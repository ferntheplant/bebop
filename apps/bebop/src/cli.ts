#!/usr/bin/env bun
// The `bebop` CLI.
//
// `ABSTRACT.md` §3.3 and "API first, with a thin CLI" (ADR 0006) make one rule about this
// program: it has no behaviour the API lacks. Every command below is a call on the generated
// client plus a way of printing the answer, and `--json` prints the API's own response so a
// script never has to parse the human rendering.
//
// Health, create, list, status, and events ship today. The rest of the surface in
// `docs/capabilities/01-bounty-lifecycle.md` arrives with the authority it needs — merge with
// GitHub, evidence with the blob store.

import {
  BountyActionResponse,
  BountyEventEnvelope,
  BountyId as BountyIdSchema,
  CreateBountyRequest as CreateBountyRequestSchema,
  CreateBountyResponse,
  GetBountyResponse,
  GitSha,
  HealthResponse,
  IdempotencyKey as IdempotencyKeySchema,
  ListBountiesResponse,
  OperatorCredentialResponse,
  StopBountyRequest as StopBountyRequestSchema,
} from "@bebop/contracts";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as BunStdio from "@effect/platform-bun/BunStdio";
import { Console, Effect, Layer, Redacted, Schema } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { bebopClient, CliHttpClientLayer, resolveConnection } from "#src/cli/client.ts";
import { streamBountyEvents } from "#src/cli/events.ts";
import { printBounty, printBountyList, printEventFrame, printHealth } from "#src/cli/render.ts";

export const bebopCliName = "bebop";

const url = Flag.string("url").pipe(
  Flag.withDescription("The Bebop API base URL. Defaults to $BEBOP_API_URL."),
  Flag.optional,
);
const token = Flag.string("token").pipe(
  Flag.withDescription("A Bebop bearer token. Defaults to $BEBOP_TOKEN."),
  Flag.optional,
);
const json = Flag.boolean("json").pipe(
  Flag.withDescription("Print the API response as JSON."),
  Flag.withDefault(false),
);

/** Every command takes the same connection flags, so they are declared once. */
const connectionFlags = { url, token, json };

interface ConnectionOptions {
  readonly url: { readonly _tag: "Some"; readonly value: string } | { readonly _tag: "None" };
  readonly token: { readonly _tag: "Some"; readonly value: string } | { readonly _tag: "None" };
}

const connect = Effect.fnUntraced(function* (options: ConnectionOptions) {
  const connection = yield* resolveConnection({
    ...(options.url._tag === "Some" ? { url: options.url.value } : {}),
    ...(options.token._tag === "Some" ? { token: options.token.value } : {}),
  });
  const client = yield* bebopClient(connection);
  return { connection, client };
});

/**
 * Prints one response, as JSON or for a person.
 *
 * The JSON form is the response **re-encoded through its own schema**, not
 * `JSON.stringify` of the decoded value. Those differ: decoding turns timestamps into
 * `DateTime` values, and stringifying those would hand a script something the API never
 * sent.
 */
const emit = <A>(options: {
  readonly asJson: boolean;
  readonly schema: Schema.Codec<A, unknown>;
  readonly value: A;
  readonly human: () => string;
}) =>
  Console.log(
    options.asJson ? JSON.stringify(Schema.encodeUnknownSync(options.schema)(options.value), null, 2) : options.human(),
  );

const health = Command.make("health", connectionFlags, (options) =>
  Effect.gen(function* () {
    const { client } = yield* connect(options);
    const response = yield* client.health.health();
    yield* emit({ asJson: options.json, schema: HealthResponse, value: response, human: () => printHealth(response) });
  }),
);

const bountyList = Command.make("list", connectionFlags, (options) =>
  Effect.gen(function* () {
    const { client } = yield* connect(options);
    const response = yield* client.bounties.listBounties({ query: {} });
    yield* emit({
      asJson: options.json,
      schema: ListBountiesResponse,
      value: response,
      human: () => printBountyList(response.bounties),
    });
  }),
);

const bountyStatus = Command.make(
  "status",
  { ...connectionFlags, bounty: Flag.string("bounty").pipe(Flag.withDescription("The bounty id.")) },
  (options) =>
    Effect.gen(function* () {
      const { client } = yield* connect(options);
      const response = yield* client.bounties.getBounty({
        params: { bountyId: Schema.decodeUnknownSync(BountyIdSchema)(options.bounty) },
      });
      yield* emit({
        asJson: options.json,
        schema: GetBountyResponse,
        value: response,
        human: () => printBounty(response),
      });
    }),
);

const bountyApproveConfig = Command.make(
  "approve-config",
  {
    ...connectionFlags,
    bounty: Flag.string("bounty").pipe(Flag.withDescription("The bounty id.")),
    sha: Flag.string("sha").pipe(Flag.withDescription("The candidate commit SHA to approve.")),
  },
  (options) =>
    Effect.gen(function* () {
      const { client } = yield* connect(options);
      const response = yield* client.bounties.approveConfig({
        params: { bountyId: Schema.decodeUnknownSync(BountyIdSchema)(options.bounty) },
        payload: { candidateSha: Schema.decodeUnknownSync(GitSha)(options.sha) },
      });
      yield* emit({
        asJson: options.json,
        schema: BountyActionResponse,
        value: response,
        human: () => printBounty(response),
      });
    }),
);

const bountyCreate = Command.make(
  "create",
  {
    ...connectionFlags,
    repository: Flag.string("repository").pipe(Flag.withDescription("The target repository, as owner/name.")),
    baseRef: Flag.string("base-ref").pipe(Flag.withDescription("The base ref to branch from.")),
    computeProfile: Flag.choice("compute-profile", ["small", "standard", "large"]).pipe(
      Flag.withDescription("The compute profile for the bounty VM."),
      Flag.withDefault("standard" as const),
    ),
    context: Flag.string("context").pipe(
      Flag.withDescription("A context capability to attach. Repeat for more than one."),
      Flag.atLeast(0),
    ),
    prompt: Flag.string("prompt").pipe(Flag.withDescription("An initial prompt for ein."), Flag.optional),
    idempotencyKey: Flag.string("idempotency-key").pipe(
      Flag.withDescription("Reuse a key to retry a create without risking a second bounty."),
      Flag.optional,
    ),
  },
  (options) =>
    Effect.gen(function* () {
      const { client } = yield* connect(options);
      // A create that is retried without a key would create a second bounty and a second VM,
      // so the CLI always sends one — generating it when the user did not supply it.
      const idempotencyKey =
        options.idempotencyKey._tag === "Some" ? options.idempotencyKey.value : `cli-${crypto.randomUUID()}`;

      const response = yield* client.bounties.createBounty({
        headers: { "idempotency-key": Schema.decodeUnknownSync(IdempotencyKeySchema)(idempotencyKey) },
        payload: Schema.decodeUnknownSync(CreateBountyRequestSchema)({
          repository: options.repository,
          baseRef: options.baseRef,
          computeProfile: options.computeProfile,
          primaryContext: options.context,
          ...(options.prompt._tag === "Some" ? { initialPrompt: options.prompt.value } : {}),
        }),
      });
      yield* emit({
        asJson: options.json,
        schema: CreateBountyResponse,
        value: response,
        human: () => printBounty(response),
      });
    }),
);

const bountyEvents = Command.make(
  "events",
  {
    ...connectionFlags,
    bounty: Flag.string("bounty").pipe(Flag.withDescription("The bounty id.")),
    from: Flag.string("from").pipe(
      Flag.withDescription("Replay from this cursor before following live events."),
      Flag.optional,
    ),
  },
  (options) =>
    Effect.gen(function* () {
      const { connection } = yield* connect(options);
      yield* streamBountyEvents({
        connection,
        bountyId: options.bounty,
        ...(options.from._tag === "Some" ? { lastEventId: options.from.value } : {}),
        onFrame: (frame) =>
          emit({
            asJson: options.json,
            schema: BountyEventEnvelope,
            value: frame,
            human: () => printEventFrame(frame),
          }),
      });
    }).pipe(Effect.scoped),
);

const bountyStop = Command.make(
  "stop",
  {
    ...connectionFlags,
    bounty: Flag.string("bounty").pipe(Flag.withDescription("The bounty id.")),
    reason: Flag.string("reason").pipe(
      Flag.withDescription("Why the bounty is being stopped; shown to whoever inspects it."),
      Flag.optional,
    ),
  },
  (options) =>
    Effect.gen(function* () {
      const { client } = yield* connect(options);
      const response = yield* client.bounties.stopBounty({
        params: { bountyId: Schema.decodeUnknownSync(BountyIdSchema)(options.bounty) },
        payload: Schema.decodeUnknownSync(StopBountyRequestSchema)(
          options.reason._tag === "Some" ? { reason: options.reason.value } : {},
        ),
      });
      yield* emit({
        asJson: options.json,
        schema: BountyActionResponse,
        value: response,
        human: () => printBounty(response),
      });
    }),
);

const bountyOperatorCredential = Command.make(
  "operator-credential",
  {
    ...connectionFlags,
    bounty: Flag.string("bounty").pipe(Flag.withDescription("The bounty id.")),
  },
  (options) =>
    Effect.gen(function* () {
      const { client } = yield* connect(options);
      const response = yield* client.bounties.getOperatorCredential({
        params: { bountyId: Schema.decodeUnknownSync(BountyIdSchema)(options.bounty) },
      });
      // The one value in the catalogue that is printed by design: this command exists to hand
      // the plaintext to a human at the `sf` prompt. `--json` still re-encodes through the
      // response schema, so a script sees exactly the wire form.
      yield* emit({
        asJson: options.json,
        schema: OperatorCredentialResponse,
        value: response,
        human: () => Redacted.value(response.operatorCredential),
      });
    }),
);

const bounty = Command.make("bounty", {}, () => Console.log("Run `bebop bounty --help`.")).pipe(
  Command.withSubcommands([
    bountyCreate,
    bountyList,
    bountyStatus,
    bountyEvents,
    bountyApproveConfig,
    bountyStop,
    bountyOperatorCredential,
  ]),
);

const root = Command.make("bebop", {}, () => Console.log("Run `bebop --help`.")).pipe(
  Command.withSubcommands([health, bounty]),
);

/**
 * Renders a failure as one line a person can act on.
 *
 * The API's typed errors already carry a message and a request ID; printing those rather
 * than a stack trace is what makes "it failed" answerable — the request ID is the handle
 * into the server's logs.
 */
function describeFailure(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && "message" in error) {
    const body = error as { code: string; message: string; requestId?: string };
    return body.requestId === undefined
      ? `${body.code}: ${body.message}`
      : `${body.code}: ${body.message} (request ${body.requestId})`;
  }
  return error instanceof Error ? error.message : String(error);
}

export const bebopCli = Command.run(root, { version: "0.0.0" });

if (import.meta.main) {
  bebopCli.pipe(
    // A failure belongs on stderr, where a shell pipeline expects it. `runMain`'s own
    // reporting goes to stdout, which would mix an error into the `--json` output a script is
    // parsing — so it is turned off and the message is written here instead.
    Effect.catch((error) => Console.error(describeFailure(error)).pipe(Effect.andThen(Effect.fail(error)))),
    Effect.provide(CliHttpClientLayer),
    // `Command.run` reads argv from the `Stdio` service rather than `process.argv`, and
    // `BunRuntime.runMain` does not provide one — without this every invocation fails at
    // startup, including `--help` (`prototypes/effect-runtime`, finding 4).
    Effect.provide(Layer.mergeAll(BunStdio.layer, BunServices.layer)),
    BunRuntime.runMain({ disableErrorReporting: true }),
  );
}

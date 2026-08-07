// The component-test harness: a real Bebop, over a real disposable Postgres.
//
// It builds the same layer stack the `bebop-api` process builds, with two substitutions that
// are the point of the exercise rather than shortcuts around it:
//
// - `Identity` is deterministic, so a test can assert on the bounty ID it will get and on the
//   exact instants that end up in timestamps;
// - the lifecycle provider reports the Swordfish credential it was asked to inject, because
//   Bebop deliberately keeps only its hash and a test still has to be able to connect a
//   Swordfish.
//
// Everything else — migrations, repositories, transactions, the HTTP server, the gateway — is
// the production wiring.

import type { ApiTokenSecret } from "@bebop/contracts";
import { ApiTokenSecret as ApiTokenSecretSchema, BountyId } from "@bebop/contracts";
import type { DisposableDatabase } from "@bebop/testkit";
import { adminDatabaseUrl, createDisposableDatabase } from "@bebop/testkit";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import { PgClient } from "@effect/sql-pg";
import { Cause, ConfigProvider, Context, Duration, Effect, Exit, Layer, Logger, Redacted, Schema, Scope } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import { BebopApiRoutes, ensureApiTokenBootstrap, reconcileConnectionsOnStartup } from "#src/api/server.ts";
import type { BebopConfig } from "#src/config.ts";
import { bebopConfigurationLayerFrom, loadBebopConfig } from "#src/config.ts";
import { fixedIdentityLayer, Identity, timestampFrom, timestampToIso } from "#src/domain/identity.ts";
import type { ProvisionedVm } from "#src/lifecycle/provider.ts";
import { localLifecycleProviderLayer } from "#src/lifecycle/provider.ts";
import { migrateDatabase } from "#src/persistence/database.ts";
import { BountyEventRepository } from "#src/persistence/events.ts";
import { LifecycleJobRepository } from "#src/persistence/jobs.ts";
import { RepositoriesLayer } from "#src/runtime/layers.ts";
import { withBoundedShutdown } from "#src/runtime/shutdown.ts";
import { runOneJob, sweepStaleConnections } from "#src/worker/jobs.ts";

/** Whether a Postgres was made available to this run. See `packages/testkit/src/postgres.ts`. */
export const testDatabaseAvailable = adminDatabaseUrl() !== null;

export interface ProvisionRecord extends ProvisionedVm {
  readonly swordfishToken: string;
}

export interface Harness {
  readonly baseUrl: string;
  readonly gatewayUrl: string;
  /** A working bearer token, stored hashed exactly as the API stores one. */
  readonly token: ApiTokenSecret;
  /** Credentials the lifecycle provider was asked to inject, oldest first. */
  readonly provisioned: ReadonlyArray<ProvisionRecord>;
  /** Messages emitted through the production logger during this harness run. */
  readonly logs: ReadonlyArray<unknown>;
  readonly provisionAttempts: number;
  /** Runs the worker's job queue to exhaustion, as `bebop-worker` would. */
  readonly runJobs: () => Promise<void>;
  /** Claims one job without running it, simulating a worker process dying after claim. */
  readonly abandonNextJob: () => Promise<string | null>;
  /** Appends known public events for replay and pagination tests. */
  readonly appendTestEvents: (bountyId: string, count: number) => Promise<void>;
  readonly storedApiTokenHash: (name: string) => Promise<string | null>;
  readonly commandCountForBounty: (bountyId: string) => Promise<number>;
  /** Runs one freshness sweep, as `bebop-worker` would. */
  readonly sweep: () => Promise<number>;
  /** Restarts the API against the same database, the way a redeploy does. */
  readonly restart: () => Promise<void>;
  readonly request: (path: string, init?: RequestInit & { readonly anonymous?: boolean }) => Promise<Response>;
  readonly close: () => Promise<void>;
}

function testConfig(databaseUrl: string, label: string, httpIdleTimeout: string): Promise<BebopConfig> {
  const environment = {
    BEBOP_HOST: "127.0.0.1",
    // Overridden by the server layer, which asks the operating system for a free port so
    // parallel suites cannot collide.
    BEBOP_PORT: "1",
    BEBOP_DATABASE_URL: databaseUrl,
    BEBOP_PUBLIC_BASE_URL: "https://bebop.test.invalid/",
    BEBOP_ARTIFACT_ROOT: "/tmp/bebop-test-artifacts",
    BEBOP_HEARTBEAT_INTERVAL: "200 millis",
    BEBOP_SWORDFISH_STALE_AFTER: "500 millis",
    BEBOP_MAX_PROTOCOL_MESSAGE_BYTES: "262144",
    BEBOP_SHUTDOWN_TIMEOUT: "1 second",
    BEBOP_SWORDFISH_CREDENTIAL_KEY: "test-swordfish-credential-key-at-least-32-bytes",
    BEBOP_BOOTSTRAP_API_TOKEN: `bebop_${label}-harness-token`,
    // Short enough that a test waiting on live delivery is not waiting on a human timescale.
    BEBOP_EVENT_STREAM_POLL_INTERVAL: "100 millis",
    BEBOP_COMMAND_POLL_INTERVAL: "150 millis",
    BEBOP_WORKER_POLL_INTERVAL: "100 millis",
    BEBOP_JOB_LEASE_DURATION: "500 millis",
    BEBOP_JOB_RETRY_DELAY: "1 milli",
    BEBOP_BOUNTY_PAGE_SIZE: "50",
    BEBOP_HTTP_IDLE_TIMEOUT: httpIdleTimeout,
  };
  return Effect.runPromise(
    loadBebopConfig(ConfigProvider.fromEnv({ env: environment }).pipe(ConfigProvider.constantCase)),
  );
}

export async function startHarness(
  label: string,
  options?: {
    readonly failProvisionAttempts?: number;
    readonly failProvisionAfterEffectAttempts?: number;
    readonly failDestroyAttempts?: number;
    /**
     * Bun closes any connection idle for longer than this, including an SSE subscription
     * with nothing to say. Generous by default so a starved CI runner cannot turn a slow
     * request into a dropped socket; a test that is *about* the idle window sets it small.
     */
    readonly httpIdleTimeout?: string;
  },
): Promise<Harness> {
  const database: DisposableDatabase = await createDisposableDatabase(label);
  const { httpIdleTimeout = "30 seconds", ...providerOptions } = options ?? {};
  const config = await testConfig(database.url, label, httpIdleTimeout);
  const provisioned: Array<ProvisionRecord> = [];
  const logs: Array<unknown> = [];
  let provisionAttempts = 0;
  const captureLogger = Logger.make<unknown, void>(({ message }) => {
    logs.push(message);
  });

  const baseLayer = RepositoriesLayer.pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(database.url), maxConnections: 6 })),
    Layer.provideMerge(
      Layer.mergeAll(
        bebopConfigurationLayerFrom(config),
        fixedIdentityLayer(),
        localLifecycleProviderLayer({
          onProvision: (record) => provisioned.push(record),
          onProvisionAttempt: () => (provisionAttempts += 1),
          // `httpIdleTimeout` is server configuration, not provider behaviour.
          ...providerOptions,
        }),
      ),
    ),
    // Tests assert on behaviour, not on log output, so a passing suite is silent. Set
    // `BEBOP_TEST_LOGS=1` when a failure needs the server's own account of it.
    Layer.provideMerge(
      Logger.layer([captureLogger, ...(process.env["BEBOP_TEST_LOGS"] === undefined ? [] : [Logger.consolePretty()])]),
    ),
  );

  interface Running {
    readonly scope: Scope.Closeable;
    readonly context: Context.Context<never>;
    readonly port: number;
  }

  async function start(): Promise<Running> {
    const scope = Effect.runSync(Scope.make());
    const baseContext = await Effect.runPromise(Layer.buildWithScope(baseLayer, scope));
    await Effect.runPromise(
      migrateDatabase.pipe(
        Effect.andThen(ensureApiTokenBootstrap),
        Effect.andThen(reconcileConnectionsOnStartup),
        Effect.provideContext(baseContext),
      ),
    );
    const serverLayer = withBoundedShutdown(HttpRouter.serve(BebopApiRoutes), config.shutdownTimeout).pipe(
      Layer.provideMerge(
        BunHttpServer.layer({
          port: 0,
          hostname: "127.0.0.1",
          idleTimeout: Math.round(Duration.toSeconds(config.httpIdleTimeout)),
        }),
      ),
    );
    const serverContext = await Effect.runPromise(
      Layer.buildWithScope(serverLayer, scope).pipe(Effect.provideContext(baseContext)),
    );
    const server = Context.get(serverContext, HttpServer.HttpServer);
    const context = Context.merge(baseContext, serverContext) as Context.Context<never>;
    return { scope, context, port: (server.address as { readonly port: number }).port };
  }

  /**
   * Closes a running server's scope.
   *
   * Closing interrupts the still-listening server fiber, and Effect reports that interrupt as
   * a failed exit. It is the shape of a clean shutdown, not a problem
   * (`prototypes/effect-runtime`, finding 5), so an interrupt-only cause is accepted and anything
   * else is raised.
   */
  async function stop(scope: Scope.Closeable): Promise<void> {
    const exit = await Effect.runPromise(Effect.exit(Scope.close(scope, Exit.void)));
    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
      throw new Error(`the server did not shut down cleanly: ${String(Cause.squash(exit.cause))}`);
    }
  }

  const secret = Schema.decodeUnknownSync(ApiTokenSecretSchema)(`bebop_${label}-harness-token`);
  let current = await start();

  const withServices = <A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> =>
    Effect.runPromise(Effect.provideContext(effect, current.context) as Effect.Effect<A, E, never>);

  const harness: Harness = {
    get baseUrl() {
      return `http://127.0.0.1:${current.port}`;
    },
    get gatewayUrl() {
      return `ws://127.0.0.1:${current.port}/swordfish`;
    },
    token: secret,
    provisioned,
    logs,
    get provisionAttempts() {
      return provisionAttempts;
    },
    runJobs: async () => {
      for (;;) {
        if (!(await withServices(runOneJob("harness")))) {
          return;
        }
      }
    },
    abandonNextJob: () =>
      withServices(
        Effect.gen(function* () {
          const identity = yield* Identity;
          const jobs = yield* LifecycleJobRepository;
          const at = yield* identity.now;
          const reclaimBefore = timestampFrom(
            new Date(Date.parse(timestampToIso(at)) - Duration.toMillis(config.jobLeaseDuration)),
          );
          const claimed = yield* jobs.claim({ workerId: "abandoned-worker", at, reclaimBefore });
          return claimed?.jobId ?? null;
        }),
      ),
    appendTestEvents: (bountyId, count) =>
      withServices(
        Effect.gen(function* () {
          const identity = yield* Identity;
          const events = yield* BountyEventRepository;
          const decodedBountyId = Schema.decodeUnknownSync(BountyId)(bountyId);
          for (let index = 0; index < count; index += 1) {
            const occurredAt = yield* identity.now;
            yield* events.append({
              bountyId: decodedBountyId,
              occurredAt,
              event: { type: "bounty_status_changed", status: "provisioning" },
            });
          }
        }),
      ),
    storedApiTokenHash: (name) =>
      withServices(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const rows = yield* sql`SELECT token_hash FROM api_tokens WHERE name = ${name}`;
          const value = rows[0]?.["token_hash"];
          return typeof value === "string" ? value : null;
        }),
      ),
    commandCountForBounty: (bountyId) =>
      withServices(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const rows = yield* sql`SELECT count(*)::int AS count FROM bounty_commands WHERE bounty_id = ${bountyId}`;
          const value = rows[0]?.["count"];
          if (typeof value !== "number") {
            return yield* Effect.die(new Error("command count was not a number"));
          }
          return value;
        }),
      ),
    sweep: () => withServices(sweepStaleConnections()),
    restart: async () => {
      await stop(current.scope);
      current = await start();
    },
    request: (path, init) => {
      const headers = new Headers(init?.headers);
      if (init?.anonymous !== true) {
        headers.set("authorization", `Bearer ${secret}`);
      }
      return fetch(`${harness.baseUrl}${path}`, { ...init, headers });
    },
    close: async () => {
      await stop(current.scope);
      await database.drop();
    },
  };

  return harness;
}

/** The request body every test that does not care about the shape of a bounty sends. */
export const sampleCreateRequest = {
  repository: "withco/bebop",
  baseRef: "main",
  computeProfile: "standard",
  primaryContext: ["context7"],
  initialPrompt: "Add a health endpoint.",
} as const;

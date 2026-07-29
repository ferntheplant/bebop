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
import { ApiTokenName, ApiTokenSecret as ApiTokenSecretSchema } from "@bebop/contracts";
import type { DisposableDatabase } from "@bebop/testkit";
import { adminDatabaseUrl, createDisposableDatabase } from "@bebop/testkit";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import { PgClient } from "@effect/sql-pg";
import { Cause, ConfigProvider, Context, Duration, Effect, Exit, Layer, Logger, Redacted, Schema, Scope } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import { BebopApiRoutes, reconcileConnectionsOnStartup } from "#src/api/server.ts";
import type { BebopConfig } from "#src/config.ts";
import { bebopConfigurationLayerFrom, loadBebopConfig } from "#src/config.ts";
import { fixedIdentityLayer, Identity } from "#src/domain/identity.ts";
import type { ProvisionedVm } from "#src/lifecycle/provider.ts";
import { fakeLifecycleProviderLayer } from "#src/lifecycle/provider.ts";
import { migrateDatabase } from "#src/persistence/database.ts";
import { ApiTokenRepository } from "#src/persistence/tokens.ts";
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
  /** Runs the worker's job queue to exhaustion, as `bebop-worker` would. */
  readonly runJobs: () => Promise<void>;
  /** Runs one freshness sweep, as `bebop-worker` would. */
  readonly sweep: () => Promise<number>;
  /** Restarts the API against the same database, the way a redeploy does. */
  readonly restart: () => Promise<void>;
  readonly request: (path: string, init?: RequestInit & { readonly anonymous?: boolean }) => Promise<Response>;
  readonly close: () => Promise<void>;
}

function testConfig(databaseUrl: string): Promise<BebopConfig> {
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
    // Short enough that a test waiting on live delivery is not waiting on a human timescale.
    BEBOP_EVENT_STREAM_POLL_INTERVAL: "100 millis",
    BEBOP_COMMAND_POLL_INTERVAL: "150 millis",
    BEBOP_WORKER_POLL_INTERVAL: "100 millis",
    BEBOP_BOUNTY_PAGE_SIZE: "50",
    // Long enough not to drop a streaming assertion, short enough that a restart does not
    // sit waiting on a keep-alive connection some earlier test left pooled.
    BEBOP_HTTP_IDLE_TIMEOUT: "2 seconds",
  };
  return Effect.runPromise(
    loadBebopConfig(ConfigProvider.fromEnv({ env: environment }).pipe(ConfigProvider.constantCase)),
  );
}

export async function startHarness(label: string): Promise<Harness> {
  const database: DisposableDatabase = await createDisposableDatabase(label);
  const config = await testConfig(database.url);
  const provisioned: Array<ProvisionRecord> = [];

  const baseLayer = RepositoriesLayer.pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(database.url), maxConnections: 6 })),
    Layer.provideMerge(
      Layer.mergeAll(
        bebopConfigurationLayerFrom(config),
        fixedIdentityLayer(),
        fakeLifecycleProviderLayer({ onProvision: (record) => provisioned.push(record) }),
      ),
    ),
    // Tests assert on behaviour, not on log output, so a passing suite is silent. Set
    // `BEBOP_TEST_LOGS=1` when a failure needs the server's own account of it.
    Layer.provideMerge(Logger.layer(process.env["BEBOP_TEST_LOGS"] === undefined ? [] : [Logger.consolePretty()])),
  );

  interface Running {
    readonly scope: Scope.Closeable;
    readonly context: Context.Context<never>;
    readonly port: number;
  }

  async function start(): Promise<Running> {
    const scope = Effect.runSync(Scope.make());
    const serverLayer = withBoundedShutdown(HttpRouter.serve(BebopApiRoutes), config.shutdownTimeout).pipe(
      Layer.provideMerge(
        BunHttpServer.layer({
          port: 0,
          hostname: "127.0.0.1",
          idleTimeout: Math.round(Duration.toSeconds(config.httpIdleTimeout)),
        }),
      ),
      Layer.provideMerge(baseLayer),
    );
    const context = await Effect.runPromise(Layer.buildWithScope(serverLayer, scope));
    const server = Context.get(context, HttpServer.HttpServer);
    await Effect.runPromise(
      migrateDatabase.pipe(Effect.andThen(reconcileConnectionsOnStartup), Effect.provideContext(context)),
    );
    return { scope, context, port: (server.address as { readonly port: number }).port };
  }

  /**
   * Closes a running server's scope.
   *
   * Closing interrupts the still-listening server fiber, and Effect reports that interrupt as
   * a failed exit. It is the shape of a clean shutdown, not a problem
   * (`spikes/effect-runtime`, finding 5), so an interrupt-only cause is accepted and anything
   * else is raised.
   */
  async function stop(scope: Scope.Closeable): Promise<void> {
    const exit = await Effect.runPromise(Effect.exit(Scope.close(scope, Exit.void)));
    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
      throw new Error(`the server did not shut down cleanly: ${String(Cause.squash(exit.cause))}`);
    }
  }

  let current = await start();

  const withServices = <A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> =>
    Effect.runPromise(Effect.provideContext(effect, current.context) as Effect.Effect<A, E, never>);

  // A real token, created the way the API creates one, so every request below exercises
  // authentication rather than bypassing it.
  const secret = Schema.decodeUnknownSync(ApiTokenSecretSchema)(`bebop_${label}-harness-token`);
  await withServices(
    Effect.gen(function* () {
      const identity = yield* Identity;
      const tokens = yield* ApiTokenRepository;
      const tokenId = yield* identity.apiTokenId;
      const createdAt = yield* identity.now;
      yield* tokens.create({ tokenId, name: Schema.decodeUnknownSync(ApiTokenName)("harness"), secret, createdAt });
    }),
  );

  const harness: Harness = {
    get baseUrl() {
      return `http://127.0.0.1:${current.port}`;
    },
    get gatewayUrl() {
      return `ws://127.0.0.1:${current.port}/swordfish`;
    },
    token: secret,
    provisioned,
    runJobs: async () => {
      for (;;) {
        if (!(await withServices(runOneJob("harness")))) {
          return;
        }
      }
    },
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

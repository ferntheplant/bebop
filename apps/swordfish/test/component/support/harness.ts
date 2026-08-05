import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Context, Fiber } from "effect";
import { ConfigProvider, Effect, Exit, Layer, Logger, Scope } from "effect";

import type { SwordfishConfig } from "#src/config.ts";
import { loadSwordfishConfig, swordfishConfigurationLayerFrom } from "#src/config.ts";
import { makeAuthorityLock } from "#src/control/server.ts";
import { fixedSwordfishIdentityLayer } from "#src/domain/identity.ts";
import { initializeDatabase } from "#src/persistence/database.ts";
import { swordfishRuntimeLayer } from "#src/runtime/layers.ts";
import { WorkflowService } from "#src/workflow/service.ts";

export interface SwordfishHarness {
  readonly root: string;
  readonly config: SwordfishConfig;
  readonly run: <A, E, R>(effect: Effect.Effect<A, E, R>) => Promise<A>;
  readonly fork: <A, E, R>(effect: Effect.Effect<A, E, R>) => Fiber.Fiber<A, E>;
  readonly restart: () => Promise<void>;
  readonly close: () => Promise<void>;
}

async function harnessConfig(
  root: string,
  options?: {
    readonly bebopWebSocketUrl?: string;
    readonly databasePath?: string;
    readonly operatorCredentialVerifier?: string;
  },
) {
  const paths = {
    databasePath: options?.databasePath ?? join(root, "state", "swordfish.sqlite"),
    controlSocketPath: join(root, "run", "control.sock"),
    repositoryPath: join(root, "repository"),
    artifactRoot: join(root, "artifacts"),
  };
  await Promise.all([
    mkdir(join(root, "state"), { recursive: true }),
    mkdir(join(root, "run"), { recursive: true }),
    mkdir(paths.repositoryPath, { recursive: true }),
    mkdir(paths.artifactRoot, { recursive: true }),
  ]);
  const environment: Record<string, string> = {
    SWORDFISH_BOUNTY_ID: "bty-component",
    SWORDFISH_VM_ID: "vm-component",
    SWORDFISH_REPOSITORY: "withco/bebop",
    SWORDFISH_ASSIGNED_BRANCH: "bounty/bty-component",
    SWORDFISH_BEBOP_WEB_SOCKET_URL: options?.bebopWebSocketUrl ?? "ws://127.0.0.1:1/swordfish",
    SWORDFISH_BEBOP_TOKEN: "component-token",
    SWORDFISH_DATABASE_PATH: paths.databasePath,
    SWORDFISH_CONTROL_SOCKET_PATH: paths.controlSocketPath,
    SWORDFISH_REPOSITORY_PATH: paths.repositoryPath,
    SWORDFISH_ARTIFACT_ROOT: paths.artifactRoot,
    SWORDFISH_OPEN_CODE_BASE_URL: "http://127.0.0.1:4096/",
    SWORDFISH_HEARTBEAT_INTERVAL: "50 millis",
    SWORDFISH_RECONNECT_MINIMUM_DELAY: "20 millis",
    SWORDFISH_RECONNECT_MAXIMUM_DELAY: "100 millis",
    SWORDFISH_SHUTDOWN_TIMEOUT: "1 second",
  };
  if (options?.operatorCredentialVerifier !== undefined) {
    environment["SWORDFISH_OPERATOR_CREDENTIAL_VERIFIER"] = options.operatorCredentialVerifier;
  }
  return Effect.runPromise(
    loadSwordfishConfig(ConfigProvider.fromEnv({ env: environment }).pipe(ConfigProvider.constantCase)),
  );
}

export async function startSwordfishHarness(
  label: string,
  options?: {
    readonly bebopWebSocketUrl?: string;
    readonly databasePath?: string;
    readonly operatorCredentialVerifier?: string;
  },
): Promise<SwordfishHarness> {
  const root = await mkdtemp(join(tmpdir(), `bebop-swordfish-${label}-`));
  const config = await harnessConfig(root, options);

  interface Running {
    readonly scope: Scope.Closeable;
    readonly context: Context.Context<never>;
  }

  async function start(): Promise<Running> {
    const scope = Effect.runSync(Scope.make());
    try {
      // Production startup acquires the database-derived authority lock before migration or
      // reconciliation can touch SQLite, so the lock is built into the layer ahead of the
      // store and released by the same scope finalization the daemon relies on.
      const authorityLock = Layer.effectDiscard(makeAuthorityLock).pipe(
        Layer.provide(swordfishConfigurationLayerFrom(config)),
      );
      const layer = swordfishRuntimeLayer({
        configuration: swordfishConfigurationLayerFrom(config),
        identity: fixedSwordfishIdentityLayer(),
      }).pipe(Layer.provideMerge(authorityLock), Layer.provideMerge(Logger.layer([])));
      const context = (await Effect.runPromise(Layer.buildWithScope(layer, scope))) as Context.Context<never>;
      await Effect.runPromise(
        Effect.provideContext(
          initializeDatabase.pipe(Effect.andThen(Effect.flatMap(WorkflowService, (workflow) => workflow.bootstrap))),
          context,
        ) as Effect.Effect<void, unknown, never>,
      );
      return { scope, context };
    } catch (cause) {
      await Effect.runPromise(Scope.close(scope, Exit.fail(cause))).catch(() => undefined);
      throw cause;
    }
  }

  let current: Running;
  try {
    current = await start();
  } catch (cause) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw cause;
  }
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A> =>
    Effect.runPromise(Effect.provideContext(effect, current.context) as Effect.Effect<A, E, never>);
  const fork = <A, E, R>(effect: Effect.Effect<A, E, R>): Fiber.Fiber<A, E> =>
    Effect.runForkWith(current.context)(effect as Effect.Effect<A, E, never>);
  const harness: SwordfishHarness = {
    root,
    config,
    run,
    fork,
    restart: async () => {
      await Effect.runPromise(Scope.close(current.scope, Exit.void));
      current = await start();
    },
    close: async () => {
      await Effect.runPromise(Scope.close(current.scope, Exit.void));
      await rm(root, { recursive: true, force: true });
    },
  };
  return harness;
}

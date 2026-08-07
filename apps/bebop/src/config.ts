import { ApiTokenSecret, Port, PositiveByteCount } from "@bebop/contracts";
import { Config, ConfigProvider, Context, Duration, Effect, Layer, Schema } from "effect";

const PositiveDuration = Schema.DurationFromString.pipe(
  Schema.check(
    Schema.makeFilter<Duration.Duration>((value) =>
      Duration.isFinite(value) && Duration.isGreaterThan(value, Duration.zero)
        ? undefined
        : "Expected a positive finite duration",
    ),
  ),
);
const AbsolutePath = Schema.String.pipe(
  Schema.check(
    Schema.isMinLength(1),
    Schema.isPattern(/^\//),
    Schema.isTrimmed(),
    Schema.makeFilter<string>((value) =>
      value.includes("//") || value.split("/").some((segment) => segment === "." || segment === "..")
        ? "Expected a canonical absolute path"
        : undefined,
    ),
  ),
);
const PostgresUrl = Schema.URL.pipe(
  Schema.check(
    Schema.makeFilter((value) =>
      value.protocol === "postgres:" || value.protocol === "postgresql:" ? undefined : "Expected a Postgres URL",
    ),
  ),
);
const HttpsUrl = Schema.URL.pipe(
  Schema.check(Schema.makeFilter((value) => (value.protocol === "https:" ? undefined : "Expected an HTTPS URL"))),
);

const PositiveCount = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(10_000)),
);
const CredentialKey = Schema.Redacted(Schema.String.pipe(Schema.check(Schema.isMinLength(32))), {
  label: "swordfish-credential-key",
  disallowJsonEncode: true,
});

/**
 * Values that have a sensible default and are tuning knobs rather than deployment facts.
 *
 * They are `optionalKey` rather than defaulted in the schema because Effect Schema's
 * `withConstructorDefault` fills a default during `make`, not during decode, and this
 * struct is only ever decoded — from the environment. Defaults are therefore applied once,
 * in `applyDefaults`, where they are visible next to each other.
 */
const tunableDefaults: {
  readonly databasePoolSize: number;
  readonly eventStreamPollInterval: Duration.Duration;
  readonly commandPollInterval: Duration.Duration;
  readonly workerPollInterval: Duration.Duration;
  readonly jobLeaseDuration: Duration.Duration;
  readonly jobRetryDelay: Duration.Duration;
  readonly bountyPageSize: number;
  readonly httpIdleTimeout: Duration.Duration;
} = {
  /** Connection pool ceiling. The API and the worker each open their own pool. */
  databasePoolSize: 8,
  /** How often a live SSE subscriber re-reads the event log when no notification arrives. */
  eventStreamPollInterval: Duration.seconds(1),
  /** How often a connected gateway drains the durable command queue. */
  commandPollInterval: Duration.seconds(2),
  /** How often the worker claims lifecycle jobs and sweeps connection freshness. */
  workerPollInterval: Duration.seconds(1),
  /** How long an unrenewed lifecycle claim remains owned by a worker process. */
  jobLeaseDuration: Duration.minutes(2),
  /** Delay between typed lifecycle-provider failures. */
  jobRetryDelay: Duration.seconds(5),
  /** Page size for `GET /api/bounties`. */
  bountyPageSize: 50,
  /**
   * How long the HTTP server holds a connection with no traffic on it.
   *
   * Bun's default is ten seconds, which would drop every `GET /api/bounties/:id/events`
   * subscriber on a quiet bounty — exactly the clients that are meant to sit and tail it
   * (`docs/capabilities/01-bounty-lifecycle.md`). 255 seconds is Bun's maximum. It is deliberately not disabled: an unbounded idle
   * connection is a resource a half-dead client can hold forever, and the event stream is
   * resumable by construction — a dropped subscriber reconnects with `Last-Event-ID` and
   * misses nothing.
   */
  httpIdleTimeout: Duration.seconds(255),
};

const BebopConfigBase = Schema.Struct({
  host: Schema.NonEmptyString,
  port: Port,
  databaseUrl: Schema.Redacted(PostgresUrl, { label: "database-url", disallowJsonEncode: true }),
  publicBaseUrl: HttpsUrl,
  artifactRoot: AbsolutePath,
  heartbeatInterval: PositiveDuration,
  swordfishStaleAfter: PositiveDuration,
  maxProtocolMessageBytes: PositiveByteCount,
  shutdownTimeout: PositiveDuration,
  swordfishCredentialKey: CredentialKey,
  bootstrapApiToken: Schema.optionalKey(
    Schema.Redacted(ApiTokenSecret, { label: "bootstrap-api-token", disallowJsonEncode: true }),
  ),
  /**
   * When set, a provisioned bounty is a real Swordfish daemon on this host under this root,
   * rather than only a VM record: the lifecycle provider clones the working copy and starts the
   * process, which is what makes a machine exist locally
   * ([A local Swordfish outlives the worker that started it (ADR
   * 0048)](../../../docs/adr/0048-a-local-swordfish-outlives-the-worker-that-started-it.md)).
   * Each bounty gets `bounties/<bountyId>/` beneath it.
   *
   * Setting it turns this process into one that spawns daemons and clones repositories on its
   * own host, so the runtime logs a warning whenever it is present. Production leaves it unset;
   * the real provider has the VM's bootstrap do all of it.
   */
  localHarnessRoot: Schema.optionalKey(AbsolutePath),
  /**
   * The rest of local machine mode, all inert in production.
   *
   * The entrypoint is the packed daemon a machine runs, and has no default because guessing a
   * path to a packed artifact and being wrong fails much later, as a daemon that never starts.
   * The remote base is what a repository slug is cloned from — GitHub for an operator, and a
   * bare repository on disk for a suite that has to clone without a network.
   */
  localSwordfishEntrypoint: Schema.optionalKey(AbsolutePath),
  localGitRemoteBase: Schema.optionalKey(Schema.URL),
  databasePoolSize: Schema.optionalKey(PositiveCount),
  eventStreamPollInterval: Schema.optionalKey(PositiveDuration),
  commandPollInterval: Schema.optionalKey(PositiveDuration),
  workerPollInterval: Schema.optionalKey(PositiveDuration),
  jobLeaseDuration: Schema.optionalKey(PositiveDuration),
  jobRetryDelay: Schema.optionalKey(PositiveDuration),
  bountyPageSize: Schema.optionalKey(PositiveCount),
  httpIdleTimeout: Schema.optionalKey(PositiveDuration),
});

const BebopConfigSchema = BebopConfigBase.pipe(
  Schema.check(
    Schema.makeFilter<typeof BebopConfigBase.Type>((config) =>
      Duration.isGreaterThan(config.swordfishStaleAfter, config.heartbeatInterval)
        ? undefined
        : { path: ["swordfishStaleAfter"], issue: "Expected stale timeout to exceed heartbeat interval" },
    ),
    // Local mode is all-or-nothing. A root without an entrypoint would start no daemon and say
    // nothing about why, which is the failure that is hardest to attribute — so it is refused at
    // startup instead, where the message can name the missing variable.
    Schema.makeFilter<typeof BebopConfigBase.Type>((config) =>
      config.localHarnessRoot === undefined || config.localSwordfishEntrypoint !== undefined
        ? undefined
        : {
            path: ["localSwordfishEntrypoint"],
            issue: "Expected a Swordfish entrypoint whenever a local harness root is set",
          },
    ),
  ),
);

export type BebopConfig = typeof BebopConfigSchema.Type & typeof tunableDefaults;

const BebopConfig = Config.schema(BebopConfigSchema, "bebop");

function applyDefaults(config: typeof BebopConfigSchema.Type): BebopConfig {
  return {
    ...config,
    databasePoolSize: config.databasePoolSize ?? tunableDefaults.databasePoolSize,
    eventStreamPollInterval: config.eventStreamPollInterval ?? tunableDefaults.eventStreamPollInterval,
    commandPollInterval: config.commandPollInterval ?? tunableDefaults.commandPollInterval,
    workerPollInterval: config.workerPollInterval ?? tunableDefaults.workerPollInterval,
    jobLeaseDuration: config.jobLeaseDuration ?? tunableDefaults.jobLeaseDuration,
    jobRetryDelay: config.jobRetryDelay ?? tunableDefaults.jobRetryDelay,
    bountyPageSize: config.bountyPageSize ?? tunableDefaults.bountyPageSize,
    httpIdleTimeout: config.httpIdleTimeout ?? tunableDefaults.httpIdleTimeout,
  };
}

function environmentProvider(): ConfigProvider.ConfigProvider {
  return ConfigProvider.fromEnv().pipe(ConfigProvider.constantCase);
}

export function loadBebopConfig(
  provider: ConfigProvider.ConfigProvider = environmentProvider(),
): Effect.Effect<BebopConfig, Config.ConfigError> {
  return Effect.map(BebopConfig.parse(provider), applyDefaults);
}

/**
 * The loaded configuration, as a service.
 *
 * Everything downstream — repositories, the gateway, the worker loop — reads its knobs from
 * here rather than from `process.env`, so a test can supply a whole configuration without
 * mutating the environment of the process it is running in.
 */
export class BebopConfiguration extends Context.Service<BebopConfiguration, BebopConfig>()("BebopConfiguration") {}

export const BebopConfigurationLayer = Layer.effect(BebopConfiguration)(loadBebopConfig());

export function bebopConfigurationLayerFrom(config: BebopConfig): Layer.Layer<BebopConfiguration> {
  return Layer.succeed(BebopConfiguration)(config);
}

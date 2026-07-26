import { Port, PositiveByteCount } from "@bebop/contracts";
import { Config, ConfigProvider, Duration, Schema } from "effect";

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
});

export const BebopConfigSchema = BebopConfigBase.pipe(
  Schema.check(
    Schema.makeFilter<typeof BebopConfigBase.Type>((config) =>
      Duration.isGreaterThan(config.swordfishStaleAfter, config.heartbeatInterval)
        ? undefined
        : { path: ["swordfishStaleAfter"], issue: "Expected stale timeout to exceed heartbeat interval" },
    ),
  ),
);
export type BebopConfig = typeof BebopConfigSchema.Type;

export const BebopConfig = Config.schema(BebopConfigSchema, "bebop");

function environmentProvider(): ConfigProvider.ConfigProvider {
  return ConfigProvider.fromEnv().pipe(ConfigProvider.constantCase);
}

export function loadBebopConfig(provider: ConfigProvider.ConfigProvider = environmentProvider()) {
  return BebopConfig.parse(provider);
}

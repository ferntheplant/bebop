import { BountyId, VmId } from "@bebop/contracts";
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
const WebSocketUrl = Schema.URL.pipe(
  Schema.check(
    Schema.makeFilter((value) =>
      value.protocol === "wss:" || value.protocol === "ws:" ? undefined : "Expected a WebSocket URL",
    ),
  ),
);

const SwordfishConfigBase = Schema.Struct({
  bountyId: BountyId,
  vmId: VmId,
  bebopWebSocketUrl: WebSocketUrl,
  bebopToken: Schema.Redacted(Schema.NonEmptyString, { label: "bebop-token", disallowJsonEncode: true }),
  databasePath: AbsolutePath,
  controlSocketPath: AbsolutePath,
  repositoryPath: AbsolutePath,
  artifactRoot: AbsolutePath,
  openCodeBaseUrl: Schema.URL,
  heartbeatInterval: PositiveDuration,
  reconnectMinimumDelay: PositiveDuration,
  reconnectMaximumDelay: PositiveDuration,
  shutdownTimeout: PositiveDuration,
});

export const SwordfishConfigSchema = SwordfishConfigBase.pipe(
  Schema.check(
    Schema.makeFilter<typeof SwordfishConfigBase.Type>((config) => {
      if (!Duration.isGreaterThanOrEqualTo(config.reconnectMaximumDelay, config.reconnectMinimumDelay)) {
        return { path: ["reconnectMaximumDelay"], issue: "Expected maximum delay to be at least minimum delay" };
      }
      const paths = [config.databasePath, config.controlSocketPath, config.repositoryPath, config.artifactRoot];
      for (const [index, path] of paths.entries()) {
        if (
          paths.some((other, otherIndex) => otherIndex !== index && (path === other || path.startsWith(`${other}/`)))
        ) {
          return "Expected non-overlapping Swordfish state and workspace paths";
        }
      }
      return undefined;
    }),
  ),
);
export type SwordfishConfig = typeof SwordfishConfigSchema.Type;

export const SwordfishConfig = Config.schema(SwordfishConfigSchema, "swordfish");

function environmentProvider(): ConfigProvider.ConfigProvider {
  return ConfigProvider.fromEnv().pipe(ConfigProvider.constantCase);
}

export function loadSwordfishConfig(provider: ConfigProvider.ConfigProvider = environmentProvider()) {
  return SwordfishConfig.parse(provider);
}

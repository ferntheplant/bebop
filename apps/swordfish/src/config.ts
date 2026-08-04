import { BountyId, GitRef, RepositorySlug, VmId } from "@bebop/contracts";
import { Config, ConfigProvider, Context, Duration, Layer, Schema } from "effect";

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

/**
 * The verifier for this bounty's operator credential, as a SHA-256 hex digest.
 *
 * Swordfish stores only this. The plaintext is derived by Bebop, retrieved through an
 * authenticated Bebop client, and entered at a hidden prompt; it is never provisioned,
 * logged, or persisted ("Workflow actions have role-aware adapters" (ADR 0038)).
 *
 * Nothing reads it yet — enforcement arrives with the retrieval route it depends on
 * (`.scratch/bebop-mvp/issues/22-operator-credential-retrieval-and-enforcement.md`), because a
 * daemon that refuses every mutation before a human can obtain the credential is worse than
 * one that refuses none.
 */
export const OperatorCredentialVerifier = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter<string>((value) =>
      /^[0-9a-f]{64}$/.test(value) ? undefined : "Expected a SHA-256 verifier as 64 lowercase hex characters",
    ),
  ),
);

const SwordfishConfigBase = Schema.Struct({
  bountyId: BountyId,
  vmId: VmId,
  repository: RepositorySlug,
  assignedBranch: GitRef,
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
  operatorCredentialVerifier: Schema.optionalKey(OperatorCredentialVerifier),
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

export class SwordfishConfiguration extends Context.Service<SwordfishConfiguration, SwordfishConfig>()(
  "SwordfishConfiguration",
) {}

export const SwordfishConfigurationLayer = Layer.effect(SwordfishConfiguration)(loadSwordfishConfig());

export function swordfishConfigurationLayerFrom(config: SwordfishConfig): Layer.Layer<SwordfishConfiguration> {
  return Layer.succeed(SwordfishConfiguration)(config);
}

import { ConfigProvider, Duration, Effect, Redacted } from "effect";
import { describe, expect, test } from "vite-plus/test";

import { loadSwordfishConfig } from "#src/config.ts";

function provider(overrides: Readonly<Record<string, string>> = {}): ConfigProvider.ConfigProvider {
  return ConfigProvider.fromEnv({
    env: {
      SWORDFISH_BOUNTY_ID: "bty-01jz8j3d9f4x",
      SWORDFISH_VM_ID: "vm_01JZ8J3D9F4X",
      SWORDFISH_REPOSITORY: "withco/bebop",
      SWORDFISH_ASSIGNED_BRANCH: "bounty/bty-01jz8j3d9f4x",
      SWORDFISH_BEBOP_WEB_SOCKET_URL: "wss://bebop.example.private/api/swordfish",
      SWORDFISH_BEBOP_TOKEN: "bounty-token",
      SWORDFISH_DATABASE_PATH: "/var/lib/swordfish/state.sqlite",
      SWORDFISH_CONTROL_SOCKET_PATH: "/run/swordfish/control.sock",
      SWORDFISH_REPOSITORY_PATH: "/workspace/repository",
      SWORDFISH_ARTIFACT_ROOT: "/var/lib/swordfish/artifacts",
      SWORDFISH_OPEN_CODE_BASE_URL: "http://127.0.0.1:4096/",
      SWORDFISH_HEARTBEAT_INTERVAL: "5 seconds",
      SWORDFISH_RECONNECT_MINIMUM_DELAY: "100 millis",
      SWORDFISH_RECONNECT_MAXIMUM_DELAY: "10 seconds",
      SWORDFISH_SHUTDOWN_TIMEOUT: "30 seconds",
      ...overrides,
    },
  }).pipe(ConfigProvider.constantCase);
}

describe("Swordfish process configuration", () => {
  test("loads branded identities, durations, paths, URLs, and redacted credentials", () => {
    const config = Effect.runSync(loadSwordfishConfig(provider()));

    expect(config.bountyId).toBe("bty-01jz8j3d9f4x");
    expect(config.repository).toBe("withco/bebop");
    expect(Duration.toMillis(config.reconnectMinimumDelay)).toBe(100);
    expect(Redacted.isRedacted(config.bebopToken)).toBe(true);
    expect(Redacted.value(config.bebopToken)).toBe("bounty-token");
  });

  test("rejects inverted reconnect bounds and relative paths", () => {
    expect(() =>
      Effect.runSync(loadSwordfishConfig(provider({ SWORDFISH_RECONNECT_MAXIMUM_DELAY: "50 millis" }))),
    ).toThrow();
    expect(() => Effect.runSync(loadSwordfishConfig(provider({ SWORDFISH_DATABASE_PATH: "state.sqlite" })))).toThrow();
    expect(() =>
      Effect.runSync(
        loadSwordfishConfig(provider({ SWORDFISH_CONTROL_SOCKET_PATH: "/var/lib/swordfish/state.sqlite" })),
      ),
    ).toThrow();
    expect(() =>
      Effect.runSync(loadSwordfishConfig(provider({ SWORDFISH_ARTIFACT_ROOT: "/workspace/repository/artifacts" }))),
    ).toThrow();
  });
});

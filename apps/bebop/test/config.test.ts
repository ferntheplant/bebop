import { ConfigProvider, Duration, Effect, Redacted } from "effect";
import { describe, expect, test } from "vite-plus/test";

import { loadBebopConfig } from "#src/config.ts";

function provider(overrides: Readonly<Record<string, string>> = {}): ConfigProvider.ConfigProvider {
  return ConfigProvider.fromEnv({
    env: {
      BEBOP_HOST: "127.0.0.1",
      BEBOP_PORT: "8080",
      BEBOP_DATABASE_URL: "postgresql://bebop:secret@localhost:5432/bebop",
      BEBOP_PUBLIC_BASE_URL: "https://bebop.example.private/",
      BEBOP_ARTIFACT_ROOT: "/var/lib/bebop/artifacts",
      BEBOP_HEARTBEAT_INTERVAL: "5 seconds",
      BEBOP_SWORDFISH_STALE_AFTER: "20 seconds",
      BEBOP_MAX_PROTOCOL_MESSAGE_BYTES: "1048576",
      BEBOP_SHUTDOWN_TIMEOUT: "30 seconds",
      ...overrides,
    },
  }).pipe(ConfigProvider.constantCase);
}

describe("Bebop process configuration", () => {
  test("loads typed environment values and redacts the database URL", () => {
    const config = Effect.runSync(loadBebopConfig(provider()));

    expect(config.port).toBe(8_080);
    expect(Duration.toSeconds(config.heartbeatInterval)).toBe(5);
    expect(Redacted.isRedacted(config.databaseUrl)).toBe(true);
    expect(Redacted.value(config.databaseUrl).protocol).toBe("postgresql:");
  });

  test("rejects stale thresholds that cannot detect missed heartbeats", () => {
    expect(() => Effect.runSync(loadBebopConfig(provider({ BEBOP_SWORDFISH_STALE_AFTER: "5 seconds" })))).toThrow();
  });

  test("rejects unsafe URL schemes and zero-sized protocol messages", () => {
    expect(() => Effect.runSync(loadBebopConfig(provider({ BEBOP_DATABASE_URL: "file:///tmp/bebop" })))).toThrow();
    expect(() =>
      Effect.runSync(loadBebopConfig(provider({ BEBOP_PUBLIC_BASE_URL: "http://bebop.example.private/" }))),
    ).toThrow();
    expect(() => Effect.runSync(loadBebopConfig(provider({ BEBOP_MAX_PROTOCOL_MESSAGE_BYTES: "0" })))).toThrow();
  });
});

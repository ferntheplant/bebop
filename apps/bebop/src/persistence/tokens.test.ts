import { ApiTokenSecret, BountyId } from "@bebop/contracts";
import { Redacted, Schema } from "effect";
import { Effect } from "effect";
import { describe, expect, test } from "vite-plus/test";

import { apiTokenPrefix, fixedIdentityLayer, Identity } from "#src/domain/identity.ts";
import { fingerprintRequest } from "#src/persistence/idempotency.ts";
import { hashApiToken } from "#src/persistence/tokens.ts";
import {
  hashSwordfishToken,
  operatorCredentialForBounty,
  operatorCredentialPrefix,
  operatorCredentialVerifier,
  presentedSwordfishToken,
  swordfishTokenPrefix,
  swordfishTokenForBounty,
} from "#src/swordfish-gateway/credentials.ts";

const secret = (value: string) => Schema.decodeUnknownSync(ApiTokenSecret)(value);

describe("API token hashing", () => {
  test("hashes to a stable 64-character digest", () => {
    const hash = hashApiToken(secret("bebop_abc"));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiToken(secret("bebop_abc"))).toBe(hash);
  });

  test("never returns the secret it was given", () => {
    // The whole point of storing a hash: a database read must not recover a working
    // credential (`docs/capabilities/14-the-security-model.md`).
    expect(hashApiToken(secret("bebop_abc"))).not.toContain("bebop_abc");
  });

  test("two secrets differing by one character hash differently", () => {
    expect(hashApiToken(secret("bebop_abc"))).not.toBe(hashApiToken(secret("bebop_abd")));
  });
});

describe("generated credentials", () => {
  test("mints prefixed, decodable API token secrets", async () => {
    const generated = await Effect.runPromise(
      Effect.gen(function* () {
        const identity = yield* Identity;
        return yield* identity.apiTokenSecret;
      }).pipe(Effect.provide(fixedIdentityLayer())),
    );
    expect(generated.startsWith(apiTokenPrefix)).toBe(true);
  });
});

describe("Swordfish credential presentation", () => {
  test("derives a stable bounty-specific credential without storing plaintext", () => {
    const key = Redacted.make("test-swordfish-credential-key-at-least-32-bytes");
    const first = Schema.decodeUnknownSync(BountyId)("bty-first");
    const second = Schema.decodeUnknownSync(BountyId)("bty-second");
    expect(Redacted.value(swordfishTokenForBounty(key, first))).toBe(
      Redacted.value(swordfishTokenForBounty(key, first)),
    );
    expect(Redacted.value(swordfishTokenForBounty(key, first))).not.toBe(
      Redacted.value(swordfishTokenForBounty(key, second)),
    );
  });

  test("derives an operator credential that is stable, per-bounty, and not the machine credential", () => {
    const key = Redacted.make("test-swordfish-credential-key-at-least-32-bytes");
    const first = Schema.decodeUnknownSync(BountyId)("bty-first");
    const second = Schema.decodeUnknownSync(BountyId)("bty-second");

    // Stable, so retrieval recomputes and a retried provision writes the same value (ADR 0038).
    expect(Redacted.value(operatorCredentialForBounty(key, first))).toBe(
      Redacted.value(operatorCredentialForBounty(key, first)),
    );
    expect(Redacted.value(operatorCredentialForBounty(key, first))).not.toBe(
      Redacted.value(operatorCredentialForBounty(key, second)),
    );

    // Domain-separated: holding one credential must not yield the other, even though both are
    // minted from the same master key.
    expect(Redacted.value(operatorCredentialForBounty(key, first))).not.toBe(
      Redacted.value(swordfishTokenForBounty(key, first)),
    );
    expect(Redacted.value(operatorCredentialForBounty(key, first)).startsWith(operatorCredentialPrefix)).toBe(true);

    // A different master key yields a different credential for the same bounty.
    expect(
      Redacted.value(operatorCredentialForBounty(Redacted.make("another-key-at-least-32-bytes-long"), first)),
    ).not.toBe(Redacted.value(operatorCredentialForBounty(key, first)));
  });

  test("verifies an operator credential without storing anything that recovers it", () => {
    const key = Redacted.make("test-swordfish-credential-key-at-least-32-bytes");
    const bountyId = Schema.decodeUnknownSync(BountyId)("bty-first");
    const credential = operatorCredentialForBounty(key, bountyId);
    const verifier = operatorCredentialVerifier(credential);

    expect(verifier).toMatch(/^[0-9a-f]{64}$/);
    // Deterministic, which is what keeps the bootstrap artifact byte-stable across retries.
    expect(operatorCredentialVerifier(credential)).toBe(verifier);
    expect(operatorCredentialVerifier(operatorCredentialForBounty(key, bountyId))).toBe(verifier);
    // The verifier is not the credential, and a different credential does not match it.
    expect(verifier).not.toBe(Redacted.value(credential));
    expect(operatorCredentialVerifier(Redacted.make("bebop_op_wrong"))).not.toBe(verifier);
  });

  test("reads a credential from an Authorization header", () => {
    expect(presentedSwordfishToken({ authorization: "Bearer bebop_sf_xyz" })).toBe("bebop_sf_xyz");
    expect(presentedSwordfishToken({ authorization: "bearer bebop_sf_xyz" })).toBe("bebop_sf_xyz");
  });

  test("reads a credential from the subprotocol a header-less client can set", () => {
    // Effect's own `BunSocket.layerWebSocket` exposes `protocols` but not `headers`, and the
    // alternative — a token in the URL — would be written into every access log on the way.
    expect(presentedSwordfishToken({ "sec-websocket-protocol": "bebop.v1, bebop-token.abc123" })).toBe("abc123");
  });

  test("reports no credential rather than an empty one", () => {
    expect(presentedSwordfishToken({})).toBeNull();
    expect(presentedSwordfishToken({ authorization: "Basic abc" })).toBeNull();
    expect(presentedSwordfishToken({ "sec-websocket-protocol": "bebop.v1" })).toBeNull();
  });

  test("hashes a Swordfish credential the same way every time", () => {
    expect(hashSwordfishToken(`${swordfishTokenPrefix}abc`)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSwordfishToken(`${swordfishTokenPrefix}abc`)).toBe(hashSwordfishToken(`${swordfishTokenPrefix}abc`));
  });
});

describe("request fingerprinting", () => {
  test("ignores key order, so a retried request matches", () => {
    expect(fingerprintRequest({ a: 1, b: [2, 3] })).toBe(fingerprintRequest({ b: [2, 3], a: 1 }));
  });

  test("distinguishes requests that differ in any value", () => {
    // This is what makes a reused idempotency key carrying different work a conflict rather
    // than a silent alias for the first request.
    expect(fingerprintRequest({ baseRef: "main" })).not.toBe(fingerprintRequest({ baseRef: "develop" }));
  });

  test("distinguishes array order, which is meaningful in a request", () => {
    expect(fingerprintRequest(["a", "b"])).not.toBe(fingerprintRequest(["b", "a"]));
  });
});

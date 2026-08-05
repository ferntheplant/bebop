// The bounty-scoped Swordfish credential ("Swordfish tokens are bounty-scoped" (ADR 0014)).
//
// One token per bounty, minted when its VM is created, injected at bootstrap, bound to the
// bounty/VM pair, and valid for the life of the bounty. Rotation and wall-clock expiry were
// specified and are now struck: the token is checked only at the upgrade, so a Swordfish
// whose connection outlived its token would reconnect with a dead credential and have no
// route to obtain another.
//
// Stored hashed, like the API tokens, so a database read cannot recover a working credential.

import { createHash, createHmac } from "node:crypto";

import type { BountyId, OperatorCredential } from "@bebop/contracts";
import { OperatorCredential as OperatorCredentialSchema } from "@bebop/contracts";
import { Redacted, Schema } from "effect";

/** Distinguishes a leaked Swordfish credential from a leaked API token at a glance. */
export const swordfishTokenPrefix = "bebop_sf_";

export function hashSwordfishToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function swordfishTokenForBounty(
  credentialKey: Redacted.Redacted<string>,
  bountyId: BountyId,
): Redacted.Redacted<string> {
  const digest = createHmac("sha256", Redacted.value(credentialKey))
    .update(`bebop-swordfish:${bountyId}`)
    .digest("base64url");
  return Redacted.make(`${swordfishTokenPrefix}${digest}`);
}

// The per-bounty operator credential ("Workflow actions have role-aware adapters" (ADR 0038)).
//
// It proves a human — not a cowboy spawning `sf` — issued a mutating local command. It shares
// this module with the machine credential because it shares everything that matters about one:
// the same master key, the same per-bounty scope, the same death with the VM, and the same
// refusal to rotate. Only the domain string differs, which is what keeps knowledge of one from
// yielding the other.
//
// It is derived rather than stored so that retrieval recomputes instead of reading, leaving no
// plaintext at rest and making a retried provision yield the same credential.

/** Distinguishes a leaked operator credential from a leaked machine credential at a glance. */
export const operatorCredentialPrefix = "bebop_op_";

export function operatorCredentialForBounty(
  credentialKey: Redacted.Redacted<string>,
  bountyId: BountyId,
): Redacted.Redacted<OperatorCredential> {
  const digest = createHmac("sha256", Redacted.value(credentialKey))
    .update(`bebop-operator:${bountyId}`)
    .digest("base64url");
  const credential = Schema.decodeUnknownSync(OperatorCredentialSchema)(`${operatorCredentialPrefix}${digest}`);
  // The label matches the one `OperatorCredentialResponse` declares, so a `Redacted` produced
  // here encodes onto the wire (`apps/bebop/src/api/handlers.ts`).
  return Redacted.make(credential, { label: "operator-credential" });
}

/**
 * The verifier Swordfish stores, so a daemon read cannot recover a working credential.
 *
 * Plain SHA-256 rather than a salted KDF: the credential is a 256-bit digest, not a
 * human-chosen secret, so there is no dictionary to precompute. Salting would add cost and
 * cost determinism — and determinism is what keeps a retried provision writing the same
 * verifier (ADR 0038).
 */
export function operatorCredentialVerifier(credential: Redacted.Redacted<string>): string {
  return createHash("sha256").update(Redacted.value(credential)).digest("hex");
}

/**
 * Pulls the credential out of an upgrade request.
 *
 * `Authorization: Bearer` is the documented path and the one Swordfish uses. The
 * subprotocol form exists because a WebSocket client cannot always set headers — Effect's own
 * `BunSocket.layerWebSocket` exposes `protocols` but not `headers` — and putting the token in
 * the URL instead would write it into every access log between here and the VM.
 */
export function presentedSwordfishToken(headers: Readonly<Record<string, string | undefined>>): string | null {
  const authorization = headers["authorization"];
  if (authorization !== undefined) {
    const match = /^Bearer (.+)$/i.exec(authorization.trim());
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }
  const protocols = headers["sec-websocket-protocol"];
  if (protocols !== undefined) {
    for (const entry of protocols.split(",")) {
      const trimmed = entry.trim();
      if (trimmed.startsWith(`${swordfishSubprotocolPrefix}.`)) {
        return trimmed.slice(swordfishSubprotocolPrefix.length + 1);
      }
    }
  }
  return null;
}

const swordfishSubprotocolPrefix = "bebop-token";

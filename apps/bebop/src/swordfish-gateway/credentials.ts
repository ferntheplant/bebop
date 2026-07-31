// The bounty-scoped Swordfish credential (`docs/design/SYSTEM.md` §18.2).
//
// One token per bounty, minted when its VM is created, injected at bootstrap, bound to the
// bounty/VM pair, and valid for the life of the bounty. Rotation and wall-clock expiry were
// specified and are now struck: the token is checked only at the upgrade, so a Swordfish
// whose connection outlived its token would reconnect with a dead credential and have no
// route to obtain another.
//
// Stored hashed, like the API tokens, so a database read cannot recover a working credential.

import { createHash, createHmac } from "node:crypto";

import type { BountyId } from "@bebop/contracts";
import { Redacted } from "effect";

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

export const swordfishSubprotocolPrefix = "bebop-token";

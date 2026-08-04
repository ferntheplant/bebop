// The per-bounty operator credential that authenticates mutating local `sf` commands.
//
// A same-user mode-`0600` Unix socket cannot tell a human shell from a cowboy spawning `sf`,
// so mutating local commands require hidden interactive entry of a per-bounty operator
// credential ("Workflow actions have role-aware adapters" (ADR 0038)). The credential is
// derived deterministically by Bebop from its master-held secret — the same key that mints
// the Swordfish machine credential — under a distinct domain string, and Swordfish receives
// only a salted verifier. The plaintext is never provisioned, logged, or placed in
// configuration; it enters only through hidden human terminal input and travels to the
// daemon inside the control request.
//
// The supervisor of the local system harness derives the plaintext from the same master key
// to feed the hidden `sf cancel` prompt; the derivation lives here in the shared package so
// that a script can compute it without importing app source.

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** Distinguishes a leaked operator credential from a leaked machine credential at a glance. */
export const operatorCredentialPrefix = "bebop_op_";

/**
 * The deterministic per-bounty operator credential.
 *
 * Domain-separated from the machine credential (`swordfishTokenForBounty` uses
 * `bebop-swordfish:`), so knowledge of one does not recover the other even though both are
 * minted from the same key. The bounty id is taken as a plain string because the derivation
 * only needs the value, and both branded ids and test literals must be able to call it.
 */
export function operatorCredentialForBounty(credentialKey: string, bountyId: string): string {
  const digest = createHmac("sha256", credentialKey).update(`bebop-operator:${bountyId}`).digest("base64url");
  return `${operatorCredentialPrefix}${digest}`;
}

/** A salted verifier of an operator credential, in the form Swordfish stores. */
export interface SaltedOperatorVerifier {
  readonly salt: string;
  readonly verifier: string;
}

/** Computes a salted verifier from the plaintext credential. */
export function saltedOperatorVerifier(credential: string): SaltedOperatorVerifier {
  const salt = randomBytes(16).toString("hex");
  return {
    salt,
    verifier: scryptSync(credential, salt, 32).toString("hex"),
  };
}

/** Compares a presented credential against the stored verifier in constant time. */
export function verifyOperatorCredential(presented: string, expected: SaltedOperatorVerifier): boolean {
  const candidate = scryptSync(presented, expected.salt, 32);
  const reference = Buffer.from(expected.verifier, "hex");
  return candidate.length === reference.length && timingSafeEqual(candidate, reference);
}

/** The serialized form of a salted verifier, for daemon configuration. */
export function serializeOperatorVerifier(verifier: SaltedOperatorVerifier): string {
  return `${verifier.salt}:${verifier.verifier}`;
}

/** Parses the serialized verifier form. Throws on a malformed value. */
export function parseOperatorVerifier(encoded: string): SaltedOperatorVerifier {
  const separator = encoded.indexOf(":");
  if (separator <= 0 || separator === encoded.length - 1) {
    throw new Error("Expected an operator credential verifier as salt:verifier.");
  }
  return {
    salt: encoded.slice(0, separator),
    verifier: encoded.slice(separator + 1),
  };
}

import { describe, expect, test } from "vite-plus/test";

import {
  operatorCredentialForBounty,
  parseOperatorVerifier,
  saltedOperatorVerifier,
  serializeOperatorVerifier,
  verifyOperatorCredential,
} from "#src/operator-credential.ts";

describe("per-bounty operator credential", () => {
  test("derives a deterministic credential per bounty, domain-separated from the machine credential", () => {
    const key = "local-operator-credential-key-at-least-32-bytes";
    const first = operatorCredentialForBounty(key, "bty-alpha");
    expect(first).toMatch(/^bebop_op_/);
    expect(operatorCredentialForBounty(key, "bty-alpha")).toBe(first);
    expect(operatorCredentialForBounty(key, "bty-beta")).not.toBe(first);
    expect(operatorCredentialForBounty("another-key-at-least-32-bytes-long", "bty-alpha")).not.toBe(first);
    // Domain separation from `swordfishTokenForBounty`, which mints `bebop_sf_` tokens.
    expect(first.startsWith("bebop_sf_")).toBe(false);
  });

  test("a salted verifier accepts the credential and refuses a wrong one", () => {
    const credential = operatorCredentialForBounty("local-operator-key-at-least-32-bytes", "bty-alpha");
    const verifier = saltedOperatorVerifier(credential);
    expect(verifyOperatorCredential(credential, verifier)).toBe(true);
    expect(verifyOperatorCredential("bebop_op_wrong", verifier)).toBe(false);
    // A verifier carries its own salt, so a fresh verifier of the same credential also accepts it.
    expect(verifyOperatorCredential(credential, saltedOperatorVerifier(credential))).toBe(true);
    // But the same credential re-salted is a different verifier value, so the two verifiers disagree.
    expect(saltedOperatorVerifier(credential)).not.toEqual(saltedOperatorVerifier(credential));
  });

  test("serializes and parses the verifier for daemon configuration", () => {
    const credential = operatorCredentialForBounty("local-operator-key-at-least-32-bytes", "bty-alpha");
    const verifier = saltedOperatorVerifier(credential);
    const encoded = serializeOperatorVerifier(verifier);
    expect(parseOperatorVerifier(encoded)).toEqual(verifier);
    expect(verifyOperatorCredential(credential, parseOperatorVerifier(encoded))).toBe(true);
  });

  test("refuses a malformed serialized verifier", () => {
    expect(() => parseOperatorVerifier("missing-colon")).toThrow();
    expect(() => parseOperatorVerifier(":verifier")).toThrow();
    expect(() => parseOperatorVerifier("salt:")).toThrow();
  });
});

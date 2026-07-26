import { Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";

import {
  UnsupportedProtocolVersionError,
  decodeBebopToSwordfishMessage,
  decodeSwordfishToBebopMessage,
} from "#src/protocol-decode.ts";
import { BebopToSwordfishMessage, SwordfishToBebopMessage } from "#src/protocol.ts";

import invalidVersions from "./golden/invalid-protocol-versions.json" with { type: "json" };
import protocolV1 from "./golden/protocol-v1.json" with { type: "json" };

describe("protocol v1 golden serialization", () => {
  test("round-trips every committed Swordfish-to-Bebop message exactly", () => {
    for (const encoded of protocolV1.swordfishToBebop) {
      const decoded = decodeSwordfishToBebopMessage(encoded);
      expect(Schema.encodeSync(SwordfishToBebopMessage)(decoded)).toEqual(encoded);
    }
  });

  test("round-trips every committed Bebop-to-Swordfish message exactly", () => {
    for (const encoded of protocolV1.bebopToSwordfish) {
      const decoded = decodeBebopToSwordfishMessage(encoded);
      expect(Schema.encodeSync(BebopToSwordfishMessage)(decoded)).toEqual(encoded);
    }
  });

  test("rejects committed cross-version fixtures with stable typed errors", () => {
    expect(() => decodeSwordfishToBebopMessage(invalidVersions[0])).toThrow(UnsupportedProtocolVersionError);
    expect(() => decodeBebopToSwordfishMessage(invalidVersions[1])).toThrow(UnsupportedProtocolVersionError);
  });
});

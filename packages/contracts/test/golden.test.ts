import { Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";

import {
  UnsupportedProtocolVersionError,
  decodeBebopToSwordfishMessage,
  decodeSwordfishToBebopMessage,
} from "#src/protocol-decode.ts";
import { BebopToSwordfishMessage, SwordfishToBebopMessage } from "#src/protocol.ts";

import invalidVersions from "./golden/invalid-protocol-versions.json" with { type: "json" };
import protocolV1Encoding from "./golden/protocol-v1-encoding.json" with { type: "json" };

// This fixture is a catalogue of every message SHAPE, not a replayable workflow: its
// events are ordered to cover the union, and that ordering is deliberately not a legal
// sequence for the workflow reducer. The name says so, because a golden transcript that
// looks replayable but is not is a trap for whoever wires up Milestone 5.
//
// The legal transcript lives in `apps/swordfish/test/workflow/golden-replay-v1.json` and is
// replayed there against the real reducer.
describe("protocol v1 golden encoding", () => {
  test("round-trips every committed Swordfish-to-Bebop message exactly", () => {
    for (const encoded of protocolV1Encoding.swordfishToBebop) {
      const decoded = decodeSwordfishToBebopMessage(encoded);
      expect(Schema.encodeSync(SwordfishToBebopMessage)(decoded)).toEqual(encoded);
    }
  });

  test("round-trips every committed Bebop-to-Swordfish message exactly", () => {
    for (const encoded of protocolV1Encoding.bebopToSwordfish) {
      const decoded = decodeBebopToSwordfishMessage(encoded);
      expect(Schema.encodeSync(BebopToSwordfishMessage)(decoded)).toEqual(encoded);
    }
  });

  test("rejects committed cross-version fixtures with stable typed errors", () => {
    expect(() => decodeSwordfishToBebopMessage(invalidVersions[0])).toThrow(UnsupportedProtocolVersionError);
    expect(() => decodeBebopToSwordfishMessage(invalidVersions[1])).toThrow(UnsupportedProtocolVersionError);
  });
});

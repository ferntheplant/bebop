import { describe, expect, test } from "vite-plus/test";

import {
  InvalidProtocolMessageError,
  UnsupportedProtocolVersionError,
  decodeBebopToSwordfishMessage,
  decodeSwordfishToBebopMessage,
  protocolDecodeErrorToMessage,
} from "#src/protocol-decode.ts";

const registration = {
  type: "register",
  protocolVersion: 1,
  bountyId: "bty-01jz8j3d9f4x",
  vmId: "vm_01JZ8J3D9F4X",
  swordfishVersion: "0.1.0",
  lastProducedEventSequence: 0,
} as const;

describe("typed protocol decoding", () => {
  test("decodes valid directional messages", () => {
    expect(decodeSwordfishToBebopMessage(registration).type).toBe("register");
  });

  test("distinguishes unsupported numeric versions from malformed v1 messages", () => {
    expect(() => decodeSwordfishToBebopMessage({ ...registration, protocolVersion: 2 })).toThrow(
      UnsupportedProtocolVersionError,
    );
    expect(() => decodeSwordfishToBebopMessage({ ...registration, protocolVersion: "1" })).toThrow(
      InvalidProtocolMessageError,
    );
    expect(() => decodeBebopToSwordfishMessage({ protocolVersion: 1, type: "destroy" })).toThrow(
      InvalidProtocolMessageError,
    );
  });

  test("maps typed decode failures to stable wire errors", () => {
    const unsupported = new UnsupportedProtocolVersionError(2);
    const invalid = new InvalidProtocolMessageError("swordfish_to_bebop");

    expect(protocolDecodeErrorToMessage(unsupported)).toMatchObject({
      type: "protocol_error",
      protocolVersion: 1,
      code: "unsupported_version",
    });
    expect(protocolDecodeErrorToMessage(invalid)).toMatchObject({
      type: "protocol_error",
      protocolVersion: 1,
      code: "invalid_message",
    });
  });

  test("returns stable invalid-message errors for invalid IDs, stages, and sequences", () => {
    const invalidMessages: ReadonlyArray<unknown> = [
      { ...registration, bountyId: "Bounty/unsafe" },
      {
        type: "event",
        protocolVersion: 1,
        bountyId: registration.bountyId,
        vmId: registration.vmId,
        sequence: 0,
        occurredAt: "2026-07-26T12:34:56.000Z",
        event: { type: "stage_changed", stage: "IMPLEMENTING" },
      },
      {
        type: "event",
        protocolVersion: 1,
        bountyId: registration.bountyId,
        vmId: registration.vmId,
        sequence: -1,
        occurredAt: "2026-07-26T12:34:56.000Z",
        event: { type: "stage_changed", stage: "implementing" },
      },
    ];

    for (const input of invalidMessages) {
      try {
        decodeSwordfishToBebopMessage(input);
        throw new Error("Expected protocol decoding to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidProtocolMessageError);
        if (error instanceof InvalidProtocolMessageError) {
          expect(error.direction).toBe("swordfish_to_bebop");
          expect(protocolDecodeErrorToMessage(error).code).toBe("invalid_message");
        }
      }
    }
  });
});

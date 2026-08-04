import { Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";

import type { BebopCommand } from "#src/protocol.ts";
import { BebopToSwordfishMessage, SwordfishToBebopMessage } from "#src/protocol.ts";

const identity = {
  protocolVersion: 1,
  bountyId: "bty-01jz8j3d9f4x",
  vmId: "vm_01JZ8J3D9F4X",
} as const;
const timestamp = "2026-07-26T12:34:56.000Z";

describe("Swordfish to Bebop protocol", () => {
  test("round-trips registration", () => {
    const encoded = {
      ...identity,
      type: "register",
      swordfishVersion: "0.1.0",
      lastProducedEventSequence: 12,
    } as const;
    const decoded = Schema.decodeUnknownSync(SwordfishToBebopMessage)(encoded);

    expect(Schema.encodeSync(SwordfishToBebopMessage)(decoded)).toEqual(encoded);
  });

  test("round-trips heartbeats without using them as workflow events", () => {
    const encoded = {
      ...identity,
      type: "heartbeat",
      sentAt: timestamp,
      lastProducedEventSequence: 12,
      lastAppliedCommandId: "cmd_01JZ8J3D9F4X",
    } as const;
    const decoded = Schema.decodeUnknownSync(SwordfishToBebopMessage)(encoded);

    expect(Schema.encodeSync(SwordfishToBebopMessage)(decoded)).toEqual(encoded);
  });

  test("round-trips sequenced workflow events", () => {
    const encoded = {
      ...identity,
      type: "event",
      sequence: 13,
      occurredAt: timestamp,
      event: {
        type: "stage_changed",
        stage: "local_validation",
        reason: "Candidate submitted for verification.",
      },
    } as const;
    const decoded = Schema.decodeUnknownSync(SwordfishToBebopMessage)(encoded);

    expect(Schema.encodeSync(SwordfishToBebopMessage)(decoded)).toEqual(encoded);
  });

  test("round-trips attachment replacement snapshots", () => {
    const encoded = {
      ...identity,
      type: "event",
      sequence: 14,
      occurredAt: timestamp,
      event: {
        type: "attachments_updated",
        previews: [{ label: "web", url: "https://web.example.private/", port: 3_000 }],
      },
    } as const;
    const decoded = Schema.decodeUnknownSync(SwordfishToBebopMessage)(encoded);

    expect(Schema.encodeSync(SwordfishToBebopMessage)(decoded)).toEqual(encoded);
  });

  test("round-trips commit-bound gate and invalidation events", () => {
    const events = [
      {
        type: "gate_completed",
        gate: "code_review",
        candidateSha: "b".repeat(40),
        specRevision: 1,
        outcome: "passed",
      },
      {
        type: "candidate_invalidated",
        candidateSha: "b".repeat(40),
        specRevision: 1,
        reason: "branch_head_changed",
        observedHeadSha: "c".repeat(40),
      },
    ] as const;

    for (const [index, event] of events.entries()) {
      const encoded = { ...identity, type: "event", sequence: 15 + index, occurredAt: timestamp, event } as const;
      const decoded = Schema.decodeUnknownSync(SwordfishToBebopMessage)(encoded);
      expect(Schema.encodeSync(SwordfishToBebopMessage)(decoded)).toEqual(encoded);
    }
  });

  test("round-trips command results for deduplication", () => {
    const encoded = {
      ...identity,
      type: "command_result",
      commandId: "cmd_01JZ8J3D9F4X",
      status: "completed",
      reportedAt: timestamp,
    } as const;
    const decoded = Schema.decodeUnknownSync(SwordfishToBebopMessage)(encoded);

    expect(Schema.encodeSync(SwordfishToBebopMessage)(decoded)).toEqual(encoded);
  });

  test("round-trips protocol errors without dropping heartbeats as an error signal", () => {
    const encoded = {
      type: "protocol_error",
      protocolVersion: 1,
      code: "invalid_message",
      message: "The command payload failed schema validation.",
    } as const;
    const decoded = Schema.decodeUnknownSync(SwordfishToBebopMessage)(encoded);

    expect(Schema.encodeSync(SwordfishToBebopMessage)(decoded)).toEqual(encoded);
  });

  test("rejects unknown versions, message types, and invalid sequences", () => {
    expect(() =>
      Schema.decodeUnknownSync(SwordfishToBebopMessage)({
        ...identity,
        type: "register",
        protocolVersion: 2,
        swordfishVersion: "0.1.0",
        lastProducedEventSequence: 0,
      }),
    ).toThrow();
    expect(() => Schema.decodeUnknownSync(SwordfishToBebopMessage)({ ...identity, type: "ping" })).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(SwordfishToBebopMessage)({
        ...identity,
        type: "event",
        sequence: -1,
        occurredAt: timestamp,
        event: { type: "stage_changed", stage: "implementing" },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(SwordfishToBebopMessage)({
        ...identity,
        type: "event",
        sequence: 0,
        occurredAt: timestamp,
        event: { type: "stage_changed", stage: "implementing" },
      }),
    ).toThrow();
  });
});

const commands: ReadonlyArray<typeof BebopCommand.Encoded> = [
  { type: "stop", reason: "User requested stop." },
  { type: "takeover", seat: "ein", force: false },
  { type: "handoff" },
  { type: "continue" },
  { type: "rerun", target: "building" },
  { type: "resume" },
  { type: "approve_config", candidateSha: "b".repeat(40) },
  { type: "external_ci_completed", candidateSha: "b".repeat(40), specRevision: 1, outcome: "passed" },
];

describe("Bebop to Swordfish protocol", () => {
  test("round-trips registration acknowledgement and event cursor", () => {
    const registered = {
      ...identity,
      type: "registered",
      connectionId: "conn_01JZ8J3D9F4X",
      serverTime: timestamp,
      acknowledgedThrough: 10,
    } as const;
    const acknowledged = {
      ...identity,
      type: "event_acknowledged",
      acknowledgedThrough: 13,
    } as const;

    const decodedRegistration = Schema.decodeUnknownSync(BebopToSwordfishMessage)(registered);
    const decodedAcknowledgement = Schema.decodeUnknownSync(BebopToSwordfishMessage)(acknowledged);
    expect(Schema.encodeSync(BebopToSwordfishMessage)(decodedRegistration)).toEqual(registered);
    expect(Schema.encodeSync(BebopToSwordfishMessage)(decodedAcknowledgement)).toEqual(acknowledged);
  });

  test.each(commands)("round-trips $type commands", (command) => {
    const encoded = {
      ...identity,
      type: "command",
      commandId: "cmd_01JZ8J3D9F4X",
      issuedAt: timestamp,
      command,
    } as const;
    const decoded = Schema.decodeUnknownSync(BebopToSwordfishMessage)(encoded);

    expect(Schema.encodeSync(BebopToSwordfishMessage)(decoded)).toEqual(encoded);
  });

  test("round-trips typed protocol errors", () => {
    const encoded = {
      type: "protocol_error",
      protocolVersion: 1,
      code: "sequence_gap",
      message: "Expected sequence 14 but received 15.",
    } as const;
    const decoded = Schema.decodeUnknownSync(BebopToSwordfishMessage)(encoded);

    expect(Schema.encodeSync(BebopToSwordfishMessage)(decoded)).toEqual(encoded);
  });

  test("rejects unsupported commands and protocol versions", () => {
    expect(() =>
      Schema.decodeUnknownSync(BebopToSwordfishMessage)({
        ...identity,
        type: "command",
        commandId: "cmd_01JZ8J3D9F4X",
        issuedAt: timestamp,
        command: { type: "destroy" },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(BebopToSwordfishMessage)({
        type: "protocol_error",
        protocolVersion: 2,
        code: "unsupported_version",
        message: "Unsupported version.",
      }),
    ).toThrow();
  });
});

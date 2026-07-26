import { DateTime, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";

import {
  BountyId,
  CommandId,
  EventSequence,
  GitSha,
  ProtocolVersion,
  SeatId,
  Timestamp,
  VmId,
  currentProtocolVersion,
} from "#src/scalars.ts";

describe("identifier schemas", () => {
  test("decodes valid identifiers into distinct branded types", () => {
    expect(Schema.decodeUnknownSync(BountyId)("bty-01jz8j3d9f4x0m6v1a2b3c4d5e")).toBe("bty-01jz8j3d9f4x0m6v1a2b3c4d5e");
    expect(Schema.decodeUnknownSync(VmId)("vm_01JZ8J3D9F4X")).toBe("vm_01JZ8J3D9F4X");
    expect(Schema.decodeUnknownSync(SeatId)("ses_01JZ8J3D9F4X")).toBe("ses_01JZ8J3D9F4X");
    expect(Schema.decodeUnknownSync(CommandId)("cmd_01JZ8J3D9F4X")).toBe("cmd_01JZ8J3D9F4X");
  });

  test("rejects identifiers that are unsafe in URLs, branches, or logs", () => {
    expect(() => Schema.decodeUnknownSync(BountyId)("Bounty/123")).toThrow();
    expect(() => Schema.decodeUnknownSync(VmId)("vm id")).toThrow();
    expect(() => Schema.decodeUnknownSync(SeatId)("")).toThrow();
    expect(() => Schema.decodeUnknownSync(CommandId)("cmd/123")).toThrow();
  });
});

describe("wire scalar schemas", () => {
  test("accepts sha-1 and sha-256 object identifiers", () => {
    expect(Schema.decodeUnknownSync(GitSha)("a".repeat(40))).toBe("a".repeat(40));
    expect(Schema.decodeUnknownSync(GitSha)("b".repeat(64))).toBe("b".repeat(64));
  });

  test("rejects abbreviated and uppercase git shas", () => {
    expect(() => Schema.decodeUnknownSync(GitSha)("a".repeat(12))).toThrow();
    expect(() => Schema.decodeUnknownSync(GitSha)("A".repeat(40))).toThrow();
  });

  test("round-trips UTC timestamps", () => {
    const timestamp = Schema.decodeUnknownSync(Timestamp)("2026-07-26T12:34:56.000Z");

    expect(DateTime.isUtc(timestamp)).toBe(true);
    expect(Schema.encodeSync(Timestamp)(timestamp)).toBe("2026-07-26T12:34:56.000Z");
  });

  test("rejects invalid timestamps", () => {
    expect(() => Schema.decodeUnknownSync(Timestamp)("2026-02-30T12:34:56.000Z")).toThrow();
  });

  test("accepts non-negative safe event sequences", () => {
    expect(Schema.decodeUnknownSync(EventSequence)(0)).toBe(0);
    expect(Schema.decodeUnknownSync(EventSequence)(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("rejects invalid event sequences", () => {
    expect(() => Schema.decodeUnknownSync(EventSequence)(-1)).toThrow();
    expect(() => Schema.decodeUnknownSync(EventSequence)(1.5)).toThrow();
    expect(() => Schema.decodeUnknownSync(EventSequence)(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });

  test("rejects unknown protocol versions", () => {
    expect(Schema.decodeUnknownSync(ProtocolVersion)(currentProtocolVersion)).toBe(1);
    expect(() => Schema.decodeUnknownSync(ProtocolVersion)(2)).toThrow();
  });
});

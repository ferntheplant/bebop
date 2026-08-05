import { Schema } from "effect";

import {
  BebopToSwordfishMessage,
  ProtocolErrorMessage,
  SwordfishToBebopMessage,
  type BebopToSwordfishMessage as BebopToSwordfishMessageType,
  type ProtocolErrorMessage as ProtocolErrorMessageType,
  type SwordfishToBebopMessage as SwordfishToBebopMessageType,
} from "./protocol.ts";
import { currentProtocolVersion } from "./scalars.ts";

export type ProtocolDirection = "swordfish_to_bebop" | "bebop_to_swordfish";

export class UnsupportedProtocolVersionError extends Error {
  constructor(readonly receivedVersion: number) {
    super(`Unsupported protocol version ${receivedVersion}; expected ${currentProtocolVersion}.`);
    this.name = "UnsupportedProtocolVersionError";
  }
}

export class InvalidProtocolMessageError extends Error {
  constructor(
    readonly direction: ProtocolDirection,
    options?: ErrorOptions,
  ) {
    super(`Invalid ${direction.replaceAll("_", "-")} protocol message.`, options);
    this.name = "InvalidProtocolMessageError";
  }
}

export type ProtocolDecodeError = UnsupportedProtocolVersionError | InvalidProtocolMessageError;

function assertSupportedProtocolVersion(input: unknown): void {
  if (typeof input !== "object" || input === null || !("protocolVersion" in input)) {
    return;
  }
  const version = input.protocolVersion;
  if (typeof version === "number" && version !== currentProtocolVersion) {
    throw new UnsupportedProtocolVersionError(version);
  }
}

export function decodeSwordfishToBebopMessage(input: unknown): SwordfishToBebopMessageType {
  assertSupportedProtocolVersion(input);
  try {
    return Schema.decodeUnknownSync(SwordfishToBebopMessage)(input);
  } catch (cause) {
    throw new InvalidProtocolMessageError("swordfish_to_bebop", { cause });
  }
}

export function decodeBebopToSwordfishMessage(input: unknown): BebopToSwordfishMessageType {
  assertSupportedProtocolVersion(input);
  try {
    return Schema.decodeUnknownSync(BebopToSwordfishMessage)(input);
  } catch (cause) {
    throw new InvalidProtocolMessageError("bebop_to_swordfish", { cause });
  }
}

export function protocolDecodeErrorToMessage(error: ProtocolDecodeError): ProtocolErrorMessageType {
  return Schema.decodeUnknownSync(ProtocolErrorMessage)({
    type: "protocol_error",
    protocolVersion: currentProtocolVersion,
    code: error instanceof UnsupportedProtocolVersionError ? "unsupported_version" : "invalid_message",
    message: error.message,
  });
}

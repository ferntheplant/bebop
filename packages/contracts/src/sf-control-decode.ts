import { Schema } from "effect";

import {
  SfControlCommand,
  SfControlRequest,
  SfControlResponse,
  currentSfControlVersion,
  type SfControlCommand as SfControlCommandType,
  type SfControlRequest as SfControlRequestType,
  type SfControlResponse as SfControlResponseType,
} from "./sf-control.ts";

export class UnsupportedSfControlVersionError extends Error {
  constructor(readonly receivedVersion: number) {
    super(`Unsupported sf control version ${receivedVersion}; expected ${currentSfControlVersion}.`);
    this.name = "UnsupportedSfControlVersionError";
  }
}

export class InvalidSfControlRequestError extends Error {
  constructor(options?: ErrorOptions) {
    super("Invalid sf control request.", options);
    this.name = "InvalidSfControlRequestError";
  }
}

export class InvalidSfControlResponseError extends Error {
  constructor(options?: ErrorOptions) {
    super("Invalid sf control response.", options);
    this.name = "InvalidSfControlResponseError";
  }
}

export class UnexpectedSfControlResponseError extends Error {
  constructor() {
    super("The sf control response did not match its request.");
    this.name = "UnexpectedSfControlResponseError";
  }
}

/**
 * Structural equality derived from the schema itself.
 *
 * The previous comparison serialised both commands with `JSON.stringify` and compared the
 * strings, which is key-order dependent. It happened to work because both sides were
 * encoded through the same schema in the same process; it would have started rejecting
 * valid responses the moment one side was built by hand or round-tripped through a store.
 */
const commandEquivalence = Schema.toEquivalence(SfControlCommand);

function sameCommand(left: SfControlCommandType, right: SfControlCommandType): boolean {
  return commandEquivalence(left, right);
}

function assertSupportedVersion(input: unknown): void {
  if (typeof input !== "object" || input === null || !("controlVersion" in input)) {
    return;
  }
  const version = input.controlVersion;
  if (typeof version === "number" && version !== currentSfControlVersion) {
    throw new UnsupportedSfControlVersionError(version);
  }
}

export function decodeSfControlRequest(input: unknown): SfControlRequestType {
  assertSupportedVersion(input);
  try {
    return Schema.decodeUnknownSync(SfControlRequest)(input);
  } catch (cause) {
    throw new InvalidSfControlRequestError({ cause });
  }
}

export function decodeSfControlResponse(input: unknown): SfControlResponseType {
  assertSupportedVersion(input);
  try {
    return Schema.decodeUnknownSync(SfControlResponse)(input);
  } catch (cause) {
    throw new InvalidSfControlResponseError({ cause });
  }
}

export function decodeSfControlResponseForRequest(
  input: unknown,
  request: SfControlRequestType,
): SfControlResponseType {
  const response = decodeSfControlResponse(input);
  if (response.correlationId !== request.correlationId) {
    throw new UnexpectedSfControlResponseError();
  }
  if (response.type === "success" && !sameCommand(response.result.command, request.command)) {
    throw new UnexpectedSfControlResponseError();
  }
  return response;
}

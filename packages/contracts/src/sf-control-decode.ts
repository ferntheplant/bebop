import { Schema } from "effect";

import {
  SfControlCommand,
  SfControlRequest,
  SfControlResponse,
  currentSfControlVersion,
  type SfControlRequest as SfControlRequestType,
  type SfControlResponse as SfControlResponseType,
} from "./sf-control.ts";

export class UnsupportedSfControlVersionError extends Error {
  readonly _tag = "UnsupportedSfControlVersionError";

  constructor(readonly receivedVersion: number) {
    super(`Unsupported sf control version ${receivedVersion}; expected ${currentSfControlVersion}.`);
    this.name = "UnsupportedSfControlVersionError";
  }
}

export class InvalidSfControlRequestError extends Error {
  readonly _tag = "InvalidSfControlRequestError";

  constructor(options?: ErrorOptions) {
    super("Invalid sf control request.", options);
    this.name = "InvalidSfControlRequestError";
  }
}

export class InvalidSfControlResponseError extends Error {
  readonly _tag = "InvalidSfControlResponseError";

  constructor(options?: ErrorOptions) {
    super("Invalid sf control response.", options);
    this.name = "InvalidSfControlResponseError";
  }
}

export class UnexpectedSfControlResponseError extends Error {
  readonly _tag = "UnexpectedSfControlResponseError";

  constructor() {
    super("The sf control response did not match its request.");
    this.name = "UnexpectedSfControlResponseError";
  }
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
  if (
    response.type === "success" &&
    JSON.stringify(Schema.encodeSync(SfControlCommand)(response.result.command)) !==
      JSON.stringify(Schema.encodeSync(SfControlCommand)(request.command))
  ) {
    throw new UnexpectedSfControlResponseError();
  }
  return response;
}

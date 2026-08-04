import { describe, expect, test } from "vite-plus/test";

import {
  InvalidSfControlRequestError,
  InvalidSfControlResponseError,
  UnsupportedSfControlVersionError,
  UnexpectedSfControlResponseError,
  decodeSfControlRequest,
  decodeSfControlResponse,
  decodeSfControlResponseForRequest,
} from "#src/sf-control-decode.ts";
import { currentSfControlVersion } from "#src/sf-control.ts";

const request = {
  type: "request",
  controlVersion: currentSfControlVersion,
  correlationId: "corr-01",
  command: { type: "status" },
} as const;

describe("sf control boundary decoding", () => {
  test("decodes current-version requests", () => {
    expect(decodeSfControlRequest(request).command.type).toBe("status");
  });

  test("distinguishes unsupported versions from malformed requests", () => {
    expect(() => decodeSfControlRequest({ ...request, controlVersion: currentSfControlVersion + 1 })).toThrow(
      UnsupportedSfControlVersionError,
    );
    expect(() => decodeSfControlRequest({ ...request, command: { type: "destroy" } })).toThrow(
      InvalidSfControlRequestError,
    );
  });

  test("rejects malformed daemon responses with a response-specific error", () => {
    expect(() => decodeSfControlResponse({ controlVersion: currentSfControlVersion, type: "success" })).toThrow(
      InvalidSfControlResponseError,
    );
  });

  test("rejects a valid response that does not match its request", () => {
    const decodedRequest = decodeSfControlRequest(request);
    expect(() =>
      decodeSfControlResponseForRequest(
        {
          type: "error",
          controlVersion: currentSfControlVersion,
          correlationId: "corr-other",
          error: { code: "invalid_state", message: "Not available." },
        },
        decodedRequest,
      ),
    ).toThrow(UnexpectedSfControlResponseError);
  });
});

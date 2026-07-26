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

const request = {
  type: "request",
  controlVersion: 1,
  correlationId: "corr-01",
  command: { type: "status" },
} as const;

describe("sf control boundary decoding", () => {
  test("decodes current-version requests", () => {
    expect(decodeSfControlRequest(request).command.type).toBe("status");
  });

  test("distinguishes unsupported versions from malformed requests", () => {
    expect(() => decodeSfControlRequest({ ...request, controlVersion: 2 })).toThrow(UnsupportedSfControlVersionError);
    expect(() => decodeSfControlRequest({ ...request, command: { type: "destroy" } })).toThrow(
      InvalidSfControlRequestError,
    );
  });

  test("rejects malformed daemon responses with a response-specific error", () => {
    expect(() => decodeSfControlResponse({ controlVersion: 1, type: "success" })).toThrow(
      InvalidSfControlResponseError,
    );
  });

  test("rejects a valid response that does not match its request", () => {
    const decodedRequest = decodeSfControlRequest(request);
    expect(() =>
      decodeSfControlResponseForRequest(
        {
          type: "error",
          controlVersion: 1,
          correlationId: "corr-other",
          error: { code: "invalid_state", message: "Not available." },
        },
        decodedRequest,
      ),
    ).toThrow(UnexpectedSfControlResponseError);
  });
});

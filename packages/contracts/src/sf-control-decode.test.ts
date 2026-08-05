import { Redacted } from "effect";
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
  controlVersion: 2,
  correlationId: "corr-01",
  command: { type: "status" },
} as const;

describe("sf control boundary decoding", () => {
  test("decodes current-version requests", () => {
    expect(decodeSfControlRequest(request).command.type).toBe("status");
  });

  test("decodes a mutating request with an operator credential", () => {
    const decoded = decodeSfControlRequest({
      ...request,
      operatorCredential: "bebop_op_credential",
      command: { type: "cancel" },
    });
    expect(decoded.command.type).toBe("cancel");
    expect(decoded.operatorCredential !== undefined && Redacted.value(decoded.operatorCredential)).toBe(
      "bebop_op_credential",
    );
  });

  test("distinguishes unsupported versions from malformed requests", () => {
    expect(() => decodeSfControlRequest({ ...request, controlVersion: 3 })).toThrow(UnsupportedSfControlVersionError);
    expect(() => decodeSfControlRequest({ ...request, command: { type: "destroy" } })).toThrow(
      InvalidSfControlRequestError,
    );
  });

  test("rejects malformed daemon responses with a response-specific error", () => {
    expect(() => decodeSfControlResponse({ controlVersion: 2, type: "success" })).toThrow(
      InvalidSfControlResponseError,
    );
  });

  test("rejects a valid response that does not match its request", () => {
    const decodedRequest = decodeSfControlRequest(request);
    expect(() =>
      decodeSfControlResponseForRequest(
        {
          type: "error",
          controlVersion: 2,
          correlationId: "corr-other",
          error: { code: "invalid_state", message: "Not available." },
        },
        decodedRequest,
      ),
    ).toThrow(UnexpectedSfControlResponseError);
  });
});

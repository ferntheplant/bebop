import { Redacted, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";

import {
  BadRequestError,
  BountyEventEnvelope,
  BountySseEvent,
  CreateBountyRequest,
  CreateTokenResponse,
  ListTokensResponse,
  bebopOpenApi,
} from "#src/http.ts";
import { ApiTokenName } from "#src/scalars.ts";

const timestamp = "2026-07-26T12:34:56.000Z";

describe("Bebop HTTP contracts", () => {
  test("decodes the create-bounty request from the specification", () => {
    const encoded = {
      repository: "withco/bebop",
      baseRef: "main",
      computeProfile: "standard",
      primaryContext: ["sentry", "figma"],
      initialPrompt: "Implement cursor replay.",
    } as const;
    const decoded = Schema.decodeUnknownSync(CreateBountyRequest)(encoded);
    expect(Schema.encodeSync(CreateBountyRequest)(decoded)).toEqual(encoded);
  });

  test("uses stable request-correlated error bodies", () => {
    const encoded = { code: "bad_request", message: "The base ref is invalid.", requestId: "req-01" } as const;
    const decoded = Schema.decodeUnknownSync(BadRequestError)(encoded);
    expect(Schema.encodeSync(BadRequestError)(decoded)).toEqual(encoded);
  });

  test("round-trips cursor-bearing SSE events with JSON data", () => {
    const data = {
      cursor: 12,
      bountyId: "bty-01jz8j3d9f4x",
      occurredAt: timestamp,
      event: { type: "bounty_status_changed", status: "autonomous" },
    } as const;
    const encoded = { id: "12", event: "bounty_event", data: JSON.stringify(data) } as const;
    const decoded = Schema.decodeUnknownSync(BountySseEvent)(encoded);

    expect(Schema.encodeSync(BountyEventEnvelope)(decoded.data)).toEqual(data);
    expect(Schema.encodeSync(BountySseEvent)(decoded)).toEqual(encoded);
    expect(() => Schema.decodeUnknownSync(BountySseEvent)({ ...encoded, id: "13" })).toThrow();
  });

  test("generates OpenAPI from the same API contract", () => {
    expect(bebopOpenApi).toMatchObject({
      openapi: "3.1.0",
      info: { title: "Bebop API", version: "1.0.0" },
      components: { securitySchemes: { bearer: { type: "http", scheme: "Bearer" } } },
      paths: {
        "/api/bounties": { get: {}, post: {} },
        "/api/bounties/{bountyId}": { delete: {}, get: {} },
        "/api/bounties/{bountyId}/events": {
          get: { responses: { "200": { content: { "text/event-stream": {} } } } },
        },
        "/api/bounties/{bountyId}/attachments": { get: {} },
        "/api/bounties/{bountyId}/evidence": { get: {} },
        "/api/bounties/{bountyId}/approve-config": { post: {} },
        "/api/bounties/{bountyId}/merge": { post: {} },
        "/api/bounties/{bountyId}/stop": { post: {} },
        "/api/bounties/{bountyId}/recover": { post: {} },
        "/api/tokens": { get: {}, post: {} },
        "/api/tokens/{tokenId}": { delete: {} },
      },
    });
  });

  test("authenticates every route that touches state, and only those", () => {
    const secured: Array<string> = [];
    const open: Array<string> = [];
    for (const [path, operations] of Object.entries(bebopOpenApi.paths)) {
      for (const [method, operation] of Object.entries(operations ?? {})) {
        const security = (operation as { security?: ReadonlyArray<unknown> }).security;
        (security === undefined || security.length === 0 ? open : secured).push(`${method.toUpperCase()} ${path}`);
      }
    }

    // Liveness is the only unauthenticated route. `docs/design/SYSTEM.md` §24's container health checks
    // must not need a credential baked into the image; nothing else may be reachable
    // without a bearer token.
    expect(open).toEqual(["GET /api/health"]);
    expect(secured).toContain("POST /api/bounties");
    expect(secured).toContain("GET /api/tokens");
    expect(secured).toContain("DELETE /api/tokens/{tokenId}");
  });

  test("returns a token secret exactly once, at creation", () => {
    const created = Schema.decodeUnknownSync(CreateTokenResponse)({
      token: { tokenId: "tok_01", name: "fern-cli", createdAt: "2026-07-26T12:34:56.000Z" },
      secret: "bbp_live_9f2c1de6a4b7c8d9",
    });
    expect(Redacted.value(created.secret)).toBe("bbp_live_9f2c1de6a4b7c8d9");

    // A listed token is metadata only: the plaintext exists once, in the creation response.
    const listed = Schema.decodeUnknownSync(ListTokensResponse)({
      tokens: [{ tokenId: "tok_01", name: "fern-cli", createdAt: "2026-07-26T12:34:56.000Z" }],
    });
    expect(listed.tokens[0]).not.toHaveProperty("secret");
    expect(() => Schema.decodeUnknownSync(ApiTokenName)("Fern CLI")).toThrow();
  });
});

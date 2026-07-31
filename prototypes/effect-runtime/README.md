# Prototype: Effect HTTP, SSE, WebSocket, and CLI on the pinned Bun

**Status:** Complete — assumption **confirmed**, with one API shape worth knowing before Milestone 3

**Date:** 2026-07-26

**Pinned versions:** Bun 1.3.14, `effect@4.0.0-beta.101`, `@effect/platform-bun@4.0.0-beta.101`

**Assumption under test:** [`docs/design/SYSTEM.md`](../../docs/design/SYSTEM.md) §25 — Effect 4 `effect/unstable/httpapi` for the HTTP API
with generated OpenAPI, `effect/unstable/cli` for the CLI — and §18.1, "each Swordfish initiates an outbound,
reconnecting WebSocket to bebop".

**Milestone:** Milestone 0, "Verify Effect HTTP, Postgres, SQLite, WebSocket, and CLI packages work on the
selected Bun version." Postgres and SQLite are covered by [`prototypes/persistence`](../persistence/README.md); this
prototype covers the rest of that sentence.

## Verdict

**Confirmed.** 14/14 probes pass. An Effect 4 HTTP server built from `HttpApi` schemas starts on Bun, enforces
bearer security, rejects malformed payloads at the boundary, streams SSE with race-free cursor replay, accepts
WebSocket upgrades, survives client disconnects and oversized frames, and the CLI reports failure with a nonzero
exit status.

Milestone 2 had already built these schemas and generated OpenAPI from them, which proved they type-check and
encode. Nothing had ever _started a server_ with them. That gap is now closed, and Milestones 3, 4, and 5 can
proceed on this stack.

| Probe | Question                                                                      | Result                        |
| ----- | ----------------------------------------------------------------------------- | ----------------------------- |
| H1    | a bearer-authenticated route responds with a decodable payload                | 200, decoded                  |
| H2    | a missing bearer token is refused with the declared typed error               | 401 `{"code":"unauthorized"}` |
| H3    | a wrong bearer token is refused                                               | 401                           |
| H4    | a payload violating its schema is refused at the boundary, not in the handler | 4xx, handler never ran        |
| H5    | OpenAPI generated from the served api declares bearer security                | scheme present on the route   |
| S1    | a fresh stream delivers every stored event in order, id equal to cursor       | cursors 1–8, ids match        |
| S2    | `Last-Event-ID` replays from the cursor and continues live                    | cursors 4–8, no gap, no dupe  |
| S3    | a cursor past the stored range yields only live events                        | live only                     |
| W1    | an outbound client round-trips framed messages in both directions             | echoed                        |
| W2    | a new connection after a disconnect works and the server stayed up            | echoed                        |
| W3    | an oversized frame fails closed without taking the server down                | refused, next client fine     |
| C1    | a subcommand parses its flags and exits 0                                     | exit 0                        |
| C2    | an unknown flag exits nonzero and prints usage                                | exit 1, usage printed         |
| C3    | a failing command exits nonzero rather than reporting success                 | exit 1                        |

## Findings

### 1. Security middleware _wraps_ the endpoint; it does not merely validate (new)

This is the finding most likely to cost Milestone 3 an afternoon. An Effect 4 `HttpApiMiddleware` security
handler has this shape:

```ts
bearer: (httpEffect, { credential, endpoint, group }) => Effect<HttpServerResponse, ...>
```

It receives **the endpoint's own effect** and must return it for the request to proceed:

```ts
bearer: (httpEffect, { credential }) =>
  Redacted.value(credential) === expected
    ? httpEffect                                   // let the request through
    : Effect.fail({ code: "unauthorized", ... }),  // refuse it
```

The natural reading of `HttpApiSecurity.bearer` — "a function from a credential to a validation effect" — type-checks
against nothing useful and fails at runtime with `Unable to get redacted value`, because the first argument is the
wrapped effect, not the token. Worse, a middleware that returns `Effect.void` on success **silently skips the
handler** rather than erroring, so the failure mode for getting this wrong is a route that appears to authorise
correctly and returns nothing.

Bebop declares `BearerAuthentication` on the whole API (`packages/contracts/src/http.ts`), so every route
depends on this one function being written correctly. It deserves a test that asserts an authorised request
reaches its handler, not only that an unauthorised one is refused.

### 2. SSE replay-then-live is race-free by construction (confirmed)

Milestone 3's exit criterion is "SSE replay delivers each stored event once in sequence before switching to live
delivery". `HttpApiSchema.StreamSse` handlers return a `Stream`, and `Stream.concat(replay, live)` gives that
property for free: the live stream is not subscribed to until replay has finished emitting, so there is no
window in which a live event can overtake a replayed one.

With `Last-Event-ID: 3` against 5 stored events plus 3 live ones, the client observed exactly `[4,5,6,7,8]` —
contiguous, nothing before the cursor, nothing duplicated, and the handoff crossed into live events (S2).

The `id`-equals-cursor invariant Milestone 2 fixed in the contracts is enforceable in the event schema itself, as
a `Schema.check` on the SSE event struct, and it held across every frame (S1).

One caveat this prototype does **not** answer: it reads each stream to completion over a bounded set of live events.
It does not exercise a client that disconnects mid-stream, nor backpressure from a slow consumer. Those belong to
Milestone 3, where the live stream is a real subscription rather than a finite range.

### 3. WebSocket upgrade and the outbound client both work (confirmed)

`HttpServerRequest.upgrade` yields a `Socket` on the server; `BunSocket.layerWebSocket(url)` provides one on the
client. Messages round-tripped in both directions (W1), and a second connection opened after the first closed
worked against the same server (W2) — which is the shape of `SYSTEM.md` §18.1's reconnecting channel, though not yet its
reconnect _policy_.

Two operational details:

- A client disconnect **interrupts the server-side socket fiber**, and that interrupt propagates. The route must
  catch it (`Effect.catchCause(() => Effect.void)`), or an ordinary disconnect is logged as a server error. It is
  reported as HTTP status 499 in the access log either way.
- Failing closed on an oversized frame works and does not affect the server: the offending connection was refused
  and closed, and the next client connected and echoed normally (W3). This is the mechanism Milestone 5's
  "bounded queues and oversized or malformed messages fail closed" scenario needs. `Socket.SendQueueCapacity` is
  the corresponding knob on the send side and is not exercised here.

### 4. The CLI needs a `Stdio` layer that `BunRuntime.runMain` does not supply (confirmed)

`Command.run` reads argv from the `Stdio` service rather than `process.argv`, and `BunRuntime.runMain` does not
provide it. Without `BunStdio.layer` the CLI fails at startup with `Service not found: ~effect/Stdio` — for every
invocation, including `--help`.

With it, exit codes behave as Milestone 4 requires: a parsed command exits 0, an unknown flag exits 1 with usage,
and a command whose effect fails exits 1 (C1–C3). `sf` can therefore express "the daemon is absent" as a status
rather than only as text.

### 5. The Bun HTTP server's clean shutdown looks like a failure (process finding)

Closing the scope that owns the server interrupts the listening fiber, and `Effect.runPromise` surfaces that as a
rejected promise: `All fibers interrupted without error`. A prototype or test that treats a nonzero exit as "probes
failed" will report a false failure after a completely successful run.

The driver checks `Cause.hasInterruptsOnly` and accepts an interrupt-only cause as a clean shutdown, re-raising
anything else. Milestone 3's graceful-shutdown work and its component tests will need the same distinction.

## What this prototype deliberately does not cover

- The **real** `BebopHttpApi` is not served — that means implementing every Milestone 3 handler. The prototype serves
  a miniature with the same constructs: API-wide bearer middleware, schema-checked payloads, typed error
  responses carried as schemas, and a `StreamSse` endpoint keyed on `Last-Event-ID`.
- Reconnect _policy_ (backoff, resume from an acknowledged cursor) is Milestone 5's, not this prototype's. W2 shows a
  second connection succeeds; it does not show Swordfish deciding to make one.
- No TLS, no proxy, no HTTP/2.

## Running it

No credentials, no containers, no network beyond loopback.

```bash
vp run @bebop/prototype-effect-runtime#prototype
```

Exits nonzero if any probe fails. Writes `results.json` next to this file; it is gitignored. The server binds an
ephemeral port and lives in a scope, so an interrupted run leaves no listener behind.

## Layout

| Path        | Purpose                                                                           |
| ----------- | --------------------------------------------------------------------------------- |
| `api.ts`    | A miniature of the bebop API, shaped like `packages/contracts/src/http.ts`        |
| `server.ts` | Handlers, bearer middleware, the SSE replay-then-live stream, the WebSocket route |
| `run.ts`    | Driver: starts the server, runs all 14 probes, reports                            |
| `cli.ts`    | A stand-in for `bebop` / `sf`, run as a child process so exit codes are real      |

This is a prototype, not product code. The real API lands in `apps/bebop` during Milestone 3, the daemon and `sf` in
`apps/swordfish` during Milestone 4, and the protocol in Milestone 5.

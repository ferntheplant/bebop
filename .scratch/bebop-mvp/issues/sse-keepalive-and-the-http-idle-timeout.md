---
type: grilling
status: open
---

# Should the bounty event stream emit a keep-alive, and what does that do to the SSE contract?

## Question

An SSE subscription with nothing to say is closed by the server after `BEBOP_HTTP_IDLE_TIMEOUT`. This is
demonstrated, not suspected — the repro below fails in under four seconds on an idle machine.

`bountyEventStream` (`apps/bebop/src/api/event-stream.ts:42-47`) documents itself as a stream that "never
completes on its own", where "the connection ends when the client disconnects or the server shuts down". That
is false. It also ends when the connection is quiet for longer than the idle timeout, because the stream emits
only real events and nothing in the path writes a keep-alive. Bun's `idleTimeout` is per-server
(`test/component/support/harness.ts:157` passes it to `BunHttpServer.layer`) and does not distinguish a
streaming response from an idle keep-alive socket.

**A quiet bounty is the normal case, not an edge case.** A bounty parked in `needs_attention`, or waiting on a
long CI run, produces no events for minutes. Every client tailing it — `bounty events`, the cockpit status
pane, any machine client of the API — has its connection dropped and sees a transport error rather than a
clean end. That touches [`ABSTRACT.md`](../../../ABSTRACT.md) §8 criterion 40 and the reconnect story in
[recovery and reliability](../../../docs/capabilities/13-recovery-and-reliability.md).

This surfaced while diagnosing a CI flake: the component harness had a two-second idle timeout, so on a starved
runner ordinary requests crossed it and four unrelated suites failed intermittently with `ECONNRESET`. The
harness now uses a generous window, which removed the flake — but that fix only moved the window. The stream
still dies whenever a real deployment's idle timeout elapses.

### What has to be settled

- Whether the stream emits a keep-alive at all, or whether the answer is that clients must reconnect and the
  contract should say so plainly. Reconnect is already specified via `Last-Event-ID`, so "drop and resume" is a
  defensible position — but it is currently accidental rather than chosen, and the drop presents as a socket
  error rather than a clean stream end.
- If it does emit one: **what it is on the wire.** `BountySseEvent`
  (`packages/contracts/src/http.ts:163-174`) is a closed struct with `event: Schema.Literal("bounty_event")`
  and a filter requiring `id` to equal the cursor. A keep-alive is neither. The options are a union member
  (`event: "keepalive"`, no id, relaxing the filter to apply only to `bounty_event`), or an SSE comment line —
  which is the conventional answer and invisible to clients, but `HttpApiSchema.StreamSse` may not expose a
  channel for one. Establish whether it does before choosing.
- What a keep-alive interval is derived from. It has to be shorter than the smallest idle timeout the stream
  can meet, which means the interval and `httpIdleTimeout` stop being independent settings — one has to be
  computed from the other, or the pair has to be validated at config load.
- Whether the same hole exists on the Swordfish gateway WebSocket. `BEBOP_HEARTBEAT_INTERVAL` exists there, so
  probably not, but it has not been checked against the same idle timeout.
- Whether `httpIdleTimeout` should apply to streaming responses at all. Bun's per-request `server.timeout()`
  can override it per connection; whether that is reachable through the Effect platform layer is unknown, and
  if it is, it may be a better answer than a keep-alive because it needs no contract change.

Every commit invalidating downstream results is not in play here — this is a live-connection property, not a
gate result — but the decision is hard to reverse once clients depend on the frame vocabulary, so it likely
wants an ADR rather than a resolution comment.

### Reproduction

The probe is not committed: it fails, and a red gate is not a useful artifact. Recreate it as
`apps/bebop/test/component/idle-stream.test.ts`, run it, watch it fail, then delete it — or keep it as the
regression test once the decision is made.

It depends on the `httpIdleTimeout` option added to `startHarness` for exactly this purpose
(`apps/bebop/test/component/support/harness.ts:100-113`), which lets one suite use a small idle window without
imposing it on every other suite.

```ts
// apps/bebop/test/component/idle-stream.test.ts
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import type { Harness } from "#test/component/support/harness.ts";
import { sampleCreateRequest, startHarness, testDatabaseAvailable } from "#test/component/support/harness.ts";

const suite = testDatabaseAvailable ? describe : describe.skip;

suite("Idle event stream", () => {
  let harness: Harness;
  let bountyId: string;

  beforeAll(async () => {
    // One second, so the idle window is crossed in a test-shaped amount of time rather than
    // a production-shaped one. The behaviour under test is not specific to this value.
    harness = await startHarness("idlestream", { httpIdleTimeout: "1 second" });
    const created = await harness.request("/api/bounties", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "idle-1" },
      body: JSON.stringify(sampleCreateRequest),
    });
    bountyId = ((await created.json()) as { bountyId: string }).bountyId;
  });

  afterAll(async () => {
    await harness.close();
  });

  test("survives an idle period longer than the HTTP idle timeout", async () => {
    const controller = new AbortController();
    const response = await harness.request(`/api/bounties/${bountyId}/events`, { signal: controller.signal });
    expect(response.ok).toBe(true);
    const reader = response.body!.getReader();

    // Drain whatever replay has to offer, then stop reading and let the stream go quiet.
    await reader.read();

    // Quiet for longer than the 1s idle window.
    await new Promise((resolve) => setTimeout(resolve, 2_500));

    // Produce an event. A live subscription must still be attached to receive it.
    await harness.request(`/api/bounties/${bountyId}/recover`, { method: "POST" });

    const next = await reader.read();
    controller.abort();

    expect(next.done, "the server closed the idle SSE connection").toBe(false);
  });
});
```

Run it with a database, under Bun — `vp test` is the Node path and will skip these suites:

```sh
docker compose up -d --wait postgres
export BEBOP_TEST_DATABASE_URL=postgres://bebop:bebop@127.0.0.1:5433/bebop
bun node_modules/vitest/vitest.mjs run apps/bebop/test/component/idle-stream.test.ts
```

Observed on 2026-08-02: fails in ~3.7s with
`Error: The socket connection was closed unexpectedly` — the same error the CI flake produced, with no load and
no concurrency involved.

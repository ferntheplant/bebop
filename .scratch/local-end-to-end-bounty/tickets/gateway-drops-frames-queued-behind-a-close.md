---
type: build
status: claimed
---

# The gateway drops frames queued behind a socket close, wedging a stopped bounty forever

Resolving this updates [Recovery and reliability](../../../docs/capabilities/13-recovery-and-reliability.md).

## What breaks

A stop that Swordfish completes can leave the bounty permanently unrestartable. Every daemon that starts
afterwards is handed the same stop, applies it as a no-op, and shuts itself down within a second of booting, so
`sf status` never finds a socket and the operator has no way back in. Nothing recovers it: the state that would
end the loop is the state that keeps repeating.

It surfaces in CI as the local-system harness failing on `alpha restart after completed stop`:

```
Error: Timed out waiting for alpha restart after completed stop: sf status failed:
Swordfish daemon is unavailable at …/run/control.sock
```

Seen on `main` (2026-08-06) and on `feat/local-provider-starts-the-daemon` (2026-08-07) — roughly two runs in
fifteen. The suite runs on every CI run; nothing is cached away.

## The mechanism, in four links

1. `apps/bebop/src/swordfish-gateway/gateway.ts` reads frames in one fiber and processes them in another, with
   a bounded queue between them so the protocol stays ordered. The handler ends with
   `Effect.raceFirst(reader, Fiber.join(consumer))`, so a closed socket wins the race and **interrupts the
   consumer with frames still in the queue**. They are dropped.
2. `apps/swordfish/src/protocol/client.ts` sends a completed stop's `command_result` and requests shutdown in
   the same breath, so its last frame and its close arrive together. That close is what races the consumer.
3. `apps/bebop/src/persistence/commands.ts` selects `status IN ('queued', 'delivered')` for delivery, so a
   command with no recorded result is redelivered on every registration and every poll. Correct at-least-once
   behaviour, and it is what turns one dropped frame into an endless one.
4. `apps/swordfish/src/workflow/service.ts` returns the _stored_ result for a command it has already applied,
   and the client shuts down on any completed stop result without distinguishing "applied now" from "replayed".
   So each redelivery is fatal to the daemon that receives it.

Link 1 is the defect. The other three are working as designed and are what make its consequence permanent
rather than a retry.

This is the rule at the top of `gateway.ts` — _an acknowledgement is a promise that the event is durable_ —
failing for command results specifically. Events survive it because Swordfish re-sends an unacknowledged event
from its outbox on reconnect ([Replay fails closed (ADR 0029)](../../../docs/adr/0029-replay-fails-closed.md)). A command result has no such outbox: the daemon reports
it once and is gone.

## What was already tried, and why the obvious fix is not enough

Two attempts, both green on `vp check`, both still failing the regression test below. The close path has three
stacked problems, not one:

1. **Frames stranded in the queue.** The easy part: end the queue when the reader stops
   (`Queue.bounded<string, Cause.Done>` plus `Queue.end`) and join the consumer instead of racing it, so it
   drains what is left and completes on its own.
2. **A write to a closed socket never settles.** With the drain running, it stalled on the first heartbeat
   after the close — the handler writes a response, the peer is gone, and the write simply hangs. Draining
   therefore requires silencing writes first. Dropping those replies is safe: the peer is gone, and an
   unacknowledged event is recoverable through the same outbox replay above.
3. **Teardown does not wait for the drain.** With writes silenced the drain got further and then stopped
   partway: the consumer exited with a `Failure`, and `Fiber.join(consumer)` returned _before_ the consumer
   finished, so the handler returned and its scope closed over the top of it. The handler's lifecycle is
   entangled with the platform's socket lifecycle, and that entanglement is the unfinished part — it is what
   the next attempt has to understand before writing code.

A tempting shortcut that should be refused: making Swordfish ignore a _replayed_ stop result so it does not
shut down twice. It turns the CI failure green in two lines and hides the fact that Bebop is losing a durable
write. Fix the loss.

## Done when

- A `command_result` that arrives in the same frame batch as the socket close is recorded, and the command is
  not redelivered on the next registration.
- No inbound frame is dropped because the socket closed after it arrived, whatever its type.
- A write attempted after the peer is gone cannot stall the handler.
- The regression test below is in `apps/bebop/test/component/gateway.test.ts` and passes; it fails 3/3 against
  the current gateway.
- The local-system harness passes ten consecutive runs on a loaded machine.
- Cancellation and restart behaviour stay covered: a stop applied once still stops the daemon once.

## The regression test

Verified to fail 3/3 against the current gateway and to be unaffected by either partial fix above. The eight
heartbeats are what make it deterministic — they give the consumer enough queued work that it provably cannot
have reached the result frame by the time the close lands. Without them the race is real but too narrow to land
in-process, and the test passes either way.

```ts
test("records a command result that arrives in the same breath as the close", async () => {
  const bounty = await provisionedBounty("gateway-command-result-at-close");
  await harness.request(`/api/bounties/${bounty.bountyId}/stop`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "Stop this one." }),
  });

  const first = await connect(harness, bounty.token);
  register(first, bounty);
  await first.next("registered");
  const command = await first.next<{ commandId: string }>("command");

  // The heartbeats go first so the result is provably still queued when the close lands: the
  // consumer projects each one in its own transaction, so it cannot have reached the last frame
  // by the time the socket closes a moment later. Without them the race is real but too narrow
  // to land in-process, and the test would pass either way.
  for (let beat = 0; beat < 8; beat += 1) {
    first.send({
      type: "heartbeat",
      protocolVersion: 1,
      bountyId: bounty.bountyId,
      vmId: bounty.vmId,
      sentAt: at(beat),
      lastProducedEventSequence: 0,
    });
  }

  // Swordfish reports a completed stop and requests shutdown in the same breath, so its last
  // frame and its close arrive together. Nothing may sit unread in the inbound queue when the
  // socket closes: a result dropped here leaves the command forever undelivered, redelivered on
  // every reconnect — and a redelivered stop shuts the next daemon down as soon as it boots, so
  // the bounty can never be restarted.
  first.send({
    type: "command_result",
    protocolVersion: 1,
    bountyId: bounty.bountyId,
    vmId: bounty.vmId,
    commandId: command.commandId,
    status: "completed",
    reportedAt: at(0),
  });
  first.close();
  await first.closed;

  const second = await connect(harness, bounty.token);
  register(second, bounty);
  await second.next("registered");
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(second.received.filter((message) => message["type"] === "command")).toHaveLength(0);
  second.close();
});
```

## How it was found

The local-system failure looks like a flake and is not one. It reproduced deterministically on the first
attempt by adding a 500ms delay before the gateway processes a `command_result` frame — the exact CI error, on
a machine where the suite otherwise passed 5/5. That probe is the cheapest way back to it if the next attempt
needs to see it fail.

Diagnosing it from CI alone is not currently possible: the harness deletes its scratch root in `finally`, so
the daemon's `swordfish.log` — which says outright that the daemon received a stop and shut down — never
reaches the CI output. Dumping the tail of that log on failure is worth doing alongside this, though it is not
a condition of being done.

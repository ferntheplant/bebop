# Prototype: real Bebop-Swordfish processes over loopback

**Status:** Complete - the packed process seam composes; six of six probes pass

**Date:** 2026-08-04

**Question:** What breaks when the packed Bebop API, worker, CLI, Swordfish daemon, and `sf` CLI run as separate
processes against real Postgres and SQLite over loopback? In particular, do startup order, listener loss, daemon
loss, process restart, event replay, command delivery, acknowledgement, projection, and cancellation preserve
state without duplication?

This is the throwaway probe for
[issue 20](../../.scratch/bebop-mvp/issues/20-real-process-local-protocol.md). It deliberately does not add a local
compute provider, test-only event injection, OpenCode prompting, repository hooks, GitHub, or an autonomous
workflow producer.

## Running it

Requires a running Docker daemon. It needs no credentials, subscription, or network beyond pulling Postgres and
using loopback.

```bash
vp run @bebop/prototype-real-process-local-protocol#prototype
```

The task builds the packed Bebop and Swordfish entrypoints, starts disposable Postgres, and tears down every
process, socket, SQLite database, and container before exit. It writes detailed observations to `results.json`
and child-process output under `.prototype/logs/`; both are ignored.

## Known probe limitation

The packed fake lifecycle provider receives the retry-stable Swordfish credential and discards it. No production
API or CLI returns it, because Bebop correctly stores only its hash. Until the probe establishes the right local
bootstrap shape, its trusted driver derives the same bounty-scoped credential from the configured master key.
That derivation is a probe expedient, not a proposed second credential path.

## Verdict

The real packed implementations compose over loopback. Worker-first startup, daemon-first startup, API loss,
daemon `SIGKILL`, SQLite restart, event replay, command delivery, acknowledgement, and projection all preserve
one durable history without duplication. An offline Bebop stop is delivered once; after Swordfish records and
reports its terminal result, a second daemon restart remains running instead of receiving the command again.

The furthest honest production progression is exactly:

```text
provisioning -> interactive -> reconnect/replay -> cancelling -> cancelled
```

No production module activates ein, drives OpenCode, or emits effective-spec, attempt, turn, candidate, or gate
events. The probe therefore establishes a reliable transport floor for autonomous tracking; it does not establish
autonomy.

| Probe | Question                                                                   | Result |
| ----- | -------------------------------------------------------------------------- | ------ |
| RP1   | worker-first startup and all five packed entrypoints reach `interactive`   | pass   |
| RP2   | API loss and restart reconnect without duplicate projection                | pass   |
| RP3   | a `SIGKILL`ed daemon restarts from SQLite without duplicate replay         | pass   |
| RP4   | local `sf cancel` projects cancellation while Swordfish remains available  | pass   |
| RP5   | Swordfish started without a listener registers when Bebop later appears    | pass   |
| RP6   | an offline Bebop stop is delivered and reaches a terminal result only once | pass   |

## Findings

### 1. The local launcher, not the operator, must receive the machine credential

The retry-stable Swordfish token already has one correct path: Bebop derives it and passes it to
`LifecycleProvider.provision`; Bebop stores only its hash. The fake provider creates no computer and discards the
plaintext, so separate packed processes have no bootstrap handoff to complete.

The prototype duplicated the HMAC in its trusted throwaway driver only to open the seam. Product code must not
add a token-retrieval API or ask an operator to derive it. The smallest local harness should let the fake
lifecycle provider write a one-shot, mode-`0600` bootstrap artifact into a mode-`0700` scratch root. The harness
consumes and removes that artifact when it starts Swordfish. That is the local equivalent of VM injection through
the existing lifecycle interface, not a second credential path.

### 2. The protocol and persistence behavior hold between the real peers

Both startup orders reached `interactive`. Restarting the API changed local Swordfish state to `disconnected`,
then restored `connected` with acknowledgement cursor 1 and no pending events. Killing Swordfish made Bebop
observe `disconnected`; restarting against the same SQLite restored the same cursor. Every replay inspection
contained exactly one `stage_changed:interactive`.

Cancellation produced exactly one event at each stage: `interactive`, `cancelling`, and `cancelled`. The offline
Bebop stop command survived daemon loss, shut the first restarted daemon down with exit code 0, and was not
redelivered to the next restart. No protocol change or ADR is justified by these observations.

### 3. Local cancel and Bebop stop now have distinct lifecycle authority

The original probe found that `sf stop` returned a local `cancelled` snapshot and then shut down the daemon before
the protocol heartbeat could deliver sequences 2 and 3. Bebop remained at `interactive` until Swordfish
restarted and replayed them.

The follow-up separates the adapters at their contracts seam. Local `sf cancel` maps to the existing workflow
cancellation transition without requesting daemon shutdown; the normal heartbeat delivers and acknowledges both
events while `sf status` remains available. A Bebop-issued `stop` still reports its terminal command result and
shuts the daemon down. RP4 now pins that distinction through the real packed processes. Operator-credential
enforcement for local mutations remains unbuilt.

### 4. API shutdown reaches its bounded drain deadline with live streams

Stopping the API with a Swordfish WebSocket and recently aborted SSE replay open consistently consumed the full
two-second shutdown timeout and logged `shutdown deadline passed with connections still draining`. The process
still exited and Swordfish reconnected safely. This is the bounded behavior already recorded in
[`docs/gotchas.md`](../../docs/gotchas.md#process-lifecycle), not a protocol failure; the production harness should
retain the timing assertion so shutdown cannot regress into a hang.

### 5. SSE replay works, but idle completion is still accidental

The prototype's bounded replay reader received every stored event. Depending on which timer won, Bun ended the
read with either `AbortError` or `The socket connection was closed unexpectedly`. This is the known unresolved
behavior in [issue 18](../../.scratch/bebop-mvp/issues/18-sse-keepalive-and-the-http-idle-timeout.md), not a new
finding. The WebSocket stayed healthy under the same short HTTP idle timeout because Swordfish heartbeats kept it
active.

### 6. The shipped CLIs do not yet match their documented surfaces

The packed `bebop` CLI has create, list, status, events, and config approval, but no stop, recover, destroy,
attachment, evidence, merge, or token commands even where the HTTP route exists. The packed `sf` CLI has the
settled `cancel` lifecycle behavior, but no watch/events, attach, authenticated mutation prompt, or
workflow-action commands. The prototype used authenticated HTTP only for the offline Bebop stop that has no CLI
adapter.

These are thin-client implementation gaps, not transport or protocol decisions.

## Next production slice

The probe justifies [the local system harness brief](../../.scratch/local-system-harness/brief.md). It turns this
throwaway driver into a maintained one-command process harness, moves credential handoff back into the lifecycle
injection path, and pins the restart/cancellation observations as regression scenarios. The production OpenCode
driver can then use that harness with the repository's scripted fake model endpoint to prove autonomous state
tracking without exe.dev or a paid model.

# REVIEW: Milestones 1–2 Implementation Review

**Status:** Draft 0.1

**Date:** 2026-07-26

**Reviewed against:** [`SPEC.md`](./SPEC.md) Draft 0.4, [`PLAN.md`](./PLAN.md) Draft 0.1

**Scope:** Everything merged through `6cba85f feat(contracts): complete milestone 2`

## 1. Baseline

Verified before reviewing:

- `vp check` is clean — 80 files formatted, 58 files linted and type-checked, zero warnings.
- `vp test --run apps packages` passes — 166 tests across 23 files.
- The process-level entrypoint integration test runs all five executables.

PLAN's claim that Milestones 1 and 2 are complete and validated is accurate. This review assumes that and
looks for what will hurt in Milestones 3 through 7.

Findings marked **verified** were reproduced with a throwaway probe harness against the real reducers, not
inferred from reading. The probe was deleted after use.

## 2. What is working

**State ownership is structurally enforced, not merely documented.** SPEC §9.3's rule that a disconnected
Swordfish cannot be presented as currently working is encoded as a discriminated union
(`SwordfishFreshness`, `apps/bebop/src/domain/swordfish-projection.ts:36`) rather than a boolean, and the
projection is scoped by `connectionId` so a replaced connection cannot mutate live state.

**Contracts-first is real.** `bebopOpenApi` (`packages/contracts/src/http.ts:253`) is generated from the same
`HttpApi` value the server will mount, and `http.test.ts` asserts the generated document's shape. There is no
hand-written OpenAPI document to drift from the schemas. SPEC §4.3 and §17.1 hold.

**`ExternalCiCompletedCommand` is the best decision in the protocol**
(`packages/contracts/src/protocol.ts:198`). Bebop polls GitHub, but the gate _state_ still transitions through
a Swordfish-emitted `gate_completed` event. One authority for gate state, and it degrades exactly as SPEC §18.4
requires when the master is unreachable.

**Commit-binding is schema-level.** Every gate outcome, invalidation, and evidence manifest carries both
`candidateSha` and `specRevision`. SPEC §4.6 is enforced by the type system rather than by reviewer discipline.

**Worth keeping as-is:** the `SfStatusSnapshot` cross-field filter
(`packages/contracts/src/sf-control.ts:124-172`) enforcing gate/candidate/spec coherence and "ready implies all
five gates passed"; the overlapping-path rejection in Swordfish configuration
(`apps/swordfish/src/config.ts:55-62`); `Schema.Redacted(..., { disallowJsonEncode: true })` on both secrets;
and `evidenceBlobObjectKey` (`packages/contracts/src/evidence.ts:125`) matching SPEC §23.2's canonical key
exactly.

## 3. High-level architecture

### H1. The workflow state machine is duplicated across two apps, and it has already drifted

`apps/swordfish/src/workflow/reducer.ts` (367 lines) and `apps/bebop/src/domain/swordfish-projection.ts`
(442 lines) carry near-identical copies of `initialGates`, `gateStage`, `stageChanges`, `attentionChanges`,
`eventFingerprint`, and the entire event switch.

PLAN's Milestone 2 exit criterion — "no app-local duplicate of a shared wire type exists" — is met narrowly.
The wire types are shared. The _interpretation_ of those types is not.

**Verified drift:** `reducer.ts:238-246` records `event.reason` into `attentionReason` on
`stage_changed → needs_attention`. The Bebop projection's corresponding branch
(`swordfish-projection.ts:198-205`) never touches `attentionReason`. Feeding the identical event to both:

```text
swordfish attentionReason: "hook is missing"
bebop     attentionReason: null
```

`BountyDetail.attentionReason` (`http.ts:69`) is user-visible, and it is where SPEC §15 constraint exhaustion
and §13.3 privileged-path blocks surface. A `needs_attention` bounty currently shows a blank reason to the CLI
whenever the reason arrived via `stage_changed` rather than `attention_required`.

**Recommendation.** PLAN §2.1 says not to create a package until a second app needs it. A second app needs it
now. Extract `packages/workflow` (pure, no I/O) holding the transition core; Bebop's projection becomes that
core plus connection and freshness scoping, which is its genuinely distinct concern. Do this before Milestones
3 and 4 write persistence on top of both copies — after that the two diverge under schema pressure and the
divergence becomes a migration.

### H2. No schema exists for the outputs of the stages the workflow gates on

`ReviewFinding` (`packages/contracts/src/review.ts:20`) is defined, exported, tested, and referenced by
nothing outside its own test. Jet's findings have no transport.

There is no validator-result schema at all, though SPEC §12.4 enumerates its fields (command, environment
profile, start and end time, exit status, captured output, artifact paths, candidate SHA). No QA scenario
outcome. No aggregated feedback packet (§12.8), which is the thing ein actually consumes in order to revise.

Today `gate_completed` carries only `passed | failed`. The _why_ has nowhere to live except unstructured
evidence blobs. Milestones 6 and 7 will need these, and absent a contract they will materialize as app-local
types in Swordfish — precisely the drift Milestone 2 existed to prevent. Deciding now whether feedback packets
ride the protocol or ride evidence bundles is cheap; deciding it mid-Milestone-7 is not.

### H3. `bebop token create|revoke|list` has no routes and no schemas

SPEC §17.3 lists the CLI commands; SPEC §17.2's route table omits them, so the specification is internally
inconsistent. But §17.4 and §22.1 both require hashed, named, revocable tokens, and §4.3 forbids CLI-only
behavior. Correct SPEC's route list and add the endpoint group in Milestone 3.

## 4. Mid-level: protocol and implementation design

### M1. Registration carries no credential, and token rotation has no wire representation

SPEC §18.2 requires a bounty-scoped token, bound to VM identity, "expiring, rotated on reconnect."
`RegisterMessage` (`protocol.ts:49`) carries `bountyId`, `vmId`, `swordfishVersion`, and
`lastProducedEventSequence` — nothing else. `RegisteredMessage` returns no new token.

The implied design is an `Authorization` header on the WebSocket upgrade, which handles authentication but
leaves rotation with no slot. Decide before Milestone 5: add `token` to register and `rotatedToken` to
registered, or strike rotation from SPEC. As written, Milestone 5's required scenario "an invalid token, bounty
ID, VM ID, or protocol version is rejected" has no contract to test the token half against.

### M2. Bebop's freshness machine has no recovery path

**Verified.** After `freshness_expired`, heartbeats on the _same_ connection return `applied: false` and
freshness stays `stale` (`swordfish-projection.ts:400`); new events on that connection are dropped (`:422`).
The only edge back to `connected` is `connection_registered`.

A merely late heartbeat — a GC pause, a slow link, `swordfishStaleAfter` tuned tight — therefore permanently
freezes Bebop's view of a live, healthy socket and silently discards everything that socket sends.

Either heartbeats on the current connection should restore `connected`, or the gateway must be _required_ to
close the socket when it marks a connection stale, making "stale implies closing" an invariant. Neither is
expressed today, and the reducer permits the bad state.

### M3. `{ ok: true, applied: false }` conflates "duplicate, safe to acknowledge" with "stale, must not acknowledge"

**Verified** — both cases produce the identical result value:

```text
duplicate event                -> {"ok":true,"applied":false}
new event on stale connection  -> {"ok":true,"applied":false}
```

The Milestone 3 gateway must decide whether to send `event_acknowledged`. Acknowledging a dropped event loses
it permanently, because Swordfish then clears it from its outbox. Not acknowledging a duplicate loops replay
forever.

Add a discriminator — `applied: false` plus `reason: "already_applied" | "stale_connection" | "wrong_connection"`
— before the gateway is written. Otherwise Milestone 5's criterion "duplicate events are acknowledged without
duplicate projection changes" will be satisfied by an implementation that also acknowledges events it discarded.

### M4. `cancelling` is unprotected, so a late gate result resurrects a cancelled run

**Verified** in both reducers:

```text
stage after cancelling:       cancelling
stage after late gate result: revision
```

`stageChanges` (`reducer.ts:116`) guards only `human_controlled`, `needs_attention`, and `blocked`. In-flight
hooks and CI polls legitimately land _after_ a stop command, so this is reachable in normal operation, not only
adversarially. Add `cancelling` to the suspended set, or reject candidate-bound events outright while
cancelling.

### M5. The two protocols share payloads but version independently

`SfControlCommand` (`sf-control.ts:38`) reuses `StopCommand`, `TakeoverCommand`, `ExtendConstraintCommand`, and
`RetryStageCommand` from `protocol.ts`, while `currentProtocolVersion` and `currentSfControlVersion` are
separate constants. Adding a field to `TakeoverCommand` for the WebSocket protocol silently changes the local
socket contract without bumping its version.

The reuse itself is good. It needs one line of policy — shared command payloads live in a third module and both
versions bump together — because the golden fixtures cannot catch this.

### M6. `appliedEventFingerprints` is an unbounded map of full event copies

**Verified:** 60 events produce 60 retained fingerprints totalling 16.8 KB, and the map is a field of both
durable state types, so Milestones 3 and 4 will persist it. Each fingerprint is the complete re-encoded JSON of
the event (`reducer.ts:112`), so a long bounty stores every event twice.

The fingerprint only needs to defend against conflicting replay near the acknowledgement frontier, which is a
bounded window. Note also the fail-open at `reducer.ts:263-270`: a sequence at or below `lastAppliedSequence`
with no fingerprint present is treated as an idempotent no-op, so any future pruning silently weakens the
collision check unless the prune boundary is made explicit in state.

### M7. Health sits behind bearer authentication

`BebopHttpApi.middleware(BearerAuthentication)` (`http.ts:248`) covers every group, matching the recorded
Milestone 2 decision. But SPEC §24 wants health-checked blue/green containers behind Caddy, so Docker and Caddy
health checks will need a token baked into the image or the compose file.

Resolve deliberately in Milestone 3 — most likely an unauthenticated liveness route bound to the internal port,
distinct from the authenticated `/api/health`.

## 5. Low-level code details

**L1.** `ListBountiesEndpoint`'s `cursor` (`http.ts:178`) and `nextCursor` (`http.ts:76`) are bare
`Schema.String` — the only unvalidated strings at a boundary in an otherwise uniformly branded and
length-bounded contract. Give them a brand, pattern, and maximum length, as `BountyEventCursorString` has.

**L2.** `packages/contracts/test/golden/protocol-v1.json` is wire-valid but workflow-illegal: sequence 1
(`effective_spec_set`) already lands the reducer in `implementing`, then sequence 3 is
`stage_changed → implementing`, which `changeStage` rejects. Nothing fails today because the fixture is used
only for serialization round-trips, but a golden transcript that cannot be replayed is a trap for whoever wires
up Milestone 5. Either make it a legal transcript or rename it `protocol-v1-encoding.json`.

**L3.** `decodeSfControlResponseForRequest` compares commands via `JSON.stringify` of encoded values
(`sf-control-decode.ts:86`), which is key-order dependent. It works because both sides encode through the same
schema, but it breaks if a response is ever constructed by hand or round-tripped through a store. The same
pattern in `EvidenceBundleDownload` (`http.ts:91`) is safe because both arrays are sorted first.

**L4.** `HttpsUrl` (`scalars.ts:141`) calls `Schema.decodeUnknownSync` inside a filter and uses `try`/`catch`
for control flow on every decode. Immaterial at current volumes; worth remembering when it validates
`EvidenceBlobUploadTargets` in bulk.

**L5.** `applied()` casts `message.sequence as number as EventSequence` (`reducer.ts:103`) to launder
`ProducedEventSequence` (at least 1) into `EventSequence` (at least 0). Correct, but the double cast defeats
both brands. A `toEventSequence()` helper in contracts would be honest and greppable.

**L6.** `Candidate.activeDevelopmentServers[].url` is a raw `Schema.URLFromString` (`candidate.ts:35`) while
every other URL in the package is the canonicalized, scheme-checked `HttpsUrl`. Development servers are
http/localhost so `HttpsUrl` is genuinely wrong here, but a `LocalHttpUrl` with matching canonicalization would
fit the package's discipline.

**L7.** `EffectiveSpec` requires at least one acceptance criterion (`spec.ts:32`), which SPEC §7.5 does not
mandate. This looks like a deliberate and good tightening — `/auto` cannot hand off a spec with nothing to
verify against — but it is an implementation-added constraint that should be reflected back into SPEC §7.5 per
PLAN §9.

**L8.** The two reducers' error taxonomies are separate types with the same members (`WorkflowReducerError`
versus `BebopProjectionError` plus `identity_mismatch`). The H1 extraction resolves this.

## 6. Sequencing concern

PLAN still lists **Milestone 0 as in progress** while Milestones 1 and 2 are complete. The four outstanding
spikes are the ones that can invalidate the design — plugin lease guard, tmux input lock, pinned OpenCode with
a fake model endpoint, and the Postgres/SQLite round trip — and SPEC §29's "To verify during build" names the
same set.

The lease guard deserved to be pulled forward, independent of milestone order. SPEC §11.5's authoritative layer
is load-bearing for the entire control model (§16.2, acceptance criteria 12 and 13), and Milestone 7's own exit
criteria state that failure of the plugin lease-guard assumption "blocks the MVP rather than silently weakening
control." Four milestones of Bebop and Swordfish work sat between here and the point where that assumption
would otherwise have been tested.

**It was run, and the assumption was wrong in two places.** See
[`spikes/lease-guard/README.md`](./spikes/lease-guard/README.md) for the full transcript. In summary:

- throwing from a plugin hook does abort a turn before the model provider is contacted, so the guard is
  implementable for `message`, `prompt_async`, and `command`;
- `POST /session/:id/shell` executes in a leased seat with no hook firing at all;
- session storage is shared per project and `opencode serve --pure` skips project-local plugins, so a second
  instance drove a leased seat with no guard loaded.

Both gaps close with OpenCode configuration rather than new architecture — a per-boot
`OPENCODE_SERVER_PASSWORD` and a private `OPENCODE_DB` — which also turned the seat credential into a natural
takeover token. SPEC §11.5 went from two enforcement layers to four, and the credential's lifetime is now bound
to the control lease (§10.4, §10.5, §16.3, §16.4, §29.15).

This is the argument for the remaining Milestone 0 spikes. Two of four assumptions in one afternoon were
incorrect in ways that changed the design; the tmux input lock and the Postgres/SQLite round trip are still
untested, and the tmux lock is the last piece of the control model resting on assumption rather than evidence.

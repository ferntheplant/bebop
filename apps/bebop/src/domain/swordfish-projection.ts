// Bebop's durable projection of one Swordfish ("Bebop owns authority, Swordfish owns the loop" (ADR 0002)).
//
// The workflow transitions come from `@bebop/workflow`, which Swordfish applies too. What
// this module owns is the part Swordfish has no equivalent of: which connection is
// authoritative, how fresh it is, and the rule that a disconnected Swordfish must never be
// presented as currently working.

import type {
  BountyId,
  ConnectionId,
  EventMessage,
  HeartbeatMessage,
  EventSequence,
  SwordfishFreshnessStatus,
  SwordfishStage,
  Timestamp,
  VmId,
} from "@bebop/contracts";
import {
  applyWorkflowEvent,
  exhaustedConstraints,
  initialWorkflowCoreState,
  isSuspended,
  isTerminal,
  type ConstraintExhaustion,
  type WorkflowCoreState,
  type WorkflowError,
  type WorkflowSkipReason,
} from "@bebop/workflow";
import { DateTime } from "effect";

export type { ActiveCowboy, AttentionState, GateState, GateStates, ReadinessClaim } from "@bebop/workflow";

export type SwordfishFreshness =
  | { readonly status: Extract<SwordfishFreshnessStatus, "never_connected"> }
  | {
      readonly status: Extract<SwordfishFreshnessStatus, "connected">;
      readonly lastObservedAt: Timestamp;
      readonly lastHeartbeatSentAt?: Timestamp;
    }
  | {
      readonly status: Extract<SwordfishFreshnessStatus, "disconnected" | "stale">;
      readonly lastObservedAt: Timestamp;
    };

export interface BebopSwordfishProjection extends WorkflowCoreState {
  readonly bountyId: BountyId;
  readonly vmId: VmId;
  readonly lastProducedSequence: EventSequence;
  readonly connectionId: ConnectionId | null;
  readonly stage: SwordfishStage | null;
  readonly freshness: SwordfishFreshness;
}

export type BebopProjectionInput =
  | {
      readonly type: "connection_registered";
      readonly connectionId: ConnectionId;
      readonly observedAt: Timestamp;
    }
  | {
      readonly type: "event_received";
      readonly connectionId: ConnectionId;
      readonly message: EventMessage;
      readonly observedAt: Timestamp;
    }
  | {
      readonly type: "heartbeat_observed";
      readonly connectionId: ConnectionId;
      readonly message: HeartbeatMessage;
      readonly observedAt: Timestamp;
    }
  | { readonly type: "connection_lost"; readonly connectionId: ConnectionId; readonly detectedAt: Timestamp }
  | {
      readonly type: "freshness_expired";
      readonly connectionId: ConnectionId;
      readonly staleBefore: Timestamp;
      readonly detectedAt: Timestamp;
    };

export type BebopProjectionError =
  | WorkflowError
  | { readonly type: "identity_mismatch"; readonly expectedBountyId: BountyId; readonly expectedVmId: VmId };

/**
 * Why an input changed no workflow state.
 *
 * The gateway acknowledges on the reasons that mean "we already have this" and must not
 * acknowledge on `wrong_connection`: acknowledging an input Bebop discarded makes Swordfish
 * drop it from its outbox, and it is then lost for good.
 */
export type BebopProjectionSkipReason = WorkflowSkipReason | "wrong_connection" | "already_stale" | "recently_observed";

export type BebopProjectionResult =
  | { readonly ok: true; readonly applied: true; readonly state: BebopSwordfishProjection }
  | {
      readonly ok: true;
      readonly applied: false;
      readonly reason: BebopProjectionSkipReason;
      readonly state: BebopSwordfishProjection;
    }
  | { readonly ok: false; readonly error: BebopProjectionError };

export function makeInitialBebopSwordfishProjection(bountyId: BountyId, vmId: VmId): BebopSwordfishProjection {
  return {
    ...initialWorkflowCoreState(),
    bountyId,
    vmId,
    lastProducedSequence: 0 as EventSequence,
    connectionId: null,
    stage: null,
    freshness: { status: "never_connected" },
  };
}

function skip(state: BebopSwordfishProjection, reason: BebopProjectionSkipReason): BebopProjectionResult {
  return { ok: true, applied: false, reason, state };
}

function identityError(state: BebopSwordfishProjection): BebopProjectionResult {
  return {
    ok: false,
    error: { type: "identity_mismatch", expectedBountyId: state.bountyId, expectedVmId: state.vmId },
  };
}

/**
 * Records that the authoritative connection was heard from.
 *
 * This is the recovery edge the projection previously lacked. Once a connection was marked
 * `stale`, nothing but a fresh registration could move it back, so a merely late heartbeat
 * — a GC pause, a slow link, a tightly tuned `swordfishStaleAfter` — froze Bebop's view of
 * a live socket permanently and silently discarded everything that socket went on to send.
 *
 * Any traffic on the current connection is evidence of life, so both heartbeats and events
 * refresh it. `disconnected` is deliberately not recoverable here: `connection_lost` clears
 * `connectionId`, so traffic claiming that connection can no longer match.
 */
function observed(at: Timestamp, heartbeatSentAt?: Timestamp): SwordfishFreshness {
  return heartbeatSentAt === undefined
    ? { status: "connected", lastObservedAt: at }
    : { status: "connected", lastObservedAt: at, lastHeartbeatSentAt: heartbeatSentAt };
}

/**
 * Budgets this projection reads as long past their limit while Swordfish has reported nothing.
 *
 * This is a **defect signal about the daemon**, not an exhaustion, and Bebop acts on it by saying so rather than
 * by suspending anything. The ledger is Swordfish's state and Bebop cannot write workflow events
 * ("Bebop owns authority, Swordfish owns the loop" (ADR 0002)); what Bebop can do is apply the same reducer to
 * the same events and notice a disagreement, the way it already re-verifies a readiness claim
 * ("Readiness is a claim" (ADR 0003)).
 *
 * `graceMs` is subtracted from the observation instant rather than added to the budget, so the answer is "past
 * budget even discounting the margin". The margin is required because the projection lags the daemon by at least
 * the delivery of one event — tolerable for a defect signal, and disqualifying for a primary detector, which is
 * why the enforcing watchdog runs on the Swordfish side ("Constraint exhaustion is computed, not announced"
 * (ADR 0042)).
 */
export function unreportedBudgetOverrun(
  state: BebopSwordfishProjection,
  observedAt: Timestamp,
  graceMs: number,
): ReadonlyArray<ConstraintExhaustion> {
  // A daemon that has already said so is not a daemon that failed to.
  if (state.attention.some((record) => record.kind === "constraint_exhausted")) return [];
  if (state.controller !== "swordfish" || isSuspended(state.stage) || isTerminal(state.stage)) return [];

  const attempt = state.attempt;
  if (attempt === null) return exhaustedConstraints(state);
  const since = attempt.runningSince;
  const elapsedMs =
    since === null
      ? attempt.elapsedMs
      : attempt.elapsedMs + Math.max(0, DateTime.toEpochMillis(observedAt) - graceMs - DateTime.toEpochMillis(since));
  return exhaustedConstraints({ ...state, attempt: { ...attempt, elapsedMs } });
}

export function reduceBebopSwordfishProjection(
  state: BebopSwordfishProjection,
  input: BebopProjectionInput,
): BebopProjectionResult {
  if (input.type === "connection_registered") {
    return {
      ok: true,
      applied: true,
      state: {
        ...state,
        connectionId: input.connectionId,
        freshness: { status: "connected", lastObservedAt: input.observedAt },
      },
    };
  }

  if (input.type === "connection_lost" || input.type === "freshness_expired") {
    if (state.connectionId !== input.connectionId) {
      return skip(state, "wrong_connection");
    }
    if (input.type === "freshness_expired" && state.freshness.status !== "connected") {
      return skip(state, "already_stale");
    }
    if (
      input.type === "freshness_expired" &&
      state.freshness.status === "connected" &&
      DateTime.toEpochMillis(state.freshness.lastObservedAt) >= DateTime.toEpochMillis(input.staleBefore)
    ) {
      return skip(state, "recently_observed");
    }
    const lastObservedAt =
      state.freshness.status === "never_connected" ? input.detectedAt : state.freshness.lastObservedAt;
    return {
      ok: true,
      applied: true,
      state: {
        ...state,
        connectionId: input.type === "connection_lost" ? null : state.connectionId,
        freshness: { status: input.type === "connection_lost" ? "disconnected" : "stale", lastObservedAt },
      },
    };
  }

  // Heartbeats and events are both inbound traffic on a claimed connection.
  if (state.connectionId !== input.connectionId) {
    return skip(state, "wrong_connection");
  }
  if (input.message.bountyId !== state.bountyId || input.message.vmId !== state.vmId) {
    return identityError(state);
  }

  if (input.type === "heartbeat_observed") {
    const heartbeat = input.message;
    return {
      ok: true,
      applied: true,
      state: {
        ...state,
        lastProducedSequence: Math.max(
          state.lastProducedSequence,
          heartbeat.lastProducedEventSequence,
        ) as EventSequence,
        freshness: observed(input.observedAt, heartbeat.sentAt),
      },
    };
  }

  // The freshness refresh is applied before the event is, and survives a result that
  // applies no event: a duplicate still proves the socket is alive.
  const message = input.message;
  const refreshed: BebopSwordfishProjection = {
    ...state,
    freshness: observed(input.observedAt),
    lastProducedSequence: Math.max(state.lastProducedSequence, message.sequence) as EventSequence,
  };

  const outcome = applyWorkflowEvent(refreshed, message);
  if (!outcome.ok) {
    return { ok: false, error: outcome.error };
  }
  return outcome.applied ? { ok: true, applied: true, state: outcome.state } : skip(outcome.state, outcome.reason);
}

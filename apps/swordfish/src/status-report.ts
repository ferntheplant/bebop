// `sf status` as text: one status snapshot in, the block an operator reads out.
//
// It is a module rather than a private helper in `cli.ts` because it is the thing the cockpit
// promises — "a Swordfish correctly retrying with backoff and one that is genuinely stuck look
// identical otherwise" (`docs/capabilities/03-the-cockpit.md`) — and a promise about what an
// operator sees has to be testable without a socket, a daemon, or a terminal.

import type { SfBudgetSnapshot, SfStatusSnapshot } from "@bebop/contracts";
import { DateTime } from "effect";

export function renderStatusReport(snapshot: SfStatusSnapshot): string {
  const lines = [
    `bounty      ${snapshot.bountyId}`,
    `vm          ${snapshot.vmId}`,
    `repository  ${snapshot.repository}`,
    `branch      ${snapshot.assignedBranch}`,
    `stage       ${snapshot.stage}`,
    `control     ${snapshot.controller}`,
    `bebop       ${describeConnection(snapshot)}`,
    `ack         ${snapshot.bebopConnection.acknowledgedThrough}`,
    `outbox      ${snapshot.bebopConnection.pendingEventCount}`,
  ];
  // A stopped bounty prints what will restart it. Reading a reason and then having to work out which command
  // applies was the step `docs/capabilities/05-control-lease-and-takeover.md` asks us to remove. Each reason
  // gets its own exits, because clearing one may leave another outstanding.
  for (const attention of snapshot.attention) {
    lines.push(`attention   ${attention.kind}: ${attention.reason}`);
    lines.push(`resolve     ${attention.resolutions.join(", ")}`);
  }
  if (snapshot.suspendedStage !== undefined) {
    lines.push(`suspended   ${snapshot.suspendedStage}`);
  }
  // Matched by seat ID, since a retried role has more than one seat in this list.
  for (const seat of snapshot.seats) {
    const active = seat.seatId === snapshot.activeCowboy?.seatId ? " (active)" : "";
    lines.push(`seat        ${seat.role} ${seat.seatId}${active}`);
  }
  // The attempt in flight, with the ordinal and the two watchdogs it is running against. A stopped clock is
  // called out because "12 minutes elapsed" reads as progress when nothing is in fact accruing.
  const attempt = snapshot.attempt;
  if (attempt !== undefined) {
    lines.push(
      `attempt     ${attempt.scope} ${attempt.ordinal} (${attempt.role} ${attempt.seatId})${attempt.running ? "" : " [clock stopped]"}`,
    );
    lines.push(`turns       ${budget(attempt.turns)}`);
    lines.push(`wall clock  ${budget(minutes(attempt.wallClockMs))} min`);
  }
  for (const constraint of snapshot.constraints) {
    lines.push(`attempts    ${constraint.scope} ${budget(constraint.attempts)}`);
  }
  lines.push(`candidates  validated ${budget(snapshot.validatedCandidates)}`);
  // What actually ran out, as the arithmetic rather than as the daemon's assertion (ADR 0042).
  for (const entry of snapshot.exhausted) {
    const scope = entry.scope === undefined ? "" : `${entry.scope} `;
    lines.push(`exhausted   ${scope}${entry.constraint} ${entry.consumed}/${entry.allowed}`);
  }
  return lines.join("\n");
}

/** `consumed/allowed`, naming a grant only when one was made, so an unextended budget stays quiet. */
function budget(value: SfBudgetSnapshot): string {
  const granted = value.granted > 0 ? ` (${value.base} + ${value.granted} granted)` : "";
  return `${value.consumed}/${value.base + value.granted}${granted}`;
}

/** A span of milliseconds at the coarsest scale that still says something, clamped at zero. */
export function describeDuration(milliseconds: number): string {
  const clamped = Math.max(0, milliseconds);
  if (clamped < 1_000) return "0s";
  const seconds = Math.round(clamped / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
  const hours = Math.floor(minutes / 60);
  const minutesRemainder = minutes % 60;
  return minutesRemainder === 0 ? `${hours}h` : `${hours}h ${minutesRemainder}m`;
}

/**
 * The Bebop connection beside the stage.
 *
 * Durations are derived here, against the snapshot's own observation time, because the daemon
 * reports instants: a rendered "4m ago" computed daemon-side would be wrong by however long the
 * response took, and would be a second copy of a fact the timestamps already carry.
 */
export function describeConnection(snapshot: SfStatusSnapshot): string {
  const observedAt = DateTime.toEpochMillis(snapshot.observedAt);
  const connection = snapshot.bebopConnection;
  if (connection.state === "connected") return "connected";
  if (connection.state === "disconnected") {
    const since = describeDuration(observedAt - DateTime.toEpochMillis(connection.disconnectedSince));
    const retry = describeDuration(DateTime.toEpochMillis(connection.nextAttemptAt) - observedAt);
    return `disconnected ${since} ago, retry in ${retry}`;
  }
  return `never connected (${describeDuration(observedAt - DateTime.toEpochMillis(connection.neverConnectedSince))} trying)`;
}

function minutes(value: SfBudgetSnapshot): SfBudgetSnapshot {
  const toMinutes = (milliseconds: number) => Math.round(milliseconds / 60_000);
  return { consumed: toMinutes(value.consumed), base: toMinutes(value.base), granted: toMinutes(value.granted) };
}

// Structured logging for both Bebop processes (`docs/capabilities/15-deployment-and-operation.md`: "structured JSON logs").
//
// `AGENTS.md`'s architectural rules require that every log line carry `bounty_id`, `vm_id`, `seat`, `stage`,
// `candidate_sha`, and correlation IDs when they are available. The annotation helpers below
// are the only place those key names are spelled, so a renamed field cannot half-apply.

import type { BountyId, CommandId, ConnectionId, GitSha, SwordfishStage, VmId } from "@bebop/contracts";
import type { Layer } from "effect";
import { Effect, Logger } from "effect";

/** The process a log line came from. Both entrypoints ship the same image (`docs/capabilities/15-deployment-and-operation.md`). */
export type BebopComponent = "bebop-api" | "bebop-worker";

export interface LogContext {
  readonly bountyId?: BountyId;
  readonly vmId?: VmId;
  readonly stage?: SwordfishStage | null;
  readonly candidateSha?: GitSha | null;
  readonly connectionId?: ConnectionId;
  readonly commandId?: CommandId;
  readonly requestId?: string;
}

const annotationKeys = {
  bountyId: "bounty_id",
  vmId: "vm_id",
  stage: "stage",
  candidateSha: "candidate_sha",
  connectionId: "connection_id",
  commandId: "command_id",
  requestId: "request_id",
} as const satisfies Record<keyof LogContext, string>;

/**
 * Annotates an effect with whichever correlation fields are known.
 *
 * Absent and null are both dropped rather than logged as `"null"`: a line that says
 * `candidate_sha=null` reads as a fact about the bounty, when it only means the caller had
 * nothing to say.
 */
export function withLogContext<A, E, R>(context: LogContext, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  let annotated = effect;
  for (const [field, key] of Object.entries(annotationKeys) as ReadonlyArray<[keyof LogContext, string]>) {
    const value = context[field];
    if (value !== undefined && value !== null) {
      annotated = Effect.annotateLogs(annotated, key, String(value));
    }
  }
  return annotated;
}

/**
 * The logging layer for a deployed process: one JSON object per line on stdout.
 *
 * `BunRuntime.runMain` installs a pretty logger by default, which is the wrong shape for a
 * container whose logs are collected by line, so this replaces the logger set rather than
 * merging with it.
 */
export const structuredLoggingLayer: Layer.Layer<never> = Logger.layer([Logger.consoleJson]);

/** Tags every line from one process with the entrypoint that produced it. */
export function withComponent<A, E, R>(
  component: BebopComponent,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.annotateLogs(effect, "component", component);
}

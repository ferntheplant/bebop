// Swordfish's durable workflow state.
//
// The transition rules live in `@bebop/workflow` because Bebop's projection applies the
// same event stream and must reach the same conclusion. What is Swordfish's own is the
// starting point: Swordfish is the authority for its workflow and begins at `interactive`
// (`docs/capabilities/06-autonomous-implementation.md`), so its stage is never null.

import type { EventMessage, SwordfishStage } from "@bebop/contracts";
import {
  applyWorkflowEvent,
  initialWorkflowCoreState,
  type WorkflowCoreState,
  type WorkflowError,
  type WorkflowResult,
} from "@bebop/workflow";

export type { ActiveCowboy, AttentionState, GateState, GateStates, ReadinessClaim } from "@bebop/workflow";

export interface SwordfishWorkflowState extends WorkflowCoreState {
  readonly stage: SwordfishStage;
}

export type WorkflowReducerError = WorkflowError;
export type WorkflowReducerResult = WorkflowResult<SwordfishWorkflowState>;

export function makeInitialSwordfishWorkflowState(): SwordfishWorkflowState {
  return { ...initialWorkflowCoreState(), stage: "interactive" };
}

export function reduceSwordfishWorkflow(state: SwordfishWorkflowState, message: EventMessage): WorkflowReducerResult {
  return applyWorkflowEvent(state, message);
}

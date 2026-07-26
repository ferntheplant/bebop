import { Schema } from "effect";

import { AcceptanceCriterionId, SeatId, SpecRevision, Timestamp } from "./scalars.ts";
import { schemaLimits } from "./settings.ts";

const Title = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(schemaLimits.specTitleMaxLength), Schema.isTrimmed()),
);
const Description = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(schemaLimits.specDescriptionMaxLength), Schema.isTrimmed()),
);

export const AcceptanceCriterion = Schema.Struct({
  id: AcceptanceCriterionId,
  description: Description,
});
export type AcceptanceCriterion = typeof AcceptanceCriterion.Type;

export const SuggestedQaScenario = Schema.Struct({
  description: Description,
  expectedOutcome: Description,
});
export type SuggestedQaScenario = typeof SuggestedQaScenario.Type;

export const EffectiveSpec = Schema.Struct({
  revision: SpecRevision,
  title: Title,
  goal: Description,
  context: Schema.Array(Description),
  constraints: Schema.Array(Description),
  nonGoals: Schema.Array(Description),
  acceptanceCriteria: Schema.Array(AcceptanceCriterion).pipe(
    Schema.check(Schema.isMinLength(schemaLimits.acceptanceCriteriaMinItems)),
  ),
  suggestedQaScenarios: Schema.Array(SuggestedQaScenario),
  createdFromSeatId: SeatId,
  createdAt: Timestamp,
});
export type EffectiveSpec = typeof EffectiveSpec.Type;

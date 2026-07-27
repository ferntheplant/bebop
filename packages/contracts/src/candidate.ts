import { Schema } from "effect";

import { DevelopmentServerUrl, GitSha, Port, SpecRevision } from "./scalars.ts";
import { schemaLimits } from "./settings.ts";
import { AgentDisposition } from "./workflow.ts";

const Summary = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(schemaLimits.candidateSummaryMaxLength), Schema.isTrimmed()),
);
const Command = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(schemaLimits.candidateCommandMaxLength), Schema.isTrimmed()),
);
const ServerName = Schema.String.pipe(
  Schema.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(schemaLimits.candidateServerNameMaxLength),
    Schema.isTrimmed(),
  ),
);

export const claimedCheckResults = ["passed", "failed", "skipped"] as const;
export const ClaimedCheckResult = Schema.Literals(claimedCheckResults);
export type ClaimedCheckResult = typeof ClaimedCheckResult.Type;

export const ClaimedLocalCheck = Schema.Struct({
  command: Command,
  result: ClaimedCheckResult,
  details: Schema.optionalKey(Summary),
});
export type ClaimedLocalCheck = typeof ClaimedLocalCheck.Type;

export const DevelopmentServer = Schema.Struct({
  name: ServerName,
  port: Port,
  url: Schema.optionalKey(DevelopmentServerUrl),
});
export type DevelopmentServer = typeof DevelopmentServer.Type;

export const Candidate = Schema.Struct({
  commitSha: GitSha,
  specRevision: SpecRevision,
  summary: Summary,
  claimedLocalChecks: Schema.Array(ClaimedLocalCheck),
  activeDevelopmentServers: Schema.Array(DevelopmentServer),
  knownLimitations: Schema.Array(Summary),
  disposition: AgentDisposition,
});
export type Candidate = typeof Candidate.Type;

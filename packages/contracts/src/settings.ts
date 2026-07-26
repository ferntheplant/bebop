export const schemaLimits = {
  acceptanceCriteriaMinItems: 1,
  bountyIdMaxLength: 63,
  candidateCommandMaxLength: 1_000,
  candidateServerNameMaxLength: 100,
  candidateSummaryMaxLength: 4_000,
  evidenceArtifactPathMaxLength: 1_024,
  evidenceBundleMaxBytes: 500_000_000,
  evidenceBundleMinArtifacts: 1,
  evidenceMediaTypeMaxLength: 255,
  evidenceToolNameMaxLength: 100,
  evidenceVersionMaxLength: 200,
  opaqueIdentifierMaxLength: 128,
  protocolComponentVersionMaxLength: 200,
  protocolMessageMaxLength: 4_000,
  reviewBodyMaxLength: 8_000,
  reviewFilePathMaxLength: 1_024,
  reviewTitleMaxLength: 200,
  specDescriptionMaxLength: 4_000,
  specTitleMaxLength: 200,
} as const;

export const defaultConstraintValues = {
  primary: {
    maxTurnsPerAttempt: 40,
    maxWallClockMinutesPerAttempt: 90,
  },
  review: {
    maxRounds: 3,
    maxTurnsPerAttempt: 15,
    maxWallClockMinutesPerAttempt: 30,
  },
  qa: {
    maxRounds: 3,
    maxTurnsPerAttempt: 20,
    maxWallClockMinutesPerAttempt: 45,
  },
} as const;

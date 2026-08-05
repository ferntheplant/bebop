export const schemaLimits = {
  acceptanceCriteriaMinItems: 1,
  attachmentHostMaxLength: 253,
  attachmentLabelMaxLength: 100,
  apiTokenNameMaxLength: 100,
  apiTokenSecretMaxLength: 200,
  attachmentUserMaxLength: 64,
  bountyIdMaxLength: 63,
  bountyListCursorMaxLength: 256,
  candidateCommandMaxLength: 1_000,
  candidateServerNameMaxLength: 100,
  candidateSummaryMaxLength: 4_000,
  ciCheckNameMaxLength: 200,
  environmentProfileMaxLength: 100,
  evidenceArtifactPathMaxLength: 1_024,
  evidenceBundleMaxBytes: 500_000_000,
  evidenceBundleMinArtifacts: 1,
  evidenceMediaTypeMaxLength: 255,
  evidenceToolNameMaxLength: 100,
  evidenceVersionMaxLength: 200,
  feedbackCapturedOutputMaxLength: 20_000,
  feedbackCommandMaxLength: 1_000,
  httpsUrlMaxLength: 4_096,
  opaqueIdentifierMaxLength: 128,
  protocolComponentVersionMaxLength: 200,
  protocolMessageMaxLength: 4_000,
  qaScenarioTextMaxLength: 4_000,
  reviewBodyMaxLength: 8_000,
  reviewFilePathMaxLength: 1_024,
  reviewTitleMaxLength: 200,
  specDescriptionMaxLength: 4_000,
  specTitleMaxLength: 200,
  sfControlMessageMaxLength: 4_000,
  sfRecentEventsMaxItems: 50,
  sfUnifiedDiffMaxLength: 100_000,
} as const;

/**
 * The defaults a repository's profile is filled in from.
 *
 * These are recommendations to be reviewed against evidence — turn and time distributions, successful attempt
 * ordinals, validated candidates per spec — after at least 20 terminal bounties, not tuned automatically.
 */
export const defaultConstraintValues = {
  validatedCandidatesPerSpec: 3,
  building: {
    attemptsPerCycle: 3,
    turnsPerAttempt: 40,
    wallClockMinutesPerAttempt: 90,
  },
  review: {
    attemptsPerCandidate: 2,
    turnsPerAttempt: 15,
    wallClockMinutesPerAttempt: 30,
  },
  qa: {
    attemptsPerCandidate: 2,
    turnsPerAttempt: 20,
    wallClockMinutesPerAttempt: 45,
  },
} as const;

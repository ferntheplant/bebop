// What `bebop-worker` actually does.
//
// Two responsibilities in this milestone, and they are here rather than in the API for the
// same reason: both are things that must keep happening whether or not anyone is holding a
// request open.
//
// - **Lifecycle jobs.** The API writes durable intent; the worker performs the externally
//   visible operation and records the result. A crash between the two is recoverable because
//   the intent outlives the process.
// - **The freshness sweep.** A Swordfish that stops sending heartbeats announces nothing.
//   Something has to notice, and it cannot be the socket that died. SPEC section 9.3: "a
//   disconnected Swordfish cannot be presented as currently working merely because its last
//   event said `implementing`."

import type { Timestamp } from "@bebop/contracts";
import { Duration, Effect } from "effect";
import { Redacted } from "effect";

import { BebopConfiguration } from "#src/config.ts";
import { Identity, timestampFrom, timestampToIso } from "#src/domain/identity.ts";
import { LifecycleProvider } from "#src/lifecycle/provider.ts";
import { BountyRepository } from "#src/persistence/bounties.ts";
import type { LifecycleJob } from "#src/persistence/jobs.ts";
import { LifecycleJobRepository } from "#src/persistence/jobs.ts";
import { SwordfishProjectionRepository } from "#src/persistence/swordfish.ts";
import { requireBounty, transitionLifecycle } from "#src/service/bounties.ts";
import { applyProjectionInput } from "#src/service/projection.ts";
import { hashSwordfishToken, mintSwordfishToken } from "#src/swordfish-gateway/credentials.ts";

/** A failure, rendered for the `last_error` column without becoming `[object Object]`. */
function describeFailure(failure: unknown): string {
  if (failure instanceof Error) {
    return failure.message;
  }
  if (typeof failure === "object" && failure !== null && "_tag" in failure) {
    return JSON.stringify(failure);
  }
  return String(failure);
}

/** How long a failed job waits before another attempt. */
const retryAfter = Duration.seconds(5);

/** How many projections one sweep examines. Bounded so a sweep cannot monopolise a pool. */
const sweepBatchSize = 200;

/**
 * Creates the bounty's computer and binds its Swordfish credential.
 *
 * The credential is minted here, not at bounty creation, because SPEC section 18.2 injects it
 * at VM bootstrap: a bounty with no computer has nothing to authenticate. Only its hash is
 * stored, and the plaintext is handed to the provider — which is the component that puts it
 * on the VM.
 */
const runProvision = Effect.fnUntraced(function* (job: LifecycleJob) {
  const identity = yield* Identity;
  const bounties = yield* BountyRepository;
  const provider = yield* LifecycleProvider;

  const bounty = yield* requireBounty(job.bountyId);
  const swordfishToken = mintSwordfishToken();
  const provisioned = yield* provider.provision({
    bountyId: bounty.bountyId,
    computeProfile: bounty.computeProfile,
    swordfishToken,
  });
  const at = yield* identity.now;

  yield* bounties.upsertVm({
    bountyId: bounty.bountyId,
    vmId: provisioned.vmId,
    ssh: provisioned.ssh,
    previews: provisioned.previews,
    at,
  });
  yield* bounties.setSwordfishTokenHash({
    bountyId: bounty.bountyId,
    tokenHash: hashSwordfishToken(Redacted.value(swordfishToken)),
    at,
  });
  // `active` rather than a status of its own: the bounty stays `provisioning` to a client
  // until its Swordfish registers, because SPEC section 10.1 does not consider creation
  // finished before that.
  yield* transitionLifecycle({ bounty, to: "active", at });
  yield* Effect.logInfo("provisioned bounty vm").pipe(
    Effect.annotateLogs("bounty_id", bounty.bountyId),
    Effect.annotateLogs("vm_id", provisioned.vmId),
  );
});

const runDestroy = Effect.fnUntraced(function* (job: LifecycleJob) {
  const identity = yield* Identity;
  const bounties = yield* BountyRepository;
  const provider = yield* LifecycleProvider;

  const bounty = yield* requireBounty(job.bountyId);
  const attachment = yield* bounties.attachment(bounty.bountyId);
  const at = yield* identity.now;

  if (attachment !== null && attachment.destroyedAt === undefined) {
    yield* provider.destroy({ bountyId: bounty.bountyId, vmId: attachment.vmId });
    yield* bounties.markVmDestroyed({ bountyId: bounty.bountyId, at });
  }
  yield* transitionLifecycle({ bounty, to: "destroyed", at });
  yield* Effect.logInfo("destroyed bounty vm").pipe(Effect.annotateLogs("bounty_id", bounty.bountyId));
});

/**
 * Claims and runs at most one job.
 *
 * Returns whether it found work, so the loop can drain a backlog quickly and then go quiet
 * rather than sleeping between every job.
 */
export const runOneJob = Effect.fnUntraced(function* (workerId: string) {
  const identity = yield* Identity;
  const jobs = yield* LifecycleJobRepository;

  const at = yield* identity.now;
  const job = yield* jobs.claim({ workerId, at });
  if (job === null) {
    return false;
  }

  const outcome = yield* Effect.result(job.kind === "provision" ? runProvision(job) : runDestroy(job));
  const finishedAt = yield* identity.now;

  if (outcome._tag === "Success") {
    yield* jobs.complete({ jobId: job.jobId, at: finishedAt });
    return true;
  }

  const status = yield* jobs.fail({
    jobId: job.jobId,
    at: finishedAt,
    error: describeFailure(outcome.failure),
    retryAfter,
  });
  yield* Effect.logError("lifecycle job failed").pipe(
    Effect.annotateLogs("job_id", job.jobId),
    Effect.annotateLogs("bounty_id", job.bountyId),
    Effect.annotateLogs("kind", job.kind),
    Effect.annotateLogs("attempts", String(job.attempts)),
    Effect.annotateLogs("job_status", status),
  );

  // A job that has exhausted its attempts is not a transient hiccup; the bounty it belongs to
  // should say so rather than sitting in `provisioning` indefinitely.
  if (status === "failed") {
    const bounty = yield* requireBounty(job.bountyId).pipe(Effect.result);
    if (bounty._tag === "Success") {
      yield* transitionLifecycle({
        bounty: bounty.success,
        to: "failed",
        detail: `The ${job.kind} operation could not be completed.`,
        at: finishedAt,
      });
    }
  }
  return true;
});

/** Marks every connection whose last traffic is older than the stale threshold. */
export const sweepStaleConnections = Effect.fnUntraced(function* () {
  const config = yield* BebopConfiguration;
  const identity = yield* Identity;
  const projections = yield* SwordfishProjectionRepository;

  const now = yield* identity.now;
  const before: Timestamp = timestampFrom(
    new Date(Date.parse(timestampToIso(now)) - Duration.toMillis(config.swordfishStaleAfter)),
  );

  const candidates = yield* projections.staleCandidates({ before, limit: sweepBatchSize });
  let marked = 0;
  for (const projection of candidates) {
    if (projection.connectionId === null) {
      continue;
    }
    // Expressed as a reducer input rather than an UPDATE so the sweep obeys the same
    // connection-scoping rule as the gateway: a projection that has since been claimed by a
    // newer connection is left alone.
    const applied = yield* applyProjectionInput({
      projection,
      input: { type: "freshness_expired", connectionId: projection.connectionId, detectedAt: now },
      at: now,
    });
    if (applied.result.ok && applied.result.applied) {
      marked += 1;
    }
  }
  if (marked > 0) {
    yield* Effect.logInfo("marked swordfish connections stale").pipe(
      Effect.annotateLogs("connections", String(marked)),
    );
  }
  return marked;
});

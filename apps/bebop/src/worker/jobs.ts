// What `bebop-worker` actually does.
//
// Two responsibilities today, and they are here rather than in the API for the same reason: both are things that must keep happening whether or not anyone is holding a
// request open.
//
// - **Lifecycle jobs.** The API writes durable intent; the worker performs the externally
//   visible operation and records the result. A crash between the two is recoverable because
//   the intent outlives the process.
// - **The freshness sweep.** A Swordfish that stops sending heartbeats announces nothing.
//   Something has to notice, and it cannot be the socket that died. "Bebop owns authority, Swordfish owns the loop" (ADR 0002): "a
//   disconnected Swordfish cannot be presented as currently working merely because its last
//   event said `implementing`."

import type { Timestamp } from "@bebop/contracts";
import { Duration, Effect } from "effect";
import { Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";

import { BebopConfiguration } from "#src/config.ts";
import { Identity, timestampFrom, timestampToIso } from "#src/domain/identity.ts";
import { LifecycleProvider } from "#src/lifecycle/provider.ts";
import { BountyRepository } from "#src/persistence/bounties.ts";
import type { LifecycleJob } from "#src/persistence/jobs.ts";
import { LifecycleJobRepository } from "#src/persistence/jobs.ts";
import { SwordfishProjectionRepository } from "#src/persistence/swordfish.ts";
import { requireBounty, transitionLifecycle } from "#src/service/bounties.ts";
import { applyProjectionInput } from "#src/service/projection.ts";
import {
  hashSwordfishToken,
  operatorCredentialForBounty,
  operatorCredentialVerifier,
  swordfishTokenForBounty,
} from "#src/swordfish-gateway/credentials.ts";

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

/** How many projections one sweep examines. Bounded so a sweep cannot monopolise a pool. */
const sweepBatchSize = 200;

/**
 * Creates the bounty's computer and binds its Swordfish credential.
 *
 * The credential is minted here, not at bounty creation, because "Swordfish tokens are bounty-scoped" (ADR 0014) injects it
 * at VM bootstrap: a bounty with no computer has nothing to authenticate. Only its hash is
 * stored, and the plaintext is handed to the provider — which is the component that puts it
 * on the VM.
 */
class JobLeaseLostError extends Error {
  readonly _tag = "JobLeaseLostError";

  constructor(readonly jobId: string) {
    super(`Lifecycle job ${jobId} no longer owns its lease.`);
    this.name = "JobLeaseLostError";
  }
}

const runProvision = Effect.fnUntraced(function* (job: LifecycleJob, workerId: string) {
  const identity = yield* Identity;
  const config = yield* BebopConfiguration;
  const bounties = yield* BountyRepository;
  const provider = yield* LifecycleProvider;
  const jobs = yield* LifecycleJobRepository;
  const sql = yield* SqlClient.SqlClient;

  const bounty = yield* requireBounty(job.bountyId);
  const swordfishToken = swordfishTokenForBounty(config.swordfishCredentialKey, bounty.bountyId);
  // Both credentials are derived here and injected by the provider, never stored in plaintext:
  // the machine one Swordfish authenticates with, and the verifier for the operator credential
  // a human presents to mutate locally (ADR 0014, ADR 0038).
  const provisioned = yield* provider.provision({
    bountyId: bounty.bountyId,
    computeProfile: bounty.computeProfile,
    swordfishToken,
    operatorCredentialVerifier: operatorCredentialVerifier(
      operatorCredentialForBounty(config.swordfishCredentialKey, bounty.bountyId),
    ),
  });
  const at = yield* identity.now;
  if (!(yield* jobs.renew({ jobId: job.jobId, workerId, attempt: job.attempts, at }))) {
    return yield* Effect.fail(new JobLeaseLostError(job.jobId));
  }

  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`SELECT pg_advisory_xact_lock(hashtext(${bounty.bountyId})::bigint)`;
      const current = yield* requireBounty(bounty.bountyId);
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
      if (current.lifecycleState === "provisioning") {
        // `active` rather than a status of its own: the bounty stays `provisioning` to a
        // client until its Swordfish registers, because provisioning is not finished before
        // that (`docs/capabilities/02-provisioning-and-attachment.md`).
        yield* transitionLifecycle({ bountyId: bounty.bountyId, to: "active", at });
      }
    }),
  );
  yield* Effect.logInfo("provisioned bounty vm").pipe(
    Effect.annotateLogs("bounty_id", bounty.bountyId),
    Effect.annotateLogs("vm_id", provisioned.vmId),
  );
});

const runDestroy = Effect.fnUntraced(function* (job: LifecycleJob, workerId: string) {
  const identity = yield* Identity;
  const bounties = yield* BountyRepository;
  const provider = yield* LifecycleProvider;
  const jobs = yield* LifecycleJobRepository;
  const sql = yield* SqlClient.SqlClient;

  const bounty = yield* requireBounty(job.bountyId);
  const attachment = yield* bounties.attachment(bounty.bountyId);

  if (attachment !== null && attachment.destroyedAt === undefined) {
    yield* provider.destroy({ bountyId: bounty.bountyId, vmId: attachment.vmId });
  }
  const at = yield* identity.now;
  if (!(yield* jobs.renew({ jobId: job.jobId, workerId, attempt: job.attempts, at }))) {
    return yield* Effect.fail(new JobLeaseLostError(job.jobId));
  }
  yield* sql.withTransaction(
    Effect.gen(function* () {
      if (attachment !== null && attachment.destroyedAt === undefined) {
        yield* bounties.markVmDestroyed({ bountyId: bounty.bountyId, at });
      }
      yield* bounties.revokeSwordfishToken({ bountyId: bounty.bountyId, at });
      yield* transitionLifecycle({ bountyId: bounty.bountyId, to: "destroyed", at });
    }),
  );
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
  const config = yield* BebopConfiguration;

  const at = yield* identity.now;
  const reclaimBefore = timestampFrom(
    new Date(Date.parse(timestampToIso(at)) - Duration.toMillis(config.jobLeaseDuration)),
  );
  const job = yield* jobs.claim({ workerId, at, reclaimBefore });
  if (job === null) {
    return false;
  }

  const renewLease = Effect.gen(function* () {
    const renewalInterval = Duration.millis(Math.max(1, Math.floor(Duration.toMillis(config.jobLeaseDuration) / 3)));
    yield* Effect.sleep(renewalInterval);
    for (;;) {
      const renewedAt = yield* identity.now;
      const renewed = yield* jobs
        .renew({ jobId: job.jobId, workerId, attempt: job.attempts, at: renewedAt })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logError("lifecycle job lease renewal failed", cause).pipe(Effect.as(true)),
          ),
        );
      if (!renewed) {
        return;
      }
      yield* Effect.sleep(renewalInterval);
    }
  });
  const outcome = yield* Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.forkScoped(renewLease);
      return yield* Effect.result(job.kind === "provision" ? runProvision(job, workerId) : runDestroy(job, workerId));
    }),
  );
  const finishedAt = yield* identity.now;

  if (outcome._tag === "Success") {
    const completed = yield* jobs.complete({
      jobId: job.jobId,
      workerId,
      attempt: job.attempts,
      at: finishedAt,
    });
    if (!completed) {
      yield* Effect.logWarning("lifecycle job completion ignored after lease loss").pipe(
        Effect.annotateLogs("job_id", job.jobId),
      );
    }
    return true;
  }

  const sql = yield* SqlClient.SqlClient;
  const status = yield* sql.withTransaction(
    Effect.gen(function* () {
      const failed = yield* jobs.fail({
        jobId: job.jobId,
        workerId,
        attempt: job.attempts,
        at: finishedAt,
        error: describeFailure(outcome.failure),
        retryAfter: config.jobRetryDelay,
      });
      if (failed === "failed") {
        yield* transitionLifecycle({
          bountyId: job.bountyId,
          to: "failed",
          detail: `The ${job.kind} operation could not be completed.`,
          at: finishedAt,
        });
      }
      return failed;
    }),
  );
  yield* Effect.logError("lifecycle job failed").pipe(
    Effect.annotateLogs("job_id", job.jobId),
    Effect.annotateLogs("bounty_id", job.bountyId),
    Effect.annotateLogs("kind", job.kind),
    Effect.annotateLogs("attempts", String(job.attempts)),
    Effect.annotateLogs("job_status", status ?? "lease_lost"),
  );

  if (status === null) {
    return true;
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
      bountyId: projection.bountyId,
      vmId: projection.vmId,
      input: {
        type: "freshness_expired",
        connectionId: projection.connectionId,
        staleBefore: before,
        detectedAt: now,
      },
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

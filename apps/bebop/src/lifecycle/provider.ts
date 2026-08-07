// The bounty compute lifecycle, behind a service.
//
// exe.dev and GitHub are deliberately not integrated yet: the fake lifecycle provider creates
// deterministic local VM records and lets the control-plane behaviour stabilise first. This
// module is that seam — the exe.dev client implements the same interface
// (`docs/capabilities/02-provisioning-and-attachment.md`), and everything upstream of it is
// already exercised by the time it lands.
//
// The interface is deliberately narrow and app-local rather than a multi-provider
// abstraction (see `AGENTS.md`, architectural rules): create, describe, destroy.

import type {
  BountyId,
  ComputeProfile,
  GitRef,
  Port,
  PrivatePreviewAttachment,
  RepositorySlug,
  SshAttachment,
  VmId,
} from "@bebop/contracts";
import {
  HttpsUrl,
  Port as PortSchema,
  SshAttachment as SshAttachmentSchema,
  VmId as VmIdSchema,
} from "@bebop/contracts";
import type { Redacted } from "effect";
import { Context, Effect, Layer, Redacted as RedactedModule, Schema } from "effect";

import type { LocalSwordfishSupervisor } from "#src/lifecycle/local-daemon.ts";

export interface ProvisionedVm {
  readonly vmId: VmId;
  readonly ssh: SshAttachment;
  readonly previews: ReadonlyArray<PrivatePreviewAttachment>;
}

class LifecycleError extends Error {
  readonly _tag = "LifecycleError";

  constructor(
    readonly operation: "provision" | "destroy",
    readonly bountyId: BountyId,
    reason: string,
    options?: ErrorOptions,
  ) {
    super(`Lifecycle ${operation} failed for ${bountyId}: ${reason}.`, options);
    this.name = "LifecycleError";
  }
}

interface LifecycleProviderService {
  /**
   * Creates the bounty's VM, or returns the existing one.
   *
   * Provisioning is retried by the worker after a crash, so this must be idempotent per
   * bounty: `ABSTRACT.md` §8 criterion 42 requires that restarting Bebop does not duplicate
   * VMs.
   */
  readonly provision: (options: {
    readonly bountyId: BountyId;
    readonly computeProfile: ComputeProfile;
    /**
     * The repository and branch the machine works on.
     *
     * Bebop is authoritative for both ("Bebop owns authority, Swordfish owns the loop" (ADR
     * 0002)), and the provider is what puts them on the machine: exe.dev's has the VM bootstrap
     * clone the repository, and the local one clones it into the bounty's working copy.
     */
    readonly repository: RepositorySlug;
    readonly assignedBranch: GitRef;
    /**
     * The bounty-scoped Swordfish credential, to be injected at VM bootstrap
     * ("Swordfish tokens are bounty-scoped" (ADR 0014)). The provider is the only component that puts it on the VM;
     * Bebop keeps nothing but its hash.
     */
    readonly swordfishToken: Redacted.Redacted<string>;
    /**
     * The verifier for this bounty's operator credential, injected at bootstrap beside the
     * machine credential ("Workflow actions have role-aware adapters" (ADR 0038)).
     *
     * It travels the same path for the same reason: the provider is the component that puts
     * things on the VM. It is a digest rather than a secret, so unlike `swordfishToken` it is
     * not redacted — a leaked verifier grants nothing.
     */
    readonly operatorCredentialVerifier: string;
  }) => Effect.Effect<ProvisionedVm, LifecycleError>;

  /** Destroys the VM. Destroying an already-destroyed or unknown VM succeeds. */
  readonly destroy: (options: {
    readonly bountyId: BountyId;
    readonly vmId: VmId;
  }) => Effect.Effect<void, LifecycleError>;
}

export class LifecycleProvider extends Context.Service<LifecycleProvider, LifecycleProviderService>()(
  "LifecycleProvider",
) {}

const decodeVmId = Schema.decodeUnknownSync(VmIdSchema);
const decodeSsh = Schema.decodeUnknownSync(SshAttachmentSchema);
const decodePort = Schema.decodeUnknownSync(PortSchema);
const decodeHttpsUrl = Schema.decodeUnknownSync(HttpsUrl);

/**
 * The deterministic local provider.
 *
 * It creates no computer. What it does create is the record shape everything downstream
 * depends on — a VM identity bound to the bounty, SSH attachment metadata, and a private
 * preview URL — so the control plane can be exercised, restarted, and asserted on without
 * a credential or a network.
 *
 * The identifiers are derived from the bounty ID rather than generated, which is what makes
 * a repeated provision return the same VM instead of a second one.
 */
export function fakeLifecycleProviderLayer(options?: {
  readonly sshHost?: string;
  readonly sshPort?: number;
  readonly previewHost?: string;
  /**
   * Receives the credential the real provider would inject at bootstrap.
   *
   * A test needs it to open a gateway connection, and there is no other honest way to get
   * it — Bebop stores only its hash, exactly as it should.
   */
  readonly onProvision?: (provisioned: ProvisionedVm & { readonly swordfishToken: string }) => void;
  readonly onProvisionAttempt?: () => void;
  readonly failProvisionAttempts?: number;
  readonly failProvisionAfterEffectAttempts?: number;
  readonly failDestroyAttempts?: number;
  /**
   * When set, a provisioned bounty is a running Swordfish daemon on this machine rather than
   * only a VM record: `provision` starts one and `destroy` stops it. This is what makes the
   * local loop runnable by hand ("A local Swordfish outlives the worker that started it" (ADR
   * 0048)); without it the provider fabricates records and nothing else, which is what the
   * component suites want.
   */
  readonly supervisor?: typeof LocalSwordfishSupervisor.Service;
}): Layer.Layer<LifecycleProvider> {
  const sshHost = options?.sshHost ?? "127.0.0.1";
  const sshPort = options?.sshPort ?? 2222;
  const previewHost = options?.previewHost ?? "preview.bebop.invalid";
  const destroyed = new Set<string>();
  let failProvisionAttempts = options?.failProvisionAttempts ?? 0;
  let failProvisionAfterEffectAttempts = options?.failProvisionAfterEffectAttempts ?? 0;
  let failDestroyAttempts = options?.failDestroyAttempts ?? 0;

  return Layer.sync(LifecycleProvider)(() => ({
    provision: ({ bountyId, repository, assignedBranch, swordfishToken, operatorCredentialVerifier }) =>
      Effect.gen(function* () {
        options?.onProvisionAttempt?.();
        if (failProvisionAttempts > 0) {
          failProvisionAttempts -= 1;
          return yield* Effect.fail(new LifecycleError("provision", bountyId, "injected failure before side effect"));
        }
        destroyed.delete(bountyId);
        const previewPort: Port = decodePort(3_000);
        const provisioned: ProvisionedVm = {
          vmId: decodeVmId(`vm-${bountyId}`),
          ssh: decodeSsh({ host: sshHost, port: sshPort, user: "bebop" }),
          previews: [
            {
              label: "app",
              url: decodeHttpsUrl(`https://${bountyId}.${previewHost}/`),
              port: previewPort,
            },
          ],
        };
        options?.onProvision?.({ ...provisioned, swordfishToken: RedactedModule.value(swordfishToken) });
        const supervisor = options?.supervisor;
        if (supervisor !== undefined) {
          // The credential goes from here straight into the daemon's environment. It is never
          // written down, which is what a VM bootstrap does with it too (ADR 0014).
          yield* supervisor
            .ensureRunning({
              bountyId,
              vmId: provisioned.vmId,
              repository,
              assignedBranch,
              swordfishToken: RedactedModule.value(swordfishToken),
              operatorCredentialVerifier,
            })
            .pipe(
              Effect.mapError(
                (error) => new LifecycleError("provision", bountyId, error.reason, { cause: error.cause }),
              ),
            );
        }
        if (failProvisionAfterEffectAttempts > 0) {
          failProvisionAfterEffectAttempts -= 1;
          return yield* Effect.fail(new LifecycleError("provision", bountyId, "injected failure after side effect"));
        }
        return provisioned;
      }),
    destroy: ({ bountyId }) =>
      Effect.gen(function* () {
        if (failDestroyAttempts > 0) {
          failDestroyAttempts -= 1;
          return yield* Effect.fail(new LifecycleError("destroy", bountyId, "injected failure"));
        }
        const supervisor = options?.supervisor;
        if (supervisor !== undefined) {
          // Destroying is the only thing that stops a local daemon, because nothing else does:
          // it outlives the worker on purpose, so an undestroyed bounty keeps running.
          yield* supervisor
            .stop(bountyId)
            .pipe(
              Effect.mapError((error) => new LifecycleError("destroy", bountyId, error.reason, { cause: error.cause })),
            );
        }
        destroyed.add(bountyId);
      }),
  }));
}

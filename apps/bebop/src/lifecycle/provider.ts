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

import type { BountyId, ComputeProfile, Port, PrivatePreviewAttachment, SshAttachment, VmId } from "@bebop/contracts";
import {
  HttpsUrl,
  Port as PortSchema,
  SshAttachment as SshAttachmentSchema,
  VmId as VmIdSchema,
} from "@bebop/contracts";
import type { Redacted } from "effect";
import { Context, Effect, Layer, Redacted as RedactedModule, Schema } from "effect";

export interface ProvisionedVm {
  readonly vmId: VmId;
  readonly ssh: SshAttachment;
  readonly previews: ReadonlyArray<PrivatePreviewAttachment>;
}

export class LifecycleError extends Error {
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

export interface LifecycleProviderService {
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
     * The bounty-scoped Swordfish credential, to be injected at VM bootstrap
     * ("Swordfish tokens are bounty-scoped" (ADR 0014)). The provider is the only component that puts it on the VM;
     * Bebop keeps nothing but its hash.
     */
    readonly swordfishToken: Redacted.Redacted<string>;
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
}): Layer.Layer<LifecycleProvider> {
  const sshHost = options?.sshHost ?? "127.0.0.1";
  const sshPort = options?.sshPort ?? 2222;
  const previewHost = options?.previewHost ?? "preview.bebop.invalid";
  const destroyed = new Set<string>();
  let failProvisionAttempts = options?.failProvisionAttempts ?? 0;
  let failProvisionAfterEffectAttempts = options?.failProvisionAfterEffectAttempts ?? 0;
  let failDestroyAttempts = options?.failDestroyAttempts ?? 0;

  return Layer.sync(LifecycleProvider)(() => ({
    provision: ({ bountyId, swordfishToken }) =>
      Effect.suspend(() => {
        options?.onProvisionAttempt?.();
        if (failProvisionAttempts > 0) {
          failProvisionAttempts -= 1;
          return Effect.fail(new LifecycleError("provision", bountyId, "injected failure before side effect"));
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
        if (failProvisionAfterEffectAttempts > 0) {
          failProvisionAfterEffectAttempts -= 1;
          return Effect.fail(new LifecycleError("provision", bountyId, "injected failure after side effect"));
        }
        return Effect.succeed(provisioned);
      }),
    destroy: ({ bountyId }) =>
      Effect.suspend(() => {
        if (failDestroyAttempts > 0) {
          failDestroyAttempts -= 1;
          return Effect.fail(new LifecycleError("destroy", bountyId, "injected failure"));
        }
        return Effect.sync(() => void destroyed.add(bountyId));
      }),
  }));
}

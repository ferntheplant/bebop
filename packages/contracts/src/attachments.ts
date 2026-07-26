import { Schema } from "effect";

import { HttpsUrl, Port, Timestamp } from "./scalars.ts";
import { schemaLimits } from "./settings.ts";

const AttachmentLabel = Schema.String.pipe(
  Schema.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(schemaLimits.attachmentLabelMaxLength),
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  ),
);
const AttachmentHost = Schema.String.pipe(
  Schema.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(schemaLimits.attachmentHostMaxLength),
    Schema.isPattern(/^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|[0-9A-Fa-f:]+)$/),
  ),
);
const AttachmentUser = Schema.String.pipe(
  Schema.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(schemaLimits.attachmentUserMaxLength),
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  ),
);

export const PrivatePreviewAttachment = Schema.Struct({
  label: AttachmentLabel,
  url: HttpsUrl,
  port: Port,
});
export type PrivatePreviewAttachment = typeof PrivatePreviewAttachment.Type;

export const PrivatePreviewAttachments = Schema.Array(PrivatePreviewAttachment).pipe(
  Schema.check(
    Schema.makeFilter<ReadonlyArray<PrivatePreviewAttachment>>((previews) => {
      const labels = new Set(previews.map((preview) => preview.label));
      if (labels.size !== previews.length) {
        return "Expected unique private preview labels";
      }
      const ports = new Set(previews.map((preview) => preview.port));
      return ports.size === previews.length ? undefined : "Expected unique private preview ports";
    }),
  ),
);

export const SshAttachment = Schema.Struct({
  host: AttachmentHost,
  port: Port,
  user: AttachmentUser,
});
export type SshAttachment = typeof SshAttachment.Type;

export const AttachmentSnapshot = Schema.Struct({
  ssh: Schema.optionalKey(SshAttachment),
  previews: PrivatePreviewAttachments,
  updatedAt: Timestamp,
});
export type AttachmentSnapshot = typeof AttachmentSnapshot.Type;

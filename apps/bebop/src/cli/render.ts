// Human rendering for the CLI.
//
// Every command also supports `--json`, which prints the API's own response. These functions
// are therefore presentation and nothing else: no field is computed here that a machine
// client could not compute from the same response, because that would be CLI-only behaviour
// (SPEC section 4.3).

import type { BountyDetail, BountySummary, Timestamp } from "@bebop/contracts";
import { DateTime } from "effect";

import type { CliEventFrame } from "#src/cli/events.ts";

function instant(timestamp: Timestamp): string {
  return DateTime.formatIso(timestamp);
}

export function printHealth(response: { readonly status: string; readonly checkedAt: Timestamp }): string {
  return `${response.status}  ${instant(response.checkedAt)}`;
}

export function printBountyList(bounties: ReadonlyArray<BountySummary>): string {
  if (bounties.length === 0) {
    return "No bounties.";
  }
  const rows = bounties.map((bounty) => [
    bounty.bountyId,
    bounty.status,
    bounty.swordfishFreshness,
    bounty.swordfishStage ?? "-",
    bounty.repository,
  ]);
  const headers = ["BOUNTY", "STATUS", "CONNECTION", "STAGE", "REPOSITORY"];
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: ReadonlyArray<string>) =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd();
  return [line(headers), ...rows.map((row) => line(row))].join("\n");
}

export function printBounty(bounty: BountyDetail): string {
  const lines = [
    `bounty      ${bounty.bountyId}`,
    `status      ${bounty.status}`,
    `repository  ${bounty.repository}`,
    `base        ${bounty.baseRef}`,
    `branch      ${bounty.assignedBranch}`,
    `connection  ${bounty.swordfishFreshness}`,
    `stage       ${bounty.swordfishStage ?? "-"}`,
    `candidate   ${bounty.candidateSha ?? "-"}`,
    `spec        ${bounty.specRevision === undefined ? "-" : `revision ${bounty.specRevision}`}`,
    `updated     ${instant(bounty.updatedAt)}`,
  ];
  if (bounty.attentionReason !== undefined) {
    lines.push(`attention   ${bounty.attentionReason}`);
  }
  if (bounty.readinessClaimSha !== undefined) {
    // Named a claim, not a state, because SPEC section 9.4 makes readiness something Bebop
    // verifies independently before merge is offered.
    lines.push(`ready claim ${bounty.readinessClaimSha}`);
  }
  const attachment = bounty.attachment;
  if (attachment !== undefined) {
    if (attachment.ssh !== undefined) {
      lines.push(`ssh         ${attachment.ssh.user}@${attachment.ssh.host} -p ${attachment.ssh.port}`);
    }
    for (const preview of attachment.previews) {
      lines.push(`preview     ${preview.label}  ${preview.url}`);
    }
  }
  return lines.join("\n");
}

export function printEventFrame(frame: CliEventFrame): string {
  const event = frame.event;
  const description =
    event.type === "bounty_status_changed"
      ? `status ${event.status}`
      : event.type === "swordfish_freshness_changed"
        ? `connection ${event.freshness}`
        : `swordfish ${event.event.type}`;
  return `${String(frame.cursor).padStart(6)}  ${instant(frame.occurredAt)}  ${description}`;
}

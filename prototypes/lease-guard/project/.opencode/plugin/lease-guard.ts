// Spike: does the OpenCode plugin API let a supervisor authoritatively reject
// prompt submission to a leased seat? "The control lease is enforced in four independent layers" (ADR 0009) assumes yes.
//
// `chat.message` is typed `=> Promise<void>` — there is no `output.status` deny
// channel like `permission.ask` has. So the only available mechanism is throwing,
// and the question is whether OpenCode treats a throw as an abort or swallows it.

import type { Plugin } from "@opencode-ai/plugin";

const stateDirectory = `${import.meta.dir}/../../.prototype`;
const leaseFile = `${stateDirectory}/lease.json`;
const auditFile = `${stateDirectory}/audit.jsonl`;

async function readLeaseOwner(): Promise<string> {
  try {
    const lease = (await Bun.file(leaseFile).json()) as { owner?: string };
    return lease.owner ?? "human";
  } catch {
    return "human";
  }
}

// Bun.write truncates; append manually so the driver sees every hook invocation.
async function appendAudit(entry: Record<string, unknown>): Promise<void> {
  const line = `${JSON.stringify({ at: Date.now(), ...entry })}\n`;
  const existing = await Bun.file(auditFile)
    .text()
    .catch(() => "");
  await Bun.write(auditFile, existing + line, { createPath: true });
}

export const LeaseGuard: Plugin = async () => {
  await appendAudit({ hook: "plugin.loaded" });

  return {
    "chat.message": async (input) => {
      const owner = await readLeaseOwner();
      await appendAudit({ hook: "chat.message", sessionID: input.sessionID, owner });
      if (owner === "swordfish") {
        throw new Error("BEBOP_LEASE_DENIED: seat is leased to swordfish; run `sf takeover` first");
      }
    },

    "tool.execute.before": async (input) => {
      const owner = await readLeaseOwner();
      await appendAudit({ hook: "tool.execute.before", tool: input.tool, sessionID: input.sessionID, owner });
      if (owner === "swordfish") {
        throw new Error("BEBOP_LEASE_DENIED: tool execution blocked on a leased seat");
      }
    },

    "command.execute.before": async (input) => {
      const owner = await readLeaseOwner();
      await appendAudit({ hook: "command.execute.before", command: input.command, sessionID: input.sessionID, owner });
      if (owner === "swordfish") {
        throw new Error("BEBOP_LEASE_DENIED: command blocked on a leased seat");
      }
    },

    "permission.ask": async (_input, output) => {
      const owner = await readLeaseOwner();
      await appendAudit({ hook: "permission.ask", owner });
      if (owner === "swordfish") {
        output.status = "deny";
      }
    },

    event: async ({ event }) => {
      if (event.type.startsWith("session.") || event.type.startsWith("message.")) {
        await appendAudit({ hook: "event", event: event.type });
      }
    },
  };
};

// The coupling tripwire for the payloads shared by the two protocols.
//
// Each protocol's golden fixtures round-trip only its own messages, so neither of them
// notices when a shared payload changes shape for the other. This test pins the shared
// shapes next to BOTH version constants, so a change to `commands.ts` fails here and the
// person making it has to decide about both versions rather than only the one they had in
// mind. See the policy note at the top of `src/commands.ts`.

import { Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";

import { sharedCommands } from "#src/commands.ts";
import { currentProtocolVersion } from "#src/scalars.ts";
import { currentSfControlVersion } from "#src/sf-control.ts";

describe("shared command payloads", () => {
  test("both protocol versions are at the value the shared shapes below were written for", () => {
    // If you are here because this failed: a shared payload changed shape. Both of these
    // must move together, and both protocols' fixtures need regenerating.
    expect(currentProtocolVersion).toBe(1);
    expect(currentSfControlVersion).toBe(1);
  });

  test("every shared command encodes to its committed shape", () => {
    const committed = {
      StopCommand: { type: "stop", reason: "operator requested a stop" },
      TakeoverCommand: { type: "takeover", seat: "ein", force: false },
      ExtendConstraintCommand: { type: "extend_constraint", constraint: "primary_turns" },
      RetryStageCommand: { type: "retry_stage", stage: "local_validation" },
    } as const;

    // Names, not just shapes: adding a shared command without adding it here would
    // otherwise pass silently.
    expect(Object.keys(sharedCommands).sort()).toEqual(Object.keys(committed).sort());

    for (const [name, encoded] of Object.entries(committed)) {
      const schema = sharedCommands[name as keyof typeof sharedCommands];
      const decoded = Schema.decodeUnknownSync(schema)(encoded);
      expect(Schema.encodeSync(schema)(decoded)).toEqual(encoded);
    }
  });

  test("an optional field omitted on the wire stays omitted after a round trip", () => {
    const encoded = { type: "stop" } as const;
    const decoded = Schema.decodeUnknownSync(sharedCommands.StopCommand)(encoded);
    expect(Schema.encodeSync(sharedCommands.StopCommand)(decoded)).toEqual(encoded);
  });
});

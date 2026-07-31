// Spike driver: does tmux disable keyboard input to one pane without hiding its output?
//
// `docs/design/SYSTEM.md` §16.2 lists the tmux input lock as the UX layer of steering safety. The
// claim has two halves and they pull against each other -- a pane that cannot be typed
// into is easy to build by hiding it, and that would destroy the thing section 16.1 is
// actually for: watching a seat work.
//
// Two tmux servers run on private sockets:
//
//   seat server  -- holds the pane under test, running seat-program.ts
//   host server  -- holds a pane running `tmux attach` against the seat server
//
// The host server exists so a *real* tmux client is attached over a *real* terminal.
// Keystrokes sent to the host pane arrive at the inner client as terminal input and go
// through its ordinary key handling, which `send-keys` against the seat server does not
// exercise. Testing a client-side input path needs a client, and tmux is the only pty
// allocator this repo can rely on: `script` refuses a non-tty stdin.
//
// Both servers start with `-f /dev/null`, so the developer's tmux configuration cannot
// change the result (see `docs/testing.md` on fixtures).

import { rm } from "node:fs/promises";

import { spawn } from "bun";

const here = import.meta.dir;
const scratch = `${here}/.prototype`;
const seatSocket = `${scratch}/seat.sock`;
const hostSocket = `${scratch}/host.sock`;
const inputLog = `${scratch}/seat-input.log`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A seat tick is 250ms; a second of settling covers scheduling jitter on a loaded machine
// without making the spike slow.
const SETTLE_MS = 1200;

// --- tmux plumbing ------------------------------------------------------------------

const tmux = async (socket: string, ...args: Array<string>): Promise<string> => {
  const child = spawn(["tmux", "-f", "/dev/null", "-S", socket, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`tmux ${args.join(" ")} failed (${code}): ${stderr.trim()}`);
  return stdout.trim();
};

const seat = (...args: Array<string>) => tmux(seatSocket, ...args);
const host = (...args: Array<string>) => tmux(hostSocket, ...args);

// The host session keeps an idle pane 0 alive purely so the host server outlives the
// attach in pane 1. Detaching the inner client ends that pane's command, and a tmux server
// whose last pane exits shuts down -- which would take the test harness with it.
const attachPane = "host:0.1";
const attachCommand = `tmux -f /dev/null -S ${seatSocket} attach -t seat`;

// The free shell pane stands in for `docs/design/SYSTEM.md` §16.1's shell panes. `/bin/sh` is named
// explicitly so the probe does not inherit the developer's login shell or its startup
// files (see `docs/testing.md` on fixtures).
const freeShellPane = "seat:0.1";

const killServer = async (socket: string) => {
  await tmux(socket, "kill-server").catch(() => undefined);
};

/** What the seat program has actually received, as opposed to what the pane looks like. */
const inputReceived = async (): Promise<Array<string>> => {
  const text = await Bun.file(inputLog)
    .text()
    .catch(() => "");
  return text.split("\n").filter((line) => line.length > 0);
};

const inputOff = async (): Promise<boolean> =>
  (await seat("display-message", "-p", "-t", "seat:0.0", "#{pane_input_off}")) === "1";

/** The highest tick number currently visible in a pane, or null if none is. */
const visibleTick = async (socket: string, target: string): Promise<number | null> => {
  const captured = await tmux(socket, "capture-pane", "-p", "-t", target);
  const ticks = captured
    .split("\n")
    .filter((line) => line.startsWith("tick "))
    .map((line) => Number(line.slice(5)));
  return ticks.length === 0 ? null : Math.max(...ticks);
};

/**
 * Sends a marker and reports whether it reached the seat program. `via` decides which
 * input path is exercised.
 */
const deliver = async (marker: string, via: "send-keys" | "real-client" | "paste-buffer"): Promise<boolean> => {
  const before = await inputReceived();
  switch (via) {
    case "send-keys": {
      await seat("send-keys", "-t", "seat:0.0", marker, "Enter");
      break;
    }
    case "real-client": {
      // Typed into the pane that is running `tmux attach`, so the inner client receives
      // it as terminal input.
      await host("send-keys", "-t", attachPane, marker, "Enter");
      break;
    }
    case "paste-buffer": {
      await seat("set-buffer", "-b", "probe", `${marker}\n`);
      await seat("paste-buffer", "-b", "probe", "-t", "seat:0.0");
      break;
    }
  }
  await sleep(SETTLE_MS);
  const after = await inputReceived();
  return after.length > before.length && after.includes(marker);
};

// --- probe harness ------------------------------------------------------------------

interface ProbeResult {
  readonly id: string;
  readonly question: string;
  readonly pass: boolean;
  readonly observed: unknown;
}

const results: Array<ProbeResult> = [];

const probe = async (
  id: string,
  question: string,
  body: () => Promise<{ readonly pass: boolean; readonly observed: unknown }>,
): Promise<void> => {
  let outcome: { pass: boolean; observed: unknown };
  try {
    outcome = await body();
  } catch (error) {
    outcome = { pass: false, observed: { unexpectedFailure: String(error) } };
  }
  results.push({ id, question, ...outcome });
  process.stdout.write(
    `  ${outcome.pass ? "PASS" : "FAIL"}  ${id.padEnd(4)} ${question}\n` +
      `              ${JSON.stringify(outcome.observed)}\n`,
  );
};

// --- driver -----------------------------------------------------------------------

try {
  await killServer(seatSocket);
  await killServer(hostSocket);
  await rm(scratch, { recursive: true, force: true });
  await Bun.write(`${scratch}/.keep`, "");

  await seat("new-session", "-d", "-s", "seat", "-x", "80", "-y", "24", `bun ${here}/seat-program.ts ${inputLog}`);
  await sleep(SETTLE_MS);

  process.stdout.write("tmux input lock\n");

  await probe("T1", "with input enabled, send-keys reaches the seat program", async () => {
    const delivered = await deliver("baseline-enabled", "send-keys");
    return { pass: delivered, observed: { delivered, inputOff: await inputOff() } };
  });

  await probe("T2", "select-pane -d reports the pane as input-disabled", async () => {
    await seat("select-pane", "-d", "-t", "seat:0.0");
    const off = await inputOff();
    return { pass: off, observed: { paneInputOff: off } };
  });

  await probe("T3", "while disabled, send-keys does NOT reach the seat program", async () => {
    const delivered = await deliver("blocked-send-keys", "send-keys");
    return { pass: !delivered, observed: { delivered, received: await inputReceived() } };
  });

  await probe("T4", "while disabled, the pane keeps producing output", async () => {
    const before = await visibleTick(seatSocket, "seat:0.0");
    await sleep(SETTLE_MS);
    const after = await visibleTick(seatSocket, "seat:0.0");
    return {
      pass: before !== null && after !== null && after > before,
      observed: { tickBefore: before, tickAfter: after },
    };
  });

  await probe("T5", "while disabled, paste-buffer does NOT reach the seat program", async () => {
    const delivered = await deliver("blocked-paste", "paste-buffer");
    return { pass: !delivered, observed: { delivered, received: await inputReceived() } };
  });

  await probe("T6", "while disabled, copy-mode still opens for scrollback observation", async () => {
    await seat("copy-mode", "-t", "seat:0.0");
    const inMode = await seat("display-message", "-p", "-t", "seat:0.0", "#{pane_in_mode}");
    await seat("send-keys", "-X", "-t", "seat:0.0", "history-top");
    const scrollback = await seat("capture-pane", "-p", "-S", "-", "-t", "seat:0.0");
    await seat("send-keys", "-X", "-t", "seat:0.0", "cancel");
    const historyLines = scrollback.split("\n").filter((line) => line.startsWith("tick ")).length;
    return {
      pass: inMode === "1" && historyLines > 0,
      observed: { paneInMode: inMode, scrollbackTickLines: historyLines },
    };
  });

  // From here on a real client is attached, so the remaining probes exercise the path an
  // operator actually uses.
  await seat("select-pane", "-e", "-t", "seat:0.0");
  await host("new-session", "-d", "-s", "host", "-x", "100", "-y", "30", "sleep 86400");
  // Without `remain-on-exit`, detaching the inner client ends its command and tmux removes
  // the pane, so there is nothing left to respawn a second client into.
  await host("set-option", "-w", "-t", "host:0", "remain-on-exit", "on");
  await host("split-window", "-d", "-t", "host:0.0", attachCommand);
  await sleep(SETTLE_MS * 2);

  await probe("T7", "a real attached client's keystrokes reach the seat program when enabled", async () => {
    const clients = await seat("list-clients", "-F", "#{client_tty}");
    const delivered = await deliver("typed-enabled", "real-client");
    return {
      pass: clients.length > 0 && delivered,
      observed: { attachedClients: clients.split("\n").filter(Boolean).length, delivered },
    };
  });

  await probe("T8", "while disabled, a real client's keystrokes do NOT reach the seat program", async () => {
    await seat("select-pane", "-d", "-t", "seat:0.0");
    const delivered = await deliver("typed-disabled", "real-client");
    return { pass: !delivered, observed: { delivered, received: await inputReceived() } };
  });

  await probe("T9", "the attached client keeps rendering live output while disabled", async () => {
    const before = await visibleTick(hostSocket, attachPane);
    await sleep(SETTLE_MS);
    const after = await visibleTick(hostSocket, attachPane);
    return {
      // Measured through the host pane, so this is what the operator's terminal shows,
      // not what the seat server knows.
      pass: before !== null && after !== null && after > before,
      observed: { tickSeenByClientBefore: before, tickSeenByClientAfter: after },
    };
  });

  await probe("T10", "the lock survives detach, a fresh attach, and a layout resize", async () => {
    await seat("detach-client", "-s", "seat");
    await sleep(SETTLE_MS);
    const offWhileDetached = await inputOff();

    await host("respawn-pane", "-k", "-t", attachPane, attachCommand);
    await sleep(SETTLE_MS * 2);
    const offAfterReattach = await inputOff();

    // Splitting reflows the window, which resizes the pane under test.
    await seat("split-window", "-d", "-t", "seat:0.0", "/bin/sh");
    await sleep(SETTLE_MS);
    const offAfterResize = await inputOff();

    const delivered = await deliver("typed-after-reattach", "real-client");
    return {
      pass: offWhileDetached && offAfterReattach && offAfterResize && !delivered,
      observed: { offWhileDetached, offAfterReattach, offAfterResize, deliveredAfterReattach: delivered },
    };
  });

  await probe("T11", "any pane in the session can clear the lock with select-pane -e", async () => {
    // The free shell pane split in T10 needs no privilege beyond talking to the same tmux
    // server the seat pane lives on.
    await seat("send-keys", "-t", freeShellPane, `tmux -S ${seatSocket} select-pane -e -t seat:0.0`, "Enter");
    await sleep(SETTLE_MS);
    const off = await inputOff();
    const delivered = await deliver("unlocked-from-shell-pane", "real-client");
    return {
      // Passing means the spike confirmed the bypass exists. `docs/design/SYSTEM.md` §16.2 already
      // calls this layer "UX"; this measures how thin it is.
      pass: !off && delivered,
      observed: { paneInputOffAfterUnlock: off, keystrokeDeliveredAfterUnlock: delivered },
    };
  });

  await Bun.write(
    `${here}/results.json`,
    `${JSON.stringify({ tmuxVersion: await tmux(seatSocket, "-V"), results }, null, 2)}\n`,
  );

  const failed = results.filter((r) => !r.pass);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} probes passed\n`);
  if (failed.length > 0) {
    process.stdout.write(`failed: ${failed.map((r) => r.id).join(", ")}\n`);
    process.exitCode = 1;
  }
} finally {
  await killServer(hostSocket);
  await killServer(seatSocket);
}

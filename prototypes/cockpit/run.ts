import { rm } from "node:fs/promises";

import { spawn } from "bun";

const here = import.meta.dir;
const scratch = `${here}/.prototype`;
const socket = `${scratch}/cockpit.sock`;
const serviceLog = `${scratch}/logs/services/web.log`;

const tmux = async (...args: Array<string>): Promise<string> => {
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

const killServer = async () => {
  await tmux("kill-server").catch(() => undefined);
};

interface Snapshot {
  readonly moment: string;
  readonly landingWindow: string;
  readonly statusLine: string;
  readonly windows: ReadonlyArray<{
    readonly name: string;
    readonly active: boolean;
    readonly panes: number;
    readonly managed: string;
  }>;
}

const setWorkflowStatus = async (values: {
  readonly stage: string;
  readonly controller: string;
  readonly cowboy: string;
  readonly connection: string;
}) => {
  for (const [name, value] of Object.entries(values)) {
    await tmux("set-option", "-t", "cockpit", `@bebop_${name}`, value);
  }
};

const statusLine = async (): Promise<string> => {
  const format =
    "stage=#{@bebop_stage} | control=#{@bebop_controller} | cowboy=#{@bebop_cowboy} | bebop=#{@bebop_connection}";
  return tmux("display-message", "-p", "-t", "cockpit", format);
};

const windows = async (): Promise<Snapshot["windows"]> => {
  const rows = await tmux(
    "list-windows",
    "-t",
    "cockpit",
    "-F",
    "#{window_name}\t#{window_active}\t#{window_panes}\t#{@bebop_managed}",
  );
  return rows.split("\n").map((row) => {
    const [name = "", active = "0", panes = "0", managed = ""] = row.split("\t");
    return { name, active: active === "1", panes: Number(panes), managed };
  });
};

const snapshot = async (moment: string, landingWindow: string): Promise<Snapshot> => ({
  moment,
  landingWindow,
  statusLine: await statusLine(),
  windows: await windows(),
});

const printSnapshot = (value: Snapshot) => {
  process.stdout.write(`\n=== ${value.moment} ===\n`);
  process.stdout.write(`new attachment lands: ${value.landingWindow}\n`);
  process.stdout.write(`status: ${value.statusLine}\n`);
  for (const window of value.windows) {
    process.stdout.write(
      `${window.active ? "*" : " "} ${window.name.padEnd(12)} panes=${window.panes} owner=${window.managed || "operator"}\n`,
    );
  }
};

const snapshots: Array<Snapshot> = [];

try {
  await killServer();
  await rm(scratch, { recursive: true, force: true });
  await Bun.write(`${scratch}/.keep`, "");

  await tmux(
    "new-session",
    "-d",
    "-s",
    "cockpit",
    "-x",
    "100",
    "-y",
    "30",
    "-n",
    "ein-1",
    `bun ${here}/fake-seat.ts ein 1`,
  );
  await tmux("set-window-option", "-t", "cockpit:ein-1", "@bebop_managed", "seat");
  await tmux(
    "set-option",
    "-t",
    "cockpit",
    "status-left",
    "#[bold] bebop #[default] #{@bebop_stage} | #{@bebop_controller} | #{@bebop_cowboy} ",
  );
  await tmux(
    "set-option",
    "-t",
    "cockpit",
    "status-right",
    " #{@bebop_connection} | SWORDFISH CONTROL: run sf takeover in a shell ",
  );
  await setWorkflowStatus({
    stage: "building",
    controller: "swordfish",
    cowboy: "ein",
    connection: "connected",
  });
  snapshots.push(await snapshot("initial SSH attachment", "ein-1"));

  // The operator chooses this layout. Swordfish must preserve it when a new seat appears.
  await tmux("split-window", "-d", "-t", "cockpit:ein-1", "/bin/sh");
  await tmux("new-window", "-d", "-t", "cockpit", "-n", "notes", "/bin/sh");
  await tmux("new-window", "-d", "-t", "cockpit", "-n", "jet-1", `bun ${here}/fake-seat.ts jet 1`);
  await tmux("set-window-option", "-t", "cockpit:jet-1", "@bebop_managed", "seat");
  await setWorkflowStatus({
    stage: "reviewing",
    controller: "swordfish",
    cowboy: "jet",
    connection: "connected",
  });
  snapshots.push(await snapshot("jet becomes active without stealing focus", "jet-1"));

  await tmux("new-window", "-d", "-t", "cockpit", "-n", "landing", `bun ${here}/landing-shell.ts`);
  await tmux("set-window-option", "-t", "cockpit:landing", "@bebop_managed", "landing-shell");
  await setWorkflowStatus({
    stage: "validating",
    controller: "swordfish",
    cowboy: "none",
    connection: "connected",
  });
  snapshots.push(await snapshot("deterministic stage with no active cowboy", "landing"));

  await Bun.write(serviceLog, "web: listening on 127.0.0.1:3000\n", { createPath: true });
  const tailCommand = `tail -F ${serviceLog}`;
  process.stdout.write(`\nservice logs: ${tailCommand}\n`);

  for (const value of snapshots) printSnapshot(value);

  const initial = snapshots[0];
  const afterJet = snapshots[1];
  const initialIsOnePane = initial?.windows.length === 1 && initial.windows[0]?.panes === 1;
  const focusStayedOnEin = afterJet?.windows.find((window) => window.active)?.name === "ein-1";
  const operatorLayoutSurvived = afterJet?.windows.find((window) => window.name === "ein-1")?.panes === 2;
  const userWindowSurvived = afterJet?.windows.some((window) => window.name === "notes" && window.managed === "");
  const findings = { initialIsOnePane, focusStayedOnEin, operatorLayoutSurvived, userWindowSurvived };

  await Bun.write(
    `${here}/results.json`,
    `${JSON.stringify({ tmuxVersion: await tmux("-V"), snapshots, tailCommand, findings }, null, 2)}\n`,
  );
  process.stdout.write(`\nfindings: ${JSON.stringify(findings)}\n`);
  if (Object.values(findings).some((value) => !value)) process.exitCode = 1;
} finally {
  await killServer();
}

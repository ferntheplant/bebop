import { rm } from "node:fs/promises";
import { resolve } from "node:path";

import { spawn, type Subprocess } from "bun";

const here = import.meta.dir;
const workspace = resolve(here, "../..");
const project = `${here}/project`;
const scratch = `${project}/.prototype`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface OpenCodeEvent {
  readonly type: string;
  readonly properties?: Record<string, unknown>;
}

async function readFirstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!buffer.includes("\n")) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
  return (buffer.split("\n")[0] ?? "").trim();
}

async function waitFor(predicate: () => boolean, description: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function waitForServer(base: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/app/agents`)).ok) return;
    } catch {
      // Server has not bound its port yet.
    }
    await sleep(200);
  }
  throw new Error(`OpenCode server did not become ready at ${base}`);
}

async function collectEvents(base: string, signal: AbortSignal, events: Array<OpenCodeEvent>): Promise<void> {
  const response = await fetch(`${base}/event`, { signal });
  if (!response.ok || !response.body) throw new Error(`OpenCode event stream failed: ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6);
      if (data) events.push(JSON.parse(data) as OpenCodeEvent);
    }
  }
}

async function request(base: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} failed (${response.status}): ${text}`);
  return text.length === 0 ? undefined : (JSON.parse(text) as unknown);
}

async function commandText(command: Array<string>, cwd: string): Promise<string> {
  const child = spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${command.join(" ")} failed (${code}): ${stderr.trim()}`);
  return stdout.trim();
}

function eventsForSession(events: ReadonlyArray<OpenCodeEvent>, sessionID: string): Array<OpenCodeEvent> {
  return events.filter((event) => {
    const properties = event.properties;
    if (properties?.sessionID === sessionID) return true;
    const info = properties?.info;
    return (
      typeof info === "object" &&
      info !== null &&
      (("id" in info && info.id === sessionID) || ("sessionID" in info && info.sessionID === sessionID))
    );
  });
}

function summarize(events: ReadonlyArray<OpenCodeEvent>): Array<Record<string, unknown>> {
  return events.map((event) => {
    const properties = event.properties ?? {};
    const info = typeof properties.info === "object" && properties.info !== null ? properties.info : undefined;
    const part = typeof properties.part === "object" && properties.part !== null ? properties.part : undefined;
    return {
      type: event.type,
      status: properties.status,
      error: properties.error,
      revert: info && "revert" in info ? info.revert : undefined,
      messageRole: info && "role" in info ? info.role : undefined,
      messageError: info && "error" in info ? info.error : undefined,
      partType: part && "type" in part ? part.type : undefined,
    };
  });
}

let fake: Subprocess | undefined;
let server: Subprocess | undefined;
const controller = new AbortController();

try {
  await rm(project, { recursive: true, force: true });
  await Bun.write(`${scratch}/.keep`, "", { createPath: true });

  fake = spawn(["bun", `${here}/fake-model.ts`], { stdout: "pipe", stderr: "inherit" });
  const fakeUrl = await readFirstLine(fake.stdout as ReadableStream<Uint8Array>).then(
    (line) => (JSON.parse(line) as { url: string }).url,
  );

  await Bun.write(
    `${project}/opencode.json`,
    `${JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        model: "fake/fake-model",
        provider: {
          fake: {
            npm: "@ai-sdk/openai-compatible",
            name: "Fake Prototype Provider",
            options: { baseURL: `${fakeUrl}/v1`, apiKey: "not-a-real-key" },
            models: { "fake-model": { name: "Fake Model" } },
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  const version = await commandText(["bun", "x", "opencode-ai@1.18.5", "--version"], workspace);
  if (version !== "1.18.5") throw new Error(`Expected OpenCode 1.18.5, got ${version}`);

  const port = 4_700 + Math.floor(Math.random() * 200);
  const base = `http://127.0.0.1:${port}`;
  server = spawn(
    [
      "bun",
      "x",
      "opencode-ai@1.18.5",
      "serve",
      "--port",
      String(port),
      "--hostname",
      "127.0.0.1",
      "--log-level",
      "WARN",
    ],
    {
      cwd: workspace,
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        OPENCODE_CONFIG: `${project}/opencode.json`,
        OPENCODE_DB: `${scratch}/opencode-db`,
        OPENCODE_DISABLE_AUTOUPDATE: "1",
      },
    },
  );
  await waitForServer(base);

  const events: Array<OpenCodeEvent> = [];
  const collecting = collectEvents(base, controller.signal, events).catch((error: unknown) => {
    if (!controller.signal.aborted) throw error;
  });
  await waitFor(() => events.some((event) => event.type === "server.connected"), "event subscription");

  const created = (await request(base, "/session", { title: "seat mutation event prototype" })) as { id: string };
  const sessionID = created.id;
  const model = { providerID: "fake", modelID: "fake-model" };
  let start = events.length;
  const initial = (await request(base, `/session/${sessionID}/message`, {
    model,
    parts: [{ type: "text", text: "baseline" }],
  })) as { info: { id: string } };

  const observations: Record<string, Array<Record<string, unknown>>> = {};
  await sleep(300);
  observations.naturalCompletion = summarize(eventsForSession(events.slice(start), sessionID));

  start = events.length;
  await request(base, `/session/${sessionID}/shell`, {
    model,
    agent: "build",
    command: `touch ${scratch}/shell-ran.sentinel`,
  });
  await sleep(300);
  observations.shell = summarize(eventsForSession(events.slice(start), sessionID));

  start = events.length;
  await request(base, `/session/${sessionID}/revert`, { messageID: initial.info.id });
  await sleep(300);
  observations.revert = summarize(eventsForSession(events.slice(start), sessionID));

  start = events.length;
  await request(base, `/session/${sessionID}/unrevert`, {});
  await sleep(300);
  observations.unrevert = summarize(eventsForSession(events.slice(start), sessionID));

  start = events.length;
  await request(base, `/session/${sessionID}/prompt_async`, {
    model,
    parts: [{ type: "text", text: "hold-open" }],
  });
  await waitFor(
    () =>
      eventsForSession(events.slice(start), sessionID).some(
        (event) => event.type === "session.status" && event.properties?.status !== undefined,
      ),
    "busy status",
  );
  await request(base, `/session/${sessionID}/abort`, {});
  await sleep(500);
  observations.abort = summarize(eventsForSession(events.slice(start), sessionID));

  const shellRan = await Bun.file(`${scratch}/shell-ran.sentinel`).exists();
  const findings = {
    shellObservable:
      shellRan &&
      observations.shell.some((event) => event.type === "message.part.updated" || event.type === "message.updated"),
    revertObservable: observations.revert.some(
      (event) => event.type === "session.updated" && event.revert !== undefined,
    ),
    unrevertObservable: observations.unrevert.some((event) => event.type === "session.updated"),
    abortDistinctFromCompletion: observations.abort.some(
      (event) =>
        (event.type === "session.error" &&
          typeof event.error === "object" &&
          event.error !== null &&
          "name" in event.error &&
          event.error.name === "MessageAbortedError") ||
        (event.type === "message.updated" &&
          typeof event.messageError === "object" &&
          event.messageError !== null &&
          "name" in event.messageError &&
          event.messageError.name === "MessageAbortedError"),
    ),
  };

  await Bun.write(
    `${here}/results.json`,
    `${JSON.stringify({ openCodeVersion: version, sessionID, observations, findings }, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify({ openCodeVersion: version, observations, findings }, null, 2)}\n`);
  if (Object.values(findings).some((value) => !value)) process.exitCode = 1;

  controller.abort();
  await collecting;
} finally {
  controller.abort();
  server?.kill();
  fake?.kill();
  await sleep(300);
}

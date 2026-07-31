// Spike driver: starts a fake model endpoint and a real pinned OpenCode server,
// then probes every prompt-submission route with the seat leased and unleased.
//
// The load-bearing assertion is NOT "an error was returned" — it is that the fake
// model endpoint receives ZERO requests while the lease is held. A rejection that
// still burns a model turn would not be a control lease.

import { spawn, type Subprocess } from "bun";

const here = import.meta.dir;
const project = `${here}/project`;
const prototypeDirectory = `${project}/.prototype`;
const leaseFile = `${prototypeDirectory}/lease.json`;
const auditFile = `${prototypeDirectory}/audit.jsonl`;
const sentinel = `${prototypeDirectory}/shell-ran.sentinel`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function setLease(owner: "human" | "swordfish") {
  await Bun.write(leaseFile, JSON.stringify({ owner }), { createPath: true });
}

async function modelCallCount(fakeUrl: string): Promise<number> {
  const response = await fetch(`${fakeUrl}/__calls`);
  return ((await response.json()) as { count: number }).count;
}

async function readAudit(): Promise<Array<Record<string, unknown>>> {
  const text = await Bun.file(auditFile)
    .text()
    .catch(() => "");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
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

async function waitForServer(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/app/agents`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error(`OpenCode server did not become ready at ${url}`);
}

interface Probe {
  readonly name: string;
  readonly method: string;
  readonly path: (sessionID: string) => string;
  readonly body: unknown;
}

const model = { providerID: "fake", modelID: "fake-model" };
const textPart = [{ type: "text", text: "Please change the button colour to blue." }];

const probes: Array<Probe> = [
  {
    name: "POST /session/:id/message (synchronous prompt)",
    method: "POST",
    path: (id) => `/session/${id}/message`,
    body: { model, parts: textPart },
  },
  {
    name: "POST /session/:id/prompt_async",
    method: "POST",
    path: (id) => `/session/${id}/prompt_async`,
    body: { model, parts: textPart },
  },
  {
    name: "POST /session/:id/command",
    method: "POST",
    path: (id) => `/session/${id}/command`,
    body: { model: "fake/fake-model", agent: "build", command: "spike", arguments: "" },
  },
  {
    name: "POST /session/:id/shell",
    method: "POST",
    path: (id) => `/session/${id}/shell`,
    body: { model, agent: "build", command: `touch ${prototypeDirectory}/shell-ran.sentinel` },
  },
];

async function submit(base: string, sessionID: string, probe: Probe) {
  const response = await fetch(`${base}${probe.path(sessionID)}`, {
    method: probe.method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(probe.body),
  });
  const text = await response.text();
  return { status: response.status, body: text.slice(0, 400) };
}

let fake: Subprocess | undefined;
let server: Subprocess | undefined;

try {
  await Bun.write(`${prototypeDirectory}/.keep`, "", { createPath: true });
  await Bun.write(auditFile, "");
  await setLease("human");

  // 1. Fake model endpoint.
  fake = spawn(["bun", `${here}/fake-model.ts`], { stdout: "pipe", stderr: "inherit" });
  const fakeUrl = await readFirstLine(fake.stdout as ReadableStream<Uint8Array>).then(
    (line) => (JSON.parse(line) as { url: string }).url,
  );
  process.stdout.write(`fake model endpoint: ${fakeUrl}\n`);

  // 2. OpenCode config pointing exclusively at the fake endpoint.
  await Bun.write(
    `${project}/opencode.json`,
    `${JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        model: "fake/fake-model",
        provider: {
          fake: {
            npm: "@ai-sdk/openai-compatible",
            name: "Fake Spike Provider",
            options: { baseURL: `${fakeUrl}/v1`, apiKey: "not-a-real-key" },
            models: { "fake-model": { name: "Fake Model" } },
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  // 3. Real pinned OpenCode server.
  const port = 4123 + Math.floor(Math.random() * 500);
  const base = `http://127.0.0.1:${port}`;
  server = spawn(["opencode", "serve", "--port", String(port), "--hostname", "127.0.0.1", "--log-level", "INFO"], {
    cwd: project,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, OPENCODE_CONFIG: `${project}/opencode.json` },
  });
  await waitForServer(base);
  process.stdout.write(`opencode server: ${base}\n\n`);

  const created = await fetch(`${base}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "lease guard spike" }),
  });
  const session = (await created.json()) as { id: string };
  process.stdout.write(`session: ${session.id}\n\n`);

  const results: Array<Record<string, unknown>> = [];

  for (const probe of probes) {
    for (const owner of ["human", "swordfish"] as const) {
      await setLease(owner);
      await fetch(`${fakeUrl}/__reset`, { method: "GET" });
      await Bun.$`rm -f ${sentinel}`.quiet().nothrow();
      const before = await modelCallCount(fakeUrl);
      const outcome = await submit(base, session.id, probe);
      await sleep(1500);
      const after = await modelCallCount(fakeUrl);
      const shellRan = await Bun.file(sentinel).exists();

      results.push({
        probe: probe.name,
        lease: owner,
        httpStatus: outcome.status,
        modelCalls: after - before,
        shellSideEffect: shellRan,
        body: outcome.body,
      });

      process.stdout.write(
        `${probe.name}\n  lease=${owner.padEnd(9)} http=${outcome.status} modelCalls=${after - before} shellSideEffect=${shellRan}\n  ${outcome.body.replaceAll("\n", " ").slice(0, 200)}\n\n`,
      );
    }
  }

  const messages = await fetch(`${base}/session/${session.id}/message`).then((r) => r.json());
  await Bun.write(`${here}/results.json`, JSON.stringify({ results, messages, audit: await readAudit() }, null, 2));

  process.stdout.write("=== hook audit ===\n");
  for (const entry of await readAudit()) {
    process.stdout.write(`  ${JSON.stringify(entry)}\n`);
  }
} finally {
  server?.kill();
  fake?.kill();
  await sleep(300);
}

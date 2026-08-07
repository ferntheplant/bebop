process.env.NO_COLOR = "1";

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { renderFrontier } from "./frontier";

const roots: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "bebop-frontier-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface TicketOptions {
  type?: string;
  status?: string;
  blockedBy?: string[];
  title?: string;
}

function writeTicket(root: string, group: string, slug: string, options: TicketOptions = {}): void {
  const dir = group === "unprojected" ? join(root, "tickets") : join(root, group, "tickets");
  mkdirSync(dir, { recursive: true });
  const frontmatter = [
    "---",
    `type: ${options.type ?? "grilling"}`,
    `status: ${options.status ?? "open"}`,
    ...(options.blockedBy === undefined ? [] : [`blocked-by: [${options.blockedBy.join(", ")}]`]),
    "---",
    "",
    `# ${options.title ?? slug}`,
  ].join("\n");
  writeFileSync(join(dir, `${slug}.md`), `${frontmatter}\n`);
}

function writeMap(root: string, project: string, name: string): void {
  mkdirSync(join(root, project), { recursive: true });
  writeFileSync(join(root, project, "map.md"), `# ${name}\n\nLabel: \`wayfinder:map\`\n`);
}

function writeBacklogItem(root: string, slug: string, title: string, date: Date): void {
  mkdirSync(join(root, "backlog"), { recursive: true });
  const file = join(root, "backlog", `${slug}.md`);
  writeFileSync(file, `# ${title}\n\nA couple of sentences.\n`);
  utimesSync(file, date, date);
}

function between(output: string, first: string, second: string): boolean {
  return output.indexOf(first) !== -1 && output.indexOf(first) < output.indexOf(second);
}

describe("blocker resolution", () => {
  it("lists a ticket whose blockers are done or absent, and hides one with an open blocker", () => {
    const root = fixture();
    writeTicket(root, "unprojected", "alpha", { title: "Alpha" });
    writeTicket(root, "unprojected", "beta", { title: "Beta", blockedBy: ["gamma"] });
    writeTicket(root, "unprojected", "gamma", { title: "Gamma", status: "done" });
    writeTicket(root, "unprojected", "delta", { title: "Delta", blockedBy: ["epsilon"] });
    writeTicket(root, "unprojected", "epsilon", { title: "Epsilon" });

    const output = renderFrontier(root);

    expect(output).toContain("▸ Alpha");
    expect(output).toContain("▸ Beta");
    expect(output).toContain("▸ Epsilon");
    expect(output).not.toContain("▸ Gamma");
    expect(output).not.toContain("▸ Delta");
  });

  it("resolves blocked-by across project directories", () => {
    const root = fixture();
    writeMap(root, "proj-a", "Project A");
    writeMap(root, "proj-b", "Project B");
    writeTicket(root, "proj-a", "waits-on-other", {
      title: "Waits on the other project",
      blockedBy: ["provision-in-beta"],
    });
    writeTicket(root, "proj-b", "provision-in-beta", { title: "Provision in beta" });

    const output = renderFrontier(root);

    expect(output).not.toContain("Waits on the other project");
    expect(output).toContain("▸ Provision in beta");
  });

  it("treats a blocker absorbed in another project as satisfied", () => {
    const root = fixture();
    writeMap(root, "proj-a", "Project A");
    writeMap(root, "proj-b", "Project B");
    writeTicket(root, "proj-a", "waits-on-other", {
      title: "Waits on the other project",
      blockedBy: ["absorbed-in-beta"],
    });
    writeTicket(root, "proj-b", "absorbed-in-beta", { title: "Absorbed in beta", status: "done" });

    const output = renderFrontier(root);

    expect(output).toContain("▸ Waits on the other project");
  });

  it("renders a dangling blocked-by as takeable and prints the slug", () => {
    const root = fixture();
    writeTicket(root, "unprojected", "zeta", { title: "Zeta", blockedBy: ["nope-typo"] });

    const output = renderFrontier(root);

    expect(output).toContain("▸ Zeta");
    expect(output).toContain("dangling blocker: nope-typo");
  });
});

describe("critical-path ranking", () => {
  it("sorts by the transitive gate count and prints it", () => {
    const root = fixture();
    writeMap(root, "proj", "Project");
    writeTicket(root, "proj", "a", { title: "Alpha" });
    writeTicket(root, "proj", "b", { title: "Beta", blockedBy: ["a"] });
    writeTicket(root, "proj", "c", { title: "Gamma" });
    writeTicket(root, "proj", "d", { title: "Delta", blockedBy: ["b"] });

    const output = renderFrontier(root);
    const decide = output.slice(output.indexOf("▍ DECIDE"));

    expect(decide).toContain("▸ Alpha · gates 2");
    expect(between(decide, "▸ Alpha · gates 2", "▸ Gamma"));
    expect(between(decide, "▸ Gamma", "▸ Alpha · gates 2")).toBe(false);
  });

  it("counts a chain broken by a done ticket as no longer gated", () => {
    const root = fixture();
    writeMap(root, "proj", "Project");
    writeTicket(root, "proj", "a", { title: "Alpha" });
    writeTicket(root, "proj", "b", { title: "Beta", blockedBy: ["a"], status: "done" });
    writeTicket(root, "proj", "c", { title: "Gamma", blockedBy: ["b"] });

    const output = renderFrontier(root);

    expect(output).toContain("▸ Alpha");
    expect(output).not.toContain("gates 1");
  });
});

describe("build section", () => {
  it("lists open unblocked builds, keeps them out of Decide, and drops blocked ones", () => {
    const root = fixture();
    writeTicket(root, "unprojected", "r1", { title: "Build one", type: "build" });
    writeTicket(root, "unprojected", "r2", { title: "Build two", type: "build", blockedBy: ["r1"] });
    writeTicket(root, "unprojected", "r3", { title: "A decision", type: "grilling" });

    const output = renderFrontier(root);
    const build = output.slice(0, output.indexOf("▍ DECIDE"));
    const decide = output.slice(output.indexOf("▍ DECIDE"));

    expect(build).toContain("▸ Build one");
    expect(build).not.toContain("Build two");
    expect(decide).toContain("▸ A decision");
    expect(decide).not.toContain("Build one");
    expect(decide).not.toContain("Build two");
  });
});

describe("triage", () => {
  it("reports backlog depth and the oldest item", () => {
    const root = fixture();
    writeBacklogItem(root, "older", "The older item", new Date("2026-01-15T00:00:00Z"));
    writeBacklogItem(root, "newer", "The newer item", new Date("2026-06-15T00:00:00Z"));

    const output = renderFrontier(root);

    expect(output).toContain('2 items in the backlog · oldest is "The older item"');
  });

  it("renders an empty backlog without error", () => {
    const root = fixture();
    writeTicket(root, "unprojected", "alpha", { title: "Alpha" });

    const output = renderFrontier(root);

    expect(output).toContain("· empty backlog");
  });

  it("ignores the backlog README", () => {
    const root = fixture();
    mkdirSync(join(root, "backlog"), { recursive: true });
    writeFileSync(join(root, "backlog", "README.md"), "# Backlog\n\nUntriaged.\n");
    writeBacklogItem(root, "one", "One", new Date("2026-01-15T00:00:00Z"));

    const output = renderFrontier(root);

    expect(output).toContain("1 item in the backlog");
  });
});

describe("empty and partial trackers", () => {
  it("renders a project with no tickets directory without error", () => {
    const root = fixture();
    writeMap(root, "ghost", "Ghost project");
    writeTicket(root, "unprojected", "alpha", { title: "Alpha" });

    const output = renderFrontier(root);

    expect(output).toContain("▍ DECIDE");
    expect(output).toContain("▸ Alpha");
  });

  it("renders an empty tracker without error", () => {
    const root = fixture();

    const output = renderFrontier(root);

    expect(output).toContain("▍ BUILD");
    expect(output).toContain("· nothing specified and unbuilt");
    expect(output).toContain("· nothing takeable");
    expect(output).toContain("· empty backlog");
  });
});

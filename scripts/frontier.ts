import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const TICKET_TYPES = new Set(["grilling", "prototype", "research", "task", "build"]);
const TICKET_STATUSES = new Set(["open", "claimed", "done"]);
const BUILD_TYPE = "build";
const TOP_LEVEL_GROUP = "unprojected";
const DEFAULT_UNPROJECTED_NAME = "Unprojected tickets";

interface Ticket {
  slug: string;
  title: string;
  type: string;
  status: string;
  blockedBy: string[];
  group: string;
  file: string;
}

interface ProjectGroup {
  key: string;
  name: string;
  ticketsDir: string;
}

interface BlockerState {
  blockers: Ticket[];
  dangling: string[];
}

type TicketIndex = Map<string, Ticket>;

const useColor = (): boolean => process.env.NO_COLOR === undefined || process.env.NO_COLOR === "";

function paint(code: string, text: string): string {
  return useColor() ? `\u001b[${code}m${text}\u001b[0m` : text;
}

const bold = (text: string): string => paint("1", text);
const dim = (text: string): string => paint("2", text);
const green = (text: string): string => paint("32", text);
const cyan = (text: string): string => paint("36", text);
const magenta = (text: string): string => paint("35", text);
const yellow = (text: string): string => paint("33", text);
const red = (text: string): string => paint("31", text);

function parseBlockedBy(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed === "") return [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner === "") return [];
    return inner
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "");
  }
  return [trimmed];
}

function parseFrontmatter(content: string): { type: string; status: string; blockedBy: string[] } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match || match[1] === undefined) return null;
  const fields = { type: "", status: "", blockedBy: [] as string[] };
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z][A-Za-z-]*):\s*(.*)$/.exec(line);
    if (!field || field[1] === undefined || field[2] === undefined) continue;
    const value = field[2].trim();
    if (field[1] === "type") fields.type = value;
    else if (field[1] === "status") fields.status = value;
    else if (field[1] === "blocked-by") fields.blockedBy = parseBlockedBy(value);
  }
  return fields;
}

function headingOf(content: string, fallback: string): string {
  for (const line of content.split(/\r?\n/)) {
    const heading = /^# (.+)$/.exec(line);
    if (heading && heading[1]) return heading[1];
  }
  return fallback;
}

function fileHeading(file: string, fallback: string): string {
  try {
    return headingOf(readFileSync(file, "utf8"), fallback);
  } catch {
    return fallback;
  }
}

function markdownFiles(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => join(dir, name));
}

function discoverProjects(scratchRoot: string): ProjectGroup[] {
  let entries;
  try {
    entries = readdirSync(scratchRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const projects: ProjectGroup[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(scratchRoot, entry.name);
    if (!existsSync(join(dir, "map.md"))) continue;
    projects.push({
      key: entry.name,
      name: fileHeading(join(dir, "map.md"), entry.name),
      ticketsDir: join(dir, "tickets"),
    });
  }
  return projects;
}

function scanTracker(scratchRoot: string): { groups: ProjectGroup[]; tickets: Ticket[] } {
  const topTicketsDir = join(scratchRoot, "tickets");
  const groups: ProjectGroup[] = [
    {
      key: TOP_LEVEL_GROUP,
      name: fileHeading(join(topTicketsDir, "README.md"), DEFAULT_UNPROJECTED_NAME),
      ticketsDir: topTicketsDir,
    },
    ...discoverProjects(scratchRoot),
  ];
  const tickets: Ticket[] = [];
  for (const group of groups) {
    for (const file of markdownFiles(group.ticketsDir)) {
      const frontmatter = parseFrontmatter(readFileSync(file, "utf8"));
      if (!frontmatter) continue;
      if (!TICKET_TYPES.has(frontmatter.type)) {
        process.stderr.write(`warn: ${basename(file)} has an unknown type (${frontmatter.type}); skipped\n`);
        continue;
      }
      if (!TICKET_STATUSES.has(frontmatter.status) && frontmatter.status !== "") {
        process.stderr.write(
          `warn: ${basename(file)} has an unknown status (${frontmatter.status}); treated as open\n`,
        );
      }
      tickets.push({
        slug: basename(file, ".md"),
        title: fileHeading(file, basename(file, ".md")),
        type: frontmatter.type,
        status: frontmatter.status === "" ? "open" : frontmatter.status,
        blockedBy: frontmatter.blockedBy,
        group: group.key,
        file,
      });
    }
  }
  return { groups, tickets };
}

function ticketIndex(tickets: Ticket[]): TicketIndex {
  const index: TicketIndex = new Map();
  for (const ticket of tickets) index.set(ticket.slug, ticket);
  return index;
}

function reverseBlockers(tickets: Ticket[], index: TicketIndex): Map<string, string[]> {
  const reverse = new Map<string, string[]>();
  for (const ticket of tickets) {
    for (const slug of ticket.blockedBy) {
      const blocker = index.get(slug);
      if (!blocker) continue;
      const dependents = reverse.get(blocker.slug) ?? [];
      dependents.push(ticket.slug);
      reverse.set(blocker.slug, dependents);
    }
  }
  return reverse;
}

function blockerState(ticket: Ticket, index: TicketIndex): BlockerState {
  const blockers: Ticket[] = [];
  const dangling: string[] = [];
  for (const slug of ticket.blockedBy) {
    const blocker = index.get(slug);
    if (!blocker) dangling.push(slug);
    else if (blocker.status !== "done") blockers.push(blocker);
  }
  return { blockers, dangling };
}

function transitivelyGated(slug: string, reverse: Map<string, string[]>, index: TicketIndex): Set<string> {
  const seen = new Set<string>();
  const stack = [...(reverse.get(slug) ?? [])];
  for (let i = 0; i < stack.length; i++) {
    const current = stack[i];
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    const currentTicket = index.get(current);
    if (!currentTicket || currentTicket.status === "done") continue;
    for (const dependent of reverse.get(current) ?? []) stack.push(dependent);
  }
  return seen;
}

function gateCounts(
  ticket: Ticket,
  reverse: Map<string, string[]>,
  index: TicketIndex,
): { gates: number; direct: number } {
  const reachable = transitivelyGated(ticket.slug, reverse, index);
  let gates = 0;
  for (const slug of reachable) {
    if (index.get(slug)?.status !== "done") gates++;
  }
  return {
    gates,
    direct: (reverse.get(ticket.slug) ?? []).filter((slug) => index.get(slug)?.status !== "done").length,
  };
}

function gatesText(gates: number, direct: number): string {
  if (gates === 0) return "";
  return direct === gates ? `gates ${gates}` : `gates ${gates} (${direct} directly)`;
}

function decideLine(title: string, gates: number, direct: number, dangling: string[]): string {
  const parts: string[] = [];
  const gatesNote = gatesText(gates, direct);
  if (gatesNote !== "") parts.push(cyan(gatesNote));
  if (dangling.length > 0) parts.push(red(`dangling blocker: ${dangling.join(", ")}`));
  const note = parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
  return `  ${cyan("▸")} ${title}${note}`;
}

function buildLine(title: string, blockers: Ticket[], dangling: string[], gates: number, direct: number): string {
  const parts: string[] = [];
  if (blockers.length > 0) parts.push(yellow(`blocked by ${blockers.map((b) => `"${b.title}"`).join(", ")}`));
  if (dangling.length > 0) parts.push(red(`dangling blocker: ${dangling.join(", ")}`));
  const gatesNote = gatesText(gates, direct);
  if (gatesNote !== "") parts.push(cyan(gatesNote));
  const note = parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
  return `  ${green("▸")} ${title}${note}`;
}

function backlogItems(scratchRoot: string): string[] {
  return markdownFiles(join(scratchRoot, "backlog")).filter((file) => basename(file) !== "README.md");
}

function gitAddDate(file: string, cwd: string): Date | null {
  try {
    const out = execFileSync("git", ["log", "--format=%cI", "--reverse", "--", file], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const first = out.split("\n").find((line) => line.trim() !== "");
    if (first === undefined) return null;
    const date = new Date(first);
    return Number.isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
}

function itemDate(file: string, scratchRoot: string): Date {
  const fromGit = gitAddDate(file, scratchRoot);
  if (fromGit) return fromGit;
  try {
    return statSync(file).mtime;
  } catch {
    return new Date(0);
  }
}

export function renderFrontier(scratchRoot: string): string {
  const { groups, tickets } = scanTracker(scratchRoot);
  const index = ticketIndex(tickets);
  const reverse = reverseBlockers(tickets, index);
  const groupNames = new Map(groups.map((group) => [group.key, group.name]));
  const lines: string[] = [];

  lines.push(`${cyan("◆")} ${bold("Frontier — what's up next")}`);

  lines.push("", bold(green("▍ BUILD")));
  const builds = tickets
    .filter((ticket) => ticket.type === BUILD_TYPE && ticket.status === "open")
    .map((ticket) => {
      const state = blockerState(ticket, index);
      return { ticket, state, unblocked: state.blockers.length === 0, ...gateCounts(ticket, reverse, index) };
    })
    .sort((a, b) => {
      if (a.unblocked !== b.unblocked) return a.unblocked ? -1 : 1;
      if (b.gates !== a.gates) return b.gates - a.gates;
      return a.ticket.title.localeCompare(b.ticket.title);
    });
  if (builds.length === 0) {
    lines.push(`  ${dim("· nothing specified and unbuilt")}`);
  } else {
    for (const entry of builds) {
      lines.push(buildLine(entry.ticket.title, entry.state.blockers, entry.state.dangling, entry.gates, entry.direct));
    }
  }

  lines.push("", bold(cyan("▍ DECIDE")));
  const byGroup = new Map<string, Ticket[]>();
  const meta = new Map<string, { gates: number; direct: number; dangling: string[] }>();
  for (const ticket of tickets) {
    if (ticket.type === BUILD_TYPE || ticket.status !== "open") continue;
    const state = blockerState(ticket, index);
    if (state.blockers.length > 0) continue;
    const list = byGroup.get(ticket.group) ?? [];
    list.push(ticket);
    byGroup.set(ticket.group, list);
    meta.set(ticket.slug, { ...gateCounts(ticket, reverse, index), dangling: state.dangling });
  }
  if (byGroup.size === 0) {
    lines.push(`  ${dim("· nothing takeable")}`);
  } else {
    const groupOrder = [...byGroup.keys()].sort((a, b) => {
      const maxA = Math.max(...(byGroup.get(a) ?? []).map((t) => meta.get(t.slug)?.gates ?? 0));
      const maxB = Math.max(...(byGroup.get(b) ?? []).map((t) => meta.get(t.slug)?.gates ?? 0));
      if (maxA !== maxB) return maxB - maxA;
      return (groupNames.get(a) ?? a).localeCompare(groupNames.get(b) ?? b);
    });
    for (const groupKey of groupOrder) {
      const groupTickets = (byGroup.get(groupKey) ?? []).sort((a, b) => {
        const gatesA = meta.get(a.slug)?.gates ?? 0;
        const gatesB = meta.get(b.slug)?.gates ?? 0;
        if (gatesA !== gatesB) return gatesB - gatesA;
        return a.title.localeCompare(b.title);
      });
      lines.push("", `  ${magenta("●")} ${bold(groupNames.get(groupKey) ?? groupKey)}`);
      for (const ticket of groupTickets) {
        const m = meta.get(ticket.slug);
        lines.push(decideLine(ticket.title, m?.gates ?? 0, m?.direct ?? 0, m?.dangling ?? []));
      }
    }
  }

  lines.push("", bold(yellow("▍ TRIAGE")));
  const items = backlogItems(scratchRoot);
  if (items.length === 0) {
    lines.push(dim("· empty backlog"));
  } else {
    const dated = items
      .map((file) => ({ file, date: itemDate(file, scratchRoot) }))
      .sort((a, b) => a.date.getTime() - b.date.getTime());
    const oldest = dated[0];
    if (oldest === undefined) {
      lines.push(`${items.length} item${items.length === 1 ? "" : "s"} in the backlog`);
    } else {
      const title = fileHeading(oldest.file, basename(oldest.file, ".md"));
      const iso = oldest.date.toISOString().slice(0, 10);
      lines.push(
        `${items.length} item${items.length === 1 ? "" : "s"} in the backlog · oldest is "${title}" ${dim(`(${iso})`)}`,
      );
    }
  }

  return lines.join("\n");
}

function main(): void {
  process.stdout.write(`${renderFrontier(".scratch")}\n`);
}

if (import.meta.main) {
  main();
}

// ---------------------------------------------------------------------------
// Local (non-RPC) CLI command for ADE's bundled agent skills.
//
//   ade skill list [--text|--json]
//   ade skill show <name> [--text|--json]
//
// This is the tamper-proof, version-locked backstop for agents that can't
// natively discover ADE's bundled skills. It reads the ADE-versioned
// `agent-skills/<name>/SKILL.md` files directly from the bundled resources
// root (resolved via agentSkillRoots), so it works headless without the
// runtime daemon — exactly like the `ade open`/`ade link` deeplink commands.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import { getAdeAgentSkillRootCandidates } from "../../../desktop/src/shared/agentSkillRoots";

export class CliSkillUsageError extends Error {}

export type SkillCliResult = {
  output: string;
  exitCode: number;
};

const HELP_SKILL = [
  "Usage:",
  "  ade skill list [--text|--json]        List ADE's bundled agent skills",
  "  ade skill show <name> [--text|--json] Show a bundled skill's SKILL.md",
  "",
  "  Serves ADE's version-locked bundled agent skills directly from the",
  "  bundled resources, without a runtime daemon. JSON output is the default;",
  "  pass --text for human-readable output.",
].join("\n");

type SkillEntry = {
  name: string;
  description: string;
  content: string;
  path: string;
};

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

type ParsedSkillFile = {
  name: string | null;
  description: string;
  body: string;
};

function parseSkillFile(content: string, fallbackName: string): ParsedSkillFile {
  // Frontmatter is delimited by a leading `---` line and a closing `---` line.
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!match) {
    return { name: fallbackName, description: "", body: content };
  }
  const [, frontmatter, body] = match;
  let name: string | null = null;
  let description = "";
  try {
    const data = parseYaml(frontmatter) as Record<string, unknown> | null;
    if (data && typeof data === "object") {
      if (typeof data.name === "string") name = data.name.trim();
      if (typeof data.description === "string") description = data.description.trim();
    }
  } catch {
    // Fall through to a minimal line-based parse below.
  }
  if (name == null && !description) {
    for (const line of frontmatter.split(/\r?\n/)) {
      const kv = /^(\w[\w-]*):\s*(.*)$/.exec(line);
      if (!kv) continue;
      const key = kv[1].toLowerCase();
      const value = kv[2].trim().replace(/^["']|["']$/g, "");
      if (key === "name" && !name) name = value;
      if (key === "description" && !description) description = value;
    }
  }
  return { name: name ?? fallbackName, description, body: body.replace(/^\r?\n/, "") };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function bundledSkillRoots(): string[] {
  // Prefer roots that actually exist and contain at least one <skill>/SKILL.md.
  const candidates = getAdeAgentSkillRootCandidates({ includeDeepSourceFallbacks: true });
  const existing: string[] = [];
  for (const root of candidates) {
    try {
      if (!fs.statSync(root).isDirectory()) continue;
    } catch {
      continue;
    }
    existing.push(root);
  }
  return existing;
}

function readSkillEntries(): SkillEntry[] {
  const roots = bundledSkillRoots();
  const byName = new Map<string, SkillEntry>();
  for (const root of roots) {
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      const skillPath = path.join(root, dirent.name, "SKILL.md");
      let content: string;
      try {
        content = fs.readFileSync(skillPath, "utf8");
      } catch {
        continue;
      }
      const parsed = parseSkillFile(content, dirent.name);
      const name = parsed.name ?? dirent.name;
      // De-dupe by name: first root wins (candidate order = bundled preference).
      if (byName.has(name)) continue;
      byName.set(name, {
        name,
        description: parsed.description,
        content,
        path: skillPath,
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

type OutputFormat = "json" | "text";

function extractFormat(args: string[]): { format: OutputFormat; rest: string[] } {
  let format: OutputFormat = "json";
  const rest: string[] = [];
  for (const arg of args) {
    if (arg === "--text") {
      format = "text";
      continue;
    }
    if (arg === "--json") {
      format = "json";
      continue;
    }
    rest.push(arg);
  }
  return { format, rest };
}

export function runSkillCommand(rest: string[]): SkillCliResult {
  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") {
    return { output: `${HELP_SKILL}\n`, exitCode: 0 };
  }
  const [verb, ...verbArgs] = rest;
  switch (verb) {
    case "list":
      return runSkillList(verbArgs);
    case "show":
      return runSkillShow(verbArgs);
    default:
      throw new CliSkillUsageError(
        `Unknown skill subcommand: ${verb}. Try 'ade skill list' or 'ade skill show <name>'.`,
      );
  }
}

export function runSkillList(args: string[]): SkillCliResult {
  const { format } = extractFormat(args);
  const entries = readSkillEntries();
  if (format === "text") {
    if (entries.length === 0) {
      return { output: "No bundled agent skills found.\n", exitCode: 0 };
    }
    const lines = entries.map((entry) =>
      entry.description ? `${entry.name} — ${entry.description}` : entry.name,
    );
    return { output: `${lines.join("\n")}\n`, exitCode: 0 };
  }
  const json = entries.map((entry) => ({
    name: entry.name,
    description: entry.description,
    path: entry.path,
  }));
  return { output: `${JSON.stringify(json, null, 2)}\n`, exitCode: 0 };
}

export function runSkillShow(args: string[]): SkillCliResult {
  const { format, rest } = extractFormat(args);
  const name = rest[0];
  if (!name) {
    throw new CliSkillUsageError("ade skill show <name> [--text|--json]");
  }
  const entries = readSkillEntries();
  const entry = entries.find((candidate) => candidate.name === name);
  if (!entry) {
    const available = entries.map((candidate) => candidate.name).join(", ") || "(none found)";
    throw new CliSkillUsageError(
      `Unknown skill: ${name}. Available skills: ${available}.`,
    );
  }
  if (format === "text") {
    const parsed = parseSkillFile(entry.content, entry.name);
    return { output: `${parsed.body.replace(/\r?\n$/, "")}\n`, exitCode: 0 };
  }
  const json = {
    name: entry.name,
    description: entry.description,
    content: entry.content,
    path: entry.path,
  };
  return { output: `${JSON.stringify(json, null, 2)}\n`, exitCode: 0 };
}

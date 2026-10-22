// ---------------------------------------------------------------------------
// Local (non-RPC) CLI command for available agent skills.
//
//   ade skill list [--text|--json]
//   ade skill show <name> [--text|--json]
//
// This catalog works headless without the runtime daemon. ADE MCP calls hide
// personal skills so a remote app sees only project and ADE-provided skills.
// ---------------------------------------------------------------------------

import {
  isRemoteMcpInvocation,
  listAgentSkills,
  readAgentSkill,
} from "../services/skills/agentSkillCatalogService";

export class CliSkillUsageError extends Error {}

export type SkillCliResult = {
  output: string;
  exitCode: number;
};

const HELP_SKILL = [
  "Usage:",
  "  ade skill list [--text|--json]        List available agent skills",
  "  ade skill show <name> [--text|--json] Show a skill's SKILL.md",
  "",
  "  Lists project, user, and ADE skills without a runtime daemon. JSON output",
  "  is the default; pass --text for human-readable output.",
].join("\n");

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

/** A skill folder ADE could not read is named on stderr, so a short list is not a silent one. */
function warnUnreadable(filePath: string, error: unknown): void {
  const code = (error as NodeJS.ErrnoException | null)?.code ?? (error instanceof Error ? error.message : String(error));
  process.stderr.write(`ade: could not read ${filePath} (${code})\n`);
}

export function runSkillList(args: string[]): SkillCliResult {
  const { format } = extractFormat(args);
  const entries = listAgentSkills({
    cwd: process.cwd(),
    includeUser: !isRemoteMcpInvocation(process.env),
    env: process.env,
    onError: warnUnreadable,
  });
  if (format === "text") {
    if (entries.length === 0) {
      return { output: "No agent skills found.\n", exitCode: 0 };
    }
    const lines = entries.map((entry) =>
      entry.description
        ? `${entry.name} [${entry.source}] — ${entry.description}`
        : `${entry.name} [${entry.source}]`,
    );
    return { output: `${lines.join("\n")}\n`, exitCode: 0 };
  }
  const json = entries.map((entry) => ({
    name: entry.name,
    description: entry.description,
    path: entry.path,
    source: entry.source,
  }));
  return { output: `${JSON.stringify(json, null, 2)}\n`, exitCode: 0 };
}

export function runSkillShow(args: string[]): SkillCliResult {
  const { format, rest } = extractFormat(args);
  const name = rest[0];
  if (!name) {
    throw new CliSkillUsageError("ade skill show <name> [--text|--json]");
  }
  const includeUser = !isRemoteMcpInvocation(process.env);
  const skill = readAgentSkill(name, { cwd: process.cwd(), includeUser, env: process.env, onError: warnUnreadable });
  if (!skill) {
    if (!includeUser) {
      const personalSkill = readAgentSkill(name, { cwd: process.cwd(), includeUser: true, env: process.env });
      if (personalSkill?.entry.source === "user") {
        throw new CliSkillUsageError(
          `${personalSkill.entry.name} is a personal skill on this computer and is not available through ADE MCP.`,
        );
      }
    }
    const entries = listAgentSkills({ cwd: process.cwd(), includeUser, env: process.env, onError: warnUnreadable });
    const available = entries.map((candidate) => candidate.name).join(", ") || "(none found)";
    throw new CliSkillUsageError(
      `Unknown skill: ${name}. Available skills: ${available}.`,
    );
  }
  if (format === "text") {
    return { output: `${skill.body.replace(/\r?\n$/, "")}\n`, exitCode: 0 };
  }
  const json = {
    name: skill.entry.name,
    description: skill.entry.description,
    content: skill.content,
    path: skill.entry.path,
    source: skill.entry.source,
  };
  return { output: `${JSON.stringify(json, null, 2)}\n`, exitCode: 0 };
}

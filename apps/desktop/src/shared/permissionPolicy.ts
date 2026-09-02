import path from "node:path";

// `PermissionPolicyPlatform` is the flavor `"posix" | "win32"`, never
// `"darwin"`, so a `sandboxRoot` comparison does not fold case on macOS.
// `foldsCase` in `pathContainment.ts` states why that is the safe direction
// for a check that grants.
import { pathIsWithinRoot } from "./pathContainment";
import type { AgentChatPermissionPolicy } from "./types/chat";

/**
 * The structured tool-permission policy an embedder supplies at create time.
 *
 * Everything here is pure. The engine evaluates the policy inside the provider
 * adapters (Claude's `canUseTool`, Codex's three approval handlers), and the
 * SDK documents the same rules, so the rules live in one module both sides can
 * read rather than in a provider branch.
 *
 * Two vocabularies meet here. The policy names tools in a provider-neutral form
 * (`mcp:<server>:<tool>`), because an embedder writes its policy once and runs
 * it on whichever provider the user picked. Claude spells the same tool
 * `mcp__<server>__<tool>`. `parseMcpToolName` is the only place either spelling
 * is taken apart; `neutralToolNameToClaude` and `claudeToolNameToNeutral` are
 * the only two that put one back together.
 *
 * Matching a built-in tool name is a different case, and deliberately weaker:
 * built-in names are provider-specific, so a pattern like `Bash` matches
 * Claude's `Bash` and matches nothing on a provider that has no such tool. The
 * match is case-insensitive with an optional trailing `*` for a prefix, and
 * nothing more. It never inspects the tool's arguments, and it never infers
 * risk from a substring — that inference is the bug this module exists to
 * replace (a read-only `list_agents` prompted because its name contains
 * "agent", while a destructive `delete_project` did not).
 */

export type PermissionPolicyDecision = "allow" | "deny" | "ask";

/** Which path flavor `sandboxRoot` containment uses. Injected so tests can assert both. */
export type PermissionPolicyPlatform = "posix" | "win32";

export type EvaluatePermissionPolicyInput = {
  /** The tool name exactly as the provider reports it. */
  toolName: string;
  /** The provider that raised the request. Selects the tool-name dialect. */
  provider: string;
  /** Working directory of a command, when the request is a command execution. */
  cwd?: string | null;
  /** Paths a file write or command would touch. */
  paths?: readonly (string | null | undefined)[];
  /** Defaults to the host platform. */
  platform?: PermissionPolicyPlatform;
};

const MAX_POLICY_ENTRIES = 256;

function defaultPlatform(): PermissionPolicyPlatform {
  return process.platform === "win32" ? "win32" : "posix";
}

function pathApi(platform: PermissionPolicyPlatform): typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

function normalizeStringList(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    if (out.includes(trimmed)) continue;
    out.push(trimmed);
    if (out.length >= MAX_POLICY_ENTRIES) break;
  }
  return out.length > 0 ? out : null;
}

/**
 * Accepts an untrusted value off the wire and returns a policy or null.
 *
 * Returns null rather than throwing so a create path can treat "no policy" and
 * "an unusable policy" the same way: both mean the legacy behavior. A caller
 * that wants a hard refusal checks the input itself before calling this.
 *
 * `fallback` is required, and a `sandboxRoot` that is not absolute is dropped
 * rather than silently reinterpreted against some current directory — a
 * containment root resolved from a relative path is a containment root nobody
 * chose.
 */
export function normalizePermissionPolicy(
  value: unknown,
  options: { platform?: PermissionPolicyPlatform } = {},
): AgentChatPermissionPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const fallback = record.fallback;
  if (fallback !== "ask" && fallback !== "deny") return null;

  const allowedTools = normalizeStringList(record.allowedTools);
  const deniedTools = normalizeStringList(record.deniedTools);
  const autoApproveMcpServers = normalizeStringList(record.autoApproveMcpServers);

  const platform = options.platform ?? defaultPlatform();
  const api = pathApi(platform);
  let sandboxRoot: string | null = null;
  if (typeof record.sandboxRoot === "string") {
    const trimmed = record.sandboxRoot.trim();
    if (trimmed.length > 0 && !trimmed.startsWith("~") && api.isAbsolute(trimmed)) {
      sandboxRoot = api.normalize(trimmed);
    }
  }

  return {
    ...(allowedTools ? { allowedTools } : {}),
    ...(deniedTools ? { deniedTools } : {}),
    ...(autoApproveMcpServers ? { autoApproveMcpServers } : {}),
    ...(sandboxRoot ? { sandboxRoot } : {}),
    fallback,
  };
}

/**
 * The one parser for a namespaced MCP tool name, in either spelling.
 *
 * Accepts `mcp:<server>:<tool>` and `mcp__<server>__<tool>` and returns their
 * two parts, or null for anything else — a built-in name such as `Bash`, a
 * prefix with no separator, an empty half.
 *
 * The rule that matters is stated here and only here: the server is the segment
 * up to the FIRST separator after the prefix, and everything after it is the
 * tool. A tool name may itself contain `__` while a server name may not, so
 * splitting on the last separator, or on all of them, renames the tool. Four
 * functions used to re-implement this; now they read it.
 */
function parseMcpToolName(name: string): { server: string; tool: string } | null {
  const trimmed = name.trim();
  const lower = trimmed.toLowerCase();
  const form = lower.startsWith("mcp__")
    ? { prefix: "mcp__".length, separator: "__" }
    : lower.startsWith("mcp:")
      ? { prefix: "mcp:".length, separator: ":" }
      : null;
  if (!form) return null;
  const rest = trimmed.slice(form.prefix);
  const at = rest.indexOf(form.separator);
  if (at <= 0) return null;
  const server = rest.slice(0, at);
  const tool = rest.slice(at + form.separator.length);
  if (server.length === 0 || tool.length === 0) return null;
  return { server, tool };
}

/**
 * `mcp:<server>:<tool>` → `mcp__<server>__<tool>`.
 *
 * A name that is not in an MCP form comes back untouched, so a built-in name
 * such as `Bash` passes straight through. So does a name already in Claude's
 * spelling, which round-trips to itself.
 */
export function neutralToolNameToClaude(name: string): string {
  const trimmed = name.trim();
  if (trimmed.toLowerCase().startsWith("mcp__")) return trimmed;
  const parsed = parseMcpToolName(trimmed);
  return parsed ? `mcp__${parsed.server}__${parsed.tool}` : trimmed;
}

/**
 * `mcp__<server>__<tool>` → `mcp:<server>:<tool>`.
 *
 * The inverse, with the same pass-through rule.
 */
export function claudeToolNameToNeutral(name: string): string {
  const trimmed = name.trim();
  if (!trimmed.toLowerCase().startsWith("mcp__")) return trimmed;
  const parsed = parseMcpToolName(trimmed);
  return parsed ? `mcp:${parsed.server}:${parsed.tool}` : trimmed;
}

/**
 * Case-insensitive equality, or a prefix match when the pattern ends in `*`.
 *
 * A bare `*` matches every name. The comparison is literal otherwise: no
 * substring containment, no regular expression, no normalization of separators.
 */
export function toolNameMatchesPattern(toolName: string, pattern: string): boolean {
  const name = toolName.trim().toLowerCase();
  const rule = pattern.trim().toLowerCase();
  if (rule.length === 0) return false;
  if (rule.endsWith("*")) return name.startsWith(rule.slice(0, -1));
  return name === rule;
}

/** Both spellings of one tool name, so a pattern written either way matches. */
function toolNameAliases(toolName: string): string[] {
  const trimmed = toolName.trim();
  const aliases = [trimmed];
  const neutral = claudeToolNameToNeutral(trimmed);
  if (neutral !== trimmed) aliases.push(neutral);
  const claude = neutralToolNameToClaude(trimmed);
  if (claude !== trimmed && !aliases.includes(claude)) aliases.push(claude);
  return aliases;
}

function matchesAnyPattern(toolName: string, patterns: readonly string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  const aliases = toolNameAliases(toolName);
  for (const pattern of patterns) {
    const patternAliases = toolNameAliases(pattern);
    for (const alias of aliases) {
      for (const patternAlias of patternAliases) {
        if (toolNameMatchesPattern(alias, patternAlias)) return true;
      }
    }
  }
  return false;
}

function serverOfToolName(toolName: string): string | null {
  return parseMcpToolName(toolName)?.server ?? null;
}

/**
 * The one decision function. Precedence, highest first:
 *
 * 1. `deniedTools` — an explicit refusal is never overridden.
 * 2. `allowedTools` and `autoApproveMcpServers`.
 * 3. `sandboxRoot` containment, and only when the request actually names a
 *    path or a working directory. A tool that touches no path cannot be judged
 *    by a directory, so it falls through instead of being allowed by accident.
 *    A relative path is judged against the request's own `cwd`, and falls
 *    through when there is none.
 * 4. `fallback`.
 */
export function evaluatePermissionPolicy(
  policy: AgentChatPermissionPolicy,
  input: EvaluatePermissionPolicyInput,
): PermissionPolicyDecision {
  const toolName = input.toolName.trim();
  if (matchesAnyPattern(toolName, policy.deniedTools)) return "deny";
  if (matchesAnyPattern(toolName, policy.allowedTools)) return "allow";

  const server = serverOfToolName(toolName);
  if (server && policy.autoApproveMcpServers?.length) {
    const wanted = server.toLowerCase();
    for (const entry of policy.autoApproveMcpServers) {
      if (entry.trim().toLowerCase() === wanted) return "allow";
    }
  }

  const sandboxRoot = policy.sandboxRoot;
  if (sandboxRoot) {
    const platform = input.platform ?? defaultPlatform();
    const candidates: string[] = [];
    for (const candidate of input.paths ?? []) {
      if (typeof candidate === "string" && candidate.trim().length > 0) candidates.push(candidate.trim());
    }
    if (typeof input.cwd === "string" && input.cwd.trim().length > 0) candidates.push(input.cwd.trim());
    if (candidates.length > 0) {
      // The base for a relative candidate is the request's own `cwd`, which is
      // what the provider resolves it against. Without one a relative path is
      // not contained by anything this module can name.
      const base = typeof input.cwd === "string" && input.cwd.trim().length > 0 ? input.cwd.trim() : null;
      const allInside = candidates.every((candidate) =>
        pathIsWithinRoot(sandboxRoot, candidate, platform, base));
      if (allInside) return "allow";
    }
  }

  return policy.fallback === "deny" ? "deny" : "ask";
}

/**
 * Translates the policy into the two tool lists the Claude Agent SDK accepts.
 *
 * Claude's lists take exact tool names, plus `mcp__<server>` for a whole
 * server. They have no wildcard for a built-in name, so a pattern such as
 * `Edit*` is deliberately left OUT of both lists: `canUseTool` evaluates the
 * full policy on every call it sees, and a tool that reaches it is decided
 * correctly there. Emitting a truncated `Edit` instead would allow or deny one
 * exact tool the embedder never named.
 */
export function policyToClaudeToolLists(
  policy: AgentChatPermissionPolicy,
): { allowedTools: string[]; disallowedTools: string[] } {
  const allowedTools = translateForClaude(policy.allowedTools);
  for (const server of policy.autoApproveMcpServers ?? []) {
    const trimmed = server.trim();
    if (trimmed.length === 0) continue;
    const entry = `mcp__${trimmed}`;
    if (!allowedTools.includes(entry)) allowedTools.push(entry);
  }
  const disallowedTools = translateForClaude(policy.deniedTools);
  // Under `fallback: "deny"` the two lists are the whole enforcement. The
  // Agent SDK removes a disallowed tool from the model's catalog outright,
  // which holds whether or not the SDK ever calls back into `canUseTool`, and
  // on the machines we measured it does not call back at all. So a deny
  // fallback cannot be left to the prompt path: every mutating built-in the
  // policy did not name is denied up front.
  //
  // Only an explicit `allowedTools` entry rescues one. `sandboxRoot` cannot,
  // because containment is decided per call against a path, and there is no
  // per-call hook to decide it in. Denying is the only answer that is actually
  // enforced, and a `sandboxRoot` that quietly did nothing would be worse.
  if (policy.fallback === "deny") {
    for (const tool of CLAUDE_MUTATING_BUILTIN_TOOLS) {
      if (matchesAnyPattern(tool, policy.allowedTools)) continue;
      if (!disallowedTools.includes(tool)) disallowedTools.push(tool);
    }
  }
  return { allowedTools, disallowedTools };
}

/**
 * Claude's own built-in tools that write, run commands, or spawn work.
 *
 * A literal, exhaustive list, matched by exact name. It is the denial set for
 * `fallback: "deny"`, so it is deliberately a fixed roster rather than a
 * pattern: a substring rule would deny a host tool whose name merely contains
 * "edit", which is the bug this whole module replaces.
 *
 * Claude's read-only built-ins (`CLAUDE_READ_ONLY_TOOLS` in the chat service)
 * are deliberately NOT here. A deny fallback removes the agent's ability to
 * change anything; it does not need to blind it.
 */
export const CLAUDE_MUTATING_BUILTIN_TOOLS = [
  "Bash",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Agent",
  "Task",
  "KillShell",
] as const;

/**
 * Servers a policy admits ONLY by naming one of their tools.
 *
 * This is a hole, not a feature, and it exists because the two enforcement
 * surfaces have different resolutions. `allowManagedMcpServersOnly` is
 * per-server: to let `mcp:srv:search` run at all, the whole of `srv` has to be
 * reachable. Per-tool refusal would have to come from `canUseTool`, and on
 * Claude that does not fire. So under `fallback: "deny"` an entry naming one
 * tool of a server silently admits every other tool of it.
 *
 * A server also named by a whole-server form is not listed: allowing all of it
 * was the stated intent there, so nothing is unexpected.
 *
 * The capability report downgrades to "best-effort" when this is non-empty
 * rather than claiming a refusal that does not happen.
 */
export function policyToolLevelMcpServers(policy: AgentChatPermissionPolicy): string[] {
  const wholeServer = new Set<string>();
  for (const server of policy.autoApproveMcpServers ?? []) {
    const trimmed = server.trim().toLowerCase();
    if (trimmed) wholeServer.add(trimmed);
  }
  for (const entry of policy.allowedTools ?? []) {
    if (!mcpEntryNamesWholeServer(entry)) continue;
    const server = serverOfToolName(entry)?.toLowerCase();
    if (server) wholeServer.add(server);
  }
  const partial: string[] = [];
  for (const entry of policy.allowedTools ?? []) {
    if (mcpEntryNamesWholeServer(entry)) continue;
    const server = serverOfToolName(entry);
    if (!server) continue;
    const folded = server.toLowerCase();
    if (wholeServer.has(folded)) continue;
    if (partial.some((existing) => existing.toLowerCase() === folded)) continue;
    partial.push(server);
  }
  return partial;
}

/** `mcp:<server>:*` and `mcp__<server>__*` name a whole server; anything else names one tool. */
function mcpEntryNamesWholeServer(entry: string): boolean {
  return parseMcpToolName(entry)?.tool.trim() === "*";
}

/**
 * The MCP servers a policy names, in the order it names them.
 *
 * Reads `autoApproveMcpServers` plus every `mcp:<server>:<tool>` and
 * `mcp:<server>:*` entry in `allowedTools`, in either spelling. This is what
 * `allowManagedMcpServersOnly` is given, so a server absent from the result is
 * a server the session cannot reach at all.
 */
export function policyAllowedMcpServers(policy: AgentChatPermissionPolicy): string[] {
  const servers: string[] = [];
  const push = (name: string | null): void => {
    const trimmed = name?.trim();
    if (!trimmed) return;
    if (servers.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) return;
    servers.push(trimmed);
  };
  for (const server of policy.autoApproveMcpServers ?? []) push(server);
  for (const entry of policy.allowedTools ?? []) push(serverOfToolName(entry));
  return servers;
}

function translateForClaude(patterns: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const pattern of patterns ?? []) {
    const trimmed = pattern.trim();
    if (trimmed.length === 0) continue;
    const claude = neutralToolNameToClaude(trimmed);
    if (!claude.endsWith("*")) {
      if (!out.includes(claude)) out.push(claude);
      continue;
    }
    // `mcp__server__*` is the only wildcard Claude can express, and it spells
    // it as the bare server name.
    if (claude.toLowerCase().startsWith("mcp__") && claude.endsWith("__*")) {
      const entry = claude.slice(0, -"__*".length);
      if (!out.includes(entry)) out.push(entry);
    }
  }
  return out;
}

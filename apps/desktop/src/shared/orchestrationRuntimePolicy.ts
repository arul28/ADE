import type {
  AgentChatClaudePermissionMode,
  AgentChatCodexApprovalPolicy,
  AgentChatCodexConfigSource,
  AgentChatCodexSandbox,
  AgentChatCreateArgs,
  AgentChatDroidPermissionMode,
  AgentChatInteractionMode,
  AgentChatOpenCodePermissionMode,
  AgentChatPermissionMode,
  AgentChatProvider,
} from "./types";
import type { OrchestrationRole } from "./types/orchestration";

export type OrchestrationInteractionMode = Extract<
  AgentChatInteractionMode,
  "orchestrator-lead" | "orchestrator-worker" | "orchestrator-validator"
>;

export type OrchestrationRuntimeSessionRef = {
  interactionMode?: AgentChatInteractionMode | null;
  orchestrationRole?: OrchestrationRole | null;
};

export type OrchestrationPermissionProfile = Partial<Pick<
  AgentChatCreateArgs,
  | "claudePermissionMode"
  | "codexApprovalPolicy"
  | "codexSandbox"
  | "codexConfigSource"
  | "cursorModeId"
  | "droidPermissionMode"
  | "opencodePermissionMode"
>>;

export const ORCHESTRATION_LOCKED_PERMISSION_MODE = "full-auto" satisfies AgentChatPermissionMode;

// ---------------------------------------------------------------------------
// Orchestrator-lead provider-native tool denials
//
// The lead plans and delegates; it never mutates code or runs mutating shell.
// ADE's own orchestration toolset already withholds editFile/writeFile/bash from leads, but that
// toolset is *additive* — it rides alongside each provider's built-in tools.
// So every provider needs its own denial expressed in that provider's native
// mechanism. All of those definitions live here so the lead's blast radius is
// reviewable in one place.
// ---------------------------------------------------------------------------

/** Claude Agent SDK tool names — enforced via `canUseTool` + `disallowedTools`. */
export const ORCHESTRATION_LEAD_DENIED_CLAUDE_TOOLS = [
  "Agent",
  "Bash",
  "Edit",
  "MultiEdit",
  "Task",
  "TodoRead",
  "TodoWrite",
  "Write",
  "NotebookEdit",
] as const;

/**
 * OpenCode built-in tool ids — enforced via the `tools` map on
 * `session.prompt` (`{ [toolName]: false }` withholds the tool from the model).
 */
export const ORCHESTRATION_LEAD_DENIED_OPENCODE_TOOLS = [
  "bash",
  "edit",
  "write",
  "patch",
  "multiedit",
  "task",
  "todowrite",
  "todoread",
] as const;

/** Spread-ready OpenCode `tools` selection that withholds every denied tool. */
export function orchestrationLeadOpenCodeToolSelection(): Record<string, boolean> {
  const selection: Record<string, boolean> = {};
  for (const name of ORCHESTRATION_LEAD_DENIED_OPENCODE_TOOLS) selection[name] = false;
  return selection;
}

/** Droid tool categories (`ListToolsResult.tools[].category`) withheld from leads. */
export const ORCHESTRATION_LEAD_DENIED_DROID_TOOL_CATEGORIES = ["edit", "execute"] as const;

export type DroidToolCategory = "read" | "edit" | "execute" | "other";

/**
 * Cursor tool-call risk classes a lead may use. Cursor's SDK has no tool
 * allow/deny list, so the denial is enforced in ADE's own hook evaluator
 * (`evaluateCursorSdkHook`), which classifies every tool call by risk. Leads
 * are allow-listed rather than deny-listed so an unrecognised tool name
 * (risk `"unknown"`) fails closed.
 */
export const ORCHESTRATION_LEAD_ALLOWED_CURSOR_TOOL_RISKS = ["read"] as const;

/**
 * Codex has no tool allow/deny knob: the pinned app-server protocol
 * (`ThreadStartParams`) exposes no tools field, and the `tools` config table
 * only covers `web_search` / `experimental_request_user_input`. Its sandbox is
 * the only enforcement point, so leads run threads read-only with approvals
 * off (so the lead cannot escalate a write through an approval prompt).
 */
export const ORCHESTRATION_LEAD_CODEX_POLICY = {
  approvalPolicy: "never" satisfies AgentChatCodexApprovalPolicy,
  sandbox: "read-only" satisfies AgentChatCodexSandbox,
} as const;

// ---------------------------------------------------------------------------
// Orchestrator-lead MCP isolation
//
// The tool denials above only cover each provider's *built-in* tools. A
// user-configured MCP server (filesystem, shell, git, …) hands the same
// capability back through a different door, so a lead must see ADE-managed MCP
// servers only. Every provider that receives MCP configuration is registered
// below with the mechanism it is isolated by — a provider added to ADE without
// an entry here is a compile error, not a silent hole.
// ---------------------------------------------------------------------------

export type OrchestrationLeadMcpIsolation = {
  /** How user/project MCP servers are withheld from a lead on this provider. */
  mechanism: string;
  /** False when no mechanism exists — the residual hole is described in `note`. */
  gated: boolean;
  note: string;
};

export type McpCapableProvider = "claude" | "codex" | "cursor" | "droid" | "opencode";

export const ORCHESTRATION_LEAD_MCP_ISOLATION = {
  claude: {
    mechanism: "strictMcpConfig + managedSettings.allowManagedMcpServersOnly",
    gated: true,
    note:
      "strictMcpConfig makes the Agent SDK ignore ~/.claude.json and project .mcp.json even though "
      + "settingSources still loads the user's rules/commands; the programmatic ADE server stays.",
  },
  codex: {
    mechanism: "thread config override: mcp_servers.<name>.enabled = false",
    gated: true,
    note:
      "Codex merges the thread `config` overlay into config.toml rather than replacing it "
      + "(verified against codex-cli: `-c mcp_servers={}` is a no-op, `-c mcp_servers.x.enabled=false` "
      + "disables x), so ADE enumerates the configured servers and disables each one. Codex leads "
      + "receive no ADE-managed MCP server at all — their ADE tools ride the app-server dynamicTools "
      + "channel — so the lead's MCP surface is empty. Residual: a server contributed by a Codex "
      + "*plugin* is not listed in config.toml's mcp_servers table and cannot be enumerated.",
  },
  cursor: {
    mechanism: "local.settingSources (project + plugin layers dropped)",
    gated: true,
    note:
      "The Cursor SDK derives includeProjectMcp/includePluginMcp from settingSources, so dropping "
      + "those layers drops their MCP servers while `mcpServers` (ADE's inline lease) is unaffected. "
      + "The `user` layer must stay: ADE's own preToolUse tool-gate hook is a user-layer artifact "
      + "(~/.cursor/hooks.json) and is the enforcement point for every Cursor lead denial. Residual: "
      + "user-level MCP servers still load, but their calls reach the gate as `MCP:<tool>`, classify "
      + "as risk `unknown`, and are denied by the fail-closed allow-list above.",
  },
  droid: {
    mechanism: "session.listMcpTools + session-scoped toggleMcpTool",
    gated: true,
    note:
      "Droid's `disabledToolIds` covers the exec tool catalog only, so ADE enumerates the live MCP "
      + "tool list and uses the low-level session-scoped `toggleMcpTool` RPC to disable every tool "
      + "whose server is not an ADE lease. This does not call `toggleMcpServer`, whose SDK request "
      + "pins settingsLevel: User and would mutate the user's global config.",
  },
  opencode: {
    mechanism: "dedicated lead server + ADE-authored config + OPENCODE_DISABLE_PROJECT_CONFIG",
    gated: true,
    note:
      "Only an orchestrator lead gets a dedicated OpenCode server with an ADE-owned XDG_CONFIG_HOME, "
      + "OPENCODE_CONFIG_CONTENT built by buildOpenCodeConfig, and OPENCODE_DISABLE_PROJECT_CONFIG=1. "
      + "Ordinary chats and workers keep the user's normal OpenCode config and MCP layers.",
  },
} as const satisfies Record<McpCapableProvider, OrchestrationLeadMcpIsolation>;

export function orchestrationLeadMcpIsolation(
  provider: AgentChatProvider | string,
): OrchestrationLeadMcpIsolation | null {
  return (ORCHESTRATION_LEAD_MCP_ISOLATION as Record<string, OrchestrationLeadMcpIsolation>)[provider]
    ?? null;
}

/**
 * Cursor setting layers a lead may load. `project` and `plugins` are dropped
 * (they carry MCP servers); `user` stays because ADE's tool-gate hook lives
 * there, and `team`/`mdm` stay because they only ever *restrict*.
 */
export const ORCHESTRATION_LEAD_CURSOR_SETTING_SOURCES = ["user", "team", "mdm"] as const;

/**
 * Extracts the server names declared under Codex's `mcp_servers` config table.
 *
 * Codex has no "managed servers only" switch; the only per-server knob is
 * `mcp_servers.<name>.enabled`, so a lead's isolation is expressed as an
 * explicit `enabled = false` for every configured server. Handles the three
 * shapes `config.toml` can use: `[mcp_servers.name]` headers, dotted
 * `mcp_servers.name.key = …` assignments, and single- or multi-line inline
 * `mcp_servers = { name = { … } }` tables.
 */
export function codexConfiguredMcpServerNames(configText: string): string[] {
  const names: string[] = [];
  const add = (raw: string): void => {
    const name = raw.trim().replace(/^["']|["']$/g, "").trim();
    if (!name || names.includes(name)) return;
    names.push(name);
  };
  const firstSegment = (path: string): string | null => {
    const trimmed = path.trim();
    if (trimmed.startsWith("\"") || trimmed.startsWith("'")) {
      const quote = trimmed[0]!;
      const end = trimmed.indexOf(quote, 1);
      return end > 0 ? trimmed.slice(1, end) : null;
    }
    const segment = trimmed.split(".")[0]?.trim() ?? "";
    return segment.length ? segment : null;
  };

  const normalizedConfig = configText.replace(/\r\n?/g, "\n");
  const inlineAssignment = /^\s*mcp_servers\s*=\s*\{/gm;
  let inlineMatch: RegExpExecArray | null;
  while ((inlineMatch = inlineAssignment.exec(normalizedConfig)) !== null) {
    const openBrace = normalizedConfig.indexOf("{", inlineMatch.index);
    const closeBrace = findTomlInlineTableEnd(normalizedConfig, openBrace);
    if (openBrace < 0 || closeBrace < 0) continue;
    for (const key of inlineTableKeys(stripTomlComments(
      normalizedConfig.slice(openBrace + 1, closeBrace),
    ))) add(key);
    inlineAssignment.lastIndex = closeBrace + 1;
  }

  for (const line of normalizedConfig.split("\n")) {
    const withoutComment = line.replace(/^\s*#.*$/, "").trim();
    if (!withoutComment.length) continue;

    const header = withoutComment.match(/^\[\[?\s*mcp_servers\s*\.\s*(.+?)\s*\]\]?$/)?.[1];
    if (header) {
      const segment = firstSegment(header);
      if (segment) add(segment);
      continue;
    }

    const dotted = withoutComment.match(/^mcp_servers\s*\.\s*(.+?)\s*=/)?.[1];
    if (dotted) {
      const segment = firstSegment(dotted);
      if (segment) add(segment);
      continue;
    }

    const inline = withoutComment.match(/^mcp_servers\s*=\s*\{(.*)\}\s*$/)?.[1];
    if (inline !== undefined) {
      for (const key of inlineTableKeys(stripTomlComments(inline))) add(key);
    }
  }
  return names;
}

function stripTomlComments(text: string): string {
  let output = "";
  let quote: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote) {
      output += char;
      if (quote === '"' && char === "\\") {
        const next = text[index + 1];
        if (next !== undefined) output += next;
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      output += char;
    } else if (char === "#") {
      while (index < text.length && text[index] !== "\n") index += 1;
      if (index < text.length) output += "\n";
    } else {
      output += char;
    }
  }
  return output;
}

function findTomlInlineTableEnd(text: string, openBrace: number): number {
  if (openBrace < 0) return -1;
  let depth = 0;
  let quote: string | null = null;
  for (let index = openBrace; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote) {
      if (quote === '"' && char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#") {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Top-level `key =` names of a single-line TOML inline table body. */
function inlineTableKeys(body: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let token = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (quote) {
      if (char === quote && body[index - 1] !== "\\") quote = null;
      else token += char;
      continue;
    }
    if (char === "\"" || char === "'") { quote = char; continue; }
    if (char === "{" || char === "[") { depth += 1; continue; }
    if (char === "}" || char === "]") { depth -= 1; continue; }
    if (depth === 0 && char === "=") {
      const key = token.trim();
      if (key.length) keys.push(key);
      token = "";
      // Skip the value until the next top-level comma.
      let valueDepth = 0;
      let valueQuote: string | null = null;
      index += 1;
      for (; index < body.length; index += 1) {
        const valueChar = body[index]!;
        if (valueQuote) {
          if (valueChar === valueQuote && body[index - 1] !== "\\") valueQuote = null;
          continue;
        }
        if (valueChar === "\"" || valueChar === "'") { valueQuote = valueChar; continue; }
        if (valueChar === "{" || valueChar === "[") { valueDepth += 1; continue; }
        if (valueChar === "}" || valueChar === "]") { valueDepth -= 1; continue; }
        if (valueChar === "," && valueDepth === 0) break;
      }
      continue;
    }
    if (depth === 0) token += char;
  }
  return keys;
}

/**
 * The `mcp_servers` overlay a lead's Codex thread config carries: every
 * user-configured server explicitly switched off.
 */
export function orchestrationLeadCodexMcpOverrides(
  configuredServerNames: readonly string[],
): Record<string, { enabled: false }> {
  const overrides: Record<string, { enabled: false }> = {};
  for (const name of configuredServerNames) {
    const trimmed = name.trim();
    if (trimmed.length) overrides[trimmed] = { enabled: false };
  }
  return overrides;
}

const ORCHESTRATION_INTERACTION_MODE_TO_ROLE: Record<OrchestrationInteractionMode, OrchestrationRole> = {
  "orchestrator-lead": "lead",
  "orchestrator-worker": "worker",
  "orchestrator-validator": "validator",
};

const ORCHESTRATION_ROLE_TO_INTERACTION_MODE: Record<OrchestrationRole, OrchestrationInteractionMode> = {
  lead: "orchestrator-lead",
  worker: "orchestrator-worker",
  validator: "orchestrator-validator",
};

export function isOrchestrationInteractionMode(
  mode: AgentChatInteractionMode | null | undefined,
): mode is OrchestrationInteractionMode {
  return mode === "orchestrator-lead"
    || mode === "orchestrator-worker"
    || mode === "orchestrator-validator";
}

export function orchestrationRoleForInteractionMode(
  mode: OrchestrationInteractionMode,
): OrchestrationRole {
  return ORCHESTRATION_INTERACTION_MODE_TO_ROLE[mode];
}

export function orchestrationInteractionModeForRole(
  role: OrchestrationRole,
): OrchestrationInteractionMode {
  return ORCHESTRATION_ROLE_TO_INTERACTION_MODE[role];
}

export function resolveOrchestrationRole(
  session: OrchestrationRuntimeSessionRef,
): OrchestrationRole | null {
  if (session.orchestrationRole) return session.orchestrationRole;
  return isOrchestrationInteractionMode(session.interactionMode)
    ? orchestrationRoleForInteractionMode(session.interactionMode)
    : null;
}

export function lockedOrchestrationPermissionMode(
  session: OrchestrationRuntimeSessionRef,
): AgentChatPermissionMode | null {
  return resolveOrchestrationRole(session) ? ORCHESTRATION_LOCKED_PERMISSION_MODE : null;
}

export function isOrchestrationLeadSession(
  session: OrchestrationRuntimeSessionRef,
): boolean {
  return resolveOrchestrationRole(session) === "lead";
}

export function effectiveOrchestrationPermissionMode(args: {
  permissionMode?: AgentChatPermissionMode | null;
  orchestrationRole?: OrchestrationRole | null;
  interactionMode?: AgentChatInteractionMode | null;
}): AgentChatPermissionMode {
  return lockedOrchestrationPermissionMode(args) ?? args.permissionMode ?? "default";
}

export function applyOrchestrationPermissionProfile(
  provider: AgentChatProvider | string,
): OrchestrationPermissionProfile {
  switch (provider) {
    case "claude":
      return {
        claudePermissionMode: "bypassPermissions" satisfies AgentChatClaudePermissionMode,
      };
    case "codex":
      return {
        codexSandbox: "danger-full-access" satisfies AgentChatCodexSandbox,
        codexApprovalPolicy: "never" satisfies AgentChatCodexApprovalPolicy,
        codexConfigSource: "flags" satisfies AgentChatCodexConfigSource,
      };
    case "cursor":
      return { cursorModeId: "full-auto" };
    case "droid":
      return {
        droidPermissionMode: "auto-high" satisfies AgentChatDroidPermissionMode,
      };
    case "opencode":
      return {
        opencodePermissionMode: "full-auto" satisfies AgentChatOpenCodePermissionMode,
      };
    default:
      return {};
  }
}

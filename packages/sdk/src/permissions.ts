import path from "node:path";
import { AdeError } from "./errors.js";
import type {
  AdeProvider,
  AgentChatClaudePermissionMode,
  AgentChatCodexApprovalPolicy,
  AgentChatCodexSandbox,
  AgentChatDroidPermissionMode,
  AgentChatOpenCodePermissionMode,
  AgentChatPermissionMode,
} from "./types.js";

/**
 * Create-args this module may emit, typed against the wire unions rather than
 * `Record<string, unknown>`. That is the whole point: a typo like
 * "bypassPermission" or a provider renaming a mode becomes a compile error here
 * instead of a permission silently not applying at runtime — and it keeps the
 * six unions load-bearing rather than decorative.
 */
export type PermissionArgs = {
  permissionMode: AgentChatPermissionMode;
  claudePermissionMode?: AgentChatClaudePermissionMode;
  codexApprovalPolicy?: AgentChatCodexApprovalPolicy;
  codexSandbox?: AgentChatCodexSandbox;
  opencodePermissionMode?: AgentChatOpenCodePermissionMode;
  droidPermissionMode?: AgentChatDroidPermissionMode;
  permissionPolicy?: ThreadPermissionPolicy;
};

export type PermissionPreset = "always-allow" | "default";

/**
 * A per-tool permission policy: the third form of `permissions`, alongside the
 * two presets.
 *
 * Tool names are provider-neutral. `mcp:<server>:<tool>` and `mcp:<server>:*`
 * name an MCP tool and the engine translates them to each provider's own
 * spelling (Claude writes `mcp__server__tool`). Any other string is matched
 * against the provider's own tool name, case-insensitively, with an optional
 * trailing `*` for a prefix match — and built-in tool names ARE
 * provider-specific, so `Bash` means something on Claude and nothing on Pi.
 *
 * Precedence on Claude, highest first:
 *   1. `deniedTools`
 *   2. `allowedTools` and `autoApproveMcpServers`
 *   3. `sandboxRoot` containment, for commands and file writes only
 *   4. `fallback`
 *
 * On Codex only rungs 3 and 4 exist. The three tool fields are Claude-only —
 * nothing on the Codex path reads them — so a Codex decision is `sandboxRoot`
 * containment and then `fallback`, and the command text is never consulted.
 * Read `thread.permissionCapability.residual` rather than assuming a rung.
 *
 * `fallback` is required. A policy with no fallback has no obvious default, and
 * guessing "ask" would silently park the turn for a host that built no approval
 * UI — which is the failure this type exists to remove.
 */
export type ThreadPermissionPolicy = {
  /** Tools that run without asking. Exact names, or a trailing-`*` prefix. */
  allowedTools?: string[];
  /** Tools refused outright, never asked about. Wins over `allowedTools`. */
  deniedTools?: string[];
  /** Every tool of these servers is allowed. Same as `mcp:<server>:*`. */
  autoApproveMcpServers?: string[];
  /**
   * Absolute path. Commands and file writes inside it auto-approve; outside it
   * they follow `fallback`. This is containment, not a jail: see
   * `ThreadOpenOptions.cwd` for the plain working directory.
   */
  sandboxRoot?: string;
  /** What happens to anything the rules above did not match. */
  fallback: "ask" | "deny";
};

/** True for the policy form of `permissions`, false for either preset. */
export function isPermissionPolicy(
  value: PermissionPreset | ThreadPermissionPolicy | undefined,
): value is ThreadPermissionPolicy {
  return typeof value === "object" && value !== null;
}

function normalizeToolList(
  value: unknown,
  field: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new AdeError("invalid_option", `permissions.${field} must be an array of tool names.`);
  }
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new AdeError(
        "invalid_option",
        `permissions.${field} must contain non-empty strings; got ${JSON.stringify(entry)}.`,
      );
    }
    names.push(entry.trim());
  }
  return names;
}

/**
 * Validates a caller's policy and returns the wire form.
 *
 * Rejects rather than repairs: a policy with a typo'd fallback or a relative
 * `sandboxRoot` would otherwise be shipped to the engine and quietly widen the
 * grant, which is the one failure mode a permission surface cannot have.
 */
export function normalizePermissionPolicy(value: ThreadPermissionPolicy): ThreadPermissionPolicy {
  if (typeof value !== "object" || value === null) {
    throw new AdeError("invalid_option", "permissions must be a preset string or a policy object.");
  }
  if (value.fallback !== "ask" && value.fallback !== "deny") {
    throw new AdeError(
      "invalid_option",
      'A permission policy needs `fallback: "ask" | "deny"`. It is required so a host that renders no approval UI has to choose "deny" deliberately rather than inherit a turn that parks forever.',
    );
  }
  const allowedTools = normalizeToolList(value.allowedTools, "allowedTools");
  const deniedTools = normalizeToolList(value.deniedTools, "deniedTools");
  const autoApproveMcpServers = normalizeToolList(
    value.autoApproveMcpServers,
    "autoApproveMcpServers",
  );
  let sandboxRoot: string | undefined;
  if (value.sandboxRoot !== undefined) {
    if (typeof value.sandboxRoot !== "string" || !value.sandboxRoot.trim()) {
      throw new AdeError("invalid_option", "permissions.sandboxRoot must be an absolute path.");
    }
    const trimmed = value.sandboxRoot.trim();
    if (trimmed.startsWith("~") || !path.isAbsolute(trimmed)) {
      throw new AdeError(
        "invalid_option",
        `permissions.sandboxRoot must be an absolute path; "${trimmed}" is not. \`~\` is not expanded.`,
      );
    }
    sandboxRoot = path.resolve(trimmed);
  }
  return {
    ...(allowedTools ? { allowedTools } : {}),
    ...(deniedTools ? { deniedTools } : {}),
    ...(autoApproveMcpServers ? { autoApproveMcpServers } : {}),
    ...(sandboxRoot ? { sandboxRoot } : {}),
    fallback: value.fallback,
  };
}

/**
 * The create args for whichever form of `permissions` the caller used.
 *
 * A policy object sends `permissionMode: "default"` plus the policy: the coarse
 * mode stays the provider's usual one and the policy is what actually decides,
 * so a runtime that ignores `permissionPolicy` behaves exactly like today's
 * `"default"` rather than like `always-allow`.
 */
export function resolvePermissionArgs(
  provider: AdeProvider,
  permissions: PermissionPreset | ThreadPermissionPolicy,
): PermissionArgs {
  if (isPermissionPolicy(permissions)) {
    return {
      permissionMode: "default",
      permissionPolicy: normalizePermissionPolicy(permissions),
    };
  }
  if (permissions !== "always-allow" && permissions !== "default") {
    throw new AdeError(
      "invalid_option",
      `permissions must be "always-allow", "default", or a policy object; got ${JSON.stringify(permissions)}.`,
    );
  }
  return permissionArgs(provider, permissions);
}

/** The server half of a neutral `mcp:<server>:<tool>` name, or null. */
function mcpEntryServer(entry: string): { server: string; tool: string } | null {
  const match = /^mcp:([^:]+):(.+)$/.exec(entry.trim());
  if (!match) return null;
  return { server: match[1]!, tool: match[2]! };
}

/**
 * Supplied MCP servers the policy never names.
 *
 * Only interesting under `fallback: "deny"`, where "not named" means "every
 * tool of this server is refused outright". Injecting a server and then denying
 * all of it is a config mistake with no symptom: the tools are simply never
 * called, and the model reports that it could not do the thing. Naming the
 * servers is cheaper than the support thread.
 *
 * An entry naming a single tool counts as covering the server, because the
 * caller clearly knows the server exists.
 */
export function mcpServersNotCoveredByPolicy(
  policy: ThreadPermissionPolicy,
  serverNames: readonly string[],
): string[] {
  const covered = new Set<string>();
  for (const entry of policy.autoApproveMcpServers ?? []) covered.add(entry.trim());
  for (const entry of policy.allowedTools ?? []) {
    const parsed = mcpEntryServer(entry);
    if (parsed) covered.add(parsed.server);
  }
  return serverNames.filter((name) => !covered.has(name));
}

/**
 * Allowed-tool entries that name one MCP tool rather than a whole server.
 *
 * Worth saying out loud because the granularity does not survive on Claude: the
 * Agent SDK's `allowedTools` admits an MCP entry at server granularity, so
 * naming one tool of a server admits every tool of it. The thread's
 * `permissionCapability.residual` carries the authoritative version.
 */
export function individualMcpToolEntries(policy: ThreadPermissionPolicy): string[] {
  const entries: string[] = [];
  for (const entry of policy.allowedTools ?? []) {
    const parsed = mcpEntryServer(entry);
    if (parsed && parsed.tool !== "*") entries.push(entry.trim());
  }
  return entries;
}

/**
 * Provider-specific create-args for a permission preset.
 *
 * "always-allow" is a single knob at the SDK boundary, but ADE has no single
 * always-allow switch: each adapter names its own full-auto state, and setting
 * only the generic `permissionMode` leaves Claude prompting and Codex sandboxed.
 * The mapping is spelled out per provider rather than inferred, so a new
 * provider is a compile error here instead of a silent half-permissive session.
 *
 * Source of truth for the unions: `apps/desktop/src/shared/types/chat.ts`.
 */
export function permissionArgs(
  provider: AdeProvider,
  preset: PermissionPreset,
): PermissionArgs {
  if (preset === "default") return { permissionMode: "default" };

  switch (provider) {
    case "claude":
      return {
        permissionMode: "full-auto",
        claudePermissionMode: "bypassPermissions",
      };
    case "codex":
      return {
        permissionMode: "full-auto",
        codexApprovalPolicy: "never",
        codexSandbox: "danger-full-access",
      };
    case "opencode":
      return {
        permissionMode: "full-auto",
        opencodePermissionMode: "full-auto",
      };
    case "droid":
      return {
        permissionMode: "full-auto",
        droidPermissionMode: "auto-high",
      };
    case "cursor":
      // Cursor's approval behavior is carried by its mode snapshot, not by a
      // dedicated permission union; the generic full-auto mode is the whole
      // contract the chat service reads for it.
      return { permissionMode: "full-auto" };
    case "pi":
      return { permissionMode: "full-auto" };
  }
}

export const SUPPORTED_PROVIDERS: readonly AdeProvider[] = [
  "claude",
  "codex",
  "cursor",
  "droid",
  "opencode",
  "pi",
];

export function isSupportedProvider(value: string): value is AdeProvider {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(value);
}

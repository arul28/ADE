// ---------------------------------------------------------------------------
// Shared permission mapping utilities
//
// Extracts the mapping logic from agentChatService so both the chat pane
// and the orchestrator/mission system use identical permission semantics.
// ---------------------------------------------------------------------------

import type { AgentChatPermissionMode } from "../../../shared/types/chat";
import type { MissionProviderPermissions, MissionPermissionConfig } from "../../../shared/types/missions";

// ─────────────────────────────────────────────────────
// Chat-pane permission → CLI flag mapping
// ─────────────────────────────────────────────────────

/**
 * Map an AgentChatPermissionMode to the Claude CLI `--permission-mode` value
 * (or `--dangerously-skip-permissions`).
 */
export function mapPermissionToClaude(mode: AgentChatPermissionMode | undefined): "default" | "plan" | "acceptEdits" | "bypassPermissions" {
  if (mode === "full-auto") return "bypassPermissions";
  if (mode === "edit") return "acceptEdits";
  if (mode === "default") return "default";
  return "plan";
}

/**
 * Map an AgentChatPermissionMode to Codex CLI approval-policy + sandbox.
 * Returns null for "config-toml" (let Codex read its own config).
 */
export function mapPermissionToCodex(mode: AgentChatPermissionMode | undefined): {
  approvalPolicy: "untrusted" | "on-request" | "on-failure" | "never";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
} | null {
  if (mode === "full-auto") {
    return { approvalPolicy: "never", sandbox: "danger-full-access" };
  }
  if (mode === "edit") {
    return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
  }
  if (mode === "config-toml") {
    return null;
  }
  if (mode === "default") {
    return { approvalPolicy: "on-request", sandbox: "workspace-write" };
  }
  // "plan" / undefined → read-only browsing mode
  return { approvalPolicy: "on-request", sandbox: "read-only" };
}

/**
 * Map an AgentChatPermissionMode to the OpenCode-backed in-process permission
 * mode string used by the native runtime path.
 *
 * The in-process executor uses `AgentPermissionMode` = "read-only" | "edit" | "full-auto".
 * "plan" and "default" both map to "read-only" (no modifications allowed).
 */
export function mapPermissionToInProcess(mode: AgentChatPermissionMode | undefined): "read-only" | "edit" | "full-auto" {
  if (mode === "full-auto") return "full-auto";
  if (mode === "edit") return "edit";
  // "default", "plan", "config-toml", undefined → read-only
  return "read-only";
}

// ─────────────────────────────────────────────────────
// Old → new normalization (backward compat)
// ─────────────────────────────────────────────────────

/** Valid old CLI modes */
const VALID_CLI_MODES = new Set(["read-only", "edit", "full-auto"]);
/** Valid old in-process modes */
const VALID_IN_PROCESS_MODES = new Set(["plan", "edit", "full-auto"]);
/** Valid new AgentChatPermissionMode values */
const VALID_PROVIDER_MODES = new Set(["default", "plan", "edit", "full-auto", "config-toml"]);

/**
 * Map old CLI mode ("read-only" | "edit" | "full-auto") to AgentChatPermissionMode.
 * "read-only" → "plan" (closest equivalent: suggest but don't change)
 */
function oldCliModeToProvider(mode: string | undefined): AgentChatPermissionMode {
  if (mode === "read-only") return "plan";
  if (mode === "edit") return "edit";
  if (mode === "full-auto") return "full-auto";
  return "full-auto"; // default for CLI workers
}

/**
 * Map old in-process mode ("plan" | "edit" | "full-auto") to AgentChatPermissionMode.
 */
function oldInProcessModeToProvider(mode: string | undefined): AgentChatPermissionMode {
  if (mode === "plan") return "plan";
  if (mode === "edit") return "edit";
  if (mode === "full-auto") return "full-auto";
  return "full-auto"; // default for in-process
}

/**
 * Normalize a MissionPermissionConfig (which may contain old `cli`/`inProcess`
 * fields, new `providers` field, or both) into a canonical MissionProviderPermissions.
 *
 * Precedence: `providers` fields take priority over old `cli`/`inProcess` fields.
 */
export function normalizeMissionPermissions(config: MissionPermissionConfig | undefined): MissionProviderPermissions {
  const result: MissionProviderPermissions = {
    claude: "full-auto",
    codex: "default",
    opencode: "full-auto",
    codexSandbox: "workspace-write",
  };

  // Layer 1: old shape
  if (config?.cli) {
    const cliMode = VALID_CLI_MODES.has(config.cli.mode ?? "") ? config.cli.mode : undefined;
    const asProvider = oldCliModeToProvider(cliMode);
    result.claude = asProvider;
    result.codex = asProvider;
    if (config.cli.sandboxPermissions === "read-only" || config.cli.sandboxPermissions === "workspace-write" || config.cli.sandboxPermissions === "danger-full-access") {
      result.codexSandbox = config.cli.sandboxPermissions;
    }
    if (Array.isArray(config.cli.writablePaths)) {
      result.writablePaths = config.cli.writablePaths.filter((p): p is string => typeof p === "string" && p.trim().length > 0).map(p => p.trim());
    }
    if (Array.isArray(config.cli.allowedTools)) {
      result.allowedTools = config.cli.allowedTools.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map(t => t.trim());
    }
  }
  if (config?.inProcess) {
    const inProcMode = VALID_IN_PROCESS_MODES.has(config.inProcess.mode ?? "") ? config.inProcess.mode : undefined;
    result.opencode = oldInProcessModeToProvider(inProcMode);
  }

  // Layer 2: new provider shape (overrides old shape where present)
  if (config?.providers) {
    const p = config.providers;
    if (p.claude && VALID_PROVIDER_MODES.has(p.claude)) result.claude = p.claude;
    if (p.codex && VALID_PROVIDER_MODES.has(p.codex)) result.codex = p.codex;
    if (p.cursor && VALID_PROVIDER_MODES.has(p.cursor)) result.cursor = p.cursor;
    if (p.opencode && VALID_PROVIDER_MODES.has(p.opencode)) result.opencode = p.opencode;
    if (p.codexSandbox === "read-only" || p.codexSandbox === "workspace-write" || p.codexSandbox === "danger-full-access") {
      result.codexSandbox = p.codexSandbox;
    }
    if (Array.isArray(p.writablePaths) && p.writablePaths.length > 0) {
      result.writablePaths = p.writablePaths.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map(x => x.trim());
    }
    if (Array.isArray(p.allowedTools) && p.allowedTools.length > 0) {
      result.allowedTools = p.allowedTools.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map(x => x.trim());
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────
// Provider permissions → old-style permissionConfig
// (for passing into adapters that still use the old shape)
// ─────────────────────────────────────────────────────

/**
 * Convert AgentChatPermissionMode to old CLI mode.
 * "default" / "plan" → "read-only", "config-toml" → "full-auto" (let CLI decide)
 */
function providerModeToCliMode(mode: AgentChatPermissionMode | undefined): "read-only" | "edit" | "full-auto" {
  if (mode === "full-auto") return "full-auto";
  if (mode === "edit") return "edit";
  if (mode === "default" || mode === "plan") return "read-only";
  if (mode === "config-toml") return "full-auto";
  return "full-auto";
}

/**
 * Convert AgentChatPermissionMode to old in-process mode.
 */
function providerModeToInProcessMode(mode: AgentChatPermissionMode | undefined): "plan" | "edit" | "full-auto" {
  if (mode === "full-auto") return "full-auto";
  if (mode === "edit") return "edit";
  if (mode === "default" || mode === "plan" || mode === "config-toml") return "plan";
  return "full-auto";
}

/**
 * Convert normalized MissionProviderPermissions into the old-style
 * `permissionConfig` shape that OrchestratorExecutorStartArgs uses.
 * This bridges the provider-level mission settings to the existing adapter interface.
 */
export function providerPermissionsToLegacyConfig(providers: MissionProviderPermissions): {
  cli: {
    mode: "read-only" | "edit" | "full-auto";
    sandboxPermissions: "read-only" | "workspace-write" | "danger-full-access";
    writablePaths?: string[];
    allowedTools?: string[];
  };
  inProcess: {
    mode: "plan" | "edit" | "full-auto";
  };
  /** Carry the provider-level modes through for adapters that can use them directly. */
  _providers: MissionProviderPermissions;
} {
  // For CLI config, use the claude mode as representative (most common CLI worker).
  // The adapter will use _providers to pick the right one per model family.
  const claudeCliMode = providerModeToCliMode(providers.claude);
  return {
    cli: {
      mode: claudeCliMode,
      sandboxPermissions: providers.codexSandbox ?? "workspace-write",
      ...(providers.writablePaths?.length ? { writablePaths: providers.writablePaths } : {}),
      ...(providers.allowedTools?.length ? { allowedTools: providers.allowedTools } : {}),
    },
    inProcess: {
      mode: providerModeToInProcessMode(providers.opencode),
    },
    _providers: providers,
  };
}

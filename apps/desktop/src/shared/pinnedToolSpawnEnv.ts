/**
 * Vendor self-update switches for ADE's pinned provider copies.
 *
 * ADE runs its own pinned, checksum-verified copy of every agent CLI and moves
 * that pin itself. A copy that updated itself in place would run a version ADE
 * never tested and leave the tools cache holding bytes that no longer match
 * the pin, so every place that starts one (chat runtimes, auth probes, model
 * discovery, one-shot tasks, terminals) applies the same switches from here.
 *
 * Keyed by tools-cache name (`claude-code`, `codex`, ...). Devin and Muse
 * have no switch: none was found, and their updaters do not touch ADE's
 * layout. Codex has no environment switch; its config flag is
 * {@link CODEX_NO_UPDATE_CHECK_ARGS}. Grok also takes {@link GROK_NO_AUTO_UPDATE_ARG}.
 *
 * Pure data, no Node imports: the renderer-side launch builders read it too.
 */

const SELF_UPDATE_ENV: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "claude-code": { DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_AUTOUPDATER_DISABLED_BY_HOST: "1" },
  // The SDK already passes --no-auto-update to its runtime; the variable also
  // covers the terminal CLI.
  copilot: { COPILOT_AUTO_UPDATE: "false" },
  "copilot-cli": { COPILOT_AUTO_UPDATE: "false" },
  opencode: { OPENCODE_DISABLE_AUTOUPDATE: "1" },
  droid: { FACTORY_DROID_AUTO_UPDATE_ENABLED: "false" },
  grok: { GROK_DISABLE_AUTOUPDATER: "1" },
  kimi: { KIMI_CODE_NO_AUTO_UPDATE: "1" },
  // Skips the update check for this launch. ADE's system-defaults file also
  // sets `general.enableAutoUpdate: false` (qwenSkillDefaults.ts).
  qwen: { QWEN_CODE_SKIP_UPDATE_CHECK_ONCE: "true" },
  pi: { PI_SKIP_VERSION_CHECK: "1" },
  // The agy CLI's background updater reads this before it asks the release
  // server; it covers `agy acp` chats and the terminal TUI.
  antigravity: { AGY_CLI_DISABLE_AUTO_UPDATE: "1" },
};

export type PinnedProviderToolSpec = {
  tool: string;
  label: string;
  /** Terminal identity; it can differ from the chat runtime (Copilot). */
  terminal?: {
    label: string;
    binaries: readonly string[];
    tools: readonly { tool: string; label: string }[];
    selfUpdateTool: string;
    selfUpdateArgs?: readonly string[];
  };
};

/** Provider identity shared by runtime status, launch, and environment setup. */
export const PINNED_PROVIDER_TOOLS: Readonly<Record<string, PinnedProviderToolSpec>> = {
  claude: { tool: "claude-code", label: "Claude Code", terminal: { label: "Claude Code", binaries: ["claude"], tools: [{ tool: "claude-code", label: "Claude Code" }], selfUpdateTool: "claude-code" } },
  codex: { tool: "codex", label: "Codex", terminal: { label: "Codex", binaries: ["codex"], tools: [{ tool: "codex", label: "Codex" }], selfUpdateTool: "codex" } },
  opencode: { tool: "opencode", label: "OpenCode", terminal: { label: "OpenCode", binaries: ["opencode"], tools: [{ tool: "opencode", label: "OpenCode" }], selfUpdateTool: "opencode" } },
  copilot: { tool: "copilot", label: "the Copilot runtime", terminal: { label: "the Copilot CLI", binaries: ["copilot"], tools: [{ tool: "copilot-cli", label: "the Copilot CLI" }], selfUpdateTool: "copilot-cli" } },
  cursor: { tool: "cursor-cli", label: "the Cursor CLI", terminal: { label: "the Cursor CLI", binaries: ["cursor-agent", "agent"], tools: [{ tool: "cursor-cli", label: "the Cursor CLI" }], selfUpdateTool: "cursor-cli" } },
  droid: { tool: "droid", label: "Droid", terminal: { label: "Droid", binaries: ["droid"], tools: [{ tool: "droid", label: "Droid" }], selfUpdateTool: "droid" } },
  pi: { tool: "pi", label: "Pi", terminal: { label: "Pi", binaries: ["pi"], tools: [{ tool: "pi", label: "Pi" }, { tool: "node", label: "the Node.js runtime Pi runs on" }], selfUpdateTool: "pi" } },
  qwen: { tool: "qwen", label: "Qwen Code", terminal: { label: "Qwen Code", binaries: ["qwen"], tools: [{ tool: "qwen", label: "Qwen Code" }], selfUpdateTool: "qwen" } },
  kimi: { tool: "kimi", label: "Kimi", terminal: { label: "Kimi", binaries: ["kimi"], tools: [{ tool: "kimi", label: "Kimi" }], selfUpdateTool: "kimi" } },
  grok: { tool: "grok", label: "Grok", terminal: { label: "Grok", binaries: ["grok"], tools: [{ tool: "grok", label: "Grok" }], selfUpdateTool: "grok", selfUpdateArgs: ["--no-auto-update"] } },
  devin: { tool: "devin", label: "Devin", terminal: { label: "Devin", binaries: ["devin"], tools: [{ tool: "devin", label: "Devin" }], selfUpdateTool: "devin" } },
  muse: { tool: "muse", label: "Muse", terminal: { label: "Muse Code", binaries: ["muse"], tools: [{ tool: "muse", label: "Muse Code" }], selfUpdateTool: "muse" } },
  antigravity: { tool: "antigravity", label: "Antigravity", terminal: { label: "Antigravity", binaries: ["agy"], tools: [{ tool: "antigravity", label: "Antigravity" }], selfUpdateTool: "antigravity" } },
};

/** The profile name ADE gives Codex's read-only sandbox with the network on. */
const CODEX_READ_ONLY_PROFILE = "ade_read_only";

/**
 * Codex CLI flags for the sandbox ADE picks, with commands reaching the
 * network in every mode (owner's decision, 2026-11-16). Codex's own default
 * keeps read-only (Plan) and workspace-write (Edit) offline, so `gh`,
 * `npm install` and `git push` only worked in Full auto. The file limits stay.
 *
 * workspace-write takes a config key. read-only has none, so it runs as a
 * permission profile with the same rule (every path readable, none
 * writable) plus the network; a profile replaces `--sandbox`, never joins it.
 */
export function codexSandboxCliArgs(sandbox: "read-only" | "workspace-write" | "danger-full-access"): string[] {
  if (sandbox === "workspace-write") return ["--sandbox", "workspace-write", "-c", "sandbox_workspace_write.network_access=true"];
  if (sandbox === "read-only") {
    return [
      "-c", `default_permissions="${CODEX_READ_ONLY_PROFILE}"`,
      "-c", `permissions.${CODEX_READ_ONLY_PROFILE}.filesystem={":root"="read"}`,
      "-c", `permissions.${CODEX_READ_ONLY_PROFILE}.network.enabled=true`,
    ];
  }
  return ["--sandbox", sandbox];
}

/** `codex` global flags that turn its startup update check off. */
export const CODEX_NO_UPDATE_CHECK_ARGS: readonly string[] = ["-c", "check_for_update_on_startup=false"];

/**
 * Flags for every `codex app-server` ADE starts: no update check, and no
 * startup fetch of the plugin directory and recommendations (0.166+; older
 * builds ignore the key). ADE only reads the installed inventory through
 * `plugin/list`, which this leaves unchanged.
 */
export const CODEX_APP_SERVER_STARTUP_ARGS: readonly string[] = [
  ...CODEX_NO_UPDATE_CHECK_ARGS,
  "-c",
  "features.plugin_discovery_prefetch=false",
];

/**
 * `-c allow_login_shell=false` for a Codex that runs commands on Linux, else
 * nothing. Codex runs each command as `bash -lc`, and a login shell whose
 * /etc/profile sets PATH from scratch (Debian) drops what ADE put on PATH:
 * the `ade` and `gh` shims, ~/.local/bin, npm's global bin. ADE starts Codex
 * with the person's login and interactive shell PATH already resolved
 * (`augmentProcessPathWithShellAndKnownCliDirs`), so a plain `bash -c` keeps
 * all of it. macOS keeps login shells (path_helper keeps existing entries);
 * Windows runs PowerShell.
 */
export function codexLinuxShellArgs(platform: string): string[] {
  return platform === "linux" ? ["-c", "allow_login_shell=false"] : [];
}

/** Grok's flag for the same, passed before its subcommand. */
export const GROK_NO_AUTO_UPDATE_ARG = "--no-auto-update";

/** The variables that keep the pinned copy of `tool` (a tools-cache name) from updating itself. */
export function pinnedToolSelfUpdateEnv(tool: string): Record<string, string> {
  return { ...(SELF_UPDATE_ENV[tool] ?? {}) };
}

/** The same, keyed by ADE provider id (`claude`, `codex`, `qwen`, ...). */
export function providerSelfUpdateEnv(provider: string): Record<string, string> {
  return pinnedToolSelfUpdateEnv(PINNED_PROVIDER_TOOLS[provider]?.tool ?? provider);
}

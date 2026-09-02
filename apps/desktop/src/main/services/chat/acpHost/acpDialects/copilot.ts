/**
 * GitHub Copilot CLI dialect. `copilot --acp`, npm package `@github/copilot`.
 *
 * GitHub ships this ACP server as a preview, and ADE labels it preview in
 * Settings until GitHub fixes the cancel report and drops the preview label.
 *
 * ## Verified rules
 *
 * - Version 1.0.82 (ACP agent 1.0.4) advertises `loadSession`, image prompts,
 *   and session list. It does **not** advertise `session/resume` or
 *   `session/close`; both answer -32601. ADE still sends `session/close` and
 *   degrades, keeping the pooled process. Live 1.0.82 on this machine completed
 *   real `session/prompt` turns (text `"ping"`, usage on the prompt result and
 *   `usage_update`). Cancel mid-prompt returned `stopReason: "end_turn"` with
 *   partial text — github/copilot-cli #4561, live. Config options arrive as
 *   `currentValue` / nested `value`, not ADE's `value` / `options[].id`.
 * - **Known bug.** Cancel may report `stopReason: "end_turn"`
 *   (github/copilot-cli issue 4561). ADE records its own cancel and marks the
 *   turn interrupted whatever the agent says. That accounting lives in the
 *   host, and it applies to every dialect.
 * - Slash commands arrive as ordinary prompts plus an
 *   `available_commands_update`. Some of the advertised commands only work in
 *   Copilot's own terminal UI. If a user picks one of those in ADE, the text
 *   reaches the model as a prompt. They are filtered out of the picker.
 * - The server-start flags `--effort`, `--available-tools`, and
 *   `--excluded-tools` are process global. `session/new` cannot override them,
 *   so a chat that needs a different value needs a different process. Those
 *   values are therefore part of the pool key.
 * - **ADE never writes Copilot's config.** There was once a trust pre-seed
 *   here that added the lane worktree to `$COPILOT_HOME/config.json`. It is
 *   removed. A three-arm live experiment on 1.0.82 showed headless
 *   `session/new` does not deadlock without any trust key and without
 *   `--add-dir`, in a throwaway git cwd and in a nested independent git repo:
 *   writes completed with `allow_all: "off"` and **zero**
 *   `session/request_permission` in every arm. The write bought nothing, and
 *   it cost something real — `config.json` is JSONC (leading `//` comments),
 *   `JSON.parse` throws on that header, and the recover path rewrote a user's
 *   live file as a stub, after which every `session/prompt` answered "No model
 *   available". For the record, since the wrong key name has been repeated in
 *   research notes: live 1.0.82 persists `trustedFolders` (camelCase), not
 *   `trusted_folders` (snake_case). Do not add either back.
 * - `--add-dir` on the spawn plan is the session path gate. It is argv, not a
 *   rewrite of user state, so it stays.
 * - `COPILOT_HOME` names the config directory, and `--config-dir` is the flag
 *   form. Sessions live at `<config home>/session-state/<uuid>/`.
 */

import {
  capability,
  capabilityAbsent,
  defineAcpDialect,
  type AcpSpawnContext,
  type AcpSpawnPlan,
} from "../acpHostTypes";
import type { AcpAvailableCommand } from "../acpProtocolTypes";
import {
  ADE_CLIENT_INFO,
  inlineImagePrompt,
  standardClose,
  standardLoad,
  transportGatedMcpInjection,
  withOptionalEnv,
} from "./shared";

/**
 * Commands the Copilot terminal UI owns. ADE hides them from its picker.
 *
 * The first four are the ones the research verified. The rest are terminal-only
 * by the same reasoning: they act on the terminal session, not on the model, so
 * sending them as a prompt would waste a turn.
 */
export const COPILOT_TUI_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "diff",
  "resume",
  "login",
  "undo",
  "logout",
  "exit",
  "quit",
  "clear",
  "theme",
  "help",
  "cwd",
  "reset",
]);

export const COPILOT_CANCEL_DEGRADATION_NOTE =
  "Copilot sometimes reports a stopped turn as finished. ADE marks it stopped.";

function normalizeCommandName(name: string): string {
  return name.replace(/^\/+/, "").trim().toLowerCase();
}

export function includeCopilotSlashCommand(command: AcpAvailableCommand): boolean {
  return !COPILOT_TUI_ONLY_COMMANDS.has(normalizeCommandName(command.name));
}

function buildSpawnPlan(context: AcpSpawnContext): AcpSpawnPlan {
  const args = ["--acp"];
  if (context.configHome?.length) args.push("--config-dir", context.configHome);
  // `--add-dir` is the session path gate. It is argv only — it does not
  // rewrite config.json, which is why it survived the removal of the trust
  // pre-seed. Live 1.0.82 ACP writes did not emit
  // `session/request_permission` with or without it, so it is a cheap gate,
  // not a supervision mechanism.
  args.push("--add-dir", context.cwd);
  if (context.reasoningEffort?.length) args.push("--effort", context.reasoningEffort);
  return {
    command: context.binaryPath,
    args,
    cwd: context.cwd,
    env: withOptionalEnv(context.baseEnv, { COPILOT_HOME: context.configHome }),
  };
}

export const copilotDialect = defineAcpDialect({
  providerId: "copilot",
  displayName: "GitHub Copilot",
  tier: "preview",
  binaryNames: ["copilot"],
  buildSpawnPlan,

  // Copilot 1.0.82 answers a `session/cancel` REQUEST with -32601. The
  // notification form is the one the binary accepts, same as Grok.
  cancelStyle: "notification",
  // `--effort` is process global, so two chats with different effort values
  // must not share a process. The environment carries the config home; the
  // effort flag is folded into the pool key by the caller through the spawn
  // plan arguments hash.
  poolEnvKeys: ["COPILOT_HOME", "GITHUB_TOKEN", "GH_TOKEN"],
  oneProcessPerSession: false,
  advertiseFsCapability: false,
  advertiseTerminalCapability: false,
  initializeMeta: null,
  clientInfo: ADE_CLIENT_INFO,
  postSessionNewNotifications: () => [],
  includeSlashCommand: includeCopilotSlashCommand,

  ignoredNotificationMethods: [],

  sessionIdPersistence: {
    assignableAtLaunch: true,
    sessionsDirName: "session-state",
    idShape: "uuid",
  },

  authProbe: {
    methodId: null,
    loginCommand: "copilot login",
    apiKeyEnvVars: ["GITHUB_TOKEN", "GH_TOKEN"],
  },

  degradationNotes: [COPILOT_CANCEL_DEGRADATION_NOTE],

  usageSource: "usage_update",
  usage: capability(({ usageUpdate, promptUsage }) => {
    if (usageUpdate) {
      return {
        contextUsedTokens: usageUpdate.used,
        contextWindowTokens: usageUpdate.size,
        ...(usageUpdate.cost && usageUpdate.cost.currency.toUpperCase() === "USD"
          ? { costUsd: usageUpdate.cost.amount }
          : {}),
      };
    }
    if (promptUsage) {
      return {
        ...(promptUsage.inputTokens !== undefined ? { inputTokens: promptUsage.inputTokens } : {}),
        ...(promptUsage.outputTokens !== undefined ? { outputTokens: promptUsage.outputTokens } : {}),
        ...(promptUsage.totalTokens !== undefined ? { totalTokens: promptUsage.totalTokens } : {}),
        ...(promptUsage.cachedReadTokens != null ? { cacheReadTokens: promptUsage.cachedReadTokens } : {}),
        ...(promptUsage.cachedWriteTokens != null ? { cacheWriteTokens: promptUsage.cachedWriteTokens } : {}),
        ...(promptUsage.thoughtTokens != null ? { reasoningTokens: promptUsage.thoughtTokens } : {}),
      };
    }
    return null;
  }),

  closeStyle: "close_request",
  closeSession: capability(standardClose),

  // `session/load` is verified. `session/resume` is not, so ADE does not claim
  // it. W5 can promote this to `resume_preferred` after a live probe.
  loadPolicy: "load_only",
  resumeSession: capabilityAbsent,
  loadSession: capability(standardLoad),

  sessionConfig: capabilityAbsent,
  mcpInjection: capability(transportGatedMcpInjection),
  imagePrompts: capability(inlineImagePrompt),
  configOptionIds: [],
});

/**
 * Antigravity dialect. Google's Antigravity CLI (`agy`) run as an ACP agent
 * (`agy acp`), from ADE's pinned copy (tools cache `antigravity`, version in
 * the manifest). The pin is one binary: `antigravity` (`antigravity.exe` on
 * Windows). Google stopped the standalone `agy-acp-server` at 1.4.5 and moved
 * ACP into this CLI at 1.5.0; the same binary is the Antigravity terminal.
 *
 * Sign-in belongs to the CLI and is the user's own `agy` login: the default
 * `~/.gemini/antigravity-cli` folder and the OS keyring (Credential Manager,
 * Keychain, Secret Service; a file where none works). ADE never passes
 * `--gemini-dir`, so a sign-in in the user's terminal and in ADE is one login.
 * The Google-account sign-in is `agy acp --login` (`ai/antigravitySignIn.ts`).
 *
 * ## Spawn
 *
 * - `agy acp --disable-telemetry`.
 * - `AGY_CLI_DISABLE_AUTO_UPDATE=1` (from `pinnedToolSpawnEnv.ts`, through the
 *   chat runtime env): the CLI must not replace ADE's pinned bytes.
 * - TMPDIR (TEMP and TMP on Windows) = an ADE-owned per-launch directory, so
 *   anything the CLI unpacks is removed on exit (`acpScratchDirs.ts`).
 * - BROWSER = a command that exits 0 and opens nothing, so a sign-in the
 *   agent starts by itself never opens a browser on a machine with no user.
 * - Google credential variables are removed and only the recorded method's
 *   are put back (`antigravityCredentialEnv`).
 *
 * ## Verified (2026-11-11, agy 1.5.6, Windows x64)
 *
 * `fixtures/antigravity.initialize.json` holds the captured `initialize`.
 *
 * 1. ACP v1. `authMethods`: oauth-personal, oauth-business, gemini-api-key,
 *    agent-platform. `authenticate` opens the OS browser by itself and waits
 *    on a `localhost` listener without printing the link, so ADE does not use
 *    it for the Google account.
 * 2. `sessionCapabilities`: resume, close, load, list, additionalDirectories.
 *    With `session/close`, chats in one lane share one process.
 * 3. No `mcpCapabilities`: MCP servers reach it over stdio only.
 * 4. Session modes `default`, `accept-edits`, `plan`, and `auto` (1.5.4+,
 *    not for Gemini Enterprise accounts). There is no full-access mode: a
 *    Full access chat runs in `default` and ADE answers each request.
 * 5. Unauthenticated `session/new` is -32000 "Authentication required".
 * 6. 1.5.1+ offers every model on the account to every ACP client.
 *
 * Signed in (Google account, same day):
 *
 * 7. Config options `model` (Gemini, Claude and GPT-OSS models on the
 *    account), `thought_level` (low, medium, high) and `mode`.
 * 8. `_meta.antigravity.systemPrompt.append` reaches the model.
 * 9. The prompt result carries `usage`; `inputTokens` leaves out the cached
 *    tokens (`antigravityUsage`). No `usage_update`.
 * 10. `plan` does not edit; `default` asks before an edit and a command.
 */

import {
  capability,
  capabilityAbsent,
  defineAcpDialect,
  type AcpSpawnContext,
  type AcpUsageBehavior,
  type AcpSpawnPlan,
} from "../acpHostTypes";
import {
  ADE_CLIENT_INFO,
  inlineImagePrompt,
  readAcpPromptUsage,
  standardAcpUsage,
  standardClose,
  standardLoad,
  standardResume,
  standardSetConfigOption,
  transportGatedMcpInjection,
} from "./shared";
import { allocateAcpScratchDir } from "../acpScratchDirs";
import { antigravityCredentialEnv, readAntigravitySettings } from "../../../ai/antigravityAuth";
import type { AgentChatUsageAccount } from "../../../../../shared/types";
import type { AntigravityAuthMethod } from "../../../../../shared/types/config";

/** Config option ids the agent implements (`set_config_option`). */
export const ANTIGRAVITY_CONFIG_OPTION_IDS = ["mode", "model", "thought_level"] as const;

/**
 * agy reports `inputTokens` without the cached part (1.5.6: `totalTokens` =
 * input + cachedRead + output), while ADE's reader takes the ACP reading, in
 * which the cached tokens are part of the input. Add them back first.
 */
const antigravityUsage: AcpUsageBehavior = ({ usageUpdate, promptUsage }) => {
  if (usageUpdate || !promptUsage) return standardAcpUsage({ usageUpdate, promptUsage });
  const input = promptUsage.inputTokens;
  if (typeof input !== "number" || !Number.isFinite(input)) return readAcpPromptUsage(promptUsage);
  const cached = (promptUsage.cachedReadTokens ?? 0) + (promptUsage.cachedWriteTokens ?? 0);
  return readAcpPromptUsage({ ...promptUsage, inputTokens: input + cached });
};

/** The flags every `agy acp` launch takes. */
export const ANTIGRAVITY_ACP_ARGS: readonly string[] = ["acp", "--disable-telemetry"];

/**
 * A BROWSER entry that succeeds and opens nothing. Python splits BROWSER on
 * the path separator and runs the entry with the URL only where `%s` appears,
 * so neither entry receives the URL.
 */
export function antigravityNoopBrowser(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === "win32") {
    const systemRoot = (env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows").replace(/\\/g, "/");
    return `${systemRoot}/System32/cmd.exe /d /c exit 0`;
  }
  return "/usr/bin/true";
}

/** The agent's own environment for one launch. Exported for the sign-in runner. */
export function antigravitySpawnEnv(args: {
  baseEnv: NodeJS.ProcessEnv;
  scratchDir: string;
  method: AntigravityAuthMethod | null;
  platform?: NodeJS.Platform;
}): NodeJS.ProcessEnv {
  const platform = args.platform ?? process.platform;
  const env = antigravityCredentialEnv(args.baseEnv, args.method);
  // An inherited browser, temp dir or 1.4.x harness path must not win.
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (upper === "ANTIGRAVITY_HARNESS_PATH" || upper === "BROWSER") delete env[key];
    if (platform === "win32" && (upper === "TEMP" || upper === "TMP")) delete env[key];
    if (platform !== "win32" && upper === "TMPDIR") delete env[key];
  }
  return {
    ...env,
    BROWSER: antigravityNoopBrowser(platform, args.baseEnv),
    ...(platform === "win32" ? { TEMP: args.scratchDir, TMP: args.scratchDir } : { TMPDIR: args.scratchDir }),
  };
}

/**
 * The spawn plan. `method` is the sign-in method whose credentials the agent
 * may see; a chat uses the one the CLI recorded, and the sign-in runner passes
 * the method the user is signing in with.
 */
export function buildAntigravitySpawnPlan(
  context: AcpSpawnContext,
  method: AntigravityAuthMethod | null = readAntigravitySettings(context.baseEnv).method,
  extraArgs: readonly string[] = [],
): AcpSpawnPlan {
  const scratchDir = allocateAcpScratchDir("antigravity");
  return {
    command: context.binaryPath,
    args: [...(context.binaryArgs ?? []), ...ANTIGRAVITY_ACP_ARGS, ...extraArgs],
    cwd: context.cwd,
    scratchDir,
    env: antigravitySpawnEnv({ baseEnv: context.baseEnv, scratchDir, method }),
  };
}

function buildSpawnPlan(context: AcpSpawnContext): AcpSpawnPlan {
  return buildAntigravitySpawnPlan(context);
}

/** Who pays, from the recorded method only (no token read, no network). */
function readAntigravityAccount({ env }: { env: NodeJS.ProcessEnv }): AgentChatUsageAccount {
  const method = readAntigravitySettings(env).method;
  if (method === "gemini-api-key" || method === "agent-platform") return { provider: "antigravity", kind: "api_key" };
  if (method === "oauth-personal" || method === "oauth-business") return { provider: "antigravity", kind: "subscription" };
  return { provider: "antigravity", kind: "unknown" };
}

export const antigravityDialect = defineAcpDialect({
  providerId: "antigravity",
  displayName: "Antigravity",
  tier: "preview",
  binaryNames: ["agy", "antigravity"],
  buildSpawnPlan,

  // The CLI's modes are `default`, `accept-edits`, `plan` and `auto`. It has
  // no full-access mode, so Full access opens in `default` and ADE answers
  // every request (`hostAnswersFullAccess`). A mode the account does not
  // offer (`auto` on Gemini Enterprise) is refused and the chat stays in
  // `default`, which asks: never a broader posture than the user picked.
  nativeModeValue: (mode) => {
    switch (mode) {
      case "plan":
        return "plan";
      case "auto-edit":
        return "accept-edits";
      case "auto":
        return "auto";
      default:
        return "default";
    }
  },
  hostAnswersFullAccess: true,
  // `_meta.antigravity.systemPrompt.append` (advertised in `initialize`).
  systemPromptMeta: (append) => ({ antigravity: { systemPrompt: { append } } }),

  cancelStyle: "notification",
  // The recorded method is read at spawn, so two chats share a process only
  // when they would start it with the same credentials.
  poolEnvKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"],
  oneProcessPerSession: false,
  advertiseFsCapability: false,
  advertiseTerminalCapability: false,
  initializeMeta: null,
  clientInfo: ADE_CLIENT_INFO,
  postSessionNewNotifications: () => [],
  // `/logout` signs the shared login out for every client on the machine;
  // Settings owns sign-in and sign-out, so the chat picker does not offer it.
  includeSlashCommand: (command) => command.name !== "logout",

  sessionIdPersistence: {
    assignableAtLaunch: false,
    sessionsDirName: null,
    idShape: "opaque",
  },

  authProbe: {
    // `authenticate` would open a browser sign-in. The probe only checks
    // `session/new` (see acpAuthProbe.ts); sign-in is the Settings action.
    methodId: null,
    loginCommand: null,
    signInHint: "Sign in from Settings > Providers > Antigravity",
    probeMayAuthenticate: false,
    // Ambient keys are removed from the agent's environment (the recorded
    // method decides), so none is offered as a way to sign in.
    apiKeyEnvVars: [],
  },

  degradationNotes: [
    "Antigravity cannot rewind or edit earlier turns; continue with a follow-up or start a new chat.",
  ],

  extensionNotifications: {},
  usage: capability(antigravityUsage),
  localUsage: capabilityAbsent,
  readAccount: readAntigravityAccount,
  inferCompaction: true,
  usageUpdateAfterTurn: false,

  closeStyle: "close_request",
  closeSession: capability(standardClose),

  // `sessionCapabilities.resume` and `loadSession` are both advertised.
  loadPolicy: "resume_preferred",
  resumeSession: capability(standardResume),
  loadSession: capability(standardLoad),

  sessionConfig: capability(standardSetConfigOption),
  // The model is the `model` config option.
  modelSelection: capabilityAbsent,
  mcpInjection: capability(transportGatedMcpInjection),
  imagePrompts: capability(inlineImagePrompt),
  configOptionIds: ANTIGRAVITY_CONFIG_OPTION_IDS,
  // `thought_level` lists the model's levels (1.5.6: low, medium, high); only a level the session
  // offers is sent, and ADE's `none` has no equivalent.
  reasoningEffortOption: {
    configId: "thought_level",
    toAgentValue: (effort) => (effort === "none" ? null : effort),
  },
});

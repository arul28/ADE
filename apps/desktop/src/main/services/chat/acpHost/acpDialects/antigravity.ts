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
 * 11. A quota or Google API error ends the turn as `end_turn` with the error
 *     as text; the session log's last step is the error
 *     (`antigravityTurnOutcome.ts`). An exhausted quota is `refusal`.
 * 12. Tool calls: the permission options are only `allow` (allow_once) and
 *     `deny` (reject_once). Edit and command quirks are corrected in
 *     `antigravitySessionUpdates.ts`. `ask_question` ends the turn with the
 *     question and its options as text; the next message is the answer.
 *     `invoke_subagent` returns at once and the subagent runs on in the
 *     background; its result reaches the agent, not ACP, so the agent's
 *     reply waits for the next prompt.
 */

import {
  capability,
  capabilityAbsent,
  defineAcpDialect,
  type AcpAccountReader,
  type AcpAsyncQuestion,
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
import { watchAntigravityTurnOutcome } from "./antigravityTurnOutcome";
import { normalizeAntigravitySessionUpdate } from "./antigravitySessionUpdates";
import { createAntigravityBackgroundWork } from "./antigravityChildWork";
import { antigravityCredentialEnv, readAntigravitySettings } from "../../../ai/antigravityAuth";
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
/**
 * The account tier `session/new` names in `_meta.antigravity.tier`
 * (`{ name, id, upgradeUri }`, e.g. "Antigravity Starter Quota" on a Google
 * account, verified 1.5.6). Only the display name is kept.
 */
function antigravityTierName(sessionMeta: Readonly<Record<string, unknown>> | null | undefined): string | null {
  const antigravity = sessionMeta?.antigravity;
  if (!antigravity || typeof antigravity !== "object") return null;
  const tier = (antigravity as Record<string, unknown>).tier;
  if (!tier || typeof tier !== "object") return null;
  const name = (tier as Record<string, unknown>).name;
  return typeof name === "string" && name.trim() ? name.trim().slice(0, 80) : null;
}

const readAntigravityAccount: AcpAccountReader = ({ env, sessionMeta }) => {
  const method = readAntigravitySettings(env).method;
  const plan = antigravityTierName(sessionMeta);
  if (method === "gemini-api-key" || method === "agent-platform") return { provider: "antigravity", kind: "api_key" };
  if (method === "oauth-personal" || method === "oauth-business" || plan) {
    return { provider: "antigravity", kind: "subscription", ...(plan ? { plan } : {}) };
  }
  return { provider: "antigravity", kind: "unknown" };
};

/**
 * `ask_question` arguments (verified 1.5.6): `{ questions: [{ question,
 * options: string[], is_multi_select }] }`. The agent marks its pick with a
 * "(Recommended) " prefix on the option.
 */
function antigravityAskQuestions(toolName: string, args: unknown): AcpAsyncQuestion[] | null {
  if (toolName !== "ask_question" || !args || typeof args !== "object") return null;
  const raw = (args as Record<string, unknown>).questions;
  if (!Array.isArray(raw)) return null;
  const questions = raw.flatMap((entry): AcpAsyncQuestion[] => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const question = typeof record.question === "string" ? record.question.trim() : "";
    if (!question) return [];
    const options = (Array.isArray(record.options) ? record.options : []).flatMap((option) => {
      if (typeof option !== "string" || !option.trim()) return [];
      const label = option.trim();
      const recommended = /^\(recommended\)\s*/i.exec(label);
      return [recommended
        ? { label: label.slice(recommended[0].length) || label, recommended: true }
        : { label }];
    });
    return [{ question: question.slice(0, 2_000), options: options.slice(0, 20), multiSelect: record.is_multi_select === true }];
  });
  return questions.length ? questions.slice(0, 8) : null;
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
  // Plan is the exception: `default` lets edits through once approved, so a
  // refused Plan stops the chat instead of falling back.
  modeSetupRequired: (nativeMode) => nativeMode === "plan",
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
  // A quota or API error arrives as `end_turn`; the session log says it failed.
  turnOutcome: watchAntigravityTurnOutcome,
  // Edit paths, a new file's text and command output (antigravitySessionUpdates.ts).
  normalizeSessionUpdate: normalizeAntigravitySessionUpdate,
  // A PDF sent as a resource (link or blob) never reaches the model; its
  // `read_file` reads one from a path (verified with a PDF, 1.5.6).
  readsBinaryAttachments: true,
  // `ask_question` ends the turn; the answer is the next message.
  asyncQuestions: antigravityAskQuestions,
  // Background subagents, read from agy's session logs (antigravityChildWork.ts).
  backgroundWork: createAntigravityBackgroundWork,

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

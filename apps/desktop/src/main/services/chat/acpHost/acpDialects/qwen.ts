/**
 * Qwen Code dialect. `qwen --acp`, npm package `@qwen-code/qwen-code`.
 *
 * Live 0.24.0 handshake: `loadSession`, session list/resume, image + audio
 * prompts, MCP http/sse, `session/set_config_option` for mode/model/
 * reasoning_effort.
 * Slash via `available_commands_update`.
 *
 * It does **not** advertise `session/close`, and a dummy `session/close` is
 * -32601. Ending a chat therefore ends the process (one process per session),
 * using the private-process posture required by this dialect. Copilot 1.0.82
 * has the same missing-close wire and keeps `close_request` + pool by product
 * call; Qwen follows the handshake so leaked agent sessions cannot pile up in
 * a pooled process.
 *
 * `QWEN_HOME` names the config directory, in the same shape as `CODEX_HOME`.
 *
 * `qwen auth` is removed in 0.24.0. Unauthenticated `session/new` is
 * "Authentication required: Use Qwen Code CLI to authenticate first." The
 * advertised methods are `openai` and `openai-responses` (both use
 * `OPENAI_API_KEY`); ADE selects the stable `openai` probe and does not write
 * `~/.qwen`, reusing whatever the Qwen CLI already has.
 *
 * `QWEN_CODE_SYSTEM_DEFAULTS_PATH` is how ADE's bundled agent skills reach a
 * Qwen session through Qwen's own `skills.directories` discovery — still
 * without writing `~/.qwen`, because the file it names is ADE's own. The
 * caller writes it; see `qwenSkillDefaults.ts` for the mechanism and for what
 * was verified in the bundle.
 *
 * ## Usage
 *
 * `usage_update { used, size }` is context occupancy, sent after each main
 * request. Token totals are not on the wire: Qwen appends one row per model
 * request to its own `usage/token-usage-YYYY-MM.jsonl`, and ADE reads the
 * turn's rows back after the turn (`qwenUsageLedger.ts`), so the totals are
 * `derived`. `qwen/notify/session/model-update { currentModelId }` names the
 * model after a switch. Qwen's ACP model ids carry the auth type as a suffix
 * (`gpt-5.5(openai)`), which ADE strips to the plain model name.
 *
 * ## Model selection
 *
 * Verified with no-prompt sessions on 0.22.3: `session/new` advertises the
 * `model` option with the suffixed ids of the models in Qwen's settings.
 * `session/set_config_option` takes the suffixed id and the bare id
 * (`gpt-5.5`) alike. A model that is not configured for the auth type is
 * -32603 `Model '<id>' not found for authType 'openai'`, and the session stays
 * on its model. The coordinator matches ADE's id against the advertised ids
 * with `qwenModelIdFromAgent`, sends the advertised id, and sends nothing for
 * a model Qwen does not offer. An unknown `reasoning_effort` value is -32602.
 */

import {
  capability,
  capabilityAbsent,
  defineAcpDialect,
  type AcpSpawnContext,
  type AcpSpawnPlan,
  type AcpTelemetrySignal,
} from "../acpHostTypes";
import {
  ADE_CLIENT_INFO,
  extensionMethodVariants,
  extensionSessionId,
  inlineImagePrompt,
  standardAcpUsage,
  standardLoad,
  standardResume,
  standardSetConfigOption,
  transportGatedMcpInjection,
  withOptionalEnv,
} from "./shared";
import { asRecord, toOptionalString } from "../../../shared/utils";
import { readQwenAccount } from "./acpAccounts";
import { createQwenUsageLedger } from "./qwenUsageLedger";
import { QWEN_SYSTEM_DEFAULTS_PATH_ENV } from "./qwenSkillDefaults";

/** Config option ids Qwen exposes through `session/set_config_option`. */
export const QWEN_CONFIG_OPTION_IDS = ["mode", "model", "reasoning_effort"] as const;

/** Qwen's `reasoning_effort` value that clears a session-scoped effort. */
export const QWEN_DEFAULT_REASONING_EFFORT = "default";

/** Extension notification Qwen sends after the session's model changes. */
export const QWEN_MODEL_UPDATE_METHOD = "qwen/notify/session/model-update";

/** `gpt-5.5(openai)` -> `gpt-5.5`. Qwen suffixes an ACP model id with its auth type. */
export function qwenModelIdFromAgent(raw: string): string {
  const stripped = raw.replace(/\([^()]*\)$/, "").trim();
  return stripped.length ? stripped : raw;
}

/** Reader for `qwen/notify/session/model-update { v, sessionId, currentModelId }`. */
export function readQwenModelUpdate(params: unknown): { sessionId: string | null; signals: AcpTelemetrySignal[] } {
  const current = toOptionalString(asRecord(params)?.currentModelId);
  return {
    sessionId: extensionSessionId(params),
    signals: current ? [{ kind: "current_model", modelId: qwenModelIdFromAgent(current) }] : [],
  };
}

function buildSpawnPlan(context: AcpSpawnContext): AcpSpawnPlan {
  return {
    command: context.binaryPath,
    args: ["--acp"],
    cwd: context.cwd,
    env: withOptionalEnv(context.baseEnv, {
      QWEN_HOME: context.configHome,
      [QWEN_SYSTEM_DEFAULTS_PATH_ENV]: context.adeSkillDefaultsPath,
    }),
  };
}

export const qwenDialect = defineAcpDialect({
  providerId: "qwen",
  displayName: "Qwen Code",
  tier: "first_class",
  binaryNames: ["qwen"],
  buildSpawnPlan,

  cancelStyle: "request",
  // The skill-defaults path is a pool key for the same reason the config home
  // is: two chats whose agents were handed different settings files are not
  // interchangeable, even though Qwen's one-process-per-session rule already
  // keeps them apart today.
  poolEnvKeys: [
    "QWEN_HOME",
    QWEN_SYSTEM_DEFAULTS_PATH_ENV,
    "QWEN_RUNTIME_DIR",
    "OPENAI_BASE_URL",
    "OPENAI_API_KEY",
  ],
  // 0.24.0 has no `session/close`. A process may never be shared.
  oneProcessPerSession: true,
  advertiseFsCapability: false,
  advertiseTerminalCapability: false,
  initializeMeta: null,
  clientInfo: ADE_CLIENT_INFO,
  postSessionNewNotifications: () => [],
  includeSlashCommand: () => true,

  extensionNotifications: extensionMethodVariants(QWEN_MODEL_UPDATE_METHOD, readQwenModelUpdate),
  localUsage: capability(createQwenUsageLedger),
  readAccount: readQwenAccount,
  // Qwen compacts silently; a sharp drop in `usage_update.used` is the tell.
  inferCompaction: true,
  usageUpdateAfterTurn: false,
  modelIdFromAgent: qwenModelIdFromAgent,

  sessionIdPersistence: {
    assignableAtLaunch: true,
    sessionsDirName: null,
    idShape: "uuid",
  },

  authProbe: {
    methodId: "openai",
    loginCommand: "qwen --auth-type=openai",
    apiKeyEnvVars: ["OPENAI_API_KEY", "DASHSCOPE_API_KEY"],
  },

  degradationNotes: [],

  usage: capability(standardAcpUsage),

  closeStyle: "kill_process",
  closeSession: capabilityAbsent,

  loadPolicy: "resume_preferred",
  resumeSession: capability(standardResume),
  loadSession: capability(standardLoad),

  sessionConfig: capability(standardSetConfigOption),
  modeSetupRequired: true,
  modelSelection: capabilityAbsent,
  mcpInjection: capability(transportGatedMcpInjection),
  imagePrompts: capability(inlineImagePrompt),
  configOptionIds: QWEN_CONFIG_OPTION_IDS,
  // `default` is Qwen's own value for "no session-scoped effort". ADE sends it
  // for every clear, also when the session does not list it, so a resumed
  // session cannot keep an older effort. Qwen answers an unknown value with
  // -32602, so a build that advertises no choices can still be sent one. A
  // failed set stops the session start: Qwen keeps the effort on the session.
  reasoningEffortOption: {
    configId: "reasoning_effort",
    toAgentValue: (effort) => effort,
    resetValue: QWEN_DEFAULT_REASONING_EFFORT,
    sendWhenUnadvertised: true,
    failClosed: true,
  },
});

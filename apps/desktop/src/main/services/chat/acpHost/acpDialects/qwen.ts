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
 */

import {
  capability,
  capabilityAbsent,
  defineAcpDialect,
  type AcpSpawnContext,
  type AcpSpawnPlan,
} from "../acpHostTypes";
import {
  ADE_CLIENT_INFO,
  inlineImagePrompt,
  standardLoad,
  standardResume,
  standardSetConfigOption,
  transportGatedMcpInjection,
  withOptionalEnv,
} from "./shared";
import { QWEN_SYSTEM_DEFAULTS_PATH_ENV } from "./qwenSkillDefaults";

/** Config option ids Qwen exposes through `session/set_config_option`. */
export const QWEN_CONFIG_OPTION_IDS = ["mode", "model", "reasoning_effort"] as const;

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

  ignoredNotificationMethods: [],

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

  usageSource: "usage_update",
  usage: capability(({ usageUpdate }) => {
    if (!usageUpdate) return null;
    return {
      contextUsedTokens: usageUpdate.used,
      contextWindowTokens: usageUpdate.size,
      ...(usageUpdate.cost && usageUpdate.cost.currency.toUpperCase() === "USD"
        ? { costUsd: usageUpdate.cost.amount }
        : {}),
    };
  }),

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
});

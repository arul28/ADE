/**
 * Qwen Code dialect. `qwen --acp`, npm package `@qwen-code/qwen-code`.
 *
 * Live 0.22.3 handshake: `loadSession`, session list/resume, image + audio
 * prompts, MCP http/sse, `session/set_config_option` for mode/model/thinking.
 * Slash via `available_commands_update`.
 *
 * It does **not** advertise `session/close`, and a dummy `session/close` is
 * -32601. Ending a chat therefore ends the process (one process per session),
 * the same posture Kimi 0.31.x used. Copilot 1.0.82 has the same missing-close
 * wire and keeps `close_request` + pool by product call; Qwen follows the
 * handshake so leaked agent sessions cannot pile up in a pooled process.
 *
 * `QWEN_HOME` names the config directory, in the same shape as `CODEX_HOME`.
 *
 * `qwen auth` is removed in 0.22.3. Unauthenticated `session/new` is
 * "Authentication required: Use Qwen Code CLI to authenticate first." The
 * advertised method is `openai` (`OPENAI_API_KEY`, `--auth-type=openai`, or a
 * custom provider already saved in `settings.json`). ADE does not write
 * `~/.qwen`; it reuses whatever the Qwen CLI already has.
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

/** Config option ids Qwen exposes through `session/set_config_option`. */
export const QWEN_CONFIG_OPTION_IDS = ["mode", "model", "thinking"] as const;

function buildSpawnPlan(context: AcpSpawnContext): AcpSpawnPlan {
  return {
    command: context.binaryPath,
    args: ["--acp"],
    cwd: context.cwd,
    env: withOptionalEnv(context.baseEnv, { QWEN_HOME: context.configHome }),
  };
}

export const qwenDialect = defineAcpDialect({
  providerId: "qwen",
  displayName: "Qwen Code",
  tier: "first_class",
  binaryNames: ["qwen"],
  buildSpawnPlan,

  cancelStyle: "request",
  poolEnvKeys: ["QWEN_HOME", "QWEN_RUNTIME_DIR", "OPENAI_BASE_URL", "OPENAI_API_KEY"],
  // 0.22.3 has no `session/close`. A process may never be shared.
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
  mcpInjection: capability(transportGatedMcpInjection),
  imagePrompts: capability(inlineImagePrompt),
  configOptionIds: QWEN_CONFIG_OPTION_IDS,
});

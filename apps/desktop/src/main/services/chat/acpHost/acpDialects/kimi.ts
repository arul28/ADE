/**
 * Kimi dialect. `kimi acp`, native binary from the MoonshotAI/kimi-code repo.
 *
 * This is NOT the deprecated Python `kimi-cli`.
 *
 * Captured 0.39.1 handshake (the compatibility baseline): `loadSession`, list,
 * resume, **and `session/close`** (also delete/fork/additionalDirectories).
 * A dummy `session/close` returns `{}`. Kimi Code 2.0.0's ACP v1 reference
 * retains that lifecycle surface and adds the documented mode/model/thinking
 * `session/set_config_option` dispatcher, which ADE exposes below. **No usage
 * on the wire** is still assumed until a live authenticated turn proves
 * otherwise; the meter stays hidden. Image prompts yes. Audio no.
 * `agentCapabilities.auth.logout` is advertised; ADE has no ACP logout action
 * yet.
 *
 * Kimi cannot take a session id at launch. The host reads the id the agent
 * reports at `session/new`, and W4 stores it. The ids are ULID shaped.
 *
 * `KIMI_CODE_HOME` names the config directory itself, and it defaults to
 * `~/.kimi-code`. The config file inside is `config.toml`. ADE does not write
 * that file — same rule as Copilot's config.json.
 *
 * Auth: `authenticate` method id `login`, type `terminal` (`kimi login` /
 * `kimi acp --login`). Region is `--region global` (kimi.ai) or
 * `mainland-cn` (kimi.com). Unauthenticated `session/new` is `-32000
 * Authentication required`.
 *
 * On Windows the native binary needs Git for Windows, because Git Bash is its
 * shell. W4 runs that preflight check and reports a clear error.
 */

import {
  capability,
  capabilityAbsent,
  defineAcpDialect,
  type AcpSpawnContext,
  type AcpSpawnPlan,
} from "../acpHostTypes";
import { resolveKimiCliModelForLaunch } from "../../../../../shared/cliLaunch";
import {
  ADE_CLIENT_INFO,
  inlineImagePrompt,
  standardClose,
  standardLoad,
  standardResume,
  standardSetConfigOption,
  transportGatedMcpInjection,
  withOptionalEnv,
} from "./shared";

export const KIMI_USAGE_DEGRADATION_NOTE =
  "Kimi does not report token usage, so the usage meter is hidden for this chat.";

export const KIMI_WINDOWS_DEGRADATION_NOTE =
  "Kimi needs Git for Windows on this machine, because Git Bash is its shell.";

/** Config option ids Kimi Code exposes through `session/set_config_option`. */
export const KIMI_CONFIG_OPTION_IDS = ["mode", "model", "thinking"] as const;

function buildSpawnPlan(context: AcpSpawnContext): AcpSpawnPlan {
  const args: string[] = [];
  const model = resolveKimiCliModelForLaunch(context.modelId);
  if (model) args.push("--model", model);
  if (context.permissionMode === "yolo") args.push("--yolo");
  else if (context.permissionMode === "auto") args.push("--auto");
  else if (context.permissionMode === "auto-edit") {
    throw new Error("Kimi ACP cannot honor ADE's auto-edit permission mode; choose a supported Kimi mode.");
  }
  else if (context.permissionMode === "plan") args.push("--plan");
  args.push("acp");
  return {
    command: context.binaryPath,
    args,
    cwd: context.cwd,
    env: withOptionalEnv(context.baseEnv, { KIMI_CODE_HOME: context.configHome }),
  };
}

export const kimiDialect = defineAcpDialect({
  providerId: "kimi",
  displayName: "Kimi",
  tier: "first_class",
  binaryNames: ["kimi"],
  buildSpawnPlan,

  cancelStyle: "request",
  poolEnvKeys: ["KIMI_CODE_HOME", "MOONSHOT_API_KEY"],
  // The 0.39.1 baseline and Kimi Code 2.0.0 both implement `session/close`.
  // Two chats in the same lane may share.
  oneProcessPerSession: false,
  advertiseFsCapability: false,
  // Kimi has no terminal reverse RPC, so advertising the capability would be a
  // claim it never uses.
  advertiseTerminalCapability: false,
  initializeMeta: null,
  clientInfo: ADE_CLIENT_INFO,
  postSessionNewNotifications: () => [],
  includeSlashCommand: () => true,

  ignoredNotificationMethods: [],

  sessionIdPersistence: {
    // The launcher cannot choose the id. The agent mints it.
    assignableAtLaunch: false,
    sessionsDirName: "sessions",
    idShape: "ulid",
  },

  authProbe: {
    methodId: "login",
    loginCommand: "kimi login",
    apiKeyEnvVars: ["MOONSHOT_API_KEY"],
  },

  degradationNotes: [KIMI_USAGE_DEGRADATION_NOTE],

  usageSource: "none",
  usage: capabilityAbsent,

  closeStyle: "close_request",
  closeSession: capability(standardClose),

  loadPolicy: "resume_preferred",
  resumeSession: capability(standardResume),
  loadSession: capability(standardLoad),

  // Kimi Code 2.0.0 documents this ACP v1 dispatcher for mode, model, and
  // thinking. Older supported binaries that omit a given option simply return
  // their normal ACP error, which the runtime already logs and degrades.
  sessionConfig: capability(standardSetConfigOption),
  modelSelection: capabilityAbsent,
  mcpInjection: capability(transportGatedMcpInjection),
  imagePrompts: capability(inlineImagePrompt),
  configOptionIds: KIMI_CONFIG_OPTION_IDS,
});

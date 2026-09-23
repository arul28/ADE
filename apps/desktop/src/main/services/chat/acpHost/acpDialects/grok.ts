/**
 * Grok dialect. `grok agent stdio`, npm package `@xai-official/grok`.
 *
 * There is no `grok acp`. The ACP server is a subcommand of `agent`.
 *
 * ## Spawn flags, and why each one is there
 *
 * `_GROK_CLAUDE_MARKER_OVERRIDE=1 grok --no-auto-update --no-plan
 *  --permission-mode <mode> agent --no-leader stdio`
 *
 * - `--no-auto-update`: auto update replaces the binary while the host holds
 *   an open connection to it.
 * - `--no-plan`: the native plan mode hangs an external host. ADE owns plan UX.
 * - `--no-leader`: leader mode lets one session contaminate another.
 * - `--permission-mode` + `_GROK_CLAUDE_MARKER_OVERRIDE`: the two halves of
 *   the approval neutralization. See rule 1.
 *
 * The flag position matters. `--no-auto-update` and `--no-plan` are global, so
 * they come before `agent`. `--no-leader` is agent scoped, so it sits between
 * `agent` and `stdio`.
 *
 * ## Verified rules
 *
 * 1. Grok merges permission RULES from several sources and evaluates MODE
 *    flags AFTER those rules, so no flag alone can force ask-always. The
 *    source that matters is the USER's `~/.claude/settings.json`
 *    `permissions.defaultMode` — that value, not the handful of allow rules
 *    beside it, is what seeds Grok's auto-classifier and silently approves
 *    writes. `GROK_HOME` does not scope that read. `_meta.autoMode: false` at
 *    `session/new` does NOT switch it off, `startupHints` does not, and
 *    `x.ai/yolo_mode_changed` is method-not-found on 1.0.13. The working kill
 *    switch is `_GROK_CLAUDE_MARKER_OVERRIDE=1` in the child environment, and
 *    it only works together with `--permission-mode`. Both halves and the risk
 *    they carry are documented in `shared/grokSupervision.ts`.
 * 2. `_meta.clientIdentifier: "ade"` must be stamped at `initialize`.
 * 3. `x.ai/session_notification` with `pending_interaction{kind:"permission"}`
 *    is a spinner hint, not a permission request. Never answer it. The same
 *    method carries Grok's usage, so its reader maps that payload to nothing.
 * 4. Read, Grep, and WebSearch never prompt. They are safe commands. Silence
 *    for reads is correct behavior, not a missing prompt.
 * 5. The option ids Grok actually offers are `allow-edits-session`,
 *    `allow-once`, and `reject-once`. The permission bridge classifies them
 *    from the id, so an unrecognized id still lands on a safe kind.
 * 6. `session/cancel` as a REQUEST answers -32601. Send it as a notification.
 * 7. Usage does not arrive as `usage_update`. Per-response usage, turn totals,
 *    subagents, compaction, and the model catalog ride xAI extension
 *    notifications, and the `session/prompt` result `_meta` repeats the turn
 *    totals. See `grokTelemetry.ts`.
 * 8. Never advertise the client `fs` capability. Grok proxies binary reads
 *    through the text file system and corrupts the bytes.
 * 9. `GROK_HOME` IS a valid config-home override (`xai-dirs` reads it). ADE
 *    passes the resolved value through unchanged so the auth probe, diagnostics,
 *    and session all inspect the same credential directory. ADE never writes it.
 * 10. The model and the effort are session config options (1.0.40). The
 *    `session/new` and `session/resume` results advertise `model` (grok-4.7,
 *    grok-4.7-build-fast, grok-4.6, grok-4.5) and `reasoning_effort` (xhigh,
 *    high, medium, low). `session/set_config_option { configId, value }`
 *    switches the session and answers with the whole option set; an unknown
 *    value is -32602. The spawn flags do not hold: `-m grok-4.7-build-fast`
 *    opened on grok-4.7 and served `grok-4.7-build`, `--reasoning-effort low`
 *    opened at `medium`, and `session/resume` brings back the model and effort
 *    the session last ran with. Set through the config option, the same turn
 *    served `grok-4.7-build-fast`. There is no `mode` option. Builds before
 *    1.0.40 advertise no `reasoning_effort` option, so the spawn flag still
 *    carries the effort for them.
 */

import {
  capability,
  capabilityAbsent,
  defineAcpDialect,
  type AcpExtensionNotificationReader,
  type AcpSpawnContext,
  type AcpSpawnPlan,
} from "../acpHostTypes";
import {
  ADE_CLIENT_INFO,
  extensionMethodVariants,
  standardClose,
  standardLoad,
  standardResume,
  standardSetConfigOption,
  transportGatedMcpInjection,
  withOptionalEnv,
} from "./shared";
import { grokReasoningEffortFlags, resolveGrokReasoningEffort } from "../../../../../shared/cliLaunch";
import { readGrokAccount } from "./acpAccounts";
import {
  GROK_MODELS_UPDATE_METHOD,
  GROK_SESSION_NOTIFICATION_METHOD,
  GROK_SESSION_UPDATE_METHOD,
  readGrokModelsUpdate,
  readGrokPromptUsage,
  readGrokSessionNotification,
} from "./grokTelemetry";
import { grokSupervisionEnv } from "../../../../../shared/grokSupervision";

export { GROK_CLAUDE_MARKER_OVERRIDE_ENV, grokSupervisionEnv } from "../../../../../shared/grokSupervision";

/** Extension notification that switches Grok's auto-approve mode off. */
export const GROK_YOLO_MODE_CHANGED_METHOD = "x.ai/yolo_mode_changed";

/** Lowest Grok version this dialect is written against. */
export const GROK_MINIMUM_VERSION = "1.0.13";

/** Every xAI extension method, under both spellings (1.0.40 adds the underscore). */
const GROK_EXTENSION_NOTIFICATIONS: Record<string, AcpExtensionNotificationReader> = {
  ...extensionMethodVariants(GROK_SESSION_NOTIFICATION_METHOD, readGrokSessionNotification),
  ...extensionMethodVariants(GROK_SESSION_UPDATE_METHOD, readGrokSessionNotification),
  ...extensionMethodVariants(GROK_MODELS_UPDATE_METHOD, readGrokModelsUpdate),
};

/**
 * Grok's `--permission-mode` is a process-global spawn flag.
 *
 * It is one of the two halves of the neutralization: it overrides the user's
 * `~/.grok/config.toml [ui] permission_mode`. On its own it is not enough,
 * because Grok evaluates mode flags AFTER the rules it merged from the user's
 * Claude settings — which is why `grokSupervisionEnv` rides alongside it.
 * `--no-plan` already disables Grok's native plan mode, so ADE's plan posture
 * maps onto `default` rather than Grok's hanging `plan` value.
 */
export function grokPermissionModeFlags(permissionMode: string | null | undefined): string[] {
  switch (permissionMode) {
    case "yolo":
      return ["--permission-mode", "bypassPermissions"];
    case "auto":
      return ["--permission-mode", "auto"];
    case "auto-edit":
      return ["--permission-mode", "acceptEdits"];
    default:
      return ["--permission-mode", "default"];
  }
}

/** Config option ids Grok 1.0.40 advertises at `session/new` and `session/resume`. */
export const GROK_CONFIG_OPTION_IDS = ["model", "reasoning_effort"] as const;

function buildSpawnPlan(context: AcpSpawnContext): AcpSpawnPlan {
  const args = [
    "--no-auto-update",
    "--no-plan",
    ...grokPermissionModeFlags(context.permissionMode),
    "agent",
    "--no-leader",
  ];
  // `-m` only sets the process default, and only for some ids: on 1.0.40
  // `-m grok-4.6` opened on grok-4.6, but `-m grok-4.7-build-fast` opened on
  // grok-4.7. A resumed session ignores it. The coordinator therefore also
  // sets the model through `session/set_config_option` after every entry;
  // this flag stays as the process default.
  //
  // `--reasoning-effort` is for builds before 1.0.40, whose session does not
  // advertise a `reasoning_effort` option. On 1.0.40 the flag never reached
  // the session (`--reasoning-effort low` opened at `medium`), so there the
  // effort rides `session/set_config_option`, and a change to this flag alone
  // does not restart a session that advertises the option (`spawnFlag`).
  if (context.modelId?.length) args.push("-m", context.modelId);
  args.push(...grokReasoningEffortFlags(context.reasoningEffort));
  args.push("stdio");
  return {
    command: context.binaryPath,
    args,
    cwd: context.cwd,
    // `GROK_HOME` is vendor-supported. Passing the resolved path keeps an
    // explicit override and the default ~/.grok path consistent with the
    // diagnostics/auth-probe surfaces. The supervision marker must travel
    // alongside --permission-mode or neither half works.
    env: withOptionalEnv(context.baseEnv, {
      GROK_HOME: context.configHome,
      ...grokSupervisionEnv(),
    }),
  };
}

export const grokDialect = defineAcpDialect({
  providerId: "grok",
  displayName: "Grok",
  tier: "first_class",
  binaryNames: ["grok"],
  buildSpawnPlan,

  // A `session/cancel` REQUEST answers -32601. The notification form works.
  cancelStyle: "notification",
  poolEnvKeys: ["GROK_HOME", "XAI_API_KEY"],
  oneProcessPerSession: false,
  // Grok corrupts binary assets when it proxies reads through the client text
  // file system. This must stay false.
  advertiseFsCapability: false,
  advertiseTerminalCapability: false,
  initializeMeta: { clientIdentifier: "ade" },
  clientInfo: ADE_CLIENT_INFO,

  postSessionNewNotifications: () => [
    // Kept as a best-effort extra. Grok 1.0.13 answers this with
    // "Method not found"; the spawn `--permission-mode` flag plus
    // `_GROK_CLAUDE_MARKER_OVERRIDE=1` are what actually defeat the
    // Claude-settings leak. Older builds may still honor this.
    {
      method: GROK_YOLO_MODE_CHANGED_METHOD,
      params: { auto_mode: false, permission_mode: "ask" },
    },
  ],

  // Grok re-sends its command list repeatedly. The translator dedupes; nothing
  // needs filtering here.
  includeSlashCommand: () => true,

  // The spinner hint rides the session-notification method, whose telemetry
  // reader maps it to nothing. It never reaches the permission bridge.
  extensionNotifications: GROK_EXTENSION_NOTIFICATIONS,
  localUsage: capabilityAbsent,
  readAccount: readGrokAccount,
  // Grok reports its own compactions (`auto_compact_*`), and it sends no
  // `usage_update` to infer one from.
  inferCompaction: false,
  usageUpdateAfterTurn: false,

  sessionIdPersistence: {
    assignableAtLaunch: true,
    sessionsDirName: null,
    idShape: "uuid",
  },

  authProbe: {
    methodId: null,
    loginCommand: "grok login",
    // A stored session token outranks the environment key.
    apiKeyEnvVars: ["XAI_API_KEY"],
  },

  degradationNotes: [
    "Grok does not accept image or audio attachments.",
  ],

  usage: capability(({ promptResponse }) =>
    readGrokPromptUsage((promptResponse?._meta ?? null) as Record<string, unknown> | null),
  ),

  closeStyle: "close_request",
  closeSession: capability(standardClose),

  loadPolicy: "resume_preferred",
  resumeSession: capability(standardResume),
  loadSession: capability(standardLoad),

  // Model and effort only. The permission posture rides spawn flags (rule 1),
  // so there is no `mode` option and the coordinator sends no mode call.
  sessionConfig: capability(standardSetConfigOption),
  modelSelection: capabilityAbsent,
  mcpInjection: capability(transportGatedMcpInjection),
  // No image or audio prompt support.
  imagePrompts: capabilityAbsent,
  configOptionIds: GROK_CONFIG_OPTION_IDS,
  // A clear puts back the effort the session opened with. A failed set is
  // logged, and the session keeps running on its own effort.
  reasoningEffortOption: {
    configId: "reasoning_effort",
    toAgentValue: resolveGrokReasoningEffort,
    spawnFlag: "--reasoning-effort",
  },
});

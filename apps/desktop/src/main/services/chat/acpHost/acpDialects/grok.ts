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
 *    is a spinner hint, not a permission request. Never answer it.
 * 4. Read, Grep, and WebSearch never prompt. They are safe commands. Silence
 *    for reads is correct behavior, not a missing prompt.
 * 5. The option ids Grok actually offers are `allow-edits-session`,
 *    `allow-once`, and `reject-once`. The permission bridge classifies them
 *    from the id, so an unrecognized id still lands on a safe kind.
 * 6. `session/cancel` as a REQUEST answers -32601. Send it as a notification.
 * 7. Usage does not arrive as `usage_update`. It rides the `session/prompt`
 *    result `_meta`.
 * 8. Never advertise the client `fs` capability. Grok proxies binary reads
 *    through the text file system and corrupts the bytes.
 * 9. `GROK_HOME` IS a valid config-home override (`xai-dirs` reads it). ADE
 *    still sets nothing, because a private home would hide the user's own
 *    `grok login` credential and rules. Reusing `~/.grok` is a choice, not a
 *    limitation.
 */

import {
  capability,
  capabilityAbsent,
  defineAcpDialect,
  type AcpSpawnContext,
  type AcpSpawnPlan,
  type AcpUsageSample,
} from "../acpHostTypes";
import {
  ADE_CLIENT_INFO,
  standardClose,
  standardLoad,
  standardResume,
  transportGatedMcpInjection,
} from "./shared";
import { grokSupervisionEnv } from "../../../../../shared/grokSupervision";

export { GROK_CLAUDE_MARKER_OVERRIDE_ENV, grokSupervisionEnv } from "../../../../../shared/grokSupervision";

/** Extension notification that switches Grok's auto-approve mode off. */
export const GROK_YOLO_MODE_CHANGED_METHOD = "x.ai/yolo_mode_changed";

/** Extension notification that is only a spinner hint. Never answer it. */
export const GROK_SESSION_NOTIFICATION_METHOD = "x.ai/session_notification";

/** Lowest Grok version this dialect is written against. */
export const GROK_MINIMUM_VERSION = "1.0.13";

/**
 * xAI `costUsdTicks` are nano-dollars: 1_000_000_000 ticks = $1.00.
 * A 1e6 scale showed a 30k-token ping as $86.65 in the usage footer.
 */
const GROK_COST_TICKS_PER_USD = 1_000_000_000;

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readFromLayers(
  layers: Array<Record<string, unknown> | null | undefined>,
  key: string,
): number | undefined {
  for (const layer of layers) {
    const value = readNumber(layer?.[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function readModelUsage(modelUsage: unknown): Pick<AcpUsageSample, "inputTokens" | "outputTokens" | "reasoningTokens" | "totalTokens"> | null {
  const record = asRecord(modelUsage);
  if (!record) return null;
  let input = 0;
  let output = 0;
  let reasoning = 0;
  let sawAny = false;
  for (const entry of Object.values(record)) {
    const row = asRecord(entry);
    if (!row) continue;
    const entryInput = readNumber(row.inputTokens) ?? readNumber(row.promptTokens);
    const entryOutput = readNumber(row.outputTokens) ?? readNumber(row.completionTokens);
    const entryReasoning = readNumber(row.reasoningTokens) ?? readNumber(row.thoughtTokens);
    if (entryInput !== undefined) {
      input += entryInput;
      sawAny = true;
    }
    if (entryOutput !== undefined) {
      output += entryOutput;
      sawAny = true;
    }
    if (entryReasoning !== undefined) {
      reasoning += entryReasoning;
      sawAny = true;
    }
  }
  if (!sawAny) return null;
  return {
    inputTokens: input,
    outputTokens: output,
    ...(reasoning ? { reasoningTokens: reasoning } : {}),
    totalTokens: input + output,
  };
}

/**
 * Read Grok's usage from the `session/prompt` result `_meta`.
 *
 * Grok 1.0.13 puts `costUsdTicks` and `modelUsage` under `_meta.usage`, and
 * repeats the token totals at the top level. Older captures put `costUsdTicks`
 * and `modelUsage` at the top level. The reader accepts both.
 */
export function readGrokPromptUsage(meta: Record<string, unknown> | null | undefined): AcpUsageSample | null {
  if (!meta) return null;
  const nested = asRecord(meta.usage);
  const sample: AcpUsageSample = {};

  const costTicks = readFromLayers([meta, nested], "costUsdTicks");
  if (costTicks !== undefined) sample.costUsd = costTicks / GROK_COST_TICKS_PER_USD;

  const cachedRead = readFromLayers([meta, nested], "cachedReadTokens");
  if (cachedRead !== undefined) sample.cacheReadTokens = cachedRead;

  const fromModels = readModelUsage(meta.modelUsage) ?? readModelUsage(nested?.modelUsage);
  if (fromModels) {
    Object.assign(sample, fromModels);
  } else {
    const input = readFromLayers([meta, nested], "inputTokens");
    const output = readFromLayers([meta, nested], "outputTokens");
    const reasoning = readFromLayers([meta, nested], "reasoningTokens");
    const total = readFromLayers([meta, nested], "totalTokens");
    if (input !== undefined) sample.inputTokens = input;
    if (output !== undefined) sample.outputTokens = output;
    if (reasoning !== undefined) sample.reasoningTokens = reasoning;
    if (total !== undefined) sample.totalTokens = total;
    else if (input !== undefined || output !== undefined) {
      sample.totalTokens = (input ?? 0) + (output ?? 0);
    }
  }

  return Object.keys(sample).length ? sample : null;
}

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

function buildSpawnPlan(context: AcpSpawnContext): AcpSpawnPlan {
  const args = [
    "--no-auto-update",
    "--no-plan",
    ...grokPermissionModeFlags(context.permissionMode),
    "agent",
    "--no-leader",
  ];
  // Model and effort go on the command line. Grok's `session/set_config_option`
  // is non-standard: it keys on `configId` and its value enumeration is not
  // documented, so ADE does not use it.
  if (context.modelId?.length) args.push("-m", context.modelId);
  if (context.reasoningEffort?.length) args.push("--reasoning-effort", context.reasoningEffort);
  args.push("stdio");
  return {
    command: context.binaryPath,
    args,
    cwd: context.cwd,
    // `GROK_HOME` is a real override, but ADE deliberately does not set one:
    // the user's `~/.grok` holds the login token and their own rules. The only
    // provider environment ADE adds is the Claude-import kill switch, which
    // must travel with the `--permission-mode` flag above or neither works.
    env: { ...context.baseEnv, ...grokSupervisionEnv() },
  };
}

export const grokDialect = defineAcpDialect({
  providerId: "grok",
  displayName: "Grok",
  tier: "preview",
  binaryNames: ["grok"],
  buildSpawnPlan,

  // A `session/cancel` REQUEST answers -32601. The notification form works.
  cancelStyle: "notification",
  poolEnvKeys: ["XAI_API_KEY"],
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

  // A spinner hint, not a permission request. Receive it and do nothing.
  ignoredNotificationMethods: [GROK_SESSION_NOTIFICATION_METHOD],

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

  usageSource: "prompt_result_meta",
  usage: capability(({ promptResponse }) =>
    readGrokPromptUsage((promptResponse?._meta ?? null) as Record<string, unknown> | null),
  ),

  closeStyle: "close_request",
  closeSession: capability(standardClose),

  loadPolicy: "resume_preferred",
  resumeSession: capability(standardResume),
  loadSession: capability(standardLoad),

  // Non-standard on this agent. Model and effort ride spawn flags instead.
  sessionConfig: capabilityAbsent,
  mcpInjection: capability(transportGatedMcpInjection),
  // No image or audio prompt support.
  imagePrompts: capabilityAbsent,
  configOptionIds: [],
});

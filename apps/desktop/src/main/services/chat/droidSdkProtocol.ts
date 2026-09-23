import { detectCompactionSignalText } from "../../../shared/contextCompaction";
import { asRecord, finiteNumberOrNull } from "../shared/utils";

export type DroidSdkAutonomyLevel = "off" | "low" | "medium" | "high";
// `agi` puts Droid in orchestrator mode: it decomposes a mission into features
// and spawns worker sub-sessions (surfaced to ADE as subagents) while keeping
// read-only tools at the top level.
export type DroidSdkInteractionMode = "auto" | "spec" | "agi";
export type DroidSdkReasoningEffort =
  | "none"
  | "dynamic"
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type DroidSdkTokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  thinkingTokens?: number;
};

export type DroidSdkContextStats = {
  used: number;
  remaining: number;
  limit: number;
  accuracy: "exact" | "estimated";
  updatedAt: string;
};

/** Normalizes both stream updates and a session `.settings.json` tokenUsage block. */
export function normalizeDroidSdkTokenUsage(value: unknown): DroidSdkTokenUsage | null {
  const record = asRecord(value);
  const source = asRecord(record?.tokenUsage) ?? record;
  if (!source) return null;
  const usage: DroidSdkTokenUsage = {};
  const inputTokens = finiteNumberOrNull(source.inputTokens);
  const outputTokens = finiteNumberOrNull(source.outputTokens);
  const cacheCreationTokens = finiteNumberOrNull(source.cacheCreationTokens);
  const cacheReadTokens = finiteNumberOrNull(source.cacheReadTokens);
  const thinkingTokens = finiteNumberOrNull(source.thinkingTokens);
  if (inputTokens != null) usage.inputTokens = inputTokens;
  if (outputTokens != null) usage.outputTokens = outputTokens;
  if (cacheCreationTokens != null) usage.cacheCreationTokens = cacheCreationTokens;
  if (cacheReadTokens != null) usage.cacheReadTokens = cacheReadTokens;
  if (thinkingTokens != null) usage.thinkingTokens = thinkingTokens;
  return Object.keys(usage).length ? usage : null;
}

export function normalizeDroidSdkContextStats(value: unknown): DroidSdkContextStats | null {
  const record = asRecord(value);
  const source = asRecord(record?.contextStats) ?? record;
  if (!source) return null;
  const used = finiteNumberOrNull(source.used);
  const remaining = finiteNumberOrNull(source.remaining);
  const limit = finiteNumberOrNull(source.limit);
  const accuracy = source.accuracy === "exact" || source.accuracy === "estimated"
    ? source.accuracy
    : null;
  const updatedAt = typeof source.updatedAt === "string" && source.updatedAt.trim().length
    ? source.updatedAt
    : null;
  if (used == null || remaining == null || limit == null || !accuracy || !updatedAt) return null;
  return { used, remaining, limit, accuracy, updatedAt };
}

/**
 * The one "is Droid compacting" test, shared by the worker (which samples
 * context stats at the edges) and the event mapper (which emits the
 * `context_compact` lifecycle). `compacting_conversation` is the SDK's
 * `DroidWorkingState` enum value; any other status string falls back to the
 * free-text compaction wording. An empty state is not compacting.
 */
export function isDroidCompactingState(state: string | null | undefined): boolean {
  if (!state) return false;
  return state === "compacting_conversation" || detectCompactionSignalText(state);
}

export type DroidSdkSessionSettings = {
  modelId: string;
  /**
   * Omitted when the user has chosen no ADE permission mode, so Droid resolves
   * autonomy from their own ~/.factory/settings.json. Both keys are optional in
   * the SDK, and omission resolves per key — a live probe confirmed an omitted
   * key falls through to the user's file while any stated value outranks it.
   * Never send null: an explicit null wedges the Droid RPC for 30 seconds.
   * See services/shared/providerConfigHomes.ts for the rule this follows.
   */
  autonomyLevel?: DroidSdkAutonomyLevel;
  interactionMode?: DroidSdkInteractionMode;
  reasoningEffort?: DroidSdkReasoningEffort;
  specModeModelId?: string;
  specModeReasoningEffort?: DroidSdkReasoningEffort;
};

/**
 * Droid's own default effort for one model, as its model catalog
 * (`listModels()`, each row's `defaultReasoningEffort`) publishes it. Null when
 * the catalog does not list the model or names no usable default.
 */
export function droidModelDefaultReasoningEffort(
  models: ReadonlyArray<unknown> | null | undefined,
  modelId: string,
): DroidSdkReasoningEffort | null {
  const wanted = modelId.trim();
  if (!wanted || !Array.isArray(models)) return null;
  const row = models
    .map((entry) => asRecord(entry))
    .find((entry) => typeof entry?.id === "string" && entry.id.trim() === wanted);
  const effort = typeof row?.defaultReasoningEffort === "string" ? row.defaultReasoningEffort.trim() : "";
  return effort ? effort as DroidSdkReasoningEffort : null;
}

export type DroidSdkReasoningEffortUpdate = {
  /** The effort to put on this update; undefined leaves the key out. */
  effort?: DroidSdkReasoningEffort;
  /** What ADE has stated to the session once the update lands. */
  stated: DroidSdkReasoningEffort | null;
  /** Why a cleared effort could not be reset; the next update retries. */
  resetError?: string;
};

/**
 * The reasoning effort one settings update states.
 *
 * Droid merges every update into the live session, so an update without an
 * effort keeps the last one stated, and the protocol has no reset value:
 * `reasoningEffort` is optional but not nullable in `update_session_settings`
 * (only the spec-mode fields take null). So when the chat clears an effort ADE
 * stated earlier, the update restates Droid's own default for the model. An
 * effort ADE never stated stays Droid's (and the user's settings.json's)
 * business, exactly as an omitted key always has.
 */
export async function resolveDroidReasoningEffortUpdate(args: {
  requested: DroidSdkReasoningEffort | null | undefined;
  stated: DroidSdkReasoningEffort | null;
  modelId: string;
  loadModels: () => Promise<ReadonlyArray<unknown>>;
}): Promise<DroidSdkReasoningEffortUpdate> {
  const requested = args.requested?.trim() ? args.requested.trim() as DroidSdkReasoningEffort : null;
  if (requested) return { effort: requested, stated: requested };
  if (!args.stated) return { stated: null };
  let resetError: string;
  try {
    const effort = droidModelDefaultReasoningEffort(await args.loadModels(), args.modelId);
    if (effort) return { effort, stated: null };
    resetError = `Droid's model list has no default effort for "${args.modelId}".`;
  } catch (error) {
    resetError = error instanceof Error ? error.message : String(error);
  }
  return { stated: args.stated, resetError };
}

/**
 * `work`, or a rejection with `timeoutError()` once `ms` passed. `work` keeps
 * running; its later result or failure is dropped.
 */
export function rejectAfterDeadline<T>(work: Promise<T>, ms: number, timeoutError: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutError()), Math.max(0, ms));
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * True when `signal` aborts before `work` settles, false when `work` settles
 * first. Rejects with `work`'s failure. A Stop during a send's settings step
 * uses it to end the send at once.
 */
export function abortedBefore(work: Promise<unknown>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(true);
  return new Promise<boolean>((resolve, reject) => {
    const onAbort = () => resolve(true);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve(false);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Undefined in, undefined out. An omitted interactionMode means "ADE has no
 * opinion, let ~/.factory/settings.json decide" — materialising a default here
 * would restate it at the highest precedence and undo the omission upstream.
 *
 * Takes the enum table rather than the SDK module so it stays a pure mapping.
 */
export function droidInteractionModeValue<T>(
  table: { Auto: T; Spec: T; AGI: T },
  mode: DroidSdkInteractionMode | undefined,
): T | undefined {
  switch (mode) {
    case "spec":
      return table.Spec;
    case "agi":
      return table.AGI;
    case "auto":
      return table.Auto;
    default:
      return undefined;
  }
}

/**
 * Selects the live Droid MCP tools a strict-MCP session must disable. MCP tools
 * are not part of `listTools()`'s native exec catalog; Droid exposes their
 * per-session enable switch through the low-level `toggleMcpTool` RPC instead.
 */
export function droidMcpToolsToDisable(
  tools: ReadonlyArray<{ serverName?: unknown; name?: unknown; isEnabled?: unknown }>,
  allowedServerNames: readonly string[],
): Array<{ serverName: string; toolName: string }> {
  const allowed = new Set(allowedServerNames.map((name) => name.trim()).filter(Boolean));
  const disabled: Array<{ serverName: string; toolName: string }> = [];
  for (const tool of tools) {
    const serverName = typeof tool?.serverName === "string" ? tool.serverName.trim() : "";
    const toolName = typeof tool?.name === "string" ? tool.name.trim() : "";
    // Unknown state is unsafe: disable anything that is not explicitly
    // reported as already disabled.
    if (!serverName || !toolName || allowed.has(serverName) || tool.isEnabled === false) continue;
    disabled.push({ serverName, toolName });
  }
  return disabled;
}

/**
 * 0.9.x requires `editedSpecContent` alongside the `proceed_edit` permission
 * outcome and rejects the result outright when it is missing (verified against
 * the SDK's `RequestPermissionResultSchema`). ADE has no plan editor, so it
 * passes the ExitSpecMode plan through unchanged — the same plan the user is
 * approving — and returns `null` for any other editable confirmation type so
 * the worker can fail closed.
 *
 * Takes the raw `toolUses` array rather than an SDK type so this stays a pure,
 * SDK-free mapping like the rest of this module.
 */
export function droidEditedSpecContentForRequest(
  toolUses: ReadonlyArray<{ details?: unknown }> | null | undefined,
): string | null {
  if (!Array.isArray(toolUses)) return null;
  for (const entry of toolUses) {
    const details = entry && typeof entry === "object"
      ? (entry as { details?: unknown }).details
      : null;
    if (!details || typeof details !== "object") continue;
    const record = details as Record<string, unknown>;
    if (record.type === "exit_spec_mode" && typeof record.plan === "string") {
      return record.plan;
    }
  }
  return null;
}

export type DroidSdkWorkerInit = {
  sessionId: string;
  laneRoot: string;
  droidPath: string;
  resumeSessionId?: string | null;
  settings: DroidSdkSessionSettings;
  /**
   * The effort an earlier worker stated to the session being resumed. Droid
   * keeps it across workers, so a chat that has since cleared its effort needs
   * it reset rather than inherited. Ignored for a new session.
   */
  statedReasoningEffort?: DroidSdkReasoningEffort | null;
  mcpServers?: unknown[];
  /** MCP server names ADE owns and the session may retain; all other tools are disabled per session. */
  allowedMcpServerNames?: string[];
};

/**
 * Worker-IPC image reference. Prefer `path` — never put multi-megabyte
 * screenshot bytes on this object. The worker materializes `{ data, mimeType }`
 * for `@factory/droid-sdk` locally. `data` remains for tests and tiny inline
 * cases. Droid's stream API has no remote-URL image form, so `url` is not part
 * of this union. Path images include `rootPath` so the worker re-opens through
 * the attachment sandbox.
 */
export type DroidSdkUserImage =
  | { path: string; mimeType: string; rootPath: string }
  | { data: string; mimeType: string };

export type DroidSdkSendPrompt = {
  promptText: string;
  images?: DroidSdkUserImage[];
  settings: DroidSdkSessionSettings;
  /**
   * The host's turn id. The worker stamps it on the trailing `context_stats`
   * samples so one that lands after the next turn started keeps its own turn.
   */
  turnId?: string;
};

export type DroidSdkReady = {
  sessionId: string;
  currentModelId: string | null;
  availableModels: Array<{
    id: string;
    modelId?: string | null;
    displayName?: string | null;
    shortDisplayName?: string | null;
    supportedReasoningEfforts?: string[];
    defaultReasoningEffort?: string | null;
    isCustom?: boolean;
  }>;
  /**
   * An effort ADE stated to the session and has not reset yet, after this
   * update. `null` once nothing is stated. The pool keeps it for the chat's
   * next worker.
   */
  statedReasoningEffort?: DroidSdkReasoningEffort | null;
};

export type DroidSdkPermissionRequest = {
  id: string;
  title: string;
  summary: string;
  toolName: string;
  toolInput?: unknown;
  toolUseIds: string[];
  options: Array<{
    label: string;
    value: string;
  }>;
  raw: unknown;
};

export type DroidSdkPermissionDecision = {
  selectedOption: string;
  comment?: string;
};

// Mirrors the Droid SDK `AskUserQuestion` shape (@factory/droid-sdk
// `AskUserRequestParamsSchema`). The SDK exposes exactly `topic`, `question`,
// and `options: string[]` per question — there is no per-option description,
// no multiSelect/allowMultiple flag, and no default-value field, so options are
// surfaced as bare choices and the topic becomes the question header. Display
// labels may be trimmed, but values preserve Droid's original option strings.
// This is the full ceiling of the Droid ask-user contract.
export type DroidSdkAskUserRequest = {
  id: string;
  toolCallId: string;
  title: string;
  questions: Array<{
    id: string;
    /** Droid's per-question `topic` (short label), surfaced as the card header. */
    header?: string;
    question: string;
    /** Droid options are plain strings; value preserves the exact SDK string. */
    options?: Array<{ label: string; value: string }>;
  }>;
  raw: unknown;
};

export type DroidSdkAskUserResponse = {
  cancelled: boolean;
  answers: Array<{
    index: number;
    question: string;
    answer: string;
  }>;
};

export type DroidSdkRunResult = {
  sessionId: string;
  tokenUsage?: unknown;
  modelId?: string;
  success: boolean;
  error?: unknown;
  /** See `DroidSdkReady.statedReasoningEffort`. */
  statedReasoningEffort?: DroidSdkReasoningEffort | null;
};

export type DroidSdkWorkerRequest =
  | { type: "init"; requestId: string; payload: DroidSdkWorkerInit }
  | { type: "send"; requestId: string; payload: DroidSdkSendPrompt }
  | { type: "settings_update"; requestId: string; payload: DroidSdkSessionSettings }
  | { type: "cancel"; requestId: string }
  | { type: "dispose"; requestId: string }
  | { type: "kill_worker"; requestId: string; payload: { workerSessionId: string } }
  | { type: "fork_session"; requestId: string }
  | { type: "permission_response"; requestId: string; payload: DroidSdkPermissionDecision }
  | { type: "ask_user_response"; requestId: string; payload: DroidSdkAskUserResponse };

export type DroidSdkWorkerResponse =
  | { type: "response"; requestId: string; ok: true; result?: unknown }
  | { type: "response"; requestId: string; ok: false; error: string }
  | { type: "ready"; ready: DroidSdkReady }
  | { type: "sdk_event"; event: unknown }
  | { type: "permission_request"; requestId: string; request: DroidSdkPermissionRequest }
  | { type: "ask_user_request"; requestId: string; request: DroidSdkAskUserRequest }
  | { type: "log"; level: "debug" | "info" | "warn" | "error"; message: string; detail?: unknown };

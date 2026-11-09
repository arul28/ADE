import {
  CURSOR_SDK_COMPACTION_EVENT,
  CURSOR_SDK_PRECOMPACT_HOOK_MARK,
  type CursorSdkCompactionWireEvent,
  type CursorSdkTurnTelemetry,
} from "./cursorSdkProtocol";
import { asRecord, finiteNumberOrNull, isEnvFlagOff, toOptionalString } from "../shared/utils";

/** Cursor's hook step name for the compaction hook (`hooks.json` key and `hook_event_name`). */
export const CURSOR_PRECOMPACT_HOOK_STEP = "preCompact";

/**
 * Every field ADE reads off the `preCompact` hook payload. None is documented:
 * the SDK copies them from agent-core's `agent.v1.PreCompactRequestQuery` into
 * the hook's stdin JSON. `cursorSdkPreCompactContract.test.ts` reads the
 * installed SDK and fails when a bump drops one.
 */
export const CURSOR_PRECOMPACT_HOOK_FIELDS = [
  "trigger",
  "context_usage_percent",
  "context_tokens",
  "context_window_size",
  "message_count",
  "messages_to_compact",
  "is_first_compaction",
  "model",
] as const;

export type CursorPreCompactHookPayload = {
  trigger: "manual" | "auto";
  contextTokens: number | null;
  contextWindowSize: number | null;
  contextUsagePercent: number | null;
  messageCount: number | null;
  messagesToCompact: number | null;
  isFirstCompaction: boolean | null;
  model: string | null;
};

/** `ADE_CURSOR_PRECOMPACT_HOOK=0` (or `false`/`off`/`no`) turns the hook off; anything else leaves it on. */
export function cursorPreCompactHookEnabled(
  init: { preCompactHook?: boolean } | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (init?.preCompactHook === false) return false;
  return !isEnvFlagOff(env.ADE_CURSOR_PRECOMPACT_HOOK);
}

export function isCursorPreCompactHookPayload(raw: unknown): boolean {
  return asRecord(raw)?.hook_event_name === CURSOR_PRECOMPACT_HOOK_STEP;
}

export function parseCursorPreCompactHookPayload(raw: unknown): CursorPreCompactHookPayload | null {
  const record = asRecord(raw);
  if (!record || record.hook_event_name !== CURSOR_PRECOMPACT_HOOK_STEP) return null;
  return {
    // The SDK already collapses the proto enum to exactly these two strings.
    trigger: record.trigger === "manual" ? "manual" : "auto",
    contextTokens: finiteNumberOrNull(record.context_tokens),
    contextWindowSize: finiteNumberOrNull(record.context_window_size),
    contextUsagePercent: finiteNumberOrNull(record.context_usage_percent),
    messageCount: finiteNumberOrNull(record.message_count),
    messagesToCompact: finiteNumberOrNull(record.messages_to_compact),
    isFirstCompaction: typeof record.is_first_compaction === "boolean" ? record.is_first_compaction : null,
    model: toOptionalString(record.model),
  };
}

function isAutoModelSelection(modelSdkId: string | null | undefined): boolean {
  const id = modelSdkId?.trim().toLowerCase().replace(/^cursor\//, "") ?? "";
  return id === "auto" || id === "default";
}

/** Stream message types that only arrive once Cursor is generating again. */
const POST_COMPACTION_STREAM_TYPES = new Set(["assistant", "thinking", "tool_call", "usage"]);

type PendingCompaction = {
  seq: number;
  trigger: "manual" | "auto";
  contextTokens: number | null;
  startedAtMs: number;
  /** Cursor's own `summary` message said it is running, so only its end may close this. */
  summaryRunning: boolean;
  /** Opened by the `summary` message; a hook that lands later joins it. */
  openedBySummary: boolean;
};

/**
 * Worker-side state for the local run in flight: the compaction the
 * `preCompact` hook opened, and the account/model facts hook payloads carry.
 *
 * Since `@cursor/sdk` 1.2.0 the stream carries `summary` messages (running,
 * completed, error), which are the real start and end of a compaction. The
 * `preCompact` hook still supplies the sizes. If no `summary` message arrives,
 * the first message that proves generation resumed closes the compaction, and
 * the run ending closes whatever is left, so a divider can never spin forever.
 */
export function createCursorSdkRunTelemetry(now: () => number = Date.now) {
  let requestedModel: string | null = null;
  let compactions = 0;
  let pending: PendingCompaction | null = null;
  let compactionSignalThisRun = false;
  let runTrigger: "manual" | "auto" = "auto";
  let hookModel: string | null = null;
  // Worker lifetime: the login does not change under a running worker.
  let hookEmail: string | null = null;

  const close = (
    phase: "completed" | "failed",
    closedBy: NonNullable<CursorSdkCompactionWireEvent["closedBy"]>,
    detail: { failReason?: "provider_error"; fallback?: boolean } = {},
  ): CursorSdkCompactionWireEvent | null => {
    if (!pending) return null;
    const open = pending;
    pending = null;
    return {
      type: CURSOR_SDK_COMPACTION_EVENT,
      phase,
      seq: open.seq,
      trigger: open.trigger,
      ...(open.contextTokens != null ? { contextTokens: open.contextTokens } : {}),
      durationMs: Math.max(0, now() - open.startedAtMs),
      ...(phase === "failed" ? { failReason: detail.failReason ?? "interrupted" as const } : {}),
      ...(detail.fallback ? { fallback: true } : {}),
      closedBy,
    };
  };

  const fromSummaryMessage = (record: Record<string, unknown> | null): CursorSdkCompactionWireEvent | null => {
    const status = record?.status;
    if (status === "completed") return close("completed", "summary", { fallback: record?.fallback === true });
    if (status === "error") return close("failed", "summary", { failReason: "provider_error" });
    if (status !== "running") return null;
    compactionSignalThisRun = true;
    if (pending) {
      pending.summaryRunning = true;
      return null;
    }
    compactions += 1;
    pending = {
      seq: compactions,
      trigger: runTrigger,
      contextTokens: null,
      startedAtMs: now(),
      summaryRunning: true,
      openedBySummary: true,
    };
    return { type: CURSOR_SDK_COMPACTION_EVENT, phase: "started", seq: compactions, trigger: runTrigger };
  };

  return {
    beginRun(modelSdkId: string | null | undefined, trigger: "manual" | "auto" = "auto"): void {
      requestedModel = modelSdkId?.trim() || null;
      runTrigger = trigger;
      compactions = 0;
      pending = null;
      compactionSignalThisRun = false;
      hookModel = null;
    },

    /** Reads the account and model facts every Cursor hook payload carries. */
    noteHookPayload(raw: unknown): void {
      const record = asRecord(raw);
      if (!record) return;
      const email = toOptionalString(record.user_email);
      if (email && email.includes("@")) hookEmail = email;
      const model = toOptionalString(record.model);
      if (model) hookModel = model;
    },

    preCompactStarted(payload: CursorPreCompactHookPayload): CursorSdkCompactionWireEvent {
      compactionSignalThisRun = true;
      const trigger = runTrigger === "manual" ? "manual" : payload.trigger;
      if (pending?.openedBySummary) {
        // The `summary` message got here first: same compaction, now with sizes.
        pending.contextTokens = payload.contextTokens;
        pending.openedBySummary = false;
      } else {
        compactions += 1;
        pending = {
          seq: compactions,
          trigger,
          contextTokens: payload.contextTokens,
          startedAtMs: now(),
          summaryRunning: false,
          openedBySummary: false,
        };
      }
      return {
        type: CURSOR_SDK_COMPACTION_EVENT,
        phase: "started",
        seq: pending.seq,
        trigger: pending.trigger,
        ...(payload.contextTokens != null ? { contextTokens: payload.contextTokens } : {}),
        ...(payload.contextWindowSize != null ? { contextWindowSize: payload.contextWindowSize } : {}),
        ...(payload.contextUsagePercent != null ? { contextUsagePercent: payload.contextUsagePercent } : {}),
        ...(payload.model ? { model: payload.model } : {}),
      };
    },

    /**
     * Call before forwarding a stream message. Returns the compaction event to
     * post first, if this message starts or ends one, and the message to forward.
     * A status message is marked once a provider signal has been seen, so the
     * text fallback is quiet. A `summary` message is fully consumed here, so
     * `event` is null and nothing is forwarded.
     */
    beforeStreamEvent(event: unknown): { compaction: CursorSdkCompactionWireEvent | null; event: unknown } {
      const record = asRecord(event);
      const type = typeof record?.type === "string" ? record.type : "";
      if (type === "summary") return { compaction: fromSummaryMessage(record), event: null };
      const compaction = POST_COMPACTION_STREAM_TYPES.has(type) && !pending?.summaryRunning
        ? close("completed", "next_event")
        : null;
      const forwarded = compactionSignalThisRun && type === "status"
        ? { ...record, [CURSOR_SDK_PRECOMPACT_HOOK_MARK]: true }
        : event;
      return { compaction, event: forwarded };
    },

    endRun(status: string | null | undefined): CursorSdkCompactionWireEvent | null {
      return close(status === "cancelled" || status === "error" ? "failed" : "completed", "run_end");
    },

    turnTelemetry(accountEmail: string | null | undefined): CursorSdkTurnTelemetry {
      const email = hookEmail ?? toOptionalString(accountEmail);
      // Only an `auto` pick is refined: for a named model the hook's value is
      // the same model, possibly under another spelling.
      const servedModel = isAutoModelSelection(requestedModel) && hookModel && !isAutoModelSelection(hookModel)
        ? hookModel
        : null;
      return {
        ...(email ? { accountEmail: email } : {}),
        ...(servedModel ? { servedModel } : {}),
      };
    },
  };
}

export type CursorSdkRunTelemetry = ReturnType<typeof createCursorSdkRunTelemetry>;

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
};

/**
 * Worker-side state for the local run in flight: the compaction the
 * `preCompact` hook opened, and the account/model facts hook payloads carry.
 *
 * Cursor has no public "compaction finished" signal. The SDK turns the
 * summary it writes into a `task` message, so that closes the compaction; the
 * first message that proves generation resumed closes it otherwise, and the run
 * ending closes whatever is left, so a divider can never spin forever.
 */
export function createCursorSdkRunTelemetry(now: () => number = Date.now) {
  let requestedModel: string | null = null;
  let compactions = 0;
  let pending: PendingCompaction | null = null;
  let hookFiredThisRun = false;
  let hookModel: string | null = null;
  // Worker lifetime: the login does not change under a running worker.
  let hookEmail: string | null = null;

  const close = (
    phase: "completed" | "failed",
    closedBy: NonNullable<CursorSdkCompactionWireEvent["closedBy"]>,
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
      ...(phase === "failed" ? { failReason: "interrupted" as const } : {}),
      closedBy,
    };
  };

  return {
    beginRun(modelSdkId: string | null | undefined): void {
      requestedModel = modelSdkId?.trim() || null;
      compactions = 0;
      pending = null;
      hookFiredThisRun = false;
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
      hookFiredThisRun = true;
      compactions += 1;
      pending = {
        seq: compactions,
        trigger: payload.trigger,
        contextTokens: payload.contextTokens,
        startedAtMs: now(),
      };
      return {
        type: CURSOR_SDK_COMPACTION_EVENT,
        phase: "started",
        seq: compactions,
        trigger: payload.trigger,
        ...(payload.contextTokens != null ? { contextTokens: payload.contextTokens } : {}),
        ...(payload.contextWindowSize != null ? { contextWindowSize: payload.contextWindowSize } : {}),
        ...(payload.contextUsagePercent != null ? { contextUsagePercent: payload.contextUsagePercent } : {}),
        ...(payload.model ? { model: payload.model } : {}),
      };
    },

    /**
     * Call before forwarding a local stream message. Returns the completion to
     * post first (if this message closes an open compaction) and the message to
     * forward, marked when the hook already fired so the text fallback is quiet.
     */
    beforeStreamEvent(event: unknown): { completion: CursorSdkCompactionWireEvent | null; event: unknown } {
      const record = asRecord(event);
      const type = typeof record?.type === "string" ? record.type : "";
      const completion = type === "task"
        ? close("completed", "summary")
        : POST_COMPACTION_STREAM_TYPES.has(type)
          ? close("completed", "next_event")
          : null;
      const forwarded = hookFiredThisRun && type === "status"
        ? { ...record, [CURSOR_SDK_PRECOMPACT_HOOK_MARK]: true }
        : event;
      return { completion, event: forwarded };
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

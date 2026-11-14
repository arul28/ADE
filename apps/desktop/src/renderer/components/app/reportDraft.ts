import { useSyncExternalStore } from "react";
import type {
  DiagnosticReportRequestPayload,
  DiagnosticsManualSendResult,
  DiagnosticsPreparedReport,
} from "../../../shared/types/diagnostics";
import { isAdeAvailable } from "../../lib/adeAvailability";

/**
 * One report a person reads before it goes to ADE: build it, show it, send
 * exactly that text, or drop it.
 *
 * The report dialog and Settings' "Send a report" both run this. Building
 * (`prepareReport`) sends nothing and spends no budget; `sendReport(id)`
 * uploads the prepared text byte for byte. A send that answers `expired`
 * (main no longer holds that text) uploads nothing: the draft builds a new
 * report and waits for the person to press Send again, so nothing unseen is
 * ever sent. The person's note survives a failed send and a closed dialog.
 */

export type ReportDraftPhase =
  | "idle"
  | "preparing"
  | "prepare_failed"
  | "ready"
  | "sending"
  | "send_failed"
  | "sent";

export type ReportDraftState = {
  phase: ReportDraftPhase;
  /** The text being shown, and sent on Send. Kept after a failed send so "Try again" sends the same text. */
  prepared: DiagnosticsPreparedReport | null;
  /** The last send's answer. */
  result: DiagnosticsManualSendResult | null;
  /** The shown report replaced one main no longer held: say so before the next Send. */
  rebuilt: boolean;
  note: string;
};

export type ReportDraft = {
  getState: () => ReportDraftState;
  subscribe: (listener: () => void) => () => void;
  prepare: () => Promise<void>;
  send: () => Promise<void>;
  setNote: (note: string) => void;
  /** Cancel: drops the prepared text in main and returns to idle. The note stays. */
  discard: () => void;
};

/** What this window's bridge offers, read at call time (the web client's `sendReport` comes and goes with its Sentry). */
export function reportBridge() {
  const bridge = typeof window !== "undefined" ? window.ade?.diagnostics : undefined;
  return {
    prepare: isAdeAvailable(bridge?.prepareReport) ? bridge.prepareReport : null,
    send: isAdeAvailable(bridge?.sendReport) ? bridge.sendReport : null,
    discard: isAdeAvailable(bridge?.discardReport) ? bridge.discardReport : null,
    /** Whether a note reaches ADE here (Sentry runs). */
    noteAvailable: bridge?.userFeedbackAvailable === true,
  };
}

export function createReportDraft(
  context: DiagnosticReportRequestPayload | undefined,
  options: { note?: string; onSent?: (result: Extract<DiagnosticsManualSendResult, { ok: true }>) => void } = {},
): ReportDraft {
  let state: ReportDraftState = { phase: "idle", prepared: null, result: null, rebuilt: false, note: options.note ?? "" };
  const listeners = new Set<() => void>();
  // Which request a reply belongs to: a Cancel, or a newer build, makes an
  // older reply stale, and a stale reply never lands on screen.
  let generation = 0;

  const set = (patch: Partial<ReportDraftState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };

  const prepare = async (keepRebuilt = false) => {
    const bridge = reportBridge();
    if (!bridge.prepare) {
      set({ phase: "prepare_failed", prepared: null, result: null });
      return;
    }
    const mine = ++generation;
    set({ phase: "preparing", prepared: null, result: null, rebuilt: keepRebuilt ? state.rebuilt : false });
    let answer: Awaited<ReturnType<NonNullable<typeof bridge.prepare>>>;
    try {
      answer = await bridge.prepare(context);
    } catch {
      answer = { ok: false, reason: "failed" };
    }
    if (mine !== generation) {
      // Nobody will read this one: free it in main now rather than at expiry.
      if (answer.ok) void bridge.discard?.(answer.id).catch(() => undefined);
      return;
    }
    if (!answer.ok) {
      set({ phase: "prepare_failed" });
      return;
    }
    const { ok: _ok, ...prepared } = answer;
    set({ phase: "ready", prepared });
  };

  const send = async () => {
    const bridge = reportBridge();
    const prepared = state.prepared;
    if (!bridge.send || !prepared || (state.phase !== "ready" && state.phase !== "send_failed")) return;
    const mine = ++generation;
    set({ phase: "sending", result: null });
    const note = bridge.noteAvailable ? state.note.trim().slice(0, prepared.noteMaxChars) : "";
    let result: DiagnosticsManualSendResult;
    try {
      result = await bridge.send(prepared.id, note ? { userMessage: note } : undefined);
    } catch {
      result = { ok: false, reason: "failed" };
    }
    if (mine !== generation) return;
    if (!result.ok && result.reason === "expired") {
      set({ rebuilt: true });
      await prepare(true);
      return;
    }
    if (result.ok) {
      set({ phase: "sent", result, note: "", rebuilt: false });
      options.onSent?.(result);
      return;
    }
    set({ phase: "send_failed", result });
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prepare: () => prepare(false),
    send,
    setNote: (note) => set({ note }),
    discard: () => {
      generation += 1;
      const prepared = state.prepared;
      if (prepared && state.phase !== "sent") {
        void reportBridge().discard?.(prepared.id).catch(() => undefined);
      }
      set({ phase: "idle", prepared: null, result: null, rebuilt: false });
    },
  };
}

export function useReportDraftState(draft: ReportDraft): ReportDraftState {
  return useSyncExternalStore(draft.subscribe, draft.getState, draft.getState);
}

/** Whether "Try again" can help after this failure. */
export function canRetryReport(result: DiagnosticsManualSendResult | null): boolean {
  return Boolean(result && !result.ok && (result.reason === "failed" || result.reason === "unavailable"));
}

/** `12.4 KB`, `860 bytes`. */
export function formatReportSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const kb = bytes / 1024;
  return kb < 1024 ? `${kb.toFixed(kb < 10 ? 1 : 0)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

const REPORT_ANALYTICS_INTERVAL_MS = 6 * 60 * 60 * 1_000;

/**
 * The report flow's coarse UI facts (`ade_feature_used`, feature
 * `issue_report`). The send's own outcome is recorded where it is known (main,
 * or the web adapter). Deduplicated per action and outcome for six hours.
 * Never the surface, the report, the note or the reference.
 */
export function captureReportEvent(
  action: "report_dialog" | "github_issue" | "report_copied",
  outcome: "opened" | "completed" | "cancelled" | "failed",
): void {
  const capture = typeof window !== "undefined" ? window.ade?.analytics?.capture : undefined;
  if (!isAdeAvailable(capture)) return;
  void Promise.resolve(capture({
    event: "ade_feature_used",
    properties: { feature: "issue_report", action, outcome },
    dedupeKey: `${action}:${outcome}`,
    minimumIntervalMs: REPORT_ANALYTICS_INTERVAL_MS,
  })).catch(() => undefined);
}

import { useEffect, useId, useState, useSyncExternalStore, type CSSProperties } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CheckCircle, Copy, Check } from "@phosphor-icons/react";
import type {
  DiagnosticReportRequestPayload,
  DiagnosticsManualSendResult,
} from "../../../shared/types/diagnostics";
import { describeManualSendFailure } from "../../../shared/diagnosticsUpload";
import { scrubFreeText } from "../../../shared/sentry/scrub";
import { Dialog, type DialogAction } from "../ui/dialog";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { tryOpenExternalUrl } from "../../lib/openExternal";
import { isAdeAvailable } from "../../lib/adeAvailability";
import {
  canRetryReport,
  captureReportEvent,
  createReportDraft,
  formatReportSize,
  reportBridge,
  useReportDraftState,
  type ReportDraft,
  type ReportDraftState,
} from "./reportDraft";

export type SentReport = Extract<DiagnosticsManualSendResult, { ok: true }>;

/**
 * "Report this error to ADE…": the one dialog every error surface opens.
 *
 * It lives in its own React root, like the confirm dialogs, so it stays open
 * when the toast or banner that opened it times out or goes away, and on a
 * crash screen whose app tree is gone. One at a time: it is modal.
 *
 * The dialog reports about this window and this computer, whatever machine
 * the screen was showing, so nothing here takes a pin.
 */

type Session = {
  key: string;
  context: DiagnosticReportRequestPayload;
  draft: ReportDraft;
  /** Changes each time the dialog opens, so its body remounts clean. */
  openId: number;
};

let session: Session | null = null;
let openCount = 0;
/**
 * Each failure's successful send, so its notice can show the reference after
 * the dialog closes. Only for `SENT_REPORT_TTL_MS`: the same failure later on
 * is a new event, and it gets a new report rather than the old reference and
 * a disabled button.
 */
const sentByKey = new Map<string, { result: SentReport; sentAtMs: number }>();
const SENT_REPORT_TTL_MS = 10 * 60_000;
/** A note typed for a failure whose dialog closed without a send. */
const notesByKey = new Map<string, string>();
const KEYS_CAP = 50;
const listeners = new Set<() => void>();
let version = 0;

function emit(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > KEYS_CAP) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

let hostRoot: Root | null = null;

function ensureHost(): void {
  if (hostRoot || typeof document === "undefined") return;
  const container = document.createElement("div");
  container.setAttribute("data-ade-report-dialog-host", "");
  document.body.appendChild(container);
  hostRoot = createRoot(container);
  hostRoot.render(<ReportDialogHost />);
}

/** The identity of one failure: a new failure starts with no result. */
export function reportKeyOf(context: DiagnosticReportRequestPayload): string {
  return [
    context.surface,
    context.headline ?? "",
    context.code ?? "",
    context.technicalDetail ?? "",
    // The same text in another project, or for another captured error, is
    // another failure: it has its own note and its own sent state.
    context.projectRoot ?? "",
    context.sentryEventId ?? "",
  ].join("\u0000");
}

/** Opens the dialog for this failure and starts building its report. Sends nothing. */
export function openReportDialog(context: DiagnosticReportRequestPayload): void {
  if (session) return;
  const key = reportKeyOf(context);
  const draft = createReportDraft(context, {
    note: notesByKey.get(key) ?? "",
    onSent: (result) => {
      notesByKey.delete(key);
      remember(sentByKey, key, { result, sentAtMs: Date.now() });
      emit();
    },
  });
  openCount += 1;
  session = { key, context, draft, openId: openCount };
  ensureHost();
  captureReportEvent("report_dialog", "opened");
  emit();
  void draft.prepare();
}

/** Esc, Cancel, Done, ×. A report not yet sent is dropped and costs nothing. */
export function closeReportDialog(): void {
  const current = session;
  if (!current) return;
  const state = current.draft.getState();
  if (state.phase === "sending") return;
  if (state.phase === "sent") {
    captureReportEvent("report_dialog", "completed");
  } else {
    captureReportEvent("report_dialog", "cancelled");
    if (state.note.trim()) remember(notesByKey, current.key, state.note);
    else notesByKey.delete(current.key);
    current.draft.discard();
  }
  session = null;
  emit();
}

/** This failure's successful send, if any, and whether its dialog is open. */
export function useReportDialogFor(context: DiagnosticReportRequestPayload): { sent: SentReport | null; open: boolean } {
  const key = reportKeyOf(context);
  useSyncExternalStore(subscribe, () => version, () => version);
  const sent = sentByKey.get(key);
  // Checked on read, with no timer: an expired entry reads as never sent.
  const fresh = sent && Date.now() - sent.sentAtMs < SENT_REPORT_TTL_MS ? sent.result : null;
  return { sent: fresh, open: session?.key === key };
}

/** Opens the public GitHub issue for a sent report. Records whether it opened. */
export async function openPublicIssue(sent: SentReport): Promise<boolean> {
  if (!sent.publicIssueUrl) return false;
  const opened = await tryOpenExternalUrl(sent.publicIssueUrl);
  captureReportEvent("github_issue", opened ? "opened" : "failed");
  return opened;
}

function ReportDialogHost(): JSX.Element | null {
  useSyncExternalStore(subscribe, () => version, () => version);
  const current = session;
  if (!current) return null;
  return <ReportIssueDialog key={current.openId} draft={current.draft} onClose={closeReportDialog} />;
}

const TEXT_2 = "var(--color-muted-fg)";
const WARN = "var(--kit-warn, var(--color-warning, #b7791f))";
const EDGE = "color-mix(in srgb, var(--color-border) 88%, var(--color-fg) 12%)";
/** A text link inside a sentence. */
const INLINE_LINK: CSSProperties = {
  background: "transparent",
  border: "none",
  padding: 0,
  color: "var(--color-fg)",
  textDecoration: "underline",
  textUnderlineOffset: 2,
  cursor: "pointer",
  font: "inherit",
};

function ReportIssueDialog({ draft, onClose }: { draft: ReportDraft; onClose: () => void }): JSX.Element {
  const state = useReportDraftState(draft);
  const bridge = reportBridge();
  const canSend = bridge.send !== null;
  const { copy: copyText, copied } = useCopyToClipboard();
  const sent = state.phase === "sent" && state.result?.ok ? state.result : null;
  const sending = state.phase === "sending";

  const actions: DialogAction[] = (() => {
    if (sent) return [{ label: "Done", variant: "solid", autoFocus: true, onClick: onClose }];
    if (!canSend) {
      return [
        { label: "Close", variant: "secondary", onClick: onClose },
        {
          label: copied ? "Copied" : "Copy report",
          variant: "solid",
          icon: copied ? <Check size={12} weight="bold" /> : <Copy size={12} />,
          disabled: !state.prepared,
          onClick: () => {
            const report = state.prepared?.report;
            if (!report) return;
            void copyText(report).then((ok) => captureReportEvent("report_copied", ok ? "completed" : "failed"));
          },
        },
      ];
    }
    const failedForGood = state.phase === "send_failed" && !canRetryReport(state.result);
    if (failedForGood) return [{ label: "Close", variant: "solid", onClick: onClose }];
    return [
      { label: "Cancel", variant: "secondary", disabled: sending, onClick: onClose },
      {
        label: sending ? "Sending…" : state.phase === "send_failed" ? "Try again" : "Send",
        variant: "solid",
        busy: sending,
        disabled: !state.prepared || (state.phase !== "ready" && state.phase !== "send_failed"),
        onClick: () => void draft.send(),
      },
    ];
  })();

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={sent ? "Report sent" : "Report this error to ADE"}
      description={
        sent
          ? undefined
          : canSend
            ? "It goes to the ADE team, privately. Nothing is sent until you press Send."
            : "This window can't send reports. You can copy the report and send it to the ADE team privately."
      }
      size="md"
      // A fixed top edge: the body changes height from building to preview to
      // sent, so the header does not move each time.
      placement="top"
      // Above the toast stack: the error toast that opened this dialog stays
      // up (it shows the reference after a send), and neither it nor a later
      // toast may cover Send. This dialog shows its own results, never a toast.
      layer="dialogOverToasts"
      // A column, so a short window squeezes the preview box first and the
      // footer with Send stays in view.
      bodyStyle={{ display: "flex", flexDirection: "column" }}
      dismissible={!sending}
      focusKey={sent ? "sent" : "draft"}
      testId="report-issue-dialog"
      actions={actions}
      // Beside the buttons, so a short window that scrolls the body never
      // hides why Send became "Try again" or "Close".
      footerStart={sent ? undefined : <DraftStatus state={state} canSend={canSend} />}
    >
      {sent ? <SentBody sent={sent} /> : <DraftBody draft={draft} state={state} canSend={canSend} noteAvailable={bridge.noteAvailable} />}
    </Dialog>
  );
}

function DraftBody({
  draft,
  state,
  canSend,
  noteAvailable,
}: {
  draft: ReportDraft;
  state: ReportDraftState;
  canSend: boolean;
  noteAvailable: boolean;
}): JSX.Element {
  const noteId = useId();
  const noteMax = state.prepared?.noteMaxChars ?? 2_000;
  // The web client's note shares one Sentry note with the report, so a long
  // report can leave it no room.
  const showNote = canSend && noteAvailable && noteMax > 0;
  const note = state.note;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, paddingBottom: 6, flex: "0 1 auto", minHeight: 0 }}>
      {showNote ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
          <label htmlFor={noteId} data-ph-unmask="" style={{ fontSize: 12, fontWeight: 600, color: "var(--color-fg)" }}>
            What were you doing? <span style={{ fontWeight: 400, color: TEXT_2 }}>Optional</span>
          </label>
          <textarea
            id={noteId}
            className="ade-dialog-input"
            value={note}
            maxLength={noteMax}
            rows={3}
            disabled={state.phase === "sending"}
            onChange={(event) => draft.setNote(event.target.value)}
            placeholder="For example: I pressed Push and this came up."
            style={{ height: "auto", minHeight: 64, padding: "7px 10px", lineHeight: 1.45, resize: "vertical" }}
          />
        </div>
      ) : null}

      <ReportPreview state={state} onRetry={() => void draft.prepare()} />

      {!canSend ? (
        <p data-ph-unmask="" style={{ margin: 0, flexShrink: 0, fontSize: 12, color: TEXT_2 }}>
          Send it to the ADE team in a private message. Don't post it on a public page: it describes your computer.
        </p>
      ) : null}
    </div>
  );
}

/** Why the footer's button changed: a failed send, or a report that was rebuilt. */
function DraftStatus({ state, canSend }: { state: ReportDraftState; canSend: boolean }): JSX.Element | null {
  const failure = state.phase === "send_failed" && state.result && !state.result.ok ? state.result : null;
  const style: CSSProperties = { margin: 0, fontSize: 12, lineHeight: 1.45, color: WARN, overflowWrap: "anywhere" };
  if (failure) {
    const revealReport = window.ade?.diagnostics?.revealReport;
    const savedCopy = failure.reportPath && isAdeAvailable(revealReport) ? failure.reportPath : null;
    return (
      <p role="alert" data-ph-unmask="" style={style}>
        {describeManualSendFailure(failure)}
        {savedCopy ? (
          <>
            {" "}
            <button type="button" onClick={() => void revealReport?.(savedCopy)} style={INLINE_LINK}>
              Show the file
            </button>
          </>
        ) : null}
      </p>
    );
  }
  if (canSend && state.rebuilt && state.phase === "ready") {
    return (
      <p role="status" data-ph-unmask="" style={style}>
        That report was out of date, so ADE made a new one. Check it, then press Send again.
      </p>
    );
  }
  return null;
}

/**
 * The note as ADE sends it: cut to the room the report leaves, then the same
 * scrub main (`sentry/userFeedback.ts`) and the web client run, so secrets,
 * email addresses and paths read as removed here too.
 */
function noteAsSent(note: string, maxChars: number): string {
  const trimmed = note.trim();
  if (!trimmed || maxChars <= 0) return "";
  return scrubFreeText(trimmed.slice(0, maxChars), { maxLength: maxChars }).slice(0, maxChars);
}

/**
 * Exactly what ADE gets: the person's note, then the report text that the
 * send uploads byte for byte. Masked in session replay (no `data-ph-unmask`
 * on the text), selectable, and scrollable inside a fixed height.
 */
export function ReportPreview({
  state,
  onRetry,
}: {
  state: Pick<ReportDraftState, "phase" | "prepared" | "note">;
  onRetry: () => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const prepared = state.prepared;
  const note = prepared ? noteAsSent(state.note, prepared.noteMaxChars) : "";
  const preparing = state.phase === "preparing" || state.phase === "idle";
  return (
    <section
      aria-label="What ADE gets"
      style={{
        // In a column parent this box gives up height first, down to its
        // header and a few lines; the text scrolls inside it.
        display: "flex",
        flexDirection: "column",
        flex: "0 1 auto",
        minHeight: 112,
        border: `1px solid ${EDGE}`,
        borderRadius: 10,
        overflow: "hidden",
        background: "color-mix(in srgb, var(--color-fg) 3%, transparent)",
      }}
    >
      <div
        data-ph-unmask=""
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexShrink: 0,
          padding: "7px 10px 7px 12px",
          borderBottom: `1px solid ${EDGE}`,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--color-fg)" }}>What ADE gets</span>
        <span style={{ marginLeft: "auto", fontSize: 11.5, color: TEXT_2, fontVariantNumeric: "tabular-nums" }}>
          {prepared ? formatReportSize(prepared.bytes) : preparing ? "Building…" : ""}
        </span>
        {prepared ? (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            className="ade-notice-btn"
            style={{
              fontSize: 11.5,
              fontWeight: 500,
              color: "var(--color-secondary-fg, var(--color-fg))",
              background: "transparent",
              border: "none",
              padding: "0 2px",
              cursor: "pointer",
              textDecoration: "underline",
              textUnderlineOffset: 2,
            }}
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        ) : null}
      </div>

      {note && prepared ? (
        <div style={{ flexShrink: 0, maxHeight: 96, overflowY: "auto", padding: "8px 12px", borderBottom: `1px solid ${EDGE}` }}>
          <div data-ph-unmask="" style={{ fontSize: 11, fontWeight: 600, color: TEXT_2, marginBottom: 2 }}>Your note</div>
          <div data-ph-mask="" style={{ fontSize: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "var(--color-fg)" }}>{note}</div>
        </div>
      ) : null}

      {prepared ? (
        <pre
          data-ph-mask=""
          tabIndex={0}
          aria-label="Report text"
          style={{
            margin: 0,
            flex: "0 1 auto",
            minHeight: 0,
            padding: "9px 12px",
            maxHeight: expanded ? "min(380px, 42vh)" : 168,
            overflow: "auto",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)",
            fontSize: 11,
            lineHeight: 1.55,
            color: "var(--color-secondary-fg, var(--color-fg))",
            userSelect: "text",
            outline: "none",
          }}
        >
          {prepared.report}
        </pre>
      ) : preparing ? (
        <div role="status" aria-live="polite" style={{ padding: "12px 12px 14px", display: "flex", flexDirection: "column", gap: 7 }}>
          <span className="ade-dialog-sr-only">Building the report</span>
          {[92, 64, 78, 40, 70].map((width, index) => (
            <span
              key={index}
              aria-hidden="true"
              className="motion-safe:animate-pulse"
              style={{
                display: "block",
                height: 8,
                width: `${width}%`,
                borderRadius: 4,
                background: "color-mix(in srgb, var(--color-fg) 9%, transparent)",
              }}
            />
          ))}
        </div>
      ) : (
        <div role="alert" data-ph-unmask="" style={{ padding: "12px", fontSize: 12, color: WARN }}>
          ADE couldn't build the report.{" "}
          <button type="button" onClick={onRetry} style={INLINE_LINK}>
            Try again
          </button>
        </div>
      )}
    </section>
  );
}

/** The reference, a copy control, what happens next, and the public issue. */
function SentBody({ sent }: { sent: SentReport }): JSX.Element {
  const { copy, copied } = useCopyToClipboard();
  const [issueFailed, setIssueFailed] = useState(false);
  useEffect(() => setIssueFailed(false), [sent.reference]);
  return (
    <div data-ph-unmask="" style={{ display: "flex", flexDirection: "column", gap: 12, paddingBottom: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <CheckCircle size={18} weight="fill" style={{ color: "var(--color-success, #2f9e5a)", flexShrink: 0 }} aria-hidden="true" />
        <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--color-fg)" }}>
          Sent. Reference{" "}
          <span style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)", letterSpacing: "0.02em" }}>{sent.reference}</span>
        </span>
        <button
          type="button"
          className="ade-notice-btn"
          onClick={() => void copy(sent.reference)}
          aria-label={copied ? "Reference copied" : "Copy the reference"}
          title="Copy the reference"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            height: 22,
            padding: "0 8px",
            borderRadius: 999,
            border: `1px solid ${EDGE}`,
            background: "transparent",
            color: "var(--color-secondary-fg, var(--color-fg))",
            fontSize: 11.5,
            cursor: "pointer",
          }}
        >
          {copied ? <Check size={11} weight="bold" /> : <Copy size={11} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p style={{ margin: 0, fontSize: 12.5, color: "var(--color-secondary-fg, var(--color-fg))" }}>
        The ADE team reads every report. If you contact ADE support, quote this reference.
      </p>
      {sent.publicIssueUrl ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 3, paddingTop: 10, borderTop: `1px solid ${EDGE}` }}>
          <button
            type="button"
            onClick={() => void openPublicIssue(sent).then((opened) => setIssueFailed(!opened))}
            style={{ alignSelf: "flex-start", background: "transparent", border: "none", padding: 0, color: "var(--color-fg)", fontSize: 12.5, fontWeight: 500, textDecoration: "underline", textUnderlineOffset: 2, cursor: "pointer" }}
          >
            Open a public GitHub issue
          </button>
          <span style={{ fontSize: 11.5, color: TEXT_2 }}>
            Optional. Anyone can read it, so it holds only the reference, the ADE version and your OS.
          </span>
          {issueFailed ? (
            <span role="alert" style={{ fontSize: 11.5, color: WARN }}>The GitHub page didn't open.</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

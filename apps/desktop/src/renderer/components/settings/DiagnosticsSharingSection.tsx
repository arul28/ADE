import { useEffect, useState } from "react";
import { describeManualSendFailure } from "../../../shared/diagnosticsUpload";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { openPublicIssue, ReportPreview } from "../app/ReportIssueDialog";
import {
  canRetryReport,
  createReportDraft,
  reportBridge,
  useReportDraftState,
  type ReportDraft,
} from "../app/reportDraft";
import { ModernRow, ModernRows, ModernSection } from "./primitives";

/**
 * The one place a person can send ADE a report on purpose.
 *
 * Automatic reports are not a setting here. ADE sends them by itself when a
 * failure it has already classified happens, unless `DO_NOT_TRACK=1` is set.
 * This section only offers the button.
 *
 * Every other "Report this error to ADE…" button sits on a screen that has
 * already broken — a crash boundary, a recovery screen, a failed repair — so a
 * user whose app merely FEELS wrong had nowhere to press. That button has to
 * exist somewhere they can always reach.
 */
export function DiagnosticsSharingSection() {
  return (
    <ModernSection
      group="Send a report"
      anchor="diagnostics-sharing"
      title="Send a report to ADE"
      hint="Send ADE a report about how it is behaving, so it can be looked at."
    >
      <ModernRows>
        <ManualDiagnosticsSend />
      </ModernRows>
    </ModernSection>
  );
}

/**
 * Settings' draft, kept outside the section while a send runs or after it
 * answered: leaving Settings during a send must not drop the reference of a
 * report that reached ADE, nor offer the same report again on return. A sent
 * report's answer is shown for `SENT_REPORT_TTL_MS`, as for an error screen's.
 */
const SENT_REPORT_TTL_MS = 10 * 60_000;
let keptDraft: { draft: ReportDraft; sentAtMs: number | null } | null = null;

function settingsDraft(): ReportDraft {
  const kept = keptDraft;
  if (kept) {
    const { phase } = kept.draft.getState();
    const sentRecently = phase === "sent" && kept.sentAtMs !== null && Date.now() - kept.sentAtMs < SENT_REPORT_TTL_MS;
    // A send that answered while Settings was closed shows its answer too.
    if (phase === "sending" || phase === "send_failed" || sentRecently) return kept.draft;
    kept.draft.discard();
  }
  const holder: { draft: ReportDraft; sentAtMs: number | null } = {
    draft: createReportDraft(undefined, {
      onSent: () => {
        holder.sentAtMs = Date.now();
      },
    }),
    sentAtMs: null,
  };
  keptDraft = holder;
  return holder.draft;
}

/** Leaving Settings drops a report nobody sent; a send running or answered stays. */
function releaseSettingsDraft(draft: ReportDraft): void {
  if (keptDraft?.draft !== draft) return;
  const { phase } = draft.getState();
  if (phase === "sending" || phase === "sent") return;
  keptDraft = null;
  draft.discard();
}

/**
 * "Send a report to ADE", for when nothing is visibly broken.
 *
 * Everything that matters happens in the main process — building the report,
 * redacting it, the per-device manual budget, the upload — because a renderer
 * cannot be trusted with any of it and because this must be the SAME report the
 * error screens send. The first press builds the report and shows it here
 * (nothing is sent, nothing is spent); "Send" uploads exactly that text.
 */
function ManualDiagnosticsSend() {
  const bridge = reportBridge();
  const [draft] = useState(settingsDraft);
  const state = useReportDraftState(draft);
  const { copy, copied } = useCopyToClipboard();
  const [issueFailed, setIssueFailed] = useState(false);
  useEffect(() => () => releaseSettingsDraft(draft), [draft]);

  // An older preload has no report bridge; offering a button that cannot
  // work is worse than offering none.
  if (!bridge.prepare || !bridge.send) return null;

  // The person's own words, sent beside the report as Sentry User Feedback.
  // Offered only where that reaches ADE (main's Sentry client is running).
  const noteAvailable = bridge.noteAvailable;
  const { phase, result } = state;
  const reviewing = phase === "preparing" || phase === "prepare_failed" || phase === "ready" || phase === "sending" || phase === "send_failed";
  const sent = phase === "sent" && result?.ok ? result : null;
  const failure = phase === "send_failed" && result && !result.ok ? result : null;
  const reportPath = sent?.reportPath || failure?.reportPath || "";
  const canPressSend = phase === "ready" || (phase === "send_failed" && canRetryReport(result));

  return (
    <ModernRow
      title="Send a report now"
      hint="Sends the same report as an error screen's report: versions, recent ADE logs and the failure code. Paths, names, emails and keys are removed; never your code or chats. You see it before it goes."
      control={(
        <button
          type="button"
          onClick={() => void (reviewing ? draft.send() : draft.prepare())}
          disabled={reviewing && !canPressSend}
          className="ade-modern-btn"
        >
          {phase === "sending"
            ? "Sending…"
            : reviewing
              ? phase === "send_failed" ? "Try again" : "Send"
              : "Send a report to ADE…"}
        </button>
      )}
    >
      {noteAvailable ? (
        <textarea
          aria-label="What went wrong (optional)"
          value={state.note}
          onChange={(event) => draft.setNote(event.target.value)}
          maxLength={state.prepared?.noteMaxChars ?? 2000}
          rows={3}
          disabled={phase === "sending"}
          placeholder="What went wrong? (optional) Sent with the report."
          style={{
            width: "100%",
            resize: "vertical",
            padding: "6px 8px",
            borderRadius: 6,
            border: "1px solid var(--kit-panel-edge)",
            background: "var(--kit-panel-bg)",
            color: "inherit",
            font: "inherit",
            fontSize: 12,
          }}
        />
      ) : null}
      {reviewing ? (
        <>
          <ReportPreview state={state} onRetry={() => void draft.prepare()} />
          {state.rebuilt && phase === "ready" ? (
            <p role="status" className="ade-modern-warn">That report was out of date, so ADE made a new one. Check it, then press Send again.</p>
          ) : null}
          <p className="ade-modern-muted" style={{ color: "var(--kit-text-2)" }}>
            It goes to the ADE team, privately. Nothing is sent until you press Send.{" "}
            <button type="button" className="ade-modern-btn" data-variant="link" disabled={phase === "sending"} onClick={() => draft.discard()}>
              Cancel
            </button>
          </p>
        </>
      ) : null}
      {sent || failure ? (
        <p role="status" className={sent ? "ade-modern-muted" : "ade-modern-warn"} style={sent ? { color: "var(--kit-text-2)" } : undefined}>
          {sent
            ? `Sent. Reference ${sent.reference}. The ADE team reads it; quote the reference if you contact support.`
            : describeManualSendFailure(failure!)}
          {sent ? (
            <>
              {" "}
              <button type="button" className="ade-modern-btn" data-variant="link" onClick={() => void copy(sent.reference)}>
                {copied ? "Copied" : "Copy reference"}
              </button>
              {sent.publicIssueUrl ? (
                <>
                  {" "}
                  <button
                    type="button"
                    className="ade-modern-btn"
                    data-variant="link"
                    onClick={() => void openPublicIssue(sent).then((opened) => setIssueFailed(!opened))}
                  >
                    Open a public GitHub issue
                  </button>
                </>
              ) : null}
              {issueFailed ? " The GitHub page didn't open." : null}
            </>
          ) : null}
          {reportPath ? (
            <>
              {" "}
              <button type="button" className="ade-modern-btn" data-variant="link" onClick={() => void window.ade?.diagnostics?.revealReport(reportPath)}>
                View report
              </button>
            </>
          ) : null}
        </p>
      ) : null}
    </ModernRow>
  );
}

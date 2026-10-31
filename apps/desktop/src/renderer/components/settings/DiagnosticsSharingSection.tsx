import { useState } from "react";
import type { DiagnosticsManualSendResult } from "../../../shared/types/diagnostics";
import { describeManualSendFailure } from "../../../shared/diagnosticsUpload";
import { ModernRow, ModernRows, ModernSection } from "./primitives";

/**
 * The one place a person can send ADE a report on purpose.
 *
 * Automatic reports are not a setting here. ADE sends them by itself when a
 * failure it has already classified happens, unless `DO_NOT_TRACK=1` is set.
 * This section only offers the button.
 *
 * Every other "Report issue" button in the app sits on a screen that has
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
 * "Send a report to ADE", for when nothing is visibly broken.
 *
 * Everything that matters happens in the main process — building the report,
 * redacting it, the per-device manual budget, the upload — because a renderer
 * cannot be trusted with any of it and because this must be the SAME report the
 * error screens send. This component only presses the button and reads the
 * answer back honestly.
 */
function ManualDiagnosticsSend() {
  const bridge = window.ade?.diagnostics;
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<DiagnosticsManualSendResult | null>(null);
  // The person's own words, sent beside the report as Sentry User Feedback.
  // Offered only where that reaches ADE (main's Sentry client is running).
  const [note, setNote] = useState("");
  const noteAvailable = bridge?.userFeedbackAvailable === true;

  // An older preload has no `sendManual`; offering a button that cannot work is
  // worse than offering none.
  if (!bridge?.sendManual) return null;

  const send = async () => {
    if (sending) return;
    setSending(true);
    setResult(null);
    try {
      const userMessage = noteAvailable ? note.trim() : "";
      const sent = await bridge.sendManual!(undefined, userMessage ? { userMessage } : undefined);
      setResult(sent);
      if (sent.ok) setNote("");
    } catch {
      setResult({ ok: false, reason: "failed" });
    } finally {
      setSending(false);
    }
  };

  const reportPath = result?.reportPath ?? "";

  return (
    <ModernRow
      title="Send a report now"
      hint="Sends the same report as “Report issue”: versions, recent ADE logs and the failure code. Paths, names, emails and keys are removed; never your code or chats."
      control={(
        <button
          type="button"
          onClick={() => void send()}
          disabled={sending}
          className="ade-modern-btn"
        >
          {sending ? "Sending…" : "Send a report to ADE"}
        </button>
      )}
    >
      {noteAvailable ? (
        <textarea
          aria-label="What went wrong (optional)"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={2000}
          rows={3}
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
      {result ? (
        <p role="status" className={result.ok ? "ade-modern-muted" : "ade-modern-warn"} style={result.ok ? { color: "var(--kit-text-2)" } : undefined}>
          {result.ok
            ? `Report sent. Reference ${result.reference} — quote it if you get in touch.`
            : describeManualSendFailure(result)}
          {reportPath ? (
            <>
              {" "}
              <button type="button" className="ade-modern-btn" data-variant="link" onClick={() => void bridge.revealReport(reportPath)}>
                View report
              </button>
            </>
          ) : null}
        </p>
      ) : null}
    </ModernRow>
  );
}

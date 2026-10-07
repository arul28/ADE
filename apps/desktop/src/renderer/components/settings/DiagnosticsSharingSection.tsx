import { useEffect, useState } from "react";
import type {
  DiagnosticsManualSendResult,
  DiagnosticsSharingStatus,
} from "../../../shared/types/diagnostics";
import { ModernRow, ModernRows, ModernSection, SettingsToggle } from "./primitives";

/**
 * The off switch for automatic diagnostic reports — and the one place a user
 * can send one on purpose.
 *
 * This is a consent control, so it reads the real persisted state rather than
 * assuming, and it says plainly what gets sent and how often. `getSharing` /
 * `setSharing` may be absent on a preload that predates the setting: the
 * switch then renders in its default position and stays disabled rather than
 * pretending to work.
 *
 * The manual send is here because the copy below already promised it. Every
 * other "Report issue" button in the app lives on a screen that has already
 * broken — a crash boundary, a recovery screen, a failed repair — so a user
 * whose app merely FEELS wrong had nowhere to press, while this section told
 * them ADE sends "the same report the Report issue button makes". That button
 * has to exist somewhere they can always reach.
 */
export function DiagnosticsSharingSection() {
  const bridge = window.ade?.diagnostics;
  const [status, setStatus] = useState<DiagnosticsSharingStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!bridge) return;
    void bridge.getSharing()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {
        if (!cancelled) setError("This setting is unavailable right now.");
      });
    return () => {
      cancelled = true;
    };
    // `bridge` is the preload object; it is stable for the life of the window,
    // and re-running on identity alone would refetch on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setEnabled = async (enabled: boolean) => {
    if (saving || !bridge) return;
    setSaving(true);
    setError(null);
    try {
      setStatus(await bridge.setSharing(enabled));
    } catch {
      setError("ADE could not save this setting.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModernSection
      group="Diagnostics sharing"
      anchor="diagnostics-sharing"
      title="Diagnostics sharing"
      hint="Send ADE a report when something breaks, so it can be fixed."
    >
      <ModernRows>
        <ModernRow
          title="Share diagnostics with ADE when something breaks"
          hint={'ADE sends the same report the "Report issue" button makes: app and system versions, recent ADE logs, disk space and the failure code. Paths, names, emails and credentials are removed first. Never your code, chats or terminal output.'}
          control={
            <SettingsToggle
              label="Share diagnostics with ADE when something breaks"
              checked={status?.enabled ?? true}
              disabled={!status || saving}
              onChange={(enabled) => void setEnabled(enabled)}
            />
          }
        >
          <p className="ade-modern-muted">
            {`At most ${status?.limit ?? 3} a day, one per problem. You get a message every time one is sent.`}
          </p>
          {error ? <p role="alert" className="ade-modern-error" style={{ marginTop: 6 }}>{error}</p> : null}
        </ModernRow>
        <ManualDiagnosticsSend sharingEnabled={status?.enabled ?? true} />
      </ModernRows>
    </ModernSection>
  );
}

/**
 * One short sentence per outcome, and never a status code.
 *
 * The two refusals a person can act on differently are deliberately worded
 * differently: `rate_limited` is the account directory saying THIS computer has
 * stored its allowance today, `unavailable` is it saying it is not taking
 * reports from anyone right now. The route answers those as two distinct 429
 * bodies precisely so a client can tell them apart, and telling someone to come
 * back tomorrow when the truth is "ADE is full" would waste their time.
 */
function describeManualSendFailure(result: Extract<DiagnosticsManualSendResult, { ok: false }>): string {
  switch (result.reason) {
    case "local_limit":
      return `You've already sent ${result.limit ?? 5} reports from this computer today. Try again tomorrow.`;
    case "rate_limited":
      return "You've already sent several reports today. Try again tomorrow.";
    case "unavailable":
      return "ADE isn't accepting reports right now. Try again later.";
    case "too_large":
      // Two situations, and only one of them leaves the user something to do.
      // The local copy is written before the upload is attempted, so it usually
      // exists — but when it could not be written the main process answers
      // without a path, and telling someone to open a file that is not there
      // sends them looking for it. The offer is made only when it is real.
      return result.reportPath
        ? "This report is too big to send. It's saved on this computer — open it and attach it to a GitHub issue."
        : "This report is too big to send, and ADE couldn't save a copy on this computer.";
    default:
      return "ADE couldn't send the report. Check your connection and try again.";
  }
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
function ManualDiagnosticsSend({ sharingEnabled }: { sharingEnabled: boolean }) {
  const bridge = window.ade?.diagnostics;
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<DiagnosticsManualSendResult | null>(null);

  // An older preload has no `sendManual`; offering a button that cannot work is
  // worse than offering none.
  if (!bridge?.sendManual) return null;

  const send = async () => {
    if (sending) return;
    setSending(true);
    setResult(null);
    try {
      setResult(await bridge.sendManual!());
    } catch {
      setResult({ ok: false, reason: "failed" });
    } finally {
      setSending(false);
    }
  };

  const reportPath = result?.ok ? result.reportPath : result?.reportPath ?? "";

  return (
    <ModernRow
      title="Send a report now"
      hint="Something feels wrong but nothing has broken? Send one now."
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
      {/*
        Consent, said out loud rather than quietly contradicted. A deliberate
        click sends whether or not automatic sharing is on — the toggle is about
        what ADE does BY ITSELF, and a user who turned it off still deserves a
        way to ask for help — but they must never be able to mistake this click
        for switching background reporting back on.
      */}
      {sharingEnabled && !result ? null : (
        <div className="ade-modern-stack" style={{ gap: 6 }}>
          {sharingEnabled ? null : (
            <p className="ade-modern-muted">
              Automatic reports are off. This sends one report, now. It does not turn
              automatic reports back on.
            </p>
          )}

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
        </div>
      )}
    </ModernRow>
  );
}

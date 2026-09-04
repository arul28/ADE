import React, { useState } from "react";
import { Lifebuoy } from "@phosphor-icons/react";
import type {
  DiagnosticsManualSendResult,
  DiagnosticsSharingStatus,
} from "../../../shared/types/diagnostics";
import { describeManualDiagnosticsSendFailure } from "../../../shared/diagnosticsManualSend";
import { COLORS, SANS_FONT, outlineButton } from "../lanes/laneDesignTokens";
import { ConsentToggleSection } from "./settingsSectionUi";

/**
 * The off switch for automatic diagnostic reports — and the one place a user
 * can send one on purpose.
 *
 * Same shape as the analytics section next to it, and now literally the same
 * component: this is a consent control, so it reads the real persisted state
 * rather than assuming, and it says plainly what gets sent and how often.
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
  return (
    <ConsentToggleSection<DiagnosticsSharingStatus>
      id="diagnostics-sharing"
      title="Diagnostics sharing"
      description="Send ADE a report when something breaks, so it can be fixed."
      icon={Lifebuoy}
      brandColor="#60A5FA"
      label="Share diagnostics with ADE when something breaks"
      body={'ADE sends the same report the "Report issue" button makes: app and system versions, recent ADE logs, disk space and the failure code. Paths, names, emails and credentials are removed first. Never your code, chats or terminal output.'}
      footnote={(status) =>
        `At most ${status?.limit ?? 3} a day, one per problem. You get a message every time one is sent.`}
      read={bridge ? () => bridge.getSharing() : undefined}
      write={bridge ? (enabled) => bridge.setSharing(enabled) : undefined}
      readErrorMessage="This setting is unavailable right now."
      writeErrorMessage="ADE could not save this setting."
    >
      {(status) => <ManualDiagnosticsSend sharingEnabled={status?.enabled ?? true} />}
    </ConsentToggleSection>
  );
}

const NOTE_STYLE: React.CSSProperties = {
  margin: "8px 0 0",
  color: COLORS.textMuted,
  fontFamily: SANS_FONT,
  fontSize: 11,
  lineHeight: 1.5,
};

const LINK_STYLE: React.CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  color: COLORS.textSecondary,
  cursor: "pointer",
  font: "inherit",
  textDecoration: "underline",
};

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
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => void send()}
          disabled={sending}
          style={outlineButton({ opacity: sending ? 0.6 : 1, cursor: sending ? "default" : "pointer" })}
        >
          {sending ? "Sending…" : "Send a report to ADE"}
        </button>
        <span style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 12 }}>
          Something feels wrong but nothing has broken? Send one now.
        </span>
      </div>

      {/*
        Consent, said out loud rather than quietly contradicted. A deliberate
        click sends whether or not automatic sharing is on — the toggle is about
        what ADE does BY ITSELF, and a user who turned it off still deserves a
        way to ask for help — but they must never be able to mistake this click
        for switching background reporting back on.
      */}
      {sharingEnabled ? null : (
        <p style={NOTE_STYLE}>
          Automatic reports are off. This sends one report, now. It does not turn
          automatic reports back on.
        </p>
      )}

      {result ? (
        <p
          role="status"
          style={{ ...NOTE_STYLE, color: result.ok ? COLORS.textSecondary : COLORS.warning }}
        >
          {result.ok
            ? `Report sent. Reference ${result.reference} — quote it if you get in touch.`
            : describeManualDiagnosticsSendFailure(result)}
          {reportPath ? (
            <>
              {" "}
              <button type="button" style={LINK_STYLE} onClick={() => void bridge.revealReport(reportPath)}>
                View report
              </button>
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

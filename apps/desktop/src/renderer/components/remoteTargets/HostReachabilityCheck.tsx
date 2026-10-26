import { useCallback, useEffect, useRef, useState } from "react";
import { CircleNotch } from "@phosphor-icons/react";
import { outlineButton } from "../lanes/laneDesignTokens";
import { extractError } from "../../lib/format";
import type { HostReachabilityReport } from "../../../shared/connectionDiagnosis";
import { DiagnosisList, DiagnosisRow, DiagnosisSectionHead, type DiagnosisState } from "./DiagnosisRows";
import { helperTextStyle } from "./remoteTargetListStyles";

const TONE_STATE: Record<HostReachabilityReport["tone"], DiagnosisState> = {
  success: "ok",
  warning: "warning",
  danger: "failed",
  info: "off",
};

/**
 * "Can my other devices reach this computer?", asked of that computer's own
 * brain: is ADE listening, is the relay connected and does a test connection
 * through it come back, is Tailscale up or routing through an exit node that
 * blocks the relay, did ADE freeze there. Each part says what to do.
 *
 * Without `check` it asks the computer you are sitting at; a connected remote
 * machine passes its own call. The web client has neither and renders nothing.
 * With `heading`, it is a section of a larger panel: the heading carries the
 * button and the panel's own verdict stands in for the report's title.
 */
export function HostReachabilityCheck({
  check = window.ade?.sync?.checkLocalReachability,
  prompt = "Can your other devices reach this computer?",
  heading,
}: {
  check?: (() => Promise<HostReachabilityReport>) | undefined;
  prompt?: string;
  heading?: string;
} = {}) {
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<HostReachabilityReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const run = useCallback(async () => {
    if (!check) return;
    setRunning(true);
    setError(null);
    try {
      const next = await check();
      if (mountedRef.current) setReport(next);
    } catch (err) {
      if (mountedRef.current) setError(extractError(err));
    } finally {
      if (mountedRef.current) setRunning(false);
    }
  }, [check]);

  if (typeof check !== "function") return null;

  const button = (
    <button
      type="button"
      disabled={running}
      onClick={() => void run()}
      style={outlineButton({
        height: 24,
        padding: "0 10px",
        fontSize: 11,
        flexShrink: 0,
        gap: 6,
        opacity: running ? 0.6 : 1,
        cursor: running ? "default" : "pointer",
      })}
    >
      {running ? <CircleNotch size={12} weight="bold" className="animate-spin" /> : null}
      {running ? "Checking…" : report ? "Check again" : "Check"}
    </button>
  );

  return (
    <div data-host-reachability style={{ display: "grid", gap: 10, minWidth: 0 }}>
      {heading ? (
        <DiagnosisSectionHead label={heading} action={button} />
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ ...helperTextStyle, flex: 1, minWidth: 0 }}>{report ? null : prompt}</span>
          {report ? null : button}
        </div>
      )}

      {heading && !report && !error ? (
        <span style={helperTextStyle}>{prompt}</span>
      ) : null}

      {error ? (
        <div role="status" style={{ ...helperTextStyle, color: "var(--kit-crit)" }}>{error}</div>
      ) : null}

      {report && !heading ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, color: "var(--color-fg)" }}>
            {report.title}
          </span>
          {button}
        </div>
      ) : null}

      {report ? (
        <DiagnosisList label="Reachability checks">
          {report.checks.map((item) => (
            <DiagnosisRow
              key={item.id}
              state={item.state}
              label={item.label}
              detail={item.detail}
              fix={item.fix}
              tooltip={item.fix ? `${item.detail}\n${item.fix}` : item.detail}
            />
          ))}
        </DiagnosisList>
      ) : null}

      {report && heading && report.tone !== "success" ? (
        <span style={{ ...helperTextStyle, color: TONE_STATE[report.tone] === "failed" ? "var(--kit-crit)" : "var(--kit-text-2)" }}>
          {report.title}
        </span>
      ) : null}
    </div>
  );
}

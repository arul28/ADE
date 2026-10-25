import { useCallback, useEffect, useRef, useState } from "react";
import { CircleNotch } from "@phosphor-icons/react";
import { COLORS, SANS_FONT, outlineButton } from "../lanes/laneDesignTokens";
import { extractError } from "../../lib/format";
import type {
  HostReachabilityCheck as Check,
  HostReachabilityReport,
} from "../../../shared/connectionDiagnosis";
import { helperTextStyle } from "./remoteTargetListStyles";

const STATE_COLOR: Record<Check["state"], string> = {
  ok: COLORS.success,
  warning: COLORS.warning,
  failed: COLORS.danger,
  off: COLORS.textMuted,
};

const TONE_COLOR: Record<HostReachabilityReport["tone"], string> = {
  success: COLORS.success,
  warning: COLORS.warning,
  danger: COLORS.danger,
  info: COLORS.textSecondary,
};

/**
 * "Can my other devices reach this computer?", asked of this computer's own
 * brain: is ADE listening, is the relay connected and does a test connection
 * through it come back, is Tailscale up or routing through an exit node that
 * blocks the relay, did ADE freeze here. Each part says what to do.
 *
 * Only for the computer you are sitting at; the web client has no such check
 * and renders nothing.
 */
export function HostReachabilityCheck() {
  const check = window.ade?.sync?.checkLocalReachability;
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

  return (
    <div data-host-reachability style={{ display: "grid", gap: 8, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ ...helperTextStyle, flex: 1, minWidth: 0 }}>
          {report
            ? <span style={{ color: TONE_COLOR[report.tone] }}>{report.title}</span>
            : "Can your other devices reach this computer?"}
        </span>
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
      </div>

      {error ? (
        <div role="status" style={{ ...helperTextStyle, color: COLORS.danger }}>{error}</div>
      ) : null}

      {report ? (
        <div role="list" aria-label="Reachability checks" style={{ display: "grid", gap: 6 }}>
          {report.checks.map((item) => (
            <div
              key={item.id}
              role="listitem"
              style={{
                display: "grid",
                gridTemplateColumns: "7px minmax(0,1fr)",
                columnGap: 8,
                alignItems: "baseline",
                fontFamily: SANS_FONT,
                fontSize: 11.5,
                lineHeight: 1.45,
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 999,
                  background: STATE_COLOR[item.state],
                  transform: "translateY(-1px)",
                }}
              />
              <span style={{ minWidth: 0 }}>
                <span style={{ color: COLORS.textPrimary, fontWeight: 600 }}>{item.label}</span>
                <span style={{ color: COLORS.textSecondary }}> · {item.detail}</span>
                {item.fix && item.state !== "ok" ? (
                  <span style={{ display: "block", color: COLORS.textMuted }}>{item.fix}</span>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

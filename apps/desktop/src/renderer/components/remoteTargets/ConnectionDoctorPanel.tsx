import { useEffect, useState, type CSSProperties } from "react";
import { CheckCircle, CircleNotch, XCircle } from "@phosphor-icons/react";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import { extractError } from "../../lib/format";
import type { RemoteRuntimeDoctorCheck } from "../../../shared/types";

const wrapStyle: CSSProperties = {
  display: "grid",
  gap: 8,
  padding: "10px 12px",
  borderRadius: 8,
  border: `1px solid ${COLORS.border}`,
  background: "rgba(0,0,0,0.16)",
};

const rowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "16px minmax(0,1fr) auto",
  alignItems: "center",
  gap: 8,
  fontFamily: SANS_FONT,
  fontSize: 12,
};

function routeLabel(kind: RemoteRuntimeDoctorCheck["route"]): string {
  switch (kind) {
    case "lan":
      return "LAN";
    case "tailnet":
      return "Tailnet";
    case "relay":
      return "Relay";
    case "ssh":
      return "SSH";
    default:
      return kind;
  }
}

type ConnectionDoctorPanelProps = {
  /** Saved target id or discovered machine id, passed to runDoctor. */
  machineId: string;
};

/**
 * Inline reachability probe. Runs the connection doctor for a machine and lists
 * each candidate route with a pass/fail, latency, and error text — so "Test"
 * answers "why can't I connect" without leaving the panel.
 */
export function ConnectionDoctorPanel({ machineId }: ConnectionDoctorPanelProps) {
  const [checks, setChecks] = useState<RemoteRuntimeDoctorCheck[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setChecks(null);
    void (async () => {
      try {
        const result = await window.ade.remoteRuntime.runDoctor(machineId);
        if (cancelled) return;
        setChecks(result.checks);
      } catch (err) {
        if (cancelled) return;
        setError(extractError(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [machineId]);

  return (
    <div style={wrapStyle}>
      <div
        style={{
          color: COLORS.textPrimary,
          fontFamily: SANS_FONT,
          fontSize: 12,
          fontWeight: 600,
        }}
      >
        Connection test
      </div>

      {loading ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            color: COLORS.textMuted,
            fontFamily: SANS_FONT,
            fontSize: 12,
          }}
        >
          <CircleNotch size={14} weight="bold" className="animate-spin" />
          Probing routes…
        </div>
      ) : null}

      {error ? (
        <div style={{ color: COLORS.danger, fontFamily: SANS_FONT, fontSize: 12 }}>
          {error}
        </div>
      ) : null}

      {!loading && !error && checks && checks.length === 0 ? (
        <div style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 12 }}>
          No routes to test for this machine.
        </div>
      ) : null}

      {checks && checks.length > 0
        ? checks.map((check, index) => (
            <div key={`${check.route}:${check.endpoint}:${index}`} style={rowStyle}>
              {check.ok ? (
                <CheckCircle size={15} weight="fill" color={COLORS.success} />
              ) : (
                <XCircle size={15} weight="fill" color={COLORS.danger} />
              )}
              <div style={{ minWidth: 0 }}>
                <span style={{ color: COLORS.textPrimary }}>{routeLabel(check.route)}</span>
                <span
                  style={{
                    color: COLORS.textMuted,
                    marginLeft: 8,
                    overflowWrap: "anywhere",
                  }}
                >
                  {check.endpoint}
                </span>
                {check.error ? (
                  <div style={{ color: COLORS.danger, fontSize: 11.5, marginTop: 2 }}>
                    {check.error}
                  </div>
                ) : null}
              </div>
              <div
                style={{
                  color: check.ok ? COLORS.textSecondary : COLORS.textMuted,
                  fontVariantNumeric: "tabular-nums",
                  fontSize: 11.5,
                }}
              >
                {typeof check.latencyMs === "number"
                  ? `${Math.round(check.latencyMs)} ms`
                  : check.ok
                    ? "ok"
                    : "—"}
              </div>
            </div>
          ))
        : null}
    </div>
  );
}

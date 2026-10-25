import { useEffect, useState, type CSSProperties } from "react";
import { CheckCircle, CircleNotch, XCircle } from "@phosphor-icons/react";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import { extractError } from "../../lib/format";
import type {
  RemoteRuntimeDoctorCheck,
  RemoteRuntimeDoctorFailure,
  RemoteRuntimeDoctorResult,
} from "../../../shared/types";
import { HostStallNote } from "./HostStallNote";

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

/** The failing part, in a few words, beside the route's raw error. */
function failureLabel(failure: RemoteRuntimeDoctorFailure | undefined): string | null {
  switch (failure) {
    case "host_offline":
      return "Not connected to the relay";
    case "no_network":
      return "This computer is offline";
    case "timeout":
      return "No answer in time";
    case "unreachable":
      return "Nothing answered";
    case "pairing":
      return "Pairing out of date";
    case "authentication":
      return "Not signed in";
    case "identity":
      return "A different computer answered";
    case "capability":
    case "protocol":
      return "Different ADE version";
    case "superseded":
      return "Another connection took over";
    default:
      return null;
  }
}

const DIAGNOSIS_COLOR: Record<NonNullable<RemoteRuntimeDoctorResult["diagnosis"]>["tone"], string> = {
  success: COLORS.success,
  warning: COLORS.warning,
  danger: COLORS.danger,
};

type ConnectionDoctorPanelProps = {
  /** Saved target id or discovered machine id, passed to runDoctor. */
  machineId: string;
  /** For the freeze note ("Studio froze for 12s"). */
  machineName?: string | null;
};

/**
 * Inline reachability probe. Runs the connection doctor for a machine and lists
 * each candidate route with a pass/fail, latency, and error text — so "Test"
 * answers "why can't I connect" without leaving the panel.
 */
export function ConnectionDoctorPanel({ machineId, machineName = null }: ConnectionDoctorPanelProps) {
  const [checks, setChecks] = useState<RemoteRuntimeDoctorCheck[] | null>(null);
  const [result, setResult] = useState<RemoteRuntimeDoctorResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setChecks(null);
    setResult(null);
    void (async () => {
      try {
        const next = await window.ade.remoteRuntime.runDoctor(machineId);
        if (cancelled) return;
        setChecks(next.checks);
        setResult(next);
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

      {result?.diagnosis ? (
        <div role="status" style={{ display: "grid", gap: 2, fontFamily: SANS_FONT, fontSize: 12 }}>
          <span style={{ color: DIAGNOSIS_COLOR[result.diagnosis.tone], fontWeight: 600 }}>
            {result.diagnosis.title}
          </span>
          {result.diagnosis.fix ? (
            <span style={{ color: COLORS.textSecondary }}>{result.diagnosis.fix}</span>
          ) : null}
        </div>
      ) : null}

      <HostStallNote stall={result?.hostStall} machineName={machineName} />

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
                  <div style={{ fontSize: 11.5, marginTop: 2 }}>
                    {failureLabel(check.failure) ? (
                      <span style={{ color: COLORS.danger }}>{failureLabel(check.failure)} · </span>
                    ) : null}
                    <span style={{ color: failureLabel(check.failure) ? COLORS.textMuted : COLORS.danger }}>
                      {check.error}
                    </span>
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

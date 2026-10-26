import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { CircleNotch } from "@phosphor-icons/react";
import { SANS_FONT } from "../lanes/laneDesignTokens";
import { extractError } from "../../lib/format";
import type {
  RemoteRuntimeDoctorCheck,
  RemoteRuntimeDoctorFailure,
  RemoteRuntimeDoctorResult,
} from "../../../shared/types";
import {
  DiagnosisList,
  DiagnosisRow,
  DiagnosisSectionHead,
  DiagnosisVerdict,
  type DiagnosisState,
} from "./DiagnosisRows";
import { HostReachabilitySection } from "./HostReachabilityCheck";
import { HostStallNote } from "./HostStallNote";

const wrapStyle: CSSProperties = { gap: 14, padding: "14px 16px" };

function routeLabel(kind: RemoteRuntimeDoctorCheck["route"]): string {
  switch (kind) {
    case "lan":
      return "Local network";
    case "tailnet":
      return "Tailscale";
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

const DIAGNOSIS_STATE: Record<NonNullable<RemoteRuntimeDoctorResult["diagnosis"]>["tone"], DiagnosisState> = {
  success: "ok",
  warning: "warning",
  danger: "failed",
};

type ConnectionDoctorPanelProps = {
  /** Saved target id or discovered machine id, passed to runDoctor. */
  machineId: string;
  /** For the freeze note ("Studio froze for 12s"). */
  machineName?: string | null;
  /**
   * The machine is connected, so it can also be asked from its own side
   * whether other devices can reach it (relay, Tailscale, exit node, freezes).
   */
  connected?: boolean;
};

/**
 * Inline reachability probe. Runs the connection doctor for a machine: one
 * sentence on top saying whether it can be reached and what to do, then one
 * line per route (working ones first) with its latency or a two-word reason.
 * The raw error is in each row's tooltip. A connected machine also gets an
 * "On <machine>" section that asks the machine itself.
 */
export function ConnectionDoctorPanel({ machineId, machineName = null, connected = false }: ConnectionDoctorPanelProps) {
  const remoteCheck = window.ade?.remoteRuntime?.checkReachability;
  const checkRemote = useCallback(
    () => remoteCheck!(machineId),
    [remoteCheck, machineId],
  );
  const [result, setResult] = useState<RemoteRuntimeDoctorResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setResult(null);
    void (async () => {
      try {
        const next = await window.ade.remoteRuntime.runDoctor(machineId);
        if (cancelled) return;
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

  const checks = result?.checks ?? null;
  const sortedChecks = checks
    ? [...checks].sort((left, right) => Number(right.ok) - Number(left.ok))
    : [];
  const verdictState: DiagnosisState = result?.diagnosis
    ? DIAGNOSIS_STATE[result.diagnosis.tone]
    : sortedChecks.some((check) => check.ok) ? "ok" : "failed";

  return (
    <div className="kit-card" style={wrapStyle}>
      {loading ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--kit-text-2)", fontFamily: SANS_FONT, fontSize: 12.5 }}>
          <CircleNotch size={16} weight="bold" className="animate-spin" />
          Testing each way to reach {machineName?.trim() || "this machine"}…
        </div>
      ) : null}

      {error ? <DiagnosisVerdict state="failed" title="The test couldn't run." fix={error} /> : null}

      {!loading && !error && result?.diagnosis ? (
        <DiagnosisVerdict state={verdictState} title={result.diagnosis.title} fix={result.diagnosis.fix} />
      ) : null}

      <HostStallNote stall={result?.hostStall} machineName={machineName} />

      {!loading && !error && checks ? (
        <div style={{ display: "grid", gap: 8 }}>
          <DiagnosisSectionHead label="Ways to reach it from here" />
          {sortedChecks.length === 0 ? (
            <span style={{ color: "var(--kit-text-3)", fontFamily: SANS_FONT, fontSize: 12 }}>
              No routes to test for this machine.
            </span>
          ) : (
            <DiagnosisList label="Routes">
              {sortedChecks.map((check, index) => {
                const failure = failureLabel(check.failure);
                return (
                  <DiagnosisRow
                    key={`${check.route}:${check.endpoint}:${index}`}
                    state={check.ok ? "ok" : "failed"}
                    label={routeLabel(check.route)}
                    detail={check.endpoint}
                    meta={check.ok
                      ? typeof check.latencyMs === "number" ? `${Math.round(check.latencyMs)} ms` : "Works"
                      : failure ?? "Failed"}
                    tooltip={[check.endpoint, check.error].filter(Boolean).join("\n")}
                  />
                );
              })}
            </DiagnosisList>
          )}
        </div>
      ) : null}

      {connected && typeof remoteCheck === "function" ? (
        <div style={{ borderTop: "1px solid var(--kit-rule)", paddingTop: 12 }}>
          <HostReachabilitySection
            key={machineId}
            check={checkRemote}
            heading={`On ${machineName?.trim() || "this machine"}`}
            prompt="Ask it whether your other devices can reach it."
          />
        </div>
      ) : null}
    </div>
  );
}

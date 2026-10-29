import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CircleNotch } from "@phosphor-icons/react";
import { outlineButton } from "../lanes/laneDesignTokens";
import { Banner } from "../ui/notice";
import { extractError } from "../../lib/format";
import type { HostReachabilityReport } from "../../../shared/connectionDiagnosis";
import { DiagnosisList, DiagnosisRow, DiagnosisSectionHead } from "./DiagnosisRows";
import { helperTextStyle } from "./remoteTargetListStyles";

type ReachabilityCheck = () => Promise<HostReachabilityReport>;

/**
 * "Can my other devices reach this computer?", asked of that computer's own
 * brain: is ADE listening, is the relay connected and does a test connection
 * through it come back, is Tailscale up or routing through an exit node that
 * blocks the relay, did ADE freeze there. Each part says what to do.
 */
function useReachabilityRun(check: ReachabilityCheck | undefined) {
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

  return { running, report, error, run };
}

function CheckButton({ running, ran, onClick }: { running: boolean; ran: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={running}
      onClick={onClick}
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
      {running ? "Checking…" : ran ? "Check again" : "Check"}
    </button>
  );
}

function ReachabilityRows({ report }: { report: HostReachabilityReport }) {
  return (
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
  );
}

function ErrorLine({ error }: { error: string }) {
  return (
    <Banner
      layout="inline"
      model={{
        id: "host-reachability-error",
        tone: "error",
        title: error,
        report: { surface: "host_reachability_check" },
      }}
    />
  );
}

/**
 * The check on its own, for the computer you are sitting at. The web client
 * has no such call and renders nothing.
 */
export function HostReachabilityCheck({
  check = window.ade?.sync?.checkLocalReachability,
  prompt = "Can your other devices reach this computer?",
  leading = null,
}: {
  check?: ReachabilityCheck | undefined;
  prompt?: string;
  /** Shown in place of the prompt before a check runs (the popover's route badges). */
  leading?: ReactNode;
} = {}) {
  const { running, report, error, run } = useReachabilityRun(check);
  if (typeof check !== "function") return null;
  const button = <CheckButton running={running} ran={report !== null} onClick={() => void run()} />;

  return (
    <div data-host-reachability style={{ display: "grid", gap: 10, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {report ? (
          <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, color: "var(--color-fg)" }}>
            {report.title}
          </span>
        ) : leading ?? (
          <span style={{ ...helperTextStyle, flex: 1, minWidth: 0 }}>{prompt}</span>
        )}
        {button}
      </div>
      {error ? <ErrorLine error={error} /> : null}
      {report ? <ReachabilityRows report={report} /> : null}
    </div>
  );
}

/**
 * The same check as a section of a larger panel (a connected machine's Test
 * panel): the heading carries the button, and the report's title shows only
 * when something needs doing, since the panel has its own verdict on top.
 */
export function HostReachabilitySection({
  check,
  heading,
  prompt,
}: {
  check: ReachabilityCheck;
  heading: string;
  prompt: string;
}) {
  const { running, report, error, run } = useReachabilityRun(check);

  return (
    <div data-host-reachability style={{ display: "grid", gap: 10, minWidth: 0 }}>
      <DiagnosisSectionHead
        label={heading}
        action={<CheckButton running={running} ran={report !== null} onClick={() => void run()} />}
      />
      {!report && !error ? <span style={helperTextStyle}>{prompt}</span> : null}
      {error ? <ErrorLine error={error} /> : null}
      {report ? <ReachabilityRows report={report} /> : null}
      {report && report.tone !== "success" ? (
        <span style={{ ...helperTextStyle, color: report.tone === "danger" ? "var(--kit-crit)" : "var(--kit-text-2)" }}>
          {report.title}
        </span>
      ) : null}
    </div>
  );
}

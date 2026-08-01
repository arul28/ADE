import {
  ArrowLeft,
  CheckCircle,
  Copy,
  MinusCircle,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  toAdeRecoveryErrorCode,
  type AdeRecoveryErrorCode,
  type ProjectRecoveryDiagnosis,
  type ProjectRepairReport,
  type RepairStepResult,
} from "../../../shared/types/recovery";
import { useAppStore } from "../../state/appStore";

/**
 * Codes we can attempt an automatic repair for when a live diagnosis isn't
 * available (the diagnosis itself, when present, is the source of truth via
 * `canAutoRepair`).
 */
const AUTO_REPAIR_CODES: readonly AdeRecoveryErrorCode[] = [
  "disk_full",
  "insufficient_headroom",
  "db_integrity",
  "migration_incomplete",
  "migration_unknown_state",
  "brain_crash_looping",
  "brain_not_installed",
  "socket_stale_no_owner",
  "provider_thread_missing",
  "provider_resume_failed",
  "continuity_reconstruction_required",
  "unknown",
];

/** Steps arrive as a finished array; reveal them one-by-one so it reads live. */
const STEP_REVEAL_MS = 150;
/** Beat the completed checklist lingers before resolving to success/failure. */
const SETTLE_MS = 250;
/** Beat the success card stays up before ADE re-attempts the project open. */
const REOPEN_DELAY_MS = 700;

/**
 * Plain-language headline/body used only when a live diagnosis is unavailable
 * (no target root, or `diagnose` failed). Never surfaces codes or internals.
 */
const FALLBACK_COPY: Record<AdeRecoveryErrorCode, { headline: string; body: string }> = {
  disk_full: {
    headline: "Your computer is out of storage",
    body: "ADE needs a little free space to open this project safely. Free up some space, then run the repair.",
  },
  insufficient_headroom: {
    headline: "Your computer is very low on storage",
    body: "ADE keeps a small safety margin so your work is never lost. Free up some space, then run the repair.",
  },
  db_integrity: {
    headline: "This project's index needs a repair",
    body: "ADE can rebuild the project's index. Your files and chats stay exactly where they are.",
  },
  migration_incomplete: {
    headline: "An update didn't finish",
    body: "A previous update to this project was interrupted. ADE can finish it and reopen the project.",
  },
  migration_unknown_state: {
    headline: "This project's data needs attention",
    body: "ADE can bring the project's data back to a known-good state and reopen it.",
  },
  brain_not_installed: {
    headline: "ADE needs to finish setting up",
    body: "A background component isn't ready yet. ADE can set it up and reopen the project.",
  },
  brain_crash_looping: {
    headline: "ADE's background service keeps restarting",
    body: "ADE can reset the service and reopen the project.",
  },
  socket_stale_no_owner: {
    headline: "A previous session didn't shut down cleanly",
    body: "ADE can clear the leftover session and reopen the project.",
  },
  socket_owned_by_other: {
    headline: "Another window is using this project",
    body: "Close the other ADE window that has this project open, then try again.",
  },
  provider_thread_missing: {
    headline: "A chat couldn't be restored",
    body: "ADE can reconcile your chats and reopen the project.",
  },
  provider_resume_failed: {
    headline: "A chat couldn't be resumed",
    body: "ADE can reconcile your chats and reopen the project.",
  },
  optional_mcp_failed: {
    headline: "An optional integration didn't load",
    body: "ADE can reopen the project without it — you can re-enable it later.",
  },
  continuity_reconstruction_required: {
    headline: "A chat needs to be rebuilt",
    body: "ADE can rebuild the affected chat and reopen the project.",
  },
  unknown: {
    headline: "ADE couldn't open this project",
    body: "ADE can run a repair pass and try opening the project again.",
  },
};

type Phase = "diagnosing" | "idle" | "repairing" | "success" | "failure";

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function StepRow({ step }: { step: RepairStepResult }) {
  const icon =
    step.status === "ok" ? (
      <CheckCircle size={16} weight="fill" className="mt-px shrink-0 text-emerald-400/90" />
    ) : step.status === "failed" ? (
      <XCircle size={16} weight="fill" className="mt-px shrink-0 text-red-400/90" />
    ) : (
      <MinusCircle size={16} weight="regular" className="mt-px shrink-0 text-fg/35" />
    );
  return (
    <li
      className={
        "flex items-start gap-2 text-[12.5px] leading-snug " +
        (step.status === "failed" ? "text-fg/90" : "text-fg/70")
      }
    >
      {icon}
      <span className={step.status === "failed" ? "font-medium" : undefined}>{step.label}</span>
    </li>
  );
}

export function ProjectRecoveryScreen() {
  const navigate = useNavigate();
  const projectTransitionError = useAppStore((s) => s.projectTransitionError);
  const clearProjectTransitionError = useAppStore((s) => s.clearProjectTransitionError);
  const switchProjectToPath = useAppStore((s) => s.switchProjectToPath);

  const rootPath = projectTransitionError?.rootPath ?? null;
  const code = toAdeRecoveryErrorCode(projectTransitionError?.code) ?? "unknown";

  const [diagnosis, setDiagnosis] = useState<ProjectRecoveryDiagnosis | null>(null);
  const [phase, setPhase] = useState<Phase>("diagnosing");
  const [report, setReport] = useState<ProjectRepairReport | null>(null);
  const [revealed, setRevealed] = useState(0);
  const [repairError, setRepairError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const reopenStartedRef = useRef(false);

  // Diagnose on mount / when the failed root changes. On failure fall back to
  // rendering from the stored code, so the surface always has calm copy.
  useEffect(() => {
    let cancelled = false;
    if (!rootPath || !window.ade?.recovery?.diagnose) {
      setDiagnosis(null);
      setPhase("idle");
      return;
    }
    setPhase("diagnosing");
    window.ade.recovery
      .diagnose(rootPath)
      .then((result) => {
        if (cancelled) return;
        setDiagnosis(result);
        setPhase("idle");
      })
      .catch(() => {
        if (cancelled) return;
        setDiagnosis(null);
        setPhase("idle");
      });
    return () => {
      cancelled = true;
    };
  }, [rootPath]);

  // Reveal repair steps sequentially, then resolve to success/failure. The API
  // returns the whole array at once; the stagger makes it read as a checklist.
  useEffect(() => {
    if (phase !== "repairing" || !report) return;
    if (revealed >= report.steps.length) {
      // Let the finished checklist settle for a beat before resolving.
      const timer = window.setTimeout(() => {
        if (report.ok) {
          setPhase("success");
        } else {
          setRepairError(report.nextAction ?? "ADE could not finish the repair.");
          setPhase("failure");
        }
      }, SETTLE_MS);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setTimeout(() => setRevealed((n) => n + 1), STEP_REVEAL_MS);
    return () => window.clearTimeout(timer);
  }, [phase, report, revealed]);

  // Once repaired, keep the success card up for a beat, then re-attempt the open.
  // A successful open clears the transition error and unmounts this surface.
  useEffect(() => {
    if (phase !== "success" || !rootPath || reopenStartedRef.current) return;
    reopenStartedRef.current = true;
    const timer = window.setTimeout(() => {
      void switchProjectToPath(rootPath);
    }, REOPEN_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [phase, rootPath, switchProjectToPath]);

  const runRepair = useCallback(async () => {
    if (!rootPath || phase === "repairing") return;
    reopenStartedRef.current = false;
    setReport(null);
    setRevealed(0);
    setRepairError(null);
    setPhase("repairing");
    try {
      const result = await window.ade.recovery.repair(rootPath);
      setReport(result);
    } catch (error) {
      setRepairError(error instanceof Error ? error.message : String(error));
      setReport(null);
      setPhase("failure");
    }
  }, [rootPath, phase]);

  const fallback = FALLBACK_COPY[code] ?? FALLBACK_COPY.unknown;
  const headline = diagnosis?.headline ?? fallback.headline;
  const body = diagnosis?.body ?? fallback.body;
  const canAutoRepair = Boolean(
    rootPath && (diagnosis ? diagnosis.canAutoRepair : AUTO_REPAIR_CODES.includes(code)),
  );

  const technicalText = [
    diagnosis?.technicalDetail,
    projectTransitionError?.detail,
    projectTransitionError?.message,
    report?.failureCode ? `failureCode: ${report.failureCode}` : null,
    report?.steps.length
      ? report.steps
          .map((s) => `${s.id}: ${s.status}${s.detail ? ` — ${s.detail}` : ""}`)
          .join("\n")
      : null,
    `code: ${code}`,
  ]
    .filter((line): line is string => Boolean(line && line.trim()))
    .join("\n");

  const copyTechnical = () => {
    void navigator.clipboard?.writeText(technicalText).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };

  const visibleSteps = report ? report.steps.slice(0, phase === "repairing" ? revealed : undefined) : [];

  const isSuccess = phase === "success";

  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center overflow-y-auto bg-bg/98 px-6 py-10 text-fg backdrop-blur-sm"
      role="region"
      aria-label="Project recovery"
    >
      <div className="w-full max-w-[520px]">
        <button
          type="button"
          onClick={clearProjectTransitionError}
          className="mb-6 inline-flex items-center gap-1.5 text-[12px] font-medium text-fg/55 transition-colors hover:text-fg/85"
        >
          <ArrowLeft size={13} weight="bold" />
          Back
        </button>

        <div className="flex flex-col items-center text-center">
          <div
            className={
              "mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border " +
              (isSuccess
                ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-400"
                : "border-amber-400/25 bg-amber-400/10 text-amber-400")
            }
          >
            {isSuccess ? (
              <CheckCircle size={30} weight="duotone" />
            ) : (
              <WarningCircle size={30} weight="duotone" />
            )}
          </div>

          {isSuccess ? (
            <SuccessCard report={report} onOpenWork={() => navigate("/work")} />
          ) : (
            <>
              <h1 className="text-[19px] font-semibold leading-tight tracking-[-0.01em] text-fg/95">
                {phase === "failure" ? "ADE couldn't finish the repair" : headline}
              </h1>
              <p className="mt-2.5 max-w-[420px] text-[13.5px] leading-relaxed text-fg/60">
                {phase === "failure"
                  ? (repairError ?? "Try the repair again, or review your storage.")
                  : body}
              </p>
            </>
          )}
        </div>

        {/* Repair progress / failure checklist */}
        {(phase === "repairing" || phase === "failure") && (report || phase === "repairing") ? (
          <div className="mt-6 rounded-xl border border-amber-400/12 bg-amber-400/[0.04] px-4 py-3.5">
            {phase === "repairing" ? (
              <div className="mb-2.5 flex items-center gap-2 text-[12px] font-medium text-amber-100/80">
                <span
                  aria-hidden="true"
                  className="h-3 w-3 shrink-0 animate-spin rounded-full border border-amber-200/30 border-t-amber-300"
                />
                Repairing…
              </div>
            ) : null}
            {visibleSteps.length ? (
              <ul className="flex flex-col gap-1.5">
                {visibleSteps.map((step) => (
                  <StepRow key={step.id} step={step} />
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {/* Actions */}
        {phase !== "repairing" && !isSuccess ? (
          <div className="mt-7 flex flex-wrap items-center justify-center gap-2.5">
            {canAutoRepair ? (
              <button
                type="button"
                onClick={() => void runRepair()}
                className="inline-flex h-9 items-center justify-center rounded-lg bg-amber-400/90 px-4 text-[13px] font-semibold text-[#1a1206] transition-colors hover:bg-amber-300"
              >
                {phase === "failure" ? "Try again" : "Repair ADE"}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                // Clearing the error first exits the recovery takeover; while
                // projectTransitionError is set, ProjectTabHost keeps rendering
                // this screen and the route change alone would never reveal
                // Settings.
                clearProjectTransitionError();
                navigate("/settings?tab=storage");
              }}
              className="inline-flex h-9 items-center justify-center rounded-lg border border-border/80 bg-fg/[0.03] px-4 text-[13px] font-medium text-fg/75 transition-colors hover:bg-fg/[0.07]"
            >
              Review storage
            </button>
          </div>
        ) : null}

        {/* Technical details fold — the only place raw internals appear. */}
        {technicalText ? (
          <details className="group mt-6 rounded-lg border border-border/60 bg-fg/[0.015]">
            <summary className="flex cursor-pointer select-none items-center justify-between px-3.5 py-2.5 text-[12px] font-medium text-fg/55 transition-colors hover:text-fg/80">
              Show technical details
              <span className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    copyTechnical();
                  }}
                  className="inline-flex items-center gap-1 text-[11px] text-fg/45 transition-colors hover:text-fg/75"
                >
                  <Copy size={12} weight="regular" />
                  {copied ? "Copied" : "Copy"}
                </button>
              </span>
            </summary>
            <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words border-t border-border/50 px-3.5 py-3 font-mono text-[11px] leading-relaxed text-fg/60">
              {technicalText}
            </pre>
          </details>
        ) : null}
      </div>
    </div>
  );
}

function SuccessCard({
  report,
  onOpenWork,
}: {
  report: ProjectRepairReport | null;
  onOpenWork: () => void;
}) {
  const dbLine =
    report?.dbHealthy === true
      ? "Project database: healthy"
      : report?.dbHealthy === false
        ? "Project database: repaired"
        : null;
  const total = report?.chatsTotal ?? null;
  const needAttention = report?.chatsNeedingAttention ?? 0;
  const resumedNormally = total != null ? Math.max(0, total - needAttention) : null;

  return (
    <>
      <h1 className="text-[19px] font-semibold leading-tight tracking-[-0.01em] text-fg/95">
        ADE repaired the project and reopened it
      </h1>
      <ul className="mt-4 flex flex-col items-center gap-1.5 text-[13px] leading-relaxed text-fg/60">
        {dbLine ? <li>{dbLine}</li> : null}
        {resumedNormally != null ? (
          <li>{pluralize(resumedNormally, "chat")} resumed normally</li>
        ) : null}
        {needAttention > 0 ? (
          <li>
            {pluralize(needAttention, "chat")} {needAttention === 1 ? "needs" : "need"} your
            attention —{" "}
            <button
              type="button"
              onClick={onOpenWork}
              className="font-medium text-amber-300/90 underline decoration-amber-300/30 underline-offset-2 transition-colors hover:text-amber-200"
            >
              open Work
            </button>
          </li>
        ) : null}
        <li className="text-fg/45">No project files were removed.</li>
      </ul>
    </>
  );
}

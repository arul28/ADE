import {
  ArrowLeft,
  CheckCircle,
  CircleNotch,
  MinusCircle,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  REPAIR_STEPS,
  toAdeRecoveryErrorCode,
  type AdeRecoveryErrorCode,
  type ProjectRecoveryDiagnosis,
  type ProjectRepairReport,
  type RepairStepResult,
} from "../../../shared/types/recovery";
import { useAppStore } from "../../state/appStore";
import { settingsRouteFor } from "../settings/settingsManifest";
import {
  ERROR_CARD,
  ERROR_GHOST_BUTTON,
  ERROR_PRIMARY_BUTTON,
  ERROR_SECONDARY_BUTTON,
  TechnicalDetailsFold,
  WhatToDo,
} from "./errorSurfaceKit";
import { ReportIssueButton } from "./ReportIssueButton";

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
 * While the background service is still starting there is nothing for the
 * user to do, so this surface keeps re-diagnosing on its own and reopens the
 * project the moment the service answers. The diagnosis itself stops saying
 * "starting" once the brain has been quiet for too long, so this cannot spin
 * forever on a wedged brain — it degrades into the normal repair offer.
 */
const STARTING_POLL_MS = 2_000;

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
    body: "Something stopped ADE's background service from answering. Repair restarts it and checks the project's data — your files and chats are not touched.",
  },
};

type DiagnosisState = ProjectRecoveryDiagnosis["state"];

/**
 * The part the diagnosis does not carry: what the person should do before
 * pressing anything. Only states with a real prerequisite get one — inventing
 * a chore for every state would train people to skip the list.
 */
const PREREQUISITE_STEPS: Partial<Record<DiagnosisState, readonly string[]>> = {
  disk_full: [
    "Free up space on this computer — emptying the Trash is usually the quickest win.",
    "Come back here and run the repair.",
  ],
  insufficient_headroom: [
    "Free up a little space on this computer.",
    "Come back here and run the repair.",
  ],
  socket_owned_by_other: [
    "Quit the other copy of ADE that's running on this computer.",
    "Then choose Try again.",
  ],
};

/** Same idea, keyed by code, for when no live diagnosis came back. */
const PREREQUISITE_STEPS_BY_CODE: Partial<Record<AdeRecoveryErrorCode, readonly string[]>> = {
  disk_full: PREREQUISITE_STEPS.disk_full,
  insufficient_headroom: PREREQUISITE_STEPS.insufficient_headroom,
  socket_owned_by_other: PREREQUISITE_STEPS.socket_owned_by_other,
};

/** What pressing Repair actually does, in the order it does it. */
const REPAIR_PROMISE: readonly string[] = [
  "Restart ADE's background service",
  "Check this project's data and finish anything that was interrupted",
  "Reopen the project",
];

/** What to do when the repair itself came back empty-handed. */
const REPAIR_FAILED_STEPS: readonly string[] = [
  "Try the repair once more — a second pass clears most of these.",
  "If it fails again, choose Report issue. ADE collects everything needed to look into it, with your personal details removed.",
];

const REASSURANCE = "Your files, chats and settings aren't touched by a repair.";

type Phase = "diagnosing" | "idle" | "repairing" | "success" | "failure";

/**
 * The "now doing" line names the next step from the shared ordered list.
 * Restarting the background service is the one that can take a while (it
 * waits for the service to answer), and it deserves to say so.
 */
const REPAIR_STEP_LABELS: readonly string[] = REPAIR_STEPS.map((step) =>
  step.id === "restart_service"
    ? `${step.label} (this can take a few minutes)`
    : step.label,
);

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
  // Steps pushed by the main process while the repair is still running. The
  // final report replaces them; until then they are what the user watches.
  const [liveSteps, setLiveSteps] = useState<RepairStepResult[]>([]);
  const [repairError, setRepairError] = useState<string | null>(null);
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
    // Keyed on the error object, not just its root: a fresh failure for the
    // same project (e.g. the automatic reopen above hitting a different problem)
    // must be diagnosed again rather than shown under the previous verdict.
  }, [rootPath, projectTransitionError]);

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
          setRepairError(report.nextAction ?? null);
          setPhase("failure");
        }
      }, SETTLE_MS);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setTimeout(() => setRevealed((n) => n + 1), STEP_REVEAL_MS);
    return () => window.clearTimeout(timer);
  }, [phase, report, revealed]);

  // Nothing to repair while the service is booting: keep asking, and reopen the
  // project ourselves as soon as it is healthy. The user should never have to
  // click Repair (which restarts the brain) to recover from a slow start.
  useEffect(() => {
    if (phase !== "idle" || diagnosis?.state !== "brain_starting" || !rootPath) return;
    if (!window.ade?.recovery?.diagnose) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      window.ade.recovery
        .diagnose(rootPath)
        .then((result) => {
          if (cancelled) return;
          if (result.state === "healthy") {
            if (reopenStartedRef.current) return;
            reopenStartedRef.current = true;
            void switchProjectToPath(rootPath).catch(() => {
              // The open failed for a new reason; the store has replaced the
              // transition error and the diagnose effect below re-runs.
              reopenStartedRef.current = false;
            });
            return;
          }
          setDiagnosis(result);
        })
        .catch(() => {
          // Keep polling; a failed diagnosis is not a verdict.
        });
    }, STARTING_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [phase, diagnosis?.state, rootPath, switchProjectToPath]);

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

  // Subscribe for the whole life of the surface: a repair started from this
  // window streams its steps here as each one finishes.
  useEffect(() => {
    if (!rootPath || !window.ade?.recovery?.onRepairStep) return;
    return window.ade.recovery.onRepairStep(({ projectRoot, step }) => {
      if (projectRoot !== rootPath) return;
      setLiveSteps((prev) => (prev.some((s) => s.id === step.id) ? prev : [...prev, step]));
    });
  }, [rootPath]);

  const runRepair = useCallback(async () => {
    if (!rootPath || phase === "repairing") return;
    reopenStartedRef.current = false;
    setReport(null);
    setRevealed(0);
    setLiveSteps([]);
    setRepairError(null);
    setPhase("repairing");
    try {
      const result = await window.ade.recovery.repair(rootPath);
      // Everything streamed already showed; reveal the rest without the stagger.
      setRevealed(result.steps.length);
      setReport(result);
    } catch (error) {
      setRepairError(error instanceof Error ? error.message : String(error));
      setReport(null);
      setPhase("failure");
    }
  }, [rootPath, phase]);

  const reopenProject = useCallback(() => {
    if (!rootPath) return;
    // Plain reopen, no repair: right after "close the other copy of ADE" or a
    // transient failure this is the whole fix, and Back alone left people
    // re-clicking the project.
    reopenStartedRef.current = true;
    void switchProjectToPath(rootPath).catch(() => {
      reopenStartedRef.current = false;
    });
  }, [rootPath, switchProjectToPath]);

  const fallback = FALLBACK_COPY[code] ?? FALLBACK_COPY.unknown;
  const headline = diagnosis?.headline ?? fallback.headline;
  const body = diagnosis?.body ?? fallback.body;
  const canAutoRepair = Boolean(
    rootPath && (diagnosis ? diagnosis.canAutoRepair : AUTO_REPAIR_CODES.includes(code)),
  );
  const starting = phase === "idle" && diagnosis?.state === "brain_starting";
  const isSuccess = phase === "success";
  const isFailure = phase === "failure";
  const prerequisites =
    (diagnosis ? PREREQUISITE_STEPS[diagnosis.state] : PREREQUISITE_STEPS_BY_CODE[code]) ?? null;
  /** Whether the amber Repair action is on screen at all. */
  const repairOffered = canAutoRepair && !starting;
  /**
   * Storage is the fix for exactly two states. Everywhere else "Review storage"
   * is a way out rather than the way out, and dressing it like the alternative
   * to Repair made three buttons of equal weight on every failure.
   */
  const storageRelevant = diagnosis
    ? diagnosis.state === "disk_full" || diagnosis.state === "insufficient_headroom"
    : code === "disk_full" || code === "insufficient_headroom";

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

  const visibleSteps = report
    ? report.steps.slice(0, phase === "repairing" ? revealed : undefined)
    : liveSteps;
  // What the repair is doing right now: the step after the last finished one.
  const activeStepLabel = phase === "repairing" && !report
    ? (liveSteps.length ? REPAIR_STEP_LABELS[liveSteps.length] ?? null : REPAIR_STEP_LABELS[0])
    : null;

  const reviewStorageButton = (
    <button
      type="button"
      onClick={() => {
        // Clearing the error first exits the recovery takeover; while
        // projectTransitionError is set, ProjectTabHost keeps rendering this
        // screen and the route change alone would never reveal Settings.
        clearProjectTransitionError();
        navigate(settingsRouteFor("storage.usage"));
      }}
      className={storageRelevant ? ERROR_SECONDARY_BUTTON : ERROR_GHOST_BUTTON}
    >
      Review storage
    </button>
  );

  const heroHeadline = isFailure ? "ADE couldn't finish the repair" : headline;
  const heroBody = isFailure
    ? (repairError
      ?? "The repair ran but didn't clear the problem. Nothing was removed, and you can try again.")
    : body;

  return (
    <div
      className="absolute inset-0 z-30 overflow-y-auto bg-bg/98 text-fg backdrop-blur-sm"
      role="region"
      aria-label="Project recovery"
    >
      {/* Centred, but as a min-height row rather than `items-center` on the
          scroller: a card taller than the window would otherwise have its top
          — Back included — clipped above the scroll origin. */}
      <div className="flex min-h-full items-center justify-center px-6 py-10">
      <div className="w-full max-w-[560px]">
        <button
          type="button"
          onClick={clearProjectTransitionError}
          className="mb-4 inline-flex items-center gap-1.5 text-[12px] font-medium text-fg/55 transition-colors hover:text-fg/85"
        >
          <ArrowLeft size={13} weight="bold" />
          Back
        </button>

        <div className={ERROR_CARD}>
          <div className="flex items-start gap-3.5">
            <div
              className={
                "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border " +
                (isSuccess
                  ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-400"
                  : starting
                    ? "border-border/70 bg-fg/[0.04] text-fg/55"
                    : "border-amber-400/25 bg-amber-400/10 text-amber-300")
              }
            >
              {isSuccess ? (
                <CheckCircle size={18} weight="fill" aria-hidden="true" />
              ) : starting ? (
                // Nothing is broken while the service boots; a warning badge
                // here is the "broken ADE" report this state exists to avoid.
                <CircleNotch size={17} weight="bold" aria-hidden="true" className="animate-spin" />
              ) : (
                <WarningCircle size={18} weight="fill" aria-hidden="true" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              {isSuccess ? (
                <SuccessCard report={report} onOpenWork={() => navigate("/work")} />
              ) : (
                <>
                  <h1 className="text-[16.5px] font-semibold leading-snug tracking-[-0.01em] text-fg/95">
                    {heroHeadline}
                  </h1>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-fg/60">{heroBody}</p>
                </>
              )}
            </div>
          </div>

          {/* Repair progress / failure checklist */}
          {(phase === "repairing" || isFailure) && (report || phase === "repairing") ? (
            <div className="mt-5 rounded-xl border border-amber-400/12 bg-amber-400/[0.04] px-4 py-3.5">
              {phase === "repairing" ? (
                <div className="mb-2.5 flex items-center gap-2 text-[12px] font-medium text-amber-100/80">
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                    <span
                      aria-hidden="true"
                      className="h-3 w-3 animate-spin rounded-full border border-amber-200/30 border-t-amber-300"
                    />
                  </span>
                  {activeStepLabel ? `${activeStepLabel}…` : "Repairing…"}
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

          {/* Booting service: nothing to press, so say who is doing the work. */}
          {starting ? (
            <div className="mt-5 flex items-start gap-2.5 rounded-xl border border-border/60 bg-fg/[0.02] px-4 py-3 text-[12.5px] leading-relaxed text-fg/65">
              <span
                aria-hidden="true"
                className="mt-1 h-3 w-3 shrink-0 animate-spin rounded-full border border-fg/20 border-t-fg/60"
              />
              <span>
                Waiting for the background service… You can leave this screen — ADE keeps
                checking and opens the project on its own.
              </span>
            </div>
          ) : null}

          {/* What to do. One list at a time: a prerequisite the person owns, the
              next move after a failed repair, or what Repair is about to do. */}
          {!isSuccess && phase !== "repairing" && !starting ? (
            isFailure ? (
              <WhatToDo title="What to do next" steps={REPAIR_FAILED_STEPS} />
            ) : prerequisites ? (
              <WhatToDo title="What to do" steps={prerequisites} />
            ) : canAutoRepair ? (
              <WhatToDo title="What the repair does" steps={REPAIR_PROMISE} />
            ) : null
          ) : null}

          {!isSuccess && phase !== "repairing" && !starting && canAutoRepair ? (
            <p className="mt-3 text-[12.5px] leading-relaxed text-fg/45">{REASSURANCE}</p>
          ) : null}

          {/* Actions. While the service is merely starting, Repair is withheld
              (it would restart the very brain we are waiting for) but the other
              ways out stay: a person must never be pinned on a spinner. */}
          {phase !== "repairing" && !isSuccess ? (
            <div className="mt-5 flex flex-wrap items-center gap-2">
              {repairOffered ? (
                <button type="button" onClick={() => void runRepair()} className={ERROR_PRIMARY_BUTTON}>
                  {isFailure ? "Try again" : "Repair ADE"}
                </button>
              ) : null}
              {storageRelevant ? reviewStorageButton : null}
              {rootPath ? (
                <button
                  type="button"
                  onClick={reopenProject}
                  // With no Repair on screen this *is* the action to take, so
                  // it carries the primary weight rather than leaving the row
                  // headless — except while the service is merely starting,
                  // where the honest answer is that there is nothing to press.
                  className={
                    repairOffered || starting ? ERROR_SECONDARY_BUTTON : ERROR_PRIMARY_BUTTON
                  }
                >
                  {repairOffered ? "Open without repairing" : "Try again"}
                </button>
              ) : null}
              {storageRelevant ? null : reviewStorageButton}
            </div>
          ) : null}
        </div>

        {/* Meta actions live outside the card: they are about this screen, not
            about the project. */}
        {phase !== "repairing" && !isSuccess ? (
          <div className="mt-4">
            <ReportIssueButton
              variant="secondary"
              context={{
                surface: "project_recovery",
                headline: heroHeadline,
                code,
                technicalDetail: technicalText,
                projectRoot: rootPath,
              }}
            />
          </div>
        ) : null}

        <TechnicalDetailsFold text={technicalText} className="mt-4" />
      </div>
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
      <h1 className="text-[16.5px] font-semibold leading-snug tracking-[-0.01em] text-fg/95">
        ADE repaired the project and reopened it
      </h1>
      <ul className="mt-3 flex flex-col gap-1.5 text-[12.5px] leading-relaxed text-fg/60">
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

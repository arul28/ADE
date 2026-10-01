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
  RECOVERY_COPY,
  REPAIR_STEPS,
  stateForCode,
  toAdeRecoveryErrorCode,
  type ProjectRecoveryDiagnosis,
  type ProjectRepairReport,
  type RepairStepResult,
} from "../../../shared/types/recovery";
import { useAppStore } from "../../state/appStore";
import { settingsRouteFor } from "../settings/settingsManifest";
import {
  ERROR_GHOST_BUTTON,
  ERROR_HEADLINE,
  ERROR_PRIMARY_BUTTON,
  ERROR_SECONDARY_BUTTON,
  ErrorSurfaceCard,
  TechnicalDetailsFold,
} from "./errorSurfaceKit";
import { ReportIssueButton } from "./ReportIssueButton";
import { ResetAdeButton } from "./ResetAdeDialog";

/** Steps arrive as a finished array; reveal them one-by-one so it reads live. */
const STEP_REVEAL_MS = 150;
/** Beat the completed checklist lingers before resolving to success/failure. */
const SETTLE_MS = 250;
/** Beat the success card stays up before ADE re-attempts the project open. */
const REOPEN_DELAY_MS = 700;
/**
 * How often the screen asks again while something else is doing the work —
 * a brain that is booting, or a person flipping a switch in System Settings.
 * The diagnosis stops saying "starting" once a brain has been quiet for too
 * long, so this cannot spin forever on a wedged one.
 */
const WATCH_POLL_MS = 2_000;

type DiagnosisState = ProjectRecoveryDiagnosis["state"];

/**
 * States where the person, or ADE itself, is doing the work and this screen
 * only has to watch: a booting brain, and a brain macOS will start the moment
 * "Allow in the Background" is switched back on.
 */
const WATCHED_STATES: ReadonlySet<DiagnosisState> = new Set(["brain_starting", "background_blocked"]);

/** The last step after any fix that did not work: the way out that always works. */
const RESET_STEP =
  "Still stuck? Choose Reset ADE. It removes everything ADE put on this computer and sets it up fresh. Your code stays.";

/** Two failed fixes in a row: another try is unlikely to help, so Reset leads. */
const FAILURES_BEFORE_RESET_LEADS = 2;

type Phase = "diagnosing" | "idle" | "repairing" | "success" | "failure";

/**
 * The "now doing" line names the next step from the shared ordered list.
 * Starting ADE again is the one that can take a while, and it says so.
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

/** Numbered, because these are done in order. */
function DoTheseSteps({ title, steps }: { title: string; steps: readonly string[] }) {
  return (
    <div className="mt-5 text-[12.5px] leading-relaxed text-fg/65">
      <p className="font-medium text-fg/85">{title}</p>
      <ol className="mt-1.5 flex list-decimal flex-col gap-1 pl-5 marker:text-fg/35">
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    </div>
  );
}

function WatchingNote({ children }: { children: string }) {
  return (
    <div className="mt-5 flex items-start gap-2.5 rounded-xl border border-border/60 bg-fg/[0.02] px-4 py-3 text-[12.5px] leading-relaxed text-fg/65">
      <span
        aria-hidden="true"
        className="mt-1 h-3 w-3 shrink-0 animate-spin rounded-full border border-fg/20 border-t-fg/60"
      />
      <span>{children}</span>
    </div>
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
  const [failedFixes, setFailedFixes] = useState(0);
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
          setFailedFixes((count) => count + 1);
          setPhase("failure");
        }
      }, SETTLE_MS);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setTimeout(() => setRevealed((n) => n + 1), STEP_REVEAL_MS);
    return () => window.clearTimeout(timer);
  }, [phase, report, revealed]);

  // Subscribe for the whole life of the surface: a repair started from this
  // window streams its steps here as each one finishes.
  useEffect(() => {
    if (!rootPath || !window.ade?.recovery?.onRepairStep) return;
    return window.ade.recovery.onRepairStep(({ projectRoot, step }) => {
      if (projectRoot !== rootPath) return;
      setLiveSteps((prev) => (prev.some((s) => s.id === step.id) ? prev : [...prev, step]));
    });
  }, [rootPath]);

  // Set and read synchronously: `phase` reaches this callback only after
  // React commits, so a poll (or a second click) landing before that commit
  // would otherwise start a second repair that stops and restarts ADE under
  // the first one.
  const repairInFlightRef = useRef(false);
  const runRepair = useCallback(async () => {
    if (!rootPath || phase === "repairing" || repairInFlightRef.current) return;
    repairInFlightRef.current = true;
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
      setFailedFixes((count) => count + 1);
      setPhase("failure");
    } finally {
      repairInFlightRef.current = false;
    }
  }, [rootPath, phase]);
  // The watcher below runs on an interval; it reads the latest runRepair
  // through a ref instead of restarting the interval on every phase change.
  const runRepairRef = useRef(runRepair);
  runRepairRef.current = runRepair;

  // Nothing to fix while ADE is booting, or while macOS is waiting for "Allow
  // in the Background": keep asking, and reopen the project ourselves as soon
  // as it is healthy. Nobody should have to press Fix it (which restarts the
  // brain) to get past a slow start, nor come back and press anything after
  // flipping the switch.
  const watchedState = diagnosis?.state && WATCHED_STATES.has(diagnosis.state) ? diagnosis.state : null;
  useEffect(() => {
    if (phase !== "idle" || !watchedState || !rootPath) return;
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
              // transition error and the diagnose effect above re-runs.
              reopenStartedRef.current = false;
            });
            return;
          }
          if (watchedState === "background_blocked" && result.state !== "background_blocked" && result.canAutoRepair) {
            // The switch is on but launchd has not started the agent by
            // itself: one fix installs it again, now that macOS allows it.
            setDiagnosis(result);
            void runRepairRef.current();
            return;
          }
          setDiagnosis(result);
        })
        .catch(() => {
          // Keep polling; a failed diagnosis is not a verdict.
        });
    }, WATCH_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [phase, watchedState, rootPath, switchProjectToPath]);

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

  const openBackgroundSettings = useCallback(() => {
    void window.ade?.recovery?.openBackgroundSettings?.().catch(() => undefined);
  }, []);

  const reopenProject = useCallback(() => {
    if (!rootPath) return;
    // Plain reopen: right after "quit the other copy of ADE" or a passing
    // failure this is the whole fix, and Back alone left people re-clicking
    // the project.
    reopenStartedRef.current = true;
    void switchProjectToPath(rootPath).catch(() => {
      reopenStartedRef.current = false;
    });
  }, [rootPath, switchProjectToPath]);

  // One verdict for the whole screen. With a live diagnosis it is the main
  // process's; without one it is what the main process would have said about
  // the stored code, via the shared mapping. The words come from the shared
  // table either way, so the two can never disagree.
  const state: DiagnosisState = diagnosis?.state ?? stateForCode(code);
  const copy = RECOVERY_COPY[state] ?? RECOVERY_COPY.unknown_failure;
  const canAutoRepair = Boolean(
    rootPath && (diagnosis ? diagnosis.canAutoRepair : copy.canAutoRepair),
  );
  const idle = phase === "idle" || phase === "diagnosing";
  const starting = idle && state === "brain_starting";
  const backgroundBlocked = idle && state === "background_blocked";
  const isSuccess = phase === "success";
  const isFailure = phase === "failure";
  const repairOffered = canAutoRepair && !starting;
  const storageRelevant = state === "disk_full" || state === "insufficient_headroom";

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
  // What the fix is doing right now: the step after the last finished one.
  const activeStepLabel = phase === "repairing" && !report
    ? (liveSteps.length ? REPAIR_STEP_LABELS[liveSteps.length] ?? null : REPAIR_STEP_LABELS[0])
    : null;

  const heroHeadline = isFailure ? "That didn't fix it" : copy.headline;
  const heroBody = isFailure ? "ADE tried, but the problem is still there. Nothing was removed." : copy.body;
  const resetLeads = isFailure && failedFixes >= FAILURES_BEFORE_RESET_LEADS;
  const failureSteps = [
    repairError ?? "Choose Try again. A second try fixes most of these.",
    RESET_STEP,
  ];

  // Exactly one filled button: the thing to do next.
  let primary: { label: string; onClick: () => void } | null = null;
  if (resetLeads) primary = null;
  else if (backgroundBlocked) primary = { label: "Open System Settings", onClick: openBackgroundSettings };
  else if (repairOffered) primary = { label: isFailure ? "Try again" : "Fix it", onClick: () => void runRepair() };
  else if (rootPath && !starting) primary = { label: "Try again", onClick: reopenProject };

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

        <ErrorSurfaceCard
          tone={isSuccess ? "success" : starting ? "neutral" : "warning"}
          icon={
            isSuccess ? (
              <CheckCircle size={18} weight="fill" aria-hidden="true" />
            ) : starting ? (
              // Nothing is broken while ADE boots; a warning badge here is the
              // "broken ADE" report this state exists to avoid.
              <CircleNotch size={17} weight="bold" aria-hidden="true" className="animate-spin" />
            ) : (
              <WarningCircle size={18} weight="fill" aria-hidden="true" />
            )
          }
          headline={heroHeadline}
          body={heroBody}
          hero={
            isSuccess
              ? <SuccessCard report={report} onOpenWork={() => navigate("/work")} />
              : undefined
          }
        >

          {/* Fix progress, or the checklist of a fix that did not work. */}
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
                  {activeStepLabel ? `${activeStepLabel}…` : "Fixing…"}
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

          {/* Someone else is doing the work: say who, so nobody hunts for a button. */}
          {starting ? (
            <WatchingNote>Waiting for ADE… You can leave this screen. The project opens by itself.</WatchingNote>
          ) : null}

          {/* What the person does, in order. One list at a time. */}
          {!isSuccess && phase !== "repairing" && !starting ? (
            isFailure ? (
              <DoTheseSteps title="What to do now" steps={failureSteps} />
            ) : copy.steps ? (
              <DoTheseSteps title="What to do" steps={copy.steps} />
            ) : null
          ) : null}

          {phase !== "repairing" && !isSuccess && (primary || resetLeads || storageRelevant || (rootPath && repairOffered)) ? (
            <div className="mt-5 flex flex-wrap items-center gap-2">
              {resetLeads ? <ResetAdeButton className={ERROR_PRIMARY_BUTTON} label="Reset ADE…" /> : null}
              {primary ? (
                <button type="button" onClick={primary.onClick} className={ERROR_PRIMARY_BUTTON}>
                  {primary.label}
                </button>
              ) : null}
              {resetLeads && repairOffered ? (
                <button type="button" onClick={() => void runRepair()} className={ERROR_SECONDARY_BUTTON}>
                  Try again
                </button>
              ) : null}
              {storageRelevant ? (
                <button
                  type="button"
                  onClick={() => {
                    // Clearing the error first exits the recovery takeover;
                    // while it is set this screen keeps rendering and the
                    // route change alone would never reveal Settings.
                    clearProjectTransitionError();
                    navigate(settingsRouteFor("storage.usage"));
                  }}
                  className={ERROR_SECONDARY_BUTTON}
                >
                  See what uses space
                </button>
              ) : null}
              {rootPath && repairOffered && !starting ? (
                <button type="button" onClick={reopenProject} className={ERROR_GHOST_BUTTON}>
                  Open anyway
                </button>
              ) : null}
            </div>
          ) : null}
          {backgroundBlocked ? (
            <WatchingNote>Watching for the change. ADE continues as soon as your Mac allows it.</WatchingNote>
          ) : null}
        </ErrorSurfaceCard>

        {/* The ways out that are about ADE, not this project. */}
        {phase !== "repairing" && !isSuccess ? (
          <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1.5">
            {resetLeads ? null : (
              <>
                <span className="text-[12px] text-fg/45">Still stuck?</span>
                <ResetAdeButton />
              </>
            )}
            <ReportIssueButton
              variant="ghost"
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
  const total = report?.chatsTotal ?? null;
  const needAttention = report?.chatsNeedingAttention ?? 0;
  const resumedNormally = total != null ? Math.max(0, total - needAttention) : null;

  return (
    <>
      <h1 className={ERROR_HEADLINE}>Fixed. Opening the project…</h1>
      <ul className="mt-3 flex flex-col gap-1.5 text-[12.5px] leading-relaxed text-fg/60">
        {report?.dbHealthy === false ? <li>This project&apos;s ADE data was repaired.</li> : null}
        {resumedNormally != null && total ? (
          <li>{pluralize(resumedNormally, "chat")} picked up where {resumedNormally === 1 ? "it" : "they"} left off.</li>
        ) : null}
        {needAttention > 0 ? (
          <li>
            {pluralize(needAttention, "chat")} {needAttention === 1 ? "needs" : "need"} a look —{" "}
            <button
              type="button"
              onClick={onOpenWork}
              className="font-medium text-amber-300/90 underline decoration-amber-300/30 underline-offset-2 transition-colors hover:text-amber-200"
            >
              open Work
            </button>
          </li>
        ) : null}
        <li className="text-fg/45">No files were removed.</li>
      </ul>
    </>
  );
}

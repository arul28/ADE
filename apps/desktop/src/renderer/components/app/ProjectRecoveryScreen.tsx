import { ArrowLeft, CircleNotch } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  RECOVERY_COPY,
  REPAIR_STEPS,
  stateForCode,
  toAdeRecoveryErrorCode,
  type ProjectRecoveryDiagnosis,
  type ProjectRepairReport,
  type RepairStepId,
  type RepairStepResult,
} from "../../../shared/types/recovery";
import { useAppStore } from "../../state/appStore";
import { settingsRouteFor } from "../settings/settingsManifest";
import { WorkToolPickerBackdrop } from "../terminals/WorkToolPickerBackdrop";
import {
  ERROR_BODY,
  ERROR_HEADLINE,
  ERROR_PRIMARY_BUTTON,
  ERROR_SECONDARY_BUTTON,
  ErrorSurfaceCard,
  TechnicalDetailsFold,
  type ErrorSurfaceTone,
} from "./errorSurfaceKit";
import { ReportIssueButton } from "./ReportIssueButton";
import { ResetAdeButton } from "./ResetAdeDialog";
import { canRestartAde, clearRestartStamp, restartAde, restartedAdeRecently } from "./restartAde";

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

/** Without Restart ADE, two failed fixes in a row hand the lead to Reset. */
const FAILURES_BEFORE_RESET_LEADS = 2;

type Phase = "diagnosing" | "idle" | "repairing" | "success" | "failure";

/**
 * The escalation ladder, one short line per rung saying what it does. Every
 * state ends on the same three rungs, so nobody reaches a screen whose last
 * word is "quit and reopen ADE": Fix it → Restart ADE → Reset ADE → Report.
 */
const RUNG_HINT = {
  fix: "Restarts ADE's background service and checks this project.",
  settings: "Opens Login Items in System Settings.",
  retry: "Opens the project again.",
  restart: "Quits and reopens ADE.",
  reset: "Removes everything ADE put on this computer. Your code stays.",
  report: "Sends ADE what went wrong and gives you a reference.",
} as const;

/**
 * What a failed fix says, by the step that stopped it. The cause in plain
 * words; the step's raw detail stays in the technical fold.
 */
const FAILED_STEP_HEADLINE: Record<RepairStepId, string> = {
  check_space: "There still isn't enough free space",
  stop_service: "Another copy of ADE is in the way",
  validate_database: "This project's ADE data is damaged",
  resolve_migrations: "ADE couldn't finish an interrupted save",
  restart_service: "ADE's background service still won't start",
  verify_endpoint: "ADE's background service isn't answering",
  verify_project_rpc: "ADE started, but this project didn't open",
  reconcile_chats: "ADE started, but couldn't check the chats",
};

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

function projectLabel(rootPath: string | null): string {
  if (!rootPath) return "ADE";
  const segments = rootPath.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? rootPath;
}

const SPINNER = (
  <CircleNotch size={12} weight="bold" aria-hidden="true" className="shrink-0 animate-spin text-(color:--kit-text-3)" />
);

function StepRow({ step }: { step: RepairStepResult }) {
  return (
    <li className="flex items-center gap-2.5 text-[12.5px] leading-snug">
      <span className="flex w-3 shrink-0 justify-center">
        <span
          className="kit-dot"
          data-state={step.status === "ok" ? "ok" : step.status === "failed" ? "crit" : undefined}
          aria-hidden="true"
        />
      </span>
      <span
        className={
          step.status === "failed"
            ? "font-medium text-fg"
            : step.status === "skipped"
              ? "text-(color:--kit-text-3)"
              : "text-(color:--kit-text-2)"
        }
      >
        {step.label}
      </span>
    </li>
  );
}

/** Numbered, because these are done in order. */
function DoTheseSteps({ steps }: { steps: readonly string[] }) {
  return (
    <ol className="mt-4 flex list-decimal flex-col gap-1 pl-5 text-[12.5px] leading-relaxed text-(color:--kit-text-2) marker:text-(color:--kit-text-3)">
      {steps.map((step) => (
        <li key={step}>{step}</li>
      ))}
    </ol>
  );
}

/** One rung: its control on the left, what it does on the right. */
function Rung({ control, hint, failed = false }: { control: ReactNode; hint: string; failed?: boolean }) {
  return (
    <li className="contents">
      <span className="flex items-center gap-2">{control}</span>
      <span className="flex min-w-0 items-center gap-2 text-[12px] leading-snug text-(color:--kit-text-2)">
        <span className="min-w-0">{hint}</span>
        {failed ? (
          <span className="kit-tag shrink-0" data-tone="crit">Didn&apos;t work</span>
        ) : null}
      </span>
    </li>
  );
}

export function ProjectRecoveryScreen() {
  const navigate = useNavigate();
  const projectTransitionError = useAppStore((s) => s.projectTransitionError);
  const clearProjectTransitionError = useAppStore((s) => s.clearProjectTransitionError);
  const switchProjectToPath = useAppStore((s) => s.switchProjectToPath);
  const theme = useAppStore((s) => s.theme);

  const rootPath = projectTransitionError?.rootPath ?? null;
  const code = toAdeRecoveryErrorCode(projectTransitionError?.code) ?? "unknown";

  const [diagnosis, setDiagnosis] = useState<ProjectRecoveryDiagnosis | null>(null);
  const [phase, setPhase] = useState<Phase>("diagnosing");
  const [report, setReport] = useState<ProjectRepairReport | null>(null);
  const [revealed, setRevealed] = useState(0);
  // Steps pushed by the main process while the repair is still running. The
  // final report replaces them; until then they are what the user watches.
  const [liveSteps, setLiveSteps] = useState<RepairStepResult[]>([]);
  // A thrown repair's raw message. Only ever shown inside the technical fold.
  const [repairError, setRepairError] = useState<string | null>(null);
  const [failedFixes, setFailedFixes] = useState(0);
  // Read once: Restart ADE ends this renderer, so a stamp from before the
  // relaunch is how the screen knows that rung was already climbed.
  const [restartedRecently] = useState(() => restartedAdeRecently());
  const [restartFailed, setRestartFailed] = useState(false);
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
        } else if (report.failureCode === "background_item_blocked") {
          // The fix ran into the switch only the person can flip. That is the
          // blocked flow — Open System Settings, then watch — not a failure to
          // climb past with Restart or Reset.
          setDiagnosis((prev) => ({
            ...(prev ?? {
              technicalDetail: "",
              headline: RECOVERY_COPY.background_blocked.headline,
              body: RECOVERY_COPY.background_blocked.body,
            }),
            state: "background_blocked",
            code: "background_item_blocked",
            canAutoRepair: false,
          }));
          setPhase("idle");
        } else {
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
            clearRestartStamp();
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
    clearRestartStamp();
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

  const onRestart = useCallback(() => {
    setRestartFailed(false);
    void restartAde().then((started) => {
      if (!started) setRestartFailed(true);
    });
  }, []);

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
  const isRepairing = phase === "repairing";
  const isSuccess = phase === "success";
  const isFailure = phase === "failure";
  const repairOffered = canAutoRepair && !starting;
  const storageRelevant = state === "disk_full" || state === "insufficient_headroom";
  const restartAvailable = canRestartAde();
  // Report issue renders nothing on a preload without the diagnostics bridge;
  // its hint must not be left standing alone.
  const reportAvailable = typeof window.ade?.diagnostics?.openIssue === "function";

  const technicalText = [
    diagnosis?.technicalDetail,
    projectTransitionError?.detail,
    projectTransitionError?.message,
    repairError ? `repairError: ${repairError}` : null,
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
    ? report.steps.slice(0, isRepairing ? revealed : undefined)
    : liveSteps;
  // What the fix is doing right now: the step after the last finished one.
  const activeStepLabel = isRepairing && !report
    ? (liveSteps.length ? REPAIR_STEP_LABELS[liveSteps.length] ?? null : REPAIR_STEP_LABELS[0])
    : null;

  const failedStep = report?.steps.find((step) => step.status === "failed")?.id ?? null;
  const heroHeadline = isFailure
    ? (failedStep ? FAILED_STEP_HEADLINE[failedStep] : "That didn't fix it")
    : copy.headline;
  const heroBody = isFailure
    ? (report?.nextAction ?? "ADE tried, but the problem is still there. Nothing was removed.")
    : copy.body;

  // Which rung leads, i.e. gets the one filled button. A failed fix climbs to
  // Restart ADE; a fix that fails again after a restart climbs to Reset. With
  // no way to restart from here, two failed fixes in a row hand it to Reset.
  const resetLeads = isFailure && (restartAvailable
    ? restartedRecently
    : failedFixes >= FAILURES_BEFORE_RESET_LEADS);
  const restartLeads = isFailure && !resetLeads && restartAvailable;
  const firstRungLeads = !resetLeads && !restartLeads;

  // The state's own first rung: what fixes this particular problem.
  let firstRung: { label: string; hint: string; onClick: () => void } | null = null;
  if (backgroundBlocked) {
    firstRung = { label: "Open System Settings", hint: RUNG_HINT.settings, onClick: openBackgroundSettings };
  } else if (repairOffered) {
    firstRung = { label: isFailure ? "Try again" : "Fix it", hint: RUNG_HINT.fix, onClick: () => void runRepair() };
  } else if (rootPath && !starting) {
    firstRung = { label: "Try again", hint: RUNG_HINT.retry, onClick: reopenProject };
  }

  const tone: ErrorSurfaceTone = isSuccess ? "success" : starting || isRepairing ? "neutral" : isFailure ? "error" : "warning";
  const status = isSuccess
    ? "Fixed"
    : isRepairing
      ? "Fixing"
      : starting
        ? "Starting"
        : backgroundBlocked
          ? "Waiting for you"
          : isFailure
            ? "Still broken"
            : canAutoRepair ? "Needs a fix" : "Needs you";

  return (
    <div
      className="absolute inset-0 z-30 overflow-y-auto text-fg"
      role="region"
      aria-label="Project recovery"
    >
      {/* The same window-wide scene as the top bar and the home page: the
          card floats over it instead of over an opaque slab. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
        <WorkToolPickerBackdrop theme={theme} field="window" />
      </div>
      {/* Centred, but as a min-height row rather than `items-center` on the
          scroller: a card taller than the window would otherwise have its top
          — Back included — clipped above the scroll origin. */}
      <div className="flex min-h-full items-center justify-center px-6 py-10">
      <div className="w-full max-w-[540px]">
        <ErrorSurfaceCard
          tone={tone}
          label={projectLabel(rootPath)}
          status={status}
          action={(
            <button type="button" onClick={clearProjectTransitionError} className="kit-card-head-action">
              <ArrowLeft size={12} weight="bold" />
              Back
            </button>
          )}
          headline={heroHeadline}
          body={heroBody}
          hero={isSuccess ? <SuccessCard report={report} onOpenWork={() => navigate("/work")} /> : undefined}
        >
          {/* What the person does themselves, in order. Only real chores. */}
          {!isSuccess && !isRepairing && !isFailure && !starting && copy.steps ? (
            <DoTheseSteps steps={copy.steps} />
          ) : null}

          {/* Fix progress, or the checklist of a fix that did not work. */}
          {isRepairing || (isFailure && report) ? (
            <div className="mt-4 rounded-[var(--radius-md)] border border-(color:--kit-panel-edge) bg-(color:--kit-panel-bg) px-3.5 py-3">
              {isRepairing ? (
                <div className="mb-2 flex items-center gap-2.5 text-[12.5px] font-medium text-fg">
                  <span className="flex w-3 justify-center">{SPINNER}</span>
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

          {/* The ladder. Hidden while a fix runs and once it worked. */}
          {!isRepairing && !isSuccess ? (
            <>
              <ul className="mt-5 grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-4 gap-y-2.5">
                {starting ? (
                  // Someone else is doing the work: say who, so nobody hunts for a button.
                  <Rung
                    control={<span className="flex h-[30px] items-center gap-2 text-[12.5px] font-medium">{SPINNER}Waiting for ADE…</span>}
                    hint="You can leave this screen; nothing needs fixing yet."
                  />
                ) : null}
                {firstRung ? (
                  <Rung
                    control={(
                      <>
                        <button
                          type="button"
                          onClick={firstRung.onClick}
                          className={firstRungLeads ? ERROR_PRIMARY_BUTTON : ERROR_SECONDARY_BUTTON}
                        >
                          {firstRung.label}
                        </button>
                      </>
                    )}
                    hint={firstRung.hint}
                    failed={isFailure && repairOffered}
                  />
                ) : null}
                {storageRelevant && !isFailure ? (
                  <Rung
                    control={(
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
                    )}
                    hint="Opens ADE's storage settings."
                  />
                ) : null}
                {restartAvailable ? (
                  <Rung
                    control={(
                      <button type="button" onClick={onRestart} className={restartLeads ? ERROR_PRIMARY_BUTTON : ERROR_SECONDARY_BUTTON}>
                        Restart ADE
                      </button>
                    )}
                    hint={restartFailed ? "ADE couldn't restart itself. Quit it from the menu, then open it again." : RUNG_HINT.restart}
                    failed={isFailure && restartedRecently}
                  />
                ) : null}
                <Rung
                  control={<ResetAdeButton label="Reset ADE…" className={resetLeads ? ERROR_PRIMARY_BUTTON : ERROR_SECONDARY_BUTTON} />}
                  hint={RUNG_HINT.reset}
                />
              </ul>

              {backgroundBlocked ? (
                <p className="mt-4 flex items-center gap-2 text-[12px] text-(color:--kit-text-3)">
                  {SPINNER}
                  Watching for the change. ADE continues as soon as your Mac allows it.
                </p>
              ) : null}

              {reportAvailable ? (
                <>
                  <hr className="kit-rule" style={{ marginTop: 18 }} />
                  {/* The last rung: when nothing above worked, tell ADE. The hint
                      steps aside once the button reports its own result. */}
                  <div className="group/report mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <ReportIssueButton
                      variant="ghost"
                      showDisclosure={false}
                      context={{
                        surface: "project_recovery",
                        headline: heroHeadline,
                        code,
                        technicalDetail: technicalText,
                        projectRoot: rootPath,
                      }}
                    />
                    <span className="text-[12px] text-(color:--kit-text-3) group-has-[[role=status]]/report:hidden">
                      {RUNG_HINT.report}
                    </span>
                  </div>
                </>
              ) : null}
            </>
          ) : null}
        </ErrorSurfaceCard>

        <TechnicalDetailsFold text={technicalText} className="mt-3" />
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
      <ul className={ERROR_BODY + " mt-2 flex flex-col gap-1"}>
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
              className="font-medium text-fg underline decoration-(color:--kit-text-3) underline-offset-2 transition-colors hover:decoration-fg"
            >
              open Work
            </button>
          </li>
        ) : null}
        <li className="text-(color:--kit-text-3)">No files were removed.</li>
      </ul>
    </>
  );
}

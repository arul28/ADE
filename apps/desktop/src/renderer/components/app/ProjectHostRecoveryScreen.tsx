import { useCallback, useEffect, useState } from "react";
import { Check, CircleNotch, Desktop, Warning } from "@phosphor-icons/react";
import { useLocation, useNavigate } from "react-router-dom";
import { projectHostBlockedReason } from "../../../shared/syncHostRecoveryUi";
import type {
  SyncHostRecoveryStepId,
  SyncHostRecoveryStepStatus,
} from "../../../shared/types/syncHostRecovery";
import {
  ERROR_GHOST_BUTTON,
  ERROR_PRIMARY_BUTTON,
  ERROR_SECONDARY_BUTTON,
  ErrorSurfaceCard,
  TechnicalDetailsFold,
} from "../../components/app/errorSurfaceKit";
import type { ProjectHostRecoveryState } from "../../webclient/sync/projectHostRecoveryStore";
import {
  getProjectHostRecoveryState,
  recoverProjectHost,
  retryProjectHost,
  subscribeProjectHostRecovery,
} from "../../webclient/sync/projectHostRecoveryStore";

function useProjectHostRecovery(): ProjectHostRecoveryState {
  const [state, setState] = useState(getProjectHostRecoveryState);
  useEffect(() => subscribeProjectHostRecovery(setState), []);
  return state;
}

/**
 * Two forms per step: what it is doing, and what it did. A finished step that
 * still reads "Stopping…" is the reason status words leaked into this list in
 * the first place.
 */
const STEP_LABELS: Record<SyncHostRecoveryStepId, { active: string; done: string }> = {
  diagnose: { active: "Checking this machine", done: "Checked this machine" },
  stop: { active: "Stopping the blocking runtime", done: "Stopped blocking runtime" },
  wait: { active: "Freeing the connection", done: "Connection freed" },
  start: { active: "Starting the project connection", done: "Started the project connection" },
  restart: { active: "Restarting this machine", done: "Restarted this machine" },
  prove: { active: "Checking chats", done: "Chats are back" },
};

// `string`, not `SyncHostRecoveryStepId`: a newer host really can name a step
// this build has no label for, and typing the parameter to the known union
// would make the guard below look like dead code to the next reader.
function stepLabel(id: string, status: SyncHostRecoveryStepStatus): string {
  const labels = (STEP_LABELS as Record<string, { active: string; done: string }>)[id];
  if (!labels) return id;
  return status === "done" ? labels.done : labels.active;
}

function StepMark({ status }: { status: SyncHostRecoveryStepStatus }) {
  return (
    <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center" aria-hidden="true">
      {status === "done" ? <Check size={12} weight="bold" className="text-emerald-400/80" /> : null}
      {status === "failed" ? <Warning size={12} weight="bold" className="text-amber-300" /> : null}
      {status === "active" ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-300" /> : null}
      {status === "pending" ? <span className="h-1.5 w-1.5 rounded-full border border-fg/30" /> : null}
    </span>
  );
}

/** One sentence for the conflicts this browser is not allowed to end itself. */
const BLOCKED_COPY = {
  unauthorized: "This browser can't stop the other runtime — retry, switch machines, or stop it on that computer.",
  unidentified: "ADE can't safely stop the other runtime from here, so stop it on that computer.",
} as const;

export function ProjectHostRecoveryScreen() {
  const navigate = useNavigate();
  const { phase, snapshot, recovery } = useProjectHostRecovery();
  const [busy, setBusy] = useState(false);

  const onFix = useCallback(async () => {
    setBusy(true);
    try {
      await recoverProjectHost();
    } finally {
      setBusy(false);
    }
  }, []);

  const onRetry = useCallback(async () => {
    setBusy(true);
    try {
      await retryProjectHost();
    } finally {
      setBusy(false);
    }
  }, []);

  if (phase === "ready" || phase === "retrying" || !snapshot) return null;

  const recovering = phase === "recovering" || busy || recovery?.status === "running" || recovery?.status === "restarting";
  const conflict = snapshot.conflict;
  const canFix = snapshot.recoveryEligible && Boolean(conflict);
  const blocked = recovering ? null : projectHostBlockedReason(snapshot);
  const steps = (recovery?.steps ?? []).filter((step) => step.status !== "skipped");
  // The redacted detail is the same sentence the blocked copy already says.
  const technical = blocked === "unauthorized" ? "" : conflict?.technicalDetail?.trim() ?? "";

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-bg/95 px-4">
      <div className="w-full max-w-lg">
        <ErrorSurfaceCard
          tone={recovering ? "neutral" : "warning"}
          icon={recovering
            ? <CircleNotch size={16} weight="bold" className="animate-spin" />
            : <Warning size={16} weight="bold" />}
          headline={recovering ? "Fixing the connection…" : snapshot.headline}
          body={recovering ? undefined : snapshot.body}
        >
          {conflict && !recovering ? (
            <div className="mt-3 space-y-0.5 text-[12.5px] text-fg/55">
              <p>{conflict.ownerLabel}</p>
              {conflict.projectLabel ? <p>{conflict.projectLabel}</p> : null}
              {conflict.impact ? <p className="text-fg/45">{conflict.impact}</p> : null}
            </div>
          ) : null}
          {blocked ? (
            <p className="mt-3 text-[12.5px] leading-relaxed text-fg/60">{BLOCKED_COPY[blocked]}</p>
          ) : null}
          {recovering && steps.length ? (
            <ol className="mt-4 space-y-1.5 text-[12.5px] text-fg/70">
              {steps.map((step) => (
                <li key={step.id} className="flex items-center gap-2">
                  <StepMark status={step.status} />
                  <span className={step.status === "pending" ? "text-fg/45" : undefined}>
                    {stepLabel(step.id, step.status)}
                  </span>
                </li>
              ))}
            </ol>
          ) : null}
          {recovering ? (
            <p className="mt-4 text-[12.5px] text-fg/45">You can switch machines.</p>
          ) : null}
          <div className="mt-5 flex flex-wrap items-center gap-2">
            {canFix ? (
              <button type="button" className={ERROR_PRIMARY_BUTTON} disabled={recovering} onClick={() => void onFix()}>
                Fix connection
              </button>
            ) : null}
            {/* Retry stays live during the repair. A restart that never comes
                back would otherwise leave this card an inert spinner. */}
            <button type="button" className={canFix ? ERROR_SECONDARY_BUTTON : ERROR_PRIMARY_BUTTON} disabled={busy} onClick={() => void onRetry()}>
              Retry
            </button>
            {/* Leaving for another machine is safe at any time, including mid-repair. */}
            <button
              type="button"
              className={ERROR_GHOST_BUTTON}
              onClick={() => navigate("/account")}
            >
              <Desktop size={14} weight="bold" />
              Switch Mac
            </button>
          </div>
          <TechnicalDetailsFold text={technical} className="mt-4" />
        </ErrorSurfaceCard>
      </div>
    </div>
  );
}

/**
 * What the lists below this banner are, so "may be out of date" names the rows
 * the person is actually looking at. The banner is the one shared place that
 * sits above every project surface, so marking staleness here keeps each list
 * component out of it.
 */
function staleListLabel(pathname: string): string {
  if (pathname.startsWith("/files")) return "files";
  if (pathname.startsWith("/prs")) return "pull requests";
  if (pathname.startsWith("/lanes")) return "lanes";
  return "chats";
}

export function ProjectHostStartingBanner() {
  const { phase } = useProjectHostRecovery();
  const { pathname } = useLocation();
  const [busy, setBusy] = useState(false);

  const onRetry = useCallback(async () => {
    setBusy(true);
    try {
      await retryProjectHost();
    } finally {
      setBusy(false);
    }
  }, []);

  if (phase !== "retrying") return null;
  return (
    <div className="border-b border-border/60 bg-fg/[0.03]">
      <div className="flex items-center justify-center gap-2 px-3 py-1.5 text-[12.5px] text-fg/65">
        <CircleNotch size={13} weight="bold" className="animate-spin" />
        Still starting this project&apos;s services…
        <button type="button" className={ERROR_GHOST_BUTTON} disabled={busy} onClick={() => void onRetry()}>
          Retry
        </button>
      </div>
      <div className="flex items-center gap-2 px-3 pb-1.5 text-[11px] text-fg/40">
        <span className="h-px flex-1 bg-border/60" />
        {staleListLabel(pathname)} (may be out of date)
        <span className="h-px flex-1 bg-border/60" />
      </div>
    </div>
  );
}

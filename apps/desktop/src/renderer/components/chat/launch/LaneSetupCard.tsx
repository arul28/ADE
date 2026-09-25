import React, { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowClockwise,
  ArrowSquareOut,
  CaretRight,
  Check,
  Circle,
  CloudArrowDown,
  Copy,
  Files,
  HardDrives,
  Key,
  Lightning,
  Minus,
  Package,
  Play,
  Scroll,
  ShippingContainer,
  Sparkle,
  Stack,
  TerminalWindow,
  Trash,
  Warning,
  Wrench,
  X,
  type Icon,
} from "@phosphor-icons/react";
import type { AdeCardPayload, AdeCardRow } from "../../../../shared/adeCard";
import type {
  ChatLaunchKind,
  ChatLaunchSnapshot,
  ChatLaunchStage,
  ChatLaunchStageId,
  ChatLaunchStageStatus,
  LaneEnvInitStep,
} from "../../../../shared/types";
import {
  CHAT_LAUNCH_STAGE_ORDER,
  LANE_SETUP_CARD_TEMPLATE_METRIC,
  chatLaunchHasWarnings,
  chatLaunchStageDurationMs,
  chatLaunchStageLabel,
  formatChatLaunchDuration,
  isChatLaunchPending,
  isChatLaunchTerminal,
  laneSetupLaunchIdFromCardId,
} from "../../../../shared/chatLaunch";
import { cn } from "../../ui/cn";
import { BranchIcon, LaneIcon } from "../../ui/vcsIcons";
import { confirmDialog } from "../../ui/dialog";
import { LaneNamingLabel } from "../../terminals/LaneNamingLabel";
import { STANDARD_EASE } from "../../../lib/motion";
import { getChatLaunchEntry, refreshChatLaunch, useChatLaunchHostReady, useChatLaunchSnapshot } from "../../../state/chatLaunchStore";
import { extractError } from "../../../lib/format";
import { stripElectronErrorWrapper } from "../../../../shared/codedError";
import { showToast } from "../../app/toast/toastStore";
import { CHAT_CARD_WIDTH_CLASS } from "../chatCardPrimitives";
import {
  cancelChatLaunch,
  retryChatLaunch,
  startChatLaunchNow,
} from "./chatLaunchActions";
import { LaunchProgressRail } from "./LaunchProgressRail";
import { useLaunchDurationText } from "./launchClock";

/**
 * The lane setup card: a header (phase tile, title, lane + base chips, live
 * elapsed), the shared segmented progress rail, then one row per stage the
 * host reports — `[stage icon] label  detail ........ duration [status]` —
 * with the environment's own steps nested underneath, then small text actions.
 *
 * Rendered in three places from the same snapshot: under the prompt bubble of
 * a chat whose lane is still being set up (`variant="thread"`), inside a row
 * of the Launches slide-out (`variant="compact"`), and — once the launch is
 * over — as a one-line "Lane set up in 4.2s ›" summary in the transcript that
 * expands back to the stage list.
 *
 * Colour carries status everywhere: running is ADE violet, done is emerald,
 * warning and failure are amber — never red (house rule in `shared/adeCard.ts`).
 *
 * Render cost: stage rows are memoized and the store keeps unchanged stage
 * objects across snapshots, so a checkout percent tick re-renders the card
 * shell, the rail and the checkout row only. Durations read the shared
 * launch clock (`launchClock.ts`) and re-render just their own text.
 */

export type LaneSetupCardVariant = "thread" | "compact";

/* ── Status palette ─────────────────────────────────────────────────────── */

type Status = ChatLaunchStageStatus | LaneEnvInitStep["status"];

function normalizeStatus(status: Status): ChatLaunchStageStatus {
  return status === "completed" ? "done" : status;
}

/** Tile tones by status; the Launches slide-out indexes the same palette. */
export const TILE_TONE: Record<ChatLaunchStageStatus, string> = {
  running: "border-violet-400/25 bg-violet-400/[0.12] text-violet-200",
  done: "border-emerald-400/15 bg-emerald-400/[0.08] text-emerald-300/85",
  warning: "border-amber-400/20 bg-amber-400/[0.08] text-amber-300/90",
  failed: "border-amber-400/25 bg-amber-400/[0.10] text-amber-300",
  skipped: "border-white/[0.05] bg-white/[0.02] text-fg/25",
  pending: "border-white/[0.06] bg-white/[0.025] text-fg/30",
};

const LABEL_TONE: Record<ChatLaunchStageStatus, string> = {
  running: "text-fg/90",
  done: "text-fg/68",
  warning: "text-amber-100/90",
  failed: "text-amber-100/90",
  skipped: "text-fg/35",
  pending: "text-fg/40",
};

/* ── Icons ──────────────────────────────────────────────────────────────── */

export function launchStageIcon(id: ChatLaunchStageId, context: { kind: ChatLaunchKind; templateName?: string | null }): Icon {
  switch (id) {
    case "fetch":
      return CloudArrowDown;
    case "checkout":
      return Files;
    case "environment":
      return context.templateName ? Stack : Wrench;
    case "agent":
      return context.kind === "cli" ? TerminalWindow : Sparkle;
  }
}

const ENV_STEP_ICON: Record<LaneEnvInitStep["kind"], Icon> = {
  "env-files": Key,
  docker: ShippingContainer,
  dependencies: Package,
  "mount-points": HardDrives,
  "copy-paths": Copy,
  "setup-script": Scroll,
};

/** A transcript payload row's stage id: its `key` (every `lane_setup` row carries one). */
function stageIdForCardRow(row: AdeCardRow): ChatLaunchStageId | null {
  const key = row.key?.trim();
  return key && (CHAT_LAUNCH_STAGE_ORDER as readonly string[]).includes(key) ? key as ChatLaunchStageId : null;
}

/** A payload card's launch kind, read off its `agent` row (the shared builder labels it per kind). */
function launchKindForCardRows(rows: readonly AdeCardRow[]): ChatLaunchKind {
  const agentRow = rows.find((row) => stageIdForCardRow(row) === "agent");
  return agentRow?.text === chatLaunchStageLabel("agent", { kind: "cli" }) ? "cli" : "chat";
}

/* ── Glyphs ──────────────────────────────────────────────────────────────── */

function SpinnerRing({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      className="motion-safe:animate-spin"
      aria-hidden
      data-launch-glyph="running"
    >
      <circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" strokeOpacity="0.22" strokeWidth="1.4" />
      <path d="M6 1.4 A4.6 4.6 0 0 1 10.6 6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** The small status mark at the end of a row (and the slide-out row's leading mark). */
export function LaunchStageGlyph({
  status,
  size = 12,
}: {
  status: Status;
  size?: number;
}) {
  switch (normalizeStatus(status)) {
    case "done":
      return (
        <span className="grid place-items-center text-emerald-300/80" data-launch-glyph="done">
          <Check size={size - 1} weight="bold" aria-hidden />
        </span>
      );
    case "running":
      return <span className="grid place-items-center text-violet-300/90"><SpinnerRing size={size} /></span>;
    case "warning":
      return (
        <span className="grid place-items-center text-amber-300/85" data-launch-glyph="warning">
          <Warning size={size} weight="bold" aria-hidden />
        </span>
      );
    case "failed":
      return (
        <span className="grid place-items-center text-amber-300/90" data-launch-glyph="failed">
          <X size={size - 1} weight="bold" aria-hidden />
        </span>
      );
    case "skipped":
      return (
        <span className="grid place-items-center text-fg/25" data-launch-glyph="skipped">
          <Minus size={size - 1} weight="bold" aria-hidden />
        </span>
      );
    default:
      return (
        <span className="grid place-items-center text-fg/20" data-launch-glyph="pending">
          <Circle size={size - 1} weight="regular" aria-hidden />
        </span>
      );
  }
}

/** A status mark that fades in when the status changes (CSS, transform/opacity only). */
function StatusMark({ status, size }: { status: Status; size: number }) {
  return (
    <span key={normalizeStatus(status)} className="ade-launch-glyph-in grid h-4 w-4 shrink-0 place-items-center">
      <LaunchStageGlyph status={status} size={size} />
    </span>
  );
}

function StageTile({ icon: IconComponent, status, compact }: { icon: Icon; status: Status; compact: boolean }) {
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-[6px] border transition-colors duration-300",
        compact ? "h-[18px] w-[18px]" : "h-5 w-5",
        TILE_TONE[normalizeStatus(status)],
      )}
      aria-hidden
    >
      <IconComponent size={compact ? 10.5 : 11.5} weight={normalizeStatus(status) === "running" ? "bold" : "regular"} />
    </span>
  );
}

/* ── Durations ──────────────────────────────────────────────────────────── */

function StageDuration({ stage, className }: { stage: ChatLaunchStage; className?: string }) {
  const live = stage.status === "running" && Boolean(stage.startedAt) && !stage.endedAt;
  const text = useLaunchDurationText(stage.startedAt, stage.endedAt, live);
  return (
    <span className={cn("tabular-nums", className)} data-testid="lane-setup-stage-duration">
      {text}
    </span>
  );
}

function LaunchElapsed({ snapshot, className }: { snapshot: ChatLaunchSnapshot; className?: string }) {
  const live = !snapshot.endedAt && (snapshot.phase === "running" || snapshot.phase === "awaiting-client");
  const text = useLaunchDurationText(snapshot.startedAt, snapshot.endedAt, live);
  return <span className={cn("shrink-0 tabular-nums", className)} data-testid="lane-setup-elapsed">{text}</span>;
}

function launchDurationMs(snapshot: ChatLaunchSnapshot, nowMs: number): number | null {
  return chatLaunchStageDurationMs({ startedAt: snapshot.startedAt, endedAt: snapshot.endedAt }, nowMs);
}

/* ── Copy ──────────────────────────────────────────────────────────────── */

function laneSetupTitle(snapshot: ChatLaunchSnapshot, nowMs = Date.now()): string {
  switch (snapshot.phase) {
    case "failed":
      return "Lane setup failed";
    case "cancelled":
      return "Lane setup cancelled";
    case "completed": {
      const duration = formatChatLaunchDuration(launchDurationMs(snapshot, nowMs));
      const warned = chatLaunchHasWarnings(snapshot);
      const lead = warned ? "Lane set up with warnings" : "Lane set up";
      return duration ? `${lead} in ${duration}` : lead;
    }
    case "awaiting-client":
      return "Starting CLI session…";
    default:
      return "Setting up lane…";
  }
}

/**
 * Past the point Cancel/Delete can undo: the agent (or CLI session) runs. The
 * host refuses a cancel from here on, so the card never sends one.
 */
function launchPastCancel(snapshot: Pick<ChatLaunchSnapshot, "agentStarted" | "phase">): boolean {
  return snapshot.agentStarted || snapshot.phase === "completed";
}

const NOTHING_TO_CANCEL_NOTICE = "Setup finished — nothing to cancel";

/* ── Action visibility ─────────────────────────────────────────────────────
   Pure so the rules are testable without rendering. */

export type LaneSetupActions = {
  cancel: boolean;
  startNow: boolean;
  retry: boolean;
  startAnyway: boolean;
  delete: boolean;
};

export function laneSetupActions(snapshot: ChatLaunchSnapshot): LaneSetupActions {
  const running = snapshot.phase === "running" || snapshot.phase === "awaiting-client";
  const failed = snapshot.phase === "failed";
  const environment = snapshot.stages.find((stage) => stage.id === "environment") ?? null;
  const failedStage = snapshot.stages.find((stage) => stage.status === "failed") ?? null;
  return {
    cancel: running,
    startNow: running && !snapshot.agentStarted && environment?.status === "running",
    retry: failed,
    startAnyway: failed && snapshot.laneCreated && failedStage?.id === "environment",
    delete: failed,
  };
}

/* ── Rows ──────────────────────────────────────────────────────────────── */

const EnvironmentSteps = React.memo(function EnvironmentSteps({ steps, compact }: { steps: LaneEnvInitStep[]; compact: boolean }) {
  if (steps.length === 0) return null;
  return (
    <ul
      className={cn(
        "mb-1.5 ml-[9px] space-y-px border-l border-white/[0.07] pl-[17px]",
        compact ? "text-[10.5px]" : "text-[length:calc(var(--chat-font-size)*11/14)]",
      )}
    >
      {steps.map((step, index) => {
        const status = normalizeStatus(step.status);
        const StepIcon = ENV_STEP_ICON[step.kind] ?? Wrench;
        return (
          <li
            key={`${step.kind}:${index}`}
            className="flex h-[20px] min-w-0 items-center gap-2"
            data-testid="lane-setup-env-step"
            data-step-status={status}
          >
            <StepIcon
              size={11}
              aria-hidden
              className={cn(
                "shrink-0 transition-colors duration-300",
                status === "running" ? "text-violet-300/90"
                  : status === "done" ? "text-emerald-300/65"
                    : status === "failed" ? "text-amber-300/85"
                      : "text-fg/25",
              )}
            />
            <span className={cn("min-w-0 flex-1 truncate", status === "pending" || status === "skipped" ? "text-fg/35" : status === "running" ? "text-fg/78" : "text-fg/55")}>
              {step.label}
            </span>
            {status === "failed" && step.error ? (
              <span className="min-w-0 max-w-[55%] truncate text-amber-200/75" title={step.error}>{step.error}</span>
            ) : typeof step.durationMs === "number" ? (
              <span className="shrink-0 tabular-nums text-fg/30">{formatChatLaunchDuration(step.durationMs)}</span>
            ) : null}
            <StatusMark status={step.status} size={9} />
          </li>
        );
      })}
    </ul>
  );
});

/** One stage line, shared by the live card and the transcript-payload fallback. */
function StageLine({
  icon,
  status,
  label,
  detail,
  percent,
  trailing,
  compact,
}: {
  icon: Icon;
  status: ChatLaunchStageStatus;
  label: string;
  detail: string | null;
  percent?: number | null;
  trailing?: React.ReactNode;
  compact: boolean;
}) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2.5", compact ? "h-[28px]" : "h-[32px]")}>
      <StageTile icon={icon} status={status} compact={compact} />
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className={cn("shrink-0 transition-colors duration-200", LABEL_TONE[status])}>{label}</span>
        {detail ? <span className="min-w-0 truncate text-fg/35" title={detail}>{detail}</span> : null}
        {percent != null ? (
          <span className="shrink-0 tabular-nums text-violet-200/80">{`${percent}%`}</span>
        ) : null}
      </div>
      {trailing}
      <StatusMark status={status} size={compact ? 11 : 12} />
    </div>
  );
}

const StageRow = React.memo(function StageRow({
  stage,
  kind,
  templateName,
  compact,
  showSteps,
}: {
  stage: ChatLaunchStage;
  kind: ChatLaunchKind;
  templateName: string | null;
  compact: boolean;
  showSteps: boolean;
}) {
  const context = { kind, templateName };
  const detail = stage.detail?.trim() || null;
  const percent = stage.id === "checkout" && stage.status === "running" ? stage.percent : null;
  return (
    <li data-testid="lane-setup-stage" data-stage-id={stage.id} data-stage-status={stage.status}>
      <StageLine
        icon={launchStageIcon(stage.id, context)}
        status={stage.status}
        label={chatLaunchStageLabel(stage.id, context)}
        detail={detail}
        percent={percent}
        compact={compact}
        trailing={<StageDuration stage={stage} className="min-w-[3rem] shrink-0 text-right text-fg/35" />}
      />
      {(stage.status === "failed" || stage.status === "warning") && stage.error ? (
        <p
          className={cn(
            "mb-1.5 ml-[30px] rounded-md border border-amber-400/15 bg-amber-400/[0.06] px-2 py-1 leading-snug text-amber-200/85",
            compact ? "text-[10.5px]" : "text-[length:calc(var(--chat-font-size)*11/14)]",
          )}
        >
          {stage.error}
        </p>
      ) : null}
      {stage.id === "environment" && showSteps && stage.steps?.length ? (
        <EnvironmentSteps steps={stage.steps} compact={compact} />
      ) : null}
    </li>
  );
});

function DetailsList({ snapshot, compact }: { snapshot: ChatLaunchSnapshot; compact: boolean }) {
  const rows: Array<[string, string, boolean?]> = [];
  if (snapshot.branchRef) rows.push(["Branch", snapshot.branchRef.replace(/^refs\/heads\//, ""), true]);
  if (snapshot.baseRef) rows.push(["Base", snapshot.baseRef, true]);
  if (snapshot.worktreePath) rows.push(["Worktree", snapshot.worktreePath, true]);
  if (snapshot.templateName) rows.push([LANE_SETUP_CARD_TEMPLATE_METRIC, snapshot.templateName]);
  if (snapshot.error) rows.push(["Error", snapshot.error]);
  if (rows.length === 0) return null;
  return (
    <dl
      data-testid="lane-setup-details"
      className={cn(
        "mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-md border border-white/[0.05] bg-black/[0.12] px-2.5 py-2",
        compact ? "text-[10.5px]" : "text-[length:calc(var(--chat-font-size)*11/14)]",
      )}
    >
      {rows.map(([label, value, mono]) => (
        <React.Fragment key={label}>
          <dt className="text-fg/35">{label}</dt>
          <dd className={cn("min-w-0 truncate", label === "Error" ? "text-amber-200/80" : "text-fg/60", mono && "font-mono")} title={value}>
            {value}
          </dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

function TextAction({
  children,
  onClick,
  tone = "default",
  disabled,
  testId,
}: {
  children: React.ReactNode;
  onClick: () => void;
  tone?: "default" | "primary";
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors disabled:cursor-default disabled:opacity-40",
        tone === "primary"
          ? "text-violet-200/90 hover:bg-violet-400/[0.10] hover:text-violet-100"
          : "text-fg/45 hover:bg-white/[0.04] hover:text-fg/80",
      )}
    >
      {children}
    </button>
  );
}

function Chip({ children, title, mono }: { children: React.ReactNode; title?: string; mono?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-white/[0.06] bg-white/[0.03] px-1.5 py-px text-fg/55",
        mono && "font-mono",
      )}
      title={title}
    >
      {children}
    </span>
  );
}

const PHASE_TILE_TONE: Record<ChatLaunchSnapshot["phase"], string> = {
  running: TILE_TONE.running,
  "awaiting-client": TILE_TONE.running,
  completed: TILE_TONE.done,
  failed: TILE_TONE.failed,
  cancelled: TILE_TONE.skipped,
};

function CardHeader({ snapshot, metaSize }: { snapshot: ChatLaunchSnapshot; metaSize: string }) {
  const failed = snapshot.phase === "failed";
  const base = snapshot.baseRef ?? (snapshot.branchRef ? snapshot.branchRef.replace(/^refs\/heads\//, "") : null);
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <span
        className={cn("mt-px grid h-6 w-6 shrink-0 place-items-center rounded-[7px] border transition-colors duration-300", PHASE_TILE_TONE[snapshot.phase])}
        aria-hidden
      >
        {failed ? <Warning size={13} weight="bold" /> : <LaneIcon size={13} weight="bold" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn("min-w-0 truncate font-medium", failed ? "text-amber-200/90" : "text-fg/82")}
            data-testid="lane-setup-title"
          >
            {laneSetupTitle(snapshot)}
          </span>
          <LaunchElapsed snapshot={snapshot} className={cn("ml-auto text-fg/38", metaSize)} />
        </div>
        <div className={cn("mt-1 flex min-w-0 flex-wrap items-center gap-1.5", metaSize)}>
          <Chip title={snapshot.laneName}>
            <LaneIcon size={10} className="text-violet-300/80" />
            <span className="min-w-0 truncate"><LaneNamingLabel laneName={snapshot.laneName} naming={snapshot.laneNaming} /></span>
          </Chip>
          {base ? (
            <Chip title={base} mono>
              <BranchIcon size={10} className="text-fg/40" />
              <span className="min-w-0 truncate">{base}</span>
            </Chip>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ── The card ──────────────────────────────────────────────────────────── */

export function LaneSetupCard({
  snapshot,
  variant = "thread",
  className,
  onOpen,
  showTitle = true,
}: {
  snapshot: ChatLaunchSnapshot;
  variant?: LaneSetupCardVariant;
  className?: string;
  /** Slide-out only: open the chat / CLI session once it exists. */
  onOpen?: (() => void) | null;
  showTitle?: boolean;
}) {
  const compact = variant === "compact";
  const reduceMotion = useReducedMotion();
  const hostReady = useChatLaunchHostReady(snapshot.launchId);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Set while the Cancel/Delete confirmation is up; aborting withdraws it.
  const [confirmAbort, setConfirmAbort] = useState<AbortController | null>(null);
  const confirmAbortRef = useRef<AbortController | null>(null);
  const actions = laneSetupActions(snapshot);
  const failed = snapshot.phase === "failed";
  const envStage = snapshot.stages.find((stage) => stage.id === "environment");
  const showEnvSteps = Boolean(detailsOpen || envStage?.status === "running" || envStage?.status === "failed");
  const hasDetails = Boolean(snapshot.branchRef || snapshot.baseRef || snapshot.worktreePath || snapshot.templateName || snapshot.error);

  const run = (name: string, action: () => Promise<void>) => {
    if (busy) return;
    setBusy(name);
    setActionError(null);
    setNotice(null);
    void action()
      // The host's own words (e.g. "This chat already started — …"), minus the IPC wrapper.
      .catch((error: unknown) => setActionError(stripElectronErrorWrapper(extractError(error))))
      .finally(() => setBusy(null));
  };

  const confirmDelete = (name: "cancel" | "delete") => {
    const subject = snapshot.kind === "cli" ? "CLI session" : "chat";
    const launchId = snapshot.launchId;
    const abort = new AbortController();
    confirmAbortRef.current = abort;
    setConfirmAbort(abort);
    void confirmDialog({
      title: name === "cancel" ? "Cancel this launch?" : "Delete this launch?",
      message: `ADE deletes the lane it created for this ${subject} — its worktree and its local and remote branch — and the ${subject} itself. Your prompt goes back into the composer.`,
      confirmLabel: `Delete lane and ${subject}`,
      destructive: true,
      signal: abort.signal,
    }).then((ok) => {
      if (confirmAbortRef.current === abort) confirmAbortRef.current = null;
      setConfirmAbort((current) => (current === abort ? null : current));
      if (!ok) return;
      // The launch may have moved on while the dialog was up: never cancel a
      // chat that already runs (its lane is now the user's to delete).
      const latest = getChatLaunchEntry(launchId)?.snapshot ?? null;
      if (!latest || latest.phase === "cancelled") return;
      if (launchPastCancel(latest)) {
        setNotice(NOTHING_TO_CANCEL_NOTICE);
        return;
      }
      run(name, () => cancelChatLaunch(launchId));
    });
  };

  // The launch finished (or was cancelled elsewhere) while the dialog was up:
  // close it and say why, rather than leave a confirm that no longer applies.
  const pastCancel = launchPastCancel(snapshot);
  const cancelledElsewhere = snapshot.phase === "cancelled";
  useEffect(() => {
    if (!confirmAbort || (!pastCancel && !cancelledElsewhere)) return;
    confirmAbort.abort();
    if (pastCancel) setNotice(NOTHING_TO_CANCEL_NOTICE);
  }, [cancelledElsewhere, confirmAbort, pastCancel]);

  // A finished launch can also collapse this card (thread) or drop its row
  // (slide-out) in the same update, taking the dialog with it: say so in a toast.
  const launchIdRef = useRef(snapshot.launchId);
  launchIdRef.current = snapshot.launchId;
  useEffect(() => () => {
    const abort = confirmAbortRef.current;
    if (!abort) return;
    confirmAbortRef.current = null;
    abort.abort();
    const latest = getChatLaunchEntry(launchIdRef.current)?.snapshot;
    if (latest && launchPastCancel(latest)) showToast({ title: NOTHING_TO_CANCEL_NOTICE, tone: "info" });
  }, []);

  const textSize = compact ? "text-[11.5px]" : "text-[length:calc(var(--chat-font-size)*12/14)]";
  const metaSize = compact ? "text-[10.5px]" : "text-[length:calc(var(--chat-font-size)*11/14)]";
  const showActions = hasDetails || (envStage?.steps?.length ?? 0) > 0 || Boolean(onOpen)
    || actions.startNow || actions.retry || actions.startAnyway || actions.delete || actions.cancel;

  return (
    <div
      data-testid="lane-setup-card"
      data-launch-id={snapshot.launchId}
      data-launch-phase={snapshot.phase}
      className={cn(
        "font-sans",
        textSize,
        compact
          ? "w-full"
          : cn(
            CHAT_CARD_WIDTH_CLASS,
            "ade-launch-card-enter rounded-[calc(var(--chat-radius-card,16px)-6px)] border bg-white/[0.022] px-3.5 pb-2 pt-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]",
            failed ? "border-amber-400/20" : "border-white/[0.07]",
          ),
        className,
      )}
    >
      {showTitle ? (
        <>
          <CardHeader snapshot={snapshot} metaSize={metaSize} />
          <LaunchProgressRail stages={snapshot.stages} className="mb-1 mt-3" />
        </>
      ) : null}

      <ul className="divide-y divide-white/[0.045]" aria-label="Lane setup stages">
        {snapshot.stages.map((stage) => (
          <StageRow
            key={stage.id}
            stage={stage}
            kind={snapshot.kind}
            templateName={snapshot.templateName}
            compact={compact}
            showSteps={showEnvSteps}
          />
        ))}
      </ul>

      <AnimatePresence initial={false}>
        {detailsOpen ? (
          <motion.div
            key="details"
            initial={reduceMotion ? false : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={reduceMotion ? undefined : { opacity: 0, height: 0 }}
            transition={{ duration: 0.18, ease: STANDARD_EASE }}
            className="overflow-hidden"
          >
            <DetailsList snapshot={snapshot} compact={compact} />
          </motion.div>
        ) : null}
      </AnimatePresence>

      {actionError ? (
        <p className={cn("mt-1.5 leading-snug text-amber-200/80", metaSize)} role="status">{actionError}</p>
      ) : notice ? (
        <p className={cn("mt-1.5 leading-snug text-fg/55", metaSize)} role="status" data-testid="lane-setup-notice">{notice}</p>
      ) : null}

      {showActions ? (
        <div className={cn("mt-1 flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 border-t border-white/[0.05] pt-1.5 -mx-1.5 px-0", metaSize)}>
          {hasDetails || (envStage?.steps?.length ?? 0) > 0 ? (
            <TextAction onClick={() => setDetailsOpen((open) => !open)} testId="lane-setup-details-toggle">
              <CaretRight
                size={10}
                weight="bold"
                aria-hidden
                className={cn("transition-transform duration-150", detailsOpen && "rotate-90")}
              />
              Details
            </TextAction>
          ) : null}
          <span className="ml-auto" aria-hidden />
          {onOpen ? (
            <TextAction tone="primary" onClick={onOpen} testId="lane-setup-open">
              <ArrowSquareOut size={11} weight="bold" aria-hidden />
              Open
            </TextAction>
          ) : null}
          {actions.startNow ? (
            <TextAction
              tone="primary"
              disabled={busy != null}
              onClick={() => run("start-now", () => startChatLaunchNow(snapshot.launchId))}
              testId="lane-setup-start-now"
            >
              <Lightning size={11} weight="fill" aria-hidden />
              Start now
            </TextAction>
          ) : null}
          {actions.retry ? (
            <TextAction
              tone="primary"
              disabled={busy != null}
              onClick={() => run("retry", () => retryChatLaunch(snapshot.launchId))}
              testId="lane-setup-retry"
            >
              <ArrowClockwise size={11} weight="bold" aria-hidden />
              Retry
            </TextAction>
          ) : null}
          {actions.startAnyway ? (
            <TextAction
              disabled={busy != null}
              onClick={() => run("start-anyway", () => startChatLaunchNow(snapshot.launchId))}
              testId="lane-setup-start-anyway"
            >
              <Play size={11} weight="fill" aria-hidden />
              Start anyway
            </TextAction>
          ) : null}
          {actions.delete ? (
            <TextAction disabled={busy != null} onClick={() => confirmDelete("delete")} testId="lane-setup-delete">
              <Trash size={11} aria-hidden />
              Delete
            </TextAction>
          ) : null}
          {actions.cancel ? (
            <TextAction
              disabled={busy != null || !hostReady}
              onClick={() => confirmDelete("cancel")}
              testId="lane-setup-cancel"
            >
              <X size={10} weight="bold" aria-hidden />
              Cancel
            </TextAction>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ── Transcript row ────────────────────────────────────────────────────────
   The `ade_card` `lane_setup` row. While the launch is live the store's
   snapshot wins (it moves faster than transcript merges and carries actions);
   once it is over the row collapses to one line that expands on demand. */

function stageStatusFromCardRow(row: AdeCardRow): ChatLaunchStageStatus {
  switch (row.icon) {
    case "pass":
      // A stage that finished, just not as asked, is a pass in the warning tone.
      return row.tone === "warning" ? "warning" : "done";
    case "fail":
      return "failed";
    case "running":
      return "running";
    case "skipped":
      return "skipped";
    default:
      return "pending";
  }
}

function CollapsedSummary({
  title,
  failed,
  expanded,
  onToggle,
  children,
}: {
  title: string;
  failed: boolean;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <div className={cn(CHAT_CARD_WIDTH_CLASS, "font-sans text-[length:calc(var(--chat-font-size)*11.5/14)]")} data-testid="lane-setup-summary">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 -ml-1.5 transition-colors",
          failed ? "text-amber-200/80 hover:bg-amber-400/[0.06] hover:text-amber-100" : "text-fg/45 hover:bg-white/[0.04] hover:text-fg/75",
        )}
      >
        <span
          className={cn(
            "grid h-4 w-4 place-items-center rounded-[5px] border",
            failed ? TILE_TONE.failed : TILE_TONE.done,
          )}
          aria-hidden
        >
          {failed ? <Warning size={9} weight="bold" /> : <Check size={9} weight="bold" />}
        </span>
        <span>{title}</span>
        <CaretRight size={10} weight="bold" aria-hidden className={cn("transition-transform duration-150", expanded && "rotate-90")} />
      </button>
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            key="stages"
            initial={reduceMotion ? false : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={reduceMotion ? undefined : { opacity: 0, height: 0 }}
            transition={{ duration: 0.18, ease: STANDARD_EASE }}
            className="overflow-hidden"
          >
            <div className="mt-1.5 rounded-lg border border-white/[0.06] bg-white/[0.018] px-3 py-1">{children}</div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export function LaneSetupTranscriptCard({ card }: { card: AdeCardPayload }) {
  const launchId = laneSetupLaunchIdFromCardId(card.cardId);
  const storeSnapshot = useChatLaunchSnapshot(launchId);
  const [expanded, setExpanded] = useState(false);
  // The host writes the finished card into the transcript. When the store
  // still holds a running snapshot, a live update was lost: trust the
  // transcript and re-read the launch so the Work row and slide-out catch up.
  const storeBehindTranscript = card.state === "terminal"
    && storeSnapshot != null
    && !isChatLaunchTerminal(storeSnapshot.phase);
  useEffect(() => {
    if (storeBehindTranscript) refreshChatLaunch(launchId);
  }, [storeBehindTranscript, launchId]);
  const live = storeBehindTranscript ? null : storeSnapshot;

  if (live && (isChatLaunchPending(live) || live.phase === "running")) {
    return <LaneSetupCard snapshot={live} variant="thread" />;
  }
  if (live && live.phase === "completed") {
    return (
      <CollapsedSummary
        title={laneSetupTitle(live)}
        failed={chatLaunchHasWarnings(live)}
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
      >
        <LaneSetupCard snapshot={live} variant="compact" showTitle={false} />
      </CollapsedSummary>
    );
  }
  return <LaneSetupCardFromPayload card={card} expanded={expanded} onToggle={() => setExpanded((v) => !v)} />;
}

function LaneSetupCardFromPayload({
  card,
  expanded,
  onToggle,
}: {
  card: AdeCardPayload;
  expanded: boolean;
  onToggle: () => void;
}) {
  const rows = card.rows ?? [];
  const failed = rows.some((row) => row.icon === "fail" || row.tone === "warning");
  const templateName = card.metrics?.find((metric) => metric.label === LANE_SETUP_CARD_TEMPLATE_METRIC)?.value?.trim() || null;
  const title = card.title;
  const kind = launchKindForCardRows(rows);
  const list = (
    <ul className="divide-y divide-white/[0.045]" aria-label="Lane setup stages">
      {rows.map((row, index) => {
        const status = stageStatusFromCardRow(row);
        const id = stageIdForCardRow(row);
        const icon = id ? launchStageIcon(id, { kind, templateName }) : Wrench;
        return (
          <li key={row.key || `${row.text}:${index}`} data-testid="lane-setup-stage" data-stage-id={id ?? undefined} data-stage-status={status}>
            <StageLine icon={icon} status={status} label={row.text} detail={row.detail ?? null} compact />
          </li>
        );
      })}
    </ul>
  );
  if (card.state === "live") {
    return (
      <div
        data-testid="lane-setup-card"
        className={cn(CHAT_CARD_WIDTH_CLASS, "rounded-[calc(var(--chat-radius-card,16px)-6px)] border border-white/[0.07] bg-white/[0.022] px-3.5 py-3 font-sans text-[length:calc(var(--chat-font-size)*12/14)]")}
      >
        <div className="flex items-center gap-2.5">
          <span className={cn("grid h-6 w-6 place-items-center rounded-[7px] border", TILE_TONE.running)} aria-hidden>
            <LaneIcon size={13} weight="bold" />
          </span>
          <span className="font-medium text-fg/82">{title}</span>
        </div>
        <div className="mt-2">{list}</div>
      </div>
    );
  }
  return (
    <CollapsedSummary title={title} failed={failed} expanded={expanded} onToggle={onToggle}>
      {list}
    </CollapsedSummary>
  );
}

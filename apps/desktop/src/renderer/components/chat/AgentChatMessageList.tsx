import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  RESET_CREDIT_OUTCOME_TEXT,
  resetCreditOutcomeText,
} from "../../../shared/usageResetCredit";
import {
  CaretDown,
  CaretLeft,
  CaretRight,
  ArrowRight,
  Bug,
  CloudArrowUp,
  GitFork,
  Warning,
  Terminal,
  FileCode,
  Check,
  CheckCircle,
  XCircle,
  Circle,
  Checks,
  Robot,
  Note,
  ChatCircleText,
  Info,
  MagnifyingGlass,
  Globe,
  ShieldCheck,
  CopySimple,
  Brain,
  Image,
  Code,
  Paperclip,
  Target,
  Clock,
  Cube,
  Moon,
  Play,
  Microphone,
  GitDiff,
  Wrench,
  SteeringWheel,
} from "@phosphor-icons/react";
import type {
  AgentChatApprovalDecision,
  AgentChatCompletionStatus,
  AgentChatEvent,
  AgentChatEventEnvelope,
  AgentChatNoticeDetail,
  AgentChatSpawnCompletion,
  AgentChatRecoverCodexTurnArgs,
  AgentChatRecoverCodexTurnResult,
  AgentChatRecoverContinuityArgs,
  AgentChatContinuityRecoveryResult,
  ChatSurfaceChipTone,
  ChatSurfaceProfile,
  ChatSurfaceMode,
  ComputerUseArtifactView,
  OperatorNavigationSuggestion,
  TurnDiffSummary,
} from "../../../shared/types";
import type { OpenProjectBinding } from "../../../shared/types/core";
import type { SceneStillRecord } from "../../../shared/chatScene";
import { WORK_BOARD_COLUMN_LABEL, spawnCompletedNoticeMessage, spawnParentGoneNoticeMessage } from "../../../shared/types/chat";
import { getModelById, resolveModelDescriptor, type ModelDescriptor } from "../../../shared/modelRegistry";
import { cn } from "../ui/cn";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { formatTime } from "../../lib/format";
import { navigateToAppTarget, openExternalUrl, openLinkFromUi } from "../../lib/openExternal";
import { ChipText } from "./ChipText";
import { normalizePath } from "../../lib/pathUtils";
import { artifactImageSrc } from "../../../shared/artifactStreamUrl";
import { useStreamSmoothnessSampler } from "../../perf/streamSmoothness";
import { AssistantTextBody } from "./AssistantTextBody";
import { MarkdownBlock, type MosaicRenderContext } from "./chatMarkdownBlock";
import { useCallStills, useSceneStillSrc } from "./sceneStillStore";
import {
  CHAT_OUTPUT_CONTEXT_CHIP_LABEL,
  splitChatOutputContextSegments,
} from "../../../shared/chatOutputContext";
import { AssistantOutputSelectionToolbar } from "./AssistantOutputSelectionToolbar";
import {
  ChatWorkspacePathProvider,
  useWorkspacePathOpener,
  type WorkspacePathLocation,
} from "./chatWorkspacePaths";
import { describeToolIdentifier, replaceInternalToolNames } from "./toolPresentation";
import { chatChipToneClass } from "./chatSurfaceTheme";
import {
  CHAT_TRANSCRIPT_GLASS_CARD_CLASS,
  CHAT_USER_MESSAGE_CARD_STYLE,
  CHAT_WORK_LOG_CARD_CLASS,
} from "./chatTranscriptChrome";
import { useAppStore } from "../../state/appStore";
import { useChatRuntimeScope } from "./ChatRuntimeScope";
import { transcriptRowGapPx } from "./chatAppearance";
import { UserMessageIssueContext } from "./UserMessageIssueContext";
import type { AgentChatContextAttachment, AgentChatFileRef } from "../../../shared/types";
import { getToolMeta } from "./chatToolAppearance";
import { deriveChatSources, type ChatSource, type ChatSources } from "../../../shared/chatSources";
import { ChatSourceIcon } from "./ChatSourcesPanel";
import { ClaudeLogo, CodexLogo, CursorAgentLogo } from "../terminals/ToolLogos";
import { ModelRowLogo, ProviderLogo } from "../shared/ProviderLogos";
import { pendingInputHeaderLabel, providerDisplayLabel } from "../../../shared/pendingInputLabels";
import {
  describeUserMessageStatus,
  type UserMessageStatus,
  type UserMessageStatusTone,
} from "../../../shared/chatUserMessageStatus";
import { formatLegacyProviderRetryActivityDetail } from "../../../shared/providerRetryPresentation";
import { logRendererDebugEvent } from "../../lib/debugLog";
import { isHostResumedNoticeEvent, isHostSleepNoticeEvent } from "../../../shared/hostSleepNotice";
import { isClaudeContextCategoryKind } from "../../../shared/claudeContextUsage";
import type { ChatSubagentSnapshot } from "./chatExecutionSummary";
import {
  ChatToolActivityDetails,
  ChatTurnWorkSummary,
  countChatTurnChangedFiles,
  dedupeChatToolActivityEntries,
} from "./ChatWorkLogBlock";
import { ChatStatusGlyph } from "./chatStatusVisuals";
import {
  applyChatTranscriptTurnFolds,
  buildTranscriptEventRowKeys,
  collapseChatTranscriptEvents,
  collapseChatTranscriptEventsIncrementalWithContext,
  countVisibleRowsAppendedSince,
  deriveChatTranscriptTurnFolds,
  deriveWebSearchResultDisplay,
  formatDoneTurnTokenLine,
  formatStructuredValue,
  filterVisibleTranscriptRows,
  groupChatTranscriptRows,
  groupSubagentCardGrids,
  mergeAdjacentActivityBundleRows,
  readRecord,
  readTurnEndSnapshots,
  sameTurnFolds,
  summarizeDiffStats,
  summarizeInlineText,
  summarizeTurnDetails,
  isTaskListRowKey,
  subagentCardGridColumns,
  subagentCardGridKeyByMemberKey,
  subagentCardKeyForLifecycleEvent,
  type BackgroundJobGroupRenderEvent,
  type BackgroundJobLineRenderEvent,
  type ChatActivityBundleEvent,
  type ChatActivityBundleItem,
  type CollapseTranscriptResult,
  type ScheduledWakeDividerRenderEvent,
  type SpawnWakeDividerRenderEvent,
  type SubagentCardGridEvent,
  type SubagentResultCardRenderEvent,
  type SubagentSpawnAnchorRenderEvent,
  type SubagentStoppedGroupEvent,
  type TaskListRenderEvent,
  type TurnDetailsRenderEvent,
  type TurnFoldRenderEvent,
  type VoiceCallGroupRenderEvent,
  type ChatTranscriptGroupedEnvelope as TranscriptGroupedEnvelope,
  type ChatTranscriptRenderEnvelope as TranscriptRenderEnvelope,
  type ChatWorkLogEntry,
  type RenderReasoningEvent,
} from "./chatTranscriptRows";
import {
  ThinkingPreview,
  ThoughtBlock,
  deriveLiveThinkingRowKey,
  formatThinkingElapsed,
} from "./ThinkingPreview";
import { renderSubagentTimelineRow, type SpawnedChatProviderProps } from "./chatSubagentTimelineRenderer";
import { AdeCard } from "./AdeCard";
import { LaneSetupTranscriptCard } from "./launch/LaneSetupCard";
import { navigateToSpawnedChat } from "./spawnNavigation";
import { ChatUserMinimap } from "./ChatUserMinimap";
import { promptHistoryEventKey } from "./chatPromptHistory";
import { buildDrawnRowKeyIndex, resolveDrawnRowKey } from "./chatDrawnRowIndex";
import { AgentCliAuthCard, type AgentCliAuthCardInfo } from "./AgentCliAuthCard";
import { ChatContinuityRecoveryCard } from "./ChatContinuityRecoveryCard";
import { classifyProviderFailure, ProviderFailureRecoveryCard } from "./ProviderFailureRecoveryCard";
import {
  isUsageLimitTurn,
  usageLimitTurnFooterLabel,
} from "../../../shared/usageLimitResumePresentation";
import { InstructionErrorCard } from "../shared/InstructionErrorCard";
import { chatErrorKindFromCategory, presentChatFailure, readChatErrorPresentation } from "../../../shared/chatErrorPresentation";
import {
  CHAT_TIMELINE_ROW_GAP_PX,
  collectUserMessageMinimapSourceEntries,
  computeActiveFullUserOrdinal,
  computeRowStartOffsets,
  computeScrollTopForRow,
  placeMinimapEntriesOnVisibleRows,
  resolveRowAnchorAtScrollTop,
  type ChatUserMinimapSourceEntry,
} from "./chatUserMinimap.logic";
import { buildLegacyPendingInputFromApprovalEvent } from "./pendingInput";
import { readPendingInputRequest } from "../../../shared/pendingInputRequest";
import { AnsweredQuestionReceipt, OpenQuestionReceipt } from "./QuestionReceipts";
import { isQuestionKind } from "../../../shared/pendingInputAnswers";
import { CodexPlanCard } from "./codex/CodexPlanCard";
import { ChatTaskListCard } from "./ChatTaskListCard";
import { CodexImageGenerationCard } from "./codex/CodexImageGenerationCard";
import { CodexImageViewLine } from "./codex/CodexImageViewLine";
import { ContextCompactDivider } from "./ContextCompactDivider";
import { terminalReasonLabel, formatTimedOutAfter, formatGrepTotalsPrefix } from "./chatEventDisplay";
import { peekPendingSessionAnchor, takePendingSessionAnchor } from "../terminals/pendingSessionAnchors";
import { ChatTurnFileChangesPanel, aggregateFiles } from "./ChatFileChangesPanel";
import { formatTurnFoldHead, formatTurnFoldJobCount, formatTurnFoldLabel } from "../../../shared/chatTurnFold";
import { pluralCount } from "../../../shared/formatting";
import { sameKeyList, sameMapContents, sameSetContents, useStableIdentity } from "../../lib/stableIdentity";
import {
  getEventTurnId,
  useTranscriptPresentation,
} from "./chatTranscriptPresentation";
import {
  calculateVirtualWindow,
  calculateVirtualWindowAnchoredToEnd,
  reconcileMeasuredScrollTop,
  resolveAnchoredChatRowIndex,
  shouldAbsorbProgrammaticScrollEvent,
  shouldKeepPinnedThroughViewportShrink,
  shouldStickToBottomAfterScroll,
  STICK_RESUME_THRESHOLD_PX,
  USER_SCROLL_UP_REPIN_HOLD_MS,
} from "./chatListScrollAnchoring";
import { BackgroundJobRunRow } from "./BackgroundJobRunRow";
import { ScheduledWorkLine } from "./ScheduledWorkLine";

export { deriveTranscriptToolActivity, deriveTurnStartedAtMs, stabilizeTranscriptToolActivity } from "./chatTranscriptPresentation";
export { sameKeyList, sameMapContents, sameSetContents } from "../../lib/stableIdentity";

const warnedDuplicateRowKeys = new Set<string>();

/** Dev-only: the virtualizer keys rows by `row.key`, so a duplicate renders ghost rows. */
function warnOnDuplicateRowKeys(keys: readonly string[]): void {
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key) && !warnedDuplicateRowKeys.has(key)) {
      warnedDuplicateRowKeys.add(key);
      console.warn(`[chat] duplicate transcript row key: ${key}`);
    }
    seen.add(key);
  }
}
export {
  calculateVirtualWindow,
  calculateVirtualWindowAnchoredToEnd,
  findAnchoredChatEventIndex,
  reconcileMeasuredScrollTop,
  resolveAnchoredChatRowIndex,
  shouldAbsorbProgrammaticScrollEvent,
  shouldKeepPinnedThroughViewportShrink,
  shouldStickToBottomAfterScroll,
} from "./chatListScrollAnchoring";
import {
  backgroundJobGroupKeyByMemberKey as deriveBackgroundJobGroupKeyByMemberKey,
  collectTurnEndLiveRowKeys,
  groupBackgroundJobRuns,
} from "./chatBackgroundJobRuns";
import {
  collectMergedThoughtRows,
  interruptReceiptIdentity,
  mergeAdjacentThoughtRows,
  thoughtRunKeyByMemberKey,
  transcriptEventDrawsNothing,
  type TranscriptRowDrawContext,
  thoughtDurationSeconds,
} from "./chatThoughtRuns";
import {
  ChatCard,
  ChatCardFaint,
  ChatCardRow,
  ChatCardSub,
  ChatCardTitle,
  ChatProofFilmstrip,
} from "./chatCardPrimitives";

/** Stable empty array so a proof-free turn never re-renders the divider. */
const EMPTY_PROOF_ARTIFACTS: ComputerUseArtifactView[] = [];
const EMPTY_WORK_LOG_ENTRIES: ChatWorkLogEntry[] = [];

const NAVIGATION_SURFACES = new Set(["work", "lanes", "cto"]);

/**
 * Recovers the child chat's title from a `spawn_completed` notice whose detail
 * lost its `spawnCompletion`. Matches both the current
 * `spawnCompletedNoticeMessage` sentence and the pre-rename `Peer "<title>"
 * turn finished`, which persisted transcripts still hold. Not global, so `exec`
 * has no `lastIndex` to carry between calls.
 */
const SPAWN_COMPLETED_TITLE_PATTERN = /^(?:Peer|Chat)\s+"?(.*?)"?\s+(?:turn finished|finished its turn)$/;
type PendingInputResolution = Extract<AgentChatEvent, { type: "pending_input_resolved" }>["resolution"];
type CodexTurnStalledEvent = Extract<AgentChatEvent, { type: "codex_turn_stalled" }>;
type CodexTurnRecoveryEvent = Extract<
  AgentChatEvent,
  { type: "codex_turn_recovery" | "turn_recovery" }
>;
type UserMessageEvent = Extract<AgentChatEvent, { type: "user_message" }>;

/**
 * The Codex "a reset credit is banked" notice, with the way to spend it.
 *
 * The button is offered only when this host can actually spend a credit — the
 * hosted web client and older preloads do not expose the bridge — because a
 * control that always fails is worse than a notice that only informs. The
 * outcome replaces the button rather than sitting beside it: the credit is
 * gone either way, and a still-clickable button invites a second spend.
 */
function ResetCreditNoticeRow({
  message,
  accountId,
  className,
  icon,
  chipLabel,
}: {
  message: string;
  accountId: string | null;
  className?: string;
  icon: React.ReactNode;
  chipLabel: string;
}) {
  const [spending, setSpending] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const consume = window.ade?.usage?.consumeResetCredit;
  const canSpend = Boolean(accountId) && typeof consume === "function" && !outcome;
  const spend = useCallback(async () => {
    if (!accountId) return;
    const call = window.ade?.usage?.consumeResetCredit;
    if (!call) return;
    setSpending(true);
    try {
      setOutcome(resetCreditOutcomeText(await call({ accountId })));
    } catch {
      setOutcome(RESET_CREDIT_OUTCOME_TEXT.failure);
    } finally {
      setSpending(false);
    }
  }, [accountId]);
  return (
    <div className={cn(
      "inline-flex max-w-[var(--chat-content-width,52rem)] flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-2.5 py-1.5 font-sans text-[length:calc(var(--chat-font-size)*10/14)]",
      className,
    )}>
      {icon}
      <span className="text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-[0.16em]">{chipLabel}</span>
      <span className="normal-case tracking-normal text-fg/55">{message}</span>
      {canSpend ? (
        <button
          type="button"
          disabled={spending}
          onClick={() => { void spend(); }}
          data-testid="reset-credit-use"
          className="rounded border border-border/30 px-1.5 py-[1px] text-[length:calc(var(--chat-font-size)*9/14)] font-medium normal-case tracking-normal text-fg/70 hover:bg-white/[0.06] disabled:opacity-50"
        >
          Use reset
        </button>
      ) : null}
      {outcome ? (
        <span className="normal-case tracking-normal text-fg/42">{outcome}</span>
      ) : null}
    </div>
  );
}

function CodexTurnRecoveryCard({
  event,
  sessionId,
  onRecover,
}: {
  event: CodexTurnStalledEvent;
  sessionId: string | null | undefined;
  onRecover?: (args: AgentChatRecoverCodexTurnArgs) => Promise<AgentChatRecoverCodexTurnResult>;
}) {
  const [pendingAction, setPendingAction] = useState<AgentChatRecoverCodexTurnArgs["action"] | null>(null);
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const targetSessionId = event.sourceSessionId?.trim() || sessionId?.trim() || "";
  const optionLabels: Record<AgentChatRecoverCodexTurnArgs["action"], string> = {
    wait: "Keep waiting",
    steer: "Send nudge",
    interrupt_retry_same_thread: "Retry same server",
    restart_resume_thread: "Restart & resume",
  };
  const resultLabels: Record<AgentChatRecoverCodexTurnResult["status"], string> = {
    waiting: "Waiting for Codex output…",
    nudged: "Status nudge sent.",
    retrying: "Retry started in this thread.",
    resumed: "Codex app-server restarted and the thread resumed.",
  };
  const recoveryOptions = event.recoveryOptions ?? [
    "restart_resume_thread",
    "wait",
    "steer",
    "interrupt_retry_same_thread",
  ];
  const primaryOptions = (["restart_resume_thread", "wait"] as const)
    .filter((option) => recoveryOptions.includes(option));
  const secondaryOptions = (["steer", "interrupt_retry_same_thread"] as const)
    .filter((option) => recoveryOptions.includes(option));
  const title = event.reason === "waiting_on_approval"
    ? "Codex is waiting for approval"
    : event.reason === "waiting_on_input"
      ? "Codex is waiting for your input"
      : event.reason === "no_progress"
        ? "Codex stopped making progress"
        : "Codex did not start responding";
  const timing = (() => {
    const detectedAt = event.detectedAt ? Date.parse(event.detectedAt) : Number.NaN;
    const turnStartedAt = event.turnStartedAt ? Date.parse(event.turnStartedAt) : Number.NaN;
    const lastProgressAt = event.lastProgressAt ? Date.parse(event.lastProgressAt) : Number.NaN;
    const parts: string[] = [];
    if (Number.isFinite(detectedAt) && Number.isFinite(turnStartedAt) && detectedAt > turnStartedAt) {
      parts.push(`Elapsed ${formatTurnDuration(detectedAt - turnStartedAt)}`);
    }
    if (Number.isFinite(detectedAt) && Number.isFinite(lastProgressAt) && detectedAt > lastProgressAt) {
      parts.push(`inactive ${formatTurnDuration(detectedAt - lastProgressAt)}`);
    }
    return parts.join(" · ");
  })();

  const recover = useCallback(async (action: AgentChatRecoverCodexTurnArgs["action"]) => {
    if (!targetSessionId || !onRecover || pendingAction) return;
    setPendingAction(action);
    setErrorMessage(null);
    setResultMessage(null);
    try {
      const result = await onRecover({ sessionId: targetSessionId, turnId: event.turnId, action });
      setResultMessage(resultLabels[result.status]);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingAction(null);
    }
  }, [event.turnId, onRecover, pendingAction, resultLabels, targetSessionId]);

  return (
    <div className="w-fit max-w-[var(--chat-content-width,52rem)] rounded-lg border border-amber-300/16 bg-amber-500/[0.055] px-3 py-2.5 font-sans text-[length:calc(var(--chat-font-size)*11/14)] text-amber-100/78">
      <div className="flex items-center gap-2">
        <Warning size={13} weight="duotone" className="shrink-0 text-amber-200/75" />
        <span className="font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-[0.16em] text-amber-200/55">recovery</span>
        <span className="min-w-0 truncate">{title}</span>
      </div>
      <div className="mt-1.5 text-[length:calc(var(--chat-font-size)*10.5/14)] leading-relaxed text-amber-50/64">
        {event.message}
      </div>
      {event.automaticRecoveryAttempted ? (
        <div className="mt-1 text-[length:calc(var(--chat-font-size)*9.5/14)] text-amber-100/48">
          ADE already tried one automatic restart. It will not restart again without you.
        </div>
      ) : null}
      {timing ? (
        <div className="mt-1 font-mono text-[length:calc(var(--chat-font-size)*9/14)] text-amber-100/42">
          {timing}
        </div>
      ) : null}
      {primaryOptions.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {primaryOptions.map((option) => (
            <button
              key={option}
              type="button"
              disabled={!targetSessionId || !onRecover || pendingAction != null}
              className={cn(
                "rounded-md border px-2.5 py-1 font-sans text-[length:calc(var(--chat-font-size)*10/14)] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-300/45 disabled:pointer-events-none disabled:opacity-45",
                option === "restart_resume_thread"
                  ? "border-amber-200/24 bg-amber-300/[0.14] text-amber-50 hover:border-amber-100/40 hover:bg-amber-300/[0.2]"
                  : "border-amber-200/12 bg-transparent text-amber-100/68 hover:border-amber-200/25 hover:bg-amber-300/[0.08]",
              )}
              onClick={() => void recover(option)}
            >
              {pendingAction === option ? `${optionLabels[option]}…` : optionLabels[option]}
            </button>
          ))}
        </div>
      ) : null}
      {secondaryOptions.length ? (
        <div className="mt-1.5">
          <button
            type="button"
            aria-expanded={moreOpen}
            className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 font-sans text-[length:calc(var(--chat-font-size)*9.5/14)] text-amber-100/48 transition-colors hover:bg-amber-300/[0.07] hover:text-amber-50/75 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-300/45"
            onClick={() => setMoreOpen((open) => !open)}
          >
            More
            {moreOpen ? <CaretDown size={10} weight="bold" /> : <CaretRight size={10} weight="bold" />}
          </button>
          {moreOpen ? (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {secondaryOptions.map((option) => (
                <button
                  key={option}
                  type="button"
                  disabled={!targetSessionId || !onRecover || pendingAction != null}
                  className="rounded-md border border-amber-200/10 bg-transparent px-2 py-0.5 font-sans text-[length:calc(var(--chat-font-size)*9.5/14)] text-amber-100/55 transition-colors hover:border-amber-200/22 hover:bg-amber-300/[0.07] hover:text-amber-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-300/45 disabled:pointer-events-none disabled:opacity-45"
                  onClick={() => void recover(option)}
                >
                  {pendingAction === option ? `${optionLabels[option]}…` : optionLabels[option]}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {resultMessage ? (
        <div className="mt-2 text-[length:calc(var(--chat-font-size)*10/14)] text-emerald-200/70" role="status">
          {resultMessage}
        </div>
      ) : null}
      {errorMessage ? (
        <div className="mt-2 text-[length:calc(var(--chat-font-size)*10/14)] text-red-200/75" role="alert">
          {errorMessage}
        </div>
      ) : null}
    </div>
  );
}

function turnRecoveryLabel(event: CodexTurnRecoveryEvent): string {
  if (event.state === "recovered") return "Recovered";
  if (event.state === "failed") return "Recovery failed";
  return "Recovering";
}

/**
 * The turn's ONE "Turn details" row: its diagnostics snapshots and recovery
 * receipt, merged by the collapse pass (`turn_details`). The summary adds the
 * counts up; expanding lists everything.
 */
function TurnDetailsDisclosure({ event }: { event: TurnDetailsRenderEvent }) {
  const { moderationChecks, integrations } = summarizeTurnDetails(event);
  const recovery = event.recovery;
  if (!moderationChecks && !integrations.length && !recovery) return null;
  const summaryParts = [
    moderationChecks ? `${moderationChecks} safety ${moderationChecks === 1 ? "check" : "checks"}` : null,
    integrations.length ? `${integrations.length} optional ${integrations.length === 1 ? "integration warning" : "integration warnings"}` : null,
  ].filter((part): part is string => Boolean(part));
  const recoveryTone = recovery?.state === "failed"
    ? "text-red-300/75"
    : recovery?.state === "recovered"
      ? "text-emerald-300/70"
      : "text-amber-300/75";
  return (
    <InlineDisclosureRow
      summary={(
        <div className="flex min-w-0 items-center gap-2 font-sans text-[length:calc(var(--chat-font-size)*10/14)] text-fg/42">
          <ShieldCheck size={11} weight="duotone" className="shrink-0 text-fg/36" />
          <span className="shrink-0 font-medium text-fg/52">Turn details</span>
          {recovery ? (
            <span className={cn("inline-flex shrink-0 items-center gap-1", recoveryTone)}>
              {recovery.state === "recovered"
                ? <CheckCircle size={11} weight="duotone" className="shrink-0" aria-hidden />
                : <Warning size={11} weight="duotone" className="shrink-0" aria-hidden />}
              {turnRecoveryLabel(recovery)}
            </span>
          ) : null}
          {summaryParts.length ? <span className="min-w-0 truncate">{summaryParts.join(" · ")}</span> : null}
          {recovery && !summaryParts.length ? <span className="min-w-0 truncate">{recovery.message}</span> : null}
        </div>
      )}
    >
      <div className="space-y-2 font-sans text-[length:calc(var(--chat-font-size)*10.5/14)] leading-relaxed text-fg/58">
        {recovery ? (
          <div>
            <span className={cn("font-medium", recoveryTone)}>{turnRecoveryLabel(recovery)}</span>
            <span className="text-fg/58"> · {recovery.message}</span>
            {recovery.automatic ? <span className="text-fg/42"> · automatic</span> : null}
          </div>
        ) : null}
        {moderationChecks ? (
          <div>Safety checks recorded: {moderationChecks}.</div>
        ) : null}
        {integrations.length ? (
          <div>
            <div className="font-medium text-fg/68">Optional integrations unavailable</div>
            <ul className="mt-1 space-y-1">
              {integrations.map((integration) => (
                <li key={integration.integration}>
                  <span className="text-fg/70">{integration.integration}</span>
                  {integration.message ? <span className="text-fg/42"> · {integration.message}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </InlineDisclosureRow>
  );
}

function formatDiffCounts(fileCount: number, additions: number, deletions: number): string {
  const fileLabel = fileCount === 1 ? "file" : "files";
  return `${fileCount} ${fileLabel} +${additions} -${deletions}`;
}

function TurnDiffSummaryFallback({
  turnSummary,
  threadSummaries,
}: {
  turnSummary: TurnDiffSummary;
  threadSummaries: TurnDiffSummary[];
}) {
  const thread = threadSummaries.length > 0 ? threadSummaries : [turnSummary];
  const turnFiles = aggregateFiles([turnSummary]);
  if (turnFiles.length === 0) return null;
  const threadFiles = aggregateFiles(thread);
  const turnAdditions = turnFiles.reduce((sum, file) => sum + file.additions, 0);
  const turnDeletions = turnFiles.reduce((sum, file) => sum + file.deletions, 0);
  const threadAdditions = threadFiles.reduce((sum, file) => sum + file.additions, 0);
  const threadDeletions = threadFiles.reduce((sum, file) => sum + file.deletions, 0);
  return (
    <div className="my-2 w-full max-w-full rounded-lg border border-white/10 bg-white/[0.035] px-3 py-2 font-sans text-[length:calc(var(--chat-font-size)*12/14)] text-fg/70">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-1.5 font-semibold text-fg/85">
          <FileCode size={13} weight="bold" aria-hidden />
          Files changed
        </span>
        <span>This turn: {formatDiffCounts(turnFiles.length, turnAdditions, turnDeletions)}</span>
        <span>Full thread: {formatDiffCounts(threadFiles.length, threadAdditions, threadDeletions)}</span>
      </div>
    </div>
  );
}

function readOperatorNavigationSuggestion(value: unknown): OperatorNavigationSuggestion | null {
  const record = readRecord(value);
  if (!record) return null;
  const surface = typeof record.surface === "string" ? record.surface : "";
  const href = typeof record.href === "string" ? record.href : "";
  const label = typeof record.label === "string" ? record.label : "";
  if (!NAVIGATION_SURFACES.has(surface) || !href.trim() || !label.trim()) return null;
  const result: OperatorNavigationSuggestion = { surface: surface as OperatorNavigationSuggestion["surface"], href, label };
  if (typeof record.laneId === "string") result.laneId = record.laneId;
  if (typeof record.sessionId === "string") result.sessionId = record.sessionId;
  return result;
}

function readNavigationSuggestions(value: unknown): OperatorNavigationSuggestion[] {
  const record = readRecord(value);
  if (!record) return [];
  const suggestions: OperatorNavigationSuggestion[] = [];
  const navigationSuggestions = Array.isArray(record.navigationSuggestions)
    ? record.navigationSuggestions
    : [];
  for (const candidate of navigationSuggestions) {
    const parsed = readOperatorNavigationSuggestion(candidate);
    if (parsed) suggestions.push(parsed);
  }
  if (suggestions.length > 0) return suggestions;
  const fallback = readOperatorNavigationSuggestion(record.navigation);
  return fallback ? [fallback] : [];
}

function summarizeStructuredValue(value: unknown, maxChars = 160): string {
  const text = formatStructuredValue(value).replace(/\s+/g, " ").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

/**
 * Envelopes seeded into a forked chat as pre-fork history carry this origin so
 * the transcript can draw a single "forked from here" divider between the
 * transported history and the first live event.
 */
const FORK_HISTORY_PROVIDER_ORIGIN = "handoff_fork";

function isForkHistoryEnvelope(envelope: AgentChatEventEnvelope): boolean {
  return envelope.provenance?.providerOrigin === FORK_HISTORY_PROVIDER_ORIGIN;
}

/**
 * Locates the single grouped-row key that should carry the fork-history divider:
 * the first live (non-fork) row that follows at least one seeded fork-history
 * envelope. Reconstructs candidate row keys the same way {@link collapseChatTranscriptEvents}
 * assigns them ({@link buildTranscriptEventRowKeys}) and returns the first that
 * survived collapse, so the divider stays pinned to a real, measured row under
 * virtualization.
 */
export function computeForkHistoryDividerRowKey(
  events: readonly AgentChatEventEnvelope[],
  groupedRowKeys: readonly string[],
): string | null {
  let boundary = -1;
  for (let index = 0; index < events.length; index += 1) {
    if (!isForkHistoryEnvelope(events[index]!)) {
      boundary = index;
      break;
    }
  }
  // boundary <= 0 means either no live events, or no fork history preceding them.
  if (boundary <= 0) return null;
  const keySet = new Set(groupedRowKeys);
  const eventRowKeys = buildTranscriptEventRowKeys(events);
  for (let index = boundary; index < events.length; index += 1) {
    const candidate = eventRowKeys[index]!;
    if (keySet.has(candidate)) return candidate;
  }
  return null;
}

export type AssistantTurnCopyInfo = {
  text: string;
  lastTextEventKey: string;
  textEventCount: number;
};

export function deriveAssistantTurnCopyMap(
  rows: readonly TranscriptRenderEnvelope[],
): Map<string, AssistantTurnCopyInfo> {
  const result = new Map<string, AssistantTurnCopyInfo>();
  for (const row of rows) {
    if (row.event.type !== "text") continue;
    const turnId = getEventTurnId(row.event);
    if (!turnId) continue;
    const existing = result.get(turnId);
    result.set(turnId, {
      text: existing ? `${existing.text}\n\n${row.event.text}` : row.event.text,
      lastTextEventKey: row.key,
      textEventCount: (existing?.textEventCount ?? 0) + 1,
    });
  }
  return result;
}

function basenamePathLabel(value: string): string {
  const normalized = normalizePath(value);
  const basename = normalized.split("/").pop()?.trim();
  if (!basename?.length) return normalized;
  if (/^[A-Za-z]:$/.test(basename)) return `${basename}/`;
  return basename;
}

function dirnamePathLabel(value: string): string | null {
  const normalized = normalizePath(value);
  const basename = basenamePathLabel(normalized);
  if (basename === normalized) return null;
  const suffix = `/${basename}`;
  if (!normalized.endsWith(suffix)) return null;
  const dirname = normalized.slice(0, -suffix.length);
  return dirname.length ? normalizePath(dirname) : null;
}

function formatFileAction(kind: Extract<AgentChatEvent, { type: "file_change" }>["kind"]): string {
  switch (kind) {
    case "create":
      return "Created";
    case "delete":
      return "Deleted";
    default:
      return "Edited";
  }
}

function approvalToneClass(state: PendingInputResolution | null): string {
  if (state === "accepted") return "text-emerald-300/70";
  if (state === "declined") return "text-red-300/70";
  return "text-fg/45";
}

function doneStatusToneClass(status: Extract<AgentChatEvent, { type: "done" }>["status"]): string {
  // Text-only tones — no band/box. Interrupted/failed read as a calm tinted line.
  if (status === "completed") return "text-fg/45";
  if (status === "failed") return "text-red-300/80";
  return "text-amber-300/85";
}

function completionReportToneClass(status: AgentChatCompletionStatus): string {
  if (status === "completed") return "border-emerald-400/15 bg-emerald-400/[0.05] text-emerald-200";
  if (status === "blocked") return "border-red-500/15 bg-red-500/[0.05] text-red-200";
  return "border-amber-500/15 bg-amber-500/[0.05] text-amber-200";
}

function turnStatusToneClass(args: { isFailure: boolean; isInterrupted: boolean }): string {
  if (args.isFailure) return "border-red-500/14 bg-red-500/[0.05] text-red-300";
  if (args.isInterrupted) return "border-amber-500/14 bg-amber-500/[0.05] text-amber-300";
  return "border-border/14 bg-surface-recessed/70 text-muted-fg/55";
}

function approvalWaitingLabel(args: {
  isPlanApproval: boolean;
  isAskUser: boolean;
  isPermissionRequest: boolean;
}): string {
  if (args.isPlanApproval) return "Presenting plan for approval";
  if (args.isAskUser) return "Waiting for input";
  if (args.isPermissionRequest) return "Permission request";
  return "Approval required";
}

function hasNoticeDetail(detail: string | AgentChatNoticeDetail | undefined): boolean {
  if (detail == null) return false;
  if (typeof detail === "string") return detail.trim().length > 0;
  return Boolean(
    detail.title?.trim()
    || detail.summary?.trim()
    || detail.metrics?.length
    || detail.sections?.length,
  );
}

function renderNoticeDetail(detail: string | AgentChatNoticeDetail): React.ReactNode {
  if (typeof detail === "string") {
    return <div className="whitespace-pre-wrap break-words text-[length:calc(var(--chat-font-size)*11/14)] leading-relaxed text-fg/60">{detail}</div>;
  }

  return (
    <div className="space-y-3 text-[length:calc(var(--chat-font-size)*11/14)] leading-relaxed text-fg/60">
      {detail.title?.trim() ? <div className="font-medium text-fg/75">{detail.title.trim()}</div> : null}
      {detail.summary?.trim() ? <div className="whitespace-pre-wrap break-words">{detail.summary.trim()}</div> : null}
      {detail.metrics?.length ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {detail.metrics.map((metric) => (
            <div
              key={`${metric.label}:${metric.value}`}
              className="rounded-lg border border-border/12 bg-black/10 px-2.5 py-2"
            >
              <div className="text-[length:calc(var(--chat-font-size)*10/14)] uppercase tracking-[0.14em] text-muted-fg/55">{metric.label}</div>
              <div className={cn("mt-1 text-sm font-medium", metric.tone ? chatChipToneClass(metric.tone) : "text-fg/75")}>
                {metric.value}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {detail.sections?.map((section) => (
        <div key={section.title} className="space-y-1.5">
          <div className="text-[length:calc(var(--chat-font-size)*10/14)] uppercase tracking-[0.14em] text-muted-fg/55">{section.title}</div>
          <div className="space-y-1.5">
            {section.items.map((item, index) => (
              typeof item === "string" ? (
                <div
                  key={`${section.title}:text:${index}`}
                  className="whitespace-pre-wrap break-words rounded-lg border border-border/12 bg-black/10 px-2.5 py-2"
                >
                  {item}
                </div>
              ) : (
                <div
                  key={`${section.title}:${item.label}:${item.value}:${index}`}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border/12 bg-black/10 px-2.5 py-2"
                >
                  <span className="text-muted-fg/60">{item.label}</span>
                  <span className={cn("text-right font-medium", item.tone ? chatChipToneClass(item.tone) : "text-fg/75")}>
                    {item.value}
                  </span>
                </div>
              )
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function formatContextK(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(1)}M`;
  }
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(Math.round(value));
}

function formatCompactDuration(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  if (value < 1000) return `${Math.max(1, Math.round(value))}ms`;
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m`;
}

const GLASS_CARD_CLASS = CHAT_TRANSCRIPT_GLASS_CARD_CLASS;

const WORK_LOG_CARD_CLASS = CHAT_WORK_LOG_CARD_CLASS;

const RECESSED_BLOCK_CLASS =
  "ade-chat-recessed overflow-auto whitespace-pre-wrap break-words rounded-[10px] px-4 py-3 font-mono text-[length:calc(var(--chat-font-size)*11/14)] leading-[1.6] text-fg/78";

function toolSourceChip(toolName: string): { label: string; tone: ChatSurfaceChipTone } | null {
  if (toolName.startsWith("functions.")) {
    return { label: "Local tool", tone: "muted" };
  }
  if (toolName.startsWith("multi_tool_use.")) {
    return { label: "Parallel", tone: "accent" };
  }
  if (toolName.includes(".")) {
    const namespace = toolName.split(".")[0]?.trim();
    if (namespace) return { label: namespace.replace(/[_-]/g, " "), tone: "muted" };
  }
  return null;
}

const MESSAGE_CARD_STYLE = CHAT_USER_MESSAGE_CARD_STYLE;

const SURFACE_INLINE_CARD_STYLE: React.CSSProperties = {
  borderColor: "color-mix(in srgb, var(--chat-glass-border) 100%, transparent)",
};

const USER_MESSAGE_STATUS_TONE_CLASS: Record<UserMessageStatusTone, string> = {
  muted: "text-fg/42",
  warning: "text-amber-300/80",
  error: "text-amber-300/85",
};

function UserMessageStatusGlyph({ icon }: { icon: UserMessageStatus["icon"] }) {
  const glyphClass = "shrink-0 opacity-85";
  if (icon === "clock") return <Clock size={11} weight="bold" className={glyphClass} aria-hidden />;
  if (icon === "warning") return <Warning size={11} weight="bold" className={glyphClass} aria-hidden />;
  return <SteeringWheel size={11} weight="bold" className={glyphClass} aria-hidden />;
}

/**
 * Small muted line under a user bubble, right-aligned with it. Lives outside
 * the bubble so it never collides with the bubble's hover actions.
 */
function UserMessageStatusLine({
  status,
  label,
  tone,
}: {
  status: UserMessageStatus;
  /** Replaces the status label (a resolved unprocessed steer). */
  label?: string;
  tone?: UserMessageStatusTone;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 max-w-full items-center justify-end gap-1 px-1 font-sans text-[length:calc(var(--chat-font-size)*10.5/14)] leading-4",
        USER_MESSAGE_STATUS_TONE_CLASS[tone ?? status.tone],
      )}
      data-testid="user-message-status"
      data-status-kind={status.kind}
    >
      <UserMessageStatusGlyph icon={status.icon} />
      <span className="truncate" title={status.title}>{label ?? status.label}</span>
    </div>
  );
}

function UserMessageStatusRow({
  event,
  onRunUnprocessedMessage,
  onEditUnprocessedMessage,
  onDismissUnprocessedMessage,
}: {
  event: UserMessageEvent;
  onRunUnprocessedMessage?: (event: UserMessageEvent) => void | Promise<void>;
  onEditUnprocessedMessage?: (event: UserMessageEvent) => void;
  onDismissUnprocessedMessage?: (event: UserMessageEvent) => void | Promise<void>;
}) {
  const status = describeUserMessageStatus(event);
  if (!status) return null;
  return (
    <div className="mt-1 flex min-w-0 max-w-[82%] flex-col items-end" data-testid="user-message-status-row">
      {status.kind === "steer_unprocessed" ? (
        <UnprocessedMessageAction
          event={event}
          status={status}
          onRun={onRunUnprocessedMessage}
          onEdit={onEditUnprocessedMessage}
          onDismiss={onDismissUnprocessedMessage}
        />
      ) : (
        <UserMessageStatusLine status={status} />
      )}
    </div>
  );
}

const IOS_SIMULATOR_CONTEXT_PREFIX = "Selected iOS simulator context:";

/**
 * Mirror the cyan chip pill the composer renders when an iOS-inspect packet is
 * staged. Sent user messages keep the same backtick-wrapped label tokens at the
 * front of `event.text`, so we can re-promote them to the same chip treatment
 * here. Without this they render as inline-code-styled text and reviewers can't
 * tell the message actually carried packet context (vs. the user just typing
 * the label by hand).
 */
function parseLeadingIosContextChips(text: string): { chips: string[]; rest: string } {
  const chips: string[] = [];
  let i = 0;
  while (i < text.length && text[i] === "`") {
    const close = text.indexOf("`", i + 1);
    if (close === -1) break;
    const inner = text.slice(i + 1, close);
    if (!inner.length || inner.includes("`") || inner.includes("\n")) break;
    // Promote only when the closing backtick is followed by a valid token
    // boundary — whitespace, end-of-string, or an accepted punctuation char.
    // Adjacent non-space text (e.g. `ctx`message) is plain code, not a chip.
    const next = text[close + 1];
    const atValidBoundary =
      next === undefined
      || next === " "
      || next === "\t"
      || next === "\n"
      || next === ","
      || next === "."
      || next === ":"
      || next === ";";
    if (!atValidBoundary) break;
    chips.push(inner);
    i = close + 1;
    if (next === " ") {
      i += 1;
      continue;
    }
    break;
  }
  return { chips, rest: text.slice(i) };
}

function ChatOutputContextChip({ quote }: { quote: string }) {
  return (
    <span
      className="mx-0.5 inline-flex max-w-[260px] translate-y-[1px] items-center rounded-md border border-violet-300/22 bg-violet-500/12 px-2 py-0.5 font-sans text-[length:calc(var(--chat-font-size)*11/14)] leading-5 text-violet-50/90 align-baseline"
      title={quote}
      data-testid="user-message-chat-context-chip"
    >
      {CHAT_OUTPUT_CONTEXT_CHIP_LABEL}
    </span>
  );
}

function UserMessageSendConfirmations({
  event,
}: {
  event: Extract<AgentChatEvent, { type: "user_message" }>;
}) {
  if (event.deliveryState === "queued") return null;

  const attachments = event.attachments ?? [];
  const contextAttachments = event.contextAttachments ?? [];
  const hasImage = attachments.some((a) => a.type === "image");
  const hasFile = attachments.some((a) => a.type === "file");
  const hasIssueContext = contextAttachments.some((a) => a.type === "linear_issue" || a.type === "github_issue");
  const showFilesRow = hasImage || hasFile;
  const showSimRow = event.text.startsWith(IOS_SIMULATOR_CONTEXT_PREFIX);

  if (!showFilesRow && !showSimRow && !hasIssueContext) return null;

  const attachmentCount = attachments.length;
  const attachmentLabel = attachmentCount <= 1 ? "Attachment analyzed" : "Attachments analyzed";

  return (
    <div className="mt-2 flex flex-col gap-1" data-testid="user-message-send-confirmations">
      {showFilesRow ? (
        <motion.div
          className="flex items-center gap-1.5 font-sans text-[length:calc(var(--chat-font-size)*12/14)] italic text-emerald-400/80"
          data-testid="user-message-attachment-analyzed"
          initial={{ opacity: 0, y: 2 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.15, ease: "easeOut" }}
        >
          {hasImage ? (
            <Image size={12} weight="regular" className="shrink-0 text-emerald-400/85" aria-hidden />
          ) : (
            <Paperclip size={12} weight="regular" className="shrink-0 text-emerald-400/85" aria-hidden />
          )}
          <span>{attachmentLabel}</span>
        </motion.div>
      ) : null}
      {showSimRow ? (
        <motion.div
          className="flex items-center gap-1.5 font-sans text-[length:calc(var(--chat-font-size)*12/14)] italic text-emerald-400/80"
          data-testid="user-message-simulator-analyzed"
          initial={{ opacity: 0, y: 2 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.15, ease: "easeOut" }}
        >
          <Code size={12} weight="regular" className="shrink-0 text-emerald-400/85" aria-hidden />
          <span>Attachments from simulator analyzed</span>
        </motion.div>
      ) : null}
      {hasIssueContext ? (
        <motion.div
          className="flex items-center gap-1.5 font-sans text-[length:calc(var(--chat-font-size)*12/14)] italic text-emerald-400/80"
          data-testid="user-message-issue-context-analyzed"
          initial={{ opacity: 0, y: 2 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.15, ease: "easeOut" }}
        >
          <Bug size={12} weight="regular" className="shrink-0 text-emerald-400/85" aria-hidden />
          <span>Issue context analyzed</span>
        </motion.div>
      ) : null}
    </div>
  );
}

/**
 * A Codex steer the turn ended without reading: the status line plus
 * Run next / Edit / Dismiss, all under the bubble. Once resolved (here or on
 * another surface, via the durable resolution) the line names the outcome.
 */
function UnprocessedMessageAction({
  event,
  status,
  onRun,
  onEdit,
  onDismiss,
}: {
  event: UserMessageEvent;
  status: UserMessageStatus;
  onRun?: (event: UserMessageEvent) => void | Promise<void>;
  onEdit?: (event: UserMessageEvent) => void;
  onDismiss?: (event: UserMessageEvent) => void | Promise<void>;
}) {
  const [running, setRunning] = useState(false);
  const [resolved, setResolved] = useState<"run_next" | "dismiss" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const durableAction =
    event.metadata?.unprocessedMessageResolution?.action ?? null;
  const settledAction = durableAction ?? resolved;
  const run = async () => {
    if (!onRun || running || settledAction) return;
    setRunning(true);
    setError(null);
    try {
      await onRun(event);
      setResolved("run_next");
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError));
    } finally {
      setRunning(false);
    }
  };
  const dismiss = async () => {
    if (!onDismiss || running || settledAction) return;
    setRunning(true);
    setError(null);
    try {
      await onDismiss(event);
      setResolved("dismiss");
    } catch (dismissError) {
      setError(dismissError instanceof Error ? dismissError.message : String(dismissError));
    } finally {
      setRunning(false);
    }
  };
  if (settledAction) {
    return (
      <UserMessageStatusLine
        status={status}
        label={settledAction === "run_next" ? "Started as the next turn" : "Dismissed"}
        tone="muted"
      />
    );
  }
  return (
    <>
      <UserMessageStatusLine status={status} />
      <div className="mt-1 flex flex-wrap items-center justify-end gap-1.5">
        <button
          type="button"
          disabled={running || !onRun}
          className="rounded-md border border-amber-200/22 bg-amber-300/[0.1] px-2.5 py-1 font-sans text-[length:calc(var(--chat-font-size)*10/14)] font-semibold text-amber-50/88 transition-colors hover:border-amber-100/35 hover:bg-amber-300/[0.16] disabled:pointer-events-none disabled:opacity-55"
          onClick={() => void run()}
        >
          {running ? "Working…" : "Run next"}
        </button>
        {onEdit ? (
          <button
            type="button"
            disabled={running}
            className="rounded-md px-2.5 py-1 font-sans text-[length:calc(var(--chat-font-size)*10/14)] font-medium text-fg/58 transition-colors hover:bg-white/[0.06] hover:text-fg/82 disabled:pointer-events-none disabled:opacity-55"
            onClick={() => onEdit(event)}
          >
            Edit
          </button>
        ) : null}
        {onDismiss ? (
          <button
            type="button"
            disabled={running}
            className="rounded-md px-2.5 py-1 font-sans text-[length:calc(var(--chat-font-size)*10/14)] font-medium text-fg/45 transition-colors hover:bg-white/[0.06] hover:text-fg/72 disabled:pointer-events-none disabled:opacity-55"
            onClick={() => void dismiss()}
          >
            Dismiss
          </button>
        ) : null}
        {error ? (
          <div className="w-full text-right text-[length:calc(var(--chat-font-size)*9.5/14)] text-red-200/78" role="alert">
            {error}
          </div>
        ) : null}
      </div>
    </>
  );
}

type RenderEnvelope = {
  key: string;
  timestamp: string;
  event: AgentChatEvent
  | SubagentSpawnAnchorRenderEvent
  | SubagentResultCardRenderEvent
  | SubagentCardGridEvent
  | SubagentStoppedGroupEvent
  | BackgroundJobLineRenderEvent
  | BackgroundJobGroupRenderEvent
  | ScheduledWakeDividerRenderEvent
  | SpawnWakeDividerRenderEvent
  | VoiceCallGroupRenderEvent
  | TurnDetailsRenderEvent
  | TaskListRenderEvent;
  /** Folded-row count from the transcript collapse; see ChatTranscriptRenderEnvelope. */
  repeatCount?: number;
  /** Row identity for a scene's still; see ChatTranscriptRenderEnvelope. */
  sceneScopeKey?: string;
};

function MessageCopyButton({
  value,
  className,
  label = "Copy",
  title = "Copy message",
}: {
  value: string;
  className?: string;
  label?: string;
  title?: string;
}) {
  const { copy, copied } = useCopyToClipboard();

  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-white/[0.06] bg-white/[0.03] px-1.5 py-0.5 font-sans text-[length:calc(var(--chat-font-size)*9/14)] text-fg/40 transition-all hover:border-violet-400/20 hover:bg-violet-500/[0.06] hover:text-fg/70",
        className,
      )}
      onClick={() => void copy(value)}
      title={copied ? "Copied" : title}
      aria-label={copied ? "Copied" : title}
    >
      {copied ? <Checks size={10} weight="bold" /> : <CopySimple size={10} weight="regular" />}
      <span>{copied ? "Copied" : label}</span>
    </button>
  );
}

/* ── Status indicators ── */

function StatusIcon({ status }: { status: "running" | "completed" | "failed" | "interrupted" }) {
  if (status === "interrupted") return <ChatStatusGlyph status="waiting" size={13} />;
  if (status === "completed" || status === "failed") return <ChatStatusGlyph status={status} size={13} />;
  return <ChatStatusGlyph status="working" size={13} />;
}

function statusColorClass(status: string | undefined): string {
  switch (status) {
    case "failed":
      return "text-red-400/70";
    case "interrupted":
    case "running":
      return "text-amber-400/70";
    default:
      return "text-emerald-400/70";
  }
}

type WebSearchActionListProps = {
  actions: NonNullable<Extract<AgentChatEvent, { type: "web_search" }>["actions"]>;
  isFailed: boolean;
};

function WebSearchActionList({ actions, isFailed }: WebSearchActionListProps) {
  const [expanded, setExpanded] = useState(false);
  const HEAD = 8;
  const showAll = expanded || actions.length <= HEAD;
  const visible = showAll ? actions : actions.slice(0, HEAD);
  const hiddenCount = showAll ? 0 : actions.length - visible.length;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {visible.map((action, index) => {
        const label = action.title ?? action.url ?? action.query ?? action.queries?.[0] ?? action.type;
        const title = [action.title, action.url, action.snippet].filter(Boolean).join("\n") || label;
        const className = cn(
          "inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-1 text-left text-[length:calc(var(--chat-font-size)*12/14)] leading-tight transition-colors",
          isFailed
            ? "border-red-400/15 bg-red-500/[0.06] text-red-100/75"
            : "border-cyan-400/15 bg-cyan-500/[0.05] text-cyan-100/80",
          action.url && !isFailed && "hover:border-cyan-300/30 hover:bg-cyan-500/[0.1]",
        );
        const content = (
          <>
            <span className={cn("shrink-0", isFailed ? "text-red-200/55" : "text-cyan-200/65")}>
              {action.type}
            </span>
            <span className="truncate text-fg/72">
              {label}
            </span>
            {action.url ? <CaretRight size={10} className="shrink-0 text-fg/35" /> : null}
          </>
        );
        return action.url ? (
          <button
            key={`${action.type}:${action.url}:${index}`}
            type="button"
            className={className}
            title={title}
            onClick={(event) => openLinkFromUi(action.url, event)}
          >
            {content}
          </button>
        ) : (
          <span
            key={`${action.type}:${action.query ?? action.queries?.join("|") ?? index}`}
            className={className}
            title={title}
          >
            {content}
          </span>
        );
      })}
      {hiddenCount > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="inline-flex items-center rounded-md border border-cyan-400/15 bg-cyan-500/[0.04] px-2 py-1 text-[length:calc(var(--chat-font-size)*12/14)] leading-tight text-cyan-100/70 transition-colors hover:bg-cyan-500/[0.08]"
        >
          +{hiddenCount} more
        </button>
      ) : null}
    </div>
  );
}

type WebSearchResultListProps = {
  results: NonNullable<Extract<AgentChatEvent, { type: "web_search" }>["results"]>;
  resultsTotal?: number;
  isFailed: boolean;
};

function WebSearchResultList({ results, resultsTotal, isFailed }: WebSearchResultListProps) {
  const HEAD = 8;
  const visible = results.slice(0, HEAD);
  const total = typeof resultsTotal === "number" ? resultsTotal : results.length;
  const moreCount = Math.max(0, total - visible.length);
  return (
    <div className="mt-2 flex flex-col gap-0.5">
      {visible.map((result, index) => {
        const display = deriveWebSearchResultDisplay(result);
        const className = cn(
          "flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[length:calc(var(--chat-font-size)*12/14)] leading-tight transition-colors",
          isFailed ? "text-red-100/75" : "text-cyan-100/80",
          display.href && !isFailed && "hover:bg-cyan-500/[0.08]",
        );
        const body = (
          <>
            <Globe size={11} weight="bold" className={cn("shrink-0", isFailed ? "text-red-200/55" : "text-cyan-200/60")} aria-hidden />
            <span className="min-w-0 truncate text-fg/78">{display.title}</span>
            {display.domain ? <span className="shrink-0 truncate text-fg/38">{display.domain}</span> : null}
            {display.href ? <CaretRight size={10} className="ml-auto shrink-0 text-fg/35" aria-hidden /> : null}
          </>
        );
        return display.href ? (
          <button
            key={`${display.href}:${index}`}
            type="button"
            className={className}
            title={display.href}
            onClick={(event) => openLinkFromUi(display.href, event)}
          >
            {body}
          </button>
        ) : (
          <span key={`result:${index}`} className={className}>
            {body}
          </span>
        );
      })}
      {moreCount > 0 ? (
        <span className="px-1.5 py-0.5 text-[length:calc(var(--chat-font-size)*11/14)] text-fg/35">
          +{moreCount} more
        </span>
      ) : null}
    </div>
  );
}

/** Drops the `⚠` a provider already put in front of a warning; the row draws its own icon. */
function stripLeadingWarningGlyph(message: string): string {
  return message.replace(/^\s*\u26A0\uFE0F?\s*/u, "").trim() || message.trim();
}

/**
 * A warning notice as one text-sized row — amber icon plus a one-line,
 * truncated summary — that expands to the full message and detail. Replaces
 * the old `WARNING` label block, inside a turn fold and outside it.
 */
function CompactWarningNoticeRow({
  message,
  detail,
}: {
  message: string;
  detail?: string | AgentChatNoticeDetail;
}) {
  const text = stripLeadingWarningGlyph(message);
  const summary = text.replace(/\s+/g, " ");
  return (
    <div data-testid="compact-warning-notice">
      <InlineDisclosureRow
        summary={(
          <div className="flex min-w-0 items-center gap-2 font-sans text-[length:calc(var(--chat-font-size)*10/14)] text-amber-200/60">
            <Warning size={11} weight="duotone" className="shrink-0 text-amber-300/70" aria-hidden />
            <span className="min-w-0 truncate" title={summary}>{summary}</span>
          </div>
        )}
      >
        <div className="space-y-2 font-sans text-[length:calc(var(--chat-font-size)*10.5/14)] leading-relaxed text-fg/60">
          <div className="whitespace-pre-wrap break-words">{text}</div>
          {detail ? renderNoticeDetail(detail) : null}
        </div>
      </InlineDisclosureRow>
    </div>
  );
}

function InlineDisclosureRow({
  summary,
  children,
  defaultOpen = false,
  className,
}: {
  summary: React.ReactNode;
  children?: React.ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const prevDefaultOpen = useRef(defaultOpen);
  const expandable = Boolean(children);

  useEffect(() => {
    if (!prevDefaultOpen.current && defaultOpen) {
      setOpen(true);
    }
    prevDefaultOpen.current = defaultOpen;
  }, [defaultOpen]);

  return (
    <div className={cn("rounded-lg", className)}>
      <button
        type="button"
        aria-expanded={expandable ? open : undefined}
        className={cn(
          "flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-white/[0.04]",
          !expandable && "cursor-default hover:bg-transparent",
        )}
        onClick={() => {
          if (expandable) setOpen((value) => !value);
        }}
      >
        {expandable ? (
          open ? <CaretDown size={10} weight="bold" className="text-fg/28" /> : <CaretRight size={10} weight="bold" className="text-fg/28" />
        ) : (
          <span className="ml-[2px] inline-flex h-1.5 w-1.5 rounded-full bg-white/12" aria-hidden="true" />
        )}
        <div className="min-w-0 flex-1">{summary}</div>
      </button>
      {expandable && open ? (
        <div className="ml-5 mt-1 space-y-2 border-l border-violet-400/10 pl-3">
          {children}
        </div>
      ) : null}
    </div>
  );
}

function openChatInfoFromActivity(sessionId: string | null | undefined, taskId: string | null): void {
  try {
    window.dispatchEvent(
      new CustomEvent("ade:chat:open-info", {
        detail: {
          ...(sessionId ? { sessionId } : {}),
          ...(taskId ? { taskId } : {}),
        },
      }),
    );
  } catch {
    /* no-op */
  }
}

/**
 * True inside a host that owns a chat actions pane and listens for
 * `ade:chat:open-info` — i.e. `AgentChatPane`, which provides it.
 * `PersonalChatsPage` mounts the same transcript with no actions pane and
 * therefore leaves it false, so an affordance that opens that pane never
 * renders as a button that silently does nothing.
 *
 * Deliberately a context and NOT a module-level "is any host alive" registry:
 * `App` renders every `ProjectSurface` and only toggles `active`, so each
 * `AgentChatPane` stays MOUNTED while Personal Chats is open. A global count
 * would read true on exactly the surface that has no pane, and clicking would
 * dispatch to a hidden pane that drops the event on the `sessionId` guard —
 * recreating the dead affordance this is meant to prevent. Only the owning
 * subtree can answer this question.
 */
export const ChatInfoHostContext = React.createContext(false);

function activityBundleDedupeKey(item: ChatActivityBundleItem): string {
  const event = item.event;
  return `schedule:${event.sourceTaskId ?? event.id}`;
}

// Folding collapses repeated scheduled-work updates for the same id down to the latest.
function foldActivityBundleItems(items: ChatActivityBundleItem[]): ChatActivityBundleItem[] {
  const folded: ChatActivityBundleItem[] = [];
  const indexByKey = new Map<string, number>();
  for (const item of items) {
    const key = activityBundleDedupeKey(item);
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, folded.length);
      folded.push(item);
    } else {
      folded[existingIndex] = item;
    }
  }
  return folded;
}

function ChatActivityBundle({
  event,
  sessionId,
}: {
  event: ChatActivityBundleEvent;
  sessionId?: string | null;
}) {
  const displayItems = foldActivityBundleItems(event.items);
  const rows = displayItems.map((item) => (
    <ScheduledWorkLine
      key={activityBundleDedupeKey(item)}
      event={item.event}
      onOpen={() => openChatInfoFromActivity(sessionId, item.event.sourceTaskId ?? item.event.id)}
    />
  ));
  return displayItems.length === 1 ? rows[0]! : <div className="min-w-0 max-w-full">{rows}</div>;
}

/* ── Collapsible card ── */

function CollapsibleCard({
  children,
  defaultOpen = false,
  forceOpen,
  summary,
  className,
  style: styleProp,
}: {
  children: React.ReactNode;
  defaultOpen?: boolean;
  /** When set, overrides the open state. When it transitions from true→undefined, auto-collapses. */
  forceOpen?: boolean;
  summary: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // Track whether the user explicitly collapsed while forceOpen is active
  const [userCollapsed, setUserCollapsed] = useState(false);
  const prevForceOpen = useRef(forceOpen);
  const panelId = useId();

  useEffect(() => {
    // Auto-collapse when forceOpen transitions from true → falsy (turn finished)
    if (prevForceOpen.current === true && !forceOpen) {
      setOpen(false);
      setUserCollapsed(false);
    }
    // Reset user override when forceOpen activates (new turn)
    if (!prevForceOpen.current && forceOpen) {
      setUserCollapsed(false);
    }
    prevForceOpen.current = forceOpen;
  }, [forceOpen]);

  const isOpen = forceOpen === true ? !userCollapsed : open;

  return (
    <div className={cn(GLASS_CARD_CLASS, "transition-all hover:border-white/[0.08]", className)} style={styleProp ?? SURFACE_INLINE_CARD_STYLE}>
      <button
        type="button"
        aria-expanded={isOpen}
        aria-controls={panelId}
        className="flex w-full items-center gap-2.5 px-4 py-3 text-left font-sans text-[length:calc(var(--chat-font-size)*11/14)] transition-colors hover:bg-white/[0.02]"
        onClick={() => {
          if (forceOpen === true) {
            setUserCollapsed((v) => !v);
          } else {
            setOpen((v) => !v);
          }
        }}
      >
        {isOpen ? <CaretDown size={10} weight="bold" className="text-violet-400/40" /> : <CaretRight size={10} weight="bold" className="text-violet-400/40" />}
        <div className="flex flex-1 flex-wrap items-center gap-2">{summary}</div>
      </button>
      {isOpen ? <div id={panelId} className="border-t border-white/[0.05] px-4 pb-4 pt-3">{children}</div> : null}
    </div>
  );
}

/* ── Diff preview ── */

function DiffPreview({ diff }: { diff: string }) {
  const lines = diff.split(/\r?\n/);
  return (
    <pre className={cn("max-h-80", RECESSED_BLOCK_CLASS)}>
      {lines.map((line, index) => {
        let tone = "text-fg/70";
        let bg = "";
        if (line.startsWith("+")) {
          tone = "text-emerald-400/90";
          bg = "bg-emerald-500/[0.06]";
        } else if (line.startsWith("-")) {
          tone = "text-red-400/90";
          bg = "bg-rose-500/[0.06]";
        } else if (line.startsWith("@@")) {
          tone = "text-accent/60";
        }
        return (
          <div key={`${index}:${line}`} className={cn(tone, bg, "px-1 -mx-1")}>
            {line}
          </div>
        );
      })}
    </pre>
  );
}

/* ── Activity indicator ── */

// Must cover every `activity` value the runtimes emit (see the union in
// shared/types/chat.ts) — an unmapped value now falls through to the raw
// identifier, so a gap here shows the user `web_searching`.
const ACTIVITY_LABELS: Record<Extract<AgentChatEvent, { type: "activity" }>["activity"], string> = {
  thinking: "Thinking",
  working: "Working",
  editing_file: "Editing",
  running_command: "Running command",
  searching: "Searching",
  reading: "Reading",
  tool_calling: "Calling tool",
  web_searching: "Searching the web",
  spawning_agent: "Starting agent"
};

/**
 * The map is typed against the `activity` union so a new runtime value is a
 * compile error rather than a raw identifier on screen; events arrive as plain
 * strings, so reading takes a widened view.
 */
function activityLabel(activity: string): string | undefined {
  return (ACTIVITY_LABELS as Record<string, string>)[activity];
}

/**
 * The live label for the working indicator.
 *
 * `activity` events carry the TOOL name as their detail, not the file, so an
 * edit burst used to read as a bare "Working". Naming the file being written
 * turns a long silent stretch into something a reader can follow, so when the
 * activity is an edit we pull the target off the most recent unfinished write
 * entry in the same turn ("Editing laneService.ts"). Presentational only —
 * canonical phase/attention semantics are owned elsewhere.
 */
export function resolveWorkingIndicatorLabel(
  activity: string | null,
  activeEntries: readonly ChatWorkLogEntry[],
): string | null {
  if (!activity) return null;
  const label = activityLabel(activity) ?? activity;
  if (activity !== "editing_file") return label;

  for (let index = activeEntries.length - 1; index >= 0; index -= 1) {
    const entry = activeEntries[index]!;
    if (entry.entryKind === "file_change") {
      const path = entry.changedFiles?.[entry.changedFiles.length - 1]?.path;
      if (path?.trim().length) return `${label} ${basenamePathLabel(path)}`;
      continue;
    }
    if (entry.entryKind !== "tool" || !entry.toolName) continue;
    const meta = getToolMeta(entry.toolName);
    if (meta.category !== "write" || !meta.getTarget) continue;
    const target = meta.getTarget(readRecord(entry.args) ?? {});
    if (target?.trim().length) return `${label} ${basenamePathLabel(target)}`;
  }
  return label;
}

function ThinkingDots({ toneClass = "bg-emerald-300/70" }: { toneClass?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5" aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className={cn("ade-thinking-pulse inline-block h-[5px] w-[5px] rounded-full", toneClass)}
          style={{ animationDelay: `${index * 0.18}s` }}
        />
      ))}
    </span>
  );
}

// After the turn has been active this long with no terminal event, the
// indicator adds a quiet "taking longer than usual" note so a long silent wait
// doesn't read as frozen. Provider overloads (HTTP 529) and transient errors
// are retried *inside* the model SDK with nothing surfaced to us until they
// resolve or finally fail — so a long "Thinking" is the only signal we get.
const LONG_RUNNING_TURN_SECONDS = 30;

/**
 * Formats the elapsed turn time as a compact "working for" duration. Stays as
 * bare seconds under a minute ("42s") and rolls into minutes past it
 * ("1m 03s", "13m 13s") so a long turn doesn't read as an enormous raw second
 * count. The whole turn — not the current sub-action — is what's been running.
 */
export function formatElapsedSeconds(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  if (safe < 60) return `${safe}s`;
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/**
 * The single, calm "model is working" indicator (replaces the prior tangle of
 * shimmer-text / emerald + violet dot variants). Three violet pulses + a
 * concise verb + a self-ticking elapsed timer that mutates textContent via a
 * ref — no per-second React commit (t3code / Codex desktop reference).
 *
 * Elapsed is anchored to the turn's real start timestamp (wall clock), so
 * leaving the chat and coming back keeps the true elapsed instead of resetting
 * to 0 on remount.
 */
function WorkingIndicator({
  activity,
  startedAt,
  toolEntries,
  onNavigateSuggestion,
  onInsertDraft,
  onRevealChatTerminal,
  sessionId,
}: {
  activity: string | null;
  startedAt: number | null;
  toolEntries: ChatWorkLogEntry[];
  onNavigateSuggestion?: (suggestion: OperatorNavigationSuggestion) => void;
  onInsertDraft?: (text: string) => void;
  onRevealChatTerminal?: (terminal: { terminalId: string; ptyId: string; label: string }) => void;
  sessionId?: string | null;
}) {
  const timerRef = useRef<HTMLSpanElement | null>(null);
  const startMsRef = useRef<number | null>(null);
  const [longRunning, setLongRunning] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const hasToolActivity = toolEntries.length > 0;
  // The status line swaps between a bare <span> and an expander <button> the
  // moment the turn's first tool entry lands, which makes React unmount and
  // remount the timer element. Painting through a *callback* ref (rather than
  // an element captured once when the ticker started) reattaches the counter to
  // whichever node is currently mounted and repaints it in the same commit, so
  // the swap can't strand the ticker on a detached node — the bug that froze
  // the display at "0s" while "taking longer than usual" still appeared.
  const attachTimer = useCallback((el: HTMLSpanElement | null) => {
    timerRef.current = el;
    if (!el) return;
    const startMs = startMsRef.current ?? startedAt ?? Date.now();
    el.textContent = formatElapsedSeconds((Date.now() - startMs) / 1000);
  }, [startedAt]);
  useEffect(() => {
    const startMs = startedAt ?? Date.now();
    startMsRef.current = startMs;
    let handle = 0;
    const tick = () => {
      const elapsedSec = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
      // Re-read the ref every tick — see attachTimer above.
      const el = timerRef.current;
      if (el) el.textContent = formatElapsedSeconds(elapsedSec);
      setLongRunning(elapsedSec >= LONG_RUNNING_TURN_SECONDS);
      handle = window.setTimeout(tick, 1000);
    };
    tick();
    return () => window.clearTimeout(handle);
  }, [startedAt]);
  const status = (
    <span className="inline-flex min-w-0 items-center gap-2 font-sans text-[length:calc(var(--chat-font-size)*12/14)]">
      <ThinkingDots toneClass="bg-violet-400/70" />
      <span className="min-w-0 truncate font-medium text-fg/55">{activity ?? "Working"}</span>
      <span className="shrink-0 text-fg/28" aria-hidden>·</span>
      <span className="shrink-0 text-fg/38">
        working for <span ref={attachTimer} className="tabular-nums">0s</span>
      </span>
      {longRunning ? (
        <>
          <span className="shrink-0 text-fg/28" aria-hidden>·</span>
          <span className="shrink-0 text-fg/35">taking longer than usual</span>
        </>
      ) : null}
      {hasToolActivity ? (
        activityOpen
          ? <CaretDown size={10} weight="bold" className="shrink-0 text-violet-300/45" />
          : <CaretRight size={10} weight="bold" className="shrink-0 text-violet-300/45" />
      ) : null}
    </span>
  );
  return (
    <div className="min-w-0 max-w-full">
      {hasToolActivity ? (
        <button
          type="button"
          aria-expanded={activityOpen}
          aria-label={`${activityOpen ? "Hide" : "Show"} activity from the active turn`}
          onClick={() => setActivityOpen((open) => !open)}
          className="flex max-w-full items-center rounded-md py-0.5 text-left transition-colors hover:text-fg/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-300/40"
        >
          {status}
        </button>
      ) : status}
      <AnimatePresence initial={false}>
        {hasToolActivity && activityOpen ? (
          <motion.div
            initial={{ opacity: 0, height: 0, y: -4 }}
            animate={{ opacity: 1, height: "auto", y: 0 }}
            exit={{ opacity: 0, height: 0, y: -4 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
            className="mt-2 min-w-0 overflow-hidden border-l border-violet-300/15 pl-4"
          >
            <ChatToolActivityDetails
              entries={toolEntries}
              onNavigateSuggestion={onNavigateSuggestion}
              onInsertDraft={onInsertDraft}
              onRevealChatTerminal={onRevealChatTerminal}
              sessionId={sessionId}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function formatActivityText(activity: string, detail?: string): string {
  const label = activityLabel(activity) ?? activity;
  return detail ? `${label}: ${replaceInternalToolNames(detail)}` : `${label}…`;
}

/**
 * One reasoning row. The live, newest thought of a streaming turn draws the
 * `ThinkingPreview` (header + live block); every other thought is the compact
 * `Thought` row that opens to the full text in the grey block.
 * One `open` state spans both, so a reader who expands the live card keeps it
 * open when the thought settles into a Thought row.
 */
function MinimalThought({
  text,
  livePreview,
  label,
  startedAtMs,
  durationSeconds,
}: {
  text: string;
  livePreview: boolean;
  label: string | null;
  startedAtMs: number | null;
  durationSeconds: number | null;
}) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((v) => !v), []);
  if (livePreview) {
    return (
      <ThinkingPreview
        text={text}
        label={label}
        startedAtMs={startedAtMs}
        expanded={open}
        onToggleExpanded={toggle}
      />
    );
  }
  const trimmed = text.trim();
  const Caret = open ? CaretDown : CaretRight;
  return (
    <div className="font-sans text-[length:calc(var(--chat-font-size)*11/14)]">
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="flex max-w-full items-center gap-1.5 py-0.5 text-left transition-colors"
      >
        <Caret size={9} weight="bold" className="shrink-0 text-violet-400/45" />
        {/* Plain text: no trailing dots. The live `… is thinking` header owns the motion. */}
        <span className="inline-flex items-center font-medium text-fg/55" data-testid="thought-label">
          <span>Thought</span>
          {durationSeconds != null ? (
            <span className="ml-1 font-normal text-fg/40">for {formatThinkingElapsed(durationSeconds)}</span>
          ) : null}
        </span>
      </button>
      {open ? (
        <ThoughtBlock>
          <MarkdownBlock markdown={trimmed.length ? text : "…"} tone="thought" />
        </ThoughtBlock>
      ) : null}
    </div>
  );
}

/* ── Tool result card ── */

const TOOL_RESULT_TRUNCATE_LIMIT = 500;

function ToolResultCard({ event }: { event: Extract<AgentChatEvent, { type: "tool_result" }> }) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const meta = getToolMeta(event.tool);
  const ToolIcon = meta.icon;
  const toolDisplay = describeToolIdentifier(event.tool);
  const sourceChip = toolSourceChip(event.tool);
  const navigationSuggestions = readNavigationSuggestions(event.result);
  const resultStr = formatStructuredValue(event.result);
  const isTruncated = resultStr.length > TOOL_RESULT_TRUNCATE_LIMIT;
  const displayStr = !expanded && isTruncated ? `${resultStr.slice(0, TOOL_RESULT_TRUNCATE_LIMIT)}...` : resultStr;
  const rawPreview = summarizeStructuredValue(event.result, 180);
  // Grep: prefix the preview with the match/file totals the service extracted.
  const preview = `${formatGrepTotalsPrefix(event.grepTotals)}${rawPreview}`;
  // Bash: a command that auto-backgrounded on timeout carries the elapsed ms;
  // surface it as a calm chip instead of the generic status word.
  const timedOutMs = typeof event.timedOutAfterMs === "number" ? event.timedOutAfterMs : null;
  const timedOutLabel = timedOutMs != null ? formatTimedOutAfter(timedOutMs) : null;

  return (
    <motion.div
      className="w-fit max-w-full"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.12, ease: "easeOut" }}
    >
    <CollapsibleCard
      summary={
        <div className="flex items-center gap-2 font-sans text-[length:calc(var(--chat-font-size)*11/14)]">
          <span className={cn("inline-flex", (event.status ?? "completed") === "running" && "ade-tool-bounce")}>
            <StatusIcon status={event.status ?? "completed"} />
          </span>
          <span className={cn("ade-chat-status-pill inline-flex items-center gap-1.5 border px-2 py-0.5 text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-wider", meta.badgeCls)}>
            <ToolIcon size={11} weight="bold" />
            {meta.label}
          </span>
          {sourceChip ? (
            <span className={cn("inline-flex items-center border px-1.5 py-0.5 text-[length:calc(var(--chat-font-size)*8/14)] font-bold uppercase tracking-[0.16em]", chatChipToneClass(sourceChip.tone))}>
              {sourceChip.label}
            </span>
          ) : null}
          {toolDisplay.secondaryLabel ? (
            <span className="font-bold text-fg/75">{toolDisplay.secondaryLabel}</span>
          ) : null}
          {preview.length ? <span className="max-w-[360px] truncate text-[length:calc(var(--chat-font-size)*10/14)] text-fg/35">{preview}</span> : null}
          {timedOutLabel ? (
            <span
              className="inline-flex items-center gap-1 rounded-md border border-white/[0.07] bg-white/[0.025] px-2 py-0.5 font-mono text-[length:calc(var(--chat-font-size)*9/14)] text-fg/55"
              title={event.backgroundCwdHint ? `Running in ${event.backgroundCwdHint}` : undefined}
            >
              auto-backgrounded after {timedOutLabel}
            </span>
          ) : event.status ? (
            <span className={cn("text-[length:calc(var(--chat-font-size)*10/14)] uppercase tracking-wider", statusColorClass(event.status))}>
              {event.status}
            </span>
          ) : null}
        </div>
      }
      defaultOpen={navigationSuggestions.length > 0}
      className="border-transparent w-fit max-w-full"
    >
      {navigationSuggestions.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-2">
          {navigationSuggestions.map((suggestion) => (
            <button
              key={`${suggestion.surface}:${suggestion.href}`}
              type="button"
              className="rounded-[8px] border border-accent/20 bg-accent/[0.08] px-2.5 py-1 font-mono text-[length:calc(var(--chat-font-size)*10/14)] font-semibold text-accent/85 transition-colors hover:bg-accent/[0.14] hover:text-accent"
              onClick={() => navigate(suggestion.href)}
            >
              {suggestion.label}
            </button>
          ))}
        </div>
      ) : null}
      <pre className={cn("max-h-52", RECESSED_BLOCK_CLASS)}>
        {displayStr}
      </pre>
      {isTruncated ? (
        <button
          type="button"
          className="mt-1.5 font-mono text-[length:calc(var(--chat-font-size)*10/14)] text-accent/60 hover:text-accent"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "collapse" : `show all (${resultStr.length} chars)`}
        </button>
      ) : null}
    </CollapsibleCard>
    </motion.div>
  );
}

/* ── Main event renderer ── */

function isKnownModelRefForDescriptor(desc: ModelDescriptor, value?: string): boolean {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (!normalized.length) return false;
  return normalized === desc.id.toLowerCase()
    || normalized === desc.shortId.toLowerCase()
    || normalized === desc.providerModelId.toLowerCase()
    || (desc.aliases ?? []).some((alias) => alias.trim().toLowerCase() === normalized);
}

function resolveModelLabel(modelId?: string, model?: string): string | null {
  if (modelId) {
    const desc = getModelById(modelId);
    if (desc) {
      // When the runtime-reported model name differs from all known canonical
      // identifiers, show it in the parenthetical so the user sees the exact
      // model string the provider returned (e.g. a snapshot variant).
      const isNonCanonicalModel = Boolean(model?.trim())
        && !isKnownModelRefForDescriptor(desc, model);
      if (isNonCanonicalModel) {
        return `${desc.displayName} (${model?.trim()})`;
      }
      return desc.displayName;
    }
    return modelId;
  }
  if (model) {
    const desc = resolveModelDescriptor(model);
    if (desc) return desc.displayName;
    return model;
  }
  return null;
}

function resolveModelMeta(modelId?: string, model?: string): {
  label: string | null;
  family: string | null;
  cliCommand: string | null;
  modelId: string | null;
  providerModelId: string | null;
} {
  const key = modelId ?? model;
  const descriptor = key ? (getModelById(key) ?? resolveModelDescriptor(key)) : undefined;
  const idHint = String(modelId ?? model ?? "").trim();
  const inferredCursor = !descriptor && idHint.startsWith("cursor/");
  const inferredDroid = !descriptor && idHint.startsWith("droid/");
  return {
    label: resolveModelLabel(modelId, model),
    family: descriptor?.family ?? (inferredCursor ? "cursor" : inferredDroid ? "factory" : null),
    cliCommand: descriptor?.cliCommand ?? (inferredCursor ? "cursor" : inferredDroid ? "droid" : null),
    modelId: descriptor?.id ?? (idHint || null),
    providerModelId: descriptor?.providerModelId
      ?? (inferredCursor ? idHint.slice("cursor/".length) : inferredDroid ? idHint.slice("droid/".length) : null),
  };
}

type TurnModelDescriptor = { label: string; modelId?: string; model?: string };

type DerivedTurnModelState = {
  map: Map<string, TurnModelDescriptor>;
  lastModel: TurnModelDescriptor | null;
  processedLength: number;
  lastProcessedEnvelope: AgentChatEventEnvelope | null;
};

export function deriveTurnModelState(
  events: AgentChatEventEnvelope[],
  previous: DerivedTurnModelState | null = null,
): DerivedTurnModelState {
  const canIncrementallyAppend =
    !!previous
    && previous.processedLength <= events.length
    && (
      previous.processedLength === 0
      || previous.lastProcessedEnvelope === events[previous.processedLength - 1]
    );

  const map = canIncrementallyAppend && previous
    ? new Map(previous.map)
    : new Map<string, TurnModelDescriptor>();
  let lastModel = canIncrementallyAppend ? (previous?.lastModel ?? null) : null;
  const startIndex = canIncrementallyAppend && previous ? previous.processedLength : 0;

  for (let index = startIndex; index < events.length; index += 1) {
    const evt = events[index]?.event;
    if (!evt || evt.type !== "done") continue;
    const modelLabel = resolveModelLabel(evt.modelId, evt.model);
    if (!evt.turnId || !modelLabel) continue;
    const model = {
      label: modelLabel,
      ...(evt.modelId ? { modelId: evt.modelId } : {}),
      ...(evt.model ? { model: evt.model } : {}),
    };
    map.set(evt.turnId, model);
    lastModel = model;
  }

  return {
    map,
    lastModel,
    processedLength: events.length,
    lastProcessedEnvelope: events.length > 0 ? events[events.length - 1]! : null,
  };
}

function ModelGlyph({
  modelId,
  model,
  size = 12,
  className,
}: {
  modelId?: string;
  model?: string;
  size?: number;
  className?: string;
}) {
  const meta = resolveModelMeta(modelId, model);
  if (meta.family === "cursor" || meta.cliCommand === "cursor") {
    return <CursorAgentLogo size={size} className={className} />;
  }
  if (meta.family === "factory" || meta.cliCommand === "droid") {
    return (
      <ModelRowLogo
        modelFamily="factory"
        cliCommand="droid"
        modelId={meta.modelId ?? modelId ?? model}
        providerModelId={meta.providerModelId ?? undefined}
        size={size}
        className={className}
      />
    );
  }
  if (meta.family === "anthropic" || meta.cliCommand === "claude") {
    return <ClaudeLogo size={size} className={className} />;
  }
  if (meta.cliCommand === "codex") {
    return <CodexLogo size={size} className={className} />;
  }
  return <Robot size={size} weight="bold" className={className} />;
}

function commandTimelineVerb(status: Extract<AgentChatEvent, { type: "command" }>["status"]): string {
  if (status === "failed") return "Command failed";
  if (status === "running") return "Running";
  return "Ran";
}

function CommandEventCard({
  event,
}: {
  event: Extract<AgentChatEvent, { type: "command" }>;
}) {
  const outputTrimmed = event.output.trim();
  const hasOutput = outputTrimmed.length > 0;
  const timelineVerb = commandTimelineVerb(event.status);
  const timelineSummary = (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[length:calc(var(--chat-font-size)*11/14)] text-fg/52">
      <span className="inline-flex h-3 w-3 items-center justify-center">
        <ChatStatusGlyph status={event.status === "running" ? "working" : event.status} size={11} />
      </span>
      <Terminal size={11} weight="regular" className="text-fg/34" />
      <span className="font-medium text-fg/62">{timelineVerb}</span>
      <span className="min-w-0 flex-1 truncate text-fg/76">{event.command}</span>
      {event.durationMs != null ? <span className="text-[length:calc(var(--chat-font-size)*10/14)] text-fg/28">{Math.max(0, event.durationMs)}ms</span> : null}
      {event.exitCode != null ? (
        <span className={cn("text-[length:calc(var(--chat-font-size)*10/14)]", event.exitCode === 0 ? "text-emerald-300/60" : "text-red-300/65")}>
          {event.exitCode === 0 ? "pass" : `exit ${event.exitCode}`}
        </span>
      ) : null}
    </div>
  );

  const commandBody = (
    <>
      <div className="rounded-lg border border-white/[0.06] bg-black/25 px-3.5 py-2.5 font-mono text-[length:calc(var(--chat-font-size)*11/14)] text-fg/80">
        <span className="select-none text-amber-500/40">$ </span>
        {event.command}
      </div>
      {hasOutput ? (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-white/[0.06] bg-black/25 px-3.5 py-2.5 font-mono text-[length:calc(var(--chat-font-size)*11/14)] leading-[1.5] text-fg/60">
          {event.output}
        </pre>
      ) : null}
    </>
  );

  return (
    <InlineDisclosureRow
      defaultOpen={event.status === "failed"}
      summary={timelineSummary}
      className={WORK_LOG_CARD_CLASS}
    >
      {commandBody}
    </InlineDisclosureRow>
  );
}

function FileChangeEventCard({
  event,
}: {
  event: Extract<AgentChatEvent, { type: "file_change" }>;
}) {
  const { additions, deletions } = summarizeDiffStats(event.diff);
  const hasDiff = event.diff.trim().length > 0;
  const basename = basenamePathLabel(event.path);
  const dirname = dirnamePathLabel(event.path);
  const summary = (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[length:calc(var(--chat-font-size)*11/14)] text-fg/52">
      <span className="inline-flex h-3 w-3 items-center justify-center">
        <ChatStatusGlyph status={event.status === "running" ? "working" : (event.status ?? "completed")} size={11} />
      </span>
      <FileCode size={11} weight="regular" className="text-fg/34" />
      <span className="font-medium text-fg/62">{formatFileAction(event.kind)}</span>
      <span className="min-w-0 max-w-full truncate text-fg/78" title={event.path}>{basename}</span>
      {additions > 0 ? <span className="text-emerald-300/70">+{additions}</span> : null}
      {deletions > 0 || event.kind === "delete" ? <span className="text-red-300/70">-{deletions}</span> : null}
      {dirname ? (
        <span className="min-w-0 max-w-full truncate text-[length:calc(var(--chat-font-size)*10/14)] text-fg/26" title={dirname}>
          {dirname}
        </span>
      ) : null}
    </div>
  );

  return (
    <InlineDisclosureRow
      defaultOpen={event.status === "failed"}
      summary={summary}
      className={WORK_LOG_CARD_CLASS}
    >
      {hasDiff ? (
        <DiffPreview diff={event.diff} />
      ) : (
        <div className="font-mono text-[length:calc(var(--chat-font-size)*11/14)] text-muted-fg/40">No diff payload available.</div>
      )}
    </InlineDisclosureRow>
  );
}


// Tracks which user messages have already played their send-up entrance, so the
// optimistic→delivered swap (and virtualized re-mounts) don't replay it — that
// replay read as a flicker once the bubble settled.
const animatedUserMessageKeys = new Set<string>();

/** Stable-ish identity for an interrupt receipt row (no id on the event). */
/** Muted per-row timestamp, revealed on row hover only (lives inside an existing
 * group-hover toolbar so it adds zero layout shift). */
function RowHoverTimestamp({ iso, className }: { iso: string; className?: string }) {
  const label = formatTime(iso);
  if (!label) return null;
  return (
    <span className={cn("pointer-events-none select-none whitespace-nowrap font-sans text-[length:calc(var(--chat-font-size)*9.5/14)] tabular-nums text-fg/35", className)}>
      {label}
    </span>
  );
}

function QueueRecoveryCard({
  recoveryId,
  messageCount,
  expiresAt,
  settled,
  onRestore,
}: {
  recoveryId: string;
  messageCount: number;
  expiresAt: string;
  settled: boolean;
  onRestore?: (recoveryId: string) => Promise<boolean>;
}) {
  const expiresAtMs = Date.parse(expiresAt);
  const [expired, setExpired] = useState(
    () => !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now(),
  );
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    if (settled || expired) return;
    const remainingMs = expiresAtMs - Date.now();
    if (remainingMs <= 0) {
      setExpired(true);
      return;
    }
    const timer = window.setTimeout(() => setExpired(true), remainingMs);
    return () => window.clearTimeout(timer);
  }, [expired, expiresAtMs, settled]);

  if (settled || expired) return null;
  return (
    <div className="inline-flex max-w-[var(--chat-content-width,52rem)] items-center gap-2 rounded-lg border border-border/15 bg-surface-raised/20 px-2.5 py-1.5 font-sans text-[length:calc(var(--chat-font-size)*10.5/14)] text-fg/60">
      <Warning size={11} weight="bold" className="shrink-0 text-fg/40" aria-hidden />
      <span>
        Cleared {messageCount} queued message{messageCount === 1 ? "" : "s"}.
      </span>
      {onRestore ? (
        <button
          type="button"
          disabled={restoring}
          onClick={() => {
            setRestoring(true);
            void onRestore(recoveryId).then((restored) => {
              if (restored) setExpired(true);
            }).catch(() => {
              // The pane reports the error and keeps this recovery available
              // for another attempt until its deadline.
            }).finally(() => {
              setRestoring(false);
            });
          }}
          className="shrink-0 font-medium text-[var(--chat-accent)] underline-offset-2 hover:underline disabled:cursor-wait disabled:opacity-50"
        >
          {restoring ? "Restoring…" : "Undo"}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Dispatcher for an `ade_card`'s non-`open` actions.
 *
 * `<AdeCard>` filters out every action it cannot route, so before this existed
 * the schema's action row was unreachable: no `onAction` prop meant no buttons,
 * whatever the emitter sent. Two behaviours:
 *
 * - `retry` / `refresh` re-enter the card's own surface when it has a nav
 *   target. That is a real retry, not a no-op: the PR checks tab refetches on
 *   mount, which is exactly what a rate-limited CI card needs.
 * - anything else is broadcast as `ade:chat:card-action` for a host to pick up,
 *   the same extension shape as `ade:chat:open-info`.
 */
function dispatchAdeCardAction(
  card: Extract<AgentChatEvent, { type: "ade_card" }>,
  actionId: string,
  sessionId: string | null,
): void {
  if ((actionId === "retry" || actionId === "refresh") && card.navTarget) {
    navigateToAppTarget(card.navTarget);
    return;
  }
  try {
    window.dispatchEvent(
      new CustomEvent("ade:chat:card-action", {
        detail: {
          actionId,
          cardId: card.cardId,
          variant: card.variant,
          ...(sessionId ? { sessionId } : {}),
          ...(card.navTarget ? { navTarget: card.navTarget } : {}),
        },
      }),
    );
  } catch {
    /* no-op */
  }
}

/** The option bag `renderEvent` takes, named so folded rows can be re-rendered with it. */
type RenderEventOptions = NonNullable<Parameters<typeof renderEvent>[1]>;

/**
 * A whole CTO voice call as one transcript row.
 *
 * A call thinks on the normal chat thread, so without this every spoken word
 * would read as a user bubble and every reply as an assistant message. Collapsed
 * is therefore the default: one line saying a call happened, how long it ran,
 * how much was said, and the first thing the user said. Expanding replays the
 * exact rows the transcript would have shown, rendered by `renderEvent` itself —
 * a `voice_call_group` never nests inside another, so the recursion is one level
 * deep by construction. `work_log_group` rows are skipped here for the same
 * reason the timeline skips them: tool work lives in the turn footer.
 */
/**
 * One still from a call, or nothing.
 *
 * Nothing rather than a broken image. A local window resolves the bytes through
 * `ade-artifact://project/`; a chat pinned to another machine has no such
 * handler, so the picture is read back through that machine's own broker — and
 * if neither answers, the card draws no tile at all.
 */
function VoiceCallStill({
  still,
  className,
  testId,
}: {
  still: SceneStillRecord;
  className: string;
  testId: string;
}) {
  // A call's record is bytes on disk and nothing else: this window never held
  // a data URL for it.
  const src = useSceneStillSrc({ dataUrl: null, record: still });
  if (!src) return null;
  return <img src={src} alt={still.title} data-testid={testId} className={className} />;
}

function VoiceCallGroupCard({
  event,
  options,
}: {
  event: VoiceCallGroupRenderEvent;
  options?: RenderEventOptions;
}) {
  const [expanded, setExpanded] = useState(false);
  const duration = formatCompactDuration(event.durationMs);
  const exchanges = `${event.exchanges} ${event.exchanges === 1 ? "exchange" : "exchanges"}`;
  /**
   * The views the call drew.
   *
   * They are not in the folded rows and cannot be: a call's scene is rendered
   * by the HUD, which is gone by the time this card exists, so a card built
   * only from transcript rows showed a call about a chart with no chart in it.
   * The still is taken while the scene is still on screen and lands here as a
   * record of bytes in the project's artifact store — the same picture, from
   * the place that outlived the frame.
   */
  const stills = useCallStills(options?.sessionId ?? null, event.callId);
  return (
    <ChatCard
      skin="rail"
      tone="neutral"
      data-testid="voice-call-card"
      data-voice-call-id={event.callId}
    >
      <ChatCardRow
        tone="neutral"
        icon={Microphone}
        align="top"
        meta={duration ?? undefined}
      >
        {/* The caret is INSIDE the toggle, not in the row's action slot: the
            slot sits outside the button, so the one thing in the row that looks
            like a disclosure control was the one thing that did nothing. */}
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="flex min-w-0 w-full items-start gap-2 text-left"
        >
          <span className="min-w-0 flex-1">
            <ChatCardTitle>
              Voice call
              <ChatCardFaint>
                {` · ${exchanges}`}
                {event.hadApproval ? " · approval" : ""}
              </ChatCardFaint>
            </ChatCardTitle>
            {event.openingLine ? <ChatCardSub>{event.openingLine}</ChatCardSub> : null}
          </span>
          {/* Collapsed, the picture is a hint that there is one — one thumbnail,
              not a strip, because the row has to stay a row. */}
          {!expanded && stills.length ? (
            <VoiceCallStill
              still={stills[stills.length - 1]!}
              className="mt-[1px] h-7 w-10 shrink-0 rounded-[3px] object-cover"
              testId="voice-call-still-thumb"
            />
          ) : null}
          <span className="mt-[3px] shrink-0 text-fg/40" data-testid="voice-call-caret">
            {expanded
              ? <CaretDown size={12} weight="bold" aria-hidden />
              : <CaretRight size={12} weight="bold" aria-hidden />}
          </span>
        </button>
      </ChatCardRow>
      {expanded && stills.length ? (
        <div className="mt-2.5 flex flex-wrap gap-2" data-testid="voice-call-stills">
          {stills.map((still) => (
            <figure key={still.uri} className="m-0 min-w-0">
              <VoiceCallStill
                still={still}
                className="max-h-40 w-auto rounded-[5px] border border-white/[0.07]"
                testId="voice-call-still"
              />
              <figcaption className="mt-1 truncate text-[length:calc(var(--chat-font-size)*10/14)] text-fg/40">
                {still.title}
              </figcaption>
            </figure>
          ))}
        </div>
      ) : null}
      {expanded ? (
        <div className="mt-2.5 space-y-3 border-l border-white/[0.06] pl-3" data-testid="voice-call-rows">
          {event.rows.map((row) => {
            if (row.event.type === "work_log_group") return null;
            return (
              <div key={row.key} className="min-w-0 max-w-full overflow-hidden">
                {row.event.type === "activity_bundle"
                  ? <ChatActivityBundle event={row.event} sessionId={options?.sessionId} />
                  : renderEvent(row as RenderEnvelope, options)}
              </div>
            );
          })}
        </div>
      ) : null}
    </ChatCard>
  );
}

function renderEvent(
  envelope: RenderEnvelope,
  options?: SpawnedChatProviderProps & {
    onApproval?: (itemId: string, decision: AgentChatApprovalDecision, responseText?: string | null, answers?: Record<string, string | string[]>) => void;
    onCodexRecovery?: (args: AgentChatRecoverCodexTurnArgs) => Promise<AgentChatRecoverCodexTurnResult>;
    onRecoverContinuity?: (args: AgentChatRecoverContinuityArgs) => Promise<AgentChatContinuityRecoveryResult>;
    onRetryProviderFailure?: (turnId: string | null) => Promise<string | null>;
    onChooseProviderFailureModel?: () => void;
    onRunUnprocessedMessage?: (event: UserMessageEvent) => void | Promise<void>;
    onEditUnprocessedMessage?: (event: UserMessageEvent) => void;
    onDismissUnprocessedMessage?: (event: UserMessageEvent) => void | Promise<void>;
    turnModel?: { label: string; modelId?: string; model?: string } | null;
    surfaceMode?: ChatSurfaceMode;
    surfaceProfile?: ChatSurfaceProfile;
    assistantLabel?: string;
    turnActive?: boolean;
    sessionTurnActive?: boolean;
    sessionEnded?: boolean;
    /** A usage limit is live for this chat — the composer pill owns the state. */
    usageLimitResumeActive?: boolean;
    onOpenWorkspacePath?: (path: string | WorkspacePathLocation) => void;
    respondingApprovalIds?: Set<string>;
    pendingApprovalIds?: Set<string>;
    resolvedInputStates?: Map<string, PendingInputResolution>;
    resolvedInputAnswers?: Map<string, Record<string, string | string[]>>;
    laneId?: string | null;
    sessionId?: string | null;
    runtimeName?: string | null;
    onRevealChatTerminal?: (terminal: { terminalId: string; ptyId: string; label: string }) => void;
    onRewindFiles?: (request: { messageId: string; timestamp: string; text: string }) => void;
    turnDiffSummaries?: TurnDiffSummary[];
    mosaic?: MosaicRenderContext;
    /** Scroll a row into view by its stable render key (subagent jump affordances). */
    onScrollToRowKey?: (rowKey: string) => void;
    assistantTurnCopy?: { text: string } | null;
    /** Interrupt-receipt identities whose queued messages already ran → collapse. */
    staleInterruptReceipts?: Set<string>;
    /** True when a host is listening for `ade:chat:open-info` (see the registry). */
    chatInfoHostAvailable?: boolean;
    /** Cancel an ADE-owned queued message by uuid (stop-receipt affordance). */
    onCancelQueuedMessage?: (uuid: string) => void;
    onRestoreCancelledQueue?: (recoveryId: string) => Promise<boolean>;
    settledQueueRecoveryIds?: Set<string>;
    /** Stop one running subagent / background task by provider task id. */
    onStopSubagent?: (taskId: string) => void;
    /**
     * True for the single trailing streaming assistant text row of a visible
     * main transcript — the only row whose growth is paced.
     */
    pacedTextReveal?: boolean;
    /** This reasoning row is the newest row of the live turn and still streaming. */
    liveThinking?: boolean;
  }
) {
  const event = envelope.event;

  // One rule for "this row draws nothing", shared with Thought-run merging.
  if (transcriptEventDrawsNothing(event, options)) return null;

  if (event.type === "model_handoff") {
    // Same-provider handoffs never reach here: they are dropped upstream by
    // `isSameProviderModelHandoffEvent` so they do not mount an empty row.
    const fromLabel = providerDisplayLabel(event.fromProvider, "Previous model");
    const toLabel = providerDisplayLabel(event.toProvider, "New model");
    return (
      <div
        className="my-3 flex items-center gap-2 font-sans text-fg/50"
        data-testid="model-handoff-event"
        aria-label={`Model handoff from ${fromLabel} to ${toLabel}`}
        title={`Model handoff from ${fromLabel} to ${toLabel}`}
      >
        <span className="h-px flex-1 bg-fg/[0.08]" />
        <span className="inline-flex h-6 shrink-0 items-center gap-2 leading-none">
          <span
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden [&_svg]:block"
            data-model-handoff-provider={event.fromProvider}
            aria-label={fromLabel}
          >
            <ProviderLogo family={event.fromProvider} size={20} />
          </span>
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] leading-none text-fg/45">
            handoff
          </span>
          <ArrowRight size={14} weight="bold" className="block shrink-0" aria-hidden />
          <span
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden [&_svg]:block"
            data-model-handoff-provider={event.toProvider}
            aria-label={toLabel}
          >
            <ProviderLogo family={event.toProvider} size={20} />
          </span>
        </span>
        <span className="h-px flex-1 bg-fg/[0.08]" />
      </div>
    );
  }

  if (event.type === "scheduled_wake_divider") {
    const reason = event.reason?.trim();
    return (
      <div
        className="my-3 flex items-center gap-2 font-sans text-[length:calc(var(--chat-font-size)*10.5/14)] text-amber-200/65"
        data-scheduled-wake-id={event.scheduleId}
      >
        <span className="h-px flex-1 bg-amber-200/[0.08]" />
        <span className="shrink-0">⏰ Woke on schedule · {formatTime(event.firedAt)}{reason ? ` · ${reason}` : ""}{event.late ? " · late" : ""}</span>
        <span className="h-px flex-1 bg-amber-200/[0.08]" />
      </div>
    );
  }

  /* ── Spawn-completion header ── */
  if (event.type === "spawn_wake_divider") {
    const summary = event.summary?.trim();
    return (
      <div className="my-3 flex flex-col gap-1" data-spawn-wake-child={event.childSessionId}>
        <div className="flex items-center gap-2 font-sans text-[length:calc(var(--chat-font-size)*10.5/14)] text-violet-200/70">
          <span className="h-px flex-1 bg-violet-300/[0.1]" />
          <span className="inline-flex shrink-0 items-center gap-1.5">
            <Robot size={11} weight="duotone" className="text-violet-300/75" aria-hidden />
            Subagent returned
          </span>
          <span className="h-px flex-1 bg-violet-300/[0.1]" />
        </div>
        <button
          type="button"
          onClick={() => navigateToSpawnedChat(event.childSessionId, options?.laneId ?? null)}
          className="mx-auto inline-flex max-w-[var(--chat-content-width,52rem)] items-center gap-1.5 rounded-full border border-violet-300/18 bg-violet-400/[0.06] px-3 py-1 text-left font-sans text-[length:calc(var(--chat-font-size)*10/14)] text-fg/70 transition-colors hover:border-violet-300/30 hover:text-fg/90"
          title="Open the spawned chat"
        >
          <span className="min-w-0 truncate">{summary || `"${event.childTitle}" finished`}</span>
          <span className="inline-flex shrink-0 items-center gap-0.5 text-violet-200/70">open<CaretRight size={10} weight="bold" aria-hidden /></span>
        </button>
      </div>
    );
  }

  /* ── Board move ──
     A board move is not a message the user typed, so it must not read as one.
     It is a state change the user made to the row, and the sentence ADE sent on
     their behalf is the consequence — so it renders as a divider (the same
     hairline-and-cutout language as every other "something happened here" rule)
     with the exact text the agent received folded underneath it, quiet and
     centred. Rendering it as a user bubble would put words in the user's mouth
     that they never wrote. */
  if (event.type === "user_message" && event.metadata?.boardMove) {
    const boardMove = event.metadata.boardMove;
    return (
      <div className="my-3 flex flex-col gap-1" data-board-move-to={boardMove.to}>
        <div className="flex items-center gap-2 font-sans text-[length:calc(var(--chat-font-size)*10.5/14)] text-fg/45">
          <span className="h-px flex-1 bg-fg/[0.08]" />
          <span className="shrink-0">
            Moved on the board · {WORK_BOARD_COLUMN_LABEL[boardMove.from]} → {WORK_BOARD_COLUMN_LABEL[boardMove.to]}
          </span>
          <span className="h-px flex-1 bg-fg/[0.08]" />
        </div>
        <p className="mx-auto max-w-[var(--chat-content-width,52rem)] text-center font-sans text-[length:calc(var(--chat-font-size)*10.5/14)] leading-relaxed text-fg/55">
          {event.displayText?.trim() || event.text}
        </p>
      </div>
    );
  }

  /* ── User message ── */
  if (event.type === "user_message") {
    const playSendEntrance = !animatedUserMessageKeys.has(envelope.key);
    if (playSendEntrance) animatedUserMessageKeys.add(envelope.key);
    return (
      <motion.div
        className="flex min-w-0 max-w-full w-full flex-col items-end overflow-visible"
        style={{ transformOrigin: "bottom right" }}
        initial={playSendEntrance ? { opacity: 0, y: 14 } : false}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
      >
        <div
          className={cn(
            GLASS_CARD_CLASS,
            "ade-chat-message-card-user group relative min-w-0 max-w-[82%] overflow-hidden px-[length:var(--chat-bubble-user-px)] py-[length:var(--chat-bubble-user-py)]",
          )}
          style={MESSAGE_CARD_STYLE}
          data-chat-user-message-card=""
        >
          <div className="absolute right-2 top-1.5 flex items-center gap-1 opacity-0 transition-opacity duration-200 group-hover:opacity-100 focus-within:opacity-100">
            <RowHoverTimestamp iso={envelope.timestamp} className="mr-0.5" />
            {event.messageId && options?.onRewindFiles ? (
              <button
                type="button"
                className="inline-flex h-5 w-5 items-center justify-center rounded text-white/45 transition-colors hover:bg-amber-300/12 hover:text-amber-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-300/45"
                title="Undo the file changes the agent made after this message. Conversation stays intact."
                aria-label="Undo file changes after this message"
                onClick={() => options.onRewindFiles?.({
                  messageId: event.messageId!,
                  timestamp: envelope.timestamp,
                  text: event.displayText?.trim() || event.text,
                })}
              >
                <span aria-hidden>↶</span>
              </button>
            ) : null}
            <MessageCopyButton value={event.metadata?.hideFullPrompt === true ? (event.displayText?.trim() ?? "") : event.text} />
          </div>
          {(() => {
            const displayText = event.displayText?.trim();
            if (event.metadata?.hideFullPrompt === true) {
              const metadataKind = typeof event.metadata?.kind === "string" ? event.metadata.kind : null;
              const isHandoffBrief = metadataKind === "handoff" || metadataKind === "cross_machine_handoff";
              const briefChip = isHandoffBrief ? (
                <div
                  className="mb-2 inline-flex items-center gap-1.5 rounded-md border border-[color:color-mix(in_srgb,var(--chat-accent)_26%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_12%,transparent)] px-2 py-1 font-sans text-[length:calc(var(--chat-font-size)*10.5/14)] leading-4 text-[color:color-mix(in_srgb,var(--chat-accent)_78%,var(--chat-fg,#e6e6e6))]"
                  data-testid="handoff-brief-chip"
                >
                  <CloudArrowUp size={12} weight="regular" className="shrink-0 opacity-85" aria-hidden />
                  Previous chat summarized into this chat&rsquo;s context
                </div>
              ) : null;
              if (!briefChip) {
                return displayText ? (
                  <ChipText className="whitespace-pre-wrap break-words text-[length:var(--chat-font-size)] font-medium leading-[1.7] text-white" text={displayText} />
                ) : null;
              }
              return (
                <div>
                  {briefChip}
                  {displayText ? (
                    <ChipText className="whitespace-pre-wrap break-words text-[length:var(--chat-font-size)] font-medium leading-[1.7] text-white" text={displayText} />
                  ) : null}
                </div>
              );
            }
            if (displayText && displayText !== event.text.trim()) {
              return (
                <div className="space-y-2 text-[length:var(--chat-font-size)] leading-[1.7] text-white">
                  <ChipText className="whitespace-pre-wrap break-words font-medium" text={displayText} />
                  <details className="group min-w-0">
                    <summary className="cursor-pointer font-sans text-[length:calc(var(--chat-font-size)*11/14)] font-medium text-white/70 transition-colors hover:text-white">
                      Full prompt
                    </summary>
                    <ChipText className="mt-2 whitespace-pre-wrap break-words text-white/90" text={event.text} />
                  </details>
                </div>
              );
            }
            const parsed = parseLeadingIosContextChips(event.text);
            const contextSegments = splitChatOutputContextSegments(parsed.rest);
            const hasOutputContext = contextSegments.some((segment) => segment.kind === "context");
            const body = !parsed.chips.length && !hasOutputContext ? (
              <ChipText className="whitespace-pre-wrap break-words text-[length:var(--chat-font-size)] leading-[1.7] text-white" text={event.text} />
            ) : (
              <div className="whitespace-pre-wrap break-words text-[length:var(--chat-font-size)] leading-[1.7] text-white">
                {parsed.chips.length ? (
                  <span className="mr-1 inline-flex flex-wrap items-baseline gap-1 align-baseline">
                    {parsed.chips.map((label, idx) => (
                      <span
                        key={`ios-chip-${idx}`}
                        className="mx-0.5 inline-flex max-w-[260px] translate-y-[1px] items-center gap-1.5 rounded-md border border-cyan-300/22 bg-cyan-500/12 px-2 py-0.5 font-sans text-[length:calc(var(--chat-font-size)*11/14)] leading-5 text-cyan-50/85 align-baseline"
                        title={label}
                        data-testid="user-message-ios-context-chip"
                      >
                        <span className="max-w-[200px] truncate">{label}</span>
                      </span>
                    ))}
                  </span>
                ) : null}
                {hasOutputContext
                  ? contextSegments.map((segment, idx) => (
                    segment.kind === "text"
                      ? <React.Fragment key={`chat-context-text-${idx}`}>{segment.text}</React.Fragment>
                      : <ChatOutputContextChip key={`chat-context-chip-${idx}`} quote={segment.quote} />
                  ))
                  : parsed.rest}
              </div>
            );
            // Prompts render in full, however long. The hidden-prompt brief and
            // the displayText + <details> variant keep their own disclosure.
            return body;
          })()}
          {event.attachments?.length || event.contextAttachments?.length ? (
            <UserMessageIssueContext
              attachments={event.attachments ?? []}
              contextAttachments={event.contextAttachments ?? []}
              mode={options?.surfaceMode ?? "standard"}
              sessionId={options?.sessionId}
            />
          ) : null}
          <UserMessageSendConfirmations event={event} />
        </div>
        <UserMessageStatusRow
          event={event}
          onRunUnprocessedMessage={options?.onRunUnprocessedMessage}
          onEditUnprocessedMessage={options?.onEditUnprocessedMessage}
          onDismissUnprocessedMessage={options?.onDismissUnprocessedMessage}
        />
      </motion.div>
    );
  }

  /* ── Agent text ── */
  if (event.type === "text") {
    return (
      <motion.div
        className="flex min-w-0 max-w-full w-full justify-start overflow-hidden"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.14, ease: "easeOut" }}
      >
        {/* Unbubbled assistant prose — plain markdown on the flat canvas (Codex/t3 reference). */}
        <div className="group relative min-w-0 max-w-full overflow-visible py-0.5 text-[length:var(--chat-font-size)] leading-[1.7]">
          <AssistantTextBody
            text={event.text}
            paced={options?.pacedTextReveal === true}
            onOpenWorkspacePath={options?.onOpenWorkspacePath}
            mosaic={options?.mosaic}
            mosaicScopeKey={envelope.key}
            // NOT the render key. A scene's still is filed on disk under this
            // and looked up again on every reopen, and the render key carries
            // the event's index in the events array — so prepending an older
            // page moved it, the lookup missed, and the scene ran again and
            // filed a second picture. Derived with the row, in
            // `chatTranscriptRows`, so there is one owner of that identity.
            sceneScopeKey={envelope.sceneScopeKey}
            // This row's OWN turn, not the session's. `sessionTurnActive` is
            // true for every row in the transcript while any turn runs, so a
            // scene drawn three turns ago came back to life — and re-executed
            // its script — the moment the user scrolled to it during a later
            // turn. `turnActive` is already scoped to the row's turn id.
            sceneLive={Boolean(options?.turnActive)}
          />
          {/* Hover actions sit in their own line under the prose, never on it:
              pinned over the text's top-right corner they covered the end of a
              short line (interim narration) and the first line of a long one. */}
          <div
            data-testid="assistant-text-hover-footer"
            className="mt-0.5 flex h-5 items-center gap-1 opacity-0 transition-opacity duration-200 group-hover:opacity-100 focus-within:opacity-100"
          >
            <RowHoverTimestamp iso={event.originTimestamp ?? envelope.timestamp} className="mr-0.5" />
            <MessageCopyButton value={event.text} />
            {options?.assistantTurnCopy ? (
              <MessageCopyButton
                value={options.assistantTurnCopy.text}
                label="Copy turn"
                title="Copy whole turn"
              />
            ) : null}
          </div>
        </div>
      </motion.div>
    );
  }

  /* ── Command ── */
  if (event.type === "command") {
    return <CommandEventCard event={event} />;
  }

  /* ── File change ── */
  if (event.type === "file_change") {
    return <FileChangeEventCard event={event} />;
  }

  /* ── Plan ── */
  if (event.type === "plan") {
    return (
      <CodexPlanCard
        event={event}
        onOpenInfo={() => openChatInfoFromActivity(options?.sessionId, null)}
      />
    );
  }

  /* ── Task list (the chat's one; see shared/chatTaskList.ts) ── */
  if (event.type === "task_list") {
    return <ChatTaskListCard list={event.list} sessionId={options?.sessionId} />;
  }

  /* ── Web Search ── */
  if (event.type === "web_search") {
    const isRunning = event.status === "running";
    const isFailed = event.status === "failed";
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.12, ease: "easeOut" }}
        className={cn(
          "group relative overflow-hidden rounded-xl border p-0",
          isFailed
            ? "border-red-500/12 bg-gradient-to-br from-red-950/20 to-red-950/5"
            : "border-cyan-500/10 bg-gradient-to-br from-cyan-950/25 via-[#0a0e14] to-[#0d0d10]",
        )}
      >
        {/* Subtle top accent line */}
        <div className={cn(
          "h-px w-full",
          isFailed ? "bg-gradient-to-r from-transparent via-red-500/30 to-transparent"
            : "bg-gradient-to-r from-transparent via-cyan-400/25 to-transparent",
        )} />
        <div className="flex items-start gap-3 px-4 py-3.5">
          <div className={cn(
            "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-xl",
            isFailed ? "bg-red-500/10" : "bg-cyan-500/10",
            isRunning && "ade-glow-pulse",
          )}>
            {isRunning ? (
              <ChatStatusGlyph status="working" size={15} />
            ) : isFailed ? (
              <XCircle size={15} weight="bold" className="text-red-400/80" />
            ) : (
              <Globe size={15} weight="bold" className="text-cyan-400/70" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className={cn(
                "font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-[0.18em]",
                isFailed ? "text-red-300/60" : "text-cyan-300/50",
              )}>
                Web Search
              </span>
              {event.action ? (
                <span className="font-mono text-[length:calc(var(--chat-font-size)*9/14)] text-fg/25">{event.action}</span>
              ) : null}
              {isRunning ? (
                <span className="font-mono text-[length:calc(var(--chat-font-size)*9/14)] text-cyan-400/40">searching...</span>
              ) : null}
            </div>
            <div className={cn(
              "mt-1.5 text-[length:calc(var(--chat-font-size)*13/14)] leading-relaxed",
              isFailed ? "text-red-200/70" : "text-fg/80",
            )}>
              <MagnifyingGlass size={12} weight="bold" className="mr-1.5 inline text-fg/30" />
              {event.query}
            </div>
            {event.results?.length ? (
              <WebSearchResultList results={event.results} resultsTotal={event.resultsTotal} isFailed={isFailed} />
            ) : event.actions?.length ? (
              <WebSearchActionList actions={event.actions} isFailed={isFailed} />
            ) : null}
          </div>
        </div>
      </motion.div>
    );
  }

  if (event.type === "codex_image_generation") {
    return <CodexImageGenerationCard event={event} />;
  }

  if (event.type === "codex_image_view") {
    return <CodexImageViewLine event={event} />;
  }

  /* ── Auto Approval Review (Guardian) ── */
  if (event.type === "auto_approval_review") {
    const isStarted = event.reviewStatus === "started";
    return (
      <div className="flex items-center gap-2.5 rounded-lg border border-indigo-500/10 bg-indigo-500/[0.04] px-3.5 py-2">
        {isStarted ? (
          <ChatStatusGlyph status="working" size={13} />
        ) : (
          <ShieldCheck size={13} weight="bold" className="text-indigo-400/60" />
        )}
        <span className="font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-[0.16em] text-indigo-300/55">
          {isStarted ? "Guardian reviewing" : "Guardian approved"}
        </span>
        {event.action ? (
          <span className="font-mono text-[length:calc(var(--chat-font-size)*9/14)] text-fg/30">{event.action}</span>
        ) : null}
        {event.review ? (
          <span className="flex-1 truncate text-[length:calc(var(--chat-font-size)*11/14)] text-fg/45">{event.review}</span>
        ) : null}
      </div>
    );
  }

  /* ── Turn details: the turn's diagnostics and recovery receipt, one row ── */
  if (event.type === "turn_details") {
    return <TurnDetailsDisclosure event={event} />;
  }

  /* ── Subagent cards: running (spawn) and settled (result), which is the
        same row converted in place. A lone card and a `subagent_card_grid`
        run render through the same grid, so a card joining a lone one keeps
        it mounted. ── */
  if (
    event.type === "subagent_spawn_anchor"
    || event.type === "subagent_result_card"
    || event.type === "subagent_card_grid"
    || event.type === "subagent_stopped_group"
  ) {
    return renderSubagentTimelineRow({ key: envelope.key, timestamp: envelope.timestamp, event }, {
      ...options,
      onOpenChatInfo: (taskId) => openChatInfoFromActivity(options?.sessionId, taskId),
    });
  }

  /* ── One CTO voice call, folded ── */
  if (event.type === "voice_call_group") {
    return <VoiceCallGroupCard event={event} options={options} />;
  }

  /* ── Background commands: one compact row per run of consecutive jobs
        (a lone job is a run of one), live from spawn through finish ── */
  if (event.type === "background_job_line" || event.type === "background_job_group") {
    return (
      <BackgroundJobRunRow
        members={event.type === "background_job_group"
          ? event.members
          : [{ key: envelope.key, timestamp: envelope.timestamp, event }]}
        sessionEnded={options?.sessionEnded}
        // Same channel the subagent card uses: the pane listens for
        // `ade:chat:open-info` and opens the agents tab, where background jobs
        // live. A null taskId opens the tab without selecting one. Omitted on a
        // host with no actions pane, so `open` never does nothing.
        onOpenJob={options?.chatInfoHostAvailable
          ? (taskId) => openChatInfoFromActivity(options?.sessionId, taskId)
          : undefined}
        onStop={options?.onStopSubagent ? (id) => options.onStopSubagent?.(id) : undefined}
      />
    );
  }

  /* ── Structured Question ── */
  if (event.type === "structured_question") {
    return (
      <div className={cn(GLASS_CARD_CLASS, "p-4")} style={MESSAGE_CARD_STYLE}>
        <div className="mb-2 flex items-center gap-2">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-[var(--chat-radius-pill)] border border-[var(--chat-accent-faint)] bg-[var(--chat-accent-faint)]">
            <ChatCircleText size={13} weight="bold" className="text-[var(--chat-accent)]" />
          </span>
          <span className="font-mono text-[length:calc(var(--chat-font-size)*11/14)] font-bold uppercase tracking-widest text-[var(--chat-accent)]">Agent Question</span>
        </div>
        <div className="rounded-[max(0px,calc(var(--chat-radius-card)-6px))] border border-[color:color-mix(in_srgb,var(--chat-accent)_18%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_8%,transparent)] px-4 py-3 text-[length:calc(var(--chat-font-size)*12.5/14)] leading-[1.65] text-fg/85">
          {event.question}
        </div>
        {event.options?.length ? (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {event.options.map((option) => (
              <button
                key={option.value}
                type="button"
                className="border border-accent/40 bg-transparent px-3 py-1.5 font-mono text-[length:calc(var(--chat-font-size)*10/14)] font-bold uppercase tracking-wider text-fg/70 transition-colors hover:bg-accent/15"
                onClick={() => options?.onApproval?.(event.itemId, "accept", option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : null}
        <div className="mt-2 font-mono text-[length:calc(var(--chat-font-size)*9/14)] text-muted-fg/35">or type a custom answer</div>
      </div>
    );
  }

  /* ── Tool Use Summary ── */
  if (event.type === "tool_use_summary") {
    const summaryText = event.summary;
    const toolCount = event.toolUseIds.length;
    return (
      <InlineDisclosureRow
        defaultOpen={summaryText.length <= 120}
        summary={
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[length:calc(var(--chat-font-size)*11/14)] text-fg/52">
            <span className="inline-flex h-1.5 w-1.5 rounded-full bg-white/30" />
            <Info size={11} weight="regular" className="text-fg/34" />
            <span className="font-medium text-fg/62">Tool summary</span>
            <span className="text-[length:calc(var(--chat-font-size)*10/14)] text-fg/35">{toolCount} tool{toolCount === 1 ? "" : "s"}</span>
            <span className="flex-1 truncate text-[length:calc(var(--chat-font-size)*10/14)] text-fg/45">{summarizeInlineText(summaryText, 100)}</span>
          </div>
        }
      >
        <div className="text-[length:calc(var(--chat-font-size)*12/14)] leading-relaxed text-fg/65">{summaryText}</div>
      </InlineDisclosureRow>
    );
  }

  /* ── Context Compaction ── */
  if (event.type === "codex_context_compaction" || event.type === "context_compact") {
    const compactEvent = event.type === "context_compact"
      ? event
      : {
          type: "context_compact" as const,
          trigger: event.trigger,
          state: event.state,
          turnId: event.turnId,
          compactionId: event.compactionId ?? event.turnId,
        };
    return <ContextCompactDivider event={compactEvent} />;
  }

  if (event.type === "codex_safety_buffering") {
    const reasons = event.state.reasons?.filter(Boolean) ?? [];
    return (
      <div className="inline-flex max-w-[var(--chat-content-width,52rem)] items-center gap-2 rounded-lg border border-sky-300/14 bg-sky-500/[0.05] px-2.5 py-1.5 font-sans text-[length:calc(var(--chat-font-size)*10.5/14)] text-sky-100/78">
        <ShieldCheck size={12} weight="duotone" className="shrink-0 text-sky-200/70" />
        <span className="shrink-0 font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-[0.16em] text-sky-200/55">safety</span>
        <span className="min-w-0 truncate">
          {event.state.fasterModel ? `Buffering, ${event.state.fasterModel} ready` : "Buffering"}
        </span>
        {reasons.length ? (
          <span className="min-w-0 truncate text-sky-100/45">{reasons[0]}</span>
        ) : null}
      </div>
    );
  }

  if (event.type === "codex_sleep") {
    const duration = formatCompactDuration(event.durationMs);
    const isRunning = event.status === "running";
    return (
      <div className="inline-flex max-w-[var(--chat-content-width,52rem)] items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.035] px-2.5 py-1.5 font-sans text-[length:calc(var(--chat-font-size)*10.5/14)] text-fg/64">
        {isRunning ? <ChatStatusGlyph status="working" size={12} /> : <Circle size={10} weight="fill" className="shrink-0 text-fg/32" />}
        <span className="shrink-0 font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-[0.16em] text-fg/38">wait</span>
        <span className="min-w-0 truncate">{duration ? `Sleeping ${duration}` : "Sleeping"}</span>
      </div>
    );
  }

  if (event.type === "codex_thread_deleted") {
    return (
      <div className="inline-flex max-w-[var(--chat-content-width,52rem)] items-center gap-2 rounded-lg border border-amber-300/16 bg-amber-500/[0.055] px-2.5 py-1.5 font-sans text-[length:calc(var(--chat-font-size)*10.5/14)] text-amber-100/78">
        <Warning size={12} weight="duotone" className="shrink-0 text-amber-200/75" />
        <span className="shrink-0 font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-[0.16em] text-amber-200/55">thread</span>
        <span className="min-w-0 truncate">Deleted upstream. Next message starts fresh.</span>
      </div>
    );
  }

  if (event.type === "codex_turn_stalled") {
    return (
      <CodexTurnRecoveryCard
        event={event}
        sessionId={options?.sessionId}
        onRecover={options?.onCodexRecovery}
      />
    );
  }

  /* ── Context Usage ── */
  if (event.type === "context_usage") {
    // Automatic "live" snapshots are filtered out of the row list upstream (see
    // isAutomaticContextUsageEvent); only user-requested `/context` reaches here.
    const usage = event.usage;
    const totalLabel = formatContextK(usage.totalTokens);
    const maxLabel = formatContextK(usage.maxTokens);
    const percent = Math.max(0, Math.min(100, usage.percentage));
    const categories = usage.categories.length ? usage.categories : [];
    const modelLabel = usage.model?.trim() || null;
    return (
      <div
        data-testid="claude-context-card"
        className="w-fit max-w-[var(--chat-content-width,52rem)] rounded-lg border border-cyan-300/14 bg-cyan-500/[0.035] px-3.5 py-3 font-sans text-[length:calc(var(--chat-font-size)*11/14)] text-cyan-50/78"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Brain size={13} weight="regular" className="text-cyan-200/70" />
          <span className="font-medium text-cyan-50/90">
            {`Context${modelLabel ? ` · ${modelLabel}` : ""} · ${totalLabel}/${maxLabel} (${percent.toFixed(0)}%)`}
          </span>
        </div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-black/25">
          <div className="h-full rounded-full bg-cyan-300/65" style={{ width: `${percent}%` }} />
        </div>
        <div className="mt-3 space-y-1.5">
          {categories.map((category) => {
            const kind = isClaudeContextCategoryKind(category.kind) ? category.kind : "used";
            const servers = category.mcpServers ?? [];
            return (
              <div key={`${category.name}:${category.tokens}:${kind}`} className="space-y-0.5">
                <div className="grid grid-cols-[minmax(8rem,1fr)_auto_4.5rem] items-center gap-3">
                  <span className="truncate text-cyan-50/74" title={category.name}>{category.name}</span>
                  <span className="font-mono text-cyan-100/50">{formatContextK(category.tokens)}</span>
                  <span className="text-right font-mono text-cyan-100/42">{kind}</span>
                </div>
                {servers.length ? (
                  <div className="pl-3 font-mono text-[length:calc(var(--chat-font-size)*10/14)] text-cyan-100/42">
                    {servers.map((server) => `${server.name} ${formatContextK(server.tokens)}`).join(" · ")}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  /* ── Codex Goal ── */
  if (event.type === "codex_goal_updated" || event.type === "codex_goal_cleared") {
    const goal = event.type === "codex_goal_updated" ? event.goal : null;
    const updateKind = event.type === "codex_goal_updated" ? event.updateKind : undefined;
    const objective = goal?.objective?.trim() ?? "";
    const status = goal?.status === "budget_limited"
      ? "active"
      : goal?.status && goal.status !== "unknown"
        ? goal.status
        : "active";
    const action = status === "active"
      ? (updateKind === "status" ? "Goal resumed" : "Goal set")
      : status === "complete"
        ? "Goal complete"
        : status === "usage_limited"
          ? "Goal paused by usage limits"
          : status === "cancelled"
            ? "Goal cancelled"
            : `Goal ${status.replace("_", " ")}`;
    const message = event.type === "codex_goal_cleared"
      ? "Goal cleared"
      : objective
        ? `${action}: ${objective}`
        : action;
    return (
      <div className="inline-flex max-w-[var(--chat-content-width,52rem)] items-center gap-2 rounded-lg border border-amber-400/16 bg-amber-500/[0.055] px-2.5 py-1.5 font-sans text-[length:calc(var(--chat-font-size)*10.5/14)] text-amber-100/78">
        <Target size={11} weight="duotone" className="shrink-0 text-amber-300/80" />
        <span className="shrink-0 text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-[0.16em] text-amber-200/55">goal</span>
        <span className="min-w-0 truncate">{message}</span>
      </div>
    );
  }

  /* ── Claude Goal (read-only /goal loop pills) ── */
  if (event.type === "claude_goal_updated" || event.type === "claude_goal_cleared") {
    const message = event.type === "claude_goal_cleared"
      ? "Goal met"
      : event.goal.iterations > 1
        ? (event.goal.lastReason?.trim()
            ? `Goal check ${event.goal.iterations}: ${event.goal.lastReason.trim()}`
            : `Goal check ${event.goal.iterations}`)
        : `Goal set: ${event.goal.condition.trim()}`;
    return (
      <div className="inline-flex max-w-[var(--chat-content-width,52rem)] items-center gap-2 rounded-lg border border-amber-400/16 bg-amber-500/[0.055] px-2.5 py-1.5 font-sans text-[length:calc(var(--chat-font-size)*10.5/14)] text-amber-100/78">
        <Target size={11} weight="duotone" className="shrink-0 text-amber-300/80" />
        <span className="shrink-0 text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-[0.16em] text-amber-200/55">goal</span>
        <span className="min-w-0 truncate">{message}</span>
      </div>
    );
  }

  /* ── Stop receipt (interrupt) ── */
  if (event.type === "interrupt_receipt") {
    const known = event.known ?? [];
    const stillQueued = event.stillQueuedUuids ?? [];
    // Count-only when we can't attribute any queued message to a user-visible one.
    const totalCount = stillQueued.length;
    const onCancel = options?.onCancelQueuedMessage;
    return (
      <div className="inline-flex max-w-[var(--chat-content-width,52rem)] flex-col gap-1 rounded-lg border border-amber-400/16 bg-amber-500/[0.05] px-2.5 py-2 font-sans text-[length:calc(var(--chat-font-size)*10.5/14)] text-amber-100/80">
        <div className="flex items-center gap-2">
          <Warning size={11} weight="bold" className="shrink-0 text-amber-300/80" aria-hidden />
          <span className="min-w-0">
            Stopped — {totalCount} queued message{totalCount === 1 ? "" : "s"} will still run
          </span>
        </div>
        {known.length > 0 ? (
          <ul className="flex flex-col gap-0.5 pl-[19px]">
            {known.map((item) => (
              <li key={item.uuid} className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-amber-100/60">{item.preview}</span>
                {onCancel && item.steerId ? (
                  <button
                    type="button"
                    onClick={() => onCancel(item.steerId!)}
                    className="shrink-0 font-sans text-[length:calc(var(--chat-font-size)*9.5/14)] text-amber-200/60 underline-offset-2 transition-colors hover:text-amber-100 hover:underline"
                  >
                    Cancel
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }

  if (event.type === "queue_recovery") {
    return (
      <QueueRecoveryCard
        recoveryId={event.recoveryId}
        messageCount={event.messageCount}
        expiresAt={event.expiresAt}
        settled={options?.settledQueueRecoveryIds?.has(event.recoveryId) ?? false}
        onRestore={options?.onRestoreCancelledQueue}
      />
    );
  }

  if (event.type === "command_lifecycle") {
    const label = event.status === "discarded" ? "Queued message discarded" : "Queued message cancelled";
    return (
      <div className="inline-flex max-w-[var(--chat-content-width,52rem)] items-center gap-2 rounded-lg border border-border/15 bg-surface-raised/20 px-2.5 py-1.5 font-sans text-[length:calc(var(--chat-font-size)*10.5/14)] text-fg/55">
        <Warning size={11} weight="bold" className="shrink-0 text-fg/40" aria-hidden />
        <span className="min-w-0 truncate">{event.preview ? `${label}: ${event.preview}` : label}</span>
      </div>
    );
  }

  /* ── System Notice ── */
  if (event.type === "system_notice") {
    if (event.status === "model_switched") {
      const message = event.message.trim() || "switched models";
      return (
        <div
          className="my-3 flex items-center gap-2 font-sans text-fg/45"
          data-testid="model-switched-divider"
          aria-label={message}
        >
          <span className="h-px flex-1 bg-fg/[0.08]" />
          <span className="shrink-0 px-1 text-[length:calc(var(--chat-font-size)*10.5/14)]">
            {message}
          </span>
          <span className="h-px flex-1 bg-fg/[0.08]" />
        </div>
      );
    }
    // Spawn notices. The "spawned" announcement is now carried by the unified,
    // navigable spawn-anchor card (SubagentSpawnCard) — do NOT render a second
    // quiet pill here. A `peer` child that finishes emits a `spawn_completed`
    // notice; render a single quiet steel chip that navigates to the child.
    if (event.noticeKind === "info" && event.status === "subagent_spawned") {
      const detail = (event.detail && typeof event.detail === "object" ? event.detail : {}) as {
        spawnKind?: "subagent" | "peer";
        spawnedSession?: { sessionId?: string; laneId?: string | null; title?: string };
      };
      const spawned = detail.spawnedSession;
      const childSessionId = typeof spawned?.sessionId === "string" && spawned.sessionId.length ? spawned.sessionId : null;
      const childTitle = spawned?.title?.trim() || event.message.replace(/^Subagent spawned:\s*/, "") || "chat";
      const isPeer = detail.spawnKind === "peer";
      return (
        <button
          type="button"
          disabled={!childSessionId}
          onClick={() => navigateToSpawnedChat(childSessionId, spawned?.laneId ?? options?.laneId ?? null)}
          className={cn(
            "inline-flex max-w-full items-center gap-2 rounded-full border px-3 py-1 text-left font-sans text-[length:calc(var(--chat-font-size)*10/14)] transition-colors",
            isPeer
              ? "border-slate-400/16 bg-slate-400/[0.05] text-slate-300/70 enabled:hover:border-slate-300/28 enabled:hover:text-slate-100/90"
              : "border-violet-300/16 bg-violet-400/[0.05] text-violet-200/75 enabled:hover:border-violet-300/30 enabled:hover:text-violet-100/90",
          )}
          title={childSessionId ? "Open the spawned chat" : undefined}
        >
          <Robot size={11} weight="duotone" className={cn("shrink-0", isPeer ? "text-slate-300/60" : "text-violet-300/70")} aria-hidden />
          <span className={cn("shrink-0 font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-[0.16em]", isPeer ? "text-slate-300/50" : "text-violet-300/55")}>
            {isPeer ? "peer" : "subagent"}
          </span>
          <span className="min-w-0 truncate">{childTitle}</span>
          {childSessionId ? <CaretRight size={10} className={cn("shrink-0", isPeer ? "text-slate-300/55" : "text-violet-300/55")} /> : null}
        </button>
      );
    }
    if (event.noticeKind === "info" && event.status === "spawn_takeover") {
      const takeover = event.detail && typeof event.detail === "object" ? event.detail.spawnTakeover : undefined;
      const childTitle = takeover?.childTitle?.trim() || "chat";
      const childSessionId = typeof takeover?.childSessionId === "string" && takeover.childSessionId.length
        ? takeover.childSessionId
        : null;
      return (
        <button
          type="button"
          disabled={!childSessionId}
          onClick={() => navigateToSpawnedChat(childSessionId, options?.laneId ?? null)}
          className="inline-flex max-w-full items-center gap-2 rounded-full border border-slate-400/16 bg-slate-400/[0.05] px-3 py-1 text-left font-sans text-[length:calc(var(--chat-font-size)*10/14)] text-slate-300/70 transition-colors enabled:hover:border-slate-300/28 enabled:hover:text-slate-100/90"
          title={childSessionId ? "Open the chat the user took over" : undefined}
        >
          <span aria-hidden className="shrink-0 text-slate-300/60">◦</span>
          <span className="min-w-0 truncate">The user took over "{childTitle}" — reports stop here.</span>
          {childSessionId ? <CaretRight size={10} className="shrink-0 text-slate-300/55" /> : null}
        </button>
      );
    }
    if (event.noticeKind === "info" && event.status === "spawn_parent_gone") {
      return (
        <div
          className="inline-flex max-w-full items-center gap-2 rounded-full border border-slate-400/16 bg-slate-400/[0.05] px-3 py-1 font-sans text-[length:calc(var(--chat-font-size)*10/14)] text-slate-300/70"
        >
          <span aria-hidden className="shrink-0 text-slate-300/60">◦</span>
          <span className="min-w-0">{spawnParentGoneNoticeMessage()}</span>
        </div>
      );
    }
    if (event.noticeKind === "info" && event.status === "spawn_completed") {
      const completion: AgentChatSpawnCompletion | undefined =
        event.detail && typeof event.detail === "object" ? event.detail.spawnCompletion : undefined;
      // Fallback title parse for a notice whose detail lost its completion —
      // which happens to notices in EITHER wording, so both are handled here:
      // the current `spawnCompletedNoticeMessage` sentence, and the pre-rename
      // `Peer "<title>" turn finished` that persisted transcripts still hold
      // and are never re-emitted.
      //
      // One anchored match with a capture group rather than subtracting the
      // two ends with a /g replace: a message that is not a completion notice
      // at all now fails to match and falls through to "Chat", instead of
      // being handed back mangled.
      const parsedChildTitle = SPAWN_COMPLETED_TITLE_PATTERN.exec(event.message)?.[1]?.trim();
      const childTitle = completion?.childTitle?.trim() || parsedChildTitle || "Chat";
      const childSessionId = typeof completion?.childSessionId === "string" && completion.childSessionId.length
        ? completion.childSessionId
        : null;
      const repeatCountRaw = envelope.repeatCount;
      const repeatCount = typeof repeatCountRaw === "number" && Number.isFinite(repeatCountRaw) && repeatCountRaw > 1
        ? Math.floor(repeatCountRaw)
        : null;
      return (
        <button
          type="button"
          disabled={!childSessionId}
          onClick={() => navigateToSpawnedChat(childSessionId, options?.laneId ?? null)}
          className="inline-flex max-w-full items-center gap-2 rounded-full border border-slate-400/16 bg-slate-400/[0.05] px-3 py-1 text-left font-sans text-[length:calc(var(--chat-font-size)*10/14)] text-slate-300/70 transition-colors enabled:hover:border-slate-300/28 enabled:hover:text-slate-100/90"
          title={childSessionId ? "Open the chat" : undefined}
        >
          <span aria-hidden className="shrink-0 text-slate-300/60">◦</span>
          <span className="min-w-0 truncate">{spawnCompletedNoticeMessage(childTitle)}</span>
          {repeatCount ? (
            <span className="shrink-0 tabular-nums text-slate-300/45">×{repeatCount}</span>
          ) : null}
          {childSessionId ? <CaretRight size={10} className="shrink-0 text-slate-300/55" /> : null}
        </button>
      );
    }
    // ── Host sleep ──
    // One quiet chip per sleep. The transcript fold hands the SAME row first
    // the paused event and then the resumed one, so this renders whichever
    // half is current — the row never doubles and never grows.
    if (isHostSleepNoticeEvent(event)) {
      const resumed = isHostResumedNoticeEvent(event);
      const SleepIcon = resumed ? Play : Moon;
      return (
        <div
          className={cn(
            "inline-flex max-w-[var(--chat-content-width,52rem)] items-center gap-2 rounded-full border px-3 py-1 font-sans text-[length:calc(var(--chat-font-size)*10/14)] transition-colors",
            resumed
              ? "border-emerald-400/16 bg-emerald-400/[0.05] text-emerald-200/70"
              : "border-sky-400/16 bg-sky-400/[0.05] text-sky-200/70",
          )}
        >
          <SleepIcon
            size={11}
            weight={resumed ? "fill" : "duotone"}
            className={cn("shrink-0", resumed ? "text-emerald-300/70" : "text-sky-300/70")}
            aria-hidden
          />
          <span className="min-w-0 truncate">{event.message}</span>
        </div>
      );
    }
    // A chat whose provider thread couldn't be resumed after a disk-full incident
    // carries a persisted continuity-recovery detail — render the dedicated card
    // (retry / recover-from-history / start-new) instead of a plain notice chip.
    if (
      event.detail
      && typeof event.detail === "object"
      && event.detail.kind === "continuity_recovery"
    ) {
      return (
        <ChatContinuityRecoveryCard
          detail={event.detail}
          sessionId={options?.sessionId ?? null}
          turnActive={Boolean(options?.sessionTurnActive)}
          onRecoverContinuity={options?.onRecoverContinuity}
        />
      );
    }

    const inferredSeverity = event.severity
      ?? (
        event.noticeKind === "rate_limit"
          || event.noticeKind === "error"
          || event.noticeKind === "thread_error"
          || event.noticeKind === "provider_health"
          ? "error" as const
          : undefined
      )
      ?? (event.noticeKind === "warning" ? "warning" as const : "info" as const);
    const kindStyles: Record<string, { border: string; bg: string; text: string; icon: typeof Warning }> = {
      auth: { border: "border-amber-500/18", bg: "bg-amber-500/[0.06]", text: "text-amber-300", icon: Warning },
      rate_limit: { border: "border-red-500/18", bg: "bg-red-500/[0.06]", text: "text-red-300", icon: Warning },
      hook: { border: "border-violet-500/18", bg: "bg-violet-500/[0.06]", text: "text-violet-300", icon: Note },
      file_persist: { border: "border-emerald-500/18", bg: "bg-emerald-500/[0.06]", text: "text-emerald-300", icon: Note },
      info: { border: "border-border/14", bg: "bg-surface-recessed/70", text: "text-muted-fg/55", icon: Note },
      warning: { border: "border-amber-500/18", bg: "bg-amber-500/[0.06]", text: "text-amber-300", icon: Warning },
      error: { border: "border-red-500/18", bg: "bg-red-500/[0.06]", text: "text-red-300", icon: Warning },
      config: { border: "border-border/14", bg: "bg-surface-recessed/70", text: "text-muted-fg/55", icon: Note },
    };
    const styleKey = event.noticeKind === "rate_limit" && inferredSeverity !== "error"
      ? inferredSeverity
      : event.noticeKind;
    const style = kindStyles[styleKey] ?? kindStyles.info!;
    const NoticeIcon = style.icon;
    const hasDetail = hasNoticeDetail(event.detail);
    const chipLabel = event.noticeKind === "rate_limit" && inferredSeverity !== "error"
      ? "usage"
      : event.noticeKind.replace("_", " ");

    // "A reset credit is banked" is the one usage notice with something to DO.
    // A notice that reports a spendable credit and offers no way to spend it is
    // the state this row exists to remove, so the action lives on the notice
    // itself rather than only in the usage popup three clicks away.
    if (event.status === "reset_credit_available") {
      const detail = typeof event.detail === "object" && event.detail && !Array.isArray(event.detail)
        ? event.detail
        : null;
      return (
        <ResetCreditNoticeRow
          message={event.message}
          accountId={typeof detail?.accountId === "string" ? detail.accountId : null}
          className={cn(style.border, style.bg, style.text)}
          icon={<NoticeIcon size={11} weight="bold" />}
          chipLabel={chipLabel}
        />
      );
    }

    // Warnings are one text-sized line, like the thread's other rows; the full
    // message and any detail open on click. Usage and sign-in keep their own
    // treatment, and errors keep their cards.
    if (inferredSeverity === "warning" && event.noticeKind !== "rate_limit" && event.noticeKind !== "auth") {
      return <CompactWarningNoticeRow message={event.message} detail={hasDetail ? event.detail : undefined} />;
    }

    if (hasDetail && event.noticeKind === "rate_limit" && inferredSeverity !== "error") {
      const detail = typeof event.detail === "string"
        ? event.detail
        : typeof event.detail === "object" && event.detail && "summary" in event.detail && typeof event.detail.summary === "string"
          ? event.detail.summary
          : null;
      return (
        <div className={cn(
          "inline-flex max-w-[var(--chat-content-width,52rem)] flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-2.5 py-1.5 font-sans text-[length:calc(var(--chat-font-size)*10/14)]",
          style.border,
          style.bg,
          style.text,
        )}>
          <NoticeIcon size={11} weight="bold" />
          <span className="text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-[0.16em]">{chipLabel}</span>
          <span className="normal-case tracking-normal text-fg/55">{event.message}</span>
          {detail ? <span className="font-mono text-[length:calc(var(--chat-font-size)*9/14)] text-fg/42">{detail}</span> : null}
        </div>
      );
    }

    if (hasDetail) {
      return (
        <CollapsibleCard
          defaultOpen={false}
          summary={
            <div className="flex items-center gap-2 font-sans text-[length:calc(var(--chat-font-size)*11/14)]">
              <NoticeIcon size={12} weight="bold" className={style.text} />
              <span className={cn("inline-flex items-center border px-1.5 py-0.5 text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-[0.16em]", style.border, style.bg, style.text)}>
                {chipLabel}
              </span>
              <span className="flex-1 truncate text-[length:calc(var(--chat-font-size)*10/14)] text-fg/55">{event.message}</span>
            </div>
          }
          className={style.border}
        >
          {event.detail ? renderNoticeDetail(event.detail) : null}
        </CollapsibleCard>
      );
    }

    return (
      <div className={cn(
        "inline-flex items-center gap-2 px-1 py-1 font-sans text-[length:calc(var(--chat-font-size)*10/14)]",
        style.text,
      )}>
        <NoticeIcon size={11} weight="bold" />
        <span className="text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-[0.16em]">{chipLabel}</span>
        <span className="normal-case tracking-normal text-fg/45">{event.message}</span>
      </div>
    );
  }

  /* ── Reasoning ── */
  if (event.type === "reasoning") {
    // Live preview only on the newest, still-streaming thought of a live turn
    // (`liveThinking`, derived once per rows identity by the list).
    const livePreview = options?.liveThinking === true && !options?.sessionEnded;
    const timing = event as RenderReasoningEvent;
    const liveStartedAt = Date.parse(timing.latestStartTimestamp ?? timing.startTimestamp ?? envelope.timestamp);
    const thinkingLabel = options?.assistantLabel?.trim();
    return (
      <motion.div
        className={cn(livePreview ? "w-full" : "w-fit", "max-w-[var(--chat-content-width,52rem)]")}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.12, ease: "easeOut" }}
      >
        <MinimalThought
          text={event.text}
          livePreview={livePreview}
          label={thinkingLabel && thinkingLabel !== "Assistant" ? thinkingLabel : null}
          startedAtMs={Number.isFinite(liveStartedAt) ? liveStartedAt : null}
          durationSeconds={timing.thoughtMemberKeys
            // A merged Thought run: the members' durations summed, or none.
            ? timing.thoughtRunDurationSeconds ?? null
            : timing.latestStartTimestamp
              ? null
              : thoughtDurationSeconds(timing.startTimestamp, envelope.timestamp)}
        />
      </motion.div>
    );
  }


  if (event.type === "tool_call") {
    const meta = getToolMeta(event.tool);
    const ToolIcon = meta.icon;
    const toolDisplay = describeToolIdentifier(event.tool);
    const args = event.args as Record<string, unknown> | null;
    const safeArgs = args && typeof args === "object" ? args : {};

    const targetLine = meta.getTarget ? meta.getTarget(safeArgs) : null;
    const label = targetLine
      ? `${meta.label} ${targetLine}`
      : toolDisplay.secondaryLabel
        ? `${meta.label} ${toolDisplay.secondaryLabel}`
        : meta.label;

    // Build expandable args display
    const kvPairs = Object.entries(safeArgs);
    const argsDisplay = kvPairs.length > 0 ? (
      <div className="space-y-1 border border-border/10 bg-surface-recessed/90 px-4 py-2.5 font-mono text-[length:calc(var(--chat-font-size)*11/14)]">
        {kvPairs.map(([k, v]) => {
          const val = typeof v === "string" ? v : JSON.stringify(v);
          const isLongStr = typeof v === "string" && v.includes("\n");
          return (
            <div key={k} className={isLongStr ? "flex flex-col gap-0.5" : "flex items-start gap-2"}>
              <span className="flex-shrink-0 text-muted-fg/40">{k}</span>
              {isLongStr ? (
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-[length:calc(var(--chat-font-size)*10/14)] text-fg/55 leading-[1.5]">{val}</pre>
              ) : (
                <span className="min-w-0 break-all text-fg/65">{val}</span>
              )}
            </div>
          );
        })}
      </div>
    ) : (
      <div className="border border-border/10 bg-surface-recessed/90 px-4 py-2 font-mono text-[length:calc(var(--chat-font-size)*10/14)] text-muted-fg/40">
        No arguments
      </div>
    );

    return (
      <CollapsibleCard
        defaultOpen={false}
        summary={
          <div className="flex items-center gap-2 font-mono text-[length:calc(var(--chat-font-size)*12/14)] text-fg/50">
            <CaretRight size={10} weight="bold" className="text-fg/30" />
            <ToolIcon size={13} weight="regular" className="text-fg/40" />
            <span className="truncate">{label}</span>
          </div>
        }
        className={WORK_LOG_CARD_CLASS}
      >
        {argsDisplay}
      </CollapsibleCard>
    );
  }

  /* ── Tool result ── */
  if (event.type === "tool_result") {
    return <ToolResultCard event={event} />;
  }

  /* ── Approval request ── */
  if (event.type === "approval_request") {
    const isResponding = options?.respondingApprovalIds?.has(event.itemId) ?? false;
    const isPending = options?.pendingApprovalIds?.has(event.itemId) ?? true;
    const resolvedState = options?.resolvedInputStates?.get(event.itemId) ?? null;
    const isResolved = resolvedState != null || (!isPending && !isResponding);
    const detail = readRecord(event.detail);
    const request = readRecord(detail?.request);
    const requestKind = typeof request?.kind === "string" ? request.kind.trim() : "";
    const requestDescription = typeof request?.description === "string" ? request.description.trim() : "";
    // Source of truth: reuse the canonical parser so questions, options, preview, recommended,
    // defaultAssumption, impact, and multiSelect all survive the render path. Falls back to the
    // legacy flat-detail shape when the modern PendingInputRequest envelope isn't present.
    const pendingRequest = readPendingInputRequest(detail?.request)
      ?? buildLegacyPendingInputFromApprovalEvent({ event });
    const requestSource = typeof pendingRequest?.source === "string"
      ? pendingRequest.source
      : typeof request?.source === "string" ? request.source.trim() : "";
    const primaryQuestion = pendingRequest?.questions?.[0] ?? null;
    const primaryQuestionText = primaryQuestion?.question ?? "";
    const detailTool = typeof detail?.tool === "string" ? detail.tool.trim() : "";
    const question = typeof detail?.question === "string" ? detail.question.trim() : "";
    const normalizedTool = detailTool.toLowerCase();
    const isQuestionRequest = isQuestionKind(requestKind);
    const isPermissionRequest = requestKind === "permissions";
    const isPlanApproval = requestKind === "plan_approval";
    const isAskUser = ((normalizedTool === "askuser" || normalizedTool === "ask_user") && question.length > 0) || isQuestionRequest;
    let bodyText: string;
    if (isQuestionRequest) {
      bodyText = requestDescription || primaryQuestionText || question || event.description;
    } else if (isAskUser) {
      bodyText = question;
    } else if (isPlanApproval) {
      bodyText = requestDescription || primaryQuestionText || event.description;
    } else {
      bodyText = event.description;
    }
    /* Generic approvals stay compact; ask-user requests render as inline chat controls. */
    const resolvedLabel = (() => {
      if (resolvedState !== "accepted" && resolvedState !== "declined") return "Closed";
      if (isPlanApproval) return resolvedState === "accepted" ? "Plan Approved" : "Plan Rejected";
      if (isAskUser) return resolvedState === "accepted" ? "Answered" : "Declined";
      return resolvedState === "accepted" ? "Accepted" : "Declined";
    })();

    /* A question's controls live in the composer now, not here. The transcript
       keeps only the record: a one-line receipt of what was sent once it
       resolves, and a one-line "awaiting you" row while it is still open (which
       is also where a *queued* second question waits until it becomes the
       composer's primary gate). */
    if (isAskUser && pendingRequest && pendingRequest.questions.length > 0) {
      if (!isResolved) {
        return (
          <OpenQuestionReceipt
            request={pendingRequest}
            headerLabel={pendingInputHeaderLabel(requestSource || "agent", pendingRequest.kind)}
          />
        );
      }
      return (
        <AnsweredQuestionReceipt
          request={pendingRequest}
          resolution={resolvedState ?? "cancelled"}
          answers={options?.resolvedInputAnswers?.get(event.itemId)}
          headerLabel={pendingInputHeaderLabel(requestSource || "agent", pendingRequest.kind)}
        />
      );
    }

    return (
      <div className={cn(GLASS_CARD_CLASS, "px-4 py-2.5")} style={SURFACE_INLINE_CARD_STYLE}>
        <div className="flex items-center gap-2">
          {requestSource ? (
            <span className={cn("inline-flex h-5 w-5 items-center justify-center rounded-[var(--chat-radius-pill)] border border-[color:color-mix(in_srgb,var(--chat-accent)_22%,transparent)] bg-black/20")}>
              <ProviderLogo family={requestSource} size={11} />
            </span>
          ) : null}
          {isResolved ? (
            <span
              className={cn(
                "inline-flex items-center gap-1.5 font-mono text-[length:calc(var(--chat-font-size)*10/14)] font-bold uppercase tracking-wider",
                approvalToneClass(resolvedState),
              )}
            >
              {resolvedState === "accepted" ? (
                <Check size={12} weight="bold" />
              ) : resolvedState === "declined" ? (
                <XCircle size={12} weight="bold" />
              ) : (
                <Circle size={12} weight="bold" />
              )}
              {resolvedLabel}
            </span>
          ) : (
            <>
              <ChatStatusGlyph status="waiting" size={11} />
              <span className="font-mono text-[length:calc(var(--chat-font-size)*10/14)] uppercase tracking-wider text-fg/50">
                {approvalWaitingLabel({ isPlanApproval, isAskUser, isPermissionRequest })}
              </span>
            </>
          )}
        </div>
        {isPlanApproval && bodyText.trim().length > 0 ? (
          <div className="mt-2 rounded-lg border border-white/[0.06] bg-black/15 px-3 py-2">
            <MarkdownBlock markdown={bodyText} onOpenWorkspacePath={options?.onOpenWorkspacePath} />
          </div>
        ) : null}
      </div>
    );
  }

  /* ── Error ── */
  if (event.type === "error") {
    const agentCliInfo: AgentCliAuthCardInfo | null =
      typeof event.errorInfo === "object" && event.errorInfo?.agentCli
        ? event.errorInfo.agentCli
        : null;
    const errorCopyValue = event.detail?.trim().length
      ? `${event.message}\n\n${event.detail}`
      : event.message;
    const recovery = classifyProviderFailure(event);
    const errorCategory = typeof event.errorInfo === "object" ? event.errorInfo?.category : undefined;
    const errorProvider = typeof event.errorInfo === "object" ? event.errorInfo?.provider : undefined;
    const presentation = readChatErrorPresentation(event.errorInfo)
      ?? presentChatFailure({
        kind: chatErrorKindFromCategory(errorCategory),
        message: event.message,
        detail: event.detail,
        provider: errorProvider,
      });
    const renderAgentCliAuthCard = () => agentCliInfo ? (
      <AgentCliAuthCard
        agentCli={agentCliInfo}
        laneId={options?.laneId}
        chatSessionId={options?.sessionId}
        runtimeName={options?.runtimeName}
        onRevealTerminal={options?.onRevealChatTerminal}
      />
    ) : null;
    // A logged-out runtime is recoverable, not a crash — lead with the calm
    // re-login card and tuck the raw 401 behind a Details disclosure instead of
    // the loud red error chrome. (The "missing CLI" card keeps the red frame.)
    if (agentCliInfo?.category === "unauthenticated") {
      return (
        <div
          className={cn(
            GLASS_CARD_CLASS,
            "group p-0",
            agentCliInfo.agent === "claude" ? "border-[#d97757]/12" : "border-amber-400/12",
          )}
          style={SURFACE_INLINE_CARD_STYLE}
        >
          <div className="p-4 pt-3">
            {renderAgentCliAuthCard()}
            <details className="mt-2">
              <summary className="cursor-pointer list-none font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-[0.16em] text-muted-fg/40 transition-colors hover:text-muted-fg/65">
                Details
              </summary>
              <div className="mt-1.5 flex items-start gap-2 rounded-[calc(var(--chat-radius-card)-8px)] border border-white/[0.06] bg-black/15 px-3 py-2">
                <div className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[length:calc(var(--chat-font-size)*10/14)] leading-relaxed text-fg/55">
                  {errorCopyValue}
                </div>
                <MessageCopyButton value={errorCopyValue} className="shrink-0" />
              </div>
            </details>
          </div>
        </div>
      );
    }
    return (
      <div className={cn(GLASS_CARD_CLASS, "group border-border/50 p-0")} style={SURFACE_INLINE_CARD_STYLE}>
        <div className="p-3">
          <InstructionErrorCard
            presentation={presentation}
            disabled={Boolean(options?.sessionTurnActive)}
            onRetry={options?.onRetryProviderFailure && !recovery
              ? () => { void options.onRetryProviderFailure!(event.turnId ?? null); }
              : undefined}
          />
          {recovery ? (
            <ProviderFailureRecoveryCard
              recovery={recovery}
              disabled={Boolean(options?.sessionTurnActive)}
              onRetry={options?.onRetryProviderFailure
                ? () => options.onRetryProviderFailure!(event.turnId ?? null)
                : undefined}
              onChooseModel={options?.onChooseProviderFailureModel}
            />
          ) : null}
          {renderAgentCliAuthCard()}
          {/* Names the failure class ("Provider capacity", "Usage limit") or the
              raw provider/model identity. The instruction card above says what
              to do; this says which thing went wrong, and dropping it would
              lose the only place a Codex usage limit is distinguishable from a
              generic stop. */}
          {event.errorInfo && !agentCliInfo ? (
            <div
              className="mt-2 font-mono text-[length:calc(var(--chat-font-size)*10/14)] text-muted-fg/40"
              title={typeof event.errorInfo === "string" ? event.errorInfo : undefined}
            >
              {recovery?.label
                ?? (typeof event.errorInfo === "string" ? event.errorInfo : `${event.errorInfo.provider ? `${event.errorInfo.provider}` : ""}${event.errorInfo.model ? ` / ${event.errorInfo.model}` : ""}`)}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  /* ── Cloud status lifecycle ── */
  if (event.type === "cloud_status") {
    const status = (event.status ?? "").toLowerCase();
    const failed = status === "error" || status === "cancelled" || status === "expired";
    if (!failed && !event.prUrl) return null;
    const inProgress = status === "creating" || status === "running";
    const live = inProgress && Boolean(options?.turnActive);
    const tone = inProgress
      ? "text-violet-200/80"
      : failed
        ? "text-red-300/75"
        : "text-emerald-300/70";
    const label = failed
      ? (status === "cancelled"
        ? "Cloud run cancelled"
        : status === "expired"
          ? "Cloud run expired"
          : "Cloud run failed")
      : "Pull request";
    return (
      <div className={cn(
        "inline-flex items-center gap-2 rounded-full border px-2.5 py-1 font-sans text-[length:calc(var(--chat-font-size)*10/14)]",
        inProgress
          ? "border-violet-300/22"
          : failed
            ? "border-red-400/20 bg-red-500/[0.05]"
            : "border-emerald-400/20 bg-emerald-500/[0.05]",
        tone,
      )} style={inProgress ? { background: "rgba(167,139,250,0.06)" } : undefined}>
        {live ? (
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" style={{ background: "#A78BFA" }} />
            <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: "#A78BFA" }} />
          </span>
        ) : inProgress ? (
          <span className="inline-flex h-2 w-2 rounded-full" style={{ background: "#A78BFA" }} />
        ) : (
          <CloudArrowUp size={11} weight="fill" />
        )}
        <span className="font-medium">{label}</span>
        {event.detail ? <span className="truncate text-fg/45">· {event.detail}</span> : null}
        {event.gitBranch ? <span className="font-mono text-[length:calc(var(--chat-font-size)*9/14)] text-fg/35">{event.gitBranch}</span> : null}
        {event.prUrl ? (
          <button
            type="button"
            onClick={(clickEvent) => openLinkFromUi(event.prUrl, clickEvent)}
            className="font-mono text-[length:calc(var(--chat-font-size)*9/14)] text-violet-200/70 hover:text-violet-100"
          >
            PR
          </button>
        ) : null}
      </div>
    );
  }

  /* ── ade_card (generic ADE-emitted card; unknown variants degrade in-place) ── */
  if (event.type === "ade_card") {
    // A new-lane launch's setup record. The live launch snapshot drives it
    // while setup runs; afterwards it is a one-line summary that expands.
    if (event.variant === "lane_setup") {
      return <LaneSetupTranscriptCard card={event} />;
    }
    // Without a dispatcher the card filters out every non-`open` action, so the
    // schema's action row could never be used. `retry`/`refresh` re-enter the
    // card's own surface (which refetches on mount); anything else is broadcast
    // for a host to pick up, mirroring `ade:chat:open-info`.
    return (
      <AdeCard
        card={event}
        onAction={(actionId) => dispatchAdeCardAction(event, actionId, options?.sessionId ?? null)}
      />
    );
  }

  /* ── Cloud artifact (auto-pulled into lane) ── */
  if (event.type === "cloud_artifact") {
    const sizeKb = typeof event.sizeBytes === "number" && event.sizeBytes > 0
      ? `${(event.sizeBytes / 1024).toFixed(1)} KB`
      : null;
    const filename = (event.path ?? "").split(/[\\/]/).pop() || event.path;
    return (
      <div
        className="inline-flex items-center gap-2 rounded-md border border-violet-300/15 bg-violet-500/[0.05] px-2 py-1 font-sans text-[length:calc(var(--chat-font-size)*10/14)] text-violet-100/80"
      >
        <CloudArrowUp size={10} weight="fill" />
        <span className="font-medium">Pulled</span>
        <span className="truncate font-mono text-[length:calc(var(--chat-font-size)*10/14)] text-fg/65" title={event.lanePath || event.path}>{filename}</span>
        {sizeKb ? <span className="font-mono text-[length:calc(var(--chat-font-size)*9/14)] text-fg/30">{sizeKb}</span> : null}
      </div>
    );
  }

  /* ── Activity ── */
  if (event.type === "activity") {
    const animate = Boolean(options?.turnActive) && !options?.sessionEnded;
    return (
      <span
        className={cn(
          "font-sans text-[length:calc(var(--chat-font-size)*12/14)] italic",
          animate ? "ade-shimmer-text" : "text-fg/35",
        )}
      >
        {formatActivityText(event.activity, event.detail)}
      </span>
    );
  }

  /* ── Status ── */
  if (event.type === "status") {
    const isFailure = event.turnStatus === "failed";
    const isInterrupted = event.turnStatus === "interrupted";
    return (
      <div
        className={cn(
          "flex items-center gap-2 rounded-[var(--chat-radius-pill)] border px-3 py-1.5 font-mono text-[length:calc(var(--chat-font-size)*10/14)] uppercase tracking-[0.16em]",
          turnStatusToneClass({ isFailure, isInterrupted }),
        )}
      >
        <Warning size={11} weight="bold" />
        <span>{event.turnStatus}</span>
        {event.message ? (
          <span className="truncate text-[length:calc(var(--chat-font-size)*9/14)] normal-case tracking-normal text-fg/55">
            {event.message}
          </span>
        ) : null}
      </div>
    );
  }

  /* ── Delegation ── */
  if (event.type === "delegation_state") {
    const isFailure =
      event.contract.status === "blocked"
      || event.contract.status === "launch_failed"
      || event.contract.status === "failed";
    const label = `${event.contract.workerIntent} ${event.contract.status}`.replace(/_/g, " ");
    const detail = (event.message ?? "").trim();
    return (
      <div
        className={cn(
          "flex items-center gap-2 rounded-[var(--chat-radius-pill)] border px-3 py-1.5 font-mono text-[length:calc(var(--chat-font-size)*10/14)] uppercase tracking-[0.16em]",
          isFailure
            ? "border-red-500/14 bg-red-500/[0.05] text-red-300"
            : "border-border/14 bg-surface-recessed/70 text-muted-fg/55"
        )}
      >
        <Warning size={11} weight="bold" />
        <span>{label}</span>
        {detail ? (
          <span className="truncate text-[length:calc(var(--chat-font-size)*9/14)] normal-case tracking-normal text-fg/55">
            {detail}
          </span>
        ) : null}
      </div>
    );
  }

  /* ── Done ── */
  if (event.type === "done") {
    // Rendered as the end-of-turn divider by EventRow (see DoneTurnDivider),
    // which needs the per-turn worked-for duration. Nothing inline here.
    return null;
  }

  /* ── Turn diff summary ── */
  if (event.type === "turn_diff_summary") {
    if (!options?.sessionId) {
      return (
        <TurnDiffSummaryFallback
          turnSummary={event}
          threadSummaries={options?.turnDiffSummaries ?? [event]}
        />
      );
    }
    return (
      <ChatTurnFileChangesPanel
        turnSummary={event}
        threadSummaries={options.turnDiffSummaries ?? [event]}
        sessionId={options.sessionId}
      />
    );
  }

  /* ── Completion report ── */
  if (event.type === "completion_report") {
    const statusTone = completionReportToneClass(event.report.status);
    return (
      <div className={cn("rounded-lg border px-3 py-2.5", statusTone)}>
        <div className="flex flex-wrap items-center gap-2 font-mono text-[length:calc(var(--chat-font-size)*10/14)] uppercase tracking-[0.14em]">
          <span>Completion</span>
          <span className="text-current/80">{event.report.status}</span>
          {event.report.artifacts.length > 0 ? (
            <span className="text-current/70">{event.report.artifacts.length} artifact{event.report.artifacts.length === 1 ? "" : "s"}</span>
          ) : null}
        </div>
        <div className="mt-2 text-[length:calc(var(--chat-font-size)*12/14)] leading-5 text-fg/85">{event.report.summary}</div>
        {event.report.blockerDescription ? (
          <div className="mt-2 text-[length:calc(var(--chat-font-size)*11/14)] leading-5 text-fg/65">{event.report.blockerDescription}</div>
        ) : null}
      </div>
    );
  }

  /* ── Fallback ── */
  return (
    <div className="flex items-center gap-3 py-0.5">
      <div className="h-px flex-1 bg-white/6" />
      <span className="font-sans text-[length:calc(var(--chat-font-size)*10/14)] text-muted-fg/20">event</span>
      <div className="h-px flex-1 bg-white/6" />
    </div>
  );
}

function sameChatSourceList(left: readonly ChatSource[], right: readonly ChatSource[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]!.id !== right[index]!.id || left[index]!.title !== right[index]!.title) return false;
  }
  return true;
}

/**
 * `[G][D] 3 sources` on the turn-end line: a small stack of site favicons
 * (domain initials until they load, or when a site has none) and the count of
 * sources the agent used this turn. Opens the drawer's Sources
 * section narrowed to the turn. Sits on the turn rule, never in the answer's
 * hover footer, so it cannot cover Copy/rewind.
 */
function TurnSourcesChip({
  turnId,
  sources,
  onOpen,
}: {
  turnId: string;
  sources: ChatSource[];
  onOpen?: (turnId: string) => void;
}) {
  const label = pluralCount(sources.length, "source");
  const stack = sources.slice(0, 3);
  const body = (
    <>
      <span className="flex items-center -space-x-1" aria-hidden>
        {stack.map((source) => (
          <span key={source.id} className="rounded-[4px] ring-1 ring-[color:var(--chat-bg,#0b0b0d)]">
            <ChatSourceIcon source={source} size={12} />
          </span>
        ))}
      </span>
      <span>{label}</span>
    </>
  );
  const className = "inline-flex shrink-0 items-center gap-1.5 rounded-[5px] border border-white/[0.07] px-1.5 py-px font-mono text-[length:calc(var(--chat-font-size)*9.5/14)] tabular-nums text-fg/45";
  return onOpen ? (
    <button
      type="button"
      onClick={() => onOpen(turnId)}
      title="Show the sources used in this turn"
      className={cn(className, "transition-colors hover:border-white/[0.16] hover:text-fg/75")}
      data-testid="turn-sources-chip"
    >
      {body}
    </button>
  ) : (
    <span className={className} data-testid="turn-sources-chip">{body}</span>
  );
}

type TurnSummary = {
  turnId: string;
  taskCount: number;
  completedTaskCount: number;
  changedFileCount: number;
  backgroundAgentCount: number;
  activeBackgroundAgentCount: number;
  turnModel: { label: string; modelId?: string; model?: string } | null;
  durationMs: number | null;
  ended: boolean;
};

function deriveTurnSummary(
  events: AgentChatEventEnvelope[],
  turnModelState: DerivedTurnModelState | null,
): TurnSummary | null {
  let latestTurnId: string | null = null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    latestTurnId = getEventTurnId(events[i]!.event);
    if (latestTurnId) break;
  }
  if (!latestTurnId) return null;

  let latestTodoUpdate: Extract<AgentChatEvent, { type: "todo_update" }> | null = null;
  let latestPlan: Extract<AgentChatEvent, { type: "plan" }> | null = null;
  let turnStartedAt: number | null = null;
  let turnEndedAt: number | null = null;
  let ended = false;
  const changedFilePaths = new Set<string>();
  const subagents = new Map<string, { background: boolean; status: ChatSubagentSnapshot["status"] }>();

  for (const envelope of events) {
    const event = envelope.event;
    if (getEventTurnId(event) !== latestTurnId) continue;

    const ts = Date.parse(envelope.timestamp);
    if (Number.isFinite(ts)) {
      if (turnStartedAt === null || ts < turnStartedAt) turnStartedAt = ts;
      if (turnEndedAt === null || ts > turnEndedAt) turnEndedAt = ts;
    }
    if (event.type === "done" || (event.type === "status" && event.turnStatus !== "started")) {
      ended = true;
    }

    if (event.type === "todo_update") {
      latestTodoUpdate = event;
      continue;
    }

    if (event.type === "plan") {
      latestPlan = event;
      continue;
    }

    if (event.type === "file_change") {
      changedFilePaths.add(event.path);
      continue;
    }

    if (event.type === "subagent_started") {
      const existing = subagents.get(event.taskId);
      subagents.set(event.taskId, {
        background: event.background ?? existing?.background ?? false,
        status: "running",
      });
      continue;
    }

    if (event.type === "subagent_progress") {
      const existing = subagents.get(event.taskId);
      subagents.set(event.taskId, {
        background: existing?.background ?? false,
        status: "running",
      });
      continue;
    }

    if (event.type === "subagent_result") {
      const existing = subagents.get(event.taskId);
      subagents.set(event.taskId, {
        background: existing?.background ?? false,
        status: event.status,
      });
    }
  }

  let taskCount = 0;
  let completedTaskCount = 0;
  const taskSource = latestTodoUpdate?.items ?? latestPlan?.steps ?? [];
  for (const task of taskSource) {
    taskCount += 1;
    if (task.status === "completed") completedTaskCount += 1;
  }
  const changedFileCount = changedFilePaths.size;
  let backgroundAgentCount = 0;
  let activeBackgroundAgentCount = 0;
  for (const entry of subagents.values()) {
    if (!entry.background) continue;
    backgroundAgentCount += 1;
    if (entry.status === "running") {
      activeBackgroundAgentCount += 1;
    }
  }

  if (!taskCount && !changedFileCount && !backgroundAgentCount) {
    return null;
  }

  const durationMs =
    turnStartedAt !== null && turnEndedAt !== null && turnEndedAt > turnStartedAt
      ? turnEndedAt - turnStartedAt
      : null;

  return {
    turnId: latestTurnId,
    taskCount,
    completedTaskCount,
    changedFileCount,
    durationMs,
    ended,
    backgroundAgentCount,
    activeBackgroundAgentCount,
    turnModel: turnModelState?.map.get(latestTurnId) ?? null,
  };
}

/** `<1s`, `4.2s`, `12s`, `3m 32s`. Sub-second turns read `<1s`, never milliseconds. */
export function formatTurnDuration(durationMs: number): string {
  if (durationMs < 1000) return "<1s";
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = Math.round(seconds - minutes * 60);
  return remSeconds ? `${minutes}m ${remSeconds}s` : `${minutes}m`;
}


/**
 * Measured duration per `done` row key. A turn runs from its user message; a
 * turn with none (a Claude internal follow-up after background subagents, a
 * scheduled wake) runs from its own `status: started` event. A turn with
 * neither has no known start and gets no duration, so the fold row and the
 * turn-end line both omit it — never a duration measured from whatever row
 * happened to come first.
 */
export function deriveTurnEndDurations(
  rows: readonly { key: string; timestamp: string; event: { type: string } }[],
  turnStartedAtMs: ReadonlyMap<string, number>,
): Map<string, number> {
  const map = new Map<string, number>();
  let userStartMs: number | null = null;
  for (const row of rows) {
    const ts = Date.parse(row.timestamp);
    if (row.event.type === "user_message") {
      if (Number.isFinite(ts)) userStartMs = ts;
      continue;
    }
    if (row.event.type !== "done") continue;
    const turnId = (row.event as { turnId?: string }).turnId;
    const start = userStartMs ?? (turnId ? turnStartedAtMs.get(turnId) : undefined) ?? null;
    if (start !== null && Number.isFinite(ts)) map.set(row.key, Math.max(0, ts - start));
    userStartMs = null;
  }
  return map;
}

/**
 * End-of-turn divider — a hairline with a mono cutout reading
 * `10:04 · ran 3m 32s` (or the interrupted/failed status + model). Driven by the
 * universal `done` event, so it renders identically for every runtime (Codex /
 * Claude / Cursor / Droid / OpenCode).
 *
 * When the turn captured proof, a small `N proof` chip sits on the rule and
 * opens the drawer. The artifacts themselves render inline where they were
 * captured — the chip is a way back, not a second copy.
 */
function DoneTurnDivider({
  event,
  timestamp,
  durationMs,
  toolEntries,
  proofArtifacts,
  resolveProofThumbnailSrc,
  onOpenProofDrawer,
  onNavigateSuggestion,
  onInsertDraft,
  onRevealChatTerminal,
  sessionId,
  onReviewInFiles,
  turnFileEntries,
  hasCheckpointDiffSummary,
  turnDiffSummary = null,
  turnDiffSummaries = null,
  usageLimitResumeTurnId,
  workSummaryInFold = false,
  turnSources,
  onOpenTurnSources,
}: {
  event: Extract<AgentChatEvent, { type: "done" }>;
  /**
   * This turn folded: its tool and file counts moved up to the fold row, so
   * the line keeps only time, usage, proof, and the checkpoint diff.
   */
  workSummaryInFold?: boolean;
  /** Sources the agent used in this turn: the "N sources" chip. */
  turnSources?: ChatSource[];
  onOpenTurnSources?: (turnId: string) => void;
  timestamp: string;
  durationMs: number | null;
  /**
   * Turn the chat's live usage limit is anchored to, when the host reports one.
   * A turn that matches gets the quiet paused footer even if the SDK did not
   * attach a 429 to the result frame.
   */
  usageLimitResumeTurnId?: string | null;
  toolEntries: ChatWorkLogEntry[];
  /** Opens the Files tab for this lane. Not a revert — see handleReviewChanges. */
  onReviewInFiles?: () => void;
  /** Raw (un-deduped) code-change entries for this turn. */
  turnFileEntries?: ChatWorkLogEntry[];
  /**
   * True when this turn moved HEAD and therefore already rendered a
   * checkpoint-backed `turn_diff_summary` row (real diffs + SHA-scoped revert).
   * The entry-derived fallback stays out of the way in that case.
   */
  hasCheckpointDiffSummary?: boolean;
  turnDiffSummary?: TurnDiffSummary | null;
  turnDiffSummaries?: TurnDiffSummary[] | null;
  proofArtifacts?: ComputerUseArtifactView[];
  resolveProofThumbnailSrc?: (artifact: ComputerUseArtifactView) => string | null;
  onOpenProofDrawer?: () => void;
  onNavigateSuggestion?: (suggestion: OperatorNavigationSuggestion) => void;
  onInsertDraft?: (text: string) => void;
  onRevealChatTerminal?: (terminal: { terminalId: string; ptyId: string; label: string }) => void;
  sessionId?: string | null;
}) {
  const [usageDetailsOpen, setUsageDetailsOpen] = useState(false);
  // Proof captured during this turn renders inline, at the moment it happened,
  // and starts collapsed so a long capture run never buries the reply.
  const [proofOpen, setProofOpen] = useState(false);
  const turnProof = proofArtifacts ?? EMPTY_PROOF_ARTIFACTS;
  const completed = event.status === "completed";
  const { label: modelLabel } = resolveModelMeta(event.modelId, event.model);
  const reasonLabel = completed ? null : terminalReasonLabel(event.terminalReason);
  // Same rule as the fold row's `Worked for …`: any measured duration shows.
  const ranFor = durationMs !== null && durationMs > 0
    ? `ran ${formatTurnDuration(durationMs)}`
    : null;
  const tokenLine = formatDoneTurnTokenLine(event.usage);
  // A turn that ended at a usage limit did not fail in any sense the user can
  // act on: nothing is wrong with the work, the provider simply stopped
  // answering, and the pill above the composer already says when it resumes.
  // So the loud `FAILED · api error · USAGE …` line collapses to one quiet
  // sentence and the token accounting moves behind the details toggle, where
  // it stays available without competing with the one fact that matters.
  const usageLimitPaused = !completed && isUsageLimitTurn(event, usageLimitResumeTurnId);
  const usageLimitLabel = usageLimitPaused
    ? usageLimitTurnFooterLabel(durationMs !== null ? formatTurnDuration(durationMs) : null)
    : null;
  const usageLimitDetails = Boolean(usageLimitPaused && tokenLine);
  const content = usageLimitPaused ? (
    <span className="inline-flex shrink-0 items-center gap-2 px-1 font-sans text-[length:calc(var(--chat-font-size)*10/14)] text-fg/45">
      <span>{usageLimitLabel}</span>
      {usageLimitDetails ? (
        usageDetailsOpen
          ? <CaretDown size={9} weight="bold" className="opacity-55" />
          : <CaretRight size={9} weight="bold" className="opacity-55" />
      ) : null}
    </span>
  ) : (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-2 px-1 font-mono tabular-nums text-[length:calc(var(--chat-font-size)*10/14)]",
        completed ? "text-fg/40" : doneStatusToneClass(event.status),
      )}
    >
        {!completed && modelLabel ? (
          <span className="inline-flex items-center gap-1.5 font-sans">
            <ModelGlyph modelId={event.modelId} model={event.model} size={12} className="shrink-0" />
            <span className="font-medium">{modelLabel}</span>
          </span>
        ) : null}
        {ranFor ? (
          <span className="inline-flex items-center gap-1">
            <Clock size={11} weight="bold" aria-hidden />
            <span>{ranFor}</span>
          </span>
        ) : null}
        {ranFor ? <span className="text-fg/25" aria-hidden>·</span> : null}
        {completed ? (
          <span>{formatTime(timestamp)}</span>
        ) : (
          <span className="font-sans font-medium uppercase tracking-wide">{event.status}</span>
        )}
        {reasonLabel ? (
          <>
            <span className="opacity-40">·</span>
            <span className="font-sans normal-case">{reasonLabel}</span>
          </>
        ) : null}
    </span>
  );
  const checkpointFileList = turnDiffSummary ? aggregateFiles([turnDiffSummary]) : [];
  const checkpointFiles = checkpointFileList.length > 0
    ? {
        count: checkpointFileList.length,
        additions: checkpointFileList.reduce((sum, file) => sum + file.additions, 0),
        deletions: checkpointFileList.reduce((sum, file) => sum + file.deletions, 0),
      }
    : null;
  const checkpointDetail = turnDiffSummary && sessionId && checkpointFiles ? (
    <ChatTurnFileChangesPanel
      turnSummary={turnDiffSummary}
      threadSummaries={turnDiffSummaries?.length ? turnDiffSummaries : [turnDiffSummary]}
      sessionId={sessionId}
      variant="detail"
    />
  ) : null;
  const proofChip = turnProof.length > 0 ? (
    <button
      type="button"
      aria-expanded={proofOpen}
      onClick={() => setProofOpen((open) => !open)}
      title={proofOpen ? "Hide the proof captured in this turn" : "Show the proof captured in this turn"}
      className="inline-flex shrink-0 items-center gap-1 rounded-[5px] border border-white/[0.07] px-1.5 py-px font-mono text-[length:calc(var(--chat-font-size)*9.5/14)] tabular-nums text-fg/45 transition-colors hover:border-white/[0.16] hover:text-fg/75"
    >
      <Cube size={10} weight="bold" aria-hidden />
      {turnProof.length} proof
    </button>
  ) : null;
  const turnLeading = (
    <span className="inline-flex min-w-0 items-center gap-2">
      {usageLimitDetails ? (
        <button
          type="button"
          aria-expanded={usageDetailsOpen}
          aria-label={`${usageDetailsOpen ? "Hide" : "Show"} details from this turn`}
          onClick={() => setUsageDetailsOpen((open) => !open)}
          className="rounded-md py-0.5 transition-colors hover:bg-white/[0.025] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-300/35"
        >
          {content}
        </button>
      ) : content}
      {proofChip}
      {turnSources?.length && event.turnId ? (
        <TurnSourcesChip turnId={event.turnId} sources={turnSources} onOpen={onOpenTurnSources} />
      ) : null}
    </span>
  );

  return (
    <div className="my-4 min-w-0">
      <ChatTurnWorkSummary
        toolEntries={workSummaryInFold ? EMPTY_WORK_LOG_ENTRIES : toolEntries}
        fileEntries={hasCheckpointDiffSummary || workSummaryInFold
          ? EMPTY_WORK_LOG_ENTRIES
          : (turnFileEntries ?? EMPTY_WORK_LOG_ENTRIES)}
        onReviewInFiles={onReviewInFiles}
        onNavigateSuggestion={onNavigateSuggestion}
        onInsertDraft={onInsertDraft}
        onRevealChatTerminal={onRevealChatTerminal}
        sessionId={sessionId}
        leading={turnLeading}
        tokenUsage={usageLimitPaused ? null : event.usage}
        checkpointFiles={checkpointFiles}
        checkpointDetail={checkpointDetail}
      />
      <AnimatePresence initial={false}>
        {usageLimitDetails && usageDetailsOpen ? (
          <motion.div
            initial={{ opacity: 0, height: 0, y: -4 }}
            animate={{ opacity: 1, height: "auto", y: 0 }}
            exit={{ opacity: 0, height: 0, y: -4 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
            className="mt-2 w-full max-w-[var(--chat-content-width,52rem)] overflow-hidden border-l border-white/[0.08] pl-4"
          >
            <div
              data-testid="done-turn-usage-detail"
              className="mb-2 font-mono tabular-nums text-[length:calc(var(--chat-font-size)*10/14)] text-fg/40"
            >
              {tokenLine}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      {turnProof.length > 0 && proofOpen ? (
        <div className="mt-2 w-full max-w-[var(--chat-content-width,52rem)]">
          <ChatProofFilmstrip
            artifacts={turnProof}
            resolveThumbnailSrc={resolveProofThumbnailSrc}
            onOpenAll={onOpenProofDrawer}
            onOpenArtifact={onOpenProofDrawer}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The one row a finished turn's intermediate work folds into:
 * `Worked for 4m 12s · 18 tools · 3 files · 2 subagents`, closed by default.
 * Opening it lists the turn's tools and files (the same disclosure the turn-end
 * line used to carry) and reveals the folded rows below it in their original
 * order. Rules: `shared/chatTurnFold.ts`.
 */
function TurnFoldRow({
  event,
  open,
  onToggle,
  durationMs,
  toolEntries,
  fileEntries,
  hasCheckpointDiffSummary,
  turnDiffSummaries,
  onReviewInFiles,
  onNavigateSuggestion,
  onInsertDraft,
  onRevealChatTerminal,
  sessionId,
  sourceCount = 0,
}: {
  event: TurnFoldRenderEvent;
  open: boolean;
  onToggle?: (foldId: string) => void;
  durationMs: number | null;
  toolEntries: ChatWorkLogEntry[];
  fileEntries: ChatWorkLogEntry[];
  hasCheckpointDiffSummary: boolean;
  turnDiffSummaries?: TurnDiffSummary[];
  onReviewInFiles?: () => void;
  onNavigateSuggestion?: (suggestion: OperatorNavigationSuggestion) => void;
  onInsertDraft?: (text: string) => void;
  onRevealChatTerminal?: (terminal: { terminalId: string; ptyId: string; label: string }) => void;
  sessionId?: string | null;
  /** Sources the agent used in this turn (same count as the turn-end chip). */
  sourceCount?: number;
}) {
  const toolCount = useMemo(() => dedupeChatToolActivityEntries(toolEntries).length, [toolEntries]);
  const checkpointSummary = hasCheckpointDiffSummary
    ? (turnDiffSummaries?.find((summary) => summary.turnId === event.turnId) ?? null)
    : null;
  const fileCount = useMemo(
    () => (checkpointSummary
      ? aggregateFiles([checkpointSummary]).length
      : countChatTurnChangedFiles(fileEntries)),
    [checkpointSummary, fileEntries],
  );
  const duration = durationMs !== null && durationMs > 0 ? formatTurnDuration(durationMs) : null;
  const label = formatTurnFoldLabel({
    duration,
    status: event.status,
    toolCount,
    fileCount,
    subagentCount: event.subagentCount,
    jobCount: event.jobCount,
    failedJobCount: event.failedJobCount,
    sourceCount,
  });
  const jobCount = event.jobCount ?? 0;
  const failedJobCount = event.failedJobCount ?? 0;
  // The same icons the turn-end line used for these counts, so the fold reads
  // as that line moved up: wrench for tools, diff for files, robot for
  // subagents, terminal for background jobs (red when any failed).
  const counts = [
    toolCount > 0
      ? { key: "tools", text: pluralCount(toolCount, "tool"), icon: <Wrench size={10} weight="bold" className="shrink-0 text-sky-300/70" aria-hidden /> }
      : null,
    fileCount > 0
      ? { key: "files", text: pluralCount(fileCount, "file"), icon: <GitDiff size={10} weight="bold" className="shrink-0 text-emerald-300/75" aria-hidden /> }
      : null,
    event.subagentCount > 0
      ? { key: "subagents", text: pluralCount(event.subagentCount, "subagent"), icon: <Robot size={10} weight="duotone" className="shrink-0 text-violet-300/70" aria-hidden /> }
      : null,
    jobCount > 0
      ? {
          key: "jobs",
          text: formatTurnFoldJobCount(jobCount, failedJobCount),
          icon: <Terminal size={10} weight="bold" className={cn("shrink-0", failedJobCount > 0 ? "text-red-400/85" : "text-amber-200/70")} aria-hidden />,
          tone: failedJobCount > 0 ? "text-red-300/85" : undefined,
        }
      : null,
    sourceCount > 0
      ? { key: "sources", text: pluralCount(sourceCount, "source"), icon: <Globe size={10} weight="bold" className="shrink-0 text-cyan-300/70" aria-hidden /> }
      : null,
  ].filter((count): count is { key: string; text: string; icon: React.ReactElement; tone?: string } => count !== null);
  // The checkpoint diff stays on the turn-end line; the fold only lists the
  // entry-derived files when there is no checkpoint to show them.
  const detailFileEntries = checkpointSummary ? EMPTY_WORK_LOG_ENTRIES : fileEntries;
  return (
    <div className="min-w-0" data-testid="turn-fold-row">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${label}. ${open ? "Hide" : "Show"} the work from this turn`}
        onClick={() => onToggle?.(event.foldId)}
        // Mouse focus draws nothing; only keyboard focus gets the ring.
        className="inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 font-sans text-[length:calc(var(--chat-font-size)*11/14)] tabular-nums text-fg/50 outline-none transition-colors hover:text-fg/80 focus:outline-none focus-visible:ring-1 focus-visible:ring-violet-300/35"
      >
        <span className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">
          <span className="shrink-0">{formatTurnFoldHead({ duration, status: event.status })}</span>
          {counts.map((count) => (
            <span key={count.key} className={cn("inline-flex min-w-0 items-center gap-1", count.tone)} data-testid={`turn-fold-count-${count.key}`}>
              <span className="shrink-0 text-fg/25" aria-hidden>{" · "}</span>
              {count.icon}
              <span className="truncate">{count.text}</span>
            </span>
          ))}
        </span>
        {open
          ? <CaretDown size={9} weight="bold" className="shrink-0" aria-hidden />
          : <CaretRight size={9} weight="bold" className="shrink-0" aria-hidden />}
      </button>
      {open && (toolCount > 0 || detailFileEntries.length > 0) ? (
        <div className="min-w-0 pl-1.5">
          <ChatTurnWorkSummary
            align="start"
            toolEntries={toolEntries}
            fileEntries={detailFileEntries}
            onReviewInFiles={onReviewInFiles}
            onNavigateSuggestion={onNavigateSuggestion}
            onInsertDraft={onInsertDraft}
            onRevealChatTerminal={onRevealChatTerminal}
            sessionId={sessionId}
          />
        </div>
      ) : null}
    </div>
  );
}

function getGroupedTurnId(envelope: TranscriptGroupedEnvelope | undefined): string | null {
  if (!envelope) return null;
  if (envelope.event.type === "work_log_group") {
    return envelope.event.turnId ?? envelope.event.entries[0]?.turnId ?? null;
  }
  if (envelope.event.type === "activity_bundle") {
    return envelope.event.turnId ?? envelope.event.items.find((item) => item.event.turnId)?.event.turnId ?? null;
  }
  return "turnId" in envelope.event ? envelope.event.turnId ?? null : null;
}

/* ── Main component ── */

type EventRowProps = SpawnedChatProviderProps & {
  envelope: TranscriptGroupedEnvelope;
  showTurnDivider: boolean;
  turnDividerLabel: string | null;
  showForkHistoryDivider?: boolean;
  turnModel: { label: string; modelId?: string; model?: string } | null;
  turnEndDurationMs?: number | null;
  turnToolEntries?: ChatWorkLogEntry[];
  onApproval?: (itemId: string, decision: AgentChatApprovalDecision, responseText?: string | null, answers?: Record<string, string | string[]>) => void;
  onCodexRecovery?: (args: AgentChatRecoverCodexTurnArgs) => Promise<AgentChatRecoverCodexTurnResult>;
  onRecoverContinuity?: (args: AgentChatRecoverContinuityArgs) => Promise<AgentChatContinuityRecoveryResult>;
  onRetryProviderFailure?: (turnId: string | null) => Promise<string | null>;
  onChooseProviderFailureModel?: () => void;
  onRunUnprocessedMessage?: (event: UserMessageEvent) => void | Promise<void>;
  onEditUnprocessedMessage?: (event: UserMessageEvent) => void;
  onDismissUnprocessedMessage?: (event: UserMessageEvent) => void | Promise<void>;
  surfaceMode?: ChatSurfaceMode;
  surfaceProfile?: ChatSurfaceProfile;
  assistantLabel?: string;
  turnActive?: boolean;
  sessionTurnActive?: boolean;
  sessionEnded?: boolean;
  /** A usage limit is live for this chat (see `AgentChatUsageLimitResume`). */
  usageLimitResumeActive?: boolean;
  /** Turn that limit is anchored to, when the host reports one. */
  usageLimitResumeTurnId?: string | null;
  onOpenWorkspacePath?: (path: string | WorkspacePathLocation) => void;
  onNavigateSuggestion?: (suggestion: OperatorNavigationSuggestion) => void;
  onReviewChanges?: () => void;
  turnFileEntries?: ChatWorkLogEntry[];
  /** This turn already rendered a checkpoint-backed `turn_diff_summary` row. */
  hasCheckpointDiffSummary?: boolean;
  onInsertDraft?: (text: string) => void;
  onRevealChatTerminal?: (terminal: { terminalId: string; ptyId: string; label: string }) => void;
  onRewindFiles?: (request: { messageId: string; timestamp: string; text: string }) => void;
  turnDiffSummaries?: TurnDiffSummary[];
  respondingApprovalIds?: Set<string>;
  pendingApprovalIds?: Set<string>;
  resolvedInputStates?: Map<string, PendingInputResolution>;
  resolvedInputAnswers?: Map<string, Record<string, string | string[]>>;
  laneId?: string | null;
  sessionId?: string | null;
  runtimeName?: string | null;
  mosaic?: MosaicRenderContext;
  anchored?: boolean;
  onScrollToRowKey?: (rowKey: string) => void;
  assistantTurnCopy?: { text: string } | null;
  staleInterruptReceipts?: Set<string>;
  onCancelQueuedMessage?: (uuid: string) => void;
  onRestoreCancelledQueue?: (recoveryId: string) => Promise<boolean>;
  settledQueueRecoveryIds?: Set<string>;
  /** Stop one running subagent / background task by provider task id. */
  onStopSubagent?: (taskId: string) => void;
  /** Proof captured during this turn — surfaced as a chip on the turn rule. */
  turnProof?: ComputerUseArtifactView[];
  /** Proof captured after this row but outside a completed turn window. */
  inlineProof?: ComputerUseArtifactView[];
  resolveProofThumbnailSrc?: (artifact: ComputerUseArtifactView) => string | null;
  onOpenProofDrawer?: () => void;
  /** This row is the trailing streaming assistant text row (paced reveal). */
  pacedTextReveal?: boolean;
  /** This reasoning row is the live turn's newest, still-streaming row. */
  liveThinking?: boolean;
  /** `turn_fold` rows: whether the fold is open. */
  turnFoldOpen?: boolean;
  onToggleTurnFold?: (foldId: string) => void;
  /** `done` rows of a folded turn: the tool/file counts live on the fold row. */
  turnWorkInFold?: boolean;
  /** `done` / `turn_fold` rows: sources the agent used this turn. */
  turnSources?: ChatSource[];
  onOpenTurnSources?: (turnId: string) => void;
};

const EventRow = React.memo(function EventRow({
  envelope,
  showTurnDivider,
  turnDividerLabel,
  showForkHistoryDivider,
  turnModel,
  turnEndDurationMs,
  turnToolEntries = [],
  onApproval,
  onCodexRecovery,
  onRecoverContinuity,
  onRetryProviderFailure,
  onChooseProviderFailureModel,
  onRunUnprocessedMessage,
  onEditUnprocessedMessage,
  onDismissUnprocessedMessage,
  surfaceMode = "standard",
  surfaceProfile = "standard",
  assistantLabel,
  sessionProvider,
  resolveSpawnedChatProvider,
  turnActive,
  sessionTurnActive,
  sessionEnded,
  usageLimitResumeActive,
  usageLimitResumeTurnId,
  onOpenWorkspacePath,
  onNavigateSuggestion,
  onReviewChanges,
  turnFileEntries,
  hasCheckpointDiffSummary,
  onInsertDraft,
  onRevealChatTerminal,
  onRewindFiles,
  turnDiffSummaries,
  respondingApprovalIds,
  pendingApprovalIds,
  resolvedInputStates,
  resolvedInputAnswers,
  laneId,
  sessionId,
  runtimeName,
  mosaic,
  anchored,
  onScrollToRowKey,
  assistantTurnCopy,
  staleInterruptReceipts,
  onCancelQueuedMessage,
  onRestoreCancelledQueue,
  settledQueueRecoveryIds,
  onStopSubagent,
  turnProof,
  inlineProof,
  resolveProofThumbnailSrc,
  onOpenProofDrawer,
  pacedTextReveal,
  liveThinking = false,
  turnFoldOpen = false,
  onToggleTurnFold,
  turnWorkInFold = false,
  turnSources,
  onOpenTurnSources,
}: EventRowProps) {
  const chatInfoHostAvailable = React.useContext(ChatInfoHostContext);
  const doneTurnId = envelope.event.type === "done" ? envelope.event.turnId : null;
  return (
    <div
      data-chat-row-key={envelope.key}
      data-chat-anchored-row={anchored ? "true" : undefined}
      className={cn(
        "min-w-0 max-w-full space-y-3 overflow-hidden transition-colors duration-700",
        anchored && "rounded-lg bg-amber-300/[0.08] ring-1 ring-amber-300/15",
      )}
    >
      {showForkHistoryDivider ? (
        <div
          className="my-3 flex items-center gap-2.5 font-sans text-[length:calc(var(--chat-font-size)*10.5/14)] text-[color:color-mix(in_srgb,var(--chat-accent)_72%,var(--chat-fg,#e6e6e6))]"
          data-testid="fork-history-divider"
        >
          <span className="h-px flex-1 bg-[color:color-mix(in_srgb,var(--chat-accent)_28%,transparent)]" />
          <span className="inline-flex shrink-0 items-center gap-1.5">
            <GitFork size={12} weight="regular" className="opacity-80" aria-hidden />
            Forked from the previous chat — full history above
          </span>
          <span className="h-px flex-1 bg-[color:color-mix(in_srgb,var(--chat-accent)_28%,transparent)]" />
        </div>
      ) : null}
      {showTurnDivider ? (
        <div className="my-4 flex items-center gap-3">
          <span className="h-px flex-1 bg-white/[0.06]" />
          <span
            className="shrink-0 px-1 font-sans text-[length:calc(var(--chat-font-size)*10.5/14)] text-fg/38"
            title={turnModel?.label ?? undefined}
          >
            {turnDividerLabel ?? "Turn"}
          </span>
          <span className="h-px flex-1 bg-white/[0.06]" />
        </div>
      ) : null}
      {envelope.event.type === "turn_fold" ? (
        <TurnFoldRow
          event={envelope.event}
          open={turnFoldOpen}
          onToggle={onToggleTurnFold}
          durationMs={turnEndDurationMs ?? null}
          toolEntries={turnToolEntries}
          fileEntries={turnFileEntries ?? EMPTY_WORK_LOG_ENTRIES}
          hasCheckpointDiffSummary={Boolean(hasCheckpointDiffSummary)}
          turnDiffSummaries={turnDiffSummaries}
          onReviewInFiles={onReviewChanges}
          onNavigateSuggestion={onNavigateSuggestion}
          onInsertDraft={onInsertDraft}
          onRevealChatTerminal={onRevealChatTerminal}
          sessionId={sessionId}
          sourceCount={turnSources?.length ?? 0}
        />
      ) : envelope.event.type === "activity_bundle"
        ? <ChatActivityBundle event={envelope.event} sessionId={sessionId} />
        : renderEvent(envelope as RenderEnvelope, {
            onApproval,
            onCodexRecovery,
            onRecoverContinuity,
            onRetryProviderFailure,
            onChooseProviderFailureModel,
            onRunUnprocessedMessage,
            onEditUnprocessedMessage,
            onDismissUnprocessedMessage,
            turnModel,
            surfaceMode,
            surfaceProfile,
            assistantLabel,
            sessionProvider,
            resolveSpawnedChatProvider,
            turnActive,
            sessionTurnActive,
            sessionEnded,
            usageLimitResumeActive,
            onOpenWorkspacePath,
            respondingApprovalIds,
            pendingApprovalIds,
            resolvedInputStates,
            resolvedInputAnswers,
            laneId,
            sessionId,
            runtimeName,
            onRevealChatTerminal,
            chatInfoHostAvailable,
            onRewindFiles,
            turnDiffSummaries,
            mosaic,
            onScrollToRowKey,
            assistantTurnCopy,
            staleInterruptReceipts,
            onCancelQueuedMessage,
            onRestoreCancelledQueue,
            settledQueueRecoveryIds,
            onStopSubagent,
            pacedTextReveal,
            liveThinking,
          })}
      {envelope.event.type === "done" ? (
        <DoneTurnDivider
          event={envelope.event}
          timestamp={envelope.timestamp}
          durationMs={turnEndDurationMs ?? null}
          toolEntries={turnToolEntries}
          proofArtifacts={turnProof}
          resolveProofThumbnailSrc={resolveProofThumbnailSrc}
          onOpenProofDrawer={onOpenProofDrawer}
          onNavigateSuggestion={onNavigateSuggestion}
          onInsertDraft={onInsertDraft}
          onRevealChatTerminal={onRevealChatTerminal}
          sessionId={sessionId}
          onReviewInFiles={onReviewChanges}
          turnFileEntries={turnFileEntries}
          hasCheckpointDiffSummary={hasCheckpointDiffSummary}
          turnDiffSummary={doneTurnId
            ? (turnDiffSummaries?.find((summary) => summary.turnId === doneTurnId) ?? null)
            : null}
          turnDiffSummaries={turnDiffSummaries}
          usageLimitResumeTurnId={usageLimitResumeTurnId}
          workSummaryInFold={turnWorkInFold}
          turnSources={turnSources}
          onOpenTurnSources={onOpenTurnSources}
        />
      ) : null}
      {inlineProof?.length ? (
        <ChatProofFilmstrip
          artifacts={inlineProof}
          title="Proof added"
          defaultOpen={false}
          resolveThumbnailSrc={resolveProofThumbnailSrc}
          onOpenAll={onOpenProofDrawer}
          onOpenArtifact={onOpenProofDrawer}
        />
      ) : null}
    </div>
  );
});

/**
 * MeasuredEventRow wraps EventRow and reports its rendered height back to the
 * virtualizer so subsequent frames use real measured sizes instead of estimates.
 */
const MeasuredEventRow = React.memo(function MeasuredEventRow({
  index,
  onMeasure,
  ...rest
}: EventRowProps & { index: number; onMeasure: (index: number, height: number) => void }) {
  const rowRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    let raf: number | null = null;
    const measureNow = (fallbackHeight = 0) => {
      const height = Math.max(el.offsetHeight, el.getBoundingClientRect().height, fallbackHeight);
      if (height > 0) onMeasure(index, height);
    };

    measureNow();
    raf = requestAnimationFrame(() => measureNow());

    if (typeof ResizeObserver === "undefined") {
      return () => {
        if (raf !== null) cancelAnimationFrame(raf);
      };
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const measuredHeight = entry.target instanceof HTMLElement
        ? Math.max(entry.target.offsetHeight, entry.target.getBoundingClientRect().height, entry.contentRect.height)
        : entry.contentRect.height;
      measureNow(measuredHeight);
    });
    observer.observe(el);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [index, onMeasure]);

  return (
    <div ref={rowRef} data-chat-virtualized-row="true" className="min-w-0 max-w-full overflow-visible">
      <EventRow {...rest} />
    </div>
  );
});

/* ── Virtualization constants ── */

/** Estimated height per message row (px) used before real measurement. */
const ESTIMATED_ROW_HEIGHT = 80;
/** Column width assumed by the per-row estimate before the column is measured. */
const ESTIMATE_DEFAULT_COLUMN_WIDTH_PX = 720;
/** The per-row estimate is recomputed only when the column width moves a full step. */
const ESTIMATE_WIDTH_STEP_PX = 64;

function countWrappedLines(text: string, charsPerLine: number): number {
  let lines = 0;
  for (const line of text.split("\n")) lines += Math.max(1, Math.ceil(line.length / charsPerLine));
  return lines;
}

/**
 * Best guess at a row's height before it has ever been measured.
 *
 * One number for every kind placed a one-line fold row and a 40-line answer at
 * the same 80px, so a window of unmeasured rows (a freshly prepended page, a
 * reopened long chat) laid out far from where it measured and the thread
 * jumped as the real heights landed. The figures follow the row styles: prose
 * at ~7.6px per character and ~22px per line across the content column, user
 * bubbles at three quarters of it, and fixed sizes for chips and cards.
 */
export function estimateTranscriptRowHeight(
  row: TranscriptGroupedEnvelope,
  columnWidthPx: number,
): number {
  const width = columnWidthPx > 0 ? columnWidthPx : ESTIMATE_DEFAULT_COLUMN_WIDTH_PX;
  const event = row.event;
  switch (event.type) {
    case "turn_fold":
      return 26;
    case "done":
      return 34;
    case "reasoning":
    case "activity_bundle":
    case "work_log_group":
    case "status":
    case "system_notice":
    case "turn_details":
    case "scheduled_wake_divider":
    case "spawn_wake_divider":
      return 30;
    case "task_list":
      // Collapsed by default: one line in a bordered card.
      return 38;
    case "user_message": {
      const text = event.displayText ?? event.text ?? "";
      const charsPerLine = Math.max(16, Math.floor((width * 0.75) / 7.6));
      // + the status line under the bubble (Steered, Sent after turn, …).
      const statusLine = describeUserMessageStatus(event) ? 20 : 0;
      return Math.min(2_400, 30 + statusLine + countWrappedLines(text, charsPerLine) * 21);
    }
    case "text": {
      const charsPerLine = Math.max(24, Math.floor(width / 7.6));
      // + the 22px hover-footer line (timestamp, Copy) under the prose.
      return Math.min(6_000, 32 + countWrappedLines(event.text ?? "", charsPerLine) * 22);
    }
    case "ade_card":
    case "approval_request":
    case "structured_question":
    case "plan":
    case "error":
    case "todo_update":
    case "subagent_spawn_anchor":
    case "subagent_result_card":
      return 96;
    case "background_job_line":
    case "background_job_group":
      // One compact line; a group opens inline only on a click.
      return 28;
    case "subagent_card_grid": {
      // Cards in one grid row share its height; rows stack with an 8px gap.
      const gridRows = Math.ceil(event.members.length / subagentCardGridColumns(event.members.length, width));
      return gridRows * 96 + (gridRows - 1) * 8;
    }
    default:
      return ESTIMATED_ROW_HEIGHT;
  }
}

/**
 * Shared deadband for every measured box below. Sub-pixel churn (zoom,
 * fractional layout, backdrop-filter reflow) would otherwise land a state write
 * on frames where nothing visibly moved.
 */
function movedByAPixel(current: number, next: number): boolean {
  return Math.abs(current - next) >= 1;
}
/** Number of extra rows to render above/below the visible viewport. */
/** Minimum number of rows before virtualization kicks in. */
const VIRTUALIZATION_THRESHOLD = 60;
/**
 * Distance (px) from the bottom of the scroll container within which we
 * consider the user "stuck to bottom" and keep auto-following new content.
 * Sized so a single wheel nudge during streaming reliably breaks free of
 * auto-follow rather than being snapped back.
 */
const TOUCH_SCROLL_DEADBAND_PX = 2;
/**
 * Distance (px) from the top of the scroll container within which scrolling
 * up requests the next older transcript page (when one exists).
 */
const LOAD_OLDER_THRESHOLD_PX = 300;
/**
 * How far ahead of the top the next older page starts loading, in viewport
 * heights.
 *
 * Firing only within `LOAD_OLDER_THRESHOLD_PX` of the top means the reader
 * always arrives before the data: they hit the top, then wait on a round trip
 * plus a git/db read. Starting two screens out gives the fetch the time it takes
 * to scroll those two screens, so in normal reading the content is already
 * there and the top spinner never appears. The near-top path stays as the
 * fallback for a fast fling or a programmatic jump.
 *
 * This is not unbounded prefetching: `onLoadOlderHistory` is a no-op while a
 * page is in flight, so at most one page is ever outstanding.
 */
const PREFETCH_OLDER_VIEWPORT_HEIGHTS = 2;

/** Distance from the top at which the next older page starts loading. */
export function resolveOlderHistoryPrefetchTriggerPx(viewportHeightPx: number): number {
  if (!Number.isFinite(viewportHeightPx) || viewportHeightPx <= 0) return LOAD_OLDER_THRESHOLD_PX;
  return Math.max(LOAD_OLDER_THRESHOLD_PX, viewportHeightPx * PREFETCH_OLDER_VIEWPORT_HEIGHTS);
}

/* ── Per-chat scroll memory ────────────────────────────────────────────────
 * The owning pane force-remounts this list on a chat switch, while native
 * transcript drill-in keeps the list mounted. Module scope survives the former;
 * the per-key ref snapshot below preserves the latter without sharing scroll
 * state between parent and child views.
 */
type ChatScrollMemory = {
  /** Whether the reader was following the live tail when they left. */
  wasPinnedToBottom: boolean;
  /** Row key of the row occupying the top of the viewport. */
  anchorRowKey: string | null;
  /** How far into that row the viewport top sat. */
  anchorOffsetPx: number;
  /**
   * Distance from the viewport bottom to the end of the transcript. The
   * fallback when the anchor row no longer exists on return (trimmed away,
   * rebuilt under another key): the tail is what a trimmed window keeps.
   */
  distanceFromBottomPx: number | null;
  /** Last row present when they left — seeds the "N new" counter on return. */
  lastSeenRowKey: string | null;
  savedAtMs: number;
};

type ScrollRestoreTarget = Pick<ChatScrollMemory, "anchorRowKey" | "anchorOffsetPx" | "distanceFromBottomPx">;

/** A detached reader with somewhere to go back to. */
function needsScrollRestore(memory: ChatScrollMemory | null): boolean {
  return Boolean(memory && !memory.wasPinnedToBottom && (memory.anchorRowKey || memory.distanceFromBottomPx != null));
}

/** Frames a scroll restore keeps correcting before it gives up waiting for layout to settle. */
const SCROLL_RESTORE_MAX_CORRECTION_FRAMES = 60;
/** Frames the restored position must hold, unchanged, before the restore is done. */
const SCROLL_RESTORE_STABLE_FRAMES = 2;
/** Automatic older pages allowed between two reader scrolls (not counting an underfilled pane). */
const MAX_CHAINED_AUTO_OLDER_PAGES = 1;
/** Keys that scroll the transcript pane; pressing one is the reader taking over. */
const SCROLL_KEYS = new Set(["PageUp", "PageDown", "ArrowUp", "ArrowDown", "Home", "End", " "]);
const SCROLL_UP_KEYS = new Set(["PageUp", "ArrowUp", "Home"]);

function isScrollUpKey(event: React.KeyboardEvent): boolean {
  return SCROLL_UP_KEYS.has(event.key) || (event.key === " " && event.shiftKey);
}

/** Rows on screen before a row-list change, with their viewport-relative tops. */
type PendingListAnchor = {
  rows: { key: string; top: number }[];
  /** Where the first still-present row sat under the height model, for a row that unmounts. */
  model: { key: string; modelTop: number } | null;
  /**
   * The scrollTop the virtualized window is computed from for this one commit:
   * the current one shifted by how far the anchor moved under the height model,
   * so the anchor row is still mounted when the layout effect reads it.
   */
  windowScrollTop: number | null;
};

/** Bounded so a long-lived window can't accumulate memory for every chat ever opened. */
const CHAT_SCROLL_MEMORY_LIMIT = 32;
/** Insertion order doubles as LRU order: writes re-insert at the tail. */
const chatScrollMemoryBySession = new Map<string, ChatScrollMemory>();

function rememberBoundedChatScrollMemory(
  cache: Map<string, ChatScrollMemory>,
  sessionId: string,
  memory: ChatScrollMemory,
): void {
  cache.delete(sessionId);
  cache.set(sessionId, memory);
  while (cache.size > CHAT_SCROLL_MEMORY_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function readChatScrollMemory(sessionId: string | null | undefined): ChatScrollMemory | null {
  if (!sessionId) return null;
  return chatScrollMemoryBySession.get(sessionId) ?? null;
}

function rememberChatScrollMemory(sessionId: string, memory: ChatScrollMemory): void {
  rememberBoundedChatScrollMemory(chatScrollMemoryBySession, sessionId, memory);
}

/**
 * Which turn folds the reader opened, per transcript view (same key as the
 * scroll memory). In memory only and bounded like the scroll memory: a fold
 * reopened five chats ago is not worth keeping.
 */
const TURN_FOLD_MEMORY_LIMIT = 32;
const EMPTY_OPEN_TURN_FOLDS: ReadonlySet<string> = new Set();
const openTurnFoldsByView = new Map<string, ReadonlySet<string>>();

function readOpenTurnFolds(viewKey: string | null | undefined): ReadonlySet<string> {
  if (!viewKey) return EMPTY_OPEN_TURN_FOLDS;
  return openTurnFoldsByView.get(viewKey) ?? EMPTY_OPEN_TURN_FOLDS;
}

function rememberOpenTurnFolds(viewKey: string | null | undefined, open: ReadonlySet<string>): void {
  if (!viewKey) return;
  openTurnFoldsByView.delete(viewKey);
  if (open.size === 0) return;
  openTurnFoldsByView.set(viewKey, open);
  while (openTurnFoldsByView.size > TURN_FOLD_MEMORY_LIMIT) {
    const oldest = openTurnFoldsByView.keys().next().value;
    if (typeof oldest !== "string") break;
    openTurnFoldsByView.delete(oldest);
  }
}

export function resetTurnFoldMemoryForTests(): void {
  openTurnFoldsByView.clear();
}

/** Viewport-relative top of a rendered transcript row, or null when unmounted. */
function readChatRowTop(container: HTMLElement, rowKey: string): number | null {
  const containerTop = container.getBoundingClientRect().top;
  for (const node of container.querySelectorAll<HTMLElement>("[data-chat-row-key]")) {
    if (node.dataset.chatRowKey === rowKey) return node.getBoundingClientRect().top - containerTop;
  }
  return null;
}

/** The first rendered row still on screen, with its viewport-relative top. */
function readFirstVisibleChatRow(container: HTMLElement): { key: string; top: number } | null {
  return readVisibleChatRows(container, 1)[0] ?? null;
}

/**
 * The first `limit` rendered rows still on screen, top down, with their
 * viewport-relative tops. More than one, so an anchor survives its first row
 * being re-keyed by the change it is anchoring across (an older page joining
 * the seam row's activity group gives that group a new first key).
 */
function readVisibleChatRows(container: HTMLElement, limit: number): { key: string; top: number }[] {
  const containerTop = container.getBoundingClientRect().top;
  const visible: { key: string; top: number }[] = [];
  for (const node of container.querySelectorAll<HTMLElement>("[data-chat-row-key]")) {
    const rect = node.getBoundingClientRect();
    const key = node.dataset.chatRowKey;
    if (!key || rect.bottom <= containerTop + 1) continue;
    visible.push({ key, top: rect.top - containerTop });
    if (visible.length >= limit) break;
  }
  return visible;
}

/**
 * Viewport-relative top of a row that is mounted AND laid out. A zero-height
 * box (no layout yet, or a row that draws nothing) is not a position to anchor
 * to, so it reads as unmounted and the caller falls back to the height model.
 */
function readLaidOutChatRowTop(container: HTMLElement, rowKey: string): number | null {
  const containerTop = container.getBoundingClientRect().top;
  for (const node of container.querySelectorAll<HTMLElement>("[data-chat-row-key]")) {
    if (node.dataset.chatRowKey !== rowKey) continue;
    const rect = node.getBoundingClientRect();
    return rect.height > 0 ? rect.top - containerTop : null;
  }
  return null;
}

type PendingFoldAnchor = {
  /** Row whose on-screen top must not move across the fold change. */
  key: string;
  /** Its viewport-relative DOM top before the change. */
  top: number;
  /**
   * The same position under the height model (row start offset − scrollTop).
   * Used when the anchor row is not mounted after the change — a virtualized
   * list whose long fold closed above the window.
   */
  modelTop: number | null;
  /** The view followed the bottom before a fold toggle suspended it. */
  wasStuck: boolean;
  /** A reader's open/close click, as opposed to a turn folding on its own. */
  fromToggle: boolean;
};


type PendingChatEventAnchor = {
  event: number;
  loadRequests: number;
  waitingForOlderHistory: boolean;
  sawOlderHistoryLoading: boolean;
  lastEventsLength: number;
};

type TranscriptCollapseCache = {
  events: AgentChatEventEnvelope[];
  rows: TranscriptRenderEnvelope[];
  context: CollapseTranscriptResult["context"] | null;
};

const MAX_TRANSCRIPT_COLLAPSE_CACHE_ENTRIES = 8;
const transcriptCollapseCacheBySessionId = new Map<string, TranscriptCollapseCache>();

export function resetTranscriptCollapseCacheForTests(): void {
  transcriptCollapseCacheBySessionId.clear();
}

function readTranscriptCollapseCache(sessionId: string | null | undefined): TranscriptCollapseCache {
  if (!sessionId) return { events: [], rows: [], context: null };
  const cached = transcriptCollapseCacheBySessionId.get(sessionId);
  if (!cached) return { events: [], rows: [], context: null };
  transcriptCollapseCacheBySessionId.delete(sessionId);
  transcriptCollapseCacheBySessionId.set(sessionId, cached);
  return cached;
}

function writeTranscriptCollapseCache(
  sessionId: string | null | undefined,
  cached: TranscriptCollapseCache,
): void {
  if (!sessionId) return;
  transcriptCollapseCacheBySessionId.delete(sessionId);
  transcriptCollapseCacheBySessionId.set(sessionId, cached);
  while (transcriptCollapseCacheBySessionId.size > MAX_TRANSCRIPT_COLLAPSE_CACHE_ENTRIES) {
    const oldest = transcriptCollapseCacheBySessionId.keys().next().value;
    if (typeof oldest !== "string") break;
    transcriptCollapseCacheBySessionId.delete(oldest);
  }
}

/** How far back from the tail we look for the streaming text row. */
const PACED_TEXT_ROW_SCAN_DEPTH = 8;

function AgentChatMessageListMain({
  events,
  chatSources = null,
  showStreamingIndicator = false,
  textPacingEnabled = true,
    className,
  onApproval,
  onCodexRecovery,
  onRecoverContinuity,
  onRetryProviderFailure,
  onChooseProviderFailureModel,
  onRunUnprocessedMessage,
  onEditUnprocessedMessage,
  onDismissUnprocessedMessage,
    surfaceMode = "standard",
  surfaceProfile = "standard",
  assistantLabel,
  sessionTurnActive = false,
  usageLimitResumeActive = false,
  usageLimitResumeTurnId = null,
  onOpenWorkspacePath,
  respondingApprovalIds,
  pendingApprovalIds,
  laneId,
  runtimePin = null,
  sessionId,
  scrollMemoryKey,
  transcriptCollapseCacheKey,
  onInsertDraft,
  onRevealChatTerminal,
  onRewindFiles,
  onCancelQueuedMessage,
  onRestoreCancelledQueue,
  onStopSubagent,
  turnDiffSummaries,
  sessionEnded = false,
  sessionProvider = null,
  resolveSpawnedChatProvider,
  hasOlderHistory = false,
  loadingOlderHistory = false,
  olderHistoryError = null,
  onLoadOlderHistory,
  onRetryOlderHistory,
  onReturnToLatest,
  mosaic,
  scrollToRowKeyRequest,
  scrollToPromptHistoryRequest,
  proofArtifacts = [],
  allowLocalProofArtifactProtocol = false,
  onOpenProofDrawer,
  onOpenTurnSources,
}: SpawnedChatProviderProps & {
  events: AgentChatEventEnvelope[];
  /** Sources derived once by the owning pane and shared with its drawer. */
  chatSources?: ChatSources | null;
  showStreamingIndicator?: boolean;
  /**
   * Pace the trailing streaming assistant text row (default). Surfaces that
   * are not the user's main prose view — subagent transcripts above all — pass
   * false and keep the cheap paint-on-arrival render.
   */
  textPacingEnabled?: boolean;
  className?: string;
  onApproval?: (itemId: string, decision: AgentChatApprovalDecision, responseText?: string | null, answers?: Record<string, string | string[]>) => void;
  onCodexRecovery?: (args: AgentChatRecoverCodexTurnArgs) => Promise<AgentChatRecoverCodexTurnResult>;
  onRecoverContinuity?: (args: AgentChatRecoverContinuityArgs) => Promise<AgentChatContinuityRecoveryResult>;
  onRetryProviderFailure?: (turnId: string | null) => Promise<string | null>;
  onChooseProviderFailureModel?: () => void;
  onRunUnprocessedMessage?: (event: UserMessageEvent) => void | Promise<void>;
  onEditUnprocessedMessage?: (event: UserMessageEvent) => void;
  onDismissUnprocessedMessage?: (event: UserMessageEvent) => void | Promise<void>;
  surfaceMode?: ChatSurfaceMode;
  surfaceProfile?: ChatSurfaceProfile;
  assistantLabel?: string;
  sessionTurnActive?: boolean;
  /**
   * The host's live usage-limit resume state for this chat, or null. Only two
   * facts are read here — that a limit is live (the quota card stands down for
   * the composer pill) and which turn it is anchored to (that turn's footer
   * goes quiet) — so they are passed as primitives: the transcript rows are
   * memoized, and a fresh object per render would defeat that.
   */
  usageLimitResumeActive?: boolean;
  usageLimitResumeTurnId?: string | null;
  onOpenWorkspacePath?: (path: string, laneId?: string | null) => void;
  onInsertDraft?: (text: string) => void;
  onRevealChatTerminal?: (terminal: { terminalId: string; ptyId: string; label: string }) => void;
  onRewindFiles?: (request: { messageId: string; timestamp: string; text: string }) => void;
  /** Cancel an ADE-owned queued message by uuid (stop-receipt affordance). */
  onCancelQueuedMessage?: (uuid: string) => void;
  onRestoreCancelledQueue?: (recoveryId: string) => Promise<boolean>;
  /** Stop one running Claude subagent / background task by provider task id. */
  onStopSubagent?: (taskId: string) => void;
  turnDiffSummaries?: TurnDiffSummary[];
  respondingApprovalIds?: Set<string>;
  pendingApprovalIds?: Set<string>;
  laneId?: string | null;
  /**
   * Machine that owns this chat. Null = the machine this project tab is bound
   * to. Used by the workspace-path opener, so a filename clicked in a foreign
   * chat is looked up on the machine that actually has the file.
   *
   * Row-level consumers (attachment previews) do NOT take it from here: they
   * read `useChatRuntimeScope()`, which the pane provides with this same value.
   */
  runtimePin?: OpenProjectBinding | null;
  sessionId?: string | null;
  /** Separate scroll state for the parent and a drilled-in native transcript. */
  scrollMemoryKey?: string | null;
  /** Stable identity for collapse warm-cache isolation when rendering a nested transcript. */
  transcriptCollapseCacheKey?: string | null;
  sessionEnded?: boolean;
  /** True when older transcript pages exist above the loaded events. */
  hasOlderHistory?: boolean;
  /** True while an older transcript page is being fetched. */
  loadingOlderHistory?: boolean;
  /** Retryable error from the most recent older-history request. */
  olderHistoryError?: string | null;
  /** Called when automatic scroll-back needs an older page. */
  onLoadOlderHistory?: () => void;
  /** Called when the user explicitly retries a failed older-history page. */
  onRetryOlderHistory?: () => void;
  /** Called when a detached historical window returns to the live transcript tail. */
  onReturnToLatest?: () => void;
  /** Present only for Claude-family sessions; enables interactive mosaic cards. */
  mosaic?: MosaicRenderContext;
  /** Imperative jump request used by the while-you-were-away wake digest. */
  scrollToRowKeyRequest?: { key: string; requestId: number } | null;
  /** Imperative jump request emitted when composer history selects a prompt. */
  scrollToPromptHistoryRequest?: { eventKey: string; requestId: number } | null;
  /** Intentional proof linked to this chat, rendered at the transcript tail. */
  proofArtifacts?: ComputerUseArtifactView[];
  /** Local Electron can stream larger artifacts through its range protocol. */
  allowLocalProofArtifactProtocol?: boolean;
  onOpenProofDrawer?: () => void;
  /** Opens the drawer's Sources section narrowed to one turn (the turn chip). */
  onOpenTurnSources?: (turnId: string) => void;
}) {
  const chatTranscriptDensity = useAppStore((s) => s.chatTranscriptDensity);
  // The machine label belongs to the CHAT, not to the tab. A Work tab unions
  // chats from every machine, so reading the tab's binding labelled a foreign
  // chat's rows with whichever machine the tab happened to be pointed at.
  const chatScope = useChatRuntimeScope();
  const runtimeName = chatScope.isRemote ? chatScope.machineName : null;
  const timelineRowGapPx = useMemo(() => transcriptRowGapPx(chatTranscriptDensity), [chatTranscriptDensity]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const listRootRef = useRef<HTMLDivElement | null>(null);
  const contentWrapperRef = useRef<HTMLDivElement | null>(null);
  const olderHistorySentinelRef = useRef<HTMLDivElement | null>(null);
  const lastHandledScrollToRowRequestIdRef = useRef<number | null>(null);
  const lastHandledPromptHistoryRequestIdRef = useRef<number | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  // Carries the CollapseTranscriptContext alongside events/rows so appended
  // subagent progress/result events can index back into the previous rows and
  // mutate the anchor by its stored rowIndex (see collapseChatTranscriptRows).
  const resolvedTranscriptCollapseCacheKey = transcriptCollapseCacheKey ?? sessionId;
  const collapseCacheStateRef = useRef<{
    key: string | null | undefined;
    cache: TranscriptCollapseCache;
  } | null>(null);
  let collapseCacheState = collapseCacheStateRef.current;
  if (!collapseCacheState || collapseCacheState.key !== resolvedTranscriptCollapseCacheKey) {
    collapseCacheState = {
      key: resolvedTranscriptCollapseCacheKey,
      cache: readTranscriptCollapseCache(resolvedTranscriptCollapseCacheKey),
    };
    collapseCacheStateRef.current = collapseCacheState;
  }
  // Read once per mount: the pane remounts this component per chat, so this is
  // effectively "the state this chat was left in".
  const resolvedScrollMemoryKey = scrollMemoryKey ?? sessionId;
  const initialScrollMemory = readChatScrollMemory(resolvedScrollMemoryKey);
  const restoredScrollMemoryRef = useRef(initialScrollMemory);
  const [stickToBottom, setStickToBottom] = useState(() => initialScrollMemory?.wasPinnedToBottom ?? true);
  const stickToBottomRef = useRef(initialScrollMemory?.wasPinnedToBottom ?? true);
  // Scroll bookkeeping written from `handleScroll` only — never state, so
  // scrolling stays render-free.
  const lastScrollTopRef = useRef(0);
  const scrollRestoreSettledRef = useRef(false);
  const scrollRestoreCorrectionRafRef = useRef<number | null>(null);
  const pendingScrollRestoreRef = useRef<ScrollRestoreTarget | null>(null);
  // True from mount until a detached reader's position is back and has held
  // for two frames (or they took over). Older-history loading waits for it: a
  // page prepended mid-restore would move the rows the restore is aiming at.
  const scrollRestoreActiveRef = useRef(needsScrollRestore(initialScrollMemory));
  // Automatic older-page requests (sentinel, re-arm, restore settle) since the
  // reader last scrolled. Capped so pages never chain on their own.
  const autoOlderLoadsSinceUserScrollRef = useRef(0);
  // The row list changed while the reader was scrolled up: the rows they were
  // looking at, read from the DOM before the commit, so the layout effect can
  // put them back exactly (see the list anchor effect).
  const pendingListAnchorRef = useRef<PendingListAnchor | null>(null);
  // Row key that was last in the transcript when bottom-follow broke; drives
  // the "N new" count on the jump pill.
  const [detachAnchorRowKey, setDetachAnchorRowKey] = useState<string | null>(
    initialScrollMemory?.wasPinnedToBottom === false ? (initialScrollMemory.lastSeenRowKey ?? null) : null,
  );
  // Measured geometry the minimap rail needs. Kept as two pieces of state so a
  // width-only change and a height-only change don't invalidate each other.
  const [listRootBoxPx, setListRootBoxPx] = useState<{ width: number; height: number }>(
    { width: 0, height: 0 },
  );
  const [columnWidthPx, setColumnWidthPx] = useState(0);
  // Track the single pending rAF handle for scroll-to-bottom writes so we
  // coalesce every source (ResizeObserver, stick-flip effect, jump button)
  // into at most one scrollTop assignment per frame.
  const scrollRafRef = useRef<number | null>(null);
  const scrollFollowFramesRef = useRef(0);
  const lastTouchYRef = useRef<number | null>(null);
  // When the reader last scrolled UP (wheel, touch, key). For a short hold
  // after it the list does not re-pin to the bottom; a scroll-down gesture
  // ends the hold early. See `shouldStickToBottomAfterScroll`.
  const userScrollUpAtRef = useRef<number | null>(null);
  // Programmatic scroll writes can be coalesced by the browser. Track the
  // latest ADE-authored scrollTop target instead of using a counter, so a real
  // user scroll never gets swallowed by stale "programmatic" credits.
  const programmaticScrollTargetRef = useRef<number | null>(null);
  const lastScrollClientHeightRef = useRef(0);
  const scrollToBottomSoonRef = useRef<((followUpFrames?: number) => void) | null>(null);
  // Turn-fold scroll bookkeeping. A fold change moves rows, so the row the
  // reader is looking at is pinned across it (see the fold anchor effect).
  const pendingFoldAnchorRef = useRef<PendingFoldAnchor | null>(null);
  // Fold ids already on screen; null until this view's first fold pass, so a
  // mount or view switch is not mistaken for a turn that just folded.
  const knownTurnFoldIdsRef = useRef<ReadonlySet<string> | null>(null);
  // A jump into a folded row opens the fold first and scrolls once it renders.
  const pendingRevealScrollKeyRef = useRef<string | null>(null);
  // A turn folded while the view followed the bottom: pin before paint.
  const pinAfterTurnFoldRef = useRef(false);
  // Scroll restore opened the fold holding its anchor row (once per view).
  const scrollRestoreRevealRequestedRef = useRef(false);
  const scrollMemoryKeyRef = useRef(resolvedScrollMemoryKey);
  const scrollMemorySnapshotByKeyRef = useRef(new Map<string, ChatScrollMemory>());
  useLayoutEffect(() => {
    const previousKey = scrollMemoryKeyRef.current;
    if (previousKey === resolvedScrollMemoryKey) return;
    if (previousKey) {
      const previousMemory = scrollMemorySnapshotByKeyRef.current.get(previousKey);
      if (previousMemory) rememberChatScrollMemory(previousKey, previousMemory);
    }
    scrollMemoryKeyRef.current = resolvedScrollMemoryKey;
    const nextMemory = readChatScrollMemory(resolvedScrollMemoryKey);
    restoredScrollMemoryRef.current = nextMemory;
    const pinned = nextMemory?.wasPinnedToBottom ?? true;
    stickToBottomRef.current = pinned;
    setStickToBottom(pinned);
    setDetachAnchorRowKey(pinned ? null : nextMemory?.lastSeenRowKey ?? null);
    pendingScrollRestoreRef.current = null;
    scrollRestoreSettledRef.current = false;
    scrollRestoreActiveRef.current = needsScrollRestore(nextMemory);
    autoOlderLoadsSinceUserScrollRef.current = 0;
    pendingListAnchorRef.current = null;
    if (scrollRafRef.current !== null) {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }
    if (scrollRestoreCorrectionRafRef.current !== null) {
      cancelAnimationFrame(scrollRestoreCorrectionRafRef.current);
      scrollRestoreCorrectionRafRef.current = null;
    }
    if (anchorCorrectionRafRef.current !== null) {
      cancelAnimationFrame(anchorCorrectionRafRef.current);
      anchorCorrectionRafRef.current = null;
    }
    if (anchorHighlightTimerRef.current !== null) {
      clearTimeout(anchorHighlightTimerRef.current);
      anchorHighlightTimerRef.current = null;
    }
    pendingChatEventAnchorRef.current = null;
    programmaticScrollTargetRef.current = null;
    pendingFoldAnchorRef.current = null;
    knownTurnFoldIdsRef.current = null;
    pendingRevealScrollKeyRef.current = null;
    pinAfterTurnFoldRef.current = false;
    scrollRestoreRevealRequestedRef.current = false;
    if (pinned) scrollToBottomSoonRef.current?.(2);
  }, [resolvedScrollMemoryKey]);
  const onApprovalRef = useRef(onApproval);
  const resolvedInputStates = useStableIdentity(useMemo(() => {
    const resolved = new Map<string, PendingInputResolution>();
    for (const envelope of events) {
      if (envelope.event.type !== "pending_input_resolved") continue;
      if (!resolved.has(envelope.event.itemId)) {
        resolved.set(envelope.event.itemId, envelope.event.resolution);
      }
    }
    return resolved;
  }, [events]), sameMapContents);
  // What was actually sent, so the answered receipt reads back the choice
  // rather than a bare "answered". Absent on older transcripts and on any
  // question that was secret — the receipt degrades to "answer hidden".
  const resolvedInputAnswers = useStableIdentity(useMemo(() => {
    const answers = new Map<string, Record<string, string | string[]>>();
    for (const envelope of events) {
      if (envelope.event.type !== "pending_input_resolved") continue;
      if (!envelope.event.answers) continue;
      if (!answers.has(envelope.event.itemId)) {
        answers.set(envelope.event.itemId, envelope.event.answers);
      }
    }
    return answers;
  }, [events]), sameMapContents);

  // Virtualization scroll tracking
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const [measurementTick, setMeasurementTick] = useState(0);
  const [anchoredRowKey, setAnchoredRowKey] = useState<string | null>(null);
  const pendingChatEventAnchorRef = useRef<PendingChatEventAnchor | null>(null);
  const anchorHighlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const anchorCorrectionRafRef = useRef<number | null>(null);
  // Map of row key → measured height (filled in lazily as rows render).
  // Keeping this keyed by row identity prevents stale measurements from a
  // previous row at the same index from creating phantom scroll space. Row
  // keys are session-scoped and position-independent, so a prepended page, a
  // front trim, or a snapshot merge keeps every surviving row's height; rows
  // that left are pruned against the current keys below.
  const measuredHeights = useRef<Map<string, number>>(new Map());
  // Per-kind height guesses for rows never measured (see
  // `estimateTranscriptRowHeight`), cached per key and per column-width step.
  const rowEstimatesRef = useRef<{ widthStep: number; byKey: Map<string, number> }>({
    widthStep: -1,
    byKey: new Map(),
  });
  /** Best-known height of a row: measured, else its per-kind estimate. Reads refs only. */
  const heightForKey = useCallback((key: string | undefined): number => {
    if (!key) return ESTIMATED_ROW_HEIGHT;
    return measuredHeights.current.get(key) ?? rowEstimatesRef.current.byKey.get(key) ?? ESTIMATED_ROW_HEIGHT;
  }, []);

  // Mirror older-history props into refs so the stable scroll handler can
  // consult them without re-subscribing.
  const onLoadOlderHistoryRef = useRef(onLoadOlderHistory);
  const hasOlderHistoryRef = useRef(hasOlderHistory);
  const loadingOlderHistoryRef = useRef(loadingOlderHistory);
  const olderHistoryErrorRef = useRef(olderHistoryError);
  useEffect(() => {
    onLoadOlderHistoryRef.current = onLoadOlderHistory;
    hasOlderHistoryRef.current = hasOlderHistory;
    loadingOlderHistoryRef.current = loadingOlderHistory;
    olderHistoryErrorRef.current = olderHistoryError;
  }, [onLoadOlderHistory, hasOlderHistory, loadingOlderHistory, olderHistoryError]);

  /**
   * Ask for the next older page when the reader is within the prefetch runway.
   *
   * `source` says who is asking. A reader's scroll always may. Automatic
   * triggers (the sentinel, the re-arm after a page lands, a settled restore)
   * get one page between two reader scrolls: a prepend that failed to hold the
   * reader's position used to leave them near the top again, the next trigger
   * fired, and pages chained while the thread jumped. An underfilled pane has
   * no scrollbar to scroll, so it keeps backfilling until it fills. Nothing
   * loads while a scroll restore is still landing.
   */
  const maybeRequestOlderHistory = useCallback((
    scrollTopNow: number,
    source: "reader" | "auto" | "underfill",
  ) => {
    // Two viewport-heights of runway, falling back to the near-top threshold
    // before the pane has been measured. See PREFETCH_OLDER_VIEWPORT_HEIGHTS.
    if (scrollTopNow > resolveOlderHistoryPrefetchTriggerPx(scrollRef.current?.clientHeight ?? 0)) return;
    if (
      !hasOlderHistoryRef.current
      || loadingOlderHistoryRef.current
      || olderHistoryErrorRef.current
    ) return;
    // An underfilled pane has nothing to restore into; let it fill.
    if (scrollRestoreActiveRef.current && source !== "underfill") return;
    if (source === "auto") {
      if (autoOlderLoadsSinceUserScrollRef.current >= MAX_CHAINED_AUTO_OLDER_PAGES) return;
      autoOlderLoadsSinceUserScrollRef.current += 1;
    }
    onLoadOlderHistoryRef.current?.();
  }, []);

  // Re-arm after a batch that changed nothing visible.
  //
  // A capped batch (maxAnchorEvents) can advance the cursor while every event it
  // returned folds into an already-rendered row or is a `work_log_group` row the
  // timeline drops — so `groupedRows` and scroll geometry are unchanged. The
  // sentinel is then still intersecting, and IntersectionObserver only fires on
  // a CHANGE in intersection, so no further callback arrives; the underfill
  // effect does not apply to a normally scrollable thread either. Without this,
  // paging stalls until the reader scrolls again.
  //
  // Keyed strictly on the load COMPLETING (true -> false), not on transcript
  // identity: `events` changes on every streaming delta, and re-arming on that
  // would keep paging a thread the reader is merely parked at the top of.
  const wasLoadingOlderHistoryRef = useRef(false);
  useEffect(() => {
    const finishedLoading = wasLoadingOlderHistoryRef.current && !loadingOlderHistory;
    wasLoadingOlderHistoryRef.current = loadingOlderHistory;
    if (!finishedLoading || !hasOlderHistory || olderHistoryError) return;
    const root = scrollRef.current;
    if (!root) return;
    if (root.scrollTop > resolveOlderHistoryPrefetchTriggerPx(root.clientHeight)) return;
    maybeRequestOlderHistory(root.scrollTop, "auto");
  }, [loadingOlderHistory, hasOlderHistory, olderHistoryError, maybeRequestOlderHistory]);

  useEffect(() => {
    const root = scrollRef.current;
    const sentinel = olderHistorySentinelRef.current;
    if (!root || !sentinel || !hasOlderHistory || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        maybeRequestOlderHistory(root.scrollTop, "auto");
      }
    }, {
      root,
      // Same runway as the scroll-handler path, so whichever notices first
      // starts the fetch at the same distance from the top.
      rootMargin: `${resolveOlderHistoryPrefetchTriggerPx(root.clientHeight)}px 0px 0px`,
      threshold: 0,
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
    // `containerHeight` re-arms the observer after a resize (and after the first
    // measurement) so its runway does not stay latched at the 300px fallback.
  }, [containerHeight, hasOlderHistory, maybeRequestOlderHistory]);

  useEffect(() => {
    onApprovalRef.current = onApproval;
  }, [onApproval]);

  useLayoutEffect(() => {
    pendingChatEventAnchorRef.current = null;
    setAnchoredRowKey(null);
  }, [sessionId]);

  useEffect(() => () => {
    if (anchorHighlightTimerRef.current) {
      clearTimeout(anchorHighlightTimerRef.current);
      anchorHighlightTimerRef.current = null;
    }
    if (anchorCorrectionRafRef.current !== null) {
      cancelAnimationFrame(anchorCorrectionRafRef.current);
      anchorCorrectionRafRef.current = null;
    }
    if (scrollRestoreCorrectionRafRef.current !== null) {
      cancelAnimationFrame(scrollRestoreCorrectionRafRef.current);
      scrollRestoreCorrectionRafRef.current = null;
    }
  }, []);

  const handleApproval = useCallback((itemId: string, decision: AgentChatApprovalDecision, responseText?: string | null, answers?: Record<string, string | string[]>) => {
    onApprovalRef.current?.(itemId, decision, responseText, answers);
  }, []);

  const rows = useMemo(() => {
    const cached = collapseCacheState.cache;
    const { rows: nextRows, context } = collapseChatTranscriptEventsIncrementalWithContext(
      events,
      cached.events,
      cached.rows,
      cached.context,
    );
    const nextCache = { events, rows: nextRows, context };
    collapseCacheState.cache = nextCache;
    writeTranscriptCollapseCache(resolvedTranscriptCollapseCacheKey, nextCache);
    return nextRows;
  }, [collapseCacheState, events, resolvedTranscriptCollapseCacheKey]);
  const assistantTurnCopyByRowKey = useMemo(() => {
    const byRowKey = new Map<string, AssistantTurnCopyInfo>();
    for (const info of deriveAssistantTurnCopyMap(rows).values()) {
      if (info.textEventCount >= 2) byRowKey.set(info.lastTextEventKey, info);
    }
    return byRowKey;
  }, [rows]);
  const previousAllGroupedRowsRef = useRef<readonly TranscriptGroupedEnvelope[]>([]);
  const allGroupedRows = useMemo(
    // Drop automatic context-usage snapshots and same-provider "handoffs"
    // before grouping: an empty (null-rendered) row still consumes a
    // `--chat-row-gap` on each side, and leaving it in the group input also
    // broke activity phases — two Thinking rows separated only by a hidden
    // `context_usage` row stayed two rows instead of merging into one.
    () => {
      const next = groupChatTranscriptRows(
        filterVisibleTranscriptRows(rows),
        previousAllGroupedRowsRef.current,
      );
      previousAllGroupedRowsRef.current = next;
      return next;
    },
    [rows],
  );
  // Same lookup-map shape as turnProofByRowKey / turnEndDurationByRowKey rather
  // than rescanning the summaries once per rendered row.
  const checkpointDiffTurnIds = useMemo(
    () => new Set((turnDiffSummaries ?? []).map((summary) => summary.turnId)),
    [turnDiffSummaries],
  );
  const {
    activeTurnId,
    activeTurnStartedAt,
    activeProviderRetryActivity,
    latestActivity,
    transcriptToolActivity,
    turnStartedAtMs,
  } = useTranscriptPresentation({
    events,
    rows: allGroupedRows,
    showStreamingIndicator,
    sessionEnded,
  });
  const doneTurnIds = useMemo(() => {
    const ids = new Set<string>();
    for (const row of allGroupedRows) {
      if (row.event.type === "done" && row.event.turnId) ids.add(row.event.turnId);
    }
    return ids;
  }, [allGroupedRows]);
  // Row keys that were live when their turn ended. Consecutive background jobs
  // group only with jobs that share that fate, so the fold can hide the ones
  // that finished and keep the ones still running (`groupBackgroundJobRuns`).
  const turnEndLiveRowKeys = useStableIdentity(
    useMemo(
      () => collectTurnEndLiveRowKeys(readTurnEndSnapshots(collapseCacheState.cache.context)),
      [collapseCacheState, rows],
    ),
    sameSetContents,
  );
  const previousPresentedRowsRef = useRef<readonly TranscriptGroupedEnvelope[]>([]);
  const presentedRows = useMemo(
    // `work_log_group` rows no longer render anything in the timeline: tool
    // calls are shown by the working indicator / done divider, and file changes
    // are summarized ONCE per turn at the done divider instead of once per
    // burst. A checkpoint `turn_diff_summary` folds into that same line when
    // the turn has a done row. Dropping the rows outright (rather than
    // rendering an empty block) keeps them from consuming a `--chat-row-gap`.
    // Consecutive same-kind subagent cards then join one side-by-side grid row
    // keyed by its first card (`groupSubagentCardGrids`). That runs here, on
    // the drawn rows and before the turn fold, so hidden rows never split a
    // run and the fold sees one kept row per grid. Consecutive background job
    // lines join one compact row the same way (`groupBackgroundJobRuns`).
    () => {
      const previous = previousPresentedRowsRef.current;
      const next = groupBackgroundJobRuns(groupSubagentCardGrids(mergeAdjacentActivityBundleRows(
        allGroupedRows.filter((row) => {
        if (row.event.type === "work_log_group") return false;
        if (
          row.event.type === "turn_diff_summary"
          && row.event.turnId
          && doneTurnIds.has(row.event.turnId)
        ) return false;
        return true;
      }),
      ), previous), turnEndLiveRowKeys, previous);
      previousPresentedRowsRef.current = next;
      return next;
    },
    [allGroupedRows, doneTurnIds, turnEndLiveRowKeys],
  );
  // A card drawn inside a grid row answers to that row: jumps, highlights, and
  // event anchors that name the card land on its grid.
  const subagentGridKeyByMemberKey = useMemo(
    () => subagentCardGridKeyByMemberKey(presentedRows),
    [presentedRows],
  );
  const subagentGridKeyByMemberKeyRef = useRef(subagentGridKeyByMemberKey);
  subagentGridKeyByMemberKeyRef.current = subagentGridKeyByMemberKey;
  // Likewise a job line drawn inside a background-job group row.
  const backgroundJobGroupKeyByMemberKeyRef = useRef<Map<string, string>>(new Map());
  backgroundJobGroupKeyByMemberKeyRef.current = useMemo(
    () => deriveBackgroundJobGroupKeyByMemberKey(presentedRows),
    [presentedRows],
  );
  // ── Turn fold ──
  // A finished turn's intermediate work folds into one `Worked for …` row
  // (rules: shared/chatTurnFold.ts). Derived in one O(n) pass per rows
  // identity; the keep-visible decisions read the turn-end snapshots the
  // collapse pass recorded when each `done` arrived, so they never move later.
  const turnFolds = useStableIdentity(
    useMemo(
      () => deriveChatTranscriptTurnFolds(
        presentedRows,
        readTurnEndSnapshots(collapseCacheState.cache.context),
      ),
      [collapseCacheState, presentedRows],
    ),
    sameTurnFolds,
  );
  // Unfolded row keys: the logical order jumps, the fork divider, the "N new"
  // count, and the measured-height cache work in. Stable across pure content
  // deltas, like `groupedRowKeys` below.
  const presentedRowKeys = useStableIdentity(
    useMemo(() => presentedRows.map((row) => row.key), [presentedRows]),
    sameKeyList,
  );
  const foldIdByHiddenRowKey = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const fold of turnFolds) {
      for (const key of fold.hiddenKeys) byKey.set(key, fold.foldId);
    }
    return byKey;
  }, [turnFolds]);
  // `done` rows whose tool/file counts moved up to their turn's fold row. By
  // row key, not turn id: an id-less `done` folds under an inferred id.
  const foldedTurnEndKeys = useMemo(
    () => new Set(turnFolds.map((fold) => fold.turnEndKey)),
    [turnFolds],
  );
  const [openTurnFoldsState, setOpenTurnFoldsState] = useState(() => ({
    viewKey: resolvedScrollMemoryKey ?? null,
    open: readOpenTurnFolds(resolvedScrollMemoryKey),
  }));
  // A nested transcript (drilled-in subagent) reuses this mount with a new
  // view key; its folds start from that view's own memory.
  const openTurnFolds = openTurnFoldsState.viewKey === (resolvedScrollMemoryKey ?? null)
    ? openTurnFoldsState.open
    : readOpenTurnFolds(resolvedScrollMemoryKey);
  const openTurnFoldsRef = useRef(openTurnFolds);
  openTurnFoldsRef.current = openTurnFolds;
  const turnFoldViewKeyRef = useRef(resolvedScrollMemoryKey ?? null);
  turnFoldViewKeyRef.current = resolvedScrollMemoryKey ?? null;
  const setTurnFoldOpen = useCallback((foldId: string, open: boolean) => {
    const current = openTurnFoldsRef.current;
    if (current.has(foldId) === open) return;
    const next = new Set(current);
    if (open) next.add(foldId);
    else next.delete(foldId);
    openTurnFoldsRef.current = next;
    rememberOpenTurnFolds(turnFoldViewKeyRef.current, next);
    setOpenTurnFoldsState({ viewKey: turnFoldViewKeyRef.current, open: next });
  }, []);
  /** Opens the closed fold hiding `rowKey`; true when that changed anything. */
  const foldIdByHiddenRowKeyRef = useRef(foldIdByHiddenRowKey);
  foldIdByHiddenRowKeyRef.current = foldIdByHiddenRowKey;
  // An earlier text row that repeats its turn's answer is never drawn, even in
  // an open fold; a jump to it lands on the answer.
  const answerKeyByDuplicateKeyRef = useRef<Map<string, string>>(new Map());
  answerKeyByDuplicateKeyRef.current = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const fold of turnFolds) {
      for (const key of fold.duplicateAnswerKeys) byKey.set(key, fold.answerKey);
    }
    return byKey;
  }, [turnFolds]);
  const revealTurnFoldRow = useCallback((rowKey: string): boolean => {
    const foldId = foldIdByHiddenRowKeyRef.current.get(rowKey);
    if (!foldId || openTurnFoldsRef.current.has(foldId)) return false;
    setTurnFoldOpen(foldId, true);
    return true;
  }, [setTurnFoldOpen]);
  const previousFoldRowsRef = useRef<ReadonlyMap<string, TranscriptGroupedEnvelope>>(new Map());
  const previousThoughtRunRowsRef = useRef<ReadonlyMap<string, TranscriptGroupedEnvelope>>(new Map());
  // The reasoning row that draws the live ThinkingPreview: the newest row of
  // the live turn, read from the rows BEFORE work-log groups leave the drawn
  // timeline so a tool starting after the thought collapses it.
  const liveThinkingRowKey = useMemo(
    () => (showStreamingIndicator && !sessionEnded ? deriveLiveThinkingRowKey(allGroupedRows, activeTurnId) : null),
    [activeTurnId, allGroupedRows, sessionEnded, showStreamingIndicator],
  );
  // A stop receipt auto-collapses once its queued messages have run — best-effort:
  // once a *later* turn (different turnId, i.e. the next turn) completes. The
  // interrupted turn's own `done` does not count.
  const staleInterruptReceipts = useStableIdentity(useMemo(() => {
    const stale = new Set<string>();
    const pending: { identity: string; turnId: string | undefined; donesAfter: number }[] = [];
    for (const envelope of events) {
      const evt = envelope.event;
      if (evt.type === "interrupt_receipt") {
        pending.push({ identity: interruptReceiptIdentity(evt), turnId: evt.turnId, donesAfter: 0 });
      } else if (evt.type === "done") {
        for (const p of pending) {
          if (stale.has(p.identity)) continue;
          if (p.turnId && evt.turnId && evt.turnId !== p.turnId) {
            stale.add(p.identity);
          } else if (p.turnId && evt.turnId === p.turnId) {
            // Interrupted turn's own done — wait for the next turn.
          } else {
            // Missing turnId on either side: fall back to "second done after".
            p.donesAfter += 1;
            if (p.donesAfter >= 2) stale.add(p.identity);
          }
        }
      }
    }
    return stale;
  }, [events]), sameSetContents);
  // What decides that a row draws nothing (`transcriptEventDrawsNothing`):
  // `renderEvent` and the Thought-run merge read the same answer.
  const rowDrawContext = useMemo<TranscriptRowDrawContext>(
    () => ({ staleInterruptReceipts, usageLimitResumeActive }),
    [staleInterruptReceipts, usageLimitResumeActive],
  );
  // The rows the timeline draws: every fold applied, then Thought rows that
  // ended up next to each other (the rows between them are not drawn: tools,
  // an open fold's duplicate answer) merged into one (`mergeAdjacentThoughtRows`).
  // Everything below — virtualization, measured heights, scroll anchoring, the
  // minimap, jumps — works on this list, so a folded row is simply not a row
  // until revealed, and a merged Thought member answers to its merged row.
  const groupedRows = useMemo(() => {
    const folded = applyChatTranscriptTurnFolds(
      presentedRows,
      turnFolds,
      openTurnFolds,
      previousFoldRowsRef.current,
    );
    const foldRows = new Map<string, TranscriptGroupedEnvelope>();
    if (turnFolds.length) {
      for (const row of folded) if (row.event.type === "turn_fold") foldRows.set(row.key, row);
    }
    previousFoldRowsRef.current = foldRows;
    const next = mergeAdjacentThoughtRows(folded, previousThoughtRunRowsRef.current, rowDrawContext);
    previousThoughtRunRowsRef.current = next === folded ? new Map() : collectMergedThoughtRows(next);
    return next;
  }, [openTurnFolds, presentedRows, rowDrawContext, turnFolds]);
  // A Thought row merged into the row before it answers to that row: jumps,
  // highlights, event anchors, inline proof, and scroll-memory anchors that
  // name it land on the merged row.
  const thoughtRunKeyByMemberKeyRef = useRef<Map<string, string>>(new Map());
  const thoughtRunKeyByMember = useStableIdentity(
    useMemo(() => thoughtRunKeyByMemberKey(groupedRows), [groupedRows]),
    sameMapContents,
  );
  thoughtRunKeyByMemberKeyRef.current = thoughtRunKeyByMember;
  // The drawn row that shows the live preview: the streaming thought's own row,
  // or the Thought run it joined (keyed by the run's first member).
  const liveThinkingDrawnKey = liveThinkingRowKey
    ? thoughtRunKeyByMember.get(liveThinkingRowKey) ?? liveThinkingRowKey
    : null;
  // `groupedRows` gets a fresh array on every streaming delta (the streaming row
  // is rebuilt), but the ROW KEYS only move when rows are added, removed or
  // regrouped. Reusing the previous key array on a pure content delta keeps
  // `rowHeight` — and therefore `handleMeasure`, and therefore every row's
  // ResizeObserver — from being recreated on each token flush. When the keys do
  // change, the fresh array is returned and every downstream memo/effect
  // recomputes exactly as before.
  const groupedRowKeys = useStableIdentity(
    useMemo(() => {
      const keys = groupedRows.map((row) => row.key);
      if (import.meta.env.DEV) warnOnDuplicateRowKeys(keys);
      return keys;
    }, [groupedRows]),
    sameKeyList,
  );
  const backgroundJobGroupKeyByMemberKey = backgroundJobGroupKeyByMemberKeyRef.current;
  const answerKeyByDuplicateKey = answerKeyByDuplicateKeyRef.current;
  const drawnRowKeyIndex = useMemo(() => buildDrawnRowKeyIndex(groupedRows, [
    subagentGridKeyByMemberKey,
    backgroundJobGroupKeyByMemberKey,
    answerKeyByDuplicateKey,
    thoughtRunKeyByMember,
    foldIdByHiddenRowKey,
  ]), [
    answerKeyByDuplicateKey,
    backgroundJobGroupKeyByMemberKey,
    foldIdByHiddenRowKey,
    groupedRows,
    subagentGridKeyByMemberKey,
    thoughtRunKeyByMember,
  ]);
  const drawnRowKeyIndexRef = useRef(drawnRowKeyIndex);
  drawnRowKeyIndexRef.current = drawnRowKeyIndex;
  // Mirrored for the render-free paths (scroll handler, unmount snapshot) that
  // must not re-subscribe every time the transcript grows.
  const groupedRowKeysRef = useRef<readonly string[]>(groupedRowKeys);
  const timelineRowGapPxRef = useRef(timelineRowGapPx);
  timelineRowGapPxRef.current = timelineRowGapPx;
  // Per-kind estimates for rows that have never been measured. Computed once
  // per new key (and again only when the column width moves a full step), so an
  // unmeasured row's model height never drifts under the virtualizer. Added
  // before the anchors below read heights; pruned with the measured heights.
  const estimateColumnWidthPx = columnWidthPx > 0 ? columnWidthPx : ESTIMATE_DEFAULT_COLUMN_WIDTH_PX;
  const estimateWidthStep = Math.round(estimateColumnWidthPx / ESTIMATE_WIDTH_STEP_PX);
  const lastEstimateSourcesRef = useRef<{
    grouped: readonly string[];
    presented: readonly string[];
    widthStep: number;
  } | null>(null);
  if (
    lastEstimateSourcesRef.current?.grouped !== groupedRowKeys
    || lastEstimateSourcesRef.current?.presented !== presentedRowKeys
    || lastEstimateSourcesRef.current?.widthStep !== estimateWidthStep
  ) {
    const estimates = rowEstimatesRef.current;
    if (estimates.widthStep !== estimateWidthStep) {
      estimates.byKey.clear();
      estimates.widthStep = estimateWidthStep;
    }
    for (const list of [presentedRows, groupedRows]) {
      for (const row of list) {
        if (!estimates.byKey.has(row.key)) {
          estimates.byKey.set(row.key, estimateTranscriptRowHeight(row, estimateColumnWidthPx));
        }
      }
    }
    lastEstimateSourcesRef.current = { grouped: groupedRowKeys, presented: presentedRowKeys, widthStep: estimateWidthStep };
  }
  // A turn that just ended folds rows the reader may be looking at. Following
  // the bottom pins the tail again before paint; a reader scrolled up keeps the
  // first on-screen row (or the fold that swallowed it) where it was. The
  // position is read here, from the previous commit's DOM and keys
  // (`groupedRowKeysRef` still holds them), because by the layout effect the
  // rows are already gone.
  const lastFoldPassRef = useRef<readonly unknown[] | null>(null);
  if (lastFoldPassRef.current !== turnFolds) {
    lastFoldPassRef.current = turnFolds;
    const known = knownTurnFoldIdsRef.current;
    knownTurnFoldIdsRef.current = new Set(turnFolds.map((fold) => fold.foldId));
    const container = scrollRef.current;
    const newFolds = known ? turnFolds.filter((fold) => !known.has(fold.foldId)) : [];
    if (newFolds.length && container) {
      if (stickToBottomRef.current) {
        pinAfterTurnFoldRef.current = true;
      } else if (!pendingFoldAnchorRef.current) {
        const first = readFirstVisibleChatRow(container);
        if (first) {
          const swallowing = newFolds.find((fold) => (
            fold.hiddenKeys.has(first.key) && !openTurnFolds.has(fold.foldId)
          ));
          const previousKeys = groupedRowKeysRef.current;
          const previousIndex = previousKeys.indexOf(first.key);
          const previousOffsets = previousIndex >= 0
            ? computeRowStartOffsets(
                previousIndex + 1,
                (index) => heightForKey(previousKeys[index]),
                timelineRowGapPx,
              )
            : null;
          pendingFoldAnchorRef.current = {
            key: swallowing ? swallowing.foldId : first.key,
            top: first.top,
            modelTop: previousOffsets ? previousOffsets[previousIndex]! - container.scrollTop : null,
            wasStuck: false,
            fromToggle: false,
          };
        }
      }
    }
  }
  // Any other change to the drawn rows while the reader is scrolled up (an older
  // page prepended, a trim, a merge, a regroup) keeps the rows on screen where
  // they are. Read here, before the commit replaces the DOM; applied by the
  // list anchor layout effect. Stands down for the paths that place the view
  // themselves: bottom-follow, a fold change, a jump, a restore.
  if (groupedRowKeysRef.current !== groupedRowKeys) {
    const container = scrollRef.current;
    if (
      container
      && !stickToBottomRef.current
      && !pendingFoldAnchorRef.current
      && !pendingRevealScrollKeyRef.current
      && !pendingChatEventAnchorRef.current
      && !scrollRestoreActiveRef.current
    ) {
      // The task-list row MOVES (to the turn of its latest update) rather than
      // staying put, so it can never be what holds the reader's place: anchoring
      // to it would follow it down the thread.
      const visible = readVisibleChatRows(container, 5).filter((row) => !isTaskListRowKey(row.key)).slice(0, 4);
      if (visible.length) {
        const previousKeys = groupedRowKeysRef.current;
        let model: PendingListAnchor["model"] = null;
        let windowScrollTop: number | null = null;
        for (const row of visible) {
          const previousIndex = previousKeys.indexOf(row.key);
          const nextIndex = previousIndex >= 0 ? groupedRowKeys.indexOf(row.key) : -1;
          if (nextIndex < 0) continue;
          const previousOffset = computeRowStartOffsets(
            previousIndex + 1,
            (index) => heightForKey(previousKeys[index]),
            timelineRowGapPx,
          )[previousIndex]!;
          const nextOffset = computeRowStartOffsets(
            nextIndex + 1,
            (index) => heightForKey(groupedRowKeys[index]),
            timelineRowGapPx,
          )[nextIndex]!;
          model = { key: row.key, modelTop: previousOffset - container.scrollTop };
          windowScrollTop = Math.max(0, container.scrollTop + nextOffset - previousOffset);
          break;
        }
        pendingListAnchorRef.current = { rows: visible, model, windowScrollTop };
      }
    }
  }
  groupedRowKeysRef.current = groupedRowKeys;
  // The fork divider belongs between two LOGICAL rows. When its row is hidden in
  // a closed fold it draws on that fold's row instead: the fold row takes the
  // place of its span's first row, and the first live row after fork history is
  // (in practice) the first row of a fresh turn window, so the divider keeps its
  // exact position. It returns to its own row when the fold opens.
  const forkHistoryDividerLogicalKey = useMemo(
    () => computeForkHistoryDividerRowKey(events, presentedRowKeys),
    [events, presentedRowKeys],
  );
  const forkHistoryDividerRowKey = useMemo(() => {
    if (!forkHistoryDividerLogicalKey) return null;
    const foldId = foldIdByHiddenRowKey.get(forkHistoryDividerLogicalKey);
    if (foldId && !openTurnFolds.has(foldId)) return foldId;
    return thoughtRunKeyByMember.get(forkHistoryDividerLogicalKey) ?? forkHistoryDividerLogicalKey;
  }, [foldIdByHiddenRowKey, forkHistoryDividerLogicalKey, openTurnFolds, thoughtRunKeyByMember]);
  // Measured heights are kept for every LOGICAL row (plus fold rows), not just
  // the drawn ones: a row hidden by a closed fold keeps its height, so opening
  // the fold again lays out on real heights instead of estimates.
  const prevMeasuredKeySourcesRef = useRef<{ keys: readonly string[]; folds: readonly unknown[] } | null>(null);
  if (
    prevMeasuredKeySourcesRef.current?.keys !== presentedRowKeys
    || prevMeasuredKeySourcesRef.current?.folds !== turnFolds
  ) {
    const liveKeys = new Set(presentedRowKeys);
    for (const fold of turnFolds) liveKeys.add(fold.foldId);
    for (const key of measuredHeights.current.keys()) {
      if (!liveKeys.has(key)) measuredHeights.current.delete(key);
    }
    for (const key of rowEstimatesRef.current.byKey.keys()) {
      if (!liveKeys.has(key)) rowEstimatesRef.current.byKey.delete(key);
    }
    prevMeasuredKeySourcesRef.current = { keys: presentedRowKeys, folds: turnFolds };
  }
  // Streaming-text paint smoothness (perf runs only). `showStreamingIndicator`
  // is the same turn-active signal that drives the WorkingIndicator, so the rAF
  // loop lives exactly as long as a turn is streaming — never while idle.
  useStreamSmoothnessSampler(showStreamingIndicator && !sessionEnded, sessionId ?? null);

  /*
    The one row whose growth is paced: the trailing assistant text row of a
    streaming turn on a main transcript. Subagent transcript views opt out
    entirely (`textPacingEnabled={false}`) — they get the cheap
    paint-on-arrival path, as do ended sessions and idle turns.

    The scan is bounded to the last few rows so it stays O(1) per delta: a text
    row buried behind a dozen tool rows is no longer the row that grows.
  */
  const pacedTextRowKey = useMemo(() => {
    if (!textPacingEnabled || !showStreamingIndicator || sessionEnded) return null;
    const floor = Math.max(0, groupedRows.length - PACED_TEXT_ROW_SCAN_DEPTH);
    for (let index = groupedRows.length - 1; index >= floor; index -= 1) {
      const row = groupedRows[index];
      if (row?.event.type === "text") return row.key;
    }
    return null;
  }, [groupedRows, sessionEnded, showStreamingIndicator, textPacingEnabled]);

  const settledQueueRecoveryIds = useStableIdentity(useMemo(() => new Set(
    events.flatMap(({ event }) =>
      event.type === "queue_recovery" && event.state !== "available"
        ? [event.recoveryId]
        : []),
  ), [events]), sameSetContents);

  const locationLaneId = typeof (location.state as { laneId?: unknown } | null)?.laneId === "string"
    ? (location.state as { laneId: string }).laneId
    : null;
  const currentLaneId = laneId ?? locationLaneId;

  const workspacePaths = useWorkspacePathOpener({
    laneId: currentLaneId,
    navigate,
    runtimePin,
    onOpened: onOpenWorkspacePath,
  });
  const openWorkspacePath = workspacePaths.openWorkspacePath;

  const handleNavigateSuggestion = useCallback((suggestion: OperatorNavigationSuggestion) => {
    navigate(suggestion.href);
  }, [navigate]);

  const turnModelStateRef = useRef<DerivedTurnModelState | null>(null);
  const turnModelState = useMemo(() => {
    const nextState = deriveTurnModelState(events, turnModelStateRef.current);
    turnModelStateRef.current = nextState;
    return nextState;
  }, [events]);
  const turnSummary = useMemo(() => deriveTurnSummary(events, turnModelState), [events, turnModelState]);
  // Per-turn worked-for duration, keyed by grouped-row index, derived from the
  // universal `done` event (runtime-agnostic — no reliance on turnId).
  const turnEndDurationByRowKey = useMemo(
    () => deriveTurnEndDurations(allGroupedRows, turnStartedAtMs),
    [allGroupedRows, turnStartedAtMs],
  );

  /**
   * Proof captured during each turn, keyed by the turn's `done` row.
   *
   * Proof itself renders inline where it was captured (an `ade_card` row), so
   * this is only the turn summary's "N proof" chip — a way back to the drawer
   * from the turn that produced the capture, not a second copy of the artifacts.
   * Bucketing is by wall clock because artifacts carry `createdAt`, not turnId.
   */
  /**
   * Thumbnail source for inline proof. The stored `uri` is project-relative
   * (`.ade/artifacts/...`), and the `ade-artifact://project/` handler resolves
   * exactly that against the chat's project root (named in the URL) — so a local project gets real
   * previews synchronously, with no per-tile IPC. A remote project has no such
   * handler, so tiles fall back to their kind label and the drawer (which reads
   * bytes over the runtime) stays the way to view them.
   */
  const resolveProofThumbnailSrc = useCallback((artifact: ComputerUseArtifactView): string | null => {
    if (!allowLocalProofArtifactProtocol) return null;
    return artifactImageSrc(artifact.uri, chatScope.rootPath);
  }, [allowLocalProofArtifactProtocol, chatScope.rootPath]);

  const turnProofTimeline = useMemo(() => {
    const byDoneRowKey = new Map<string, ComputerUseArtifactView[]>();
    const inlineByRowKey = new Map<string, ComputerUseArtifactView[]>();
    if (!proofArtifacts.length) {
      return { byDoneRowKey, inlineByRowKey, unanchored: EMPTY_PROOF_ARTIFACTS };
    }
    const stamped = proofArtifacts
      .map((artifact) => ({ artifact, at: Date.parse(artifact.createdAt) }))
      .filter((entry) => Number.isFinite(entry.at))
      .sort((left, right) => left.at - right.at);
    if (!stamped.length) {
      return { byDoneRowKey, inlineByRowKey, unanchored: EMPTY_PROOF_ARTIFACTS };
    }
    const loadedTranscriptStart = allGroupedRows.reduce((earliest, env) => {
      const at = Date.parse(env.timestamp);
      return Number.isFinite(at) ? Math.min(earliest, at) : earliest;
    }, Number.POSITIVE_INFINITY);
    if (!Number.isFinite(loadedTranscriptStart)) {
      return {
        byDoneRowKey,
        inlineByRowKey,
        // With no loaded rows, an older page means this is not the transcript
        // boundary. Do not pull unknown historic proof into the visible tail.
        unanchored: hasOlderHistory ? EMPTY_PROOF_ARTIFACTS : stamped.map((entry) => entry.artifact),
      };
    }
    const visibleStamped = stamped.filter((entry) => entry.at >= loadedTranscriptStart);
    const assignedIds = new Set<string>();
    let turnStartMs: number | null = null;
    for (const env of allGroupedRows) {
      const rowMs = Date.parse(env.timestamp);
      if (!Number.isFinite(rowMs)) continue;
      if (
        turnStartMs == null
        && (getGroupedTurnId(env) != null || env.event.type === "user_message")
      ) {
        turnStartMs = rowMs;
      }
      if (env.event.type !== "done") continue;
      const endMs = rowMs;
      const startMs = turnStartMs ?? endMs;
      const captured = visibleStamped
        .filter((entry) => entry.at >= startMs && entry.at <= endMs)
        .map((entry) => entry.artifact);
      if (captured.length > 0) {
        byDoneRowKey.set(env.key, captured);
        for (const artifact of captured) assignedIds.add(artifact.id);
      }
      turnStartMs = null;
    }

    // Anchored on the unfolded rows so opening or closing a fold never moves
    // proof between rows; `inlineProofByRowKey` below lifts proof whose row is
    // hidden onto the fold row.
    const visibleRows = presentedRows
      .map((row) => ({ row, at: Date.parse(row.timestamp) }))
      .filter((entry) => Number.isFinite(entry.at))
      .sort((left, right) => left.at - right.at);
    const unanchored: ComputerUseArtifactView[] = [];
    for (const entry of visibleStamped) {
      if (assignedIds.has(entry.artifact.id)) continue;
      let anchorKey: string | null = null;
      for (const row of visibleRows) {
        if (row.at > entry.at) break;
        anchorKey = row.row.key;
      }
      if (!anchorKey) {
        unanchored.push(entry.artifact);
        continue;
      }
      const existing = inlineByRowKey.get(anchorKey) ?? [];
      existing.push(entry.artifact);
      inlineByRowKey.set(anchorKey, existing);
    }

    return {
      byDoneRowKey,
      inlineByRowKey,
      unanchored,
    };
  }, [allGroupedRows, presentedRows, hasOlderHistory, proofArtifacts]);
  const turnProofByRowKey = turnProofTimeline.byDoneRowKey;
  // Sources the agent used per turn: the turn-end chip and the fold count.
  // A turn's list keeps its identity while its sources are unchanged, so a
  // streaming delta does not re-render every memoized turn-end row.
  const turnSourcesCacheRef = useRef<Map<string, ChatSource[]>>(new Map());
  const turnSourcesByTurnId = useMemo(() => {
    const previous = turnSourcesCacheRef.current;
    const next = new Map<string, ChatSource[]>();
    const derived = chatSources ?? deriveChatSources(events, { provider: sessionProvider });
    for (const [turnId, list] of derived.byTurn) {
      const prior = previous.get(turnId);
      next.set(turnId, prior && sameChatSourceList(prior, list) ? prior : list);
    }
    turnSourcesCacheRef.current = next;
    return next;
  }, [chatSources, events, sessionProvider]);
  // Proof stays visible when its row folds: it draws on the fold row.
  // Likewise proof anchored on a Thought row that merged into the one before it
  // draws on the merged row.
  const inlineProofByRowKey = useMemo(() => {
    const byRowKey = turnProofTimeline.inlineByRowKey;
    if (!byRowKey.size || (!foldIdByHiddenRowKey.size && !thoughtRunKeyByMember.size)) return byRowKey;
    let lifted: Map<string, ComputerUseArtifactView[]> | null = null;
    for (const [rowKey, artifacts] of byRowKey) {
      const foldId = foldIdByHiddenRowKey.get(rowKey);
      const closedFoldId = foldId && !openTurnFolds.has(foldId) ? foldId : null;
      const thoughtKey = thoughtRunKeyByMember.get(rowKey);
      const target = closedFoldId ?? (thoughtKey && thoughtKey !== rowKey ? thoughtKey : null);
      if (!target) continue;
      lifted ??= new Map(byRowKey);
      lifted.delete(rowKey);
      lifted.set(target, [...(lifted.get(target) ?? []), ...artifacts]);
    }
    return lifted ?? byRowKey;
  }, [foldIdByHiddenRowKey, openTurnFolds, thoughtRunKeyByMember, turnProofTimeline.inlineByRowKey]);
  const unanchoredProofArtifacts = turnProofTimeline.unanchored;

  // Opens the Files tab for this chat's lane. It is NOT a revert: reverting is
  // checkpoint-scoped and lives on the `turn_diff_summary` panel, which has the
  // before/after SHAs. It also must not gate on the LATEST turn's file count —
  // every done divider in the thread renders this, so that gate made the
  // control a silent no-op on every turn but the last.
  const handleReviewChanges = useCallback(() => {
    const state = currentLaneId ? { laneId: currentLaneId } : undefined;
    navigate("/files", state ? { state } : undefined);
  }, [currentLaneId, navigate]);

  useEffect(() => {
    stickToBottomRef.current = stickToBottom;
  }, [stickToBottom]);

  const pinScrollToBottomNow = useCallback((el: HTMLElement) => {
    const pinTarget = Math.max(0, el.scrollHeight - el.clientHeight);
    const before = el.scrollTop;
    if (Math.abs(before - pinTarget) < 1) return;
    el.scrollTop = pinTarget;
    programmaticScrollTargetRef.current = el.scrollTop;
    setScrollTop(el.scrollTop);
  }, []);

  const measureScrollContainerHeight = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nextHeight = el.clientHeight;
    if (lastScrollClientHeightRef.current <= 0) {
      lastScrollClientHeightRef.current = nextHeight;
    }
    setContainerHeight((current) => (movedByAPixel(current, nextHeight) ? nextHeight : current));
  }, []);

  // The minimap rail is positioned against the LIST ROOT (its offset parent), so
  // its gutter maths need that element's box — nothing else measures it.
  const measureListRootBox = useCallback(() => {
    const el = listRootRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const width = Math.max(el.clientWidth, rect.width);
    const height = Math.max(el.clientHeight, rect.height);
    setListRootBoxPx((current) => (
      movedByAPixel(current.width, width)
        || movedByAPixel(current.height, height)
        ? { width, height }
        : current
    ));
  }, []);

  /** Centered column width — the other half of the rail's gutter maths. */
  const measureContentColumnWidth = useCallback(() => {
    const el = contentWrapperRef.current;
    if (!el) return;
    const width = Math.max(el.clientWidth, el.getBoundingClientRect().width);
    setColumnWidthPx((current) => (movedByAPixel(current, width) ? width : current));
  }, []);

  useEffect(() => {
    const el = listRootRef.current;
    if (!el) return;
    if (typeof ResizeObserver === "undefined") {
      measureListRootBox();
      return;
    }
    const ro = new ResizeObserver(() => measureListRootBox());
    ro.observe(el);
    measureListRootBox();
    return () => ro.disconnect();
  }, [measureListRootBox]);

  // Unified stick-to-bottom autoscroll:
  // - scrollToBottomSoon coalesces every scroll-to-bottom request into a
  //   single rAF per frame so rapid streaming updates can't produce
  //   back-to-back synchronous scrollTop writes (the classic source of
  //   chat flicker during token streaming).
  // - A ResizeObserver on the content wrapper picks up every size change —
  //   new rows appearing *and* streaming tokens extending existing rows —
  //   without the old MutationObserver's characterData firehose.
  const scrollToBottomSoon = useCallback((followUpFrames = 1) => {
    scrollFollowFramesRef.current = Math.max(scrollFollowFramesRef.current, followUpFrames);
    if (scrollRafRef.current !== null) return;
    const run = () => {
      scrollRafRef.current = null;
      const el = scrollRef.current;
      if (!el || !stickToBottomRef.current) {
        scrollFollowFramesRef.current = 0;
        return;
      }
      const target = Math.max(0, el.scrollHeight - el.clientHeight);
      const before = el.scrollTop;
      if (Math.abs(before - target) >= 1) {
        el.scrollTop = target;
        setScrollTop(el.scrollTop);
        // Only register a pending programmatic scroll event if the assignment
        // actually moved the element. Otherwise (clamped to the same value,
        // hidden element, etc.) no scroll event will fire and the next real
        // user scroll must still be allowed to update sticky state.
        if (el.scrollTop !== before) {
          programmaticScrollTargetRef.current = el.scrollTop;
        }
      }
      const remaining = scrollFollowFramesRef.current;
      if (remaining > 0) {
        scrollFollowFramesRef.current = remaining - 1;
        scrollRafRef.current = requestAnimationFrame(run);
      }
    };
    scrollRafRef.current = requestAnimationFrame(run);
  }, []);
  scrollToBottomSoonRef.current = scrollToBottomSoon;

  /** Row the transcript ended on at the moment bottom-follow broke. */
  const markDetachAnchor = useCallback(() => {
    const keys = groupedRowKeysRef.current;
    setDetachAnchorRowKey(keys.length ? keys[keys.length - 1]! : null);
  }, []);

  const releaseBottomStickinessForUserScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || el.scrollHeight <= el.clientHeight + 1 || !stickToBottomRef.current) return;
    stickToBottomRef.current = false;
    setStickToBottom(false);
    markDetachAnchor();
    scrollFollowFramesRef.current = 0;
    // Keep `programmaticScrollTargetRef`: a bottom snap already written may
    // still owe its scroll event, and that event must be absorbed, not read
    // as the reader landing at the bottom. A non-matching event clears it.
    if (scrollRafRef.current !== null) {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }
  }, [markDetachAnchor]);

  useEffect(() => () => {
    if (scrollRafRef.current !== null) {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }
    scrollFollowFramesRef.current = 0;
  }, []);

  // Opening or closing a fold keeps the fold row where the reader clicked it.
  // Bottom-follow is suspended for the change (it would otherwise chase the
  // new bottom and fling the fold row off screen) and resumes afterwards only
  // if the view still ends at the bottom.
  const toggleTurnFold = useCallback((foldId: string) => {
    const el = scrollRef.current;
    const top = el ? readChatRowTop(el, foldId) : null;
    if (el && top !== null) {
      const keys = groupedRowKeysRef.current;
      const foldIndex = keys.indexOf(foldId);
      const offsets = foldIndex >= 0
        ? computeRowStartOffsets(
            foldIndex + 1,
            (index) => heightForKey(keys[index]),
            timelineRowGapPxRef.current,
          )
        : null;
      pendingFoldAnchorRef.current = {
        key: foldId,
        top,
        modelTop: offsets ? offsets[foldIndex]! - el.scrollTop : null,
        wasStuck: stickToBottomRef.current,
        fromToggle: true,
      };
      if (stickToBottomRef.current) {
        stickToBottomRef.current = false;
        setStickToBottom(false);
        scrollFollowFramesRef.current = 0;
        if (scrollRafRef.current !== null) {
          cancelAnimationFrame(scrollRafRef.current);
          scrollRafRef.current = null;
        }
      }
    }
    setTurnFoldOpen(foldId, !openTurnFoldsRef.current.has(foldId));
  }, [heightForKey, setTurnFoldOpen]);

  // When the user re-enters the sticky zone (or on first mount), snap to bottom.
  useEffect(() => {
    if (stickToBottom) scrollToBottomSoon();
  }, [stickToBottom, scrollToBottomSoon]);

  // Observe the content wrapper so streaming growth triggers a single
  // rAF-coalesced scroll. The observer stays attached at all times; the
  // rAF callback self-guards on stickToBottomRef so it's a cheap no-op
  // when the user has scrolled up.
  useEffect(() => {
    const wrapper = contentWrapperRef.current;
    if (!wrapper || typeof ResizeObserver === "undefined") {
      // Fallback: when ResizeObserver is unavailable (test env) we still
      // want sticky behavior as content mutates.
      measureContentColumnWidth();
      if (stickToBottomRef.current) scrollToBottomSoon();
      return;
    }
    const ro = new ResizeObserver(() => {
      // One observation, two consumers: bottom-follow and the minimap's gutter
      // maths. The rail costs no extra observer, and the width setter has a 1px
      // deadband so streaming height churn never re-renders for it.
      measureContentColumnWidth();
      if (stickToBottomRef.current) scrollToBottomSoon(2);
    });
    ro.observe(wrapper);
    measureContentColumnWidth();
    return () => ro.disconnect();
  }, [measureContentColumnWidth, scrollToBottomSoon]);

  // Observe the scroll container's size so we know the viewport height.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (typeof ResizeObserver === "undefined") {
      // Fallback for test environments / old browsers
      measureScrollContainerHeight();
      return;
    }
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      const nextHeight = Math.max(entry?.contentRect.height ?? 0, el.clientHeight);
      const previousHeight = lastScrollClientHeightRef.current;
      if (shouldKeepPinnedThroughViewportShrink({
        wasStuckToBottom: stickToBottomRef.current,
        previousClientHeight: previousHeight,
        nextClientHeight: nextHeight,
      })) {
        pinScrollToBottomNow(el);
        scrollToBottomSoon(2);
      }
      lastScrollClientHeightRef.current = nextHeight;
      setContainerHeight((current) => (movedByAPixel(current, nextHeight) ? nextHeight : current));
    });
    ro.observe(el);
    measureScrollContainerHeight();
    return () => ro.disconnect();
  }, [measureScrollContainerHeight, pinScrollToBottomNow, scrollToBottomSoon]);

  // A short initial tail may not create a scrollbar, so no scroll event can
  // ever ask for the next page. Keep backfilling while the viewport is
  // underfilled; stop after a retryable failure so the explicit retry control
  // remains stable instead of hammering a disconnected host.
  useEffect(() => {
    if (!hasOlderHistory || loadingOlderHistory || olderHistoryError) return;
    const frame = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (!el) return;
      if (el.scrollHeight <= el.clientHeight + LOAD_OLDER_THRESHOLD_PX) {
        maybeRequestOlderHistory(el.scrollTop, "underfill");
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [
    containerHeight,
    groupedRows.length,
    hasOlderHistory,
    loadingOlderHistory,
    maybeRequestOlderHistory,
    olderHistoryError,
  ]);

  // Decided on the unfolded row count: a fold closing (or opening) must never
  // flip the list between the plain and virtualized render paths, which would
  // remount every row and drop its measured height.
  const shouldVirtualize = presentedRows.length >= VIRTUALIZATION_THRESHOLD;

  useLayoutEffect(() => {
    measureScrollContainerHeight();
    const raf = requestAnimationFrame(() => {
      measureScrollContainerHeight();
      if (stickToBottomRef.current) scrollToBottomSoon(2);
    });
    return () => cancelAnimationFrame(raf);
  }, [groupedRows.length, measureScrollContainerHeight, scrollToBottomSoon, shouldVirtualize]);

  /**
   * Returns the best-known height for a given row index. Its identity follows
   * the key list (stable across content-only deltas) and the estimate width
   * step, never per-token content.
   */
  const rowHeight = useCallback(
    (index: number) => heightForKey(groupedRowKeys[index]),
    // `estimateWidthStep`: the estimates behind `heightForKey` were re-seeded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groupedRowKeys, heightForKey, estimateWidthStep],
  );

  const scrollToRowIndexNearTop = useCallback((rowIndex: number) => {
    const el = scrollRef.current;
    if (!el || rowIndex < 0 || rowIndex >= groupedRows.length) return false;
    const offsets = computeRowStartOffsets(groupedRows.length, rowHeight, timelineRowGapPx);
    const targetTop = computeScrollTopForRow(rowIndex, offsets);
    const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
    const clamped = Math.max(0, Math.min(maxScroll, targetTop));
    stickToBottomRef.current = false;
    setStickToBottom(false);
    scrollFollowFramesRef.current = 0;
    if (scrollRafRef.current !== null) {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }
    const before = el.scrollTop;
    el.scrollTop = clamped;
    if (el.scrollTop !== before) {
      programmaticScrollTargetRef.current = el.scrollTop;
    }
    setScrollTop(el.scrollTop);
    return true;
  }, [groupedRows.length, rowHeight, timelineRowGapPx]);

  // Scroll a grouped row into view by its stable render key — used by the
  // subagent spawn/result "jump to result ↓" / "↑ jump to start" affordances.
  const scrollToRowKey = useCallback((requestedKey: string) => {
    // Resolve pre-draw memberships in one place. Keep this key before fold
    // ownership is applied so a hidden member can open its containing fold.
    const rowKey = resolveDrawnRowKey(requestedKey, [
      subagentGridKeyByMemberKeyRef.current,
      backgroundJobGroupKeyByMemberKeyRef.current,
      answerKeyByDuplicateKeyRef.current,
      thoughtRunKeyByMemberKeyRef.current,
    ]);
    if (revealTurnFoldRow(rowKey)) {
      pendingRevealScrollKeyRef.current = rowKey;
      return;
    }
    const rowIndex = drawnRowKeyIndexRef.current.get(rowKey);
    if (rowIndex !== undefined && rowIndex >= 0) scrollToRowIndexNearTop(rowIndex);
  }, [revealTurnFoldRow, scrollToRowIndexNearTop]);

  useEffect(() => {
    if (!scrollToRowKeyRequest?.key) return;
    if (lastHandledScrollToRowRequestIdRef.current === scrollToRowKeyRequest.requestId) return;
    lastHandledScrollToRowRequestIdRef.current = scrollToRowKeyRequest.requestId;
    scrollToRowKey(scrollToRowKeyRequest.key);
  }, [scrollToRowKey, scrollToRowKeyRequest]);

  useEffect(() => {
    if (!scrollToPromptHistoryRequest?.eventKey) return;
    if (lastHandledPromptHistoryRequestIdRef.current === scrollToPromptHistoryRequest.requestId) return;
    lastHandledPromptHistoryRequestIdRef.current = scrollToPromptHistoryRequest.requestId;
    const rowIndex = groupedRows.findIndex((row) => (
      row.event.type === "user_message"
      && promptHistoryEventKey({ timestamp: row.timestamp, event: row.event }) === scrollToPromptHistoryRequest.eventKey
    ));
    if (rowIndex >= 0) scrollToRowIndexNearTop(rowIndex);
  }, [groupedRows, scrollToPromptHistoryRequest, scrollToRowIndexNearTop]);

  const scheduleAnchoredRowCorrection = useCallback((rowKey: string) => {
    if (anchorCorrectionRafRef.current !== null) {
      cancelAnimationFrame(anchorCorrectionRafRef.current);
      anchorCorrectionRafRef.current = null;
    }
    let remainingFrames = 2;
    const run = () => {
      anchorCorrectionRafRef.current = null;
      const rowIndex = groupedRowKeys.indexOf(rowKey);
      if (rowIndex >= 0) scrollToRowIndexNearTop(rowIndex);
      remainingFrames -= 1;
      if (remainingFrames > 0) {
        anchorCorrectionRafRef.current = requestAnimationFrame(run);
      }
    };
    anchorCorrectionRafRef.current = requestAnimationFrame(run);
  }, [groupedRowKeys, scrollToRowIndexNearTop]);

  const highlightRow = useCallback((rowKey: string) => {
    setAnchoredRowKey(rowKey);
    if (anchorHighlightTimerRef.current) clearTimeout(anchorHighlightTimerRef.current);
    anchorHighlightTimerRef.current = setTimeout(() => {
      anchorHighlightTimerRef.current = null;
      setAnchoredRowKey((current) => (current === rowKey ? null : current));
    }, 2000);
  }, []);

  // Finish a jump that had to open a fold first. The fold's rows exist after
  // this commit; newly revealed rows lay out on estimates in the virtualized
  // list, so the jump re-lands on the next two frames as they measure, and the
  // row is highlighted so the reader finds it among the revealed work.
  useLayoutEffect(() => {
    const pendingKey = pendingRevealScrollKeyRef.current;
    if (!pendingKey) return;
    // The revealed row may have merged into the Thought row before it.
    const rowKey = thoughtRunKeyByMemberKeyRef.current.get(pendingKey) ?? pendingKey;
    const rowIndex = groupedRowKeys.indexOf(rowKey);
    if (rowIndex < 0) {
      // Still hidden: the fold opens on this commit. Gone: drop the jump.
      if (!foldIdByHiddenRowKeyRef.current.has(pendingKey)) pendingRevealScrollKeyRef.current = null;
      return;
    }
    pendingRevealScrollKeyRef.current = null;
    highlightRow(rowKey);
    scrollToRowIndexNearTop(rowIndex);
    scheduleAnchoredRowCorrection(rowKey);
  }, [groupedRowKeys, highlightRow, scheduleAnchoredRowCorrection, scrollToRowIndexNearTop]);

  useLayoutEffect(() => {
    if (!sessionId || events.length === 0) return;
    let pending = pendingChatEventAnchorRef.current;
    if (!pending) {
      const queued = peekPendingSessionAnchor(sessionId);
      if (queued?.event == null) return;
      const consumed = takePendingSessionAnchor(sessionId);
      if (consumed?.event == null) return;
      pending = {
        event: consumed.event,
        loadRequests: 0,
        waitingForOlderHistory: false,
        sawOlderHistoryLoading: false,
        lastEventsLength: events.length,
      };
      pendingChatEventAnchorRef.current = pending;
    }

    if (pending.waitingForOlderHistory) {
      if (loadingOlderHistory) {
        pending.sawOlderHistoryLoading = true;
      } else if (!pending.sawOlderHistoryLoading && events.length === pending.lastEventsLength) {
        return;
      } else {
        pending.waitingForOlderHistory = false;
        pending.sawOlderHistoryLoading = false;
      }
    }

    // Resolve against the unfolded rows so a target inside a closed fold is
    // found; open that fold first and finish once its rows render.
    const presentedIndex = resolveAnchoredChatRowIndex({
      events,
      groupedRows: presentedRows,
      anchorEvent: pending.event,
      hasFullHistory: !hasOlderHistory,
    });
    const anchoredKey = presentedIndex >= 0 ? (presentedRows[presentedIndex]?.key ?? null) : null;
    const presentedKey = anchoredKey ? (answerKeyByDuplicateKeyRef.current.get(anchoredKey) ?? anchoredKey) : null;
    if (presentedKey && revealTurnFoldRow(presentedKey)) return;
    const rowIndex = presentedKey
      ? groupedRowKeys.indexOf(thoughtRunKeyByMemberKeyRef.current.get(presentedKey) ?? presentedKey)
      : -1;
    if (rowIndex >= 0) {
      const rowKey = groupedRows[rowIndex]?.key ?? null;
      pendingChatEventAnchorRef.current = null;
      if (rowKey) highlightRow(rowKey);
      scrollToRowIndexNearTop(rowIndex);
      if (rowKey) scheduleAnchoredRowCorrection(rowKey);
      return;
    }

    if (!hasOlderHistory) {
      pendingChatEventAnchorRef.current = null;
      return;
    }
    if (loadingOlderHistory) return;
    if (pending.loadRequests >= 10) {
      pendingChatEventAnchorRef.current = null;
      return;
    }
    pending.loadRequests += 1;
    pending.waitingForOlderHistory = true;
    pending.sawOlderHistoryLoading = false;
    pending.lastEventsLength = events.length;
    onLoadOlderHistory?.();
  }, [
    sessionId,
    events,
    groupedRows,
    groupedRowKeys,
    presentedRows,
    revealTurnFoldRow,
    hasOlderHistory,
    loadingOlderHistory,
    onLoadOlderHistory,
    location.key,
    location.search,
    highlightRow,
    scrollToRowIndexNearTop,
    scheduleAnchoredRowCorrection,
  ]);

  /** Callback from MeasuredEventRow when it measures its real DOM height. */
  const measureFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (measureFlushTimer.current) {
      clearTimeout(measureFlushTimer.current);
      measureFlushTimer.current = null;
    }
  }, []);
  const handleMeasure = useCallback((index: number, height: number) => {
    const key = groupedRowKeys[index];
    if (!key) return;
    const prev = measuredHeights.current.get(key);
    if (prev !== height) {
      const previousHeight = prev ?? heightForKey(key);
      measuredHeights.current.set(key, height);
      const scrollEl = scrollRef.current;
      if (scrollEl && shouldVirtualize && !stickToBottomRef.current) {
        const adjustedScrollTop = reconcileMeasuredScrollTop({
          index,
          previousHeight,
          nextHeight: height,
          scrollTop: scrollEl.scrollTop,
          rowHeight,
          rowGap: timelineRowGapPx,
        });
        if (adjustedScrollTop !== scrollEl.scrollTop) {
          scrollEl.scrollTop = adjustedScrollTop;
          programmaticScrollTargetRef.current = adjustedScrollTop;
          setScrollTop(adjustedScrollTop);
        }
      }
      // Debounce measurement tick updates to batch rapid height changes
      // into a single re-render instead of one per row.
      const isFollowingBottom = stickToBottomRef.current;
      if (measureFlushTimer.current) {
        if (!isFollowingBottom) return;
        clearTimeout(measureFlushTimer.current);
      }
      measureFlushTimer.current = setTimeout(() => {
        measureFlushTimer.current = null;
        setMeasurementTick((value) => value + 1);
        if (isFollowingBottom) scrollToBottomSoon(2);
      }, isFollowingBottom ? 16 : 80);
    }
  }, [groupedRowKeys, heightForKey, rowHeight, scrollToBottomSoon, shouldVirtualize, timelineRowGapPx]);

  // Compute the visible window of rows when virtualization is active.
  // measurementTick forces recomputation when row heights are measured so
  // totalHeight stays accurate — without this, scroll-to-top can break because
  // the spacer heights are computed from stale estimates.
  // A row-list change under a scrolled-up reader sizes this commit's window
  // from where the anchor row is about to be, not from the pre-change
  // scrollTop, so the row the list anchor reads back is mounted.
  const windowScrollTop = pendingListAnchorRef.current?.windowScrollTop ?? scrollTop;
  const { startIndex, endIndex, totalHeight, offsetTop } = useMemo(() => {
    if (!shouldVirtualize) {
      return { startIndex: 0, endIndex: groupedRows.length, totalHeight: 0, offsetTop: 0 };
    }

    // While following the bottom, anchor the window to the last row instead of
    // deriving it from the estimate-based scrollTop. This keeps the tail mounted
    // so it can't strand behind a phantom gap on long transcripts.
    if (stickToBottom) {
      return calculateVirtualWindowAnchoredToEnd({
        rowCount: groupedRows.length,
        containerHeight,
        rowHeight,
        rowGap: timelineRowGapPx,
      });
    }

    return calculateVirtualWindow({
      rowCount: groupedRows.length,
      scrollTop: windowScrollTop,
      containerHeight,
      rowHeight,
      rowGap: timelineRowGapPx,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldVirtualize, stickToBottom, groupedRows.length, windowScrollTop, containerHeight, rowHeight, measurementTick, timelineRowGapPx]);

  useLayoutEffect(() => {
    if (stickToBottomRef.current) scrollToBottomSoon(2);
  }, [containerHeight, groupedRows.length, measurementTick, scrollToBottomSoon, shouldVirtualize, totalHeight]);

  /**
   * Row start offsets under the measured-height model (the per-kind estimate
   * for anything not yet measured). Stable, and reads only refs, so the unmount
   * cleanup can call it too.
   */
  const measuredRowStartOffsets = useCallback((keys: readonly string[]): number[] => (
    computeRowStartOffsets(
      keys.length,
      (index) => heightForKey(keys[index]),
      timelineRowGapPxRef.current,
    )
  ), [heightForKey]);

  // ── List anchoring ─────────────────────────────────────────────────────
  // When the row list changes under a reader who is scrolled up — an older
  // page prepended, a front trim, a snapshot merge, rows regrouped or removed
  // above them — keep what they were looking at exactly where it was. The rows
  // on screen were read from the DOM before the commit (`pendingListAnchorRef`,
  // captured during render); here the first of them that is still mounted is
  // read again and scrollTop moves by exactly how far it moved. That is exact
  // in both render paths and needs no key matching or height model: the model
  // only sizes the virtualized window for this commit (`windowScrollTop`) so
  // the anchor row stays mounted, and places a row that did unmount.
  // `overflow-anchor: none` on the pane keeps the browser out of it.
  useLayoutEffect(() => {
    const anchor = pendingListAnchorRef.current;
    if (!anchor) return;
    pendingListAnchorRef.current = null;
    const el = scrollRef.current;
    if (!el || stickToBottomRef.current) return;
    let shift: number | null = null;
    for (const row of anchor.rows) {
      const top = readLaidOutChatRowTop(el, row.key);
      if (top === null) continue;
      shift = top - row.top;
      break;
    }
    if (shift === null && anchor.model) {
      const index = groupedRowKeys.indexOf(anchor.model.key);
      if (index >= 0) {
        const offsets = measuredRowStartOffsets(groupedRowKeys.slice(0, index + 1));
        shift = (offsets[index]! - el.scrollTop) - anchor.model.modelTop;
      }
    }
    if (shift === null || !movedByAPixel(0, shift)) {
      // Nothing moved on screen, but the window may have been sized from the
      // shifted model position; resync it with the real scrollTop.
      if (anchor.windowScrollTop !== null) setScrollTop(el.scrollTop);
      return;
    }
    const before = el.scrollTop;
    el.scrollTop = Math.max(0, before + shift);
    if (el.scrollTop !== before) programmaticScrollTargetRef.current = el.scrollTop;
    setScrollTop(el.scrollTop);
  }, [groupedRowKeys, measuredRowStartOffsets]);

  // Apply a pending fold anchor: move scrollTop by exactly how far the anchor
  // row moved, so the fold change reads as happening below/inside the reader's
  // position instead of scrolling the thread. Runs after the list anchor (which
  // stands down while a fold anchor is pending), so it measures (and only
  // corrects) the real post-commit position.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (pinAfterTurnFoldRef.current) {
      pinAfterTurnFoldRef.current = false;
      // Rows vanished above a view that follows the bottom. The browser clamps
      // scrollTop, but only when the content got shorter than the viewport's
      // reach; pin now so the first painted frame already shows the tail.
      if (el && stickToBottomRef.current) pinScrollToBottomNow(el);
    }
    const pending = pendingFoldAnchorRef.current;
    if (!pending) return;
    pendingFoldAnchorRef.current = null;
    if (!el) return;
    const top = readChatRowTop(el, pending.key);
    let shift: number | null = null;
    if (top !== null) {
      shift = top - pending.top;
    } else if (pending.modelTop !== null) {
      // Not mounted (virtualized, and the change moved it outside the
      // window): place it with the same height model the virtualizer uses.
      const index = groupedRowKeys.indexOf(pending.key);
      if (index >= 0) {
        const offsets = measuredRowStartOffsets(groupedRowKeys.slice(0, index + 1));
        shift = (offsets[index]! - el.scrollTop) - pending.modelTop;
      }
    }
    if (shift !== null && movedByAPixel(0, shift)) {
      const before = el.scrollTop;
      el.scrollTop = before + shift;
      if (el.scrollTop !== before) programmaticScrollTargetRef.current = el.scrollTop;
      setScrollTop(el.scrollTop);
    }
    // Resume bottom-follow when the change left the view at the end: always
    // after a toggle that suspended it, and after a CLOSE even from a detached
    // view — closing can reveal the end without any scroll event. A turn
    // folding on its own never re-sticks a reader who scrolled up.
    if (!pending.wasStuck && !pending.fromToggle) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom <= STICK_RESUME_THRESHOLD_PX) {
      stickToBottomRef.current = true;
      setStickToBottom(true);
      if (!pending.wasStuck) {
        // Same as scrolling back into the sticky zone (`handleScroll`).
        setDetachAnchorRowKey(null);
        onReturnToLatest?.();
      }
    } else if (pending.wasStuck) {
      markDetachAnchor();
    }
  }, [groupedRowKeys, markDetachAnchor, measuredRowStartOffsets, onReturnToLatest, pinScrollToBottomNow]);

  // ── Smart-hybrid scroll restore ────────────────────────────────────────
  // Pinned readers come back to the live tail (the bottom-stick path already
  // does that); detached readers come back to the exact row they left on, at
  // the same offset. Older-history loading is held until the restore settles
  // (`scrollRestoreActiveRef`), so a prepend never lands mid-restore.
  const captureScrollMemory = useCallback((
    keys: readonly string[],
    pinned: boolean,
    el: HTMLElement | null,
    scrollTopAtExit: number,
  ): ChatScrollMemory => {
    let anchorRowKey: string | null = null;
    let anchorOffsetPx = 0;
    if (!pinned && keys.length) {
      // The DOM says exactly which row is at the top and how far into it the
      // viewport sits; the height model is the fallback when nothing is laid out.
      const first = el ? readFirstVisibleChatRow(el) : null;
      if (first) {
        anchorRowKey = first.key;
        anchorOffsetPx = -first.top;
      } else {
        const anchor = resolveRowAnchorAtScrollTop(measuredRowStartOffsets(keys), scrollTopAtExit);
        if (anchor) {
          anchorRowKey = keys[anchor.index] ?? null;
          anchorOffsetPx = anchor.offsetPx;
        }
      }
    }
    return {
      wasPinnedToBottom: pinned,
      anchorRowKey,
      anchorOffsetPx,
      distanceFromBottomPx: !pinned && el
        ? Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight)
        : null,
      lastSeenRowKey: keys.length ? keys[keys.length - 1]! : null,
      savedAtMs: Date.now(),
    };
  }, [measuredRowStartOffsets]);

  // Keep a committed snapshot for each view. Passive cleanup runs after the
  // shared list has already rendered the next view, so reading live refs there
  // would save the child transcript under the parent's key. Skip until restore
  // has settled so a key switch cannot store the previous view's scrollTop
  // under the next key, and while it is still correcting so a half-landed
  // position never replaces the one being restored.
  useLayoutEffect(() => {
    if (!resolvedScrollMemoryKey || !scrollRestoreSettledRef.current || scrollRestoreActiveRef.current) return;
    const el = scrollRef.current;
    const scrollTopAtExit = el?.scrollTop ?? lastScrollTopRef.current;
    rememberBoundedChatScrollMemory(
      scrollMemorySnapshotByKeyRef.current,
      resolvedScrollMemoryKey,
      captureScrollMemory(groupedRowKeys, stickToBottomRef.current, el, scrollTopAtExit),
    );
  }, [captureScrollMemory, groupedRowKeys, measurementTick, resolvedScrollMemoryKey, scrollTop, stickToBottom]);

  /**
   * Put the saved row back at its saved offset: by its DOM position when it is
   * mounted, by the height model when it is not (a virtualized window that has
   * not reached it yet; the next correction frame finds it mounted), and by the
   * saved distance from the bottom when the row is gone entirely.
   */
  const applyScrollRestore = useCallback((target: ScrollRestoreTarget): boolean => {
    const el = scrollRef.current;
    if (!el) return false;
    const keys = groupedRowKeysRef.current;
    let anchorKey = target.anchorRowKey;
    let offsetPx = target.anchorOffsetPx;
    let anchorIndex = anchorKey ? keys.indexOf(anchorKey) : -1;
    if (anchorIndex < 0 && anchorKey) {
      const drawnIndex = drawnRowKeyIndexRef.current.get(anchorKey);
      if (drawnIndex !== undefined) {
        anchorIndex = drawnIndex;
        anchorKey = keys[drawnIndex] ?? anchorKey;
        offsetPx = 0;
      }
    }
    let next: number | null = null;
    if (anchorKey && anchorIndex >= 0) {
      const domTop = readLaidOutChatRowTop(el, anchorKey);
      next = domTop !== null
        ? el.scrollTop + domTop + offsetPx
        // The SAME height model the list anchor and the minimap use — one shared
        // function, so they cannot disagree about where a row starts.
        : computeScrollTopForRow(anchorIndex, measuredRowStartOffsets(keys)) + offsetPx;
    } else if (target.distanceFromBottomPx != null) {
      next = el.scrollHeight - el.clientHeight - target.distanceFromBottomPx;
    }
    if (next === null) return false;
    const before = el.scrollTop;
    el.scrollTop = Math.max(0, next);
    if (el.scrollTop !== before) programmaticScrollTargetRef.current = el.scrollTop;
    lastScrollTopRef.current = el.scrollTop;
    setScrollTop(el.scrollTop);
    return true;
  }, [measuredRowStartOffsets]);

  /** The restore is over (landed, gave up, or the reader took over): let older history load again. */
  const finishScrollRestore = useCallback(() => {
    if (scrollRestoreCorrectionRafRef.current !== null) {
      cancelAnimationFrame(scrollRestoreCorrectionRafRef.current);
      scrollRestoreCorrectionRafRef.current = null;
    }
    pendingScrollRestoreRef.current = null;
    scrollRestoreSettledRef.current = true;
    if (!scrollRestoreActiveRef.current) return;
    scrollRestoreActiveRef.current = false;
    // The sentinel may have come into range while loading was held back, and
    // it only reports changes; ask once, as an automatic request.
    const el = scrollRef.current;
    if (el) maybeRequestOlderHistory(el.scrollTop, "auto");
  }, [maybeRequestOlderHistory]);

  /**
   * Re-apply the restore every frame until the position holds for two frames
   * in a row: rows mount, measure, and highlight after the first pass, and each
   * of those can move the row being restored.
   */
  const startScrollRestoreCorrection = useCallback(() => {
    if (scrollRestoreCorrectionRafRef.current !== null) {
      cancelAnimationFrame(scrollRestoreCorrectionRafRef.current);
    }
    let frames = 0;
    let stableFrames = 0;
    const run = () => {
      scrollRestoreCorrectionRafRef.current = null;
      const target = pendingScrollRestoreRef.current;
      const el = scrollRef.current;
      if (!target || !el) {
        finishScrollRestore();
        return;
      }
      const before = el.scrollTop;
      applyScrollRestore(target);
      stableFrames = movedByAPixel(before, el.scrollTop) ? 0 : stableFrames + 1;
      frames += 1;
      if (stableFrames >= SCROLL_RESTORE_STABLE_FRAMES || frames >= SCROLL_RESTORE_MAX_CORRECTION_FRAMES) {
        finishScrollRestore();
        return;
      }
      scrollRestoreCorrectionRafRef.current = requestAnimationFrame(run);
    };
    scrollRestoreCorrectionRafRef.current = requestAnimationFrame(run);
  }, [applyScrollRestore, finishScrollRestore]);

  /** Wheel, touch, press, or a scroll key: the reader is driving now. */
  const noteReaderScrollIntent = useCallback(() => {
    autoOlderLoadsSinceUserScrollRef.current = 0;
    if (scrollRestoreActiveRef.current) finishScrollRestore();
  }, [finishScrollRestore]);

  /** Opens the closed fold hiding a restore anchor, once per view; true while that is pending. */
  const revealScrollRestoreAnchor = useCallback((anchorRowKey: string): boolean => {
    if (groupedRowKeysRef.current.includes(anchorRowKey)) return false;
    if (scrollRestoreRevealRequestedRef.current) return false;
    scrollRestoreRevealRequestedRef.current = true;
    return revealTurnFoldRow(anchorRowKey);
  }, [revealTurnFoldRow]);

  useLayoutEffect(() => {
    if (scrollRestoreSettledRef.current) return;
    const memory = restoredScrollMemoryRef.current;
    if (!memory || !needsScrollRestore(memory)) {
      scrollRestoreSettledRef.current = true;
      scrollRestoreActiveRef.current = false;
    } else if (containerHeight <= 0 || groupedRowKeys.length === 0) {
      return;
    } else if (memory.anchorRowKey && revealScrollRestoreAnchor(memory.anchorRowKey)) {
      // The turn finished (and folded) while the reader was away: open the
      // fold holding the row they left on and restore on the next commit, once
      // its rows exist, to the exact row and offset.
      return;
    } else {
      scrollRestoreSettledRef.current = true;
      const target: ScrollRestoreTarget = {
        anchorRowKey: memory.anchorRowKey,
        anchorOffsetPx: memory.anchorOffsetPx,
        distanceFromBottomPx: memory.distanceFromBottomPx ?? null,
      };
      if (applyScrollRestore(target)) {
        pendingScrollRestoreRef.current = target;
        startScrollRestoreCorrection();
      } else {
        finishScrollRestore();
      }
    }
    if (!resolvedScrollMemoryKey || scrollRestoreActiveRef.current) return;
    const el = scrollRef.current;
    const scrollTopAtExit = el?.scrollTop ?? lastScrollTopRef.current;
    rememberBoundedChatScrollMemory(
      scrollMemorySnapshotByKeyRef.current,
      resolvedScrollMemoryKey,
      captureScrollMemory(groupedRowKeys, stickToBottomRef.current, el, scrollTopAtExit),
    );
  }, [
    applyScrollRestore,
    captureScrollMemory,
    containerHeight,
    finishScrollRestore,
    groupedRowKeys,
    resolvedScrollMemoryKey,
    revealScrollRestoreAnchor,
    startScrollRestoreCorrection,
  ]);

  // Promote the latest committed snapshot when the view changes or unmounts.
  // The layout effect above always seeds the active key before this cleanup
  // runs, so cleanup never needs to read refs that may now belong to another
  // nested transcript.
  useEffect(() => {
    if (!resolvedScrollMemoryKey) return;
    const memorySessionId = resolvedScrollMemoryKey;
    const snapshots = scrollMemorySnapshotByKeyRef.current;
    return () => {
      const memory = snapshots.get(memorySessionId);
      if (memory) rememberChatScrollMemory(memorySessionId, memory);
    };
  }, [resolvedScrollMemoryKey]);

  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    const previousScrollTop = lastScrollTopRef.current;
    // Ref write, not state: the per-chat scroll memory is snapshotted at unmount
    // so following the scroll costs zero renders.
    lastScrollTopRef.current = target.scrollTop;
    // Absorb scroll events produced by our own programmatic scroll-to-bottom
    // writes so we never flip sticky state based on them — only the user's
    // own gesture (wheel / trackpad / keyboard) should break auto-follow.
    const programmaticTarget = programmaticScrollTargetRef.current;
    if (shouldAbsorbProgrammaticScrollEvent({
      scrollTop: target.scrollTop,
      programmaticTarget,
    })) {
      programmaticScrollTargetRef.current = null;
      lastScrollClientHeightRef.current = target.clientHeight;
      setScrollTop(target.scrollTop);
      return;
    }
    programmaticScrollTargetRef.current = null;
    const nextClientHeight = target.clientHeight;
    const previousClientHeight = lastScrollClientHeightRef.current;
    lastScrollClientHeightRef.current = nextClientHeight;
    if (shouldKeepPinnedThroughViewportShrink({
      wasStuckToBottom: stickToBottomRef.current,
      previousClientHeight,
      nextClientHeight,
    })) {
      pinScrollToBottomNow(target);
      scrollToBottomSoon(2);
      return;
    }
    const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
    // Wider threshold (~1 row of assistant text) so a small wheel nudge
    // while the turn is streaming actually breaks free instead of snapping
    // straight back to the bottom.
    const scrolledDown = target.scrollTop > previousScrollTop + 0.5;
    const scrollUpAt = userScrollUpAtRef.current;
    const repinHeld = scrollUpAt != null && performance.now() - scrollUpAt < USER_SCROLL_UP_REPIN_HOLD_MS;
    const nextStick = shouldStickToBottomAfterScroll({
      distanceFromBottom,
      wasStuckToBottom: stickToBottomRef.current,
      scrolledDown,
      repinHeld,
    });
    if (nextStick !== stickToBottomRef.current) {
      stickToBottomRef.current = nextStick;
      setStickToBottom(nextStick);
      // Re-sticking means everything is caught up, so the "N new" baseline goes
      // away; detaching starts a fresh one.
      if (nextStick) {
        logRendererDebugEvent("renderer.chat.scroll.repin", {
          sessionId: sessionId ?? null,
          direction: scrolledDown ? "down" : "none",
          deltaPx: Math.round(target.scrollTop - previousScrollTop),
          distanceFromBottomPx: Math.round(distanceFromBottom),
          msSinceScrollUp: scrollUpAt == null ? null : Math.round(performance.now() - scrollUpAt),
        });
        setDetachAnchorRowKey(null);
        onReturnToLatest?.();
      } else {
        markDetachAnchor();
      }
    }
    setScrollTop(target.scrollTop);
    // A scroll we did not author is the reader moving: automatic older pages
    // get their one chained page back.
    autoOlderLoadsSinceUserScrollRef.current = 0;
    maybeRequestOlderHistory(target.scrollTop, "reader");
  }, [markDetachAnchor, maybeRequestOlderHistory, onReturnToLatest, pinScrollToBottomNow, scrollToBottomSoon, sessionId]);

  /** The reader scrolled up (true) or down (false): starts or ends the re-pin hold. */
  const noteReaderScrollDirection = useCallback((up: boolean) => {
    userScrollUpAtRef.current = up ? performance.now() : null;
    if (up) releaseBottomStickinessForUserScroll();
  }, [releaseBottomStickinessForUserScroll]);

  const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    noteReaderScrollIntent();
    if (event.deltaY < 0) noteReaderScrollDirection(true);
    else if (event.deltaY > 0) noteReaderScrollDirection(false);
  }, [noteReaderScrollDirection, noteReaderScrollIntent]);

  const handleTouchStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    noteReaderScrollIntent();
    lastTouchYRef.current = event.touches[0]?.clientY ?? null;
  }, [noteReaderScrollIntent]);

  // A press (scrollbar drag included) or a scroll key is the reader taking
  // over: an in-flight scroll restore must not pull the view back afterwards.
  const handlePointerDown = useCallback(() => {
    noteReaderScrollIntent();
  }, [noteReaderScrollIntent]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!SCROLL_KEYS.has(event.key)) return;
    noteReaderScrollIntent();
    noteReaderScrollDirection(isScrollUpKey(event));
  }, [noteReaderScrollDirection, noteReaderScrollIntent]);

  const handleTouchMove = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const nextY = event.touches[0]?.clientY ?? null;
    const previousY = lastTouchYRef.current;
    if (nextY != null && previousY != null) {
      if (nextY - previousY > TOUCH_SCROLL_DEADBAND_PX) noteReaderScrollDirection(true);
      else if (previousY - nextY > TOUCH_SCROLL_DEADBAND_PX) noteReaderScrollDirection(false);
    }
    lastTouchYRef.current = nextY;
  }, [noteReaderScrollDirection]);

  const handleTouchEnd = useCallback(() => {
    lastTouchYRef.current = null;
  }, []);

  const jumpToLatest = useCallback(() => {
    userScrollUpAtRef.current = null;
    stickToBottomRef.current = true;
    setStickToBottom(true);
    setDetachAnchorRowKey(null);
    onReturnToLatest?.();
    scrollToBottomSoon();
  }, [onReturnToLatest, scrollToBottomSoon]);

  // How much arrived after bottom-follow broke, on the logical row order so a
  // turn folding the anchor row away neither zeroes nor inflates it. Fails
  // quiet (0) when the anchor row was re-grouped away, so the pill degrades to
  // its plain label.
  const newRowsSinceDetach = useMemo(
    () => countVisibleRowsAppendedSince({
      visibleKeys: groupedRowKeys,
      logicalKeys: presentedRowKeys,
      folds: turnFolds,
      anchorKey: detachAnchorRowKey,
    }),
    [groupedRowKeys, presentedRowKeys, turnFolds, detachAnchorRowKey],
  );

  const groupedRowIndexByKey = useMemo(() => buildDrawnRowKeyIndex(groupedRows), [groupedRows]);
  // Collected on the unfolded rows so a closed fold never drops an item (or a
  // reply preview) from the rail, then placed on the drawn rows: an item hidden
  // in a closed fold sits on the fold row and its jump opens the fold.
  const minimapSourceEntries = useMemo(
    () => placeMinimapEntriesOnVisibleRows(
      collectUserMessageMinimapSourceEntries(presentedRows, {
        includeCodexExtras: sessionProvider === "codex",
      }),
      groupedRowIndexByKey,
      foldIdByHiddenRowKey,
    ),
    [foldIdByHiddenRowKey, groupedRowIndexByKey, presentedRows, sessionProvider],
  );

  const promptHistoryFocusIndex = useMemo(() => {
    if (!scrollToPromptHistoryRequest?.eventKey) return null;
    const row = presentedRows.find((candidate) => (
      candidate.event.type === "user_message"
      && promptHistoryEventKey({ timestamp: candidate.timestamp, event: candidate.event }) === scrollToPromptHistoryRequest.eventKey
    ));
    if (!row) return null;
    const minimapIndex = minimapSourceEntries.findIndex((entry) => entry.rowKey === row.key && entry.kind !== "queued");
    return minimapIndex >= 0 ? minimapIndex : null;
  }, [presentedRows, minimapSourceEntries, scrollToPromptHistoryRequest]);

  const rowStartOffsetsForMinimap = useMemo(() => {
    void measurementTick;
    return computeRowStartOffsets(groupedRows.length, rowHeight, timelineRowGapPx);
  }, [groupedRows, rowHeight, measurementTick, timelineRowGapPx]);

  // Ticks are 1:1 with entries, so the ordinal IS the rail index — no
  // display-index translation step exists any more.
  const activeFullUserOrdinal = useMemo(
    () => computeActiveFullUserOrdinal(scrollTop, minimapSourceEntries, rowStartOffsetsForMinimap),
    [scrollTop, minimapSourceEntries, rowStartOffsetsForMinimap],
  );

  const jumpToRowFromMinimap = useCallback(
    (rowIndex: number, entry?: ChatUserMinimapSourceEntry) => {
      // Hidden in a closed fold: open it, then land on the row itself.
      if (entry?.foldId) {
        scrollToRowKey(entry.rowKey);
        return;
      }
      const el = scrollRef.current;
      if (!el) return;
      const offsets = computeRowStartOffsets(groupedRows.length, rowHeight, timelineRowGapPx);
      const targetTop = computeScrollTopForRow(rowIndex, offsets);
      const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
      const clamped = Math.max(0, Math.min(maxScroll, targetTop));
      stickToBottomRef.current = false;
      setStickToBottom(false);
      const before = el.scrollTop;
      el.scrollTop = clamped;
      if (el.scrollTop !== before) {
        programmaticScrollTargetRef.current = el.scrollTop;
      }
      setScrollTop(el.scrollTop);
    },
    [groupedRows, rowHeight, scrollToRowKey, timelineRowGapPx],
  );

  /** Renders a single row with turn-divider logic. Used by both paths. */
  const renderRow = useCallback((envelope: TranscriptGroupedEnvelope, index: number, virtualized: boolean) => {
    const currentTurn = getGroupedTurnId(envelope);
    // Turn dividers render at the END of a turn (the `done` row) for every
    // runtime; the old start-of-turn boundary divider is disabled.
    const showTurnDivider = false;
    const turnDividerLabel: string | null = null;
    // A fold row reads the same per-turn facts as its turn's `done` row.
    const foldEvent = envelope.event.type === "turn_fold" ? envelope.event : null;
    const turnEndKey = envelope.event.type === "done" ? envelope.key : (foldEvent?.turnEndKey ?? null);
    const turnEndDurationMs = turnEndKey
      ? (turnEndDurationByRowKey.get(turnEndKey) ?? null)
      : undefined;
    const turnToolEntries = turnEndKey
      ? (transcriptToolActivity.byDoneRowKey.get(turnEndKey) ?? EMPTY_WORK_LOG_ENTRIES)
      : undefined;
    const turnFileEntries = turnEndKey
      ? (transcriptToolActivity.fileEntriesByDoneRowKey.get(turnEndKey) ?? EMPTY_WORK_LOG_ENTRIES)
      : undefined;
    const turnFoldOpen = foldEvent ? openTurnFolds.has(foldEvent.foldId) : false;
    const turnWorkInFold = envelope.event.type === "done" && foldedTurnEndKeys.has(envelope.key);
    const turnProof = envelope.event.type === "done"
      ? turnProofByRowKey.get(envelope.key)
      : undefined;
    const inlineProof = inlineProofByRowKey.get(envelope.key);
    const sourcesTurnId = envelope.event.type === "done" ? envelope.event.turnId : foldEvent?.turnId;
    const turnSources = sourcesTurnId ? turnSourcesByTurnId.get(sourcesTurnId) : undefined;
    const turnModel = currentTurn
      ? (turnModelState.map.get(currentTurn) ?? null)
      : turnModelState.lastModel;

    // A turn that moved HEAD emits its own checkpoint-backed `turn_diff_summary`
    // row; the done divider's entry-derived fallback stands down for it so the
    // turn never shows two "files changed" summaries.
    const hasCheckpointDiffSummary = (envelope.event.type === "done" || foldEvent != null)
      && currentTurn != null
      && checkpointDiffTurnIds.has(currentTurn);

    const rowTurnActive = Boolean(currentTurn && activeTurnId && currentTurn === activeTurnId) && !sessionEnded;
    const anchored = envelope.key === anchoredRowKey;
    const assistantTurnCopy = assistantTurnCopyByRowKey.get(envelope.key) ?? null;
    const showForkHistoryDivider = envelope.key === forkHistoryDividerRowKey;

    if (virtualized) {
      return (
        <MeasuredEventRow
          key={envelope.key}
          index={index}
          onMeasure={handleMeasure}
          envelope={envelope}
          showTurnDivider={Boolean(showTurnDivider)}
          turnDividerLabel={turnDividerLabel}
          showForkHistoryDivider={showForkHistoryDivider}
          turnModel={turnModel}
          turnEndDurationMs={turnEndDurationMs}
          turnToolEntries={turnToolEntries}
          turnProof={turnProof}
          turnSources={turnSources}
          onOpenTurnSources={onOpenTurnSources}
          inlineProof={inlineProof}
          resolveProofThumbnailSrc={resolveProofThumbnailSrc}
          onOpenProofDrawer={onOpenProofDrawer}
          onApproval={handleApproval}
          onCodexRecovery={onCodexRecovery}
          onRecoverContinuity={onRecoverContinuity}
          onRetryProviderFailure={onRetryProviderFailure}
          onChooseProviderFailureModel={onChooseProviderFailureModel}
          onRunUnprocessedMessage={onRunUnprocessedMessage}
          onEditUnprocessedMessage={onEditUnprocessedMessage}
          onDismissUnprocessedMessage={onDismissUnprocessedMessage}
          surfaceMode={surfaceMode}
          surfaceProfile={surfaceProfile}
          assistantLabel={assistantLabel}
          sessionProvider={sessionProvider}
          resolveSpawnedChatProvider={resolveSpawnedChatProvider}
          turnActive={rowTurnActive}
          sessionTurnActive={sessionTurnActive}
          sessionEnded={sessionEnded}
          usageLimitResumeActive={usageLimitResumeActive}
          usageLimitResumeTurnId={usageLimitResumeTurnId}
          onOpenWorkspacePath={openWorkspacePath}
          onNavigateSuggestion={handleNavigateSuggestion}
          onReviewChanges={handleReviewChanges}
          turnFileEntries={turnFileEntries}
          hasCheckpointDiffSummary={hasCheckpointDiffSummary}
          onInsertDraft={onInsertDraft}
          onRevealChatTerminal={onRevealChatTerminal}
          onRewindFiles={onRewindFiles}
          turnDiffSummaries={turnDiffSummaries}
          respondingApprovalIds={respondingApprovalIds}
          pendingApprovalIds={pendingApprovalIds}
          resolvedInputStates={resolvedInputStates}
          resolvedInputAnswers={resolvedInputAnswers}
          laneId={laneId}
          sessionId={sessionId}
          runtimeName={runtimeName}
          mosaic={mosaic}
          anchored={anchored}
          onScrollToRowKey={scrollToRowKey}
          assistantTurnCopy={assistantTurnCopy}
          staleInterruptReceipts={staleInterruptReceipts}
          onCancelQueuedMessage={onCancelQueuedMessage}
          onRestoreCancelledQueue={onRestoreCancelledQueue}
          settledQueueRecoveryIds={settledQueueRecoveryIds}
          onStopSubagent={onStopSubagent}
          pacedTextReveal={envelope.key === pacedTextRowKey}
          liveThinking={envelope.key === liveThinkingDrawnKey}
          turnFoldOpen={turnFoldOpen}
          onToggleTurnFold={toggleTurnFold}
          turnWorkInFold={turnWorkInFold}
        />
      );
    }

    return (
      <EventRow
        key={envelope.key}
        envelope={envelope}
        showTurnDivider={Boolean(showTurnDivider)}
        turnDividerLabel={turnDividerLabel}
        showForkHistoryDivider={showForkHistoryDivider}
        turnModel={turnModel}
        turnEndDurationMs={turnEndDurationMs}
        turnToolEntries={turnToolEntries}
        turnProof={turnProof}
        turnSources={turnSources}
        onOpenTurnSources={onOpenTurnSources}
        inlineProof={inlineProof}
        resolveProofThumbnailSrc={resolveProofThumbnailSrc}
        onOpenProofDrawer={onOpenProofDrawer}
        onApproval={handleApproval}
        onCodexRecovery={onCodexRecovery}
        onRecoverContinuity={onRecoverContinuity}
        onRetryProviderFailure={onRetryProviderFailure}
        onChooseProviderFailureModel={onChooseProviderFailureModel}
        onRunUnprocessedMessage={onRunUnprocessedMessage}
        onEditUnprocessedMessage={onEditUnprocessedMessage}
        onDismissUnprocessedMessage={onDismissUnprocessedMessage}
        surfaceMode={surfaceMode}
        surfaceProfile={surfaceProfile}
        assistantLabel={assistantLabel}
        sessionProvider={sessionProvider}
        resolveSpawnedChatProvider={resolveSpawnedChatProvider}
        turnActive={rowTurnActive}
        sessionTurnActive={sessionTurnActive}
        sessionEnded={sessionEnded}
        usageLimitResumeActive={usageLimitResumeActive}
        usageLimitResumeTurnId={usageLimitResumeTurnId}
        onOpenWorkspacePath={openWorkspacePath}
        onNavigateSuggestion={handleNavigateSuggestion}
        onReviewChanges={handleReviewChanges}
        turnFileEntries={turnFileEntries}
        hasCheckpointDiffSummary={hasCheckpointDiffSummary}
        onInsertDraft={onInsertDraft}
        onRevealChatTerminal={onRevealChatTerminal}
        onRewindFiles={onRewindFiles}
        turnDiffSummaries={turnDiffSummaries}
        respondingApprovalIds={respondingApprovalIds}
        pendingApprovalIds={pendingApprovalIds}
        resolvedInputStates={resolvedInputStates}
        resolvedInputAnswers={resolvedInputAnswers}
        laneId={laneId}
        sessionId={sessionId}
        runtimeName={runtimeName}
        mosaic={mosaic}
        anchored={anchored}
        onScrollToRowKey={scrollToRowKey}
        assistantTurnCopy={assistantTurnCopy}
        staleInterruptReceipts={staleInterruptReceipts}
        onCancelQueuedMessage={onCancelQueuedMessage}
        onRestoreCancelledQueue={onRestoreCancelledQueue}
        settledQueueRecoveryIds={settledQueueRecoveryIds}
        onStopSubagent={onStopSubagent}
        pacedTextReveal={envelope.key === pacedTextRowKey}
        liveThinking={envelope.key === liveThinkingDrawnKey}
        turnFoldOpen={turnFoldOpen}
        onToggleTurnFold={toggleTurnFold}
        turnWorkInFold={turnWorkInFold}
      />
    );
  }, [activeTurnId, foldedTurnEndKeys, openTurnFolds, toggleTurnFold, anchoredRowKey, assistantLabel, assistantTurnCopyByRowKey, checkpointDiffTurnIds, surfaceMode, surfaceProfile, turnModelState, handleApproval, handleMeasure, openWorkspacePath, handleNavigateSuggestion, handleReviewChanges, onCodexRecovery, onRecoverContinuity, onRetryProviderFailure, onChooseProviderFailureModel, onRunUnprocessedMessage, onEditUnprocessedMessage, onDismissUnprocessedMessage, onInsertDraft, onRevealChatTerminal, onRewindFiles, turnDiffSummaries, respondingApprovalIds, pendingApprovalIds, resolvedInputStates, resolvedInputAnswers, laneId, sessionId, sessionProvider, resolveSpawnedChatProvider, sessionTurnActive, sessionEnded, usageLimitResumeActive, usageLimitResumeTurnId, runtimeName, mosaic, scrollToRowKey, forkHistoryDividerRowKey, staleInterruptReceipts, settledQueueRecoveryIds, onCancelQueuedMessage, onRestoreCancelledQueue, onStopSubagent, transcriptToolActivity, turnEndDurationByRowKey, turnProofByRowKey, inlineProofByRowKey, resolveProofThumbnailSrc, onOpenProofDrawer, turnSourcesByTurnId, onOpenTurnSources, pacedTextRowKey, liveThinkingDrawnKey]);

  // Compute the bottom spacer height for virtualized mode.
  const bottomSpacerHeight = useMemo(() => {
    if (!shouldVirtualize) return 0;
    let h = 0;
    for (let i = endIndex; i < groupedRows.length; i++) {
      h += rowHeight(i) + timelineRowGapPx;
    }
    // The trailing gap accounts for the space between the last rendered row
    // and the first unrendered row — keep it so the total content fills
    // totalHeight exactly (offsetTop already includes the gap before the
    // first rendered row via the offsets array).
    return Math.max(0, h);
  }, [shouldVirtualize, endIndex, groupedRows.length, rowHeight, timelineRowGapPx]);

  const streamingIndicator = showStreamingIndicator && !sessionEnded ? (
    <motion.div
      className="w-fit max-w-[var(--chat-content-width,52rem)] pt-3 pb-2"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.12, ease: "easeOut" }}
    >
      <WorkingIndicator
        activity={
          activeProviderRetryActivity
            ? activeProviderRetryActivity
            : resolveWorkingIndicatorLabel(
              latestActivity?.activity ?? null,
              transcriptToolActivity.activeFileEntries,
            )
        }
        startedAt={activeTurnStartedAt}
        toolEntries={transcriptToolActivity.activeEntries}
        onNavigateSuggestion={handleNavigateSuggestion}
        onInsertDraft={onInsertDraft}
        onRevealChatTerminal={onRevealChatTerminal}
        sessionId={sessionId}
      />
    </motion.div>
  ) : null;

  // End-of-turn dividers now render inline at each `done` row (DoneTurnDivider),
  // so there is no separate bottom divider.
  const turnDivider = null;
  const trailingProof = unanchoredProofArtifacts.length > 0 ? (
    <div className="w-full max-w-[var(--chat-content-width,52rem)]">
      <ChatProofFilmstrip
        artifacts={unanchoredProofArtifacts}
        title="Proof added"
        defaultOpen={false}
        resolveThumbnailSrc={resolveProofThumbnailSrc}
        onOpenAll={onOpenProofDrawer}
        onOpenArtifact={onOpenProofDrawer}
      />
    </div>
  ) : null;

  // Jump-to-latest pill is only meaningful during an active turn — if nothing
  // is streaming there's no "latest" to catch up to.
  const showJumpToLatest = !stickToBottom && !sessionEnded;

  return (
    <ChatWorkspacePathProvider value={workspacePaths}>
    <div
      ref={listRootRef}
      data-chat-message-list-root=""
      className={cn("relative h-full min-h-0 min-w-0 max-w-full overflow-hidden", className)}
    >
      {/* Direct child of the list root on purpose: the rail's `left-0` and all of
          its gutter maths assume the offset parent is the element whose width is
          `listWidthPx`. An intermediate max-width wrapper would silently shift
          the rail into the message column. Floating panes stay independent of
          this fixed transcript anchor. */}
      <ChatUserMinimap
        entries={minimapSourceEntries}
        activeIndex={activeFullUserOrdinal}
        onJumpToRow={jumpToRowFromMinimap}
        hasOlderHistory={hasOlderHistory}
        loadingOlderHistory={loadingOlderHistory}
        olderHistoryError={olderHistoryError}
        onLoadOlderHistory={onLoadOlderHistory}
        onRetryOlderHistory={onRetryOlderHistory}
        listWidthPx={listRootBoxPx.width}
        listHeightPx={listRootBoxPx.height}
        columnWidthPx={columnWidthPx}
        keyboardFocusIndex={promptHistoryFocusIndex}
        keyboardFocusRequestId={scrollToPromptHistoryRequest?.requestId ?? null}
      />
      <div
        ref={scrollRef}
        className="ade-chat-timeline-pane h-full min-h-0 min-w-0 overflow-x-hidden overflow-y-auto pl-[length:var(--chat-timeline-pad-x)] pr-[length:var(--chat-timeline-pad-x)] pt-[length:var(--chat-timeline-pad-top)] pb-[length:var(--chat-timeline-pad-bottom)]"
        onScroll={handleScroll}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onKeyDown={handleKeyDown}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
      >
        <div ref={contentWrapperRef} className="mx-auto w-full min-w-0 max-w-[var(--chat-column,52rem)] overflow-visible">
          {hasOlderHistory ? (
            /* Older history backfills silently: the IntersectionObserver on this
               sentinel (and the underfill effect) page it in without ever asking
               the reader to do anything, so the healthy path renders an EMPTY
               fixed-height slot. Only a latched failure earns words. The height
               is constant either way, so toggling never shifts the transcript.
               Unmounts entirely once the head of the transcript is reached. */
            <div
              ref={olderHistorySentinelRef}
              className="flex h-7 shrink-0 items-center justify-center font-sans text-[11px] text-fg/45"
              role="status"
              aria-live="polite"
            >
              {olderHistoryError ? (
                <button
                  type="button"
                  onClick={onRetryOlderHistory}
                  disabled={loadingOlderHistory}
                  className="rounded px-2 py-0.5 text-fg/55 transition-colors hover:bg-white/[0.05] hover:text-fg/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
                  aria-label={loadingOlderHistory ? "Loading earlier messages" : "Retry loading earlier messages"}
                  aria-busy={loadingOlderHistory}
                  title={olderHistoryError}
                >
                  {loadingOlderHistory ? "loading earlier messages…" : "couldn’t load earlier messages · retry"}
                </button>
              ) : null}
            </div>
          ) : null}
          {/* Proof with no following turn completion is a chronological tail
              row, not the old permanently pinned footer. */}
          {rows.length === 0 && !streamingIndicator && !trailingProof ? (
            null
          ) : shouldVirtualize ? (
            /* ── Virtualized path: only render rows in / near the viewport ── */
            <div className="flex min-w-0 max-w-full flex-col gap-[length:var(--chat-row-gap)]">
              <div style={{ height: totalHeight, position: "relative" }}>
                {/* Top spacer pushes rendered rows to their correct scroll position */}
                <div style={{ height: offsetTop }} aria-hidden />
                <div className="flex flex-col gap-[length:var(--chat-row-gap)]">
                  {groupedRows.slice(startIndex, Math.min(endIndex, groupedRows.length)).map((envelope, i) =>
                    renderRow(envelope, startIndex + i, true)
                  )}
                </div>
                {/* Bottom spacer fills remaining scroll area */}
                <div style={{ height: bottomSpacerHeight }} aria-hidden />
              </div>
              {trailingProof}
              {streamingIndicator}
              {turnDivider}
            </div>
          ) : (
            /* ── Non-virtualized path: render all rows (small conversation) ── */
            <div className="flex min-w-0 max-w-full flex-col gap-[length:var(--chat-row-gap)]">
              {groupedRows.map((envelope, index) => renderRow(envelope, index, false))}
              {trailingProof}
              {streamingIndicator}
              {turnDivider}
            </div>
          )}
        </div>
      </div>
      {showJumpToLatest ? (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border border-violet-400/30 bg-violet-500/20 px-2 py-1 font-sans text-[length:calc(var(--chat-font-size)*10/14)] font-medium text-violet-100 shadow-lg shadow-violet-500/20 backdrop-blur-md transition-colors hover:bg-violet-500/30"
          aria-label={newRowsSinceDetach > 0 ? `${newRowsSinceDetach} new · Jump To Latest` : "Jump to latest message"}
        >
          <CaretDown size={9} weight="bold" />
          {/* Answers "did I miss anything?" without making the reader scroll to find out. */}
          <span>{newRowsSinceDetach > 0 ? `${newRowsSinceDetach} new · Jump To Latest` : "Jump To Latest"}</span>
        </button>
      ) : null}
      <AssistantOutputSelectionToolbar rootRef={listRootRef} onAddToChat={onInsertDraft} />
    </div>
    </ChatWorkspacePathProvider>
  );
}

// Memoized transcript boundary. Draft/composer keystrokes rerender the owning
// pane (AgentChatPane / PersonalChatsPage), but those callers pass referentially
// stable props (memoized events/state + useCallback'd row-facing handlers), so a
// draft-only update no longer commits the message list or its virtualized rows.
// The component still rerenders on real transcript/prop changes and on its own
// appStore subscriptions (density, runtime name).
export const AgentChatMessageList = React.memo(AgentChatMessageListMain);
AgentChatMessageList.displayName = "AgentChatMessageList";

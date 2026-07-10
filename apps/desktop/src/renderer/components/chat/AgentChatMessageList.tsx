import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { motion } from "motion/react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  CaretDown,
  CaretLeft,
  CaretRight,
  Bug,
  CloudArrowUp,
  Warning,
  Terminal,
  FileCode,
  Check,
  CheckCircle,
  XCircle,
  Circle,
  Checks,
  ListChecks,
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
} from "@phosphor-icons/react";
import type {
  AgentChatApprovalDecision,
  AgentChatCompletionStatus,
  AgentChatEvent,
  AgentChatEventEnvelope,
  AgentChatNoticeDetail,
  AgentChatRecoverCodexTurnArgs,
  AgentChatRecoverCodexTurnResult,
  ChatSurfaceChipTone,
  FilesWorkspace,
  ChatSurfaceProfile,
  ChatSurfaceMode,
  OperatorNavigationSuggestion,
  TurnDiffSummary,
} from "../../../shared/types";
import { getModelById, resolveModelDescriptor, type ModelDescriptor } from "../../../shared/modelRegistry";
import { cn } from "../ui/cn";
import { formatTime } from "../../lib/format";
import { openUrlInAdeBrowser } from "../../lib/openExternal";
import { isPathEqualOrDescendant, isWindowsAbsolutePath, normalizePath } from "../../lib/pathUtils";
import { describeToolIdentifier, replaceInternalToolNames } from "./toolPresentation";
import { chatChipToneClass } from "./chatSurfaceTheme";
import {
  CHAT_TRANSCRIPT_GLASS_CARD_CLASS,
  CHAT_USER_MESSAGE_CARD_STYLE,
  CHAT_WORK_LOG_CARD_CLASS,
} from "./chatTranscriptChrome";
import { useAppStore } from "../../state/appStore";
import { transcriptRowGapPx, useChatChromeTint } from "./chatAppearance";
import { ChatAttachmentTray } from "./ChatAttachmentTray";
import { getToolMeta } from "./chatToolAppearance";
import { ClaudeLogo, CodexLogo, CursorAgentLogo } from "../terminals/ToolLogos";
import { ModelRowLogo, ProviderLogo } from "../shared/ProviderLogos";
import { ChatMarkdown } from "./chatMarkdown";
import { pendingInputHeaderLabel } from "../../../shared/pendingInputLabels";
import type { ChatSubagentSnapshot } from "./chatExecutionSummary";
import { ChatWorkLogBlock } from "./ChatWorkLogBlock";
import { ChatStatusGlyph } from "./chatStatusVisuals";
import {
  collapseChatTranscriptEvents,
  collapseChatTranscriptEventsIncrementalWithContext,
  formatStructuredValue,
  groupChatTranscriptRows,
  readRecord,
  summarizeDiffStats,
  summarizeInlineText,
  type BackgroundFinishChipRenderEvent,
  type ChatActivityBundleEvent,
  type ChatActivityBundleItem,
  type CollapseTranscriptResult,
  type ScheduledWakeDividerRenderEvent,
  type SubagentResultCardRenderEvent,
  type SubagentSpawnAnchorRenderEvent,
  type ChatTranscriptGroupedEnvelope as TranscriptGroupedEnvelope,
  type ChatTranscriptRenderEnvelope as TranscriptRenderEnvelope,
} from "./chatTranscriptRows";
import { BackgroundFinishChip, SubagentResultCard, SubagentSpawnCard } from "./SubagentActivityCards";
import { ChatUserMinimap } from "./ChatUserMinimap";
import { AgentCliAuthCard, type AgentCliAuthCardInfo } from "./AgentCliAuthCard";
import { HighlightedCode } from "./CodeHighlighter";
import { MosaicCard } from "./MosaicCard";
import { MOSAIC_FENCE_LANGUAGE } from "../../../shared/chatMosaic";
import {
  CHAT_TIMELINE_ROW_GAP_PX,
  buildMinimapDisplayEntries,
  collectUserMessageMinimapSourceEntries,
  computeActiveDisplayIndex,
  computeActiveFullUserOrdinal,
  computeRowStartOffsets,
  computeScrollTopForRow,
} from "./chatUserMinimap.logic";
import { readPendingInputRequest, buildLegacyPendingInputFromApprovalEvent } from "./pendingInput";
import type { PendingInputQuestion, PendingInputRequest } from "../../../shared/types";
import { CodexPlanCard } from "./codex/CodexPlanCard";
import { CodexImageGenerationCard } from "./codex/CodexImageGenerationCard";
import { CodexImageViewLine } from "./codex/CodexImageViewLine";
import { ContextCompactDivider } from "./ContextCompactDivider";
import { peekPendingSessionAnchor, takePendingSessionAnchor } from "../terminals/pendingSessionAnchors";
import { ChatTurnFileChangesPanel, aggregateFiles } from "./ChatFileChangesPanel";

/**
 * Threaded into MarkdownBlock only for Claude-family sessions. When present, a
 * ```mosaic fence renders as an interactive card instead of a plain code block.
 * `scope` is the transcript row's stable key so byte-identical cards at
 * different positions keep independent answered state.
 */
export type MosaicRenderContext = {
  cardKeyFor: (source: string, scope: string) => string;
  onSubmit: (submission: { text: string; displayText: string }) => void | Promise<void>;
};

const NAVIGATION_SURFACES = new Set(["work", "lanes", "cto"]);
type PendingInputResolution = Extract<AgentChatEvent, { type: "pending_input_resolved" }>["resolution"];
type WorkspacePathLocation = {
  path: string;
  startLine?: number;
  startColumn?: number;
};

type CodexTurnStalledEvent = Extract<AgentChatEvent, { type: "codex_turn_stalled" }>;

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
  const targetSessionId = event.sourceSessionId?.trim() || sessionId?.trim() || "";
  const optionLabels: Record<AgentChatRecoverCodexTurnArgs["action"], string> = {
    wait: "Wait",
    steer: "Nudge",
    interrupt_retry_same_thread: "Retry",
    restart_resume_thread: "Resume",
  };
  const resultLabels: Record<AgentChatRecoverCodexTurnResult["status"], string> = {
    waiting: "Waiting for Codex output…",
    nudged: "Status nudge sent.",
    retrying: "Retry started in this thread.",
    resumed: "Codex app-server restarted and the thread resumed.",
  };

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
    <div className="w-fit max-w-[min(100%,42rem)] rounded-lg border border-amber-300/16 bg-amber-500/[0.055] px-3 py-2.5 font-sans text-[length:calc(var(--chat-font-size)*11/14)] text-amber-100/78">
      <div className="flex items-center gap-2">
        <Warning size={13} weight="duotone" className="shrink-0 text-amber-200/75" />
        <span className="font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-[0.16em] text-amber-200/55">recovery</span>
        <span className="min-w-0 truncate">Codex paused unexpectedly</span>
      </div>
      <div className="mt-1.5 text-[length:calc(var(--chat-font-size)*10.5/14)] leading-relaxed text-amber-50/64">
        {event.message}
      </div>
      {event.recoveryOptions?.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {event.recoveryOptions.slice(0, 4).map((option) => (
            <button
              key={option}
              type="button"
              disabled={!targetSessionId || !onRecover || pendingAction != null}
              className="rounded-md border border-amber-200/12 bg-amber-300/[0.055] px-2 py-0.5 font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-semibold text-amber-100/65 transition-colors hover:border-amber-200/25 hover:bg-amber-300/[0.11] hover:text-amber-50 disabled:pointer-events-none disabled:opacity-45"
              onClick={() => void recover(option)}
            >
              {pendingAction === option ? `${optionLabels[option]}…` : optionLabels[option]}
            </button>
          ))}
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

function getEventTurnId(event: AgentChatEvent): string | null {
  if (!("turnId" in event) || typeof event.turnId !== "string") return null;
  const turnId = event.turnId.trim();
  return turnId.length ? turnId : null;
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

function formatTokenCount(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
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

function describeUserDeliveryState(event: Extract<AgentChatEvent, { type: "user_message" }>): { label: string; className: string } | null {
  if (event.deliveryState === "failed") {
    return {
      label: "failed",
      className: "ade-chat-status-pill border-red-500/25 text-red-300",
    };
  }
  // Queued user_messages render in the staging area only, not in the chat
  // thread, so we never need a "queued" delivery chip in the bubble itself.
  if (event.deliveryState === "inline") {
    return {
      label: "during turn",
      className: "ade-chat-status-pill border-violet-500/15 text-violet-300/70",
    };
  }
  if (event.processed) {
    return {
      label: "processed",
      className: "ade-chat-status-pill border-emerald-500/25 text-emerald-300",
    };
  }
  if (event.deliveryState === "delivered") {
    return {
      label: "sent",
      className: "ade-chat-status-pill border-sky-500/25 text-sky-300",
    };
  }
  return null;
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
  const hasIssueContext = contextAttachments.some((a) => a.type === "linear_issue");
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

type RenderEnvelope = {
  key: string;
  timestamp: string;
  event: AgentChatEvent | {
    type: "tool_invocation";
    tool: string;
    args: unknown;
    itemId: string;
    parentItemId?: string;
    turnId?: string;
    result?: unknown;
    status: "running" | "completed" | "failed";
  }
  | SubagentSpawnAnchorRenderEvent
  | SubagentResultCardRenderEvent
  | BackgroundFinishChipRenderEvent
  | ScheduledWakeDividerRenderEvent;
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
  const [copied, setCopied] = useState(false);
  const mountedRef = useRef(true);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (resetTimerRef.current !== null) {
        clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  const handleCopy = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(value)
      .then(() => {
        if (!mountedRef.current) return;
        if (resetTimerRef.current !== null) {
          clearTimeout(resetTimerRef.current);
        }
        setCopied(true);
        resetTimerRef.current = window.setTimeout(() => {
          resetTimerRef.current = null;
          if (!mountedRef.current) return;
          setCopied(false);
        }, 1_500);
      })
      .catch(() => {
        if (!mountedRef.current) return;
        if (resetTimerRef.current !== null) {
          clearTimeout(resetTimerRef.current);
          resetTimerRef.current = null;
        }
        setCopied(false);
      });
  }, [value]);

  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-white/[0.06] bg-white/[0.03] px-1.5 py-0.5 font-sans text-[length:calc(var(--chat-font-size)*9/14)] text-fg/40 transition-all hover:border-violet-400/20 hover:bg-violet-500/[0.06] hover:text-fg/70",
        className,
      )}
      onClick={handleCopy}
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

function todoItemStatusClass(status: string): string {
  switch (status) {
    case "completed":
      return "border-emerald-400/18 bg-emerald-500/[0.08] text-emerald-300/80";
    case "in_progress":
      return "border-sky-400/18 bg-sky-500/[0.08] text-sky-300/80";
    default:
      return "border-amber-400/18 bg-amber-500/[0.08] text-amber-300/80";
  }
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

function isExternalHref(href: string): boolean {
  const trimmed = href.trim();
  if (/^file:/i.test(trimmed)) return false;
  if (isWindowsAbsolutePath(trimmed)) return false;
  return /^(?:[a-z]+:)?\/\//i.test(trimmed) || /^mailto:/i.test(trimmed) || /^tel:/i.test(trimmed);
}

function readWorkspacePathFragmentPosition(fragment: string): Pick<WorkspacePathLocation, "startLine" | "startColumn"> {
  const trimmed = fragment.trim();
  if (!trimmed.length) return {};

  const lineMatch = trimmed.match(/^L(\d+)(?:C(\d+))?(?:-L?\d+)?$/i);
  if (lineMatch) {
    const [, startLineRaw, startColumnRaw] = lineMatch;
    return {
      startLine: Number(startLineRaw),
      startColumn: startColumnRaw ? Number(startColumnRaw) : undefined,
    };
  }

  const explicitMatch = trimmed.match(/^line=(\d+)(?:,(\d+))?$/i);
  if (!explicitMatch) return {};
  const [, startLineRaw, startColumnRaw] = explicitMatch;
  return {
    startLine: Number(startLineRaw),
    startColumn: startColumnRaw ? Number(startColumnRaw) : undefined,
  };
}

function splitWorkspacePathLineSuffix(path: string): WorkspacePathLocation {
  const match = path.match(/^(.*?)(?::(\d+))(?::(\d+))?$/);
  if (!match) return { path };

  const [, candidatePath, startLineRaw, startColumnRaw] = match;
  if (!candidatePath.length) return { path };
  return {
    path: candidatePath,
    startLine: Number(startLineRaw),
    startColumn: startColumnRaw ? Number(startColumnRaw) : undefined,
  };
}

function parseWorkspacePathLocation(value: string): WorkspacePathLocation | null {
  const trimmed = value.trim();
  if (!trimmed.length) return null;
  if (/^(?:https?|mailto|tel):/i.test(trimmed)) return null;
  if (/^#/.test(trimmed)) return null;

  let rawPath: string;
  let rawFragment = "";
  if (/^file:/i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      rawPath = `${url.host ? `//${url.host}` : ""}${url.pathname}`.trim();
      rawFragment = url.hash.startsWith("#") ? url.hash.slice(1) : "";
    } catch {
      const withoutScheme = trimmed.replace(/^file:\/\//i, "");
      const [withoutFragment, fallbackFragment = ""] = withoutScheme.split("#", 2);
      rawPath = withoutFragment.split("?", 1)[0]?.trim() ?? "";
      rawFragment = fallbackFragment;
    }
  } else {
    const [withoutFragment, fallbackFragment = ""] = trimmed.split("#", 2);
    rawPath = withoutFragment.split("?", 1)[0]?.trim() ?? "";
    rawFragment = fallbackFragment;
  }
  let decodedPath = rawPath;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    // Keep the raw path when markdown produced a partially-encoded href.
  }

  const slashNormalized = decodedPath.replace(/\\/g, "/");
  if (!slashNormalized.length) return null;

  const normalizedDrivePath = /^\/[A-Za-z]:\//.test(slashNormalized) ? slashNormalized.slice(1) : slashNormalized;
  const fromSuffix = splitWorkspacePathLineSuffix(normalizedDrivePath);
  const fromFragment = readWorkspacePathFragmentPosition(rawFragment);
  const normalizedPath = normalizePath(fromSuffix.path);
  if (!normalizedPath.length) return null;

  return {
    path: normalizedPath,
    startLine: fromFragment.startLine ?? fromSuffix.startLine,
    startColumn: fromFragment.startColumn ?? fromSuffix.startColumn,
  };
}

function looksLikeWorkspacePath(value: string): boolean {
  const candidate = parseWorkspacePathLocation(value);
  if (!candidate) return false;
  if (candidate.path === ".." || candidate.path.startsWith("../") || candidate.path.startsWith("~/")) {
    return false;
  }
  if (candidate.path.startsWith("/")) {
    return candidate.path.slice(1).includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(candidate.path);
  }
  return candidate.path.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(candidate.path);
}

function resolveWorkspacePathFromHref(href: string | undefined): WorkspacePathLocation | null {
  if (!href) return null;
  if (isExternalHref(href)) return null;
  const candidate = parseWorkspacePathLocation(href);
  if (!candidate) return null;
  return looksLikeWorkspacePath(href) ? candidate : null;
}

function chatMarkdownUrlTransform(value: string): string {
  if (/^file:/i.test(value) || isWindowsAbsolutePath(value)) {
    return value;
  }
  return defaultUrlTransform(value);
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
            onClick={() => openUrlInAdeBrowser(action.url)}
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

function activityBundleTaskId(item: ChatActivityBundleItem): string | null {
  const event = item.event;
  if (event.type === "scheduled_work_update") return event.sourceTaskId ?? event.id;
  return null;
}

function activityBundleKind(item: ChatActivityBundleItem): "task" | "schedule" {
  const event = item.event;
  if (event.type === "scheduled_work_update") return "schedule";
  return "task";
}

function activityBundleStatus(item: ChatActivityBundleItem): string {
  const event = item.event;
  if (event.type === "todo_update") {
    if (event.items.length === 1) return event.items[0]!.status.replace("_", " ");
    const completed = event.items.filter((task) => task.status === "completed").length;
    return event.items.length ? `${completed}/${event.items.length} complete` : "updated";
  }
  return event.status.replace(/_/g, " ");
}

function activityBundleTitle(item: ChatActivityBundleItem): string {
  const event = item.event;
  if (event.type === "todo_update") {
    if (event.items.length === 1) return event.items[0]!.description.trim() || "Task updated";
    const active = event.items.find((task) => task.status === "in_progress") ?? event.items.find((task) => task.status !== "completed") ?? event.items.at(-1);
    return active?.description?.trim() || "Task list updated";
  }
  return event.title?.trim()
    || event.reason?.trim()
    || event.prompt?.trim()
    || (event.kind === "cron" ? "Cron schedule" : "Scheduled work");
}

function activityBundleDetail(item: ChatActivityBundleItem): string | null {
  const event = item.event;
  if (event.type === "todo_update") {
    const changed = event.items.filter((task) => task.status !== "pending");
    return changed.slice(0, 3).map((task) => `${task.status.replace("_", " ")}: ${task.description}`).join(" · ") || null;
  }
  return event.summary?.trim()
    || event.error?.trim()
    || event.cron?.trim()
    || event.nextRunAt?.trim()
    || null;
}

function activityKindLabel(kind: ReturnType<typeof activityBundleKind>): string {
  if (kind === "task") return "tasks";
  return "schedule";
}

function activityKindTone(kind: ReturnType<typeof activityBundleKind>): string {
  if (kind === "task") return "border-cyan-300/14 bg-cyan-300/[0.055] text-cyan-100/72";
  return "border-amber-300/14 bg-amber-300/[0.055] text-amber-100/72";
}

function activityStatusIcon(item: ChatActivityBundleItem): React.ReactNode {
  if (item.event.type === "todo_update") {
    const total = item.event.items.length;
    const completed = item.event.items.filter((task) => task.status === "completed").length;
    return total > 0 && completed === total
      ? <CheckCircle size={12} weight="bold" className="text-emerald-300/80" />
      : <Circle size={10} weight="fill" className="text-sky-300/75" />;
  }
  const status = activityBundleStatus(item);
  if (status.includes("failed")) return <XCircle size={12} weight="bold" className="text-red-300/80" />;
  if (status.includes("stopped") || status.includes("cancelled")) return <Warning size={12} weight="fill" className="text-amber-300/80" />;
  if (status.includes("complete")) return <CheckCircle size={12} weight="bold" className="text-emerald-300/80" />;
  return <Circle size={10} weight="fill" className="text-sky-300/75" />;
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

function activityBundleDedupeKey(item: ChatActivityBundleItem): string {
  const event = item.event;
  if (event.type === "scheduled_work_update") {
    return `schedule:${event.sourceTaskId ?? event.id}`;
  }
  return `todo:${item.key}`;
}

// Now that subagent lifecycle events render as dedicated cards, activity bundles
// only carry task (todo) + scheduled-work rows. Folding collapses repeated
// scheduled-work updates for the same id down to the latest.
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

function activityBundleSummary(items: ChatActivityBundleItem[]): string {
  const kinds = Array.from(new Set(items.map(activityBundleKind)));
  if (items.length === 1) {
    const kind = activityBundleKind(items[0]!);
    return kind === "task" ? "Task updated" : "Scheduled work updated";
  }
  if (kinds.length === 1 && kinds[0] === "task") return "Task updates";
  if (kinds.length === 1 && kinds[0] === "schedule") return "Scheduled work updates";
  return "Work updates";
}

function ActivityBundleRow({
  item,
  sessionId,
  standalone = false,
}: {
  item: ChatActivityBundleItem;
  sessionId?: string | null;
  standalone?: boolean;
}) {
  const kind = activityBundleKind(item);
  const detail = activityBundleDetail(item);
  const title = activityBundleTitle(item);
  const taskId = activityBundleTaskId(item);

  return (
    <button
      type="button"
      className={cn(
        "group flex w-full min-w-0 items-start gap-2.5 text-left transition-colors",
        standalone
          ? "rounded-lg border border-white/[0.06] bg-white/[0.028] px-3 py-2.5 shadow-[0_10px_30px_rgba(0,0,0,0.10)] hover:border-white/[0.11] hover:bg-white/[0.04]"
          : "rounded-md px-1.5 py-1.5 hover:bg-white/[0.035]",
      )}
      onClick={() => openChatInfoFromActivity(sessionId, taskId)}
    >
      <span className="mt-0.5 shrink-0">
        {activityStatusIcon(item)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="truncate font-sans text-[length:calc(var(--chat-font-size)*11/14)] text-fg/76">{title}</span>
          <span className={cn("rounded-md border px-1.5 py-0.5 font-mono text-[length:calc(var(--chat-font-size)*7.5/14)] font-bold uppercase tracking-[0.14em]", activityKindTone(kind))}>
            {activityBundleStatus(item)}
          </span>
        </span>
        {detail ? (
          <span className="mt-0.5 block truncate text-[length:calc(var(--chat-font-size)*9.5/14)] text-fg/38">{summarizeInlineText(detail, 160)}</span>
        ) : null}
      </span>
    </button>
  );
}

function ChatActivityBundle({
  event,
  sessionId,
}: {
  event: ChatActivityBundleEvent;
  sessionId?: string | null;
}) {
  const displayItems = foldActivityBundleItems(event.items);
  const [open, setOpen] = useState(displayItems.length <= 3);
  const kinds = Array.from(new Set(displayItems.map(activityBundleKind)));
  const primaryKind = kinds[0] ?? "task";
  const summary = activityBundleSummary(displayItems);

  if (displayItems.length === 1) {
    return <ActivityBundleRow item={displayItems[0]!} sessionId={sessionId} standalone />;
  }

  return (
    <div
      className="w-full min-w-0 max-w-full rounded-lg border border-white/[0.055] bg-white/[0.028] px-2.5 py-2 shadow-[0_10px_30px_rgba(0,0,0,0.10)] transition-colors hover:border-white/[0.1] hover:bg-white/[0.04]"
      onClick={() => openChatInfoFromActivity(sessionId, null)}
    >
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={(clickEvent) => {
            clickEvent.stopPropagation();
            setOpen((value) => !value);
          }}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fg/34 transition-colors hover:bg-white/[0.045] hover:text-fg/60"
          title={open ? "Collapse activity" : "Expand activity"}
        >
          {open ? <CaretDown size={11} weight="bold" /> : <CaretRight size={11} weight="bold" />}
        </button>
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-violet-300/[0.075] text-violet-100/70">
          {primaryKind === "task" ? <ListChecks size={13} weight="regular" /> : <Target size={13} weight="duotone" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="truncate font-sans text-[length:calc(var(--chat-font-size)*11/14)] text-fg/76">{summary}</span>
            <span className={cn("rounded-md border px-1.5 py-0.5 font-mono text-[length:calc(var(--chat-font-size)*8/14)] font-bold uppercase tracking-[0.14em]", activityKindTone(primaryKind))}>
              {displayItems.length} {activityKindLabel(primaryKind)}
            </span>
          </div>
        </div>
      </div>
      {open ? (
        <div className="ml-8 mt-2 space-y-1.5 border-l border-white/[0.06] pl-3" onClick={(clickEvent) => clickEvent.stopPropagation()}>
          {displayItems.map((item) => (
            <ActivityBundleRow key={activityBundleDedupeKey(item)} item={item} sessionId={sessionId} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function resolveFilesNavigationTarget(args: {
  path: string | WorkspacePathLocation;
  workspaces: FilesWorkspace[];
  fallbackLaneId: string | null;
}): { openFilePath: string; laneId: string | null; startLine?: number; startColumn?: number } | null {
  const candidate = typeof args.path === "string" ? parseWorkspacePathLocation(args.path) : args.path;
  if (!candidate) return null;

  const normalizedCandidate = normalizePath(candidate.path);
  if (normalizedCandidate.startsWith("/") || isWindowsAbsolutePath(normalizedCandidate)) {
    const matches = args.workspaces
      .map((workspace) => ({
        workspace,
        rootPath: normalizePath(workspace.rootPath),
      }))
      .filter(({ rootPath }) => isPathEqualOrDescendant(normalizedCandidate, rootPath))
      .sort((left, right) => {
        const rightMatchesLane = right.workspace.laneId != null && right.workspace.laneId === args.fallbackLaneId ? 1 : 0;
        const leftMatchesLane = left.workspace.laneId != null && left.workspace.laneId === args.fallbackLaneId ? 1 : 0;
        if (rightMatchesLane !== leftMatchesLane) return rightMatchesLane - leftMatchesLane;
        return right.rootPath.length - left.rootPath.length;
      });

    const match = matches[0];
    if (!match) return null;
    const openFilePath = normalizedCandidate.slice(match.rootPath.length).replace(/^\/+/, "");
    if (!openFilePath.length) return null;
    return {
      openFilePath,
      laneId: match.workspace.laneId ?? args.fallbackLaneId ?? null,
      startLine: candidate.startLine,
      startColumn: candidate.startColumn,
    };
  }

  const openFilePath = normalizedCandidate.replace(/^\.\//, "");
  if (!openFilePath.length) return null;
  return {
    openFilePath,
    laneId: args.fallbackLaneId ?? null,
    startLine: candidate.startLine,
    startColumn: candidate.startColumn,
  };
}

/* ── Markdown renderer ── */

const MarkdownBlock = React.memo(function MarkdownBlock({
  markdown,
  onOpenWorkspacePath,
  workspaceLaneId,
  mosaic,
  mosaicScopeKey,
}: {
  markdown: string;
  onOpenWorkspacePath?: (path: string | WorkspacePathLocation, laneId?: string | null) => void;
  workspaceLaneId?: string | null;
  mosaic?: MosaicRenderContext;
  /** Stable transcript-row key scoping mosaic answered state per message. */
  mosaicScopeKey?: string;
}) {
  const chromeTint = useChatChromeTint();
  const neu = chromeTint === "neutral";
  const openWorkspacePath = useCallback((path: WorkspacePathLocation) => {
    onOpenWorkspacePath?.(path, workspaceLaneId ?? null);
  }, [onOpenWorkspacePath, workspaceLaneId]);

  return (
    <div
      className={cn(
        "ade-prose-themed prose prose-invert min-w-0 max-w-full break-words text-[length:calc(var(--chat-font-size)*13/14)] leading-[1.8]",
        neu
          ? "text-white/92 prose-headings:text-white/95 prose-p:text-white/88 prose-li:text-white/86 prose-strong:text-white prose-blockquote:text-white/76"
          : "text-fg/96 prose-headings:text-fg prose-p:text-fg/88 prose-li:text-fg/86 prose-strong:text-fg prose-blockquote:text-fg/76",
        "prose-headings:mb-3 prose-headings:mt-6 prose-headings:font-sans prose-headings:font-semibold prose-headings:tracking-tight",
        "prose-p:my-3 prose-p:break-words prose-ul:my-3 prose-ul:pl-5 prose-ol:my-3 prose-ol:pl-5 prose-li:my-1.5 prose-li:break-words prose-li:pl-1",
        "prose-blockquote:border-l-2 prose-blockquote:border-l-white/20 prose-blockquote:pl-4 prose-hr:my-5 prose-hr:border-white/[0.08]",
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={chatMarkdownUrlTransform}
        components={{
          h1: ({ children }) => <h1 className="text-[1rem]">{children}</h1>,
          h2: ({ children }) => <h2 className="text-[0.95rem]">{children}</h2>,
          h3: ({ children }) => <h3 className="text-[0.9rem]">{children}</h3>,
          ul: ({ children }) => <ul className="my-3 list-disc space-y-1.5 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-3 list-decimal space-y-1.5 pl-5">{children}</ol>,
          li: ({ children }) => (
            <li className={neu ? "pl-1 text-white/86" : "pl-1 text-fg/88"}>{children}</li>
          ),
          blockquote: ({ children }) => (
            <blockquote
              className={neu ? "border-l-2 border-white/20 pl-4 italic text-white/74" : "border-l-2 border-white/20 pl-4 italic text-fg/72"}
            >
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div className="my-4 overflow-x-auto rounded-xl border border-white/[0.06] bg-[#0A090E]/60 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
              <table className="min-w-full border-separate border-spacing-0 text-[length:calc(var(--chat-font-size)*12/14)]">{children}</table>
            </div>
          ),
          thead: ({ children, node: _, ...props }) => <thead className="bg-white/[0.04]" {...props}>{children}</thead>,
          tbody: ({ children, node: _, ...props }) => <tbody {...props}>{children}</tbody>,
          tr: ({ children, node: _, ...props }) => <tr className="align-top" {...props}>{children}</tr>,
          th: ({ children, node: _, ...props }) => (
            <th
              className={
                neu
                  ? "break-words border-b border-white/[0.06] px-3 py-2 text-left font-medium text-white/88 first:rounded-tl-xl last:rounded-tr-xl"
                  : "break-words border-b border-white/[0.06] px-3 py-2 text-left font-medium text-fg/82 first:rounded-tl-xl last:rounded-tr-xl"
              }
              {...props}
            >
              {children}
            </th>
          ),
          td: ({ children, node: _, ...props }) => (
            <td
              className={
                neu
                  ? "break-words border-b border-white/[0.05] px-3 py-2 align-top text-white/82 last:border-r-0"
                  : "break-words border-b border-white/[0.05] px-3 py-2 align-top text-fg/76 last:border-r-0"
              }
              {...props}
            >
              {children}
            </td>
          ),
          pre: ({ children }) => (
            <>{children}</>
          ),
          code: ({ className, children }) => {
            const text = String(children ?? "");
            const isBlock = /\n/.test(text) || (typeof className === "string" && className.length > 0);
            const workspacePath = !isBlock ? parseWorkspacePathLocation(text) : null;
            const pathIsClickable = Boolean(workspacePath && looksLikeWorkspacePath(text));
            const language = typeof className === "string"
              ? (className.match(/language-([^\s]+)/)?.[1] ?? "text")
              : "text";
            if (isBlock && language === MOSAIC_FENCE_LANGUAGE && mosaic) {
              return <MosaicCard source={text} cardKey={mosaic.cardKeyFor(text, mosaicScopeKey ?? "")} onSubmit={mosaic.onSubmit} />;
            }
            return isBlock ? (
              <HighlightedCode code={text} language={language} />
            ) : pathIsClickable ? (
              <span
                role="button"
                tabIndex={0}
                className={
                  neu
                    ? "inline max-w-full cursor-pointer break-all whitespace-normal rounded-md border border-white/14 bg-white/[0.06] px-1.5 py-0.5 align-baseline font-mono text-[length:calc(var(--chat-font-size)*11/14)] text-white/88 underline decoration-white/25 underline-offset-2 transition-colors hover:border-white/22 hover:bg-white/[0.1] hover:text-white"
                    : "inline max-w-full cursor-pointer break-all whitespace-normal rounded-md border border-sky-400/16 bg-sky-500/[0.08] px-1.5 py-0.5 align-baseline font-mono text-[length:calc(var(--chat-font-size)*11/14)] text-sky-200 underline decoration-sky-300/30 underline-offset-2 transition-colors hover:border-sky-400/24 hover:bg-sky-500/[0.12] hover:text-sky-100"
                }
                onClick={() => openWorkspacePath(workspacePath!)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openWorkspacePath(workspacePath!); } }}
                title="Open file in Files"
              >
                {children}
              </span>
            ) : (
              <code
                className={
                  neu
                    ? "break-all whitespace-normal rounded-md border border-white/[0.1] bg-black/30 px-1.5 py-0.5 font-mono text-[length:calc(var(--chat-font-size)*11/14)] text-white/90"
                    : "break-all whitespace-normal rounded-md border border-white/[0.08] bg-black/30 px-1.5 py-0.5 font-mono text-[length:calc(var(--chat-font-size)*11/14)] text-fg/90"
                }
              >
                {children}
              </code>
            );
          },
          a: ({ children, href }) => {
            const workspacePath = resolveWorkspacePathFromHref(href);
            if (workspacePath) {
              return (
                <button
                  type="button"
                  className={
                    neu
                      ? "inline max-w-full break-all whitespace-normal rounded-sm border border-white/12 bg-white/[0.06] px-1.5 py-0.5 align-baseline font-sans text-[length:calc(var(--chat-font-size)*12/14)] text-left text-white/88 underline decoration-white/25 underline-offset-2 transition-colors hover:border-white/20 hover:bg-white/[0.1] hover:text-white"
                      : "inline max-w-full break-all whitespace-normal rounded-sm border border-sky-400/12 bg-sky-500/[0.06] px-1.5 py-0.5 align-baseline font-sans text-[length:calc(var(--chat-font-size)*12/14)] text-left text-sky-200 underline decoration-sky-300/30 underline-offset-2 transition-colors hover:border-sky-400/22 hover:bg-sky-500/[0.1] hover:text-sky-100"
                  }
                  onClick={() => openWorkspacePath(workspacePath)}
                  title="Open file in Files"
                >
                  {children}
                </button>
              );
            }
            return (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => {
                  event.preventDefault();
                  openUrlInAdeBrowser(href);
                }}
                className={
                  neu
                    ? "text-white/85 underline decoration-white/28 underline-offset-2 transition-colors hover:text-white hover:decoration-white/45"
                    : "text-accent underline decoration-accent/30 underline-offset-2 transition-colors hover:text-accent/80 hover:decoration-accent/50"
                }
              >
                {children}
              </a>
            );
          }
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
});

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

const ACTIVITY_LABELS: Record<string, string> = {
  thinking: "Thinking",
  working: "Working",
  editing_file: "Editing",
  running_command: "Running command",
  searching: "Searching",
  reading: "Reading",
  tool_calling: "Calling tool"
};

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
function WorkingIndicator({ activity, startedAt }: { activity: string | null; startedAt: number | null }) {
  const timerRef = useRef<HTMLSpanElement>(null);
  const [longRunning, setLongRunning] = useState(false);
  useEffect(() => {
    const startMs = startedAt ?? Date.now();
    const el = timerRef.current;
    let handle = 0;
    const tick = () => {
      const elapsedSec = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
      if (el) el.textContent = formatElapsedSeconds(elapsedSec);
      setLongRunning(elapsedSec >= LONG_RUNNING_TURN_SECONDS);
      handle = window.setTimeout(tick, 1000);
    };
    tick();
    return () => window.clearTimeout(handle);
  }, [startedAt]);
  return (
    <span className="inline-flex items-center gap-2 font-sans text-[length:calc(var(--chat-font-size)*12/14)]">
      <ThinkingDots toneClass="bg-violet-400/70" />
      <span className="font-medium text-fg/55">{activity ?? "Working"}</span>
      <span className="text-fg/28" aria-hidden>·</span>
      <span className="text-fg/38">
        working for <span ref={timerRef} className="tabular-nums">0s</span>
      </span>
      {longRunning ? (
        <>
          <span className="text-fg/28" aria-hidden>·</span>
          <span className="text-fg/35">taking longer than usual</span>
        </>
      ) : null}
    </span>
  );
}

/** Three dots: animated while reasoning streams; larger static dots when the turn is done (stay visible on dark chat bg). */
function ReasoningStateDots({ animated }: { animated: boolean }) {
  return (
    <span className="inline-flex select-none items-center gap-[3px] pl-0.5" aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className={cn(
            "inline-block flex-shrink-0 translate-y-px rounded-full",
            animated ? "h-[3px] w-[3px] bg-violet-300/72 ade-thinking-pulse" : "h-[4px] w-[4px] bg-fg/50",
          )}
          style={animated ? { animationDelay: `${index * 0.18}s` } : undefined}
        />
      ))}
    </span>
  );
}

function formatActivityText(activity: string, detail?: string): string {
  const label = ACTIVITY_LABELS[activity] ?? activity;
  return detail ? `${label}: ${replaceInternalToolNames(detail)}` : `${label}…`;
}

function MinimalThought({ text, isLive }: { text: string; isLive: boolean }) {
  const [open, setOpen] = useState(false);
  const trimmed = text.trim();
  const preview = summarizeInlineText(trimmed, 96);
  const Caret = open ? CaretDown : CaretRight;
  return (
    <div className="font-sans text-[length:calc(var(--chat-font-size)*11/14)]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex max-w-full items-center gap-1.5 py-0.5 text-left transition-colors"
      >
        <Caret size={9} weight="bold" className="shrink-0 text-violet-400/45" />
        {isLive ? (
          <>
            <Brain size={12} weight="duotone" className="shrink-0 text-violet-300/75" />
            <span className="inline-flex items-center font-medium text-violet-200/75">
              Thinking
              <ReasoningStateDots animated />
            </span>
            {preview ? (
              <span className="min-w-0 truncate text-fg/40">{preview}</span>
            ) : null}
          </>
        ) : (
          <span className="inline-flex items-center font-medium text-fg/55">
            Thought
            <ReasoningStateDots animated={false} />
          </span>
        )}
      </button>
      {open ? (
        <div className="mt-1.5 pl-4 text-fg/55 text-[length:calc(var(--chat-font-size)*12/14)] leading-relaxed">
          <MarkdownBlock markdown={trimmed.length ? text : "…"} />
        </div>
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
  const preview = summarizeStructuredValue(event.result, 180);

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
          {event.status ? (
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

type InlineQuestionOption = {
  label: string;
  value: string;
  description?: string;
  recommended?: boolean;
  preview?: string;
  previewFormat?: "markdown" | "html";
};

type InlineQuestion = {
  id: string;
  header: string;
  questionText: string;
  options: InlineQuestionOption[];
  allowsFreeform: boolean;
  multiSelect: boolean;
  isSecret: boolean;
  defaultAssumption: string;
  impact: string;
};

function buildInlineQuestionsFromPendingRequest(request: PendingInputRequest): InlineQuestion[] {
  const hydrateOptions = (options: PendingInputQuestion["options"] | undefined): InlineQuestionOption[] => {
    if (!Array.isArray(options)) return [];
    return options.flatMap((option) => {
      if (!option) return [];
      const label = typeof option.label === "string" ? option.label.trim() : "";
      const value = typeof option.value === "string" ? option.value : label;
      if (!label.length || !value.trim().length) return [];
      const entry: InlineQuestionOption = { label, value };
      if (typeof option.description === "string" && option.description.trim().length) {
        entry.description = option.description.trim();
      }
      if (option.recommended === true) entry.recommended = true;
      if (typeof option.preview === "string" && option.preview.trim().length) {
        entry.preview = option.preview;
      }
      if (option.previewFormat === "markdown" || option.previewFormat === "html") {
        entry.previewFormat = option.previewFormat;
      }
      return [entry];
    });
  };

  const questions = Array.isArray(request.questions) ? request.questions : [];
  if (questions.length > 0) {
    return questions.map((question, index) => ({
      id: typeof question.id === "string" && question.id.trim().length ? question.id.trim() : `question_${index + 1}`,
      header: typeof question.header === "string" && question.header.trim().length
        ? question.header.trim()
        : `Question ${index + 1}`,
      questionText: typeof question.question === "string" ? question.question.trim() : "",
      options: hydrateOptions(question.options ?? null),
      allowsFreeform: question.allowsFreeform !== false,
      multiSelect: question.multiSelect === true,
      isSecret: question.isSecret === true,
      defaultAssumption: typeof question.defaultAssumption === "string" && question.defaultAssumption.trim().length
        ? question.defaultAssumption.trim()
        : "",
      impact: typeof question.impact === "string" && question.impact.trim().length
        ? question.impact.trim()
        : "",
    }));
  }

  const topLevelOptions = hydrateOptions(request.options ?? null);
  if (!topLevelOptions.length && !request.allowsFreeform) return [];
  return [{
    id: "response",
    header: "Question",
    questionText: typeof request.description === "string" ? request.description : "",
    options: topLevelOptions,
    allowsFreeform: request.allowsFreeform !== false,
    multiSelect: false,
    isSecret: false,
    defaultAssumption: "",
    impact: "",
  }];
}

// Focus a question card once on first appearance so keyboard answering works
// without a click — guarded by a module-level set so the virtualized list
// re-mounting the row mid-scroll does not keep re-stealing focus.
const focusedQuestionCardKeys = new Set<string>();

// Play the gentle entrance once per card so a scroll-back re-mount doesn't
// replay the fade — the question shouldn't "pop in" hard, but it also
// shouldn't shimmer every time the row recycles.
const enteredQuestionCardKeys = new Set<string>();

function rememberQuestionCardKey(keys: Set<string>, key: string): void {
  if (keys.size > 512) {
    const oldest = keys.values().next().value;
    if (oldest) keys.delete(oldest);
  }
  keys.add(key);
}

// Accent-driven class fragments. The chat surface already sets `--chat-accent`
// per provider (Claude amber, Codex warm-white, Cursor violet, …) and honours
// the neutral-chrome preference, so the question/plan card inherits the right
// tint instead of a hardcoded amber.
const Q_ACCENT_BORDER = "border-[color:color-mix(in_srgb,var(--chat-accent)_22%,transparent)]";
const Q_ACCENT_BORDER_STRONG = "border-[color:color-mix(in_srgb,var(--chat-accent)_55%,transparent)]";
const Q_ACCENT_BG_FAINT = "bg-[color:color-mix(in_srgb,var(--chat-accent)_5%,transparent)]";
const Q_ACCENT_BG = "bg-[color:color-mix(in_srgb,var(--chat-accent)_14%,transparent)]";
const Q_ACCENT_TEXT = "text-[color:color-mix(in_srgb,var(--chat-accent)_82%,white_18%)]";
const Q_ACCENT_TEXT_SOFT = "text-[color:color-mix(in_srgb,var(--chat-accent)_66%,white_34%)]";

// Wireframe / ASCII previews must render in a true monospace block with columns
// preserved; the old path piped them through proportional markdown, which
// collapsed the alignment the user flagged. Genuine markdown previews still get
// the rich, code-fence-aware pipeline.
const WIREFRAME_CHARS = /[│┌┐└┘├┤┬┴┼─━┃┏┓┗┛┣┫┳┻╋╭╮╰╯║╔╗╚╝╠╣╦╩╬▸▹◂◃▪▫■□●○◦◆◇]/;

export function looksLikeWireframe(text: string): boolean {
  if (WIREFRAME_CHARS.test(text)) return true;
  const lines = text.split("\n");
  if (lines.length < 2) return false;
  const indented = lines.filter((line) => /^\s{2,}\S/.test(line)).length;
  return indented >= 2;
}

function QuestionOptionPreview({ preview, previewFormat }: { preview: string; previewFormat?: "markdown" | "html" }) {
  const monospace = previewFormat === "html" || looksLikeWireframe(preview);
  if (monospace) {
    return (
      <pre className="m-0 max-h-[320px] overflow-auto whitespace-pre font-mono text-[length:calc(var(--chat-font-size)*11/14)] leading-[1.5] text-fg/80 [tab-size:2]">
        {preview}
      </pre>
    );
  }
  return (
    <div className="max-w-none text-[length:calc(var(--chat-font-size)*11.5/14)] [&_p]:my-1">
      <ChatMarkdown>{preview}</ChatMarkdown>
    </div>
  );
}

function pickComparePreviewOptions(
  focused: InlineQuestionOption | null,
  options: InlineQuestionOption[],
): InlineQuestionOption[] {
  const withPreview = options.filter((option) => option.preview);
  const ordered: InlineQuestionOption[] = [];
  if (focused?.preview) ordered.push(focused);
  for (const option of withPreview) {
    if (ordered.length >= 2) break;
    if (!ordered.some((entry) => entry.value === option.value)) ordered.push(option);
  }
  return ordered.slice(0, 2);
}

function InlineQuestionRequestCard({
  itemId,
  lifecycleKey,
  source,
  kind,
  description,
  questions,
  isResponding,
  onApproval,
}: {
  itemId: string;
  lifecycleKey: string;
  source: string;
  kind: PendingInputRequest["kind"];
  description: string;
  questions: InlineQuestion[];
  isResponding: boolean;
  onApproval?: (itemId: string, decision: AgentChatApprovalDecision, responseText?: string | null, answers?: Record<string, string | string[]>) => void;
}) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [focusedOption, setFocusedOption] = useState<Record<string, string>>({});
  const [comparing, setComparing] = useState<Record<string, boolean>>({});
  const [page, setPage] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const isPaged = questions.length > 1;
  const safePage = Math.min(Math.max(page, 0), Math.max(questions.length - 1, 0));
  const activeQuestion = questions[safePage] ?? questions[0];

  // Pre-focus the recommended option per question so its preview shows first
  // and the common path is one keystroke / click away.
  useEffect(() => {
    setFocusedOption((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const q of questions) {
        if (next[q.id]) continue;
        const recommended = q.options.find((option) => option.recommended);
        if (recommended) {
          next[q.id] = recommended.value;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [questions]);

  // Focus the card the first time it appears so keyboard answering works
  // without a click.
  useEffect(() => {
    if (focusedQuestionCardKeys.has(lifecycleKey)) return;
    rememberQuestionCardKey(focusedQuestionCardKeys, lifecycleKey);
    const node = rootRef.current;
    if (node && !node.contains(document.activeElement)) {
      node.focus({ preventScroll: true });
    }
  }, [lifecycleKey]);

  const animateInRef = useRef(!enteredQuestionCardKeys.has(lifecycleKey));
  useEffect(() => {
    rememberQuestionCardKey(enteredQuestionCardKeys, lifecycleKey);
  }, [lifecycleKey]);

  const isAnswered = useCallback((q: InlineQuestion) => {
    const sel = selected[q.id]?.length ?? 0;
    const draft = drafts[q.id]?.trim().length ?? 0;
    return sel > 0 || draft > 0;
  }, [drafts, selected]);

  const allAnswered = questions.every(isAnswered);
  const anyAnswered = questions.some(isAnswered);

  const submit = useCallback((extraAnswers?: Record<string, string | string[]>) => {
    const answers: Record<string, string | string[]> = {};
    for (const question of questions) {
      const selectedValues = selected[question.id]?.filter(Boolean) ?? [];
      const draft = drafts[question.id]?.trim() ?? "";
      const values = [...selectedValues];
      if (draft.length) values.push(draft);
      if (values.length === 1) answers[question.id] = values[0]!;
      if (values.length > 1) answers[question.id] = values;
    }
    onApproval?.(itemId, "accept", null, { ...answers, ...(extraAnswers ?? {}) });
  }, [drafts, itemId, onApproval, questions, selected]);

  const handleOption = useCallback((question: InlineQuestion, option: InlineQuestionOption, opts?: { submitSingle?: boolean }) => {
    const submitSingle = opts?.submitSingle ?? true;
    const hasFreeformDraft = question.allowsFreeform && (drafts[question.id]?.trim().length ?? 0) > 0;
    if (submitSingle && !question.multiSelect && !hasFreeformDraft && questions.length === 1) {
      onApproval?.(itemId, "accept", null, { [question.id]: option.value });
      return;
    }
    setFocusedOption((prev) => ({ ...prev, [question.id]: option.value }));
    setSelected((prev) => {
      const current = prev[question.id] ?? [];
      let next: string[];
      if (current.includes(option.value)) {
        next = current.filter((value) => value !== option.value);
      } else if (question.multiSelect) {
        next = [...current, option.value];
      } else {
        next = [option.value];
      }
      return { ...prev, [question.id]: next };
    });
  }, [drafts, itemId, onApproval, questions.length]);

  const canSend = isPaged ? allAnswered : anyAnswered;
  const sendLabel = isResponding ? "Sending..." : isPaged ? "Send answers" : "Send answer";
  const headerLabel = pendingInputHeaderLabel(source, kind);
  // Show the request-level description only when it adds context beyond the
  // question text itself — otherwise it's the duplication the user flagged
  // (header + question + the same question again).
  const trimmedDescription = description.trim();
  const extraContext = trimmedDescription && !questions.some((q) => q.questionText.trim() === trimmedDescription)
    ? trimmedDescription
    : "";

  // Keyboard-first answering: digits toggle the active question's options,
  // ↑↓ move the highlight (and its preview), ←→ page between questions, and
  // Enter advances or sends. Typing in the freeform field is never hijacked.
  const onKeyDownCard = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isResponding) return;
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName?.toLowerCase();
    const typingInField = tag === "input" || tag === "textarea" || target?.isContentEditable === true;
    const nestedInteractiveTarget = target !== event.currentTarget
      && Boolean(target?.closest("button,a,input,textarea,select,[contenteditable='true'],[role='button'],[role='checkbox'],[role='radio'],[role='tab']"));
    if (nestedInteractiveTarget) return;
    const q = activeQuestion;
    if (!q) return;
    if (!typingInField && /^[1-9]$/.test(event.key)) {
      const option = q.options[Number(event.key) - 1];
      if (option) {
        event.preventDefault();
        handleOption(q, option, { submitSingle: false });
      }
      return;
    }
    if (!typingInField && (event.key === "ArrowDown" || event.key === "ArrowUp") && q.options.length) {
      event.preventDefault();
      const currentValue = focusedOption[q.id];
      let index = q.options.findIndex((option) => option.value === currentValue);
      if (index < 0) index = 0;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const nextOption = q.options[(index + delta + q.options.length) % q.options.length]!;
      setFocusedOption((prev) => ({ ...prev, [q.id]: nextOption.value }));
      return;
    }
    if (!typingInField && isPaged && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
      event.preventDefault();
      setPage((prev) => event.key === "ArrowRight"
        ? Math.min(prev + 1, questions.length - 1)
        : Math.max(prev - 1, 0));
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !typingInField) {
      event.preventDefault();
      if (isPaged && safePage < questions.length - 1 && isAnswered(q)) {
        setPage(safePage + 1);
      } else if (canSend) {
        submit();
      }
    }
  }, [activeQuestion, canSend, focusedOption, handleOption, isAnswered, isPaged, isResponding, questions.length, safePage, submit]);

  if (!activeQuestion) return null;

  const renderQuestion = (question: InlineQuestion) => {
    const selectedForQuestion = selected[question.id];
    const focusValue = focusedOption[question.id]
      ?? selectedForQuestion?.[selectedForQuestion.length - 1]
      ?? null;
    const focused = focusValue
      ? question.options.find((option) => option.value === focusValue)
      : null;
    const useGrid = question.options.length >= 3;
    const previewOptions = question.options.filter((option) => option.preview);
    const canCompare = previewOptions.length >= 2;
    const isComparing = canCompare && (comparing[question.id] ?? false);
    const comparePair = isComparing ? pickComparePreviewOptions(focused ?? null, question.options) : [];
    const toggleCompare = () => setComparing((prev) => ({ ...prev, [question.id]: !(prev[question.id] ?? false) }));

    return (
      <div className={cn("rounded-[max(0px,calc(var(--chat-radius-card)-4px))] border p-4", Q_ACCENT_BORDER, Q_ACCENT_BG_FAINT)}>
        {question.header ? (
          <div className={cn("mb-1.5 font-mono text-[length:calc(var(--chat-font-size)*9.5/14)] font-bold uppercase tracking-widest", Q_ACCENT_TEXT)}>
            {question.header}
          </div>
        ) : null}
        <div className="text-[length:calc(var(--chat-font-size)*14/14)] font-semibold leading-[1.45] text-fg/92">{question.questionText}</div>
        {question.multiSelect ? (
          <div className={cn("mt-1.5 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-widest", Q_ACCENT_BORDER, Q_ACCENT_TEXT)}>
            <ListChecks size={10} weight="bold" /> Pick all that apply
          </div>
        ) : null}
        {question.impact ? (
          <div className="mt-2 text-[length:calc(var(--chat-font-size)*11.5/14)] leading-relaxed text-fg/55">{question.impact}</div>
        ) : null}
        {question.options.length ? (
          <div
            role={question.multiSelect ? "group" : "radiogroup"}
            aria-label={question.questionText}
            className={cn(
              "mt-3.5 gap-2",
              useGrid ? "grid grid-cols-1 sm:grid-cols-2" : "flex flex-col",
            )}
            data-testid={`inline-question-options-${question.id}`}
          >
            {question.options.map((option) => {
              const active = selected[question.id]?.includes(option.value) ?? false;
              const isHighlighted = (focused?.value ?? null) === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  disabled={isResponding}
                  role={question.multiSelect ? "checkbox" : "radio"}
                  aria-checked={active}
                  data-testid={`inline-question-option-${question.id}-${option.value}`}
                  className={cn(
                    "group relative flex w-full flex-col items-start gap-1 rounded-[max(0px,calc(var(--chat-radius-card)-6px))] border px-3.5 py-3 text-left transition-colors disabled:pointer-events-none disabled:opacity-45",
                    active
                      ? cn(Q_ACCENT_BORDER_STRONG, Q_ACCENT_BG)
                      : isHighlighted
                        ? "border-[color:color-mix(in_srgb,var(--chat-accent)_40%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_7%,transparent)]"
                        : "border-[color:color-mix(in_srgb,var(--chat-accent)_18%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_3%,transparent)] hover:border-[color:color-mix(in_srgb,var(--chat-accent)_35%,transparent)] hover:bg-[color:color-mix(in_srgb,var(--chat-accent)_8%,transparent)]",
                  )}
                  onClick={() => handleOption(question, option)}
                  onFocus={() => setFocusedOption((prev) => ({ ...prev, [question.id]: option.value }))}
                  onMouseEnter={() => setFocusedOption((prev) => ({ ...prev, [question.id]: option.value }))}
                >
                  <div className="flex w-full items-start gap-2">
                    <span
                      className={cn(
                        "mt-0.5 inline-flex h-4 w-4 flex-none items-center justify-center border transition-colors",
                        question.multiSelect ? "rounded-[4px]" : "rounded-full",
                        active
                          ? "border-[color:color-mix(in_srgb,var(--chat-accent)_80%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_85%,transparent)] text-black"
                          : "border-[color:color-mix(in_srgb,var(--chat-accent)_35%,transparent)] bg-transparent text-transparent",
                      )}
                    >
                      {active ? (
                        question.multiSelect
                          ? <Check size={10} weight="bold" />
                          : <span className="block h-1.5 w-1.5 rounded-full bg-black" />
                      ) : null}
                    </span>
                    <span className="flex-1 text-[length:calc(var(--chat-font-size)*12.5/14)] font-semibold uppercase tracking-wider text-fg/90">
                      {option.label}
                      {option.recommended ? (
                        <span className="ml-1.5 inline-block rounded-full bg-emerald-300/14 px-1.5 py-px font-mono text-[length:calc(var(--chat-font-size)*8.5/14)] font-bold uppercase tracking-widest text-emerald-200/90">
                          (Recommended)
                        </span>
                      ) : null}
                    </span>
                  </div>
                  {option.description ? (
                    <span className="ml-6 text-[length:calc(var(--chat-font-size)*11.5/14)] font-medium leading-relaxed text-fg/55">
                      {option.description}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}
        {focused?.preview && !isComparing ? (
          <div
            className={cn("mt-3 rounded-[max(0px,calc(var(--chat-radius-card)-8px))] border bg-black/22 p-3", Q_ACCENT_BORDER)}
            data-testid={`inline-question-preview-${question.id}`}
          >
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className={cn("font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-widest", Q_ACCENT_TEXT_SOFT)}>
                Preview · {focused.label}
              </span>
              {canCompare ? (
                <button
                  type="button"
                  onClick={toggleCompare}
                  data-testid={`inline-question-compare-toggle-${question.id}`}
                  className={cn("rounded-[var(--chat-radius-pill)] border px-2 py-0.5 font-mono text-[length:calc(var(--chat-font-size)*8.5/14)] font-bold uppercase tracking-widest transition-colors hover:bg-[color:color-mix(in_srgb,var(--chat-accent)_10%,transparent)]", Q_ACCENT_BORDER, Q_ACCENT_TEXT_SOFT)}
                >
                  ⇄ Compare
                </button>
              ) : null}
            </div>
            <QuestionOptionPreview preview={focused.preview} previewFormat={focused.previewFormat} />
          </div>
        ) : null}
        {isComparing && comparePair.length ? (
          <div
            className={cn("mt-3 rounded-[max(0px,calc(var(--chat-radius-card)-8px))] border bg-black/22 p-3", Q_ACCENT_BORDER)}
            data-testid={`inline-question-compare-${question.id}`}
          >
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className={cn("font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-widest", Q_ACCENT_TEXT_SOFT)}>
                Compare
              </span>
              <button
                type="button"
                onClick={toggleCompare}
                className={cn("rounded-[var(--chat-radius-pill)] border px-2 py-0.5 font-mono text-[length:calc(var(--chat-font-size)*8.5/14)] font-bold uppercase tracking-widest transition-colors hover:bg-[color:color-mix(in_srgb,var(--chat-accent)_10%,transparent)]", Q_ACCENT_BORDER, Q_ACCENT_TEXT_SOFT)}
              >
                Single
              </button>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {comparePair.map((option) => (
                <div key={option.value} className="min-w-0">
                  <div className={cn("mb-1 truncate font-mono text-[length:calc(var(--chat-font-size)*8.5/14)] font-bold uppercase tracking-widest", Q_ACCENT_TEXT_SOFT)}>
                    {option.label}
                  </div>
                  <QuestionOptionPreview preview={option.preview ?? ""} previewFormat={option.previewFormat} />
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {question.allowsFreeform ? (
          <input
            type={question.isSecret ? "password" : "text"}
            value={drafts[question.id] ?? ""}
            disabled={isResponding}
            placeholder={question.options.length ? "Optional response" : "Response"}
            className="mt-3 w-full rounded-[var(--chat-radius-card)] border border-white/10 bg-black/22 px-3 py-2 text-[length:calc(var(--chat-font-size)*12.5/14)] text-fg/85 outline-none placeholder:text-fg/30 focus:border-[color:color-mix(in_srgb,var(--chat-accent)_40%,transparent)] focus:bg-black/28"
            onChange={(event) => setDrafts((prev) => ({ ...prev, [question.id]: event.target.value }))}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                if (isPaged && safePage < questions.length - 1 && isAnswered(question)) {
                  setPage(safePage + 1);
                } else if (canSend) {
                  submit();
                }
              }
            }}
          />
        ) : null}
        {question.defaultAssumption ? (
          <div className="mt-2 text-[length:calc(var(--chat-font-size)*10.5/14)] text-fg/40">Default: {question.defaultAssumption}</div>
        ) : null}
      </div>
    );
  };

  return (
    <motion.div
      ref={rootRef}
      tabIndex={0}
      role="group"
      aria-label={headerLabel}
      onKeyDown={onKeyDownCard}
      className={cn(GLASS_CARD_CLASS, "p-4 outline-none")}
      style={MESSAGE_CARD_STYLE}
      initial={animateInRef.current ? { opacity: 0, y: 4 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className={cn("inline-flex h-6 w-6 items-center justify-center rounded-[var(--chat-radius-pill)] border bg-black/20", Q_ACCENT_BORDER)}>
            <ProviderLogo family={source} size={13} />
          </span>
          <span className={cn("font-mono text-[length:calc(var(--chat-font-size)*10.5/14)] font-bold uppercase tracking-widest", Q_ACCENT_TEXT)}>
            {headerLabel}
          </span>
        </div>
        {isPaged ? (
          <span className="font-mono text-[length:calc(var(--chat-font-size)*9.5/14)] font-bold uppercase tracking-widest text-fg/50">
            {questions.filter(isAnswered).length} of {questions.length} answered
          </span>
        ) : null}
      </div>

      {extraContext ? (
        <div className="mb-3 text-[length:calc(var(--chat-font-size)*12/14)] leading-relaxed text-fg/62">{extraContext}</div>
      ) : null}

      {isPaged ? (
        <div
          role="tablist"
          aria-label="Questions"
          className="mb-3 flex flex-wrap gap-1.5"
          data-testid="inline-question-tabs"
        >
          {questions.map((q, index) => {
            const active = index === safePage;
            const answered = isAnswered(q);
            return (
              <button
                key={q.id}
                type="button"
                role="tab"
                aria-selected={active}
                aria-label={`Question ${index + 1}: ${q.header}`}
                disabled={isResponding}
                data-testid={`inline-question-tab-${q.id}`}
                onClick={() => setPage(index)}
                className={cn(
                  "group inline-flex max-w-[180px] items-center gap-1.5 rounded-[var(--chat-radius-pill)] border px-2.5 py-1 font-mono text-[length:calc(var(--chat-font-size)*9.5/14)] font-bold uppercase tracking-widest transition-colors disabled:pointer-events-none disabled:opacity-45",
                  active
                    ? cn(Q_ACCENT_BORDER_STRONG, Q_ACCENT_BG, Q_ACCENT_TEXT)
                    : answered
                      ? "border-emerald-300/30 bg-emerald-300/[0.06] text-emerald-200/80 hover:bg-emerald-300/12"
                      : "border-[color:color-mix(in_srgb,var(--chat-accent)_18%,transparent)] bg-transparent text-fg/55 hover:bg-[color:color-mix(in_srgb,var(--chat-accent)_8%,transparent)]",
                )}
              >
                <span
                  className={cn(
                    "inline-flex h-3.5 w-3.5 flex-none items-center justify-center rounded-full border text-[length:calc(var(--chat-font-size)*9/14)]",
                    active
                      ? "border-[color:color-mix(in_srgb,var(--chat-accent)_70%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_25%,transparent)] text-[color:color-mix(in_srgb,var(--chat-accent)_90%,white_10%)]"
                      : answered
                        ? "border-emerald-300/55 bg-emerald-300/30 text-emerald-50"
                        : "border-fg/25 bg-transparent text-fg/55",
                  )}
                >
                  {answered ? <Check size={8} weight="bold" /> : index + 1}
                </span>
                <span className="truncate">{q.header}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {renderQuestion(activeQuestion)}

      <div className="mt-3 flex items-center gap-2">
        {isPaged ? (
          <>
            <button
              type="button"
              disabled={isResponding || safePage === 0}
              onClick={() => setPage(Math.max(safePage - 1, 0))}
              data-testid="inline-question-prev"
              className="inline-flex items-center gap-1 rounded-[var(--chat-radius-pill)] border border-border/20 px-2.5 py-1.5 font-mono text-[length:calc(var(--chat-font-size)*10/14)] font-bold uppercase tracking-wider text-fg/65 transition-colors hover:bg-border/10 disabled:pointer-events-none disabled:opacity-30"
            >
              <CaretLeft size={11} weight="bold" /> Back
            </button>
            <button
              type="button"
              disabled={isResponding || safePage >= questions.length - 1}
              onClick={() => setPage(Math.min(safePage + 1, questions.length - 1))}
              data-testid="inline-question-next"
              className={cn("inline-flex items-center gap-1 rounded-[var(--chat-radius-pill)] border px-2.5 py-1.5 font-mono text-[length:calc(var(--chat-font-size)*10/14)] font-bold uppercase tracking-wider transition-colors hover:bg-[color:color-mix(in_srgb,var(--chat-accent)_12%,transparent)] disabled:pointer-events-none disabled:opacity-30", Q_ACCENT_BORDER, Q_ACCENT_TEXT)}
            >
              Next <CaretRight size={11} weight="bold" />
            </button>
            <span className="ml-1 font-mono text-[length:calc(var(--chat-font-size)*10/14)] font-bold uppercase tracking-widest text-fg/40">
              {safePage + 1} / {questions.length}
            </span>
            <span className="flex-1" />
          </>
        ) : null}
        <button
          type="button"
          disabled={isResponding || !canSend}
          className={cn(
            "rounded-[var(--chat-radius-pill)] border px-3.5 py-1.5 font-mono text-[length:calc(var(--chat-font-size)*10/14)] font-bold uppercase tracking-wider transition-colors disabled:pointer-events-none disabled:opacity-40",
            canSend
              ? cn(Q_ACCENT_BORDER_STRONG, Q_ACCENT_BG, Q_ACCENT_TEXT, "hover:bg-[color:color-mix(in_srgb,var(--chat-accent)_24%,transparent)]")
              : cn(Q_ACCENT_BORDER, "bg-[color:color-mix(in_srgb,var(--chat-accent)_8%,transparent)]", Q_ACCENT_TEXT_SOFT),
          )}
          onClick={() => submit()}
        >
          {sendLabel}
        </button>
        <button
          type="button"
          disabled={isResponding}
          className="rounded-[var(--chat-radius-pill)] border border-border/20 px-3 py-1.5 font-mono text-[length:calc(var(--chat-font-size)*10/14)] font-bold uppercase tracking-wider text-fg/45 transition-colors hover:bg-border/10 disabled:pointer-events-none disabled:opacity-40"
          onClick={() => onApproval?.(itemId, "decline")}
        >
          Decline
        </button>
      </div>
    </motion.div>
  );
}

// Tracks which user messages have already played their send-up entrance, so the
// optimistic→delivered swap (and virtualized re-mounts) don't replay it — that
// replay read as a flicker once the bubble settled.
const animatedUserMessageKeys = new Set<string>();

function renderEvent(
  envelope: RenderEnvelope,
  options?: {
    onApproval?: (itemId: string, decision: AgentChatApprovalDecision, responseText?: string | null, answers?: Record<string, string | string[]>) => void;
    onCodexRecovery?: (args: AgentChatRecoverCodexTurnArgs) => Promise<AgentChatRecoverCodexTurnResult>;
    turnModel?: { label: string; modelId?: string; model?: string } | null;
    surfaceMode?: ChatSurfaceMode;
    surfaceProfile?: ChatSurfaceProfile;
    assistantLabel?: string;
    turnActive?: boolean;
    sessionEnded?: boolean;
    onOpenWorkspacePath?: (path: string | WorkspacePathLocation) => void;
    respondingApprovalIds?: Set<string>;
    pendingApprovalIds?: Set<string>;
    resolvedInputStates?: Map<string, PendingInputResolution>;
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
  }
) {
  const event = envelope.event;

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

  /* ── User message ── */
  if (event.type === "user_message") {
    const deliveryChip = describeUserDeliveryState(event);
    // Queued steers live in the composer's staging area only — never in the
    // chat thread. They graduate to a normal user bubble (with deliveryState
    // "delivered" or "inline") once the model actually consumes them.
    if (event.deliveryState === "queued" && event.steerId) {
      return null;
    }
    const playSendEntrance = !animatedUserMessageKeys.has(envelope.key);
    if (playSendEntrance) animatedUserMessageKeys.add(envelope.key);
    return (
      <motion.div
        className="flex min-w-0 max-w-full w-full justify-end overflow-visible"
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
        >
          {deliveryChip ? (
            <span className={cn("mb-1 inline-flex items-center border px-1.5 py-0.5 font-sans text-[length:calc(var(--chat-font-size)*9/14)] font-medium", deliveryChip.className)}>
              {deliveryChip.label}
            </span>
          ) : null}
          <div className="absolute right-2 top-1.5 flex items-center gap-1 opacity-0 transition-opacity duration-200 group-hover:opacity-100 focus-within:opacity-100">
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
              return displayText ? (
                <div className="whitespace-pre-wrap break-words text-[length:var(--chat-font-size)] font-medium leading-[1.7] text-white">
                  {displayText}
                </div>
              ) : null;
            }
            if (displayText && displayText !== event.text.trim()) {
              return (
                <div className="space-y-2 text-[length:var(--chat-font-size)] leading-[1.7] text-white">
                  <div className="whitespace-pre-wrap break-words font-medium">{displayText}</div>
                  <details className="group min-w-0">
                    <summary className="cursor-pointer font-sans text-[length:calc(var(--chat-font-size)*11/14)] font-medium text-white/70 transition-colors hover:text-white">
                      Full prompt
                    </summary>
                    <div className="mt-2 whitespace-pre-wrap break-words text-white/90">
                      {event.text}
                    </div>
                  </details>
                </div>
              );
            }
            const parsed = parseLeadingIosContextChips(event.text);
            if (!parsed.chips.length) {
              return (
                <div className="whitespace-pre-wrap break-words text-[length:var(--chat-font-size)] leading-[1.7] text-white">
                  {event.text}
                </div>
              );
            }
            return (
              <div className="whitespace-pre-wrap break-words text-[length:var(--chat-font-size)] leading-[1.7] text-white">
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
                {parsed.rest}
              </div>
            );
          })()}
          {event.attachments?.length || event.contextAttachments?.length ? (
            <ChatAttachmentTray
              attachments={event.attachments ?? []}
              contextAttachments={event.contextAttachments ?? []}
              mode={options?.surfaceMode ?? "standard"}
              className="mt-1 px-0 py-0"
            />
          ) : null}
          <UserMessageSendConfirmations event={event} />
        </div>
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
        <div className="group relative min-w-0 max-w-full overflow-visible py-0.5 pr-7 text-[length:var(--chat-font-size)] leading-[1.7]">
          <div className="absolute right-0 top-0 flex items-center gap-1 opacity-0 transition-opacity duration-200 group-hover:opacity-100 focus-within:opacity-100">
            <MessageCopyButton value={event.text} />
            {options?.assistantTurnCopy ? (
              <MessageCopyButton
                value={options.assistantTurnCopy.text}
                label="Copy turn"
                title="Copy whole turn"
              />
            ) : null}
          </div>
          <div className="min-w-0">
            <MarkdownBlock markdown={event.text} onOpenWorkspacePath={options?.onOpenWorkspacePath} mosaic={options?.mosaic} mosaicScopeKey={envelope.key} />
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

  /* ── TODO Update ── */
  if (event.type === "todo_update") {
    const completedCount = event.items.filter((item) => item.status === "completed").length;
    const totalCount = event.items.length;
    const activeItem = event.items.find((item) => item.status === "in_progress") ?? null;
    return (
      <InlineDisclosureRow
        defaultOpen={Boolean(activeItem)}
        summary={
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[length:calc(var(--chat-font-size)*11/14)] text-fg/52">
            <span className="inline-flex h-1.5 w-1.5 rounded-full bg-cyan-400/80" />
            <ListChecks size={11} weight="regular" className="text-fg/34" />
            <span className="font-medium text-fg/62">Task list</span>
            <span className="text-fg/76">{completedCount}/{totalCount} complete</span>
            {activeItem?.description ? (
              <span className="truncate text-[length:calc(var(--chat-font-size)*10/14)] text-fg/34">
                {summarizeInlineText(activeItem.description, 96)}
              </span>
            ) : null}
          </div>
        }
      >
        <div className="space-y-1.5">
          {event.items.length ? (
            event.items.map((item) => (
              <div key={item.id} className="flex items-start gap-2.5 px-1 py-1">
                <div className="mt-0.5 flex-shrink-0">
                  {item.status === "completed" ? (
                    <Checks size={13} weight="bold" className="text-emerald-400" />
                  ) : item.status === "in_progress" ? (
                    <Circle size={11} weight="fill" className="text-sky-400/80" />
                  ) : (
                    <Circle size={11} weight="regular" className="text-amber-400/60" />
                  )}
                </div>
                <div className={cn(
                  "flex-1 text-[length:calc(var(--chat-font-size)*12/14)]",
                  item.status === "completed" ? "text-fg/45 line-through decoration-fg/15" : "text-fg/80"
                )}>
                  {item.description}
                </div>
                <span className={cn(
                  "inline-flex shrink-0 items-center border px-1.5 py-0.5 text-[length:calc(var(--chat-font-size)*8/14)] font-bold uppercase tracking-[0.16em]",
                  todoItemStatusClass(item.status),
                )}>
                  {item.status.replace("_", " ")}
                </span>
              </div>
            ))
          ) : (
            <div className="font-mono text-[length:calc(var(--chat-font-size)*11/14)] text-muted-fg/40">No items yet.</div>
          )}
        </div>
      </InlineDisclosureRow>
    );
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
            {event.actions?.length ? (
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

  /* ── Subagent spawn anchor (two-row rendering: spawn card) ── */
  if (event.type === "subagent_spawn_anchor") {
    return (
      <SubagentSpawnCard
        event={event}
        onJumpToResult={
          options?.onScrollToRowKey
            ? () => options!.onScrollToRowKey?.(`subagent-result:${event.agentKey}`)
            : undefined
        }
      />
    );
  }

  /* ── Subagent result card ── */
  if (event.type === "subagent_result_card") {
    return (
      <SubagentResultCard
        event={event}
        onViewTranscript={() => openChatInfoFromActivity(options?.sessionId, event.agentKey)}
        onJumpToStart={
          options?.onScrollToRowKey
            ? () => options!.onScrollToRowKey?.(`subagent-spawn:${event.agentKey}`)
            : undefined
        }
      />
    );
  }

  /* ── Background command finish chip ── */
  if (event.type === "background_finish_chip") {
    return <BackgroundFinishChip event={event} />;
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
      <div className="inline-flex max-w-[min(100%,46rem)] items-center gap-2 rounded-lg border border-sky-300/14 bg-sky-500/[0.05] px-2.5 py-1.5 font-sans text-[length:calc(var(--chat-font-size)*10.5/14)] text-sky-100/78">
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

  if (event.type === "codex_moderation_metadata") {
    return (
      <div className="inline-flex max-w-[min(100%,34rem)] items-center gap-2 rounded-lg border border-emerald-300/12 bg-emerald-500/[0.04] px-2.5 py-1.5 font-sans text-[length:calc(var(--chat-font-size)*10.5/14)] text-emerald-100/72">
        <ShieldCheck size={12} weight="duotone" className="shrink-0 text-emerald-200/65" />
        <span className="shrink-0 font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-[0.16em] text-emerald-200/50">moderation</span>
        <span className="min-w-0 truncate">Checked</span>
      </div>
    );
  }

  if (event.type === "codex_sleep") {
    const duration = formatCompactDuration(event.durationMs);
    const isRunning = event.status === "running";
    return (
      <div className="inline-flex max-w-[min(100%,34rem)] items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.035] px-2.5 py-1.5 font-sans text-[length:calc(var(--chat-font-size)*10.5/14)] text-fg/64">
        {isRunning ? <ChatStatusGlyph status="working" size={12} /> : <Circle size={10} weight="fill" className="shrink-0 text-fg/32" />}
        <span className="shrink-0 font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-[0.16em] text-fg/38">wait</span>
        <span className="min-w-0 truncate">{duration ? `Sleeping ${duration}` : "Sleeping"}</span>
      </div>
    );
  }

  if (event.type === "codex_thread_deleted") {
    return (
      <div className="inline-flex max-w-[min(100%,44rem)] items-center gap-2 rounded-lg border border-amber-300/16 bg-amber-500/[0.055] px-2.5 py-1.5 font-sans text-[length:calc(var(--chat-font-size)*10.5/14)] text-amber-100/78">
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
    const usage = event.usage;
    const totalLabel = formatTokenCount(usage.totalTokens) ?? "0";
    const maxLabel = formatTokenCount(usage.maxTokens) ?? "0";
    const percent = Math.max(0, Math.min(100, usage.percentage));
    const categories = usage.categories.length ? usage.categories : [];
    return (
      <div className="w-fit max-w-[min(100%,42rem)] rounded-lg border border-cyan-300/14 bg-cyan-500/[0.035] px-3.5 py-3 font-sans text-[length:calc(var(--chat-font-size)*11/14)] text-cyan-50/78">
        <div className="flex flex-wrap items-center gap-2">
          <Brain size={13} weight="regular" className="text-cyan-200/70" />
          <span className="font-medium text-cyan-50/90">Context usage</span>
          <span className="font-mono text-[length:calc(var(--chat-font-size)*10/14)] text-cyan-100/50">
            {totalLabel} / {maxLabel} tokens · {percent.toFixed(0)}%
          </span>
          {usage.model ? <span className="rounded-md border border-cyan-200/10 px-1.5 py-0.5 font-mono text-[length:calc(var(--chat-font-size)*9/14)] text-cyan-100/45">{usage.model}</span> : null}
        </div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-black/25">
          <div className="h-full rounded-full bg-cyan-300/65" style={{ width: `${percent}%` }} />
        </div>
        <div className="mt-3 space-y-1.5">
          {categories.map((category) => {
            const categoryPercent = Math.max(0, Math.min(100, category.percentage));
            return (
              <div key={`${category.name}:${category.tokens}`} className="grid grid-cols-[minmax(8rem,1fr)_auto_4rem] items-center gap-3">
                <span className="truncate text-cyan-50/74" title={category.name}>{category.name}</span>
                <span className="font-mono text-cyan-100/50">{formatTokenCount(category.tokens) ?? "0"}</span>
                <span className="text-right font-mono text-cyan-100/42">{categoryPercent.toFixed(categoryPercent < 10 && categoryPercent > 0 ? 1 : 0)}%</span>
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
      <div className="inline-flex max-w-[min(100%,70ch)] items-center gap-2 rounded-lg border border-amber-400/16 bg-amber-500/[0.055] px-2.5 py-1.5 font-sans text-[length:calc(var(--chat-font-size)*10.5/14)] text-amber-100/78">
        <Target size={11} weight="duotone" className="shrink-0 text-amber-300/80" />
        <span className="shrink-0 text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-[0.16em] text-amber-200/55">goal</span>
        <span className="min-w-0 truncate">{message}</span>
      </div>
    );
  }

  /* ── System Notice ── */
  if (event.type === "system_notice") {
    // "Subagent spawned" chip — one quiet line deep-linking to the child
    // chat session (spawnAgent + CLI-spawned children). SDK Task-tool
    // subagents stay panel-only; the side panel remains the primary surface.
    if (event.noticeKind === "info" && event.status === "subagent_spawned") {
      const spawned = event.detail && typeof event.detail === "object" && "spawnedSession" in event.detail
        ? (event.detail as { spawnedSession?: { sessionId?: string; laneId?: string | null; title?: string } }).spawnedSession
        : undefined;
      const childTitle = spawned?.title ?? event.message.replace(/^Subagent spawned:\s*/, "");
      const childSessionId = typeof spawned?.sessionId === "string" && spawned.sessionId.length ? spawned.sessionId : null;
      return (
        <button
          type="button"
          disabled={!childSessionId}
          onClick={() => {
            if (!childSessionId) return;
            try {
              window.dispatchEvent(
                new CustomEvent("ade:work:select-session", {
                  detail: { sessionId: childSessionId, laneId: spawned?.laneId ?? null },
                }),
              );
            } catch {
              /* no-op */
            }
          }}
          className="inline-flex max-w-full items-center gap-2 rounded-full border border-border/14 bg-surface-recessed/70 px-3 py-1 text-left font-sans text-[length:calc(var(--chat-font-size)*10/14)] text-muted-fg/70 transition-colors enabled:hover:border-border/28 enabled:hover:text-fg/85"
          title={childSessionId ? "Open the spawned chat" : undefined}
        >
          <Robot size={11} weight="duotone" className="shrink-0 text-muted-fg/55" />
          <span className="shrink-0 font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-[0.16em] text-muted-fg/45">subagent</span>
          <span className="min-w-0 truncate">{childTitle}</span>
          {childSessionId ? <CaretRight size={10} className="shrink-0 text-muted-fg/50" /> : null}
        </button>
      );
    }
    if (event.noticeKind === "info" && event.message === "Promoted to Cursor Cloud") {
      return (
        <div
          className="inline-flex max-w-full items-center gap-2 rounded-full border border-violet-300/22 px-3 py-1 font-sans text-[length:calc(var(--chat-font-size)*10/14)]"
          style={{ background: "rgba(167,139,250,0.07)", color: "rgba(216,200,255,0.85)" }}
        >
          <CloudArrowUp size={11} weight="fill" style={{ color: "#A78BFA" }} />
          <span className="font-medium">Promoted to cloud</span>
          <a
            href="#/cloud"
            onClick={(e) => {
              e.preventDefault();
              try { window.location.hash = "#/cloud"; } catch { /* noop */ }
            }}
            className="inline-flex items-center gap-0.5 font-mono text-[length:calc(var(--chat-font-size)*9/14)] text-violet-200/70 hover:text-violet-100"
          >
            open in /cloud
          </a>
        </div>
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

    if (hasDetail && event.noticeKind === "rate_limit" && inferredSeverity !== "error") {
      const detail = typeof event.detail === "string"
        ? event.detail
        : typeof event.detail === "object" && event.detail && "summary" in event.detail && typeof event.detail.summary === "string"
          ? event.detail.summary
          : null;
      return (
        <div className={cn(
          "inline-flex max-w-[min(100%,70ch)] flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-2.5 py-1.5 font-sans text-[length:calc(var(--chat-font-size)*10/14)]",
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
    const isLive = Boolean(options?.turnActive);
    return (
      <motion.div
        className="w-fit max-w-[70ch]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.12, ease: "easeOut" }}
      >
        <MinimalThought text={event.text} isLive={isLive} />
      </motion.div>
    );
  }

  /* ── Step boundary ── */
  if (event.type === "step_boundary") {
    return null;
  }

  /* ── Tool call ── */
  if (event.type === "tool_invocation") {
    const meta = getToolMeta(event.tool);
    const ToolIcon = meta.icon;
    const toolDisplay = describeToolIdentifier(event.tool);
    const args = readRecord(event.args) ?? {};
    const resultText = event.result === undefined ? null : formatStructuredValue(event.result);
    const targetLine = meta.getTarget ? meta.getTarget(args) : null;
    const label = targetLine
      ? `${meta.label} ${targetLine}`
      : toolDisplay.secondaryLabel
        ? `${meta.label} ${toolDisplay.secondaryLabel}`
        : meta.label;
    const argCount = Object.keys(args).length;

    return (
      <CollapsibleCard
        defaultOpen={event.status === "failed"}
        summary={
          <div className="flex items-center gap-2 font-mono text-[length:calc(var(--chat-font-size)*12/14)] text-fg/50">
            {event.status === "running" ? (
              <ThinkingDots />
            ) : event.status === "failed" ? (
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-400/70" />
            ) : (
              <CaretRight size={10} weight="bold" className="text-fg/30" />
            )}
            <ToolIcon size={13} weight="regular" className="text-fg/40" />
            <span className="truncate">{label}</span>
          </div>
        }
        className={cn(
          WORK_LOG_CARD_CLASS,
          event.parentItemId ? "ml-5" : null,
        )}
      >
        <div className="space-y-3">
          <div>
            <div className="mb-1 font-mono text-[length:calc(var(--chat-font-size)*10/14)] uppercase tracking-[0.16em] text-muted-fg/35">Arguments</div>
            {argCount ? (
              <pre className={cn("max-h-52", RECESSED_BLOCK_CLASS)}>
                {formatStructuredValue(args)}
              </pre>
            ) : (
              <div className="rounded-[max(0px,calc(var(--chat-radius-card)-6px))] border border-white/[0.04] bg-black/20 px-4 py-2 font-mono text-[length:calc(var(--chat-font-size)*10/14)] text-muted-fg/40">
                No arguments
              </div>
            )}
          </div>
          {resultText ? (
            <div>
              <div className="mb-1 font-mono text-[length:calc(var(--chat-font-size)*10/14)] uppercase tracking-[0.16em] text-muted-fg/35">Result</div>
              <pre className={cn("max-h-52", RECESSED_BLOCK_CLASS)}>
                {resultText}
              </pre>
            </div>
          ) : null}
        </div>
      </CollapsibleCard>
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
    const inlineQuestions: InlineQuestion[] = pendingRequest
      ? buildInlineQuestionsFromPendingRequest(pendingRequest)
      : [];
    const primaryQuestion = inlineQuestions[0] ?? null;
    const primaryQuestionText = primaryQuestion?.questionText ?? "";
    const detailTool = typeof detail?.tool === "string" ? detail.tool.trim() : "";
    const question = typeof detail?.question === "string" ? detail.question.trim() : "";
    const normalizedTool = detailTool.toLowerCase();
    const isQuestionRequest = requestKind === "question" || requestKind === "structured_question";
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

    if (isAskUser && !isResolved && inlineQuestions.length > 0) {
      return (
        <InlineQuestionRequestCard
          itemId={event.itemId}
          lifecycleKey={`${options?.sessionId ?? "unknown-session"}:${event.itemId}`}
          source={requestSource || "agent"}
          kind={pendingRequest?.kind ?? "question"}
          description={bodyText}
          questions={inlineQuestions}
          isResponding={isResponding}
          onApproval={options?.onApproval}
        />
      );
    }

    return (
      <div className={cn(GLASS_CARD_CLASS, "px-4 py-2.5")} style={SURFACE_INLINE_CARD_STYLE}>
        <div className="flex items-center gap-2">
          {requestSource ? (
            <span className={cn("inline-flex h-5 w-5 items-center justify-center rounded-[var(--chat-radius-pill)] border bg-black/20", Q_ACCENT_BORDER)}>
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
          <div className="mt-2 max-h-[360px] overflow-y-auto rounded-lg border border-white/[0.06] bg-black/15 px-3 py-2">
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
      <div className={cn(GLASS_CARD_CLASS, "group border-red-500/12 p-0")} style={SURFACE_INLINE_CARD_STYLE}>
        <div className="h-px w-full bg-gradient-to-r from-transparent via-red-500/40 to-transparent" />
        <div className="p-4">
          <div className="mb-2 flex items-center gap-2">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-red-500/10">
              <Warning size={13} weight="bold" className="text-red-400/90" />
            </div>
            <span className="font-mono text-[length:calc(var(--chat-font-size)*11/14)] font-bold uppercase tracking-widest text-fg/85">Error</span>
            {event.errorInfo && typeof event.errorInfo !== "string" && event.errorInfo.category ? (
              <span className="inline-flex items-center rounded-md border border-red-500/12 bg-red-500/[0.06] px-1.5 py-0.5 font-mono text-[length:calc(var(--chat-font-size)*8/14)] font-bold uppercase tracking-[0.16em] text-red-300/70">
                {event.errorInfo.category}
              </span>
            ) : null}
            <div className="ml-auto">
              <MessageCopyButton value={errorCopyValue} className="opacity-0 group-hover:opacity-100 focus-within:opacity-100" />
            </div>
          </div>
          <div className="whitespace-pre-wrap break-words text-[length:calc(var(--chat-font-size)*12/14)] leading-relaxed text-fg/80">{event.message}</div>
          {event.detail?.trim().length ? (
            <div className="mt-2 whitespace-pre-wrap break-words rounded-[calc(var(--chat-radius-card)-8px)] border border-red-500/10 bg-red-500/[0.04] px-3 py-2 text-[length:calc(var(--chat-font-size)*11/14)] leading-relaxed text-fg/68">
              {event.detail}
            </div>
          ) : null}
          {renderAgentCliAuthCard()}
          {event.errorInfo && !agentCliInfo ? (
            <div className="mt-2 font-mono text-[length:calc(var(--chat-font-size)*10/14)] text-muted-fg/40">
              {typeof event.errorInfo === "string" ? event.errorInfo : `${event.errorInfo.provider ? `${event.errorInfo.provider}` : ""}${event.errorInfo.model ? ` / ${event.errorInfo.model}` : ""}`}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  /* ── Cloud status lifecycle ── */
  if (event.type === "cloud_status") {
    const status = (event.status ?? "").toLowerCase();
    const inProgress = status === "creating" || status === "running";
    const live = inProgress && Boolean(options?.turnActive);
    const failed = status === "error" || status === "cancelled" || status === "expired";
    const tone = inProgress
      ? "text-violet-200/80"
      : failed
        ? "text-red-300/75"
        : "text-emerald-300/70";
    const label = status === "creating"
      ? "Provisioning cloud VM"
      : status === "running"
        ? "Running in cloud"
        : status === "finished"
          ? "Cloud run finished"
          : status === "cancelled"
            ? "Cloud run cancelled"
            : status === "expired"
              ? "Cloud run expired"
              : status === "error"
                ? "Cloud run failed"
                : `Cloud · ${status}`;
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
            onClick={() => openUrlInAdeBrowser(event.prUrl!)}
            className="font-mono text-[length:calc(var(--chat-font-size)*9/14)] text-violet-200/70 hover:text-violet-100"
          >
            PR
          </button>
        ) : null}
      </div>
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
    if (!isFailure && !isInterrupted && !(event.message ?? "").trim().length) {
      return null;
    }
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

function formatTurnDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.max(1, Math.round(durationMs))}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = Math.round(seconds - minutes * 60);
  return remSeconds ? `${minutes}m ${remSeconds}s` : `${minutes}m`;
}

/**
 * End-of-turn divider — a hairline with a plain-text cutout. Shows the wall time
 * (or the interrupted/failed status + model) plus how long the turn worked. It
 * is driven by the universal `done` event, so it renders identically for every
 * runtime (Codex / Claude / Cursor / Droid / OpenCode).
 */
function DoneTurnDivider({
  event,
  timestamp,
  durationMs,
}: {
  event: Extract<AgentChatEvent, { type: "done" }>;
  timestamp: string;
  durationMs: number | null;
}) {
  const completed = event.status === "completed";
  const { label: modelLabel } = resolveModelMeta(event.modelId, event.model);
  const workedFor = durationMs !== null && durationMs > 1500
    ? `Worked for ${formatTurnDuration(durationMs)}`
    : null;
  return (
    <div className="my-4 flex items-center gap-3">
      <span className="h-px flex-1 bg-white/[0.06]" />
      <span
        className={cn(
          "inline-flex shrink-0 items-center gap-2 px-1 font-sans text-[length:calc(var(--chat-font-size)*10.5/14)]",
          completed ? "text-fg/40" : doneStatusToneClass(event.status),
        )}
      >
        {!completed && modelLabel ? (
          <span className="inline-flex items-center gap-1.5">
            <ModelGlyph modelId={event.modelId} model={event.model} size={12} className="shrink-0" />
            <span className="font-medium">{modelLabel}</span>
          </span>
        ) : null}
        {completed ? (
          <span>{formatTime(timestamp)}</span>
        ) : (
          <span className="font-medium uppercase tracking-wide">{event.status}</span>
        )}
        {workedFor ? (
          <>
            <span className="opacity-40">·</span>
            <span>{workedFor}</span>
          </>
        ) : null}
      </span>
      <span className="h-px flex-1 bg-white/[0.06]" />
    </div>
  );
}

function deriveLatestActivity(events: AgentChatEventEnvelope[]): { activity: string; detail?: string } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const evt = events[i]!.event;
    if (evt.type === "activity") {
      return { activity: evt.activity, detail: evt.detail };
    }
    if (evt.type === "done") return null;
    if (evt.type === "status" && evt.turnStatus !== "started") return null;
  }
  return null;
}

function deriveActiveTurnId(events: AgentChatEventEnvelope[]): string | null {
  const completedTurnIds = new Set<string>();
  for (let i = events.length - 1; i >= 0; i--) {
    const evt = events[i]!.event;
    if (evt.type === "done" && evt.turnId?.trim()) {
      completedTurnIds.add(evt.turnId.trim());
      continue;
    }
    const turnId = getEventTurnId(evt);
    if (!turnId || completedTurnIds.has(turnId)) continue;
    return turnId;
  }
  return null;
}

// Wall-clock start time (ms) of the given turn — the earliest event timestamp
// tagged with that turnId. Used to anchor the working-indicator elapsed timer
// so it survives remounts (leaving/returning to the chat).
function deriveTurnStartedAt(events: AgentChatEventEnvelope[], turnId: string | null): number | null {
  if (!turnId) return null;
  let startedAt: number | null = null;
  for (const envelope of events) {
    if (getEventTurnId(envelope.event) !== turnId) continue;
    const ts = Date.parse(envelope.timestamp);
    if (!Number.isFinite(ts)) continue;
    if (startedAt === null || ts < startedAt) startedAt = ts;
  }
  return startedAt;
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

type EventRowProps = {
  envelope: TranscriptGroupedEnvelope;
  showTurnDivider: boolean;
  turnDividerLabel: string | null;
  turnModel: { label: string; modelId?: string; model?: string } | null;
  turnEndDurationMs?: number | null;
  onApproval?: (itemId: string, decision: AgentChatApprovalDecision, responseText?: string | null, answers?: Record<string, string | string[]>) => void;
  onCodexRecovery?: (args: AgentChatRecoverCodexTurnArgs) => Promise<AgentChatRecoverCodexTurnResult>;
  surfaceMode?: ChatSurfaceMode;
  surfaceProfile?: ChatSurfaceProfile;
  assistantLabel?: string;
  turnActive?: boolean;
  sessionEnded?: boolean;
  isLatestWorkLog?: boolean;
  onOpenWorkspacePath?: (path: string | WorkspacePathLocation) => void;
  onNavigateSuggestion?: (suggestion: OperatorNavigationSuggestion) => void;
  onReviewChanges?: () => void;
  onInsertDraft?: (text: string) => void;
  onRevealChatTerminal?: (terminal: { terminalId: string; ptyId: string; label: string }) => void;
  onRewindFiles?: (request: { messageId: string; timestamp: string; text: string }) => void;
  turnDiffSummaries?: TurnDiffSummary[];
  respondingApprovalIds?: Set<string>;
  pendingApprovalIds?: Set<string>;
  resolvedInputStates?: Map<string, PendingInputResolution>;
  laneId?: string | null;
  sessionId?: string | null;
  runtimeName?: string | null;
  mosaic?: MosaicRenderContext;
  anchored?: boolean;
  onScrollToRowKey?: (rowKey: string) => void;
  assistantTurnCopy?: { text: string } | null;
};

const EventRow = React.memo(function EventRow({
  envelope,
  showTurnDivider,
  turnDividerLabel,
  turnModel,
  turnEndDurationMs,
  onApproval,
  onCodexRecovery,
  surfaceMode = "standard",
  surfaceProfile = "standard",
  assistantLabel,
  turnActive,
  sessionEnded,
  isLatestWorkLog,
  onOpenWorkspacePath,
  onNavigateSuggestion,
  onReviewChanges,
  onInsertDraft,
  onRevealChatTerminal,
  onRewindFiles,
  turnDiffSummaries,
  respondingApprovalIds,
  pendingApprovalIds,
  resolvedInputStates,
  laneId,
  sessionId,
  runtimeName,
  mosaic,
  anchored,
  onScrollToRowKey,
  assistantTurnCopy,
}: EventRowProps) {
  const workLogAnimate = Boolean(turnActive)
    && !sessionEnded
    && Boolean(isLatestWorkLog);
  return (
    <div
      data-chat-anchored-row={anchored ? "true" : undefined}
      className={cn(
        "min-w-0 max-w-full space-y-3 overflow-hidden transition-colors duration-700",
        anchored && "rounded-lg bg-amber-300/[0.08] ring-1 ring-amber-300/15",
      )}
    >
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
      {envelope.event.type === "work_log_group"
        ? (
          <div className="w-fit min-w-0 max-w-[min(100%,70ch)] overflow-hidden">
            <ChatWorkLogBlock
              entries={envelope.event.entries}
              summary={envelope.event.summary}
              onNavigateSuggestion={onNavigateSuggestion}
              onUndoChanges={onReviewChanges}
              onInsertDraft={onInsertDraft}
              onRevealChatTerminal={onRevealChatTerminal}
              sessionId={sessionId}
              animate={workLogAnimate}
            />
          </div>
        )
        : envelope.event.type === "activity_bundle"
          ? <ChatActivityBundle event={envelope.event} sessionId={sessionId} />
        : renderEvent(envelope as RenderEnvelope, {
            onApproval,
            onCodexRecovery,
            turnModel,
            surfaceMode,
            surfaceProfile,
            assistantLabel,
            turnActive,
            sessionEnded,
            onOpenWorkspacePath,
            respondingApprovalIds,
            pendingApprovalIds,
            resolvedInputStates,
            laneId,
            sessionId,
            runtimeName,
            onRevealChatTerminal,
            onRewindFiles,
            turnDiffSummaries,
            mosaic,
            onScrollToRowKey,
            assistantTurnCopy,
          })}
      {envelope.event.type === "done" ? (
        <DoneTurnDivider
          event={envelope.event}
          timestamp={envelope.timestamp}
          durationMs={turnEndDurationMs ?? null}
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
/** Number of extra rows to render above/below the visible viewport. */
const OVERSCAN = 10;
/** Minimum number of rows before virtualization kicks in. */
const VIRTUALIZATION_THRESHOLD = 60;
/**
 * Distance (px) from the bottom of the scroll container within which we
 * consider the user "stuck to bottom" and keep auto-following new content.
 * Sized so a single wheel nudge during streaming reliably breaks free of
 * auto-follow rather than being snapped back.
 */
const STICK_THRESHOLD_PX = 160;
const STICK_RESUME_THRESHOLD_PX = 24;
const TOUCH_SCROLL_DEADBAND_PX = 2;
/**
 * Distance (px) from the top of the scroll container within which scrolling
 * up requests the next older transcript page (when one exists).
 */
const LOAD_OLDER_THRESHOLD_PX = 300;

export function shouldAbsorbProgrammaticScrollEvent({
  scrollTop,
  programmaticTarget,
}: {
  scrollTop: number;
  programmaticTarget: number | null;
}): boolean {
  return programmaticTarget != null && Math.abs(scrollTop - programmaticTarget) < 1;
}

export function shouldStickToBottomAfterScroll({
  distanceFromBottom,
  wasStuckToBottom,
}: {
  distanceFromBottom: number;
  wasStuckToBottom: boolean;
}): boolean {
  return wasStuckToBottom
    ? distanceFromBottom < STICK_THRESHOLD_PX
    : distanceFromBottom <= STICK_RESUME_THRESHOLD_PX;
}

export function calculateVirtualWindow({
  rowCount,
  scrollTop,
  containerHeight,
  rowHeight,
  overscan = OVERSCAN,
  rowGap = CHAT_TIMELINE_ROW_GAP_PX,
}: {
  rowCount: number;
  scrollTop: number;
  containerHeight: number;
  rowHeight: (index: number) => number;
  overscan?: number;
  rowGap?: number;
}): {
  startIndex: number;
  endIndex: number;
  totalHeight: number;
  offsetTop: number;
} {
  if (rowCount <= 0) {
    return { startIndex: 0, endIndex: 0, totalHeight: 0, offsetTop: 0 };
  }

  let cumulative = 0;
  const offsets: number[] = new Array(rowCount);
  for (let i = 0; i < rowCount; i += 1) {
    offsets[i] = cumulative;
    cumulative += rowHeight(i) + rowGap;
  }
  const totalHeight = cumulative - rowGap;
  const viewTop = scrollTop;
  const viewBottom = scrollTop + containerHeight;

  let lo = 0;
  let hi = rowCount - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const rowBottom = offsets[mid]! + rowHeight(mid);
    if (rowBottom < viewTop) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  const firstVisible = lo;

  let lastVisible = firstVisible;
  while (lastVisible < rowCount - 1 && offsets[lastVisible + 1]! < viewBottom) {
    lastVisible += 1;
  }

  const startIndex = Math.max(0, firstVisible - overscan);
  const endIndex = Math.min(rowCount, lastVisible + 1 + overscan);

  return {
    startIndex,
    endIndex,
    totalHeight,
    offsetTop: offsets[startIndex] ?? 0,
  };
}

/**
 * Window anchored to the *end* of the list, used while we're following the
 * bottom of a streaming turn. Estimate-based `scrollTop` windowing drifts on
 * long transcripts (a single rendered row whose stored height lags its real
 * DOM height desyncs the spacer math from `el.scrollTop`), which strands the
 * tail above a phantom gap and "locks" — new content keeps landing at the top
 * while the space above the composer stays empty. Anchoring directly to the
 * last row keeps the tail permanently mounted and re-measured every frame, so
 * `bottomSpacerHeight` is always 0 and the streaming indicator sits flush
 * against the final message regardless of how stale the off-screen estimates
 * upstream are.
 */
export function calculateVirtualWindowAnchoredToEnd({
  rowCount,
  containerHeight,
  rowHeight,
  overscan = OVERSCAN,
  rowGap = CHAT_TIMELINE_ROW_GAP_PX,
}: {
  rowCount: number;
  containerHeight: number;
  rowHeight: (index: number) => number;
  overscan?: number;
  rowGap?: number;
}): {
  startIndex: number;
  endIndex: number;
  totalHeight: number;
  offsetTop: number;
} {
  if (rowCount <= 0) {
    return { startIndex: 0, endIndex: 0, totalHeight: 0, offsetTop: 0 };
  }

  let total = 0;
  for (let i = 0; i < rowCount; i += 1) {
    total += rowHeight(i) + rowGap;
  }
  const totalHeight = total - rowGap;

  // Walk back from the last row until the rendered rows cover the viewport.
  let firstVisible = rowCount - 1;
  let filled = rowHeight(firstVisible);
  while (firstVisible > 0 && filled < containerHeight) {
    firstVisible -= 1;
    filled += rowHeight(firstVisible) + rowGap;
  }
  const startIndex = Math.max(0, firstVisible - overscan);

  let offsetTop = 0;
  for (let i = 0; i < startIndex; i += 1) {
    offsetTop += rowHeight(i) + rowGap;
  }

  return { startIndex, endIndex: rowCount, totalHeight, offsetTop };
}

export function reconcileMeasuredScrollTop({
  index,
  previousHeight,
  nextHeight,
  scrollTop,
  rowHeight,
  rowGap = CHAT_TIMELINE_ROW_GAP_PX,
}: {
  index: number;
  previousHeight: number;
  nextHeight: number;
  scrollTop: number;
  rowHeight: (index: number) => number;
  rowGap?: number;
}): number {
  const delta = nextHeight - previousHeight;
  if (delta === 0) return scrollTop;

  let rowTop = 0;
  for (let i = 0; i < index; i += 1) {
    rowTop += rowHeight(i) + rowGap;
  }

  const rowBottom = rowTop + previousHeight;
  if (rowBottom <= scrollTop) {
    return Math.max(0, scrollTop + delta);
  }
  return scrollTop;
}

export function findAnchoredChatEventIndex({
  events,
  anchorEvent,
  hasFullHistory,
}: {
  events: AgentChatEventEnvelope[];
  anchorEvent: number;
  hasFullHistory: boolean;
}): number {
  if (!Number.isInteger(anchorEvent) || anchorEvent < 0) return -1;
  const sequenceIndex = events.findIndex((envelope) => envelope.sequence === anchorEvent);
  if (sequenceIndex >= 0) return sequenceIndex;
  if (!hasFullHistory) return -1;
  return anchorEvent < events.length ? anchorEvent : -1;
}

export function resolveAnchoredChatRowIndex({
  events,
  groupedRows,
  anchorEvent,
  hasFullHistory,
}: {
  events: AgentChatEventEnvelope[];
  groupedRows: TranscriptGroupedEnvelope[];
  anchorEvent: number;
  hasFullHistory: boolean;
}): number {
  const eventIndex = findAnchoredChatEventIndex({ events, anchorEvent, hasFullHistory });
  if (eventIndex < 0) return -1;
  const targetRows = groupChatTranscriptRows(
    collapseChatTranscriptEvents(events.slice(0, eventIndex + 1)),
  );
  const targetRow = targetRows[targetRows.length - 1];
  if (!targetRow) return -1;
  return groupedRows.findIndex((row) => row.key === targetRow.key);
}

type PendingChatEventAnchor = {
  event: number;
  loadRequests: number;
  waitingForOlderHistory: boolean;
  sawOlderHistoryLoading: boolean;
  lastEventsLength: number;
};

function AgentChatMessageListMain({
  events,
  showStreamingIndicator = false,
    className,
  onApproval,
  onCodexRecovery,
    surfaceMode = "standard",
  surfaceProfile = "standard",
  assistantLabel,
  onOpenWorkspacePath,
  respondingApprovalIds,
  pendingApprovalIds,
  laneId,
  sessionId,
  onInsertDraft,
  onRevealChatTerminal,
  onRewindFiles,
  turnDiffSummaries,
  sessionEnded = false,
  hasOlderHistory = false,
  loadingOlderHistory = false,
  onLoadOlderHistory,
  mosaic,
  scrollToRowKeyRequest,
}: {
  events: AgentChatEventEnvelope[];
  showStreamingIndicator?: boolean;
  className?: string;
  onApproval?: (itemId: string, decision: AgentChatApprovalDecision, responseText?: string | null, answers?: Record<string, string | string[]>) => void;
  onCodexRecovery?: (args: AgentChatRecoverCodexTurnArgs) => Promise<AgentChatRecoverCodexTurnResult>;
  surfaceMode?: ChatSurfaceMode;
  surfaceProfile?: ChatSurfaceProfile;
  assistantLabel?: string;
  onOpenWorkspacePath?: (path: string, laneId?: string | null) => void;
  onInsertDraft?: (text: string) => void;
  onRevealChatTerminal?: (terminal: { terminalId: string; ptyId: string; label: string }) => void;
  onRewindFiles?: (request: { messageId: string; timestamp: string; text: string }) => void;
  turnDiffSummaries?: TurnDiffSummary[];
  respondingApprovalIds?: Set<string>;
  pendingApprovalIds?: Set<string>;
  laneId?: string | null;
  sessionId?: string | null;
  sessionEnded?: boolean;
  /** True when older transcript pages exist above the loaded events. */
  hasOlderHistory?: boolean;
  /** True while an older transcript page is being fetched. */
  loadingOlderHistory?: boolean;
  /** Called when the user scrolls near the top and older pages exist. */
  onLoadOlderHistory?: () => void;
  /** Present only for Claude-family sessions; enables interactive mosaic cards. */
  mosaic?: MosaicRenderContext;
  /** Imperative jump request used by the while-you-were-away wake digest. */
  scrollToRowKeyRequest?: { key: string; requestId: number } | null;
}) {
  const chatTranscriptDensity = useAppStore((s) => s.chatTranscriptDensity);
  const runtimeName = useAppStore((s) => s.projectBinding?.kind === "remote" ? s.projectBinding.runtimeName : null);
  const timelineRowGapPx = useMemo(() => transcriptRowGapPx(chatTranscriptDensity), [chatTranscriptDensity]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentWrapperRef = useRef<HTMLDivElement | null>(null);
  const lastHandledScrollToRowRequestIdRef = useRef<number | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  // Carries the CollapseTranscriptContext alongside events/rows so appended
  // subagent progress/result events can index back into the previous rows and
  // mutate the anchor by its stored rowIndex (see collapseChatTranscriptRows).
  const collapseCacheRef = useRef<{
    events: AgentChatEventEnvelope[];
    rows: TranscriptRenderEnvelope[];
    context: CollapseTranscriptResult["context"] | null;
  }>({
    events: [],
    rows: [],
    context: null,
  });
  const [stickToBottom, setStickToBottom] = useState(true);
  const [filesWorkspaces, setFilesWorkspaces] = useState<FilesWorkspace[]>([]);
  const stickToBottomRef = useRef(true);
  // Track the single pending rAF handle for scroll-to-bottom writes so we
  // coalesce every source (ResizeObserver, stick-flip effect, jump button)
  // into at most one scrollTop assignment per frame.
  const scrollRafRef = useRef<number | null>(null);
  const scrollFollowFramesRef = useRef(0);
  const lastTouchYRef = useRef<number | null>(null);
  // Programmatic scroll writes can be coalesced by the browser. Track the
  // latest ADE-authored scrollTop target instead of using a counter, so a real
  // user scroll never gets swallowed by stale "programmatic" credits.
  const programmaticScrollTargetRef = useRef<number | null>(null);
  const onApprovalRef = useRef(onApproval);
  const resolvedInputStates = useMemo(() => {
    const resolved = new Map<string, PendingInputResolution>();
    for (const envelope of events) {
      if (envelope.event.type !== "pending_input_resolved") continue;
      if (!resolved.has(envelope.event.itemId)) {
        resolved.set(envelope.event.itemId, envelope.event.resolution);
      }
    }
    return resolved;
  }, [events]);

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
  // previous row at the same index from creating phantom scroll space.
  const measuredHeights = useRef<Map<string, number>>(new Map());
  // Track previous events identity to clear stale measurements on session
  // switch. Older-history pagination PREPENDS events (changing events[0]
  // while keeping the previous envelopes), so only clear when the previous
  // first envelope is gone entirely — i.e. a real content swap, not a prepend.
  const prevEventsRef = useRef<AgentChatEventEnvelope[]>(events);
  if (prevEventsRef.current !== events && events.length > 0 && (events[0] !== prevEventsRef.current[0])) {
    const prevFirst = prevEventsRef.current[0];
    if (!prevFirst || !events.includes(prevFirst)) {
      measuredHeights.current.clear();
    }
  }
  prevEventsRef.current = events;

  // Mirror older-history props into refs so the stable scroll handler can
  // consult them without re-subscribing.
  const onLoadOlderHistoryRef = useRef(onLoadOlderHistory);
  const hasOlderHistoryRef = useRef(hasOlderHistory);
  const loadingOlderHistoryRef = useRef(loadingOlderHistory);
  useEffect(() => {
    onLoadOlderHistoryRef.current = onLoadOlderHistory;
    hasOlderHistoryRef.current = hasOlderHistory;
    loadingOlderHistoryRef.current = loadingOlderHistory;
  }, [onLoadOlderHistory, hasOlderHistory, loadingOlderHistory]);

  const maybeRequestOlderHistory = useCallback((scrollTopNow: number) => {
    if (scrollTopNow > LOAD_OLDER_THRESHOLD_PX) return;
    if (!hasOlderHistoryRef.current || loadingOlderHistoryRef.current) return;
    onLoadOlderHistoryRef.current?.();
  }, []);

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
  }, []);

  const handleApproval = useCallback((itemId: string, decision: AgentChatApprovalDecision, responseText?: string | null, answers?: Record<string, string | string[]>) => {
    onApprovalRef.current?.(itemId, decision, responseText, answers);
  }, []);

  const rows = useMemo(() => {
    const cached = collapseCacheRef.current;
    const { rows: nextRows, context } = collapseChatTranscriptEventsIncrementalWithContext(
      events,
      cached.events,
      cached.rows,
      cached.context,
    );
    collapseCacheRef.current = { events, rows: nextRows, context };
    return nextRows;
  }, [events]);
  const assistantTurnCopyByRowKey = useMemo(() => {
    const byRowKey = new Map<string, AssistantTurnCopyInfo>();
    for (const info of deriveAssistantTurnCopyMap(rows).values()) {
      if (info.textEventCount >= 2) byRowKey.set(info.lastTextEventKey, info);
    }
    return byRowKey;
  }, [rows]);
  const groupedRows = useMemo(() => groupChatTranscriptRows(rows), [rows]);
  const groupedRowKeys = useMemo(() => groupedRows.map((row) => row.key), [groupedRows]);
  const prevGroupedRowKeysRef = useRef<readonly string[] | null>(null);
  if (prevGroupedRowKeysRef.current !== groupedRowKeys) {
    const liveKeys = new Set(groupedRowKeys);
    for (const key of measuredHeights.current.keys()) {
      if (!liveKeys.has(key)) measuredHeights.current.delete(key);
    }
    prevGroupedRowKeysRef.current = groupedRowKeys;
  }
  const latestActivity = useMemo(() => (showStreamingIndicator ? deriveLatestActivity(events) : null), [events, showStreamingIndicator]);
  const activeTurnId = useMemo(() => (showStreamingIndicator ? deriveActiveTurnId(events) : null), [events, showStreamingIndicator]);
  const activeTurnStartedAt = useMemo(
    () => (showStreamingIndicator ? deriveTurnStartedAt(events, activeTurnId) : null),
    [events, showStreamingIndicator, activeTurnId],
  );

  const currentLaneId = typeof (location.state as { laneId?: unknown } | null)?.laneId === "string"
    ? (location.state as { laneId: string }).laneId
    : null;

  const openWorkspacePath = useCallback(async (path: string | WorkspacePathLocation) => {
    let resolvedWorkspaces = filesWorkspaces;
    let target = resolveFilesNavigationTarget({
      path,
      workspaces: resolvedWorkspaces,
      fallbackLaneId: currentLaneId,
    });
    const workspaceCandidate = typeof path === "string" ? parseWorkspacePathLocation(path) : path;
    if (!target && workspaceCandidate && (workspaceCandidate.path.startsWith("/") || isWindowsAbsolutePath(workspaceCandidate.path))) {
      const listWorkspaces = window.ade?.files?.listWorkspaces;
      if (typeof listWorkspaces === "function") {
        try {
          resolvedWorkspaces = await listWorkspaces();
          setFilesWorkspaces(resolvedWorkspaces);
          target = resolveFilesNavigationTarget({
            path,
            workspaces: resolvedWorkspaces,
            fallbackLaneId: currentLaneId,
          });
        } catch {
          target = null;
        }
      }
    }
    if (!target) return;
    const state = {
      openFilePath: target.openFilePath,
      ...(target.laneId ? { laneId: target.laneId } : {}),
      ...(typeof target.startLine === "number" ? { startLine: target.startLine } : {}),
      ...(typeof target.startColumn === "number" ? { startColumn: target.startColumn } : {}),
    };
    navigate("/files", { state });
    onOpenWorkspacePath?.(target.openFilePath, target.laneId);
  }, [currentLaneId, filesWorkspaces, navigate, onOpenWorkspacePath]);

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
  const turnEndDurationByRowIndex = useMemo(() => {
    const map = new Map<number, number>();
    let turnStartMs: number | null = null;
    for (let i = 0; i < groupedRows.length; i += 1) {
      const env = groupedRows[i];
      if (!env) continue;
      const ts = Date.parse(env.timestamp);
      if (turnStartMs === null && Number.isFinite(ts)) turnStartMs = ts;
      if (env.event.type === "done") {
        const start = turnStartMs ?? ts;
        map.set(i, Number.isFinite(ts) && Number.isFinite(start) ? Math.max(0, ts - start) : 0);
        turnStartMs = null;
      }
    }
    return map;
  }, [groupedRows]);

  const handleReviewChanges = useCallback(() => {
    if (!turnSummary?.changedFileCount) return;
    const state = currentLaneId ? { laneId: currentLaneId } : undefined;
    navigate("/files", state ? { state } : undefined);
  }, [currentLaneId, navigate, turnSummary]);

  useEffect(() => {
    stickToBottomRef.current = stickToBottom;
  }, [stickToBottom]);

  const measureScrollContainerHeight = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nextHeight = el.clientHeight;
    setContainerHeight((current) => (
      Math.abs(current - nextHeight) >= 1 ? nextHeight : current
    ));
  }, []);

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

  const releaseBottomStickinessForUserScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || el.scrollHeight <= el.clientHeight + 1 || !stickToBottomRef.current) return;
    stickToBottomRef.current = false;
    setStickToBottom(false);
    scrollFollowFramesRef.current = 0;
    programmaticScrollTargetRef.current = null;
    if (scrollRafRef.current !== null) {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }
  }, []);

  useEffect(() => () => {
    if (scrollRafRef.current !== null) {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }
    scrollFollowFramesRef.current = 0;
  }, []);

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
      if (stickToBottomRef.current) scrollToBottomSoon();
      return;
    }
    const ro = new ResizeObserver(() => {
      if (stickToBottomRef.current) scrollToBottomSoon(2);
    });
    ro.observe(wrapper);
    return () => ro.disconnect();
  }, [scrollToBottomSoon]);

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
      setContainerHeight((current) => (
        Math.abs(current - nextHeight) >= 1 ? nextHeight : current
      ));
    });
    ro.observe(el);
    measureScrollContainerHeight();
    return () => ro.disconnect();
  }, [measureScrollContainerHeight]);

  const shouldVirtualize = groupedRows.length >= VIRTUALIZATION_THRESHOLD;

  useLayoutEffect(() => {
    measureScrollContainerHeight();
    const raf = requestAnimationFrame(() => {
      measureScrollContainerHeight();
      if (stickToBottomRef.current) scrollToBottomSoon(2);
    });
    return () => cancelAnimationFrame(raf);
  }, [groupedRows.length, measureScrollContainerHeight, scrollToBottomSoon, shouldVirtualize]);

  /** Returns the best-known height for a given row index. */
  const rowHeight = useCallback((index: number) => {
    const key = groupedRowKeys[index];
    return key ? (measuredHeights.current.get(key) ?? ESTIMATED_ROW_HEIGHT) : ESTIMATED_ROW_HEIGHT;
  }, [groupedRowKeys]);

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
  const scrollToRowKey = useCallback((rowKey: string) => {
    const rowIndex = groupedRowKeys.indexOf(rowKey);
    if (rowIndex >= 0) scrollToRowIndexNearTop(rowIndex);
  }, [groupedRowKeys, scrollToRowIndexNearTop]);

  useEffect(() => {
    if (!scrollToRowKeyRequest?.key) return;
    if (lastHandledScrollToRowRequestIdRef.current === scrollToRowKeyRequest.requestId) return;
    lastHandledScrollToRowRequestIdRef.current = scrollToRowKeyRequest.requestId;
    scrollToRowKey(scrollToRowKeyRequest.key);
  }, [scrollToRowKey, scrollToRowKeyRequest]);

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

    const rowIndex = resolveAnchoredChatRowIndex({
      events,
      groupedRows,
      anchorEvent: pending.event,
      hasFullHistory: !hasOlderHistory,
    });
    if (rowIndex >= 0) {
      const rowKey = groupedRows[rowIndex]?.key ?? null;
      pendingChatEventAnchorRef.current = null;
      if (rowKey) {
        setAnchoredRowKey(rowKey);
        if (anchorHighlightTimerRef.current) clearTimeout(anchorHighlightTimerRef.current);
        anchorHighlightTimerRef.current = setTimeout(() => {
          anchorHighlightTimerRef.current = null;
          setAnchoredRowKey((current) => (current === rowKey ? null : current));
        }, 2000);
      }
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
    hasOlderHistory,
    loadingOlderHistory,
    onLoadOlderHistory,
    location.key,
    location.search,
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
      measuredHeights.current.set(key, height);
      const scrollEl = scrollRef.current;
      if (scrollEl && shouldVirtualize && !stickToBottomRef.current) {
        const adjustedScrollTop = reconcileMeasuredScrollTop({
          index,
          previousHeight: prev ?? ESTIMATED_ROW_HEIGHT,
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
  }, [groupedRowKeys, rowHeight, scrollToBottomSoon, shouldVirtualize, timelineRowGapPx]);

  // Compute the visible window of rows when virtualization is active.
  // measurementTick forces recomputation when row heights are measured so
  // totalHeight stays accurate — without this, scroll-to-top can break because
  // the spacer heights are computed from stale estimates.
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
      scrollTop,
      containerHeight,
      rowHeight,
      rowGap: timelineRowGapPx,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldVirtualize, stickToBottom, groupedRows.length, scrollTop, containerHeight, rowHeight, measurementTick, timelineRowGapPx]);

  useLayoutEffect(() => {
    if (stickToBottomRef.current) scrollToBottomSoon(2);
  }, [containerHeight, groupedRows.length, measurementTick, scrollToBottomSoon, shouldVirtualize, totalHeight]);

  // ── Prepend anchoring ──────────────────────────────────────────────────
  // When older transcript pages are prepended, keep the viewport visually
  // anchored to the row the user was looking at: bump scrollTop by exactly
  // the height inserted ABOVE the previous first row. In virtualized mode the
  // inserted height is derived from the same per-key height model the spacer
  // math uses (so the compensation matches the virtualizer's layout); in the
  // non-virtualized path the DOM scrollHeight delta is exact.
  const prependAnchorKeysRef = useRef<readonly string[] | null>(null);
  const prependDomMetricsRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  useLayoutEffect(() => {
    const prevKeys = prependAnchorKeysRef.current;
    prependAnchorKeysRef.current = groupedRowKeys;
    const el = scrollRef.current;
    if (!el || !prevKeys?.length || groupedRowKeys.length <= prevKeys.length) return;
    if (stickToBottomRef.current) return;

    // Locate one of the previous leading rows in the new list. Scanning a few
    // keys tolerates the seam row being re-grouped/merged by the collapse
    // pipeline (its key changes when older events join its group).
    let anchorOldIndex = -1;
    let anchorNewIndex = -1;
    for (let oldIndex = 0; oldIndex < Math.min(prevKeys.length, 4); oldIndex += 1) {
      const key = prevKeys[oldIndex]!;
      const newIndex = groupedRowKeys.indexOf(key);
      if (newIndex >= 0) {
        anchorOldIndex = oldIndex;
        anchorNewIndex = newIndex;
        break;
      }
    }
    // No prepend (appends keep leading keys at the same index) or no anchor.
    if (anchorOldIndex < 0 || anchorNewIndex <= anchorOldIndex) return;

    let delta: number;
    if (shouldVirtualize) {
      const heightForKey = (key: string | undefined): number =>
        (key ? measuredHeights.current.get(key) : undefined) ?? ESTIMATED_ROW_HEIGHT;
      let oldPrefix = 0;
      for (let i = 0; i < anchorOldIndex; i += 1) oldPrefix += heightForKey(prevKeys[i]) + timelineRowGapPx;
      let newPrefix = 0;
      for (let i = 0; i < anchorNewIndex; i += 1) newPrefix += heightForKey(groupedRowKeys[i]) + timelineRowGapPx;
      delta = newPrefix - oldPrefix;
    } else {
      const previousMetrics = prependDomMetricsRef.current;
      delta = previousMetrics ? el.scrollHeight - previousMetrics.scrollHeight : 0;
    }
    if (delta <= 0) return;

    const before = el.scrollTop;
    el.scrollTop = before + delta;
    if (el.scrollTop !== before) {
      programmaticScrollTargetRef.current = el.scrollTop;
      setScrollTop(el.scrollTop);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupedRowKeys, shouldVirtualize, timelineRowGapPx]);

  // Snapshot DOM scroll metrics after every commit so the prepend anchor can
  // compare against the pre-prepend layout on the next commit.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) prependDomMetricsRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
  });

  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    // Absorb scroll events produced by our own programmatic scroll-to-bottom
    // writes so we never flip sticky state based on them — only the user's
    // own gesture (wheel / trackpad / keyboard) should break auto-follow.
    const programmaticTarget = programmaticScrollTargetRef.current;
    if (shouldAbsorbProgrammaticScrollEvent({
      scrollTop: target.scrollTop,
      programmaticTarget,
    })) {
      programmaticScrollTargetRef.current = null;
      setScrollTop(target.scrollTop);
      return;
    }
    programmaticScrollTargetRef.current = null;
    const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
    // Wider threshold (~1 row of assistant text) so a small wheel nudge
    // while the turn is streaming actually breaks free instead of snapping
    // straight back to the bottom.
    const nextStick = shouldStickToBottomAfterScroll({
      distanceFromBottom,
      wasStuckToBottom: stickToBottomRef.current,
    });
    if (nextStick !== stickToBottomRef.current) {
      stickToBottomRef.current = nextStick;
      setStickToBottom(nextStick);
    }
    setScrollTop(target.scrollTop);
    maybeRequestOlderHistory(target.scrollTop);
  }, [maybeRequestOlderHistory]);

  const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) {
      releaseBottomStickinessForUserScroll();
    }
  }, [releaseBottomStickinessForUserScroll]);

  const handleTouchStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    lastTouchYRef.current = event.touches[0]?.clientY ?? null;
  }, []);

  const handleTouchMove = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const nextY = event.touches[0]?.clientY ?? null;
    const previousY = lastTouchYRef.current;
    if (nextY != null && previousY != null && nextY - previousY > TOUCH_SCROLL_DEADBAND_PX) {
      releaseBottomStickinessForUserScroll();
    }
    lastTouchYRef.current = nextY;
  }, [releaseBottomStickinessForUserScroll]);

  const handleTouchEnd = useCallback(() => {
    lastTouchYRef.current = null;
  }, []);

  const jumpToLatest = useCallback(() => {
    stickToBottomRef.current = true;
    setStickToBottom(true);
    scrollToBottomSoon();
  }, [scrollToBottomSoon]);

  const fullUserMinimapEntries = useMemo(
    () => collectUserMessageMinimapSourceEntries(groupedRows),
    [groupedRows],
  );

  const minimapDisplayEntries = useMemo(
    () => buildMinimapDisplayEntries(groupedRows),
    [groupedRows],
  );

  const rowStartOffsetsForMinimap = useMemo(() => {
    void measurementTick;
    return computeRowStartOffsets(groupedRows.length, rowHeight, timelineRowGapPx);
  }, [groupedRows, rowHeight, measurementTick, timelineRowGapPx]);

  const activeFullUserOrdinal = useMemo(
    () => computeActiveFullUserOrdinal(scrollTop, fullUserMinimapEntries, rowStartOffsetsForMinimap),
    [scrollTop, fullUserMinimapEntries, rowStartOffsetsForMinimap],
  );

  const activeMinimapDisplayIndex = useMemo(
    () => computeActiveDisplayIndex(activeFullUserOrdinal, minimapDisplayEntries),
    [activeFullUserOrdinal, minimapDisplayEntries],
  );

  const jumpToRowFromMinimap = useCallback(
    (rowIndex: number) => {
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
    [groupedRows, rowHeight, timelineRowGapPx],
  );

  const latestWorkLogIndex = useMemo(() => {
    for (let i = groupedRows.length - 1; i >= 0; i -= 1) {
      if (groupedRows[i]?.event.type === "work_log_group") return i;
    }
    return -1;
  }, [groupedRows]);

  /** Renders a single row with turn-divider logic. Used by both paths. */
  const renderRow = useCallback((envelope: TranscriptGroupedEnvelope, index: number, virtualized: boolean) => {
    const currentTurn = getGroupedTurnId(envelope);
    // Turn dividers render at the END of a turn (the `done` row) for every
    // runtime; the old start-of-turn boundary divider is disabled.
    const showTurnDivider = false;
    const turnDividerLabel: string | null = null;
    const turnEndDurationMs = envelope.event.type === "done"
      ? (turnEndDurationByRowIndex.get(index) ?? null)
      : undefined;
    const turnModel = currentTurn
      ? (turnModelState.map.get(currentTurn) ?? null)
      : turnModelState.lastModel;
    const isLatestWorkLog = index === latestWorkLogIndex;

    const rowTurnActive = Boolean(currentTurn && activeTurnId && currentTurn === activeTurnId) && !sessionEnded;
    const anchored = envelope.key === anchoredRowKey;
    const assistantTurnCopy = assistantTurnCopyByRowKey.get(envelope.key) ?? null;

    if (virtualized) {
      return (
        <MeasuredEventRow
          key={envelope.key}
          index={index}
          onMeasure={handleMeasure}
          envelope={envelope}
          showTurnDivider={Boolean(showTurnDivider)}
          turnDividerLabel={turnDividerLabel}
          turnModel={turnModel}
          turnEndDurationMs={turnEndDurationMs}
          onApproval={handleApproval}
          onCodexRecovery={onCodexRecovery}
          surfaceMode={surfaceMode}
          surfaceProfile={surfaceProfile}
          assistantLabel={assistantLabel}
          turnActive={rowTurnActive}
          sessionEnded={sessionEnded}
          isLatestWorkLog={isLatestWorkLog}
          onOpenWorkspacePath={openWorkspacePath}
          onNavigateSuggestion={handleNavigateSuggestion}
          onReviewChanges={handleReviewChanges}
          onInsertDraft={onInsertDraft}
          onRevealChatTerminal={onRevealChatTerminal}
          onRewindFiles={onRewindFiles}
          turnDiffSummaries={turnDiffSummaries}
          respondingApprovalIds={respondingApprovalIds}
          pendingApprovalIds={pendingApprovalIds}
          resolvedInputStates={resolvedInputStates}
          laneId={laneId}
          sessionId={sessionId}
          runtimeName={runtimeName}
          mosaic={mosaic}
          anchored={anchored}
          onScrollToRowKey={scrollToRowKey}
          assistantTurnCopy={assistantTurnCopy}
        />
      );
    }

    return (
      <EventRow
        key={envelope.key}
        envelope={envelope}
        showTurnDivider={Boolean(showTurnDivider)}
        turnDividerLabel={turnDividerLabel}
        turnModel={turnModel}
        onApproval={handleApproval}
        onCodexRecovery={onCodexRecovery}
        surfaceMode={surfaceMode}
        surfaceProfile={surfaceProfile}
        assistantLabel={assistantLabel}
        turnActive={rowTurnActive}
        sessionEnded={sessionEnded}
        isLatestWorkLog={isLatestWorkLog}
        onOpenWorkspacePath={openWorkspacePath}
        onNavigateSuggestion={handleNavigateSuggestion}
        onReviewChanges={handleReviewChanges}
        onInsertDraft={onInsertDraft}
        onRevealChatTerminal={onRevealChatTerminal}
        onRewindFiles={onRewindFiles}
        turnDiffSummaries={turnDiffSummaries}
        respondingApprovalIds={respondingApprovalIds}
        pendingApprovalIds={pendingApprovalIds}
        resolvedInputStates={resolvedInputStates}
        laneId={laneId}
        sessionId={sessionId}
        runtimeName={runtimeName}
        mosaic={mosaic}
        anchored={anchored}
        onScrollToRowKey={scrollToRowKey}
        assistantTurnCopy={assistantTurnCopy}
      />
    );
  }, [activeTurnId, anchoredRowKey, assistantLabel, assistantTurnCopyByRowKey, surfaceMode, surfaceProfile, groupedRows, latestWorkLogIndex, turnModelState, handleApproval, handleMeasure, openWorkspacePath, handleNavigateSuggestion, handleReviewChanges, onCodexRecovery, onInsertDraft, onRevealChatTerminal, onRewindFiles, turnDiffSummaries, respondingApprovalIds, pendingApprovalIds, resolvedInputStates, laneId, sessionId, sessionEnded, runtimeName, mosaic, scrollToRowKey]);

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
      className="w-fit max-w-[min(100%,70ch)] pt-3 pb-2"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.12, ease: "easeOut" }}
    >
      <WorkingIndicator
        activity={latestActivity ? (ACTIVITY_LABELS[latestActivity.activity] ?? null) : null}
        startedAt={activeTurnStartedAt}
      />
    </motion.div>
  ) : null;

  // End-of-turn dividers now render inline at each `done` row (DoneTurnDivider),
  // so there is no separate bottom divider.
  const turnDivider = null;

  // Jump-to-latest pill is only meaningful during an active turn — if nothing
  // is streaming there's no "latest" to catch up to.
  const showJumpToLatest = !stickToBottom && !sessionEnded;

  return (
    <div className={cn("relative h-full min-h-0 min-w-0 max-w-full overflow-hidden", className)}>
      {/* Bound the minimap to the centered chat column, then place it just outside
          the transcript gutter on wide layouts so it does not stripe the message text. */}
      <div className="pointer-events-none absolute inset-0 z-20 mx-auto w-full max-w-[var(--chat-column,52rem)]">
        <ChatUserMinimap
          displayEntries={minimapDisplayEntries}
          activeDisplayIndex={activeMinimapDisplayIndex}
          onJumpToRow={jumpToRowFromMinimap}
          placement="outsideRight"
        />
      </div>
      <div
        ref={scrollRef}
        className="ade-chat-timeline-pane h-full min-h-0 min-w-0 overflow-x-hidden overflow-y-auto pl-[length:var(--chat-timeline-pad-x)] pr-[length:var(--chat-timeline-pad-x)] pt-[length:var(--chat-timeline-pad-top)] pb-[length:var(--chat-timeline-pad-bottom)]"
        onScroll={handleScroll}
        onWheel={handleWheel}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
      >
        <div ref={contentWrapperRef} className="mx-auto w-full min-w-0 max-w-[var(--chat-column,52rem)] overflow-visible">
          {hasOlderHistory ? (
            /* Constant-height slot while older pages exist so toggling the
               loading text never shifts the transcript below it. Unmounts
               entirely once the head of the transcript is reached. */
            <div
              className="flex h-7 shrink-0 items-center justify-center font-sans text-[11px] text-fg/45"
              role="status"
              aria-live="polite"
            >
              {loadingOlderHistory ? "loading earlier messages…" : null}
            </div>
          ) : null}
          {rows.length === 0 && !streamingIndicator ? (
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
              {streamingIndicator}
              {turnDivider}
            </div>
          ) : (
            /* ── Non-virtualized path: render all rows (small conversation) ── */
            <div className="flex min-w-0 max-w-full flex-col gap-[length:var(--chat-row-gap)]">
              {groupedRows.map((envelope, index) => renderRow(envelope, index, false))}
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
          className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-violet-400/30 bg-violet-500/20 px-3 py-1.5 font-sans text-[length:calc(var(--chat-font-size)*11/14)] font-medium text-violet-100 shadow-lg shadow-violet-500/20 backdrop-blur-md transition-colors hover:bg-violet-500/30"
          aria-label="Jump to latest message"
        >
          <CaretDown size={11} weight="bold" />
          <span>Jump to latest</span>
        </button>
      ) : null}
    </div>
  );
}

export const AgentChatMessageList = AgentChatMessageListMain;

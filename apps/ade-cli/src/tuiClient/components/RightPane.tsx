import React from "react";
import { Box, Text } from "ink";
import type {
  AdeCodeInterfaceMode,
  AdeCodeProvider,
  ChatInfoPlanStep,
  ChatInfoSnapshot,
  ChatScheduledWorkSnapshot,
  RightPaneContent,
  SubagentSnapshot,
} from "../types";
import type { AgentChatSessionSummary } from "../../../../desktop/src/shared/types/chat";
import type { TuiChatSessionSummary } from "../adeApi";
import { theme } from "../theme";
import {
  externalSessionActionKey,
  externalSessionBrowserActions,
  externalSessionProviderLabel,
  shortenCwd,
  visibleExternalSessions,
} from "../externalSessionBrowser";
import { formatRelativePastTime } from "../relativeTime";
import {
  isEarlierBackgroundItem,
  isEarlierScheduleItem,
  backgroundCommandLabel,
  compactRelativeDuration,
} from "../../../../desktop/src/shared/chatScheduledWork";
import {
  BACKGROUND_ACTIVE_CAP,
  SCHEDULE_ACTIVE_CAP,
  capPaneSectionItems,
  groupPaneSectionItems,
} from "../../../../desktop/src/shared/chatSubagents";
import {
  buildSubagentPaneRows,
  SUBAGENT_PANE_ROSTER_CAPACITY,
  type SubagentPaneRow,
  type SubagentPaneViewState,
  windowSubagentPaneRows,
} from "../subagentPane";
import { ModelPickerPane } from "./ModelPicker/ModelPickerPane";
import { buildModelPickerLayout } from "./ModelPicker/modelPickerLayout";
import { TokenBar } from "./FooterControls";
import { UsagePane } from "./UsagePane";
import type { AgentChatModelCatalog, AgentChatModelInfo } from "../../../../desktop/src/shared/types/chat";
import type { AiSettingsStatus } from "../../../../desktop/src/shared/types/config";
import { useHoveredHitId } from "../hitTestRegistry";
import { diffLineKind, type DiffLineKind } from "../format";
import type { SubagentCapability } from "../../../../desktop/src/shared/subagentCapabilities";
import { missionFeatureCounts, orderMissionFeatures } from "../../../../desktop/src/renderer/components/chat/chatMission";
import type { MissionSnapshot } from "../types";
import type { HelpRow } from "../helpIndex";
import {
  NEW_LANE_COLOR_OPTIONS,
  NEW_LANE_START_HINT,
  NEW_LANE_START_LABEL,
  NEW_LANE_START_ORDER,
  NEW_LANE_TYPEAHEAD_ROWS,
  filterNewLaneBranchMatches,
  newLaneColorIndex,
  newLaneCreateAction,
  newLaneTypeaheadField,
  normalizeNewLaneBranchSource,
  normalizeNewLaneStart,
} from "../newLaneForm";
import { useShimmerTick } from "../spinTick";
import {
  FEEDBACK_TYPES,
  feedbackFormCanSubmit,
  serializeContextFooter,
  type FeedbackFormState,
  type FeedbackType,
} from "../feedbackForm";

// Cap per-file diff body so a pathological 50k-line file can't make the right
// pane build a giant row array on every scroll. The window only shows
// DETAILS_BODY_MAX_LINES at a time, but the flattened array is built in full —
// this keeps that bounded while still covering any realistic review diff.
const DIFF_FILE_BODY_MAX = 600;

// Map a diff line kind to a theme token. Green/red here is diff *content*
// semantics (the universal add/remove convention Claude Code uses), not idle
// chrome — so it's exempt from the "no green chrome" rule.
function diffLineTone(kind: DiffLineKind): { color: string; dim: boolean; bold: boolean } {
  switch (kind) {
    case "add":
      return { color: theme.color.done, dim: false, bold: false };
    case "del":
      return { color: theme.color.error, dim: false, bold: false };
    case "hunk":
      return { color: theme.color.violet, dim: false, bold: true };
    case "meta":
      return { color: theme.color.t4, dim: true, bold: false };
    default:
      return { color: theme.color.t3, dim: true, bold: false };
  }
}

// ---------------------------------------------------------------------------
// Right-pane width / focus chrome
// ---------------------------------------------------------------------------

const DEFAULT_PANE_WIDTH = 38;
const LANE_FILE_PREVIEW_ROWS = 5;
const EXTERNAL_SESSION_ROW_WINDOW = 4;
export const DETAILS_BODY_MAX_LINES = 26;

// ---------------------------------------------------------------------------
// Actions for the lane-details pane (5 rows · wireframe)
// ---------------------------------------------------------------------------

export const LANE_DETAIL_ACTIONS: ReadonlyArray<{
  k: string;
  label: string;
  slashCommand: string;
  detail?: string;
  glyph?: string;
  glyphColorKind: "additive" | "navigation" | "destructive" | "rescue";
  intent?: "rescue-unstaged";
}> = [
  { k: "n", label: "new chat", slashCommand: "/new chat", glyph: "✦", glyphColorKind: "additive" },
  { k: "o", label: "open / create PR", slashCommand: "/pr open", detail: "create when missing", glyph: "↗", glyphColorKind: "navigation" },
  { k: "a", label: "stage all", slashCommand: "/stage all", glyph: "+", glyphColorKind: "additive" },
  {
    k: "u",
    label: "move unstaged to new lane",
    slashCommand: "/lane-rescue-unstaged",
    intent: "rescue-unstaged" as const,
    detail: "child lane from unstaged work",
    glyph: "⇄",
    glyphColorKind: "rescue",
  },
  { k: "c", label: "commit", slashCommand: "/commit", detail: "claude will draft message", glyph: "✓", glyphColorKind: "additive" },
  { k: "p", label: "push", slashCommand: "/push", glyph: "↑", glyphColorKind: "additive" },
  { k: "d", label: "diff", slashCommand: "/diff", glyph: "≡", glyphColorKind: "navigation" },
  { k: "r", label: "reparent", slashCommand: "/reparent", detail: "optional base ref", glyph: "⎇", glyphColorKind: "navigation" },
  { k: "x", label: "delete lane", slashCommand: "/lane delete", detail: "requires name", glyph: "✗", glyphColorKind: "destructive" },
];

export const LANE_DETAIL_PR_ACTION_INDEX = LANE_DETAIL_ACTIONS.length;

type LaneDetailsContent = Extract<RightPaneContent, { kind: "lane-details" }>;

export type LaneDetailsInteractionLayout = {
  actionRows: number[];
  prRow: { start: number; height: number } | null;
};

export function laneDetailsInteractionLayout(content: LaneDetailsContent): LaneDetailsInteractionLayout {
  const worktreeMissing = content.worktreeAvailable === false;
  const filesCount = Math.max(content.git.total, content.files.length);
  const changedRows = content.files.slice(0, content.showFiles ? 9 : LANE_FILE_PREVIEW_ROWS);
  const remainingFiles = Math.max(0, filesCount - changedRows.length);

  let row = 0;
  // RightPane lane-details header: title, optional branch, and marginBottom.
  row += 1 + (content.lane.branchRef ? 1 : 0) + 1;
  if (worktreeMissing) row += 1;
  row += 2; // STATUS section heading with marginTop.
  row += 1; // working state.
  row += 1; // ahead / behind line.
  if (content.setup) {
    row += 2; // SETUP section heading with marginTop.
    row += content.setup.detail ? 2 : 1;
  }
  if (worktreeMissing) {
    row += 2; // UNAVAILABLE section heading with marginTop.
    row += 1; // unavailable detail.
  }
  row += 2; // CHANGES section heading with marginTop.
  row += changedRows.length ? changedRows.length : 1;
  if (remainingFiles > 0) row += 1;
  row += changedRows.length ? 2 : 1; // stats row, plus margin when file rows exist.

  const actionRows: number[] = [];
  if (!worktreeMissing) {
    row += 2; // ACTIONS section heading with marginTop.
    for (let index = 0; index < LANE_DETAIL_ACTIONS.length; index += 1) {
      actionRows.push(row + index);
    }
    row += LANE_DETAIL_ACTIONS.length;
  }

  let prRow: LaneDetailsInteractionLayout["prRow"] = null;
  if (content.pr) {
    row += 2; // PR section heading with marginTop.
    prRow = { start: row, height: 3 };
  }

  return { actionRows, prRow };
}

export function computeLaneChatCounts(
  sessions: AgentChatSessionSummary[],
  laneId: string,
): { active: number; needsYou: number; settled: number; closed: number; failed: number } {
  const laneSessions = sessions.filter((session) => session.laneId === laneId);
  let active = 0;
  let needsYou = 0;
  let settled = 0;
  let closed = 0;
  let failed = 0;
  for (const session of laneSessions) {
    const lifecycle = session as TuiChatSessionSummary;
    if (session.awaitingInput || lifecycle.attentionRequestedAt) {
      needsYou += 1;
      continue;
    }
    if (lifecycle.settledAt && session.status !== "active") {
      settled += 1;
      continue;
    }
    if (lifecycle.lastTurnFailedAt) {
      failed += 1;
      continue;
    }
    if (session.status === "active" || session.status === "idle") {
      active += 1;
      continue;
    }
    if (session.completion?.status === "blocked") {
      failed += 1;
    } else {
      closed += 1;
    }
  }
  return { active, needsYou, settled, closed, failed };
}

type LaneDetailsPr = NonNullable<Extract<RightPaneContent, { kind: "lane-details" }>["pr"]>;

function laneDetailsPrChecksLineColor(pr: LaneDetailsPr): string {
  if (pr.checksPending > 0) return theme.color.running;
  if (pr.checksFailed > 0) return theme.color.error;
  return theme.color.t3;
}

function laneDetailsPrChipStatus(state: LaneDetailsPr["state"]): "info" | "done" | "idle" {
  if (state === "open") return "info";
  if (state === "merged") return "done";
  return "idle";
}

function formatPrActivity(pr: LaneDetailsPr): string {
  if (pr.checksPending > 0) {
    const done = pr.checksTotal - pr.checksPending;
    return `CI running · ${done}/${pr.checksTotal} done`;
  }
  if (pr.checksFailed > 0) {
    return `${pr.checksFailed} check${pr.checksFailed === 1 ? "" : "s"} failing`;
  }
  if (pr.checksTotal > 0) {
    return "checks passing";
  }
  if (pr.state === "merged") return "merged";
  if (pr.state === "closed") return "closed";
  return "open";
}

function formatLaneChatSummary(chats: Extract<RightPaneContent, { kind: "lane-details" }>["chats"]): string {
  const parts: string[] = [];
  if (chats.active > 0) parts.push(`${chats.active} active`);
  if (chats.needsYou > 0) parts.push(`${chats.needsYou} needs you`);
  if (chats.settled > 0) parts.push(`${chats.settled} settled`);
  if (chats.closed > 0) parts.push(`${chats.closed} closed`);
  if (chats.failed > 0) parts.push(`${chats.failed} failed`);
  return parts.length ? parts.join(" · ") : "no chats";
}

// ---------------------------------------------------------------------------
// Tiny atom helpers (inline replacements for Chip / Rail / SectionLG / Kbd /
// ActionRow / Exec from the wireframe primitives)
// ---------------------------------------------------------------------------

function Chip({
  status,
  children,
}: {
  status: "running" | "attention" | "error" | "info" | "idle" | "done";
  children: React.ReactNode;
}) {
  const colorMap: Record<typeof status, string> = {
    running: theme.color.running,
    attention: theme.color.attention,
    error: theme.color.error,
    info: theme.color.info,
    idle: theme.color.t4,
    done: theme.color.done,
  } as const;
  const color = colorMap[status];
  return (
    <Text color={color}>
      [<Text bold>●</Text> {children}]
    </Text>
  );
}

function SectionHead({ title, hint }: { title: string; hint?: string }) {
  return (
    <Box flexDirection="row" justifyContent="space-between" marginTop={1}>
      <Text bold color={theme.color.t3}>{title}</Text>
      {hint ? <Text color={theme.color.t4} dimColor>{hint}</Text> : null}
    </Box>
  );
}

function actionGlyphColor(kind: typeof LANE_DETAIL_ACTIONS[number]["glyphColorKind"]): string {
  if (kind === "additive") return theme.color.running;
  if (kind === "destructive") return theme.color.error;
  if (kind === "rescue") return theme.color.attention;
  return theme.color.violet;
}

function ActionRow({
  k,
  label,
  detail,
  glyph,
  glyphColorKind,
  selected,
  width,
}: {
  k: string;
  label: string;
  detail?: string;
  glyph?: string;
  glyphColorKind: typeof LANE_DETAIL_ACTIONS[number]["glyphColorKind"];
  selected?: boolean;
  width: number;
}) {
  const glyphChar = glyph ?? " ";
  const glyphColor = actionGlyphColor(glyphColorKind);
  // Reserve at least a small budget so we never produce a negative width.
  const safeWidth = Math.max(8, width);
  if (!selected) {
    // Non-selected: "  {glyph} {label}" — two leading spaces, glyph, space, label.
    // Total prefix is 3 chars ("  " + glyph + " ").
    const remaining = Math.max(1, safeWidth - 3);
    const labelText = endTruncate(label, remaining);
    return (
      <Text wrap="truncate">
        <Text>{"  "}</Text>
        <Text color={glyphColor}>{glyphChar}</Text>
        <Text color={theme.color.t2}>{` ${labelText}`}</Text>
      </Text>
    );
  }
  // Selected: "▎ [k] {glyph} {label}  {detail?}"
  // Prefix string (rail + space + [k] + space): "▎ [k] "  → 6 chars (rail counted as 1 cell).
  const prefix = `${theme.rail} [${k}] `;
  // After prefix we render: glyph + space + label + (optional "  " + detail)
  // Reserve width for prefix + glyph + space + label first.
  const afterPrefix = Math.max(1, safeWidth - prefix.length);
  // glyph+space costs 2 cells.
  const labelBudget = Math.max(1, afterPrefix - 2);
  const labelText = endTruncate(label, labelBudget);
  const used = prefix.length + 2 + labelText.length;
  let detailText = "";
  if (detail) {
    const detailRoom = Math.max(0, safeWidth - used - 2); // 2 = "  " gap
    if (detailRoom > 1) {
      detailText = `  ${endTruncate(detail, detailRoom)}`;
    }
  }
  return (
    <Text wrap="truncate" color={theme.color.violet} bold>
      <Text>{prefix}</Text>
      <Text color={glyphColor}>{glyphChar}</Text>
      <Text>{` ${labelText}${detailText}`}</Text>
    </Text>
  );
}

function ExecGlyph({ provider }: { provider: AdeCodeProvider | "shell" | "copilot" | null | undefined }) {
  if (!provider) return <Text color={theme.color.t4}>·</Text>;
  if (provider === "shell") return <Text color={theme.color.shell}>$</Text>;
  if (provider === "copilot") return <Text color={theme.color.copilot}>◉</Text>;
  const brand = theme.provider(provider as AdeCodeProvider);
  return <Text color={brand.color}>{brand.glyph}</Text>;
}

function tailTruncate(value: string, max: number): string {
  if (max <= 1) return value.length ? "…" : "";
  if (value.length <= max) return value;
  return `…${value.slice(value.length - (max - 1))}`;
}

function endTruncate(value: string, max: number): string {
  if (max <= 1) return value.length ? "…" : "";
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function compactPath(value: string, max: number): string {
  if (value.length <= max) return value;
  const parts = value.split("/").filter(Boolean);
  for (let count = Math.min(4, parts.length); count >= 1; count -= 1) {
    const candidate = `…/${parts.slice(-count).join("/")}`;
    if (candidate.length <= max) return candidate;
  }
  return tailTruncate(value, max);
}

function formatTokens(tok: number | null | undefined): string {
  if (tok == null) return "—";
  if (tok >= 1000) return `${(tok / 1000).toFixed(1)}k`;
  return `${tok}`;
}

function formatElapsed(ms: number | null | undefined): string {
  if (ms == null) return "—";
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}

// ---------------------------------------------------------------------------
// Lane-details renderer (wireframe MainChatFinal · right column)
// ---------------------------------------------------------------------------

function LaneSectionHead({ title, width }: { title: string; width: number }) {
  const lineWidth = Math.max(2, width - title.length - 4);
  return (
    <Box flexDirection="row" marginTop={1}>
      <Text bold color={theme.color.violet}>{title}</Text>
      <Text color={theme.color.borderSoft}> {"─".repeat(lineWidth)}</Text>
    </Box>
  );
}

function LaneFileRow({
  file,
  width,
}: {
  file: { path: string; status: "M" | "A" | "D" | "?"; staged: boolean };
  width: number;
}) {
  const statusColor = file.status === "D"
    ? theme.color.error
    : file.status === "A" || file.status === "?"
      ? theme.color.running
      : theme.color.attention;
  const pathWidth = Math.max(10, width - 8);
  return (
    <Box flexDirection="row">
      <Text color={file.staged ? theme.color.running : theme.color.t5}>{file.staged ? "●" : "○"} </Text>
      <Text color={statusColor}>{file.status}</Text>
      <Text color={theme.color.t1}> {compactPath(file.path, pathWidth)}</Text>
    </Box>
  );
}

function LaneDetailsPane({
  content,
  width,
}: {
  content: Extract<RightPaneContent, { kind: "lane-details" }>;
  width: number;
}) {
  const hoveredId = useHoveredHitId();
  const lane = content.lane;
  const worktreeMissing = content.worktreeAvailable === false;
  const git = content.git;
  const workingClean = git.staged + git.unstaged === 0;
  const filesCount = Math.max(git.total, content.files.length);
  const contentWidth = Math.max(18, width - 4);
  const remoteLabel = git.remote && git.remote !== lane.branchRef ? git.remote : null;
  const changedRows = content.files.slice(0, content.showFiles ? 9 : LANE_FILE_PREVIEW_ROWS);
  const remainingFiles = Math.max(0, filesCount - changedRows.length);
  let workingColor: string = theme.color.attention;
  let workingLabel = "dirty";
  if (worktreeMissing) {
    workingColor = theme.color.error;
    workingLabel = "worktree missing";
  } else if (workingClean) {
    workingColor = theme.color.running;
    workingLabel = "clean";
  }
  const setup = content.setup ?? null;
  const setupColor = setup?.status === "failed"
    ? theme.color.error
    : setup?.status === "running"
      ? theme.color.running
      : theme.color.t3;

  let laneDetailsFooterHint = "↑↓ move · ↵ run · tab next section · esc close";
  if (worktreeMissing) {
    laneDetailsFooterHint = "esc close";
  } else if (content.pr) {
    laneDetailsFooterHint = "↑↓ move · ↵ run/open PR · tab next section · esc close";
  }

  return (
    <Box flexDirection="column">
      {worktreeMissing ? (
        <Text color={theme.color.error}>{tailTruncate(lane.worktreePath, contentWidth)}</Text>
      ) : null}

      <LaneSectionHead title="STATUS" width={contentWidth} />
      <Text color={workingColor}>● {workingLabel}</Text>
      <Box flexDirection="row">
        <Text color={git.ahead > 0 ? theme.color.running : theme.color.t4}>↑{git.ahead} </Text>
        <Text color={git.behind > 0 ? theme.color.attention : theme.color.t4}>↓{git.behind}</Text>
        {remoteLabel ? (
          <Text color={theme.color.t4}> {tailTruncate(remoteLabel, Math.max(5, contentWidth - 8))}</Text>
        ) : null}
      </Box>
      {setup ? (
        <>
          <LaneSectionHead title="SETUP" width={contentWidth} />
          <Text color={setupColor} wrap="truncate-end">
            {setup.status === "running" ? "●" : setup.status === "failed" ? "×" : "✓"} {endTruncate(setup.label, contentWidth - 2)}
          </Text>
          {setup.detail ? (
            <Text color={setup.status === "failed" ? theme.color.error : theme.color.t4} dimColor={setup.status !== "failed"} wrap="truncate-end">
              {"  "}{endTruncate(setup.detail, contentWidth - 2)}
            </Text>
          ) : null}
        </>
      ) : null}
      {worktreeMissing ? (
        <>
          <LaneSectionHead title="UNAVAILABLE" width={contentWidth} />
          <Text color={theme.color.error}>Restore this lane worktree before starting chats or running git actions.</Text>
        </>
      ) : null}

      <LaneSectionHead title={`CHANGES · ${filesCount}`} width={contentWidth} />
      <Box flexDirection="column">
        {changedRows.length ? changedRows.map((file) => (
          <LaneFileRow key={`${file.staged ? "s" : "u"}:${file.path}`} file={file} width={contentWidth} />
        )) : (
          <Text color={theme.color.t4} dimColor>No changed files.</Text>
        )}
        {remainingFiles > 0 ? (
          <Text color={theme.color.t4} dimColor>{`… ${remainingFiles} more`}</Text>
        ) : null}
        <Box flexDirection="row" marginTop={changedRows.length ? 1 : 0}>
          <Text color={theme.color.running}>{git.staged} staged</Text>
          <Text color={theme.color.t4}>  {git.unstaged} unstaged</Text>
          {git.additions || git.deletions ? (
            <>
              <Text color={theme.color.running}>  +{git.additions}</Text>
              <Text color={theme.color.error}> −{git.deletions}</Text>
            </>
          ) : null}
        </Box>
      </Box>

      {!worktreeMissing ? (
        <>
          <LaneSectionHead title="ACTIONS" width={contentWidth} />
          <Box flexDirection="column">
            {LANE_DETAIL_ACTIONS.map((action, idx) => (
              <ActionRow
                key={action.label}
                k={action.k}
                label={action.label}
                detail={action.detail}
                glyph={action.glyph}
                glyphColorKind={action.glyphColorKind}
                selected={idx === content.selectedActionIndex || hoveredId === `right:lane-action:${idx}`}
                width={contentWidth}
              />
            ))}
          </Box>
        </>
      ) : null}

      {content.pr ? (
        <>
          <LaneSectionHead title={`PR #${content.pr.number}`} width={contentWidth} />
          {content.selectedActionIndex === LANE_DETAIL_PR_ACTION_INDEX ? (
            <Box flexDirection="column">
              <Text color={theme.color.violet} bold>
                {theme.rail} [↵] open in browser
              </Text>
              <Text color={theme.color.info}>{tailTruncate(content.pr.url, contentWidth - 2)}</Text>
              <Text color={laneDetailsPrChecksLineColor(content.pr)}>
                {formatPrActivity(content.pr)}
              </Text>
            </Box>
          ) : (
            <Box flexDirection="column">
              <Box flexDirection="row">
                <Chip status={laneDetailsPrChipStatus(content.pr.state)}>
                  {content.pr.state}
                </Chip>
              </Box>
              <Text color={laneDetailsPrChecksLineColor(content.pr)}>
                {formatPrActivity(content.pr)}
              </Text>
              {content.pr.checksTotal > 0 ? (
                <Text color={theme.color.t4} dimColor>
                  {content.pr.checksPassed}/{content.pr.checksTotal} passing
                </Text>
              ) : null}
            </Box>
          )}
        </>
      ) : null}

      <LaneSectionHead title="CHATS" width={contentWidth} />
      <Text color={content.chats.active > 0 ? theme.color.running : theme.color.t4}>
        {formatLaneChatSummary(content.chats)}
      </Text>

      <Box marginTop={1}>
        <Text color={theme.color.t4} dimColor>
          {laneDetailsFooterHint}
        </Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Chat-info pane — main agent dashboard + subagent roster (cross-pane navigator)
// ---------------------------------------------------------------------------

function planStepColor(status: ChatInfoPlanStep["status"]): string {
  if (status === "completed") return theme.color.done;
  if (status === "failed") return theme.color.error;
  if (status === "in_progress") return theme.color.running;
  return theme.color.t4;
}

function planStepGlyph(status: ChatInfoPlanStep["status"]): string {
  if (status === "completed") return "✓";
  if (status === "failed") return "✗";
  if (status === "in_progress") return "◐";
  return "○";
}

function secondsElapsed(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  return formatElapsed(Math.max(0, seconds) * 1000);
}

function subagentAgentKind(status: SubagentSnapshot["status"]): "running" | "ok" | "waiting" | "error" {
  if (status === "running") return "running";
  if (status === "completed") return "ok";
  if (status === "stopped") return "waiting";
  return "error";
}

function isGenericSubagentSummary(value: string | undefined): boolean {
  const text = (value ?? "").trim().toLowerCase();
  return !text
    || text === "agent closed"
    || text === "stopped"
    || text === "agent closedstopped"
    || text.startsWith("parent turn ended before ade received");
}

function rosterRowDetail(snapshot: SubagentSnapshot): string | null {
  const parts = [snapshot.lastToolName, snapshot.summary]
    .filter((value): value is string => !isGenericSubagentSummary(value));
  const unique = parts.filter((part, index) => parts.indexOf(part) === index);
  return unique.length ? unique.join(" · ") : null;
}

// Per-runtime stat chips for the selected subagent's inline detail line. Only
// the fields the runtime's capability advertises and that the snapshot actually
// carries are shown (durationMs already prints on the row, so it is omitted here
// to avoid duplication). Kept to a single line so the click line-math — which
// accounts for exactly one detail line on the selected row — stays correct.
function subagentStatChips(snapshot: SubagentSnapshot, capability: SubagentCapability): string {
  const fields = new Set(capability.statsFields);
  const chips: string[] = [];
  if (fields.has("tokens") && typeof snapshot.tokens === "number" && snapshot.tokens > 0) {
    chips.push(`${compactNumber(snapshot.tokens)} tok`);
  }
  if (fields.has("toolUses") && typeof snapshot.toolUses === "number" && snapshot.toolUses > 0) {
    chips.push(`${snapshot.toolUses} tool${snapshot.toolUses === 1 ? "" : "s"}`);
  }
  if (fields.has("cost") && typeof snapshot.costUsd === "number" && snapshot.costUsd > 0) {
    chips.push(`$${snapshot.costUsd < 0.1 ? snapshot.costUsd.toFixed(4) : snapshot.costUsd.toFixed(2)}`);
  }
  return chips.join(" · ");
}

// Detail line content for the SELECTED subagent row. Matches the click line-math
// condition exactly (`lastToolName || summary` raw truthiness) so the rendered
// line count never drifts from `subagentPaneSelectableLineOffsets`.
function selectedRosterDetail(snapshot: SubagentSnapshot, capability: SubagentCapability): string | null {
  const rawHasDetail = Boolean(snapshot.lastToolName || snapshot.summary);
  if (!rawHasDetail) return null;
  const chips = subagentStatChips(snapshot, capability);
  const text = rosterRowDetail(snapshot);
  return [chips, text].filter((part) => part && part.length > 0).join(" · ")
    || (typeof snapshot.summary === "string" ? snapshot.summary : null)
    || "…";
}

function ChatInfoSectionHead({
  title,
  dimSuffix,
  hint,
  color,
  width,
}: {
  title: string;
  dimSuffix?: string;
  hint?: string;
  color: string;
  width?: number;
}) {
  // Section header with a hairline rule that fills the gap to the hint, so each
  // block reads as a titled card divider rather than a bare label.
  const inner = Math.max(12, (width ?? 40) - 4);
  const used = title.length + (dimSuffix ? dimSuffix.length + 1 : 0) + 2 + (hint ? hint.length + 1 : 0);
  const ruleLen = Math.max(1, inner - used);
  return (
    <Box flexDirection="row" marginTop={1}>
      <Text bold color={color}>{title}</Text>
      {dimSuffix ? <Text color={theme.color.t4} dimColor>{` ${dimSuffix}`}</Text> : null}
      <Text color={theme.color.borderSoft}>{` ${"─".repeat(ruleLen)}${hint ? " " : ""}`}</Text>
      {hint ? <Text color={theme.color.t4} dimColor>{hint}</Text> : null}
    </Box>
  );
}

function ChatInfoHeader({ info, width }: { info: ChatInfoSnapshot; width: number }) {
  const brand = theme.provider(info.provider);
  const inner = Math.max(10, width - 4);
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={brand.color} bold>{brand.glyph}</Text>
        <Text color={theme.color.t1}>{` ${endTruncate(info.modelLabel, inner - 2)}`}</Text>
      </Box>
      {info.laneLabel || info.claudeTag ? (
        <Box flexDirection="row">
          {info.laneLabel ? (
            <>
              <Text color={theme.color.t4}>lane </Text>
              <Text color={theme.color.t4} dimColor>· </Text>
              <Text color={theme.color.t2}>{endTruncate(info.laneLabel, Math.max(6, inner - 7))}</Text>
            </>
          ) : null}
          {info.claudeTag ? <Text color={theme.color.t4}>{`${info.laneLabel ? "  " : ""}tag:${endTruncate(info.claudeTag, 24)}`}</Text> : null}
        </Box>
      ) : null}
      <Box flexDirection="row" marginTop={1}>
        <Text color={info.streaming ? theme.color.running : theme.color.t4} bold={info.streaming}>
          {info.streaming ? "● live" : "○ idle"}
        </Text>
        {info.contextPercent != null ? (
          <>
            <Text>{"   "}</Text>
            <TokenBar percent={info.contextPercent} />
            <Text color={theme.color.t4} dimColor>{` ${info.contextPercent}%`}</Text>
          </>
        ) : null}
      </Box>
      {info.tokenSummary ? (
        <Text color={theme.color.t4} dimColor wrap="truncate-end">{endTruncate(info.tokenSummary, inner)}</Text>
      ) : null}
    </Box>
  );
}

function ChatInfoPlanBlock({ info, brandColor, width }: { info: ChatInfoSnapshot; brandColor: string; width: number }) {
  const plan = info.plan;
  const inner = Math.max(10, width - 4);
  if (!plan || !plan.steps.length) {
    return (
      <Box flexDirection="column">
        <ChatInfoSectionHead title="PLAN" color={brandColor} width={width} />
        <Text color={theme.color.t4} dimColor>No plan yet.</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <ChatInfoSectionHead title="PLAN" hint={`${plan.current}/${plan.total}`} color={brandColor} width={width} />
      {plan.steps.slice(0, 6).map((step, index) => (
        <Text key={`${index}:${step.text}`} color={planStepColor(step.status)} wrap="truncate-end">
          {planStepGlyph(step.status)} {endTruncate(step.text, inner - 2)}
        </Text>
      ))}
      {info.planExplanation ? (
        <Text color={theme.color.t4} dimColor wrap="truncate-end">{endTruncate(info.planExplanation, inner)}</Text>
      ) : null}
      {info.planStreamingText ? (
        <Text color={theme.color.t4} dimColor italic wrap="truncate-end">{endTruncate(info.planStreamingText, inner)}</Text>
      ) : null}
    </Box>
  );
}

function ChatInfoGoalBlock({ info, brandColor, width }: { info: ChatInfoSnapshot; brandColor: string; width: number }) {
  if (info.provider !== "codex" || !info.goal) return null;
  const goal = info.goal;
  const inner = Math.max(10, width - 4);
  return (
    <Box flexDirection="column">
      <ChatInfoSectionHead title="GOAL" hint={secondsElapsed(goal.timeUsedSeconds)} color={brandColor} width={width} />
      {goal.objective ? (
        <Text color={theme.color.t2} wrap="truncate-end">{endTruncate(goal.objective, inner)}</Text>
      ) : null}
    </Box>
  );
}

// ── Resume row (closed-but-resumable Claude terminal sessions) ──────────────
// Rendered as the FIRST chat-info body block (directly below the pane title,
// above the model header). It occupies a fixed number of lines ABOVE the
// roster, so the click line-math compensates: app.tsx adds
// CHAT_INFO_RESUME_ROW_LINES to `subagentPaneTop` whenever the row is visible
// — the same mechanism the variable goal-banner / add-mode header lines use.
export const CHAT_INFO_RESUME_ROW_LINES = 2;

/**
 * Selection-index offset the resume row introduces into the chat-info
 * selection model: with the row visible, index 0 = resume, 1 = main,
 * 2..N+1 = subagents (otherwise 0 = main, 1..N = subagents).
 */
export function chatInfoSelectionOffset(info: ChatInfoSnapshot): 0 | 1 {
  return info.resumableTerminal ? 1 : 0;
}

export function ChatInfoResumeRow({ selected }: { selected: boolean }) {
  return (
    <Box flexDirection="row" marginBottom={1}>
      <Text color={selected ? theme.color.attention : theme.color.t5}>{selected ? theme.rail : " "}</Text>
      {/* Deliberately orange (theme.color.attention) — this is the "your
          session died, bring it back" affordance. */}
      <Text color={theme.color.attention} bold>{" [ ⟳ resume session ]"}</Text>
      {selected ? <Text color={theme.color.t4} dimColor>{"  ↵ resume"}</Text> : null}
    </Box>
  );
}

function ChatInfoRoster({
  info,
  selectedIndex,
  brandColor,
  width,
  viewState,
}: {
  info: ChatInfoSnapshot;
  selectedIndex: number;
  brandColor: string;
  width: number;
  viewState: SubagentPaneViewState;
}) {
  const inner = Math.max(10, width - 4);
  const paneRows = buildSubagentPaneRows(info, viewState);
  const snapshotRows = paneRows
    .filter((row): row is Extract<SubagentPaneRow, { kind: "snapshot" }> => row.kind === "snapshot");
  const clearedIds = new Set(Object.values(viewState.cleared ?? {}).flatMap((ids) => [...(ids ?? [])]));
  const countedSnapshots = info.snapshots.filter((snapshot) => !clearedIds.has(snapshot.id));
  const runCount = countedSnapshots.filter((snapshot) => snapshot.status === "running").length;
  const doneCount = countedSnapshots.filter((snapshot) => snapshot.status === "completed").length;
  const failedCount = countedSnapshots.filter((snapshot) => snapshot.status === "failed").length;
  const bgCount = countedSnapshots.filter((snapshot) => snapshot.background === true).length;
  // Selection convention: 0 = main row; 1..N = subagent rows (1-indexed).
  // A negative index means the selection sits ABOVE the roster (the resume
  // row) — nothing in the roster highlights.
  const totalSelectable = snapshotRows.length + 1;
  const selected = Math.max(-1, Math.min(selectedIndex, totalSelectable - 1));
  const mainSelected = selected === 0;
  const showingMain = !info.inspectedSubagentId;
  // Gate on the full uncleared snapshot list, not the visible rows — a
  // collapsed section empties snapshotRows while agents are still running.
  const hint = countedSnapshots.length === 0
    ? "0 live"
    : [
        `${runCount} live`,
        `${doneCount} done`,
        failedCount ? `${failedCount} failed` : null,
        bgCount ? `${bgCount} bg` : null,
      ].filter((value): value is string => value !== null).join(" · ");

  const subagentSelectedIndex = mainSelected ? -1 : selected - 1;
  const selectedSnapshot = !mainSelected ? (snapshotRows[subagentSelectedIndex]?.snapshot ?? null) : null;
  const selectedSection = !mainSelected ? snapshotRows[subagentSelectedIndex]?.section ?? null : null;
  const selectedHeader = selectedSection
    ? paneRows.find((row): row is Extract<SubagentPaneRow, { kind: "section-header" }> => row.kind === "section-header" && row.section === selectedSection)
    : null;
  const disclosureHints = selectedHeader ? [
    ...(selectedHeader.collapsible ? ["c section"] : []),
    ...(selectedHeader.earlierCount > 0 || selectedHeader.clearedCount > 0 ? ["e completed"] : []),
    ...(selectedHeader.hasClear && viewState.earlierExpanded?.[selectedHeader.section] === true ? ["x clear"] : []),
    ...(paneRows.some((row) => row.kind === "show-all" && row.section === selectedSection) ? ["a all"] : []),
  ] : [];
  const { visibleRows: visibleSlice, hiddenBefore, hiddenAfter } = windowSubagentPaneRows(
    paneRows,
    selected,
    SUBAGENT_PANE_ROSTER_CAPACITY,
  );
  const rosterIndexByKey = new Map(snapshotRows.map((row, index) => [row.key, index]));

  return (
    <Box flexDirection="column">
      <ChatInfoSectionHead title="CHATS" hint={hint} color={brandColor} width={width} />
      {/* Main row — always present, tagged with the current middle-pane state */}
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row">
          <Text color={mainSelected ? theme.color.violet : theme.color.t5}>{mainSelected ? theme.rail : " "}</Text>
          <Text color={mainSelected ? theme.color.violet : showingMain ? theme.color.t1 : theme.color.t3} bold={mainSelected || showingMain}>
            {" main"}
          </Text>
        </Box>
        <Text color={theme.color.t4} dimColor>{showingMain ? "viewing" : "return ↵"}</Text>
      </Box>
      {info.snapshots.length === 0 ? (
        <Text color={theme.color.t4} dimColor>{" "}no subagents yet</Text>
      ) : (
        <>
          {hiddenBefore > 0 ? (
            <Text color={theme.color.t4} dimColor>{`  ↑ ${hiddenBefore} completed`}</Text>
          ) : null}
          {visibleSlice.map((row) => {
            if (row.kind === "section-header") {
              return <RosterSectionHead key={row.key} row={row} />;
            }
            if (row.kind === "earlier-toggle") {
              return (
                <Text key={row.key} color={theme.color.t4} dimColor>
                  {`  ${row.expanded ? "▾" : "▸"} completed (${row.count})${row.clearedCount ? ` · ${row.clearedCount} hidden` : ""}`}
                </Text>
              );
            }
            if (row.kind === "show-all") {
              return <Text key={row.key} color={theme.color.t4} dimColor>{`  + show all (${row.hiddenCount})`}</Text>;
            }
            if (row.kind === "restore-cleared") {
              return <Text key={row.key} color={theme.color.t4} dimColor>{`  restore (${row.count})`}</Text>;
            }
            const rosterIndex = rosterIndexByKey.get(row.key) ?? -1;
            const isSelected = !mainSelected && subagentSelectedIndex === rosterIndex;
            const kind = subagentAgentKind(row.snapshot.status);
            // Background rows get a cyan glyph tint so the eye can sort them out
            // from foreground subagents at a glance. Falls back to the
            // status-driven color for other rows.
            const statusColor = row.section === "background"
              ? theme.color.tool
              : theme.agentStatusColor(kind);
            const inspected = info.inspectedSubagentId === row.snapshot.id;
            // Only the selected row shows the (single) detail line, now enriched
            // with the runtime's capability stat chips. Keeping it to one line
            // preserves the click line-math.
            const detail = isSelected ? selectedRosterDetail(row.snapshot, info.capability) : null;
            return (
              <Box key={row.key} flexDirection="column">
                <Box flexDirection="row">
                  <Text color={isSelected ? theme.color.violet : theme.color.t5}>{isSelected ? theme.rail : " "}</Text>
                  <Text color={statusColor}>{` ${theme.agentStatusGlyph(kind)}`}</Text>
                  <Text color={isSelected ? theme.color.violet : inspected ? theme.color.t1 : theme.color.t2} bold={isSelected || inspected}>
                    {` ${endTruncate(row.snapshot.name, Math.max(6, inner - 18))}`}
                  </Text>
                  <Text color={theme.color.t4} dimColor>{`  ${formatElapsed(row.snapshot.durationMs ?? null)}`}</Text>
                </Box>
                {detail ? (
                  <Text color={theme.color.t4} dimColor wrap="truncate-end">
                    {`     › ${endTruncate(detail, Math.max(8, inner - 8))}`}
                  </Text>
                ) : null}
              </Box>
            );
          })}
          {hiddenAfter > 0 ? (
            <Text color={theme.color.t4} dimColor>{`  ↓ ${hiddenAfter} more`}</Text>
          ) : null}
        </>
      )}
      <Box marginTop={1}>
        <Text color={theme.color.t4} dimColor>{rosterFooterHint(info, mainSelected, selectedSnapshot, disclosureHints)}</Text>
      </Box>
      {info.mission ? <ChatInfoMissionBlock mission={info.mission} width={width} brandColor={brandColor} /> : null}
    </Box>
  );
}

// Footer hint reflects the runtime capability: only Codex/OpenCode
// (canViewFullTranscript) can take over the main chat with the real child
// transcript; Cursor/Droid keep the row selected with inline detail. Droid
// adds a kill hint when a running worker is selected.
function rosterFooterHint(
  info: ChatInfoSnapshot,
  mainSelected: boolean,
  selectedSnapshot: SubagentSnapshot | null,
  disclosureHints: string[],
): string {
  const parts = ["↑↓ focus"];
  if (mainSelected) {
    parts.push("↵ stay");
  } else if (info.capability.canViewFullTranscript) {
    parts.push("↵ open thread");
  }
  if (
    info.provider === "droid"
    && selectedSnapshot
    && selectedSnapshot.kind === "subagent"
    && selectedSnapshot.status === "running"
  ) {
    parts.push("^k kill");
  }
  parts.push(...disclosureHints);
  parts.push("esc → main");
  return parts.join(" · ");
}

// Section heading for the roster — matches the 2-line allowance built into
// `subagentPaneSelectableLineOffsets` (one blank-margin line + one title line)
// so the mouse-click line-math stays accurate.
function RosterSectionHead({ row }: { row: Extract<SubagentPaneRow, { kind: "section-header" }> }) {
  const color = row.section === "background" ? theme.color.tool : theme.color.t4;
  return (
    <Box marginTop={1}>
      <Text color={color} dimColor>
        {row.collapsible ? (row.collapsed ? "▸ " : "▾ ") : ""}{row.label.toLowerCase()} {row.activeCount}{row.clearedCount ? ` · ${row.clearedCount} hidden` : ""}
      </Text>
    </Box>
  );
}

const MISSION_STATE_LABEL: Record<string, string> = {
  awaiting_input: "awaiting input",
  initializing: "initializing",
  running: "running",
  paused: "paused",
  orchestrator_turn: "orchestrator turn",
  completed: "completed",
};

function missionFeatureGlyphColor(status: string): { glyph: string; color: string } {
  if (status === "completed") return { glyph: theme.agentStatusGlyph("ok"), color: theme.agentStatusColor("ok") };
  if (status === "in_progress") return { glyph: theme.rail, color: theme.color.violet };
  if (status === "cancelled") return { glyph: "✗", color: theme.color.t5 };
  return { glyph: "○", color: theme.color.t4 };
}

// Droid AGI Missions surface. Rendered BELOW the roster so it never shifts the
// roster's first-row offset (`subagentPaneTop`), keeping the mouse-click
// line-math intact. Mission events are full-state snapshots (see chatMission),
// so this just renders the latest derived state + ordered feature checklist.
const MISSION_FEATURE_CAP = 6;
function ChatInfoMissionBlock({ mission, width, brandColor }: { mission: MissionSnapshot; width: number; brandColor: string }) {
  const inner = Math.max(10, width - 4);
  const features = orderMissionFeatures(mission.features);
  const counts = missionFeatureCounts(mission.features);
  const stateLabel = mission.state ? (MISSION_STATE_LABEL[mission.state] ?? mission.state) : null;
  const visible = features.slice(0, MISSION_FEATURE_CAP);
  const hiddenAfter = features.length - visible.length;
  const hint = counts.total
    ? `${counts.completed}/${counts.total}${counts.inProgress ? ` · ${counts.inProgress} active` : ""}`
    : (stateLabel ?? "");
  return (
    <Box flexDirection="column">
      <ChatInfoSectionHead title="MISSION" hint={hint} color={brandColor} width={width} />
      {stateLabel ? <Text color={theme.color.t4} dimColor>{` state · ${stateLabel}`}</Text> : null}
      {features.length === 0 ? (
        <Text color={theme.color.t4} dimColor>{" no features yet"}</Text>
      ) : (
        visible.map((feature) => {
          const { glyph, color } = missionFeatureGlyphColor(feature.status);
          return (
            <Box key={feature.id} flexDirection="row">
              <Text color={color}>{` ${glyph}`}</Text>
              <Text color={feature.status === "completed" ? theme.color.t4 : theme.color.t2} wrap="truncate-end">
                {` ${endTruncate(feature.description, Math.max(8, inner - 4))}`}
              </Text>
            </Box>
          );
        })
      )}
      {hiddenAfter > 0 ? <Text color={theme.color.t4} dimColor>{`  ↓ ${hiddenAfter} more`}</Text> : null}
    </Box>
  );
}

// Desktop ChatTasksPanel parity: latest todo_update snapshot. Rendered BELOW
// the roster (like Mission) so the roster's click line-math stays intact.
const TASKS_VISIBLE_CAP = 6;

function scheduleStatusColor(status: ChatScheduledWorkSnapshot["status"]): string {
  if (status === "running" || status === "fired") return theme.color.running;
  if (status === "failed" || status === "missed") return theme.color.error;
  if (status === "completed") return theme.color.done;
  // Paused reads as dormant, not armed — dimmest text so it never looks like a
  // live "scheduled" row (which stays info-blue).
  if (status === "paused") return theme.color.t5;
  if (status === "cancelled" || status === "stopped") return theme.color.t4;
  return theme.color.info;
}

function scheduleStatusGlyph(status: ChatScheduledWorkSnapshot["status"]): string {
  if (status === "running" || status === "fired") return "●";
  if (status === "failed" || status === "missed") return "×";
  if (status === "completed") return "✓";
  if (status === "paused") return "‖";
  if (status === "cancelled" || status === "stopped") return "○";
  return "◷";
}

function scheduleKindLabel(kind: ChatScheduledWorkSnapshot["kind"]): string {
  if (kind === "remote_trigger") return "trigger";
  if (kind === "background_task") return "background";
  return kind;
}

function scheduleLineDetail(item: ChatScheduledWorkSnapshot): string {
  return item.cron ?? item.reason ?? item.summary ?? item.prompt ?? "";
}

function nextWakeCountdown(value: string | null | undefined, nowMs: number): string | null {
  if (!value) return null;
  const timestampMs = Date.parse(value);
  if (!Number.isFinite(timestampMs) || timestampMs <= nowMs) return null;
  return compactRelativeDuration(Math.max(60_000, timestampMs - nowMs));
}

function ChatInfoScheduleBlock({ info, brandColor, width, viewState }: { info: ChatInfoSnapshot; brandColor: string; width: number; viewState: SubagentPaneViewState }) {
  const nextWake = nextWakeCountdown(info.nextWakeAt, Date.now());
  if (!info.scheduledWork.length && !nextWake) return null;
  const inner = Math.max(10, width - 4);
  const clearedIds = new Set(viewState.cleared?.schedule ?? []);
  const grouped = groupPaneSectionItems(info.scheduledWork, {
    isEarlier: isEarlierScheduleItem,
    isCleared: (item) => clearedIds.has(item.id),
    isPinned: () => false,
  });
  const capped = viewState.showAll?.schedule
    ? { visible: grouped.active, hiddenCount: 0 }
    : capPaneSectionItems(grouped.active, SCHEDULE_ACTIVE_CAP, (item) => item.status === "failed");
  const earlierExpanded = viewState.earlierExpanded?.schedule === true;
  const renderItem = (item: ChatScheduledWorkSnapshot, earlier: boolean) => {
    const detail = scheduleLineDetail(item);
    const label = `${scheduleKindLabel(item.kind)} · ${item.status}${item.late ? " · late" : ""}`;
    const titleBudget = Math.max(6, inner - label.length - 4);
    return (
      <Box key={item.id} flexDirection="column">
        <Text color={scheduleStatusColor(item.status)} dimColor={earlier} wrap="truncate-end">
          {scheduleStatusGlyph(item.status)} {endTruncate(item.title, titleBudget)} <Text color={theme.color.t4}>{label}</Text>
        </Text>
        {detail ? (
          <Text color={theme.color.t4} dimColor wrap="truncate-end">
            {"  "}{endTruncate(detail, inner - 2)}
          </Text>
        ) : null}
      </Box>
    );
  };
  return (
    <Box flexDirection="column">
      <ChatInfoSectionHead
        title="SCHEDULE"
        dimSuffix={info.scheduledWorkPaused ? "(paused)" : undefined}
        hint={`${grouped.active.length}`}
        color={brandColor}
        width={width}
      />
      {nextWake ? (
        <Text color={theme.color.t2} wrap="truncate-end">
          {` ⏰ next wake ${nextWake}`}
        </Text>
      ) : null}
      {capped.visible.map((item) => renderItem(item, false))}
      {capped.hiddenCount > 0 ? <Text color={theme.color.t4} dimColor>{`  + show all (${capped.hiddenCount})`}</Text> : null}
      {grouped.earlier.length > 0 || grouped.clearedCount > 0 ? (
        <Text color={theme.color.t4} dimColor>{`  ${earlierExpanded ? "▾" : "▸"} completed (${grouped.earlier.length})${grouped.clearedCount ? ` · ${grouped.clearedCount} hidden` : ""}`}</Text>
      ) : null}
      {earlierExpanded ? grouped.earlier.map((item) => renderItem(item, true)) : null}
      {earlierExpanded && grouped.clearedCount > 0 ? <Text color={theme.color.t4} dimColor>{`  restore (${grouped.clearedCount})`}</Text> : null}
    </Box>
  );
}

// Background command tasks — mirrors the desktop actions-pane Background
// section. Each row: `$ <smart label>  status` (ASCII, one line).
function ChatInfoBackgroundBlock({ info, brandColor, width, viewState }: { info: ChatInfoSnapshot; brandColor: string; width: number; viewState: SubagentPaneViewState }) {
  if (!info.backgroundWork.length) return null;
  const inner = Math.max(10, width - 4);
  const clearedIds = new Set(viewState.cleared?.background ?? []);
  const grouped = groupPaneSectionItems(info.backgroundWork, {
    isEarlier: isEarlierBackgroundItem,
    isCleared: (item) => clearedIds.has(item.id),
    isPinned: () => false,
  });
  const capped = viewState.showAll?.background
    ? { visible: grouped.active, hiddenCount: 0 }
    : capPaneSectionItems(grouped.active, BACKGROUND_ACTIVE_CAP, (item) => item.status === "failed");
  const earlierExpanded = viewState.earlierExpanded?.background === true;
  const renderItem = (item: ChatScheduledWorkSnapshot) => {
    const raw = (item.title || item.prompt || item.summary || "").trim();
    const label = backgroundCommandLabel(raw) || raw || "background command";
    const status = ` ${item.status}`;
    const labelBudget = Math.max(6, inner - status.length - 4);
    return (
      <Text key={item.id} color={scheduleStatusColor(item.status)} wrap="truncate-end">
        {"$ "}{endTruncate(label, labelBudget)} <Text color={theme.color.t4}>{item.status}</Text>
      </Text>
    );
  };
  return (
    <Box flexDirection="column">
      <ChatInfoSectionHead title="BACKGROUND" hint={`${grouped.active.length}`} color={brandColor} width={width} />
      {capped.visible.map(renderItem)}
      {capped.hiddenCount > 0 ? <Text color={theme.color.t4} dimColor>{`  + show all (${capped.hiddenCount})`}</Text> : null}
      {grouped.earlier.length > 0 || grouped.clearedCount > 0 ? <Text color={theme.color.t4} dimColor>{`  ${earlierExpanded ? "▾" : "▸"} completed (${grouped.earlier.length})`}</Text> : null}
      {earlierExpanded ? grouped.earlier.map(renderItem) : null}
    </Box>
  );
}

function ChatInfoTasksBlock({ info, brandColor, width }: { info: ChatInfoSnapshot; brandColor: string; width: number }) {
  if (!info.todos.length) return null;
  const inner = Math.max(10, width - 4);
  const done = info.todos.filter((todo) => todo.status === "completed").length;
  const visible = info.todos.slice(0, TASKS_VISIBLE_CAP);
  const hiddenAfter = info.todos.length - visible.length;
  return (
    <Box flexDirection="column">
      <ChatInfoSectionHead title="TASKS" hint={`${done}/${info.todos.length}`} color={brandColor} width={width} />
      {visible.map((todo, index) => {
        const status = todo.status === "completed" || todo.status === "failed" || todo.status === "in_progress"
          ? todo.status
          : "pending";
        return (
          <Text key={`${todo.id || "todo"}:${index}`} color={planStepColor(status as ChatInfoPlanStep["status"])} wrap="truncate-end">
            {planStepGlyph(status as ChatInfoPlanStep["status"])} {endTruncate(todo.description, inner - 2)}
          </Text>
        );
      })}
      {hiddenAfter > 0 ? <Text color={theme.color.t4} dimColor>{`  ↓ ${hiddenAfter} more`}</Text> : null}
    </Box>
  );
}

// Desktop ChatPrPane parity: the lane's PR rollup with a /pr handoff hint.
// Rendered BELOW the roster so the click line-math stays intact.
function ChatInfoPrBlock({ info, brandColor, width }: { info: ChatInfoSnapshot; brandColor: string; width: number }) {
  const pr = info.pr;
  if (!pr) return null;
  const stateColor = pr.state === "open"
    ? theme.color.running
    : pr.state === "merged"
      ? theme.color.violet
      : theme.color.t4;
  const checksColor = pr.checksTotal === 0
    ? theme.color.t4
    : pr.checksPassed === pr.checksTotal
      ? theme.color.running
      : theme.color.attention;
  return (
    <Box flexDirection="column">
      <ChatInfoSectionHead title="PR" hint={`#${pr.number}`} color={brandColor} width={width} />
      <Box flexDirection="row">
        <Text color={stateColor} bold>{` ${pr.state}`}</Text>
        {pr.checksTotal > 0 ? (
          <>
            <Text color={theme.color.t4}>{" · checks "}</Text>
            <Text color={checksColor}>{`${pr.checksPassed}/${pr.checksTotal}`}</Text>
          </>
        ) : null}
      </Box>
      <Text color={theme.color.t4} dimColor>{" /pr for details · /pr checks · /pr review"}</Text>
    </Box>
  );
}

function ChatInfoPane({
  info,
  selectedIndex,
  width,
  subagentPaneViewState,
}: {
  info: ChatInfoSnapshot;
  selectedIndex: number;
  width: number;
  subagentPaneViewState: SubagentPaneViewState;
}) {
  const brand = theme.provider(info.provider);
  // With the resume row visible the selection space shifts by one (0 = resume,
  // 1 = main, …); the roster receives the un-shifted index (-1 ⇒ resume row
  // holds the selection, nothing in the roster highlights).
  const resumeOffset = chatInfoSelectionOffset(info);
  return (
    <Box flexDirection="column">
      {info.resumableTerminal ? <ChatInfoResumeRow selected={selectedIndex === 0} /> : null}
      <ChatInfoHeader info={info} width={width} />
      <ChatInfoPlanBlock info={info} brandColor={brand.color} width={width} />
      <ChatInfoGoalBlock info={info} brandColor={brand.color} width={width} />
      <ChatInfoRoster info={info} selectedIndex={selectedIndex - resumeOffset} brandColor={brand.color} width={width} viewState={subagentPaneViewState} />
      <ChatInfoTasksBlock info={info} brandColor={brand.color} width={width} />
      <ChatInfoBackgroundBlock info={info} brandColor={brand.color} width={width} viewState={subagentPaneViewState} />
      <ChatInfoScheduleBlock info={info} brandColor={brand.color} width={width} viewState={subagentPaneViewState} />
      <ChatInfoPrBlock info={info} brandColor={brand.color} width={width} />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Other content modes (status, list, details, diff, form,
// help, empty) — kept compact, refreshed to use theme tokens.
// ---------------------------------------------------------------------------

type HelpPaneContent = Extract<RightPaneContent, { kind: "help" }>;

function HelpPane({ content, width }: { content: HelpPaneContent; width: number }) {
  const groups = content.groupedRows ?? [];
  const query = content.filterQuery ?? "";
  const selectedIndex = content.selectedIndex ?? 0;
  const inner = Math.max(12, width - 4);

  // Flatten to navigation order so the single selected index maps to one row,
  // interleaving heading markers so the renderer can print each category title.
  type FlatItem =
    | { kind: "heading"; category: string }
    | { kind: "row"; row: HelpRow; flatIndex: number };
  const flat: FlatItem[] = [];
  let flatIndex = 0;
  for (const group of groups) {
    flat.push({ kind: "heading", category: group.category });
    for (const row of group.rows) {
      flat.push({ kind: "row", row, flatIndex });
      flatIndex += 1;
    }
  }
  const totalRows = flatIndex;

  // Scroll the flat list to keep the selection visible. Reserve a few lines for
  // the filter line, spacer, footer hint, and overflow markers.
  const bodyMax = Math.max(4, Math.min(DETAILS_BODY_MAX_LINES, width > 0 ? 24 : 4));
  const selectedFlatPos = flat.findIndex((item) => item.kind === "row" && item.flatIndex === selectedIndex);
  let windowStart = 0;
  if (flat.length > bodyMax) {
    windowStart = selectedFlatPos < 0 ? 0 : Math.max(0, Math.min(selectedFlatPos - 2, flat.length - bodyMax));
  }
  const windowEnd = Math.min(flat.length, windowStart + bodyMax);
  const visible = flat.slice(windowStart, windowEnd);
  const hasAbove = windowStart > 0;
  const hasBelow = windowEnd < flat.length;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.color.t4}>{"› "}</Text>
        {query ? (
          <Text color={theme.color.t1}>{query}</Text>
        ) : (
          <Text color={theme.color.t4} dimColor>Filter commands…</Text>
        )}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {hasAbove ? <Text color={theme.color.t4} dimColor>↑ more</Text> : null}
        {totalRows === 0 ? (
          <Text color={theme.color.t3}>{query ? `No commands match “${query}”.` : "No commands."}</Text>
        ) : (
          visible.map((item, idx) => {
            if (item.kind === "heading") {
              return (
                <Box key={`h-${item.category}`} marginTop={windowStart + idx === 0 ? 0 : 1}>
                  <Text color={theme.color.violet} bold>{item.category.toUpperCase()}</Text>
                </Box>
              );
            }
            const selected = item.flatIndex === selectedIndex;
            const nameWidth = item.row.name.length;
            const descRoom = Math.max(4, inner - nameWidth - 2 - (item.row.keybind ? item.row.keybind.length + 2 : 0));
            return (
              <Box key={`r-${item.row.name}`} flexDirection="row" justifyContent="space-between">
                <Box flexDirection="row">
                  <Text color={selected ? theme.color.violet : theme.color.t5}>{selected ? theme.rail : " "}</Text>
                  <Text color={selected ? theme.color.violet : theme.color.t2} bold={selected}>{` ${item.row.name}`}</Text>
                  <Text color={theme.color.t3} dimColor wrap="truncate-end">{`  ${endTruncate(item.row.description, descRoom)}`}</Text>
                </Box>
                {item.row.keybind ? <Text color={theme.color.violet}>{item.row.keybind}</Text> : null}
              </Box>
            );
          })
        )}
        {hasBelow ? <Text color={theme.color.t4} dimColor>↓ more</Text> : null}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.color.t4} dimColor>↑↓ move · ↵ run · esc close</Text>
      </Box>
    </Box>
  );
}

function detailsBodyLines(body: string, scrollOffsetRows = 0): string[] {
  const lines = body.split(/\r?\n/);
  const start = Math.max(0, Math.min(Math.floor(scrollOffsetRows), Math.max(0, lines.length - DETAILS_BODY_MAX_LINES)));
  const window = lines.slice(start, start + DETAILS_BODY_MAX_LINES);
  if (start > 0) window.unshift(`↑ ${start} earlier`);
  const remaining = Math.max(0, lines.length - (start + DETAILS_BODY_MAX_LINES));
  if (remaining > 0) window.push(`↓ ${remaining} more line${remaining === 1 ? "" : "s"}`);
  return window;
}

function isDetailsSectionLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 36) return false;
  if (/^[A-Z][A-Z0-9 /_.-]+$/.test(trimmed)) return true;
  return /^[A-Z][A-Za-z0-9 /_.-]+:$/.test(trimmed);
}

function detailsKeyValue(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  const match = trimmed.match(/^([^:]{2,22}):\s+(.+)$/);
  if (!match) return null;
  const key = match[1]?.trim() ?? "";
  const value = match[2]?.trim() ?? "";
  if (!key || !value || key.includes("{") || key.includes("[")) return null;
  return { key, value };
}

function DetailsPane({ title, body, width, scrollOffsetRows = 0 }: { title: string; body: string; width: number; scrollOffsetRows?: number }) {
  const bodyWidth = Math.max(12, width - 4);
  const lines = detailsBodyLines(body, scrollOffsetRows);
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => {
        const trimmed = line.trim();
        if (!trimmed) return <Text key={index}> </Text>;
        if (isDetailsSectionLine(trimmed)) {
          return (
            <Box key={index} flexDirection="row" marginTop={index === 0 ? 0 : 1}>
              <Text bold color={theme.color.violet}>{endTruncate(trimmed.replace(/:$/, ""), Math.max(8, bodyWidth - 2))}</Text>
            </Box>
          );
        }
        const kv = detailsKeyValue(trimmed);
        if (kv) {
          return (
            <Box key={index} flexDirection="row">
              <Text color={theme.color.t4}>{endTruncate(kv.key, 13).padEnd(13)} </Text>
              <Text color={theme.color.t1} wrap="truncate-end">{endTruncate(kv.value, Math.max(8, bodyWidth - 14))}</Text>
            </Box>
          );
        }
        if (/^[-*•]\s+/.test(trimmed)) {
          return (
            <Text key={index} color={theme.color.t2} wrap="truncate-end">
              <Text color={theme.color.violet}>• </Text>
              {endTruncate(trimmed.replace(/^[-*•]\s+/, ""), Math.max(8, bodyWidth - 2))}
            </Text>
          );
        }
        if (/^\d+[.)]\s+/.test(trimmed)) {
          const prefix = trimmed.match(/^\d+[.)]/)?.[0] ?? "1.";
          return (
            <Text key={index} color={theme.color.t2} wrap="truncate-end">
              <Text color={theme.color.violet}>{prefix} </Text>
              {endTruncate(trimmed.replace(/^\d+[.)]\s+/, ""), Math.max(8, bodyWidth - prefix.length - 1))}
            </Text>
          );
        }
        if (/^[{}[\],"]/.test(trimmed) || trimmed.includes('":')) {
          return (
            <Text key={index} color={theme.color.t4} dimColor wrap="truncate-end">
              {endTruncate(trimmed, bodyWidth)}
            </Text>
          );
        }
        const tone = title.toLowerCase().includes("error") || /^error\b/i.test(trimmed)
          ? theme.color.error
          : theme.color.t2;
        return (
          <Text key={index} color={tone} wrap="truncate-end">
            {endTruncate(trimmed, bodyWidth)}
          </Text>
        );
      })}
    </Box>
  );
}

type DiffRenderLine = {
  key: string;
  text: string;
  color: string;
  dim: boolean;
  bold: boolean;
  // Set on per-file header rows so the renderer can colorize the +/− counts
  // (green adds / red dels) to match the hunk body and ChatView's file rows.
  header?: { path: string; additions: number; deletions: number };
};

// Flatten a diff into colorized, fully-scrollable lines: a bold per-file header
// (path + add/del counts) followed by each hunk line tinted by kind. Shared by
// the renderer and the scroll-row counter so they never drift.
function buildDiffRenderLines(
  files: Array<{ path: string; additions?: number; deletions?: number; body?: string }>,
): DiffRenderLine[] {
  const out: DiffRenderLine[] = [];
  for (const file of files) {
    const additions = file.additions ?? 0;
    const deletions = file.deletions ?? 0;
    out.push({
      key: `${file.path}:head`,
      text: `▸ ${file.path}  +${additions} −${deletions}`,
      color: theme.color.t1,
      dim: false,
      bold: true,
      header: { path: file.path, additions, deletions },
    });
    if (!file.body) continue;
    const lines = file.body.split(/\r?\n/);
    const shown = lines.slice(0, DIFF_FILE_BODY_MAX);
    shown.forEach((line, index) => {
      const tone = diffLineTone(diffLineKind(line));
      out.push({ key: `${file.path}:${index}`, text: line, color: tone.color, dim: tone.dim, bold: tone.bold });
    });
    const hidden = lines.length - shown.length;
    if (hidden > 0) {
      out.push({
        key: `${file.path}:truncated`,
        text: `  … ${hidden} more line${hidden === 1 ? "" : "s"} in this file`,
        color: theme.color.t4,
        dim: true,
        bold: false,
      });
    }
  }
  return out;
}

function externalSessionAge(session: { updatedAt: number | null; createdAt: number | null }): string {
  const timestamp = session.updatedAt ?? session.createdAt;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return "recently";
  return formatRelativePastTime(new Date(timestamp).toISOString());
}

function ExternalSessionBrowserPane({
  content,
  width,
}: {
  content: Extract<RightPaneContent, { kind: "external-session-browser" }>;
  width: number;
}) {
  const inner = Math.max(12, width - 4);
  const visible = visibleExternalSessions(content.sessions, content.providerFilter, content.query);
  const selectedIndex = visible.length
    ? Math.min(Math.max(0, content.selectedIndex), visible.length - 1)
    : 0;
  const selectedSession = visible[selectedIndex] ?? null;
  const actionRows = selectedSession ? externalSessionBrowserActions(selectedSession) : [];
  const selectedActionIndex = actionRows.length
    ? Math.min(Math.max(0, content.actionIndex), actionRows.length - 1)
    : 0;
  const windowStart = Math.min(
    Math.max(0, selectedIndex - Math.floor(EXTERNAL_SESSION_ROW_WINDOW / 2)),
    Math.max(0, visible.length - EXTERNAL_SESSION_ROW_WINDOW),
  );
  const rowWindow = visible.slice(windowStart, windowStart + EXTERNAL_SESSION_ROW_WINDOW);
  const providerFilter = externalSessionProviderLabel(content.providerFilter);
  const queryText = content.query.trim();

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.color.t2} bold wrap="truncate-end">
        {endTruncate(`Import into ${content.laneLabel}`, inner)}
      </Text>
      <Text color={theme.color.t4}>
        <Text color={theme.color.t5}>filter </Text>
        <Text color={theme.color.violet}>{providerFilter}</Text>
        <Text color={theme.color.t5}>{` · ${visible.length}/${content.sessions.length}`}</Text>
        {queryText ? (
          <Text color={theme.color.t5}>{` · "${endTruncate(queryText, Math.max(4, inner - 18))}"`}</Text>
        ) : null}
      </Text>

      {content.error ? (
        <Box marginTop={1}>
          <Text color={theme.color.error} wrap="truncate-end">{endTruncate(content.error, inner)}</Text>
        </Box>
      ) : null}
      {content.importError ? (
        <Box marginTop={1}>
          <Text color={theme.color.error} wrap="truncate-end">{endTruncate(content.importError, inner)}</Text>
        </Box>
      ) : null}
      {content.loading ? (
        <Box marginTop={1}>
          <Text color={theme.color.t3}>Scanning sessions...</Text>
        </Box>
      ) : null}

      {!content.loading && !rowWindow.length ? (
        <Box marginTop={1}>
          <Text color={theme.color.t4} dimColor>
            {content.sessions.length ? "No sessions match this filter." : "No external sessions found."}
          </Text>
        </Box>
      ) : null}

      {rowWindow.length ? (
        <Box flexDirection="column" marginTop={1}>
          {windowStart > 0 ? <Text color={theme.color.t5} dimColor>{`  ${windowStart} earlier`}</Text> : null}
          {rowWindow.map((session, offset) => {
            const absoluteIndex = windowStart + offset;
            const selected = absoluteIndex === selectedIndex;
            const brand = theme.provider(session.provider);
            const title = session.title?.trim() || session.preview?.trim() || session.id;
            const cwd = shortenCwd(session.cwd, 4);
            const messageCount = typeof session.messageCount === "number" && Number.isFinite(session.messageCount)
              ? `${compactNumber(session.messageCount)} prompt${session.messageCount === 1 ? "" : "s"}`
              : "prompts ?";
            const badges = [
              session.alreadyImported ? "imported" : null,
              session.possiblyActive ? "may be open elsewhere" : null,
            ].filter((value): value is string => Boolean(value));
            return (
              <Box key={`${session.provider}:${session.id}`} flexDirection="column" marginBottom={1}>
                <Text>
                  <Text color={selected ? theme.color.violet : theme.color.t5}>{selected ? theme.rail : " "}</Text>
                  <Text color={brand.color}>{`${brand.glyph} ${externalSessionProviderLabel(session.provider)} `}</Text>
                  <Text color={selected ? theme.color.t1 : theme.color.t2} bold={selected} wrap="truncate-end">
                    {endTruncate(title, Math.max(8, inner - 15))}
                  </Text>
                </Text>
                <Text color={selected ? theme.color.t3 : theme.color.t4} dimColor={!selected} wrap="truncate-end">
                  {`  ${externalSessionAge(session)} · ${messageCount} · ${endTruncate(cwd, Math.max(8, inner - 20))}`}
                </Text>
                {badges.length ? (
                  <Text color={session.possiblyActive ? theme.color.warning : theme.color.t5} dimColor={!session.possiblyActive} wrap="truncate-end">
                    {`  ${endTruncate(badges.join(" · "), Math.max(8, inner - 2))}`}
                  </Text>
                ) : null}
                {selected && session.preview?.trim() ? (
                  <Text color={theme.color.t3} wrap="truncate-end">
                    {`  ${endTruncate(session.preview.trim(), Math.max(8, inner - 2))}`}
                  </Text>
                ) : null}
                {selected && session.alreadyImported && session.importedSessionRef ? (
                  <Text color={theme.color.violet}>  O Open existing ADE session</Text>
                ) : null}
              </Box>
            );
          })}
          {windowStart + rowWindow.length < visible.length ? (
            <Text color={theme.color.t5} dimColor>{`  ${visible.length - windowStart - rowWindow.length} more`}</Text>
          ) : null}
        </Box>
      ) : null}

      {selectedSession ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.color.t5}>Actions</Text>
          {actionRows.length ? actionRows.map((action, index) => {
            const focused = index === selectedActionIndex;
            const importing = content.importingKey === externalSessionActionKey(selectedSession, action);
            const color = !action.enabled
              ? theme.color.t5
              : focused
                ? theme.color.violet
                : action.hero
                  ? theme.color.t1
                  : theme.color.t3;
            const supplemental = ("hint" in action ? action.hint : null)
              ?? ("foreignCwd" in action && action.foreignCwd ? `Runs in ${shortenCwd(action.foreignCwd, 4)}.` : null);
            const hint = ("disabledReason" in action ? action.disabledReason : null)
              ?? [action.description, supplemental].filter(Boolean).join(" ");
            return (
              <Box key={action.kind} flexDirection="column">
                <Text color={color} dimColor={!action.enabled}>
                  <Text color={focused ? theme.color.violet : theme.color.t5}>{focused ? theme.rail : " "}</Text>
                  {importing ? "◐ " : focused ? "↵ " : "  "}
                  <Text bold={focused || action.hero}>{endTruncate(action.label, Math.max(8, inner - 4))}</Text>
                </Text>
                {hint ? (
                  <Text color={theme.color.t5} dimColor wrap="truncate-end">
                    {`   ${endTruncate(hint, Math.max(8, inner - 3))}`}
                  </Text>
                ) : null}
              </Box>
            );
          }) : (
            <Text color={theme.color.t4} dimColor>No import actions available.</Text>
          )}
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text color={theme.color.t5} dimColor wrap="truncate-end">
          {endTruncate("up/down rows · left/right actions · enter run action · O open existing · R refresh · P provider · type search", inner)}
        </Text>
      </Box>
    </Box>
  );
}

export function rightPaneScrollableRowCount(content: RightPaneContent): number {
  switch (content.kind) {
    case "details":
      return content.body.split(/\r?\n/).length;
    case "context-usage":
      return (content.usage?.categories.length ?? 0) + 4;
    case "list":
      return content.rows.length;
    case "diff":
      return buildDiffRenderLines(content.files).length;
    case "usage":
      // Mirror UsagePane's rendered rows so the bottom stays reachable when a
      // provider exposes multiple quota windows: each QuotaWindowRow is label(1)
      // + bar(1) + marginBottom(1) = 3 rows, plus up to ~4 rows for the session
      // block (marginTop + "Session" + body) and any loading/error line.
      return (content.quotaWindows?.length ?? 0) * 3 + 4;
    case "status":
      // Flat key/value list — scrolls by row count.
      return content.rows.length;
    case "empty":
    case "form":
    case "chat-info":
    case "model-picker":
    case "external-session-browser":
    case "help":
    case "lane-details":
      // These panes have their own internal navigation (help uses selectedIndex,
      // lane-details uses selectedActionIndex) or no scrollable body.
      return 0;
    default: {
      const _exhaustive: never = content;
      void _exhaustive;
      return 0;
    }
  }
}

type FormPaneContent = Extract<RightPaneContent, { kind: "form" }>;
type LaneDeleteFormContent = FormPaneContent & { command: "lane-delete" };
type FeedbackFormContent = FormPaneContent & { command: "feedback" };

// Rebuild the framework-free FeedbackFormState (from feedbackForm.ts) out of the
// FeedbackContextMeta carried on the form content. app.tsx seeds + edits that
// meta; this keeps the render in lock-step with the reducer/serializer that
// validation + submission go through.
export function feedbackStateFromContent(content: FeedbackFormContent): FeedbackFormState {
  const meta = content.feedback ?? {};
  const rawType = (meta.type ?? "bug") as FeedbackType;
  const type = FEEDBACK_TYPES.includes(rawType) ? rawType : "bug";
  return {
    type,
    text: meta.body ?? "",
    showContext: meta.showContext !== false,
    context: {
      provider: meta.provider ?? null,
      model: meta.model ?? null,
      lane: meta.lane ?? null,
      lastError: meta.lastError ?? null,
    },
  };
}

function FeedbackTypeSelector({ type }: { type: FeedbackType }) {
  // ‹ bug · idea · praise › — violet is the only selection accent; the rest is
  // neutral idle chrome.
  return (
    <Text>
      <Text color={theme.color.t4}>‹ </Text>
      {FEEDBACK_TYPES.map((option, index) => (
        <React.Fragment key={option}>
          {index > 0 ? <Text color={theme.color.t5}> · </Text> : null}
          <Text
            color={option === type ? theme.color.violet : theme.color.t4}
            bold={option === type}
          >
            {option === type ? `[${option}]` : option}
          </Text>
        </React.Fragment>
      ))}
      <Text color={theme.color.t4}> ›</Text>
    </Text>
  );
}

function FeedbackFormPane({
  content,
  focused,
  width,
}: {
  content: FeedbackFormContent;
  focused: boolean;
  width: number;
}) {
  const hoveredId = useHoveredHitId();
  const tick = useShimmerTick();
  const inner = Math.max(12, width - 4);
  const state = feedbackStateFromContent(content);
  const submitted = content.feedback?.feedback === "submitted";
  const canSubmit = feedbackFormCanSubmit(state);

  if (submitted) {
    // The single sanctioned green (#22C55E === theme.color.done) for a success
    // ✓, faded in via the shared spin tick (no bare setInterval). Dim for the
    // first ~200ms so it reads as a gentle confirm rather than a flash.
    const settled = (tick ?? 0) % 1000 >= 2;
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color={theme.color.done} bold dimColor={!settled}>
          ✓ Feedback sent
        </Text>
        <Text color={theme.color.t4} dimColor>Closing…</Text>
      </Box>
    );
  }

  const bodyLines = state.text.length ? state.text.split("\n") : [];
  const bodyHover = hoveredId === "right:feedback:body";
  const footer = state.showContext ? serializeContextFooter(state.context) : "";

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={focused ? theme.color.violet : theme.color.t5}>{focused ? theme.rail : " "}</Text>
        <Text color={theme.color.t3}> Type  </Text>
        <FeedbackTypeSelector type={state.type} />
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text color={bodyHover ? theme.color.violet : theme.color.t3}>{bodyHover ? theme.rail : " "} Body</Text>
        <Box flexDirection="column">
          {bodyLines.length ? (
            bodyLines.map((line, index) => (
              <Text key={index} color={theme.color.t1} wrap="truncate-end">
                {endTruncate(line.length ? line : " ", inner)}
                {index === bodyLines.length - 1 ? <Text color={theme.color.violet}>▏</Text> : null}
              </Text>
            ))
          ) : (
            <Text color={theme.color.t4} dimColor>
              Describe it…<Text color={theme.color.violet}>▏</Text>
            </Text>
          )}
        </Box>
      </Box>

      {state.showContext && footer ? (
        <Box flexDirection="column" marginTop={1}>
          {footer.split("\n").map((line, index) => (
            <Text
              key={index}
              color={index === 0 ? theme.color.t3 : theme.color.t4}
              dimColor={index !== 0}
              wrap="truncate-end"
            >
              {endTruncate(line, inner)}
            </Text>
          ))}
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text color={theme.color.t4} dimColor>
            --- Context --- (hidden · Ctrl+T)
          </Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="row" justifyContent="space-between">
        <Text color={canSubmit ? theme.color.t3 : theme.color.t4} dimColor={!canSubmit}>
          ⏎ newline · Ctrl+S send · esc cancel
        </Text>
        <Text color={hoveredId === "right:feedback:send" && canSubmit ? theme.color.violet : theme.color.t5}>
          {canSubmit ? "[send]" : ""}
        </Text>
      </Box>
    </Box>
  );
}

function LaneDeleteFormPane({
  content,
  formValues,
  activeFormField,
  width,
}: {
  content: LaneDeleteFormContent;
  formValues: Record<string, string>;
  activeFormField: number;
  width: number;
}) {
  const hoveredId = useHoveredHitId();
  const inner = Math.max(12, width - 4);
  const meta = content.laneDelete;
  const scope = formValues.scope === "local_branch" || formValues.scope === "remote_branch"
    ? formValues.scope
    : "worktree";
  const force = formValues.force === "yes";
  const confirm = formValues.confirm ?? "";
  const remoteName = formValues.remoteName?.trim() || "origin";
  const confirmMatch = Boolean(meta?.laneName) && confirm === meta?.laneName;
  const fields = content.fields;
  let scopeHint = "remove worktree only; keep branches";
  if (scope === "local_branch") scopeHint = "also delete the local branch";
  else if (scope === "remote_branch") scopeHint = `also delete ${remoteName}/${meta?.branchRef ?? "branch"}`;
  const activeName = fields[activeFormField]?.name ?? fields[0]?.name ?? "scope";
  const active = (name: string) => activeName === name || hoveredId === `right:form:${name}`;
  const scopeOption = (value: string, label: string) => (
    <Text color={scope === value ? theme.color.error : theme.color.t3} bold={scope === value}>
      {scope === value ? `[${label}]` : ` ${label} `}
    </Text>
  );

  return (
    <Box flexDirection="column">
      <Text color={theme.color.error} bold>Destructive action</Text>
      <Text color={theme.color.t2} wrap="truncate-end">
        {meta ? endTruncate(meta.laneName, inner) : "No active lane"}
      </Text>
      {meta?.branchRef ? (
        <Text color={theme.color.t4} wrap="truncate-end">⎇ {tailTruncate(meta.branchRef, Math.max(8, inner - 2))}</Text>
      ) : null}
      {meta?.dirty ? (
        <Box marginTop={1}>
          <Text color={theme.color.attention}>● uncommitted changes detected</Text>
        </Box>
      ) : null}

      <Box flexDirection="column" marginTop={1}>
        <Text color={active("scope") ? theme.color.violet : theme.color.t3} bold={active("scope")}>
          {active("scope") ? theme.rail : " "} Scope
        </Text>
        <Text>
          {"  "}
          {scopeOption("worktree", "worktree")}
          <Text> </Text>
          {scopeOption("local_branch", "local")}
          <Text> </Text>
          {scopeOption("remote_branch", "remote")}
        </Text>
        <Text color={theme.color.t4} dimColor>
          {"  "}{scopeHint}
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text
          color={active("remoteName") ? theme.color.violet : scope === "remote_branch" ? theme.color.t3 : theme.color.t4}
          bold={active("remoteName")}
          dimColor={scope !== "remote_branch" && !active("remoteName")}
        >
          {active("remoteName") ? theme.rail : " "} Remote name
        </Text>
        <Text color={scope === "remote_branch" ? theme.color.t1 : theme.color.t4} dimColor={scope !== "remote_branch"}>
          {"  "}{scope === "remote_branch" ? endTruncate(remoteName, inner - 2) : "used only for remote branch"}
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text color={active("force") ? theme.color.violet : theme.color.t3} bold={active("force")}>
          {active("force") ? theme.rail : " "} Force delete
        </Text>
        <Text color={force ? theme.color.error : theme.color.t4}>
          {"  "}{force ? "[x]" : "[ ]"} skip safety checks
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text color={active("confirm") ? theme.color.violet : theme.color.t3} bold={active("confirm")}>
          {active("confirm") ? theme.rail : " "} Type lane name
        </Text>
        <Text color={confirmMatch ? theme.color.error : theme.color.t1} wrap="truncate-end">
          {"  "}{endTruncate(confirm || "required before delete", inner - 2)}
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text color={confirmMatch ? theme.color.error : theme.color.t4} dimColor={!confirmMatch}>
          {confirmMatch ? "enter deletes this lane" : "↑↓ rows · ←→ scope · space force · esc cancel"}
        </Text>
      </Box>
    </Box>
  );
}

type NewLaneFormContent = FormPaneContent & { command: "new-lane" };

/**
 * Desktop CreateLaneDialog parity for /new lane: name + color swatches, a
 * vertical "Start from" option list (radio style — never wraps in a narrow
 * pane), mode-specific inputs with a branch typeahead, and an explicit create
 * button. Text fields render through the
 * shared prompt input like every other form. Row geometry must stay in sync
 * with newLaneFormFieldRowOffsets (the mouse hit-target source of truth).
 */
function NewLaneFormPane({
  content,
  formValues,
  activeFormField,
  width,
}: {
  content: NewLaneFormContent;
  formValues: Record<string, string>;
  activeFormField: number;
  width: number;
}) {
  const hoveredId = useHoveredHitId();
  const inner = Math.max(12, width - 4);
  const fields = content.fields;
  const start = normalizeNewLaneStart(formValues.start);
  const branchSource = normalizeNewLaneBranchSource(formValues.branchSource);
  const activeName = fields[activeFormField]?.name ?? fields[0]?.name ?? "name";
  const active = (name: string) => activeName === name || hoveredId === `right:form:${name}`;
  const typeahead = newLaneTypeaheadField(fields);

  const labelRow = (name: string, label: string, required?: boolean) => (
    <Text color={active(name) ? theme.color.violet : theme.color.t3} bold={active(name)}>
      {active(name) ? theme.rail : " "} {label}{required ? " *" : ""}
    </Text>
  );

  // Fixed-height match list under the typeahead field (blank rows reserved so
  // the pane's row geometry never shifts while typing). ↹ completes the top match.
  const typeaheadRows = (name: string) => {
    const matches = filterNewLaneBranchMatches({
      branches: content.branches,
      query: formValues[name]?.trim() ?? "",
      remote: name === "baseBranch" ? true : branchSource === "remote",
      limit: NEW_LANE_TYPEAHEAD_ROWS,
    });
    return Array.from({ length: NEW_LANE_TYPEAHEAD_ROWS }, (_, index) => (
      <Text key={`${name}:match:${index}`} color={theme.color.t4} dimColor wrap="truncate-end">
        {matches[index] ? `  ${index === 0 ? "↹ " : "  "}${endTruncate(matches[index]!, inner - 4)}` : " "}
      </Text>
    ));
  };

  const renderField = (field: NewLaneFormContent["fields"][number]) => {
    switch (field.name) {
      case "name":
      case "parent":
      case "branch":
      case "baseBranch":
      case "linearIssue":
      case "templateId": {
        const value = formValues[field.name]?.trim() ?? "";
        return (
          <Box key={field.name} flexDirection="column" marginTop={1}>
            {labelRow(field.name, field.label, field.required)}
            <Text color={value ? theme.color.t1 : theme.color.t4} dimColor={!value} wrap="truncate-end">
              {"  "}{endTruncate(value || field.placeholder || "", inner - 2)}
            </Text>
            {field.name === typeahead ? typeaheadRows(field.name) : null}
          </Box>
        );
      }
      case "color": {
        const colorIndex = newLaneColorIndex(formValues.color);
        const selected = NEW_LANE_COLOR_OPTIONS[colorIndex] ?? NEW_LANE_COLOR_OPTIONS[0]!;
        return (
          <Box key="color" flexDirection="column" marginTop={1}>
            {labelRow("color", "Color")}
            <Text wrap="truncate-end">
              {"  "}
              {NEW_LANE_COLOR_OPTIONS.map((option, index) => (
                <Text
                  key={option.name}
                  color={option.hex ?? theme.color.t3}
                  bold={index === colorIndex}
                  dimColor={!option.hex && index !== colorIndex}
                >
                  {index === colorIndex ? (option.hex ? "[●]" : "[○]") : option.hex ? "●" : "○"}
                </Text>
              ))}
              <Text color={selected.hex ?? theme.color.t3}> {selected.name}</Text>
            </Text>
          </Box>
        );
      }
      case "start":
        return (
          <Box key="start" flexDirection="column" marginTop={1}>
            {labelRow("start", "Start from")}
            {NEW_LANE_START_ORDER.map((mode) => {
              const chosen = start === mode;
              return (
                <Text key={mode} wrap="truncate-end">
                  {"  "}
                  <Text color={chosen ? theme.color.violet : theme.color.t4} bold={chosen} dimColor={!chosen}>
                    {chosen ? "●" : "○"} {NEW_LANE_START_LABEL[mode].padEnd(8)}
                  </Text>
                  <Text color={chosen ? theme.color.t3 : theme.color.t5} dimColor={!chosen}>
                    {endTruncate(NEW_LANE_START_HINT[mode], inner - 12)}
                  </Text>
                </Text>
              );
            })}
          </Box>
        );
      case "branchSource":
        return (
          <Box key="branchSource" flexDirection="column" marginTop={1}>
            {labelRow("branchSource", "Source")}
            <Text>
              {"  "}
              <Text color={branchSource === "remote" ? theme.color.violet : theme.color.t3} bold={branchSource === "remote"}>
                {branchSource === "remote" ? "[remote]" : " remote "}
              </Text>
              <Text> </Text>
              <Text color={branchSource === "local" ? theme.color.violet : theme.color.t3} bold={branchSource === "local"}>
                {branchSource === "local" ? "[local]" : " local "}
              </Text>
            </Text>
          </Box>
        );
      case "create": {
        const action = newLaneCreateAction({ values: formValues, fields });
        return (
          <Box key="create" marginTop={1}>
            <Text wrap="truncate-end">
              <Text color={active("create") ? theme.color.violet : theme.color.t3} bold={active("create")}>
                {active("create") ? theme.rail : " "}{" "}
              </Text>
              <Text
                color={action.enabled ? theme.color.violet : theme.color.t4}
                bold={action.enabled}
                dimColor={!action.enabled}
              >
                [ {endTruncate(action.label, inner - 8)} ]
              </Text>
              {action.reason ? (
                <Text color={theme.color.t5} dimColor>  {action.reason}</Text>
              ) : null}
            </Text>
          </Box>
        );
      }
      default:
        return null;
    }
  };

  return (
    <Box flexDirection="column">
      {fields.map((field) => renderField(field))}
      <Box marginTop={1}>
        <Text color={theme.color.t4} dimColor wrap="truncate-end">
          {activeName === typeahead
            ? "type to filter · ↹ top match · ↵ create"
            : "↑↓ rows · ←→ pick · ↵ create · esc"}
        </Text>
      </Box>
    </Box>
  );
}

function ContextUsagePane({
  content,
  width,
}: {
  content: Extract<RightPaneContent, { kind: "context-usage" }>;
  width: number;
}) {
  const inner = Math.max(12, width - 4);
  if (content.error) {
    return (
      <Box flexDirection="column">
        <Text color={theme.color.error}>Context unavailable</Text>
        <Text color={theme.color.t3} wrap="wrap">{endTruncate(content.error, inner * 3)}</Text>
      </Box>
    );
  }
  if (!content.usage) {
    return (
      <Box flexDirection="column">
        <Text color={theme.color.t3}>Context usage is not available yet.</Text>
      </Box>
    );
  }
  const usage = content.usage;
  const percent = Math.max(0, Math.min(100, usage.percentage));
  return (
    <Box flexDirection="column">
      <Text color={theme.color.t2}>{usage.model ? endTruncate(usage.model, inner) : "Model context"}</Text>
      <Box marginTop={1}>
        <TokenBar percent={percent} />
        <Text color={theme.color.t2}>{` ${compactNumber(usage.totalTokens)} / ${compactNumber(usage.maxTokens)} (${percent.toFixed(0)}%)`}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {usage.categories.map((category, index) => (
          <Text key={`${category.name}:${index}`} color={category.isDeferred ? theme.color.t4 : theme.color.t2}>
            {endTruncate(category.name.padEnd(18), 18)} {compactNumber(category.tokens).padStart(7)} {category.percentage.toFixed(category.percentage > 0 && category.percentage < 10 ? 1 : 0).padStart(5)}%
          </Text>
        ))}
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Pane title resolution
// ---------------------------------------------------------------------------

function paneTitle(content: RightPaneContent): { title: string; hint?: string; branch?: string } {
  switch (content.kind) {
    case "lane-details":
      return {
        title: content.lane.name,
        branch: content.lane.branchRef,
      };
    case "chat-info":
      return { title: `CHAT INFO · ${theme.provider(content.info.provider).label.toUpperCase()}` };
    case "model-picker":
      return { title: content.surface === "new-chat" ? "MODEL · NEW CHAT" : "MODEL" };
    case "external-session-browser":
      return { title: "IMPORT SESSION", hint: "r refresh · p provider" };
    case "help":
      return { title: "HELP" };
    case "status":
      return { title: "STATUS" };
    case "diff":
      return { title: content.title.toUpperCase() };
    case "list":
      return { title: content.title.toUpperCase() };
    case "details":
      return { title: content.title.toUpperCase() };
    case "context-usage":
      return { title: content.title.toUpperCase() };
    case "usage":
      return { title: (content.title ?? "USAGE").toUpperCase() };
    case "form":
      return { title: content.title.toUpperCase() };
    default:
      return { title: "PANE" };
  }
}

// ---------------------------------------------------------------------------
// Main right pane component
// ---------------------------------------------------------------------------

function RightPaneComponent({
  content,
  formValues = {},
  activeFormField = 0,
  selectedIndex = 0,
  focused = false,
  width = DEFAULT_PANE_WIDTH,
  modelPickerInputs,
  onModelPickerMeasureOrigin,
  scrollOffsetRows = 0,
  subagentPaneViewState = {},
}: {
  content: RightPaneContent;
  formValues?: Record<string, string>;
  activeFormField?: number;
  selectedIndex?: number;
  focused?: boolean;
  activeProvider?: AdeCodeProvider | null;
  width?: number;
  scrollOffsetRows?: number;
  subagentPaneViewState?: SubagentPaneViewState;
  /** Reports the model-picker's measured content origin for click hit-testing. */
  onModelPickerMeasureOrigin?: (origin: { x: number; y: number; width: number }) => void;
  /** Data passed in by app.tsx for the model-picker content kind. */
  modelPickerInputs?: {
    models: AgentChatModelInfo[];
    catalog?: AgentChatModelCatalog | null;
    favorites: string[];
    recents: string[];
    activeModelId: string | null;
    activeReasoningEffort?: string | null;
    aiStatus?: AiSettingsStatus | null;
    interfaceMode?: AdeCodeInterfaceMode;
  };
}) {
  const { title, hint, branch } = paneTitle(content);
  const paneWidth = Math.max(30, width);
  const hoveredId = useHoveredHitId();

  return (
    <Box
      width={paneWidth}
      flexDirection="column"
      borderStyle="single"
      borderColor={focused ? theme.color.borderFocused : theme.color.border}
      paddingX={1}
    >
      {content.kind === "lane-details" ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={focused ? theme.color.violet : theme.color.t1}>
            {endTruncate(title, Math.max(10, paneWidth - 4))}
          </Text>
          {branch ? (
            <Text color={theme.color.t3}>⎇ {tailTruncate(branch, Math.max(8, paneWidth - 4))}</Text>
          ) : null}
        </Box>
      ) : (
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold color={focused ? theme.color.violet : theme.color.t2}>
            {title}
          </Text>
          {hint ? <Text color={theme.color.t4} dimColor>{hint}</Text> : null}
        </Box>
      )}

      {content.kind === "empty" ? (
        <Text color={theme.color.t4} dimColor>Run /status, /diff, /model, or /help.</Text>
      ) : null}

      {content.kind === "help" ? <HelpPane content={content} width={paneWidth} /> : null}

      {content.kind === "status" ? (
        <Box flexDirection="column">
          {content.rows.map(([key, value]) => (
            <Text key={key}>
              <Text color={theme.color.t4}>{key.padEnd(10)}</Text> {value}
            </Text>
          ))}
        </Box>
      ) : null}

      {content.kind === "list" ? (
        <Box flexDirection="column">
          {(() => {
            // Clamp so a stale offset (after switching to a shorter same-kind
            // list) can't scroll past the content into a blank pane.
            const listStart = Math.max(0, Math.min(scrollOffsetRows, Math.max(0, content.rows.length - DETAILS_BODY_MAX_LINES)));
            const visibleRows = content.rows.slice(listStart, listStart + DETAILS_BODY_MAX_LINES);
            return content.rows.length ? visibleRows.map((row, visibleIndex) => {
              const index = listStart + visibleIndex;
              return (
                <Text
                  key={`${content.action?.ids[index] ?? row}:${index}`}
                  color={content.action && (index === selectedIndex || hoveredId === `right:list:${index}`) ? theme.color.violet : undefined}
                >
                  {content.action ? `${index === selectedIndex ? theme.rail : " "} ${row}` : row}
                </Text>
              );
            }) : <Text color={theme.color.t4} dimColor>{content.emptyText ?? "No data."}</Text>;
          })()}
          {content.rows.length > DETAILS_BODY_MAX_LINES ? (
            <Text color={theme.color.t4} dimColor>
              {scrollOffsetRows > 0 ? `↑ ${scrollOffsetRows} earlier · ` : ""}
              {Math.max(0, content.rows.length - scrollOffsetRows - DETAILS_BODY_MAX_LINES)} more
            </Text>
          ) : null}
          {content.action && content.rows.length ? (
            <Text color={theme.color.t4} dimColor>
              {content.action.kind === "copy-secret" ? "arrows move · enter/c copies" : "arrows move · enter opens"}
            </Text>
          ) : null}
        </Box>
      ) : null}

      {content.kind === "details" ? (
        <DetailsPane title={content.title} body={content.body} width={paneWidth} scrollOffsetRows={scrollOffsetRows} />
      ) : null}

      {content.kind === "context-usage" ? (
        <ContextUsagePane content={content} width={paneWidth} />
      ) : null}

      {content.kind === "external-session-browser" ? (
        <ExternalSessionBrowserPane content={content} width={paneWidth} />
      ) : null}

      {content.kind === "usage" ? (
        <UsagePane content={content} width={paneWidth} />
      ) : null}

      {content.kind === "diff" ? (
        <Box flexDirection="column">
          {content.files.length ? (() => {
            const diffLines = buildDiffRenderLines(content.files);
            const window = diffLines.slice(scrollOffsetRows, scrollOffsetRows + DETAILS_BODY_MAX_LINES);
            const maxLineWidth = Math.max(10, paneWidth - 4);
            return (
              <>
                {window.map((line) => {
                  if (line.header) {
                    // Counts stay neutral (t4) to match ChatView's file rows and
                    // keep green confined to actual diff-body add lines — a green
                    // count on the header row would read as idle chrome.
                    const counts = ` +${line.header.additions} −${line.header.deletions}`;
                    const pathRoom = Math.max(6, maxLineWidth - counts.length - 2);
                    return (
                      <Text key={line.key} wrap="truncate-end">
                        <Text color={theme.color.t1} bold>{`▸ ${endTruncate(line.header.path, pathRoom)}`}</Text>
                        <Text color={theme.color.t4}>{counts}</Text>
                      </Text>
                    );
                  }
                  return (
                    <Text key={line.key} color={line.color} dimColor={line.dim} bold={line.bold} wrap="truncate-end">
                      {endTruncate(line.text, maxLineWidth)}
                    </Text>
                  );
                })}
                {diffLines.length > DETAILS_BODY_MAX_LINES ? (
                  <Text color={theme.color.t4} dimColor>
                    {scrollOffsetRows > 0 ? `↑ ${scrollOffsetRows} earlier · ` : ""}
                    {Math.max(0, diffLines.length - scrollOffsetRows - DETAILS_BODY_MAX_LINES)} more · ↑↓ scroll
                  </Text>
                ) : null}
              </>
            );
          })() : <Text color={theme.color.t4} dimColor>No changes.</Text>}
        </Box>
      ) : null}

      {content.kind === "lane-details" ? (
        <LaneDetailsPane content={content} width={paneWidth} />
      ) : null}

      {content.kind === "chat-info" ? (
        <ChatInfoPane info={content.info} selectedIndex={selectedIndex} width={paneWidth} subagentPaneViewState={subagentPaneViewState} />
      ) : null}

      {content.kind === "model-picker" && modelPickerInputs ? (
        <ModelPickerPane
          state={buildModelPickerLayout({
            models: modelPickerInputs.models,
            catalog: modelPickerInputs.catalog,
            favorites: modelPickerInputs.favorites,
            recents: modelPickerInputs.recents,
            activeModelId: modelPickerInputs.activeModelId,
            activeReasoningEffort: modelPickerInputs.activeReasoningEffort,
            aiStatus: modelPickerInputs.aiStatus,
            interfaceMode: modelPickerInputs.interfaceMode,
            settingsRows: content.settingsRows,
            footerFocus: content.footerFocus ?? null,
            laneLabel: content.laneLabel ?? null,
            query: content.query,
            selection: content.selection,
            providerTabKey: content.providerTabKey ?? null,
            focusedIndex: content.focusedIndex,
            searchMode: content.searchMode,
          })}
          width={paneWidth}
          railFocused={content.railFocused === true}
          onMeasureOrigin={onModelPickerMeasureOrigin}
        />
      ) : null}

      {content.kind === "form" && content.command === "lane-delete" ? (
        <LaneDeleteFormPane
          content={content as LaneDeleteFormContent}
          formValues={formValues}
          activeFormField={activeFormField}
          width={paneWidth}
        />
      ) : null}

      {content.kind === "form" && content.command === "feedback" ? (
        <FeedbackFormPane
          content={content as FeedbackFormContent}
          focused={focused}
          width={paneWidth}
        />
      ) : null}

      {content.kind === "form" && content.command === "new-lane" ? (
        <NewLaneFormPane
          content={content as NewLaneFormContent}
          formValues={formValues}
          activeFormField={activeFormField}
          width={paneWidth}
        />
      ) : null}

      {content.kind === "form" && content.command !== "lane-delete" && content.command !== "feedback" && content.command !== "new-lane" ? (
        <Box flexDirection="column">
          {content.description ? (
            <Box marginBottom={1}>
              <Text color={theme.color.t4} dimColor wrap="truncate-end">
                {endTruncate(content.description, Math.max(8, paneWidth - 4))}
              </Text>
            </Box>
          ) : null}
          {content.fields.map((field, index) => {
            const value = formValues[field.name]?.trim();
            const displayValue = endTruncate(
              (value || field.placeholder || "").replace(/\s+/g, " "),
              Math.max(8, paneWidth - field.label.length - 8),
            );
            return (
              <Text
                key={field.name}
                color={index === activeFormField || hoveredId === `right:form:${field.name}` ? theme.color.violet : undefined}
              >
                {index === activeFormField ? theme.rail : " "} {field.label}
                {field.required ? " *" : ""}: {displayValue}
              </Text>
            );
          })}
          <Text color={theme.color.t4} dimColor>arrows move · enter submits · esc cancels</Text>
        </Box>
      ) : null}
    </Box>
  );
}

export const RightPane = React.memo(RightPaneComponent);

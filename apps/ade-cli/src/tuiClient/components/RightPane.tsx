import React from "react";
import { Box, Text } from "ink";
import type {
  AdeCodeProvider,
  ChatInfoPlanStep,
  ChatInfoSnapshot,
  RightPaneContent,
  SubagentSnapshot,
} from "../types";
import type { AgentChatSessionSummary } from "../../../../desktop/src/shared/types/chat";
import { theme } from "../theme";
import { buildSubagentPaneRows, type SubagentPaneRow } from "../subagentPane";
import { ModelPickerPane } from "./ModelPicker/ModelPickerPane";
import { buildModelPickerLayout } from "./ModelPicker/modelPickerLayout";
import { TokenBar } from "./FooterControls";
import type { AgentChatModelCatalog, AgentChatModelInfo } from "../../../../desktop/src/shared/types/chat";
import type { AiSettingsStatus } from "../../../../desktop/src/shared/types/config";
import { useHoveredHitId } from "../hitTestRegistry";
import { diffLineKind, type DiffLineKind } from "../format";

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
  { k: "o", label: "open / create PR", slashCommand: "/pr open", detail: "draft when missing", glyph: "↗", glyphColorKind: "navigation" },
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
): { active: number; closed: number; killed: number } {
  const laneSessions = sessions.filter((session) => session.laneId === laneId);
  let active = 0;
  let closed = 0;
  let killed = 0;
  for (const session of laneSessions) {
    if (session.status === "active" || session.status === "idle") {
      active += 1;
      continue;
    }
    if (session.completion?.status === "blocked") {
      killed += 1;
    } else {
      closed += 1;
    }
  }
  return { active, closed, killed };
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
  if (chats.closed > 0) parts.push(`${chats.closed} closed`);
  if (chats.killed > 0) parts.push(`${chats.killed} killed`);
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

function ChatInfoSectionHead({ title, hint, color, width }: { title: string; hint?: string; color: string; width?: number }) {
  // Section header with a hairline rule that fills the gap to the hint, so each
  // block reads as a titled card divider rather than a bare label.
  const inner = Math.max(12, (width ?? 40) - 4);
  const used = title.length + 2 + (hint ? hint.length + 1 : 0);
  const ruleLen = Math.max(1, inner - used);
  return (
    <Box flexDirection="row" marginTop={1}>
      <Text bold color={color}>{title}</Text>
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
      {info.laneLabel ? (
        <Box flexDirection="row">
          <Text color={theme.color.t4}>lane </Text>
          <Text color={theme.color.t4} dimColor>· </Text>
          <Text color={theme.color.t2}>{endTruncate(info.laneLabel, Math.max(6, inner - 7))}</Text>
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

function rosterWindow(rowCount: number, selected: number, capacity: number): { start: number; end: number } {
  if (rowCount <= capacity) return { start: 0, end: rowCount };
  const half = Math.floor(capacity / 2);
  let start = Math.max(0, selected - half);
  let end = start + capacity;
  if (end > rowCount) {
    end = rowCount;
    start = end - capacity;
  }
  return { start, end };
}

function ChatInfoRoster({
  info,
  selectedIndex,
  brandColor,
  width,
}: {
  info: ChatInfoSnapshot;
  selectedIndex: number;
  brandColor: string;
  width: number;
}) {
  const inner = Math.max(10, width - 4);
  const snapshotRows = buildSubagentPaneRows(info)
    .filter((row): row is Extract<SubagentPaneRow, { kind: "snapshot" }> => row.kind === "snapshot");
  const runCount = snapshotRows.filter((row) => row.snapshot.status === "running").length;
  const doneCount = snapshotRows.filter((row) => row.snapshot.status === "completed").length;
  const failedCount = snapshotRows.filter((row) => row.snapshot.status === "failed").length;
  const bgCount = snapshotRows.filter((row) => row.section === "background").length;
  // Selection convention: 0 = main row; 1..N = subagent rows (1-indexed).
  const totalSelectable = snapshotRows.length + 1;
  const selected = Math.max(0, Math.min(selectedIndex, totalSelectable - 1));
  const mainSelected = selected === 0;
  const showingMain = !info.inspectedSubagentId;
  const hint = snapshotRows.length === 0
    ? "0 live"
    : [
        `${runCount} live`,
        `${doneCount} done`,
        failedCount ? `${failedCount} failed` : null,
        bgCount ? `${bgCount} bg` : null,
      ].filter((value): value is string => value !== null).join(" · ");

  const ROSTER_CAPACITY = 5;
  const subagentSelectedIndex = mainSelected ? -1 : selected - 1;
  const window = rosterWindow(snapshotRows.length, Math.max(0, subagentSelectedIndex), ROSTER_CAPACITY);
  const visibleSlice = snapshotRows.slice(window.start, window.end);
  const hiddenBefore = window.start;
  const hiddenAfter = snapshotRows.length - window.end;

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
      {snapshotRows.length === 0 ? (
        <Text color={theme.color.t4} dimColor>{" "}no subagents yet</Text>
      ) : (
        <>
          {hiddenBefore > 0 ? (
            <Text color={theme.color.t4} dimColor>{`  ↑ ${hiddenBefore} earlier`}</Text>
          ) : null}
          {visibleSlice.map((row, sliceIndex) => {
            const rosterIndex = window.start + sliceIndex;
            const previousSection = rosterIndex === 0
              ? "main"
              : snapshotRows[rosterIndex - 1]?.section;
            const showSection = row.section !== previousSection;
            const isSelected = !mainSelected && subagentSelectedIndex === rosterIndex;
            const kind = subagentAgentKind(row.snapshot.status);
            // Background rows get a cyan glyph tint so the eye can sort them out
            // from foreground subagents at a glance. Falls back to the
            // status-driven color for other rows.
            const statusColor = row.section === "background"
              ? theme.color.tool
              : theme.agentStatusColor(kind);
            const inspected = info.inspectedSubagentId === row.snapshot.id;
            const detail = rosterRowDetail(row.snapshot);
            return (
              <Box key={row.key} flexDirection="column">
                {showSection ? <RosterSectionHead section={row.section} /> : null}
                <Box flexDirection="row">
                  <Text color={isSelected ? theme.color.violet : theme.color.t5}>{isSelected ? theme.rail : " "}</Text>
                  <Text color={statusColor}>{` ${theme.agentStatusGlyph(kind)}`}</Text>
                  <Text color={isSelected ? theme.color.violet : inspected ? theme.color.t1 : theme.color.t2} bold={isSelected || inspected}>
                    {` ${endTruncate(row.snapshot.name, Math.max(6, inner - 18))}`}
                  </Text>
                  <Text color={theme.color.t4} dimColor>{`  ${formatElapsed(row.snapshot.durationMs ?? null)}`}</Text>
                </Box>
                {isSelected && detail ? (
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
        <Text color={theme.color.t4} dimColor>↑↓ focus · ↵ swap · esc → main</Text>
      </Box>
    </Box>
  );
}

// Section heading for the roster — matches the 2-line allowance built into
// `subagentPaneSelectableLineOffsets` (one blank-margin line + one title line)
// so the mouse-click line-math stays accurate.
function RosterSectionHead({ section }: { section: SubagentPaneRow["section"] }) {
  let label = "subagents";
  if (section === "background") label = "background";
  else if (section === "teammates") label = "teammates";
  const color = section === "background" ? theme.color.tool : theme.color.t4;
  return (
    <Box marginTop={1}>
      <Text color={color} dimColor>{label}</Text>
    </Box>
  );
}

function ChatInfoPane({
  info,
  selectedIndex,
  width,
}: {
  info: ChatInfoSnapshot;
  selectedIndex: number;
  width: number;
}) {
  const brand = theme.provider(info.provider);
  return (
    <Box flexDirection="column">
      <ChatInfoHeader info={info} width={width} />
      <ChatInfoPlanBlock info={info} brandColor={brand.color} width={width} />
      <ChatInfoGoalBlock info={info} brandColor={brand.color} width={width} />
      <ChatInfoRoster info={info} selectedIndex={selectedIndex} brandColor={brand.color} width={width} />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Other content modes (status, list, details, diff, form,
// help, empty) — kept compact, refreshed to use theme tokens.
// ---------------------------------------------------------------------------

function HelpPane() {
  return (
    <Box flexDirection="column">
      <Text color={theme.color.t3} dimColor>↓ from prompt enters the model row; ↑ returns</Text>
      <Text color={theme.color.t3} dimColor>in the row: ← → moves between cells, ↓ cycles values</Text>
      <Text color={theme.color.t3} dimColor>/model opens the model picker · /info opens chat info</Text>
      <Text color={theme.color.t3} dimColor>ctrl-o opens or focuses lanes and chats</Text>
      <Text color={theme.color.t3} dimColor>ctrl-g starts split chat add-mode; enter adds, esc cancels</Text>
      <Text color={theme.color.t3} dimColor>in split chat: tab focuses tiles, ctrl-w closes the focused tile</Text>
      <Text color={theme.color.t3} dimColor>ctrl-p opens or focuses info · ctrl-a toggles chat info</Text>
      <Text color={theme.color.t3} dimColor>shift-tab cycles pane focus · esc closes the active side pane</Text>
      <Text color={theme.color.t3} dimColor>ctrl-c interrupts a running chat; press again to quit</Text>
      <Text color={theme.color.t3} dimColor>/ opens commands, @ opens references, tab inserts selected</Text>
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

export function rightPaneScrollableRowCount(content: RightPaneContent): number {
  if (content.kind === "details") return content.body.split(/\r?\n/).length;
  if (content.kind === "context-usage") return (content.usage?.categories.length ?? 0) + 4;
  if (content.kind === "list") return content.rows.length;
  if (content.kind === "diff") {
    return buildDiffRenderLines(content.files).length;
  }
  return 0;
}

type FormPaneContent = Extract<RightPaneContent, { kind: "form" }>;
type LaneDeleteFormContent = FormPaneContent & { command: "lane-delete" };

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
    case "form":
      return { title: content.title.toUpperCase() };
    default:
      return { title: "PANE" };
  }
}

// ---------------------------------------------------------------------------
// Main right pane component
// ---------------------------------------------------------------------------

export function RightPane({
  content,
  formValues = {},
  activeFormField = 0,
  selectedIndex = 0,
  focused = false,
  width = DEFAULT_PANE_WIDTH,
  modelPickerInputs,
  scrollOffsetRows = 0,
}: {
  content: RightPaneContent;
  formValues?: Record<string, string>;
  activeFormField?: number;
  selectedIndex?: number;
  focused?: boolean;
  activeProvider?: AdeCodeProvider | null;
  width?: number;
  scrollOffsetRows?: number;
  /** Data passed in by app.tsx for the model-picker content kind. */
		  modelPickerInputs?: {
		    models: AgentChatModelInfo[];
		    catalog?: AgentChatModelCatalog | null;
		    favorites: string[];
	    recents: string[];
	    activeModelId: string | null;
	    activeReasoningEffort?: string | null;
	    aiStatus?: AiSettingsStatus | null;
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

      {content.kind === "help" ? <HelpPane /> : null}

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
            <Text color={theme.color.t4} dimColor>arrows move · enter opens</Text>
          ) : null}
        </Box>
      ) : null}

      {content.kind === "details" ? (
        <DetailsPane title={content.title} body={content.body} width={paneWidth} scrollOffsetRows={scrollOffsetRows} />
      ) : null}

      {content.kind === "context-usage" ? (
        <ContextUsagePane content={content} width={paneWidth} />
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
        <ChatInfoPane info={content.info} selectedIndex={selectedIndex} width={paneWidth} />
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
		            showAll: content.showAll,
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

      {content.kind === "form" && content.command !== "lane-delete" ? (
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

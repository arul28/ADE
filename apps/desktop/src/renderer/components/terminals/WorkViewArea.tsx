import { useMemo, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowClockwise,
  CaretDown,
  CaretRight,
  Chats,
  Check,
  Code,
  Columns,
  DotsSixVertical,
  Funnel,
  GitBranch,
  GridFour,
  List,
  Plus,
  PaperPlaneTilt,
  Rows,
  SidebarSimple,
  SpinnerGap,
  X,
} from "@phosphor-icons/react";
import type {
  AgentChatSession,
  AgentChatSlashCommand,
  ChatTerminalPreviewResult,
  LaneLinearIssue,
  LaneSummary,
  TerminalResumeProvider,
  TerminalSessionSummary,
  TerminalSnapshotCell,
  TerminalSnapshotRow,
} from "../../../shared/types";
import type { WorkDraftKind, WorkViewMode } from "../../state/appStore";
import { TerminalView } from "./TerminalView";
import { ToolLogo } from "./ToolLogos";
import { SessionLaneHeaderLabel } from "./LaneChip";
import { AgentChatPane, type AgentChatSessionCreatedOptions } from "../chat/AgentChatPane";
import { ChatCommandMenu, handleCommandMenuKeyDown, type ChatCommandMenuHandle, type ChatCommandMenuItem } from "../chat/ChatCommandMenu";
import { ChatComposerShell } from "../chat/ChatComposerShell";
import { WorkStartSurface } from "./WorkStartSurface";
import { CliSessionWorkSurfaceHeader, GridTileSessionHeaderActions } from "./CliSessionWorkSurfaceHeader";
import { isChatToolType, primarySessionLabel, stripTerminalLabelControls, truncateSessionLabel, formatToolTypeLabel } from "../../lib/sessions";
import { sessionNeedsChatTabHighlight, sessionStatusDot } from "../../lib/terminalAttention";
import type { WorkTabGroup } from "./useWorkSessions";
import { SmartTooltip } from "../ui/SmartTooltip";
import { useFloatingPaneEmbeddedChrome, type FloatingPaneEmbeddedChrome } from "../ui/FloatingPane";
import { PaneTilingLayout, type PaneConfig } from "../ui/PaneTilingLayout";
import { cn } from "../ui/cn";
import { launchProfileForTerminalSession, type WorkPtyLaunchArgs, type WorkPtyLaunchResult } from "./cliLaunch";
import { buildWorkSessionTilingTree, type TilingPreset } from "./workSessionTiling";
import { laneSurfaceTint } from "../lanes/laneDesignTokens";
import { useWorkLaneContextMenu } from "./useWorkLaneContextMenu";

function isSessionAwaitingInput(session: TerminalSessionSummary): boolean {
  return sessionNeedsChatTabHighlight({
    runtimeState: session.runtimeState,
    toolType: session.toolType,
    pendingInputItemId: session.pendingInputItemId,
  });
}

function isRunningPtySession(
  session: TerminalSessionSummary | null | undefined,
): session is TerminalSessionSummary & { ptyId: string } {
  return Boolean(
    session
    && session.status === "running"
    && session.ptyId
    && !isChatToolType(session.toolType),
  );
}

function isAgentCliSession(session: TerminalSessionSummary): boolean {
  return Boolean(
    session.toolType
    && session.toolType !== "shell"
    && session.toolType !== "run-shell"
    && !isChatToolType(session.toolType),
  );
}

function stoppedBySignal(exitCode: number | null | undefined): boolean {
  return exitCode === 130 || exitCode === 143;
}

function terminalExitLabel(exitCode: number | null | undefined): string | null {
  if (exitCode == null || exitCode === 0) return null;
  return stoppedBySignal(exitCode) ? "Stopped" : `Exit ${exitCode}`;
}

function stripTerminalControls(value: string): string {
  return stripTerminalLabelControls(value).replace(/\r(?!\n)/g, "\n");
}

const XTERM_16_COLORS = [
  "#000000",
  "#cd3131",
  "#0dbc79",
  "#e5e510",
  "#2472c8",
  "#bc3fbc",
  "#11a8cd",
  "#e5e5e5",
  "#666666",
  "#f14c4c",
  "#23d18b",
  "#f5f543",
  "#3b8eea",
  "#d670d6",
  "#29b8db",
  "#ffffff",
] as const;

function rgbColor(value: number | null | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const safe = Math.max(0, Math.min(0xffffff, Math.floor(value)));
  return `#${safe.toString(16).padStart(6, "0")}`;
}

function paletteColor(value: number | null | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const index = Math.max(0, Math.min(255, Math.floor(value)));
  if (index < XTERM_16_COLORS.length) return XTERM_16_COLORS[index];
  if (index >= 16 && index <= 231) {
    const offset = index - 16;
    const r = Math.floor(offset / 36);
    const g = Math.floor((offset % 36) / 6);
    const b = offset % 6;
    const channel = (part: number) => part === 0 ? 0 : 55 + part * 40;
    return rgbColor((channel(r) << 16) + (channel(g) << 8) + channel(b));
  }
  const gray = 8 + (index - 232) * 10;
  return rgbColor((gray << 16) + (gray << 8) + gray);
}

function cellColor(mode: "default" | "palette" | "rgb", value: number | null): string | undefined {
  if (mode === "rgb") return rgbColor(value);
  if (mode === "palette") return paletteColor(value);
  return undefined;
}

function styleForSnapshotCell(cell: TerminalSnapshotCell): CSSProperties {
  let color = cellColor(cell.fgMode, cell.fg);
  let backgroundColor = cellColor(cell.bgMode, cell.bg);
  if (cell.inverse) {
    const nextColor = backgroundColor;
    backgroundColor = color;
    color = nextColor;
  }
  return {
    ...(color ? { color } : {}),
    ...(backgroundColor ? { backgroundColor } : {}),
    ...(cell.bold ? { fontWeight: 700 } : {}),
    ...(cell.dim ? { opacity: 0.65 } : {}),
    ...(cell.italic ? { fontStyle: "italic" } : {}),
    ...(cell.underline || cell.strikethrough
      ? { textDecoration: [cell.underline ? "underline" : "", cell.strikethrough ? "line-through" : ""].filter(Boolean).join(" ") }
      : {}),
  };
}

function styleKey(style: CSSProperties): string {
  return [
    style.color ?? "",
    style.backgroundColor ?? "",
    style.fontWeight ?? "",
    style.opacity ?? "",
    style.fontStyle ?? "",
    style.textDecoration ?? "",
  ].join("|");
}

function stableKeyHash(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function withStableDuplicateKeys<T>(
  items: T[],
  fingerprint: (item: T) => string,
): Array<{ item: T; key: string }> {
  const counts = new Map<string, number>();
  return items.map((item) => {
    const base = stableKeyHash(fingerprint(item));
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    return { item, key: count ? `${base}:${count}` : base };
  });
}

function isTrimmedBlankCell(cell: TerminalSnapshotCell | undefined): boolean {
  return Boolean(
    cell
    && (cell.text || " ") === " "
    && cell.bgMode === "default"
    && !cell.inverse,
  );
}

function snapshotRuns(row: TerminalSnapshotRow): Array<{ text: string; style: CSSProperties }> {
  let cells = row.cells;
  let end = cells.length;
  while (end > 1 && isTrimmedBlankCell(cells[end - 1])) end -= 1;
  cells = cells.slice(0, end);

  const runs: Array<{ text: string; style: CSSProperties }> = [];
  for (const cell of cells) {
    const text = cell.text || " ";
    const style = styleForSnapshotCell(cell);
    const last = runs[runs.length - 1];
    if (last && styleKey(last.style) === styleKey(style)) {
      last.text += text;
    } else {
      runs.push({ text, style });
    }
  }
  if (!runs.length) return [{ text: row.text || " ", style: {} }];
  return runs;
}

const TUI_FRAME_CHARS = /[╭╮╰╯│─┌┐└┘├┤┬┴┼▐▌▀▄█▛▜▝▘]/;

function cellHasVisibleStyle(cell: TerminalSnapshotCell): boolean {
  const hasText = (cell.text || " ") !== " ";
  const hasTextStyle = (
    cell.fgMode !== "default"
    || cell.bgMode !== "default"
    || Boolean(cell.bold)
    || Boolean(cell.dim)
    || Boolean(cell.italic)
    || Boolean(cell.underline)
    || Boolean(cell.inverse)
    || Boolean(cell.strikethrough)
  );
  if (hasText) return hasTextStyle;
  return cell.bgMode !== "default" || Boolean(cell.inverse);
}

function snapshotLooksLikeTui(rows: TerminalSnapshotRow[]): boolean {
  let nonBlankRows = 0;
  let styledCells = 0;
  for (const row of rows) {
    const text = row.text.trimEnd();
    const visibleStyleCells = row.cells.filter(cellHasVisibleStyle).length;
    if (text.trim() || visibleStyleCells > 0) nonBlankRows += 1;
    if (TUI_FRAME_CHARS.test(text)) return true;
    styledCells += visibleStyleCells;
  }
  return nonBlankRows >= 3 && styledCells >= 8;
}

function TerminalSnapshotTranscript({ rows }: { rows: TerminalSnapshotRow[] }) {
  const renderedRows = useMemo(() => withStableDuplicateKeys(rows, (row) => [
    row.text,
    row.wrapped ? "wrapped" : "plain",
    ...row.cells.map((cell) => [
      cell.text,
      cell.fg,
      cell.bg,
      cell.fgMode,
      cell.bgMode,
      cell.bold ? "bold" : "",
      cell.dim ? "dim" : "",
      cell.italic ? "italic" : "",
      cell.underline ? "underline" : "",
      cell.inverse ? "inverse" : "",
      cell.strikethrough ? "strikethrough" : "",
    ].join("\u0001")),
  ].join("\u0002")).map(({ item: row, key }) => ({
    key,
    runs: withStableDuplicateKeys(snapshotRuns(row), (run) => `${run.text}\u0001${styleKey(run.style)}`),
  })), [rows]);

  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-md border border-white/[0.06] bg-black/20 p-3 font-mono text-[11px] leading-relaxed text-fg/75">
      {renderedRows.map((row) => (
        <div key={row.key} className="min-h-[1.25em] whitespace-pre">
          {row.runs.map(({ item: run, key }) => (
            <span key={key} style={run.style}>
              {run.text}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

type CommandMenuAnchor = { top: number; left: number; bottom: number };

function getCommandMenuAnchor(element: HTMLElement | null): CommandMenuAnchor | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom, left: rect.left + 16 };
}

function continuationProviderForSession(session: TerminalSessionSummary): TerminalResumeProvider | null {
  const profile = launchProfileForTerminalSession(session);
  return profile && profile !== "shell" ? profile : null;
}

function canContinueAgentCliSession(session: TerminalSessionSummary): boolean {
  return Boolean(session.tracked && continuationProviderForSession(session) && (session.resumeMetadata || session.resumeCommand));
}

function continuationProviderLabel(provider: TerminalResumeProvider | null): string {
  if (provider === "claude") return "Claude Code";
  if (provider === "codex") return "Codex";
  if (provider === "cursor") return "Cursor Agent";
  if (provider === "droid") return "Droid";
  if (provider === "opencode") return "OpenCode";
  return "agent CLI";
}

function WorkCliContinuationComposer({
  session,
  onContinue,
}: {
  session: TerminalSessionSummary;
  onContinue?: (session: TerminalSessionSummary, text: string) => Promise<void> | void;
}) {
  const provider = continuationProviderForSession(session);
  const providerLabel = continuationProviderLabel(provider);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const commandMenuRef = useRef<ChatCommandMenuHandle | null>(null);
  const [draft, setDraft] = useState("");
  const [slashCommands, setSlashCommands] = useState<AgentChatSlashCommand[]>([]);
  const [commandMenuTrigger, setCommandMenuTrigger] = useState<{ type: "slash"; query: string; cursorIndex: number } | null>(null);
  const [commandMenuAnchor, setCommandMenuAnchor] = useState<CommandMenuAnchor | null>(null);
  const [sending, setSending] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSlashCommands([]);
    if (!provider) return () => {
      cancelled = true;
    };
    void window.ade.agentChat.slashCommands({ laneId: session.laneId, provider })
      .then((commands) => {
        if (!cancelled) {
          setSlashCommands(commands.filter((command) => command.source !== "local"));
        }
      })
      .catch(() => {
        if (!cancelled) setSlashCommands([]);
      });
    return () => {
      cancelled = true;
    };
  }, [provider, session.laneId]);

  const updateDraft = useCallback((next: string, element: HTMLTextAreaElement | null) => {
    setDraft(next);
    setSubmitError(null);
    if (next.startsWith("/") && !next.slice(1).includes("\n")) {
      const afterSlash = next.slice(1);
      if (!/\s/.test(afterSlash)) {
        const query = afterSlash.match(/^[^\s/]*/)?.[0] ?? "";
        setCommandMenuTrigger({ type: "slash", query, cursorIndex: 0 });
        const anchor = getCommandMenuAnchor(element);
        if (anchor) setCommandMenuAnchor(anchor);
        return;
      }
    }
    setCommandMenuTrigger(null);
  }, []);

  const handleCommandSelect = useCallback((item: ChatCommandMenuItem) => {
    if (item.type !== "command") return;
    const command = slashCommands.find((candidate) => candidate.name.replace(/^\//, "") === item.name);
    const argumentHint = command?.argumentHint ? ` ${command.argumentHint}` : "";
    const next = `/${item.name}${argumentHint} `;
    setDraft(next);
    setCommandMenuTrigger(null);
    requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
  }, [slashCommands]);

  const submit = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setSubmitError(null);
    try {
      await onContinue?.(session, text);
      setDraft("");
      setCommandMenuTrigger(null);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }, [draft, onContinue, sending, session]);

  return (
    <div className="shrink-0">
      <ChatComposerShell
        mode="standard"
        className="rounded-lg border border-white/[0.08] bg-white/[0.025]"
        footer={(
          <div className="flex min-h-10 flex-wrap items-center justify-between gap-2 px-2.5 py-1.5 text-[10px] text-muted-fg/55">
            <div className="min-w-0 shrink truncate px-1">
              <span className="font-medium text-fg/70">{providerLabel}</span>
            </div>
            <button
              type="button"
              disabled={sending || !draft.trim()}
              onClick={() => void submit()}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.04] px-2 text-[10px] font-medium text-fg/75 transition-colors hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-45"
            >
              {sending ? <SpinnerGap size={12} className="animate-spin" /> : <PaperPlaneTilt size={12} weight="fill" />}
              Send
            </button>
          </div>
        )}
      >
        <ChatCommandMenu
          ref={commandMenuRef}
          trigger={commandMenuTrigger}
          slashCommands={slashCommands.map((command) => ({
            name: command.name.replace(/^\//, ""),
            description: command.description,
            argumentHint: command.argumentHint,
            source: command.source,
          }))}
          sessionId={null}
          anchor={commandMenuAnchor}
          onSelect={handleCommandSelect}
          onClose={() => setCommandMenuTrigger(null)}
        />
        <textarea
          ref={textareaRef}
          value={draft}
          rows={1}
          disabled={sending}
          onChange={(event) => updateDraft(event.currentTarget.value, event.currentTarget)}
          onKeyDown={(event) => {
            if (commandMenuTrigger && handleCommandMenuKeyDown(event, commandMenuRef, () => setCommandMenuTrigger(null))) {
              return;
            }
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
          className="block max-h-32 min-h-[3rem] w-full resize-none bg-transparent px-3 py-2.5 text-[13px] leading-relaxed text-fg/88 outline-none placeholder:text-muted-fg/35 disabled:cursor-not-allowed disabled:opacity-60"
          placeholder={`Type to continue this ${providerLabel} session...`}
          aria-label={`Continue ${providerLabel} session`}
        />
      </ChatComposerShell>
      {submitError ? (
        <div className="mt-2 rounded-md border border-red-500/20 bg-red-500/5 px-3 py-2 text-[11px] text-red-300">
          {submitError}
        </div>
      ) : null}
    </div>
  );
}

function ClosedCliSessionSurface({
  session,
  lanes,
  layoutVariant,
  onInfoClick,
  onContextMenu,
  onContinue,
  onResume,
}: {
  session: TerminalSessionSummary;
  lanes: LaneSummary[];
  layoutVariant: "standard" | "grid-tile";
  onInfoClick?: (session: TerminalSessionSummary, event: React.MouseEvent<HTMLElement>) => void;
  onContextMenu?: (session: TerminalSessionSummary, event: React.MouseEvent<HTMLElement>) => void;
  onContinue?: (session: TerminalSessionSummary, text: string) => Promise<void> | void;
  onResume?: (session: TerminalSessionSummary) => Promise<void> | void;
}) {
  const [preview, setPreview] = useState<ChatTerminalPreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const label = primarySessionLabel(session);
  const showComposer = canContinueAgentCliSession(session);
  const exitLabel = terminalExitLabel(session.exitCode);
  const endedTime = session.endedAt
    ? new Date(session.endedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : null;
  const endedLabel = endedTime ? `Ended ${endedTime}` : "Session ended";

  const handleResume = useCallback(async () => {
    if (resuming) return;
    setResuming(true);
    setResumeError(null);
    try {
      await onResume?.(session);
    } catch (err) {
      setResumeError(err instanceof Error ? err.message : String(err));
    } finally {
      setResuming(false);
    }
  }, [onResume, resuming, session]);

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setError(null);
    void window.ade.terminal.preview({ terminalId: session.id, maxBytes: 160_000 })
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [session.id, session.endedAt, session.status]);

  const snapshotRows = preview?.snapshot?.visibleRows ?? [];
  const useSnapshotPreview = snapshotRows.length > 0 && (
    preview?.session?.status === "running"
    || !preview?.transcript
    || snapshotLooksLikeTui(snapshotRows)
  );
  const transcriptText = stripTerminalControls(preview?.transcript ?? "").trimEnd()
    || session.lastOutputPreview
    || session.summary
    || "No transcript was captured for this session.";

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-card">
      {layoutVariant !== "grid-tile" ? (
        <CliSessionWorkSurfaceHeader
          session={session}
          lanes={lanes}
          onInfoClick={onInfoClick}
          onContextMenu={onContextMenu}
        />
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-4 py-3">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] pb-3">
          <div className="min-w-0">
            <div className="truncate text-[12px] font-medium text-fg/85">{label}</div>
            <div className="mt-0.5 text-[10px] text-muted-fg/55">
              {endedLabel}
              {exitLabel ? ` · ${exitLabel}` : ""}
            </div>
          </div>
          {showComposer && onResume ? (
            <button
              type="button"
              disabled={resuming}
              onClick={() => void handleResume()}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.04] px-2 text-[10px] font-medium text-fg/75 transition-colors hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-45"
            >
              {resuming ? <SpinnerGap size={12} className="animate-spin" /> : <ArrowClockwise size={12} />}
              Resume
            </button>
          ) : null}
        </div>
        {error || resumeError ? (
          <div className="shrink-0 rounded-md border border-red-500/20 bg-red-500/5 px-3 py-2 text-[11px] text-red-300">
            {resumeError ?? error}
          </div>
        ) : null}
        {useSnapshotPreview ? (
          <TerminalSnapshotTranscript rows={snapshotRows} />
        ) : (
          <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-md border border-white/[0.06] bg-black/20 p-3 font-mono text-[11px] leading-relaxed text-fg/75">
            {transcriptText}
          </pre>
        )}
        {showComposer ? <WorkCliContinuationComposer session={session} onContinue={onContinue} /> : null}
      </div>
    </div>
  );
}

function SessionSurface({
  session,
  lanes,
  isActive,
  pageActive = true,
  shouldAutofocus = false,
  layoutVariant = "standard",
  terminalVisible = isActive,
  onInfoClick,
  onContextMenu,
  onStopRunningSession,
  stopping = false,
  onOpenChatSession,
  onContinueCliSession,
  onResumeCliSession,
}: {
  session: TerminalSessionSummary;
  lanes: LaneSummary[];
  isActive: boolean;
  pageActive?: boolean;
  shouldAutofocus?: boolean;
  layoutVariant?: "standard" | "grid-tile";
  terminalVisible?: boolean;
  onInfoClick?: (session: TerminalSessionSummary, event: React.MouseEvent<HTMLElement>) => void;
  onContextMenu?: (session: TerminalSessionSummary, event: React.MouseEvent<HTMLElement>) => void;
  onStopRunningSession?: (session: TerminalSessionSummary) => void;
  stopping?: boolean;
  onOpenChatSession: (session: AgentChatSession, options?: AgentChatSessionCreatedOptions) => void | Promise<void>;
  onContinueCliSession?: (session: TerminalSessionSummary, text: string) => Promise<void> | void;
  onResumeCliSession?: (session: TerminalSessionSummary) => Promise<void> | void;
}) {
  const isChat = isChatToolType(session.toolType);
  const surfaceActive = pageActive && isActive;
  const surfaceVisible = pageActive && (layoutVariant === "grid-tile" ? true : isActive);
  if (isChat) {
    return (
      <AgentChatPane
        laneId={session.laneId}
        laneLabel={session.laneName}
        lockSessionId={session.id}
        hideSessionTabs
        hideLaneToolDrawers
        onSessionCreated={onOpenChatSession}
        layoutVariant={layoutVariant}
        isTileActive={surfaceActive}
        isTileVisible={surfaceVisible}
        shouldAutofocusComposer={surfaceActive && shouldAutofocus}
      />
    );
  }
  if (isRunningPtySession(session)) {
    if (isAgentCliSession(session)) {
      return (
        <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
          {layoutVariant !== "grid-tile" ? (
            <CliSessionWorkSurfaceHeader
              session={session}
              lanes={lanes}
              stopping={stopping}
              onInfoClick={onInfoClick}
              onContextMenu={onContextMenu}
              onStopRunningSession={onStopRunningSession}
            />
          ) : null}
          <TerminalView
            key={session.id}
            ptyId={session.ptyId}
            sessionId={session.id}
            isActive={surfaceActive}
            isVisible={pageActive && terminalVisible}
            className="min-h-0 w-full flex-1"
          />
        </div>
      );
    }
    return (
      <TerminalView
        key={session.id}
        ptyId={session.ptyId}
        sessionId={session.id}
        isActive={surfaceActive}
        isVisible={pageActive && terminalVisible}
        className="h-full w-full"
      />
    );
  }

  if (isAgentCliSession(session)) {
    return (
      <ClosedCliSessionSurface
        session={session}
        lanes={lanes}
        layoutVariant={layoutVariant}
        onInfoClick={onInfoClick}
        onContextMenu={onContextMenu}
        onContinue={onContinueCliSession}
        onResume={onResumeCliSession}
      />
    );
  }

  const label = primarySessionLabel(session);
  const toolLabel = session.toolType ? formatToolTypeLabel(session.toolType) : null;
  const rawSummary = session.summary?.trim() || session.goal?.trim() || null;
  // Don't show summary if it just repeats the title
  const summary = rawSummary && rawSummary !== label && !rawSummary.startsWith(label) ? rawSummary : null;
  const endedTime = session.endedAt
    ? new Date(session.endedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : null;
  const exitLabel = terminalExitLabel(session.exitCode);

  return (
    <div
      className="flex h-full w-full items-center justify-center px-6"
      style={{
        background: "radial-gradient(circle at top, color-mix(in srgb, var(--color-fg) 5%, transparent) 0%, transparent 42%), var(--color-card)",
      }}
    >
      <div className="ade-liquid-glass-menu flex w-full max-w-md flex-col gap-4 rounded-lg px-5 py-5">
        {/* Header: tool logo + session name */}
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md" style={{ background: "rgba(255,255,255,0.05)" }}>
            <ToolLogo toolType={session.toolType} size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-fg">{label}</div>
            <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-fg/70">
              {toolLabel && <span>{toolLabel}</span>}
              {toolLabel && endedTime && <span>·</span>}
              {endedTime && <span>Ended {endedTime}</span>}
              {exitLabel && (
                <>
                  <span>·</span>
                  <span className={stoppedBySignal(session.exitCode) ? "text-amber-300" : "text-red-400"}>{exitLabel}</span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Summary */}
        {summary && (
          <div className="text-[12px] leading-relaxed text-muted-fg">
            {summary.length > 300 ? `${summary.slice(0, 300).trimEnd()}…` : summary}
          </div>
        )}

        {/* Session ID */}
        <div className="flex items-center gap-2 text-[10px] text-muted-fg/50">
          <span className="font-mono">{session.id}</span>
        </div>

      </div>
    </div>
  );
}

const MODE_OPTIONS: Array<{
  kind: WorkDraftKind;
  label: string;
  description: string;
  Icon: typeof Chats;
}> = [
  { kind: "chat", label: "Chat", description: "Compose a new ADE chat in this lane.", Icon: Chats },
  { kind: "cli", label: "CLI", description: "Start a tracked agent CLI session.", Icon: Code },
];


type SessionsPaneToggleProps = {
  collapsed: boolean;
  onToggle: () => void;
  listCount: number;
  runningCount: number;
  listLoading: boolean;
};

function SessionsPaneToggle({
  collapsed,
  onToggle,
  listCount,
  runningCount,
  listLoading,
}: SessionsPaneToggleProps) {
  let countHint: string;
  if (listLoading) {
    countHint = "Loading session list…";
  } else if (listCount > 0) {
    countHint = `${listCount} in list${runningCount > 0 ? `, ${runningCount} running` : ""}`;
  } else {
    countHint = "Session list is empty.";
  }
  const label = collapsed ? "Show sessions" : "Hide sidebar";
  const description = collapsed
    ? `Expand the sessions sidebar. ${countHint}`
    : `Collapse the sessions sidebar. ${countHint}`;
  return (
    <SmartTooltip
      content={{
        label,
        description,
      }}
    >
      <button
        type="button"
        className="ade-shell-control ade-work-header-side-control inline-flex shrink-0 items-center gap-1 rounded p-0.5 px-1.5 text-[10px] font-medium"
        data-variant="ghost"
        data-tour="work.sessionsExpand"
        title={label}
        aria-label={label}
        aria-pressed={!collapsed}
        onClick={onToggle}
      >
        <SidebarSimple size={11} weight="regular" />
        {!listLoading && listCount > 0 ? (
          <span className="min-w-[1ch] text-[9px] leading-none tabular-nums text-muted-fg/50">{listCount}</span>
        ) : null}
      </button>
    </SmartTooltip>
  );
}

function ModeSwitcherPills({
  draftKind,
  onShowDraftKind,
}: {
  draftKind: WorkDraftKind;
  onShowDraftKind: (kind: WorkDraftKind) => void;
}) {
  return (
    <div className="ade-liquid-glass-pill inline-flex items-center gap-1 rounded-full p-1.5">
      {MODE_OPTIONS.map((opt) => {
        const active = opt.kind === "chat"
          ? draftKind === "chat" || draftKind === "chat-orchestrator"
          : draftKind === opt.kind;
        const Icon = opt.Icon;
        return (
          <SmartTooltip
            key={opt.kind}
            content={{
              label: opt.label,
              description: opt.description,
              effect: active ? "This start mode is selected." : undefined,
            }}
          >
            <button
              type="button"
              className={cn(
                "inline-flex min-h-[48px] items-center gap-2.5 rounded-full px-5 py-2.5 text-[14px] font-medium transition-all",
                active && "ade-work-tab-active",
              )}
              style={{
                background: active ? undefined : "transparent",
                color: active ? "var(--color-fg)" : "var(--color-muted-fg)",
                cursor: "pointer",
                border: "none",
              }}
              onClick={() => onShowDraftKind(opt.kind)}
            >
              <Icon size={18} weight="regular" className="shrink-0 opacity-80" />
              {opt.label}
            </button>
          </SmartTooltip>
        );
      })}
    </div>
  );
}

function WorkPaneEmbeddedChromeLeading({ chrome }: { chrome: FloatingPaneEmbeddedChrome | null }) {
  if (!chrome?.minimizable) return null;
  const { onMinimizeToggle, minimized, dragHandleProps } = chrome;
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {dragHandleProps?.draggable ? (
        <DotsSixVertical
          size={10}
          weight="regular"
          className="pointer-events-none text-muted-fg/30 shrink-0"
          aria-hidden
        />
      ) : null}
      <button
        type="button"
        className={cn(
          "ade-work-header-side-control flex w-[var(--ade-work-header-side-h)] shrink-0 items-center justify-center rounded-md transition-colors",
          minimized ? "text-accent" : "text-muted-fg/50 hover:text-fg"
        )}
        onClick={(event) => {
          event.stopPropagation();
          onMinimizeToggle();
        }}
        onMouseDown={(event) => event.stopPropagation()}
        title={minimized ? "Expand pane" : "Minimize pane"}
        aria-label={minimized ? "Expand pane" : "Minimize pane"}
      >
        {minimized ? <CaretRight size={12} weight="regular" /> : <CaretDown size={12} weight="regular" />}
      </button>
    </div>
  );
}

/**
 * Glyph for the workspace-level "Tools" pane: a sidebar panel docked to the
 * right with a stack of mixed content lines inside, plus an active-state
 * indicator bar. Communicates "a side panel that holds many tools" at
 * a glance — distinct from the chat-header Workbench chip (per-chat tools).
 */
function ToolsPaneGlyph({ open }: { open: boolean }) {
  return (
    <span className="relative block h-[14px] w-[16px]" aria-hidden="true">
      {/* Outer frame */}
      <span
        className={cn(
          "absolute inset-0 rounded-[3px] border transition-colors",
          open
            ? "border-sky-300/55 bg-sky-300/10"
            : "border-current/45 bg-transparent",
        )}
      />
      {/* Active "docked panel" column on the right */}
      <span
        className={cn(
          "absolute right-[1.5px] top-[1.5px] bottom-[1.5px] w-[4px] rounded-[2px] transition-colors",
          open
            ? "bg-sky-200/85 shadow-[0_0_8px_rgba(125,211,252,0.35)]"
            : "bg-current/55",
        )}
      />
      {/* Stacked content rows on the left */}
      <span
        className={cn(
          "absolute left-[2.5px] top-[3px] h-[1.5px] w-[6px] rounded-full transition-colors",
          open ? "bg-sky-100/80" : "bg-current/70",
        )}
      />
      <span
        className={cn(
          "absolute left-[2.5px] top-[6.5px] h-[1.5px] w-[4.5px] rounded-full transition-colors",
          open ? "bg-sky-100/55" : "bg-current/45",
        )}
      />
      <span
        className={cn(
          "absolute left-[2.5px] top-[10px] h-[1.5px] w-[5.5px] rounded-full transition-colors",
          open ? "bg-sky-100/55" : "bg-current/45",
        )}
      />
    </span>
  );
}

function WorkSidebarToggle({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle?: () => void;
}) {
  if (!onToggle) return null;
  return (
    <SmartTooltip
      content={{
        label: open ? "Close Tools pane" : "Open Tools pane",
        description: "Workspace-level tools alongside this session — Git, Files, iOS Simulator, App Control, and Browser.",
      }}
    >
      <button
        type="button"
        className={cn(
          "ade-shell-control ade-work-header-side-control ade-work-tools-toggle inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5",
          "font-sans text-[9.5px] font-medium transition-colors hover:text-fg/90",
          open ? "text-fg/90" : "text-muted-fg/75",
        )}
        onClick={onToggle}
        aria-label={open ? "Close Tools pane" : "Open Tools pane"}
        aria-pressed={open}
      >
        <ToolsPaneGlyph open={open} />
        <span className="leading-none">Tools</span>
      </button>
    </SmartTooltip>
  );
}

type WorkGlassHeaderProps = {
  headerAlignClass: string;
  glassHeaderDragProps: React.HTMLAttributes<HTMLDivElement>;
  workEmbeddedChrome: FloatingPaneEmbeddedChrome | null;
  sessionsPaneToggleProps: SessionsPaneToggleProps | null;
  viewMode: WorkViewMode;
  setViewMode: (mode: WorkViewMode) => void;
  showViewModeToggle?: boolean;
  workSidebarOpen: boolean;
  onToggleWorkSidebar?: () => void;
  leftTrailing?: React.ReactNode;
  center?: React.ReactNode;
};

function WorkGlassHeader({
  headerAlignClass,
  glassHeaderDragProps,
  workEmbeddedChrome,
  sessionsPaneToggleProps,
  viewMode,
  setViewMode,
  showViewModeToggle = false,
  workSidebarOpen,
  onToggleWorkSidebar,
  leftTrailing,
  center,
}: WorkGlassHeaderProps) {
  const toolsDockVisible = Boolean(onToggleWorkSidebar);
  return (
    <div
      className={cn(
        "ade-work-glass-header ade-work-glass-header-flex w-full min-w-0 max-w-full shrink-0 px-2 py-0",
        headerAlignClass,
        workEmbeddedChrome?.dragHandleProps?.draggable && "cursor-grab active:cursor-grabbing",
      )}
      {...glassHeaderDragProps}
    >
      <div
        className="ade-work-glass-header-left flex min-w-0 shrink-0 items-stretch justify-start gap-1"
        data-tour="work.focusToolbar"
      >
        {sessionsPaneToggleProps ? <SessionsPaneToggle {...sessionsPaneToggleProps} /> : null}
        <WorkPaneEmbeddedChromeLeading chrome={workEmbeddedChrome} />
        {showViewModeToggle ? (
          <ViewModeToggle viewMode={viewMode} setViewMode={setViewMode} />
        ) : null}
        <AnimatePresence>{leftTrailing}</AnimatePresence>
      </div>
      <div
        className={cn(
          "ade-work-glass-header-center min-w-0 flex-1 overflow-hidden",
          toolsDockVisible && "ade-work-glass-header-center--tools-dock",
        )}
      >
        <div
          className={cn(
            "ade-work-tab-strip-scroll scrollbar-none min-w-0 w-full overflow-x-auto overflow-y-hidden",
            toolsDockVisible && "ade-work-tab-strip-scroll--tools-dock",
          )}
        >
          <div className={cn("ade-work-tab-strip-scroll-inner", headerAlignClass)}>
            {center}
            {toolsDockVisible ? <div aria-hidden className="ade-work-tab-strip-scroll-spacer" /> : null}
          </div>
        </div>
        {toolsDockVisible ? (
          <div className="ade-work-header-tools-dock">
            <WorkSidebarToggle open={workSidebarOpen} onToggle={onToggleWorkSidebar} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function placeWorkGlassHeader(
  header: React.ReactNode,
  headerMountEl: HTMLElement | null | undefined,
): React.ReactNode {
  if (headerMountEl) return createPortal(header, headerMountEl);
  return header;
}

type WorkTabProps = {
  session: TerminalSessionSummary;
  isActive: boolean;
  isBusy: boolean;
  laneColor: string | null;
  grouped?: boolean;
  awaiting: boolean;
  dropEdge?: "before" | "after" | null;
  onSelect: () => void;
  onClose: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  dragProps?: {
    draggable: boolean;
    onDragStart: (e: React.DragEvent) => void;
    onDragEnter: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
    onDragEnd: (e: React.DragEvent) => void;
  };
};

function WorkTab({
  session,
  isActive,
  isBusy,
  laneColor,
  grouped = false,
  awaiting,
  dropEdge = null,
  onSelect,
  onClose,
  onContextMenu,
  dragProps,
}: WorkTabProps) {
  const dot = sessionStatusDot(session);
  const primary = primarySessionLabel(session);
  const trimmedLaneColor = laneColor?.trim() || null;
  const tabTint = trimmedLaneColor
    ? `color-mix(in srgb, ${trimmedLaneColor} ${isActive ? 22 : 16}%, transparent)`
    : isActive
      ? undefined
      : "color-mix(in srgb, var(--color-fg) 6%, transparent)";
  const ring = trimmedLaneColor
    ? `color-mix(in srgb, ${trimmedLaneColor} ${isActive ? 40 : 34}%, transparent)`
    : "color-mix(in srgb, var(--color-fg) 18%, transparent)";
  const cssVars = {
    "--lane-tab-tint": tabTint,
    "--lane-tab-active-ring": ring,
    "--lane-drop-indicator": trimmedLaneColor ?? "color-mix(in srgb, var(--color-fg) 60%, transparent)",
  } as React.CSSProperties;
  return (
    <SmartTooltip
      wrapperClassName="h-full min-h-0 self-stretch"
      wrapperStyle={{ display: "flex", alignItems: "center", height: "100%", minHeight: 0 }}
      content={{
        label: truncateSessionLabel(primary, 28),
        description: `Switch to this ${formatToolTypeLabel(session.toolType)} work tab.`,
        effect: dot.label,
      }}
    >
      <div
        className={cn(
          "group/tab ade-work-tab h-full",
          grouped && "ade-work-tab--grouped",
          isActive && "ade-work-tab--active",
          awaiting && "ade-work-tab--awaiting",
          dropEdge === "before" && "ade-work-tab--drop-before",
          dropEdge === "after" && "ade-work-tab--drop-after",
        )}
        style={cssVars}
        onContextMenu={onContextMenu}
        draggable={dragProps?.draggable ?? false}
        onDragStart={dragProps?.onDragStart}
        onDragEnter={dragProps?.onDragEnter}
        onDragOver={dragProps?.onDragOver}
        onDragLeave={dragProps?.onDragLeave}
        onDrop={dragProps?.onDrop}
        onDragEnd={dragProps?.onDragEnd}
      >
        <button
          type="button"
          role="tab"
          tabIndex={0}
          aria-selected={isActive}
          className="ade-work-tab-select"
          onClick={onSelect}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            onSelect();
          }}
        >
          <ToolLogo toolType={session.toolType} size={grouped ? 11 : 12} className="ade-work-tab-logo shrink-0" />
          <span className="ade-work-tab-label">
            {truncateSessionLabel(primary, grouped ? 24 : 26)}
          </span>
          <span
            title={dot.label}
            aria-hidden
            className={cn(
              "ade-work-tab-status pointer-events-none",
              dot.cls,
              dot.spinning && "animate-spin",
            )}
          />
        </button>
        <button
          type="button"
          data-close-tab-session-id={session.id}
          aria-label={`Close ${primary}`}
          title={isBusy ? "Removing..." : "Remove from Work view"}
          draggable={false}
          className="ade-work-tab-close inline-flex items-center justify-center opacity-0 transition-opacity group-hover/tab:opacity-100 focus-visible:opacity-100"
          style={{
            padding: 0,
            border: 0,
            background: "transparent",
            cursor: isBusy ? "default" : "pointer",
            color: "var(--color-muted-fg)",
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onDragStart={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.stopPropagation();
            if (isBusy) return;
            onClose();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              if (isBusy) return;
              onClose();
            }
          }}
        >
          <X size={9} />
        </button>
      </div>
    </SmartTooltip>
  );
}

export function WorkViewArea({
  pageActive = true,
  gridLayoutId,
  lanes,
  sessions,
  visibleSessions,
  tabGroups,
  tabVisibleSessionIds,
  activeItemId,
  viewMode,
  draftKind,
  draftLaneId = null,
  draftContextTargetId = null,
  onContinueCliSession,
  onResumeCliSession,
  setViewMode,
  onSelectItem,
  onCloseItem,
  onOpenChatSession,
  onLaunchPtySession,
  onDraftLaneChange,
  onShowDraftKind,
  onToggleTabGroupCollapsed,
  closingPtyIds,
  onContextMenu,
  sessionsPaneCollapsed = false,
  onToggleSessionsPane,
  sessionsPaneListCount = 0,
  sessionsPaneRunningCount = 0,
  sessionsListLoading = false,
  workSidebarOpen = false,
  onToggleWorkSidebar,
  headerMountEl = null,
  initialLinearIssueContext = null,
  initialLinearIssueContextSource = "lane_link",
  initialModelId = null,
  onInitialLinearIssueContextConsumed,
  suppressDraftLaunchNavigation = false,
  onReorderLaneSessions,
  onOpenSessionInTabsView,
  onGoToLane,
  onInfoClick,
  onStopRunningSession,
}: {
  pageActive?: boolean;
  gridLayoutId: string;
  lanes: LaneSummary[];
  sessions: TerminalSessionSummary[];
  visibleSessions: TerminalSessionSummary[];
  tabGroups?: WorkTabGroup[];
  tabVisibleSessionIds?: string[];
  activeItemId: string | null;
  viewMode: WorkViewMode;
  draftKind: WorkDraftKind;
  draftLaneId?: string | null;
  draftContextTargetId?: string | null;
  setViewMode: (mode: WorkViewMode) => void;
  onSelectItem: (sessionId: string) => void;
  onCloseItem: (sessionId: string) => void;
  onOpenChatSession: (session: AgentChatSession, options?: AgentChatSessionCreatedOptions) => void | Promise<void>;
  onLaunchPtySession: (args: WorkPtyLaunchArgs) => Promise<WorkPtyLaunchResult>;
  onDraftLaneChange?: (laneId: string) => void;
  onShowDraftKind: (kind: WorkDraftKind) => void;
  onToggleTabGroupCollapsed?: (groupId: string) => void;
  closingPtyIds: Set<string>;
  onContextMenu?: (session: TerminalSessionSummary, e: React.MouseEvent) => void;
  onContinueCliSession?: (session: TerminalSessionSummary, text: string) => Promise<void> | void;
  onResumeCliSession?: (session: TerminalSessionSummary) => Promise<void> | void;
  onReorderLaneSessions?: (laneId: string, movedSessionId: string, targetSessionId: string, edge: "before" | "after") => void;
  onOpenSessionInTabsView?: (sessionId: string) => void;
  onGoToLane?: (laneId: string) => void;
  /** Whether the work sessions list pane is collapsed. */
  sessionsPaneCollapsed?: boolean;
  onToggleSessionsPane?: () => void;
  sessionsPaneListCount?: number;
  sessionsPaneRunningCount?: number;
  sessionsListLoading?: boolean;
  workSidebarOpen?: boolean;
  onToggleWorkSidebar?: () => void;
  /** When set, the work glass header is portaled into this element (full-width chrome above session split). */
  headerMountEl?: HTMLElement | null;
  initialLinearIssueContext?: LaneLinearIssue | null;
  initialLinearIssueContextSource?: "manual" | "lane_link";
  initialModelId?: string | null;
  onInitialLinearIssueContextConsumed?: () => void;
  suppressDraftLaunchNavigation?: boolean;
  onInfoClick?: (session: TerminalSessionSummary, event: React.MouseEvent<HTMLElement>) => void;
  onStopRunningSession?: (session: TerminalSessionSummary) => void;
}) {
  const sessionsPaneToggleProps: SessionsPaneToggleProps | null = onToggleSessionsPane
    ? {
      collapsed: sessionsPaneCollapsed,
      onToggle: onToggleSessionsPane,
      listCount: sessionsPaneListCount,
      runningCount: sessionsPaneRunningCount,
      listLoading: sessionsListLoading,
    }
    : null;
  const workEmbeddedChrome = useFloatingPaneEmbeddedChrome();
  const glassHeaderDragProps = workEmbeddedChrome?.dragHandleProps ?? {};
  const { trigger: triggerLaneContextMenu, menu: laneContextMenuPortal } = useWorkLaneContextMenu();
  const sessionsById = useMemo(() => {
    const map = new Map<string, TerminalSessionSummary>();
    for (const session of sessions) map.set(session.id, session);
    return map;
  }, [sessions]);

  const laneColorById = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const lane of lanes) map.set(lane.id, lane.color);
    return map;
  }, [lanes]);

  const tabVisibleSessions = useMemo(
    () => (tabVisibleSessionIds ?? visibleSessions.map((session) => session.id))
      .map((sessionId) => sessionsById.get(sessionId))
      .filter((session): session is TerminalSessionSummary => session != null),
    [sessionsById, tabVisibleSessionIds, visibleSessions],
  );
  const showingDraft = activeItemId == null;
  const activeSession = showingDraft
    ? null
    : sessionsById.get(activeItemId) ?? tabVisibleSessions[0] ?? visibleSessions[0] ?? null;
  const handleContextMenu = useCallback((session: TerminalSessionSummary, e: React.MouseEvent): void => {
    if (onContextMenu) {
      e.preventDefault();
      onContextMenu(session, e);
    }
  }, [onContextMenu]);
  const [tilingPreset, setTilingPreset] = useState<TilingPreset>("auto");
  const gridSessionIdsKey = JSON.stringify(visibleSessions.map((session) => session.id));
  const gridTree = useMemo(
    () => buildWorkSessionTilingTree(JSON.parse(gridSessionIdsKey) as string[], tilingPreset),
    [gridSessionIdsKey, tilingPreset],
  );
  const applyTilingPreset = useCallback(async (preset: TilingPreset) => {
    const ids = JSON.parse(gridSessionIdsKey) as string[];
    const nextTree = buildWorkSessionTilingTree(ids, preset);
    try {
      await Promise.all([
        window.ade.tilingTree.set(gridLayoutId, nextTree),
        window.ade.layout.set(gridLayoutId, {}),
      ]);
    } catch {
      /* persistence is best-effort; UI state update below still applies */
    }
    setTilingPreset(preset);
  }, [gridLayoutId, gridSessionIdsKey]);
  const tilingPanes = useMemo<Record<string, PaneConfig>>(() => Object.fromEntries(
    visibleSessions.map((session) => {
      const dot = sessionStatusDot(session);
      const isBusy = session.ptyId ? closingPtyIds.has(session.ptyId) : false;
      const isCliAgentSession = isAgentCliSession(session);
      const isActive = activeItemId === session.id;
      const rawLaneColor = laneColorById.get(session.laneId) ?? null;
      const laneAccentColor = rawLaneColor?.trim() ? rawLaneColor.trim() : null;
      const openInTabs = () => onOpenSessionInTabsView?.(session.id);
      const gotoLane = () => onGoToLane?.(session.laneId);
      return [session.id, {
        title: truncateSessionLabel(primarySessionLabel(session)),
        titleContent: (
          <SessionLaneHeaderLabel
            sessionTitle={truncateSessionLabel(primarySessionLabel(session))}
            laneName={session.laneName}
            laneColor={laneAccentColor}
            onSessionTitleClick={openInTabs}
            onLaneClick={gotoLane}
            onLaneContextMenu={(e) => triggerLaneContextMenu(session.laneId, e)}
          />
        ),
        minimizable: false,
        laneAccentColor,
        className: cn("h-full ade-work-glass-tile", isActive && "ade-work-glass-tile-active"),
        bodyClassName: "overflow-hidden",
        headerActions: (
          <>
            {isCliAgentSession ? (
              <GridTileSessionHeaderActions
                session={session}
                stopping={isBusy}
                onInfoClick={onInfoClick}
                onContextMenu={onContextMenu}
                onStopRunningSession={onStopRunningSession}
              />
            ) : (
              <span
                title={dot.label}
                className={`${dot.cls} h-2 w-2 shrink-0${dot.spinning ? " animate-spin" : ""}`}
              />
            )}
            <button
              type="button"
              onClick={() => onCloseItem(session.id)}
              onMouseDown={(e) => e.stopPropagation()}
              title={isBusy ? "Removing..." : "Remove from Work view"}
              disabled={isBusy}
              className="inline-flex h-5 w-5 items-center justify-center text-muted-fg/50 transition-colors hover:text-fg"
              style={{
                border: "none",
                background: "transparent",
                cursor: isBusy ? "default" : "pointer",
                opacity: isBusy ? 0.4 : 1,
              }}
            >
              <X size={10} />
            </button>
          </>
        ),
        onPaneMouseDown: () => onSelectItem(session.id),
        onPaneContextMenu: (e) => handleContextMenu(session, e),
        children: (
          <div className="min-h-0 h-full flex-1 overflow-hidden">
            <SessionSurface
              session={session}
              lanes={lanes}
              isActive={isActive}
              pageActive={pageActive}
              shouldAutofocus={isActive}
              terminalVisible
              layoutVariant="grid-tile"
              onInfoClick={onInfoClick}
              onContextMenu={onContextMenu}
              onStopRunningSession={onStopRunningSession}
              stopping={Boolean(session.ptyId && closingPtyIds.has(session.ptyId))}
              onOpenChatSession={onOpenChatSession}
              onContinueCliSession={onContinueCliSession}
              onResumeCliSession={onResumeCliSession}
            />
          </div>
        ),
      } satisfies PaneConfig];
    }),
  ), [
    activeItemId,
    closingPtyIds,
    handleContextMenu,
    lanes,
    laneColorById,
    onCloseItem,
    onContextMenu,
    onGoToLane,
    onInfoClick,
    onOpenChatSession,
    onOpenSessionInTabsView,
    onContinueCliSession,
    onResumeCliSession,
    onSelectItem,
    onStopRunningSession,
    pageActive,
    triggerLaneContextMenu,
    visibleSessions,
  ]);
  const resolvedTabGroups = tabGroups ?? [];
  const hasGroupedTabs = resolvedTabGroups.length > 0;
  const toggleTabGroupCollapsed = onToggleTabGroupCollapsed ?? (() => {});

  const [dragState, setDragState] = useState<{
    laneId: string;
    sessionId: string;
    overIndex: number | null;
    overEdge: "before" | "after" | null;
  } | null>(null);

  const buildLaneDragProps = useCallback((args: {
    laneId: string;
    sessionId: string;
    index: number;
  }): WorkTabProps["dragProps"] => {
    if (!onReorderLaneSessions) return undefined;
    return {
      draggable: true,
      onDragStart: (e) => {
        try { e.dataTransfer.setData("text/x-ade-work-tab", args.sessionId); } catch { /* ignore */ }
        e.dataTransfer.effectAllowed = "move";
        setDragState({ laneId: args.laneId, sessionId: args.sessionId, overIndex: null, overEdge: null });
      },
      onDragEnter: (e) => {
        if (!dragState || dragState.laneId !== args.laneId) return;
        e.preventDefault();
      },
      onDragOver: (e) => {
        if (!dragState || dragState.laneId !== args.laneId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const edge: "before" | "after" = e.clientX < rect.left + rect.width / 2 ? "before" : "after";
        setDragState((prev) => (
          prev && prev.laneId === args.laneId && (prev.overIndex !== args.index || prev.overEdge !== edge)
            ? { ...prev, overIndex: args.index, overEdge: edge }
            : prev
        ));
      },
      onDragLeave: () => {
        setDragState((prev) => (
          prev && prev.overIndex === args.index ? { ...prev, overIndex: null, overEdge: null } : prev
        ));
      },
      onDrop: (e) => {
        e.preventDefault();
        if (!dragState || dragState.laneId !== args.laneId || dragState.sessionId === args.sessionId) return;
        const targetEdge = dragState.overEdge ?? "before";
        onReorderLaneSessions(args.laneId, dragState.sessionId, args.sessionId, targetEdge);
        setDragState(null);
      },
      onDragEnd: () => setDragState(null),
    };
  }, [dragState, onReorderLaneSessions]);

  const headerAlignClass = "items-stretch";
  const showViewModeToggle = visibleSessions.length > 1;

  const tabStripCenter = hasGroupedTabs ? (
    <div className={cn("flex min-h-full w-max flex-row items-stretch gap-2")}>
      {resolvedTabGroups.map((group) => {
        const hasActive = group.sessionIds.includes(activeSession?.id ?? "");
        const isLaneGroup = group.kind === "lane";
        const laneId = isLaneGroup && group.id.startsWith("lane:") ? group.id.slice("lane:".length) : null;
        const laneColor = group.laneColor;
        const someAwaiting = group.sessions.some(isSessionAwaitingInput);
        const bandColor = laneColor?.trim() || null;
        const bandTint = bandColor
          ? laneSurfaceTint(bandColor, "default", 0.08)
          : laneSurfaceTint(null);
        const bandCssVars = {
          "--lane-band-color": bandColor ?? "color-mix(in srgb, var(--color-fg) 28%, transparent)",
          ...(bandColor ? { "--lane-band-label-color": bandColor } : {}),
          "--lane-band-bg": bandTint.background,
          "--lane-band-header-bg": bandColor
            ? `color-mix(in srgb, ${bandColor} 12%, transparent)`
            : "transparent",
        } as React.CSSProperties;
        const GroupIcon = isLaneGroup ? GitBranch : Funnel;
        if (group.collapsed) {
          return (
            <SmartTooltip
              key={group.id}
              content={{
                label: `Expand ${group.label}`,
                description: "Show the work tabs in this group.",
                effect: `${group.sessions.length} session${group.sessions.length === 1 ? "" : "s"} in this group.`,
              }}
            >
              <button
                type="button"
                aria-expanded={false}
                aria-controls={`tab-group-${group.id}`}
                className={cn(
                  "ade-work-lane-band ade-work-lane-band--collapsed",
                  someAwaiting && "ade-work-lane-band--awaiting",
                  hasActive && "ade-work-lane-band--active",
                )}
                style={bandCssVars}
                onClick={() => toggleTabGroupCollapsed(group.id)}
                onContextMenu={(e) => {
                  if (!laneId) return;
                  triggerLaneContextMenu(laneId, e);
                }}
              >
                <GroupIcon size={11} weight="regular" className="shrink-0" />
                <span className="ade-work-lane-band-collapsed-label">
                  {group.label}
                </span>
                <span className="ade-work-lane-band-collapsed-count tabular-nums">
                  {group.sessions.length}
                </span>
              </button>
            </SmartTooltip>
          );
        }
        return (
          <div
            key={group.id}
            className="ade-work-lane-band"
            style={bandCssVars}
          >
            <SmartTooltip
              content={{
                label: `Collapse ${group.label}`,
                description: "Hide the work tabs in this group.",
                effect: `${group.sessions.length} session${group.sessions.length === 1 ? "" : "s"} in this group.`,
              }}
            >
              <button
                type="button"
                aria-expanded
                aria-controls={`tab-group-${group.id}`}
                aria-label={`Collapse ${group.label}`}
                className={cn(
                  "ade-work-lane-band-collapse",
                  someAwaiting && "ade-work-lane-band--awaiting",
                  hasActive && "ade-work-lane-band--active",
                )}
                onClick={() => toggleTabGroupCollapsed(group.id)}
                onContextMenu={(e) => {
                  if (!laneId) return;
                  triggerLaneContextMenu(laneId, e);
                }}
              >
                <CaretRight size={9} weight="bold" />
              </button>
            </SmartTooltip>
            <div
              id={`tab-group-${group.id}`}
              role="tablist"
              className="ade-work-lane-band-tabs"
            >
              {group.sessions.map((session, index) => {
                const isActive = activeSession?.id === session.id;
                const isBusy = session.ptyId ? closingPtyIds.has(session.ptyId) : false;
                const awaiting = isSessionAwaitingInput(session);
                const dropEdge = dragState
                  && laneId
                  && dragState.laneId === laneId
                  && dragState.overIndex === index
                  && dragState.sessionId !== session.id
                  ? dragState.overEdge
                  : null;
                return (
                  <WorkTab
                    key={session.id}
                    session={session}
                    isActive={isActive}
                    isBusy={isBusy}
                    laneColor={laneColor}
                    grouped
                    awaiting={awaiting}
                    dropEdge={dropEdge}
                    onSelect={() => onSelectItem(session.id)}
                    onClose={() => onCloseItem(session.id)}
                    onContextMenu={(e) => handleContextMenu(session, e)}
                    dragProps={laneId ? buildLaneDragProps({ laneId, sessionId: session.id, index }) : undefined}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
      {visibleSessions.length === 0 ? (
        <SmartTooltip content={{ label: "New Chat", description: "Start a new AI chat session in the current lane." }}>
          <button
            type="button"
            className="ade-work-new-chat-btn inline-flex shrink-0 items-center justify-center"
            onClick={() => onShowDraftKind("chat")}
            aria-label="Start a new chat"
          >
            <Plus size={12} weight="bold" />
          </button>
        </SmartTooltip>
      ) : null}
    </div>
  ) : (
    <div className="ade-work-tab-strip-roomy w-max">
      {visibleSessions.map((session, index) => {
        const isActive = activeSession?.id === session.id;
        const isBusy = session.ptyId ? closingPtyIds.has(session.ptyId) : false;
        const laneColor = laneColorById.get(session.laneId) ?? null;
        const awaiting = isSessionAwaitingInput(session);
        const dropEdge = dragState
          && dragState.laneId === session.laneId
          && dragState.overIndex === index
          && dragState.sessionId !== session.id
          ? dragState.overEdge
          : null;
        return (
          <WorkTab
            key={session.id}
            session={session}
            isActive={isActive}
            isBusy={isBusy}
            laneColor={laneColor}
            awaiting={awaiting}
            dropEdge={dropEdge}
            onSelect={() => onSelectItem(session.id)}
            onClose={() => onCloseItem(session.id)}
            onContextMenu={(e) => handleContextMenu(session, e)}
            dragProps={buildLaneDragProps({ laneId: session.laneId, sessionId: session.id, index })}
          />
        );
      })}
      {visibleSessions.length === 0 ? (
        <SmartTooltip content={{ label: "New Chat", description: "Start a new AI chat session in the current lane." }}>
          <button
            type="button"
            className="ade-work-new-chat-btn inline-flex shrink-0 items-center justify-center"
            onClick={() => onShowDraftKind("chat")}
            aria-label="Start a new chat"
          >
            <Plus size={11} weight="bold" />
          </button>
        </SmartTooltip>
      ) : null}
    </div>
  );

  if (viewMode === "grid") {
    return (
      <div className="flex h-full min-w-0 flex-col">
        {placeWorkGlassHeader(
          <WorkGlassHeader
            headerAlignClass={headerAlignClass}
            glassHeaderDragProps={glassHeaderDragProps}
            workEmbeddedChrome={workEmbeddedChrome}
            sessionsPaneToggleProps={sessionsPaneToggleProps}
            viewMode={viewMode}
            setViewMode={setViewMode}
            showViewModeToggle={showViewModeToggle}
            workSidebarOpen={workSidebarOpen}
            onToggleWorkSidebar={onToggleWorkSidebar}
            leftTrailing={visibleSessions.length > 1 ? (
              <motion.div
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: "auto", opacity: 1 }}
                exit={{ width: 0, opacity: 0 }}
                transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
                className="overflow-hidden flex items-stretch"
              >
                <ArrangeMenu preset={tilingPreset} onSelect={applyTilingPreset} />
              </motion.div>
            ) : null}
            center={tabStripCenter}
          />,
          headerMountEl,
        )}

        {visibleSessions.length === 0 ? (
          <div className="flex h-full flex-col">
            <div className="relative z-10 flex shrink-0 items-center justify-center pb-8 pt-6">
              <ModeSwitcherPills draftKind={draftKind} onShowDraftKind={onShowDraftKind} />
            </div>
            <div className="min-h-0 flex-1">
              <WorkStartSurface
                draftKind={draftKind}
                draftLaneId={draftLaneId}
                draftContextTargetId={draftContextTargetId}
                lanes={lanes}
                onOpenChatSession={onOpenChatSession}
                onLaunchPtySession={onLaunchPtySession}
                onDraftLaneChange={onDraftLaneChange}
                initialLinearIssueContext={initialLinearIssueContext}
                initialLinearIssueContextSource={initialLinearIssueContextSource}
                initialModelId={initialModelId}
                onInitialLinearIssueContextConsumed={onInitialLinearIssueContextConsumed}
                suppressDraftLaunchNavigation={suppressDraftLaunchNavigation}
              />
            </div>
          </div>
        ) : (
          <PaneTilingLayout
            key={`${gridLayoutId}:${tilingPreset}`}
            layoutId={gridLayoutId}
            tree={gridTree}
            panes={tilingPanes}
            className="ade-work-grid-tiling flex-1 min-h-0 px-2 pb-2"
          />
        )}
        {laneContextMenuPortal}
      </div>
    );
  }

  /* ---- Tab view ---- */
  const tabBody = (
    <div className="relative min-h-0 flex-1" style={{ background: "var(--color-bg)" }}>
      {visibleSessions.map((session) => {
        const isActive = activeSession?.id === session.id;
        if (!isActive) return null;

        return (
          <div
            key={session.id}
            className="absolute inset-0"
            hidden={!isActive}
          >
            <SessionSurface
              session={session}
              lanes={lanes}
              isActive={isActive}
              pageActive={pageActive}
              terminalVisible={isActive}
              onInfoClick={onInfoClick}
              onContextMenu={onContextMenu}
              onStopRunningSession={onStopRunningSession}
              stopping={Boolean(session.ptyId && closingPtyIds.has(session.ptyId))}
              onOpenChatSession={onOpenChatSession}
              onContinueCliSession={onContinueCliSession}
              onResumeCliSession={onResumeCliSession}
            />
          </div>
        );
      })}

      {!activeSession ? (
        <div className="absolute inset-0 flex flex-col">
          <div className="relative z-10 flex shrink-0 items-center justify-center pb-8 pt-6">
            <ModeSwitcherPills draftKind={draftKind} onShowDraftKind={onShowDraftKind} />
          </div>
          <div className="min-h-0 flex-1">
            <WorkStartSurface
              draftKind={draftKind}
              draftLaneId={draftLaneId}
              draftContextTargetId={draftContextTargetId}
              lanes={lanes}
              onOpenChatSession={onOpenChatSession}
              onLaunchPtySession={onLaunchPtySession}
              onDraftLaneChange={onDraftLaneChange}
              initialLinearIssueContext={initialLinearIssueContext}
              initialLinearIssueContextSource={initialLinearIssueContextSource}
              initialModelId={initialModelId}
              onInitialLinearIssueContextConsumed={onInitialLinearIssueContextConsumed}
              suppressDraftLaunchNavigation={suppressDraftLaunchNavigation}
            />
          </div>
        </div>
      ) : null}
    </div>
  );

  if (!hasGroupedTabs) {
    return (
      <div className="flex h-full min-w-0 flex-col">
        {placeWorkGlassHeader(
          <WorkGlassHeader
            headerAlignClass={headerAlignClass}
            glassHeaderDragProps={glassHeaderDragProps}
            workEmbeddedChrome={workEmbeddedChrome}
            sessionsPaneToggleProps={sessionsPaneToggleProps}
            viewMode={viewMode}
            setViewMode={setViewMode}
            showViewModeToggle={showViewModeToggle}
            workSidebarOpen={workSidebarOpen}
            onToggleWorkSidebar={onToggleWorkSidebar}
            center={tabStripCenter}
          />,
          headerMountEl,
        )}

        {tabBody}
        {laneContextMenuPortal}
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col">
      {placeWorkGlassHeader(
        <WorkGlassHeader
          headerAlignClass={headerAlignClass}
          glassHeaderDragProps={glassHeaderDragProps}
          workEmbeddedChrome={workEmbeddedChrome}
          sessionsPaneToggleProps={sessionsPaneToggleProps}
          viewMode={viewMode}
          setViewMode={setViewMode}
          showViewModeToggle={showViewModeToggle}
          workSidebarOpen={workSidebarOpen}
          onToggleWorkSidebar={onToggleWorkSidebar}
          center={tabStripCenter}
        />,
        headerMountEl,
      )}

      {tabBody}
      {laneContextMenuPortal}
    </div>
  );
}

const TILING_PRESET_OPTIONS: ReadonlyArray<{
  preset: TilingPreset;
  label: string;
  description: string;
  icon: React.ReactNode;
}> = [
  { preset: "auto", label: "Auto", description: "Balanced grid (default).", icon: <GridFour size={10} /> },
  { preset: "rows", label: "Rows", description: "Stack vertically, one full-width row per session.", icon: <Rows size={10} /> },
  { preset: "columns", label: "Columns", description: "Side by side, one full-height column per session.", icon: <Columns size={10} /> },
];

function ArrangeMenu({
  preset,
  onSelect,
}: {
  preset: TilingPreset;
  onSelect: (preset: TilingPreset) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const active = TILING_PRESET_OPTIONS.find((opt) => opt.preset === preset) ?? TILING_PRESET_OPTIONS[0]!;

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div
      ref={containerRef}
      className="ade-work-arrange-menu-root flex max-w-full min-w-0 shrink-0 items-center gap-1"
    >
      <SmartTooltip content={{ label: "Arrange grid layout", description: "Pick a preset shape for the grid: Auto, Rows, or Columns." }}>
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          aria-haspopup="menu"
          aria-expanded={open}
          className="ade-work-header-side-control ade-liquid-glass-pill inline-flex shrink-0 items-center gap-1 rounded-full px-2 text-[10px] font-medium transition-all"
          style={{
            color: "var(--color-muted-fg)",
            border: "none",
            cursor: "pointer",
          }}
          title="Arrange grid layout"
        >
          {active.icon}
          {active.label}
          <CaretDown size={9} />
        </button>
      </SmartTooltip>
      <AnimatePresence>
        {open ? (
          <motion.div
            key="arrange-menu"
            role="menu"
            initial={{ clipPath: "inset(0 100% 0 0)", opacity: 0.88 }}
            animate={{ clipPath: "inset(0 0% 0 0)", opacity: 1 }}
            exit={{ clipPath: "inset(0 100% 0 0)", opacity: 0.88 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            className="ade-work-arrange-menu ade-liquid-glass-pill z-50 flex min-w-0 max-w-[min(100vw-24px,32rem)] flex-none flex-row flex-nowrap divide-x divide-white/10 overflow-hidden rounded-md"
          >
            <div className="flex min-h-0 min-w-0 flex-row flex-nowrap items-center overflow-x-auto scrollbar-none">
              {TILING_PRESET_OPTIONS.map((opt) => {
                const isActive = opt.preset === preset;
                return (
                  <button
                    key={opt.preset}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isActive}
                    onClick={() => {
                      onSelect(opt.preset);
                      setOpen(false);
                    }}
                    className="ade-work-arrange-menu-item inline-flex shrink-0 items-center gap-1 whitespace-nowrap transition-colors"
                    style={{
                      background: "transparent",
                      color: isActive ? "var(--color-fg)" : "var(--color-muted-fg)",
                      border: "none",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                    title={opt.description}
                  >
                    <span className="inline-flex shrink-0 items-center justify-center">{opt.icon}</span>
                    <span className="shrink-0">{opt.label}</span>
                    <span className="inline-flex w-2.5 shrink-0 items-center justify-center">
                      {isActive ? <Check size={10} weight="bold" /> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function ViewModeToggle({
  viewMode,
  setViewMode,
}: {
  viewMode: WorkViewMode;
  setViewMode: (mode: WorkViewMode) => void;
}) {
  return (
    <div className="ade-work-view-mode-toggle" role="group" aria-label="View mode">
      {([
        { mode: "tabs" as const, icon: <List size={10} weight={viewMode === "tabs" ? "bold" : "regular"} />, title: "Tab view", description: "Display sessions as tabs in a single panel." },
        { mode: "grid" as const, icon: <GridFour size={10} weight={viewMode === "grid" ? "bold" : "regular"} />, title: "Grid view", description: "Display sessions side by side in a tiled grid." },
      ]).map(({ mode, icon, title, description }) => {
        const active = viewMode === mode;
        return (
          <SmartTooltip
            key={mode}
            content={{ label: title, description }}
            wrapperClassName="ade-work-view-mode-toggle-slot"
          >
            <button
              type="button"
              aria-pressed={active}
              aria-label={title}
              onClick={() => setViewMode(mode)}
              className="ade-work-view-mode-toggle-btn"
            >
              {icon}
            </button>
          </SmartTooltip>
        );
      })}
    </div>
  );
}

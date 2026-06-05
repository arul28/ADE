import { useMemo, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowClockwise,
  Chats,
  Code,
  PaperPlaneTilt,
  SpinnerGap,
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
import { useAppStore, type WorkDraftKind, type WorkGridSet } from "../../state/appStore";
import { findGridSetForSession } from "../../lib/workGrid";
import type { DropEdge } from "../ui/paneTreeOps";
import { WorkGridView, SingleSessionGridDropZone } from "./WorkGridView";

const EMPTY_GRID_SETS: WorkGridSet[] = [];
import { TerminalView } from "./TerminalView";
import { ToolLogo } from "./ToolLogos";
import { AgentChatPane, type AgentChatSessionCreatedOptions } from "../chat/AgentChatPane";
import { ChatCommandMenu, handleCommandMenuKeyDown, type ChatCommandMenuHandle, type ChatCommandMenuItem } from "../chat/ChatCommandMenu";
import { ChatComposerShell } from "../chat/ChatComposerShell";
import { WorkStartSurface } from "./WorkStartSurface";
import { CliSessionWorkSurfaceHeader } from "./CliSessionWorkSurfaceHeader";
import { isChatToolType, primarySessionLabel, stripTerminalLabelControls, truncateSessionLabel, formatToolTypeLabel } from "../../lib/sessions";
import { SmartTooltip } from "../ui/SmartTooltip";
import { cn } from "../ui/cn";
import { launchProfileForTerminalSession, type WorkPtyLaunchArgs, type WorkPtyLaunchResult } from "./cliLaunch";
import { useWorkLaneContextMenu } from "./useWorkLaneContextMenu";
import { copyLaunchPromptToClipboard } from "../../lib/launchPromptClipboard";

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
  const launchPromptClipboardEnabled = useAppStore((s) => s.launchPromptClipboardEnabled);

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
      if (launchPromptClipboardEnabled) {
        void copyLaunchPromptToClipboard(text);
      }
      await onContinue?.(session, text);
      setDraft("");
      setCommandMenuTrigger(null);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }, [draft, launchPromptClipboardEnabled, onContinue, sending, session]);

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
  onToggleSessionsPane,
  sessionsPaneCollapsed,
  sessionsPaneCount,
  onToggleToolsPane,
  toolsPaneOpen,
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
  /** Far-left session-list expander (per-surface header now owns it). */
  onToggleSessionsPane?: () => void;
  sessionsPaneCollapsed?: boolean;
  sessionsPaneCount?: number;
  /** Far-right Tools-pane toggle (per-surface header now owns it). */
  onToggleToolsPane?: () => void;
  toolsPaneOpen?: boolean;
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
        onToggleSessionsPane={onToggleSessionsPane}
        sessionsPaneCollapsed={sessionsPaneCollapsed}
        sessionsPaneCount={sessionsPaneCount}
        onToggleToolsPane={onToggleToolsPane}
        toolsPaneOpen={toolsPaneOpen}
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
              onToggleSessionsPane={onToggleSessionsPane}
              sessionsPaneCollapsed={sessionsPaneCollapsed}
              sessionsPaneCount={sessionsPaneCount}
              onToggleToolsPane={onToggleToolsPane}
              toolsPaneOpen={toolsPaneOpen}
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

export function WorkViewArea({
  pageActive = true,
  lanes,
  sessions,
  visibleSessions,
  activeItemId,
  draftKind,
  draftLaneId = null,
  draftContextTargetId = null,
  onContinueCliSession,
  onResumeCliSession,
  onSelectItem,
  onCloseItem,
  onOpenChatSession,
  onLaunchPtySession,
  onDraftLaneChange,
  onShowDraftKind,
  closingPtyIds,
  onContextMenu,
  sessionsPaneCollapsed = false,
  onToggleSessionsPane,
  sessionsPaneListCount = 0,
  workSidebarOpen = false,
  onToggleWorkSidebar,
  initialLinearIssueContext = null,
  initialLinearIssueContextSource = "lane_link",
  initialModelId = null,
  onInitialLinearIssueContextConsumed,
  suppressDraftLaunchNavigation = false,
  onGoToLane,
  onInfoClick,
  onStopRunningSession,
  gridSets = EMPTY_GRID_SETS,
  onAddSessionToGrid,
  onCreateGridFromSingle,
  onRemoveSessionFromGrid,
}: {
  pageActive?: boolean;
  lanes: LaneSummary[];
  sessions: TerminalSessionSummary[];
  visibleSessions: TerminalSessionSummary[];
  activeItemId: string | null;
  draftKind: WorkDraftKind;
  draftLaneId?: string | null;
  draftContextTargetId?: string | null;
  onSelectItem: (sessionId: string) => void;
  onCloseItem: (sessionId: string) => void;
  onOpenChatSession: (session: AgentChatSession, options?: AgentChatSessionCreatedOptions) => void | Promise<void>;
  onLaunchPtySession: (args: WorkPtyLaunchArgs) => Promise<WorkPtyLaunchResult>;
  onDraftLaneChange?: (laneId: string) => void;
  onShowDraftKind: (kind: WorkDraftKind) => void;
  closingPtyIds: Set<string>;
  onContextMenu?: (session: TerminalSessionSummary, e: React.MouseEvent) => void;
  onContinueCliSession?: (session: TerminalSessionSummary, text: string) => Promise<void> | void;
  onResumeCliSession?: (session: TerminalSessionSummary) => Promise<void> | void;
  onGoToLane?: (laneId: string) => void;
  /** Whether the work sessions list pane is collapsed. */
  sessionsPaneCollapsed?: boolean;
  onToggleSessionsPane?: () => void;
  sessionsPaneListCount?: number;
  workSidebarOpen?: boolean;
  onToggleWorkSidebar?: () => void;
  initialLinearIssueContext?: LaneLinearIssue | null;
  initialLinearIssueContextSource?: "manual" | "lane_link";
  initialModelId?: string | null;
  onInitialLinearIssueContextConsumed?: () => void;
  suppressDraftLaunchNavigation?: boolean;
  onInfoClick?: (session: TerminalSessionSummary, event: React.MouseEvent<HTMLElement>) => void;
  onStopRunningSession?: (session: TerminalSessionSummary) => void;
  /** Cursor-style grid sets for this project. */
  gridSets?: WorkGridSet[];
  /** A session card was dropped onto an existing grid tile. */
  onAddSessionToGrid?: (draggedSessionId: string, targetSessionId: string, edge: DropEdge) => void;
  /** A session card was dropped onto a single (non-grid) session — create a grid. */
  onCreateGridFromSingle?: (draggedSessionId: string, targetSessionId: string, edge: DropEdge) => void;
  /** A grid tile was dragged out of the grid — pop it back to single view. */
  onRemoveSessionFromGrid?: (sessionId: string) => void;
}) {
  const { menu: laneContextMenuPortal } = useWorkLaneContextMenu();
  const sessionsById = useMemo(() => {
    const map = new Map<string, TerminalSessionSummary>();
    for (const session of sessions) map.set(session.id, session);
    return map;
  }, [sessions]);

  const showingDraft = activeItemId == null;
  const activeSession = showingDraft
    ? null
    : sessionsById.get(activeItemId) ?? visibleSessions[0] ?? null;
  /* ---- Single / grid session view ---- */
  // The focused session decides the view: if it belongs to a grid set we render
  // the whole set (Cursor-style resizable tiles); otherwise the single session.
  const activeGridSet = activeSession ? findGridSetForSession(gridSets, activeSession.id) : null;

  const renderGridSession = (session: TerminalSessionSummary) => (
    <SessionSurface
      session={session}
      lanes={lanes}
      isActive
      pageActive={pageActive}
      shouldAutofocus={session.id === activeItemId}
      terminalVisible
      onInfoClick={onInfoClick}
      onContextMenu={onContextMenu}
      onStopRunningSession={onStopRunningSession}
      stopping={Boolean(session.ptyId && closingPtyIds.has(session.ptyId))}
      onOpenChatSession={onOpenChatSession}
      onContinueCliSession={onContinueCliSession}
      onResumeCliSession={onResumeCliSession}
      onToggleSessionsPane={onToggleSessionsPane}
      sessionsPaneCollapsed={sessionsPaneCollapsed}
      sessionsPaneCount={sessionsPaneListCount}
      onToggleToolsPane={onToggleWorkSidebar}
      toolsPaneOpen={workSidebarOpen}
    />
  );

  // Coarse work-area mode — switching sessions stays "single" (no remount), but
  // the new-chat → real-chat and grid↔single transitions cross-fade with a blur
  // dissolve (the "new-chat pane dissolves into the chat" showcase moment).
  const workAreaMode: "grid" | "single" | "empty" = activeGridSet
    ? "grid"
    : activeSession
      ? "single"
      : "empty";
  const workAreaContent =
    workAreaMode === "grid" && activeGridSet ? (
      <WorkGridView
        gridSet={activeGridSet}
        sessions={sessions}
        lanes={lanes}
        activeItemId={activeItemId}
        renderSession={renderGridSession}
        onFocusSession={onSelectItem}
        onAddSessionToGrid={(dragged, target, edge) => onAddSessionToGrid?.(dragged, target, edge)}
        onRemoveFromGrid={(sessionId) => onRemoveSessionFromGrid?.(sessionId)}
        className="ade-work-grid-tiling h-full min-h-0 px-2 pb-2"
      />
    ) : workAreaMode === "single" && activeSession ? (
      <SingleSessionGridDropZone
        targetSessionId={activeSession.id}
        onDropSession={(dragged, edge) => onCreateGridFromSingle?.(dragged, activeSession.id, edge)}
      >
        <SessionSurface
          session={activeSession}
          lanes={lanes}
          isActive
          pageActive={pageActive}
          terminalVisible
          onInfoClick={onInfoClick}
          onContextMenu={onContextMenu}
          onStopRunningSession={onStopRunningSession}
          stopping={Boolean(activeSession.ptyId && closingPtyIds.has(activeSession.ptyId))}
          onOpenChatSession={onOpenChatSession}
          onContinueCliSession={onContinueCliSession}
          onResumeCliSession={onResumeCliSession}
          onToggleSessionsPane={onToggleSessionsPane}
          sessionsPaneCollapsed={sessionsPaneCollapsed}
          sessionsPaneCount={sessionsPaneListCount}
          onToggleToolsPane={onToggleWorkSidebar}
          toolsPaneOpen={workSidebarOpen}
        />
      </SingleSessionGridDropZone>
    ) : (
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
    );

  const tabBody = (
    <div className="relative min-h-0 flex-1" style={{ background: "var(--chat-canvas-bg)" }}>
      <AnimatePresence initial={false}>
        <motion.div
          key={workAreaMode}
          className="absolute inset-0"
          initial={{ opacity: 0, filter: "blur(12px)", scale: 0.992 }}
          animate={{ opacity: 1, filter: "blur(0px)", scale: 1 }}
          exit={{ opacity: 0, filter: "blur(12px)", scale: 0.992 }}
          transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
        >
          {workAreaContent}
        </motion.div>
      </AnimatePresence>
    </div>
  );

  // No shared top bar anymore — the focused session's own header carries the
  // sessions + Tools toggles. Navigation between open sessions happens via the
  // left session list; the work area shows the focused session.
  return (
    <div className="flex h-full min-w-0 flex-col">
      {tabBody}
      {laneContextMenuPortal}
    </div>
  );
}


import { PROVIDER_DISPLAY_NAME } from "../../../shared/providers";
import { useMemo, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { AnimatePresence, motion } from "motion/react";
import { STANDARD_EASE } from "../../lib/motion";
import { previewRowsFromTranscript, transcriptUsesAlternateScreen } from "./terminalPreviewRows";
import {
  ArrowClockwise,
  ArrowUp,
  Chats,
  Code,
  SpinnerGap,
} from "@phosphor-icons/react";
import type {
  AgentChatSession,
  AgentChatSlashCommand,
  ChatTerminalPreviewResult,
  LaneLinearIssue,
  LaneSummary,
  OpenProjectBinding,
  TerminalResumeProvider,
  TerminalResumeLaunchConfig,
  TerminalSessionSummary,
  TerminalSnapshotCell,
  TerminalSnapshotRow,
} from "../../../shared/types";
import { useAppStore, type WorkDraftKind, type WorkGridSet } from "../../state/appStore";
import { findGridSetForSession } from "../../lib/workGrid";
import type { DropEdge } from "../ui/paneTreeOps";
import { WorkGridView, SingleSessionGridDropZone } from "./WorkGridView";
import { fgTint } from "../lanes/laneDesignTokens";

const EMPTY_GRID_SETS: WorkGridSet[] = [];
import { TerminalView } from "./TerminalView";
import { ToolLogo } from "./ToolLogos";
import { AgentChatPane, type AgentChatSessionCreatedOptions } from "../chat/AgentChatPane";
import { ChatCommandMenu, handleCommandMenuKeyDown, type ChatCommandMenuHandle, type ChatCommandMenuItem } from "../chat/ChatCommandMenu";
import {
  composerTriggerSpansWholeDraft,
  detectComposerTrigger,
  replaceComposerTriggerSpan,
  type ComposerTrigger,
} from "../../../shared/composerTriggers";
import { ChatComposerShell } from "../chat/ChatComposerShell";
import { CliLaunchChips } from "./CliLaunchChips";
import { WorkStartSurface } from "./WorkStartSurface";
import { hasPendingComposerDock } from "../chat/launch/chatLaunchDock";
import { WorkToolPickerBackdrop } from "./WorkToolPickerBackdrop";
import { useBackgroundContextMenu } from "../../scene/BackgroundContextMenu";
import { CliSessionWorkSurfaceHeader } from "./CliSessionWorkSurfaceHeader";
import { CliActionsScope, CliActionsSidePane, CliActionsToggle, CliPromptSlot } from "./CliAgentPane";
import { CliInputModeToggle, WorkCliInputBox } from "./WorkCliInputBox";
import { isTrackedAgentCliToolType } from "../../../shared/types";
import {
  CLI_CONTINUE_DRAFT_CHANGED_EVENT,
  moveCliInputQueueToContinueDraft,
  useCliInputMode,
} from "./cliInputBoxState";
import { useWorkSidebarTool } from "./useWorkSidebarTool";
import { isChatToolType, primarySessionLabel, providerFromChatToolType, stripTerminalLabelControls, formatToolTypeLabel } from "../../lib/sessions";
import { SmartTooltip } from "../ui/SmartTooltip";
import { cn } from "../ui/cn";
import {
  launchProfileForTerminalSession,
  mergeContinuationLaunch,
  recoverImportedContinuationLaunch,
  type WorkPtyLaunchArgs,
  type WorkPtyLaunchResult,
} from "./cliLaunch";
import type {
  ExternalSessionImportResult,
  ExternalSessionSource,
  ExternalSessionSummary,
} from "./importSessions/contract";
import { useWorkLaneContextMenu } from "./useWorkLaneContextMenu";
import { copyLaunchPromptToClipboard } from "../../lib/launchPromptClipboard";
import { isImeComposing } from "../../lib/imeComposition";
import { NO_CHAT_MACHINE_MESSAGE, withChatPin } from "../chat/chatMachinePin";

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

/** The most rows an ended session's replayed transcript shows, newest last. */
const ENDED_PREVIEW_MAX_ROWS = 400;

/** Whether the ended pane shows the machine's stored screen rows. */
function previewShowsSnapshot(preview: ChatTerminalPreviewResult | null): boolean {
  const rows = preview?.snapshot?.visibleRows ?? [];
  return rows.length > 0 && (
    preview?.session?.status === "running"
    || !preview?.transcript
    || snapshotLooksLikeTui(rows)
  );
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
    <div className="min-h-0 flex-1 overflow-auto rounded-md border border-fg/[0.06] bg-black/20 p-3 font-mono text-[11px] leading-relaxed text-fg/75">
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
  if (provider === "muse") return PROVIDER_DISPLAY_NAME.muse;
  if (provider === "opencode") return "OpenCode";
  return "agent CLI";
}

// The continue box's unsent text, per session, so switching tabs or tiles does
// not lose it. The component is keyed by session id, so one instance only ever
// reads and writes its own session's key.
const CLI_CONTINUE_DRAFT_KEY_PREFIX = "ade.work.cliContinueDraft.";

function readCliContinueDraft(sessionId: string): string {
  try {
    return window.localStorage.getItem(`${CLI_CONTINUE_DRAFT_KEY_PREFIX}${sessionId}`) ?? "";
  } catch {
    return "";
  }
}

function writeCliContinueDraft(sessionId: string, text: string): void {
  try {
    const key = `${CLI_CONTINUE_DRAFT_KEY_PREFIX}${sessionId}`;
    if (text.trim()) window.localStorage.setItem(key, text);
    else window.localStorage.removeItem(key);
  } catch {
    // Storage full or unavailable: the draft just is not kept.
  }
}

function WorkCliContinuationComposer({
  session,
  runtimePin,
  onContinue,
}: {
  session: TerminalSessionSummary;
  runtimePin: OpenProjectBinding | null;
  onContinue?: (
    session: TerminalSessionSummary,
    text: string,
    launch: TerminalResumeLaunchConfig | null,
  ) => Promise<void> | void;
}) {
  const provider = continuationProviderForSession(session);
  const providerLabel = continuationProviderLabel(provider);
  // Mirror the active chat composer's model pill: resolve the model the session was
  // launched with (recorded on its resume metadata) so we show the same glyph + name.
  const storedLaunch = session.resumeMetadata?.launch ?? null;
  const importedProvider = session.resumeMetadata?.importedFrom?.provider ?? null;
  const importedTargetId = session.resumeMetadata?.importedFrom?.targetId?.trim() || "";
  const storedLaunchFingerprint = JSON.stringify([
    storedLaunch?.model ?? null,
    storedLaunch?.reasoningEffort ?? null,
    storedLaunch?.fastMode ?? null,
    storedLaunch?.codexFastMode ?? null,
    storedLaunch?.permissionMode ?? null,
    storedLaunch?.codexApprovalPolicy ?? null,
    storedLaunch?.codexSandbox ?? null,
    storedLaunch?.codexConfigSource ?? null,
  ]);
  const storedLaunchRef = useRef(storedLaunch);
  storedLaunchRef.current = storedLaunch;
  const recoveryIdentity = `${session.id}:${provider ?? ""}:${importedProvider ?? ""}:${importedTargetId}:${storedLaunchFingerprint}`;
  const appliedRecoveryIdentityRef = useRef<string | null>(null);
  const [resolvedLaunch, setResolvedLaunch] = useState<TerminalResumeLaunchConfig | null>(storedLaunch);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const commandMenuRef = useRef<ChatCommandMenuHandle | null>(null);
  const [draft, setDraft] = useState(() => readCliContinueDraft(session.id));
  useEffect(() => {
    writeCliContinueDraft(session.id, draft);
  }, [draft, session.id]);
  // Texts the running CLI's input box still had waiting when the CLI ended
  // land here, where sending continues the session.
  useEffect(() => {
    const reread = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string }>).detail;
      if (detail?.sessionId === session.id) setDraft(readCliContinueDraft(session.id));
    };
    window.addEventListener(CLI_CONTINUE_DRAFT_CHANGED_EVENT, reread);
    moveCliInputQueueToContinueDraft(session.id);
    return () => window.removeEventListener(CLI_CONTINUE_DRAFT_CHANGED_EVENT, reread);
  }, [session.id]);
  const [slashCommands, setSlashCommands] = useState<AgentChatSlashCommand[]>([]);
  const [commandMenuTrigger, setCommandMenuTrigger] = useState<ComposerTrigger | null>(null);
  const [commandMenuAnchor, setCommandMenuAnchor] = useState<CommandMenuAnchor | null>(null);
  const [sending, setSending] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const launchPromptClipboardEnabled = useAppStore((s) => s.launchPromptClipboardEnabled);

  useEffect(() => {
    let cancelled = false;
    const currentStoredLaunch = storedLaunchRef.current;
    if (appliedRecoveryIdentityRef.current !== recoveryIdentity) {
      appliedRecoveryIdentityRef.current = recoveryIdentity;
      setResolvedLaunch(currentStoredLaunch);
    }
    // Historical imports often stored only one launch field (or an empty
    // object), so the presence of a permission or fast-mode value must not
    // prevent recovery of the model and reasoning effort.
    if (provider !== "codex" || (
      currentStoredLaunch?.model?.trim()
      && currentStoredLaunch?.reasoningEffort?.trim()
      && (currentStoredLaunch?.permissionMode || (
        currentStoredLaunch?.codexApprovalPolicy && currentStoredLaunch?.codexSandbox
      ))
    )) return () => {
      cancelled = true;
    };
    // Native provider history is machine-local: the lookup reads the session's
    // own machine. With no machine known, the stored launch stands.
    const request = runtimePin
      ? recoverImportedContinuationLaunch(provider, importedProvider, importedTargetId, runtimePin)
      : null;
    if (!request) return () => {
      cancelled = true;
    };
    void request.then((launch) => {
      if (!cancelled && launch) setResolvedLaunch(mergeContinuationLaunch(launch, currentStoredLaunch));
    }).catch(() => {
      // The native provider transcript may have moved or been compressed.
      // Continuing still uses the durable stored resume command.
    });
    return () => {
      cancelled = true;
    };
  }, [importedProvider, importedTargetId, provider, recoveryIdentity, runtimePin]);

  useEffect(() => {
    let cancelled = false;
    setSlashCommands([]);
    if (!provider) return () => {
      cancelled = true;
    };
    const args = { laneId: session.laneId, provider };
    void (withChatPin(runtimePin, (chatPin) => window.ade.agentChat.slashCommands(args, chatPin)))
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
  }, [provider, runtimePin, session.laneId]);

  const updateDraft = useCallback((next: string, element: HTMLTextAreaElement | null) => {
    setDraft(next);
    setSubmitError(null);
    // This composer has no file search (sessionId is null), so only slash
    // triggers open the menu — but they open anywhere in the draft.
    const trigger = detectComposerTrigger(next, element?.selectionStart ?? next.length);
    if (trigger?.type === "slash") {
      setCommandMenuTrigger(trigger);
      const anchor = getCommandMenuAnchor(element);
      if (anchor) setCommandMenuAnchor(anchor);
      return;
    }
    setCommandMenuTrigger(null);
  }, []);

  const handleCommandSelect = useCallback((item: ChatCommandMenuItem) => {
    if (item.type !== "command" || !commandMenuTrigger) return;
    const command = slashCommands.find((candidate) => candidate.name.replace(/^\//, "") === item.name);
    const argumentHint = command?.argumentHint && composerTriggerSpansWholeDraft(draft, commandMenuTrigger)
      ? ` ${command.argumentHint}`
      : "";
    const next = replaceComposerTriggerSpan(draft, commandMenuTrigger, `/${item.name}${argumentHint} `);
    setDraft(next.text);
    setCommandMenuTrigger(null);
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus({ preventScroll: true });
      try {
        node.setSelectionRange(next.caret, next.caret);
      } catch {
        // selection may not apply if the node is detached; ignore
      }
    });
  }, [commandMenuTrigger, draft, slashCommands]);

  const submit = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setSubmitError(null);
    try {
      if (launchPromptClipboardEnabled) {
        void copyLaunchPromptToClipboard(text);
      }
      await onContinue?.(session, text, resolvedLaunch);
      setDraft("");
      setCommandMenuTrigger(null);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }, [draft, launchPromptClipboardEnabled, onContinue, resolvedLaunch, sending, session]);

  // Auto-grow from a single-line height (matches the active chat composer): start
  // thin and expand with the draft, capped so the transcript above keeps the room.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  return (
    <div className="shrink-0">
      <ChatComposerShell
        mode="standard"
        className="mx-auto w-full max-w-[var(--chat-column,46rem)]"
        footer={(
          <div className="flex min-h-10 flex-wrap items-center justify-between gap-2 px-2.5 py-1.5">
            <CliLaunchChips launch={resolvedLaunch} providerLabel={providerLabel} />
            <button
              type="button"
              disabled={sending || !draft.trim()}
              onClick={() => void submit()}
              aria-label="Send"
              className={cn(
                "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-all",
                sending || !draft.trim()
                  ? "bg-fg/[0.06] text-muted-fg/20"
                  : "bg-white/90 text-zinc-900 hover:bg-white",
              )}
            >
              {sending ? <SpinnerGap size={14} className="animate-spin" /> : <ArrowUp size={14} weight="bold" />}
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
            // Enter with the menu open but nothing matching closes the menu
            // instead of sending a half-typed `/comp` to the CLI; a second
            // Enter sends the text as typed.
            if (commandMenuTrigger && event.key === "Enter" && !event.shiftKey && !isImeComposing(event)) {
              event.preventDefault();
              setCommandMenuTrigger(null);
              return;
            }
            if (event.key === "Enter" && !event.shiftKey && !isImeComposing(event)) {
              event.preventDefault();
              void submit();
            }
          }}
          className="block w-full resize-none overflow-y-auto bg-transparent px-4 py-2.5 text-[length:calc(var(--chat-font-size)*13/14)] leading-[1.6] text-fg/88 outline-none placeholder:text-muted-fg/35 disabled:cursor-not-allowed disabled:opacity-60"
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
  runtimePin = null,
  layoutVariant,
  onInfoClick,
  onContextMenu,
  onContinue,
  onResume,
  onToggleToolsPane,
  toolsPaneOpen,
  onOpenFullView,
}: {
  session: TerminalSessionSummary;
  lanes: LaneSummary[];
  runtimePin?: OpenProjectBinding | null;
  layoutVariant: "standard" | "grid-tile";
  onOpenFullView?: () => void;
  onInfoClick?: (session: TerminalSessionSummary, event: React.MouseEvent<HTMLElement>) => void;
  onContextMenu?: (session: TerminalSessionSummary, event: React.MouseEvent<HTMLElement>) => void;
  onContinue?: (
    session: TerminalSessionSummary,
    text: string,
    launch: TerminalResumeLaunchConfig | null,
  ) => Promise<void> | void;
  onResume?: (session: TerminalSessionSummary) => Promise<void> | void;
  onToggleToolsPane?: () => void;
  toolsPaneOpen?: boolean;
}) {
  const [preview, setPreview] = useState<ChatTerminalPreviewResult | null>(null);
  const [replayedRows, setReplayedRows] = useState<TerminalSnapshotRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
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
    setReplayedRows(null);
    setError(null);
    const args = { terminalId: session.id, maxBytes: 160_000 };
    void (runtimePin
      ? window.ade.terminal.preview(args, runtimePin)
      : Promise.reject(new Error(NO_CHAT_MACHINE_MESSAGE)))
      .then(async (result) => {
        if (cancelled) return;
        setPreview(result);
        // A full-screen CLI that exited left only the normal screen behind, and
        // its raw transcript is cursor moves with the spaces left out. Play the
        // transcript into an off-screen terminal to show the rows it drew.
        const transcript = result.transcript ?? "";
        if (previewShowsSnapshot(result) || !transcriptUsesAlternateScreen(transcript)) return;
        const rows = await previewRowsFromTranscript(transcript, result.snapshot?.cols ?? 100, ENDED_PREVIEW_MAX_ROWS);
        if (!cancelled) setReplayedRows(rows);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [runtimePin, session.id, session.endedAt, session.status]);

  const useSnapshotPreview = previewShowsSnapshot(preview);
  const previewRows = useSnapshotPreview ? preview?.snapshot?.visibleRows ?? [] : replayedRows;
  const transcriptText = stripTerminalControls(preview?.transcript ?? "").trimEnd()
    || session.lastOutputPreview
    || session.summary
    || "No transcript was captured for this session.";

  const agentCli = Boolean(session.tracked && isTrackedAgentCliToolType(session.toolType));
  return (
    <CliActionsScope session={session} runtimePin={runtimePin} enabled={agentCli}>
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-[color:var(--chat-canvas-bg)]">
      {layoutVariant !== "grid-tile" ? (
        <CliSessionWorkSurfaceHeader
          session={session}
          lanes={lanes}
          onInfoClick={onInfoClick}
          onContextMenu={onContextMenu}
          onToggleToolsPane={onToggleToolsPane}
          toolsPaneOpen={toolsPaneOpen}
          onOpenFullView={onOpenFullView}
          leadingTrailingAction={agentCli ? <CliActionsToggle /> : undefined}
        />
      ) : null}
      <div className="relative flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-4 py-3">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-fg/[0.06] pb-2">
          <div className="min-w-0 truncate text-[11px] text-muted-fg/60">
            {endedLabel}
            {exitLabel ? ` · ${exitLabel}` : ""}
          </div>
          {showComposer && onResume ? (
            <button
              type="button"
              disabled={resuming}
              onClick={() => void handleResume()}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-emerald-300/25 bg-emerald-500/[0.12] px-2.5 text-[11px] font-medium text-emerald-100 transition-colors hover:border-emerald-300/40 hover:bg-emerald-500/[0.18] disabled:cursor-not-allowed disabled:opacity-45"
            >
              {resuming ? <SpinnerGap size={13} className="animate-spin" /> : <ArrowClockwise size={13} weight="bold" />}
              Resume
            </button>
          ) : null}
        </div>
        {error || resumeError ? (
          <div className="shrink-0 rounded-md border border-red-500/20 bg-red-500/5 px-3 py-2 text-[11px] text-red-300">
            {resumeError ?? error}
          </div>
        ) : null}
        {previewRows?.length ? (
          <TerminalSnapshotTranscript rows={previewRows} />
        ) : (
          <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-md border border-fg/[0.06] bg-black/20 p-3 font-mono text-[11px] leading-relaxed text-fg/75">
            {transcriptText}
          </pre>
        )}
        {showComposer ? (
          <WorkCliContinuationComposer
            key={session.id}
            session={session}
            runtimePin={runtimePin}
            onContinue={onContinue}
          />
        ) : null}
        {agentCli && layoutVariant !== "grid-tile" ? <CliActionsSidePane /> : null}
      </div>
    </div>
    </CliActionsScope>
  );
}

/**
 * CLI session work surface: the header + PTY terminal. The PR pill opens the
 * per-lane PR tools tab and does not overlay the terminal.
 */
function CliSessionSurface({
  session,
  lanes,
  runtimePin = null,
  stopping = false,
  layoutVariant = "standard",
  surfaceActive,
  pageActive,
  terminalVisible,
  onInfoClick,
  onContextMenu,
  onStopRunningSession,
  onToggleToolsPane,
  toolsPaneOpen,
  onOpenFullView,
}: {
  session: TerminalSessionSummary & { ptyId: string };
  onOpenFullView?: () => void;
  lanes: LaneSummary[];
  /** See `SessionSurface.runtimePin`. */
  runtimePin?: OpenProjectBinding | null;
  stopping?: boolean;
  layoutVariant?: "standard" | "grid-tile";
  surfaceActive: boolean;
  pageActive: boolean;
  terminalVisible: boolean;
  onInfoClick?: (session: TerminalSessionSummary, event: React.MouseEvent<HTMLElement>) => void;
  onContextMenu?: (session: TerminalSessionSummary, event: React.MouseEvent<HTMLElement>) => void;
  onStopRunningSession?: (session: TerminalSessionSummary) => void;
  onToggleToolsPane?: () => void;
  toolsPaneOpen?: boolean;
}) {
  const workSidebar = useWorkSidebarTool(session.laneId, runtimePin);
  // The ADE input box is for a tracked agent CLI only; a raw CLI ADE does not
  // track has no prompt ADE can tell is free.
  const inputBoxAvailable = session.tracked && isTrackedAgentCliToolType(session.toolType);
  const inputMode = useCliInputMode();
  const showInputBox = inputBoxAvailable && inputMode === "box";
  const inputProvider = continuationProviderForSession(session);
  const showSidePane = inputBoxAvailable && layoutVariant !== "grid-tile";
  return (
    <CliActionsScope session={session} runtimePin={runtimePin} enabled={inputBoxAvailable}>
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      {layoutVariant !== "grid-tile" ? (
        <CliSessionWorkSurfaceHeader
          session={session}
          lanes={lanes}
          stopping={stopping}
          onInfoClick={onInfoClick}
          onContextMenu={onContextMenu}
          onStopRunningSession={onStopRunningSession}
          onToggleToolsPane={onToggleToolsPane}
          toolsPaneOpen={toolsPaneOpen}
          onOpenFullView={onOpenFullView}
          onTogglePrPane={session.laneId ? () => workSidebar.setTool("pr") : undefined}
          prPaneOpen={workSidebar.tool === "pr"}
          runtimePin={runtimePin}
          prBadgeOnly
          leadingTrailingAction={inputBoxAvailable ? (
            <>
              <CliActionsToggle />
              <CliInputModeToggle sessionId={session.id} />
            </>
          ) : undefined}
        />
      ) : null}
      <div className="relative min-h-0 w-full flex-1 overflow-hidden">
        <TerminalView
          key={session.id}
          ptyId={session.ptyId}
          sessionId={session.id}
          isActive={surfaceActive}
          isVisible={pageActive && terminalVisible}
          runtimePin={runtimePin}
          toolType={session.toolType}
          imagePasteMode="agent-cli"
          className="h-full w-full"
        />
        {showSidePane ? <CliActionsSidePane /> : null}
      </div>
      <CliPromptSlot>
      {showInputBox ? (
        <WorkCliInputBox
          key={session.id}
          sessionId={session.id}
          laneId={session.laneId || null}
          provider={inputProvider}
          providerLabel={continuationProviderLabel(inputProvider)}
          runtimeState={session.runtimeState}
          pin={runtimePin}
          autoFocus={surfaceActive}
          launch={session.resumeMetadata?.launch ?? null}
        />
      ) : null}
      </CliPromptSlot>
    </div>
    </CliActionsScope>
  );
}

export function SessionSurface({
  session,
  sessionTitleById,
  lanes,
  isActive,
  runtimePin,
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
  onToggleToolsPane,
  toolsPaneOpen,
  onToggleTerminalPane,
  onOpenTerminalPane,
  terminalPaneOpen,
  onOpenFullView,
}: {
  session: TerminalSessionSummary;
  sessionTitleById?: ReadonlyMap<string, string>;
  lanes: LaneSummary[];
  isActive: boolean;
  /**
   * Set only for a session that lives on another open binding; `null` means the
   * tab's own machine (the hot path — same calls as before per-session routing).
   * ADE chats take this pin too: after a dropdown switch the live union is
   * empty, so deriving from the lane would unpin send/history onto the new tab.
   */
  runtimePin?: OpenProjectBinding | null;
  pageActive?: boolean;
  shouldAutofocus?: boolean;
  layoutVariant?: "standard" | "grid-tile";
  terminalVisible?: boolean;
  onInfoClick?: (session: TerminalSessionSummary, event: React.MouseEvent<HTMLElement>) => void;
  onContextMenu?: (session: TerminalSessionSummary, event: React.MouseEvent<HTMLElement>) => void;
  onStopRunningSession?: (session: TerminalSessionSummary) => void;
  stopping?: boolean;
  onOpenChatSession: (session: AgentChatSession, options?: AgentChatSessionCreatedOptions) => void | Promise<void>;
  onContinueCliSession?: (
    session: TerminalSessionSummary,
    text: string,
    launch: TerminalResumeLaunchConfig | null,
  ) => Promise<void> | void;
  onResumeCliSession?: (session: TerminalSessionSummary) => Promise<void> | void;
  /** Far-right Tools-pane toggle (per-surface header now owns it). */
  onToggleToolsPane?: () => void;
  toolsPaneOpen?: boolean;
  onToggleTerminalPane?: () => void;
  onOpenTerminalPane?: () => void;
  terminalPaneOpen?: boolean;
  /** Focus grid: "open in full view" replaces the Tools toggle in the header. */
  onOpenFullView?: () => void;
}) {
  const isChat = isChatToolType(session.toolType);
  const surfaceActive = pageActive && isActive;
  // Visibility is decoupled from active ownership. `terminalVisible` means "keep
  // this surface rendered and streaming" and defaults to `isActive`, so the
  // single-session/tab callers that omit it are unchanged. The grid passes
  // `terminalVisible` for every tile, so all tiles stay visible while only the
  // focused one (session.id === activeItemId) is active.
  const surfaceVisible = pageActive && terminalVisible;
  if (isChat) {
    return (
      <AgentChatPane
        laneId={session.laneId}
        laneLabel={session.laneName}
        lockSessionId={session.id}
        // The row knows the provider on the switch frame; the pane does not (see
        // AgentChatPane's `lockSessionProvider` doc).
        lockSessionProvider={providerFromChatToolType(session.toolType)}
        sessionTitleById={sessionTitleById}
        hideSessionTabs
        hideLaneToolDrawers
        runtimePin={runtimePin}
        onSessionCreated={onOpenChatSession}
        layoutVariant={layoutVariant}
        isTileActive={surfaceActive}
        isTileVisible={surfaceVisible}
        shouldAutofocusComposer={surfaceActive && shouldAutofocus}
        onToggleToolsPane={onToggleToolsPane}
        toolsPaneOpen={toolsPaneOpen}
        onOpenFullView={onOpenFullView}
        onToggleTerminalPane={onToggleTerminalPane}
        onOpenTerminalPane={onOpenTerminalPane}
        terminalPaneOpen={terminalPaneOpen}
      />
    );
  }
  if (isRunningPtySession(session)) {
    if (isAgentCliSession(session)) {
      return (
        <CliSessionSurface
          session={session}
          lanes={lanes}
          runtimePin={runtimePin}
          stopping={stopping}
          layoutVariant={layoutVariant}
          surfaceActive={surfaceActive}
          pageActive={pageActive}
          terminalVisible={terminalVisible}
          onInfoClick={onInfoClick}
          onContextMenu={onContextMenu}
          onStopRunningSession={onStopRunningSession}
          onToggleToolsPane={onToggleToolsPane}
          toolsPaneOpen={toolsPaneOpen}
          onOpenFullView={onOpenFullView}
        />
      );
    }
    // A plain shell used to be the one Work surface with no header at all —
    // and therefore the one surface you could not open the Tools pane from,
    // even though a shell is exactly where you want Git or the browser beside
    // you. It gets the same header every other CLI surface has; only the
    // terminal's own paste behaviour stays shell-specific.
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
            onToggleToolsPane={onToggleToolsPane}
            toolsPaneOpen={toolsPaneOpen}
            onOpenFullView={onOpenFullView}
            runtimePin={runtimePin}
          />
        ) : null}
        <div className="min-h-0 w-full flex-1 overflow-hidden">
          <TerminalView
            key={session.id}
            ptyId={session.ptyId}
            sessionId={session.id}
            isActive={surfaceActive}
            isVisible={pageActive && terminalVisible}
            runtimePin={runtimePin}
            toolType={session.toolType}
            className="h-full w-full"
          />
        </div>
      </div>
    );
  }

  if (isAgentCliSession(session)) {
    return (
      <ClosedCliSessionSurface
        session={session}
        lanes={lanes}
        runtimePin={runtimePin}
        layoutVariant={layoutVariant}
        onInfoClick={onInfoClick}
        onContextMenu={onContextMenu}
        onContinue={onContinueCliSession}
        onResume={onResumeCliSession}
        onToggleToolsPane={onToggleToolsPane}
        toolsPaneOpen={toolsPaneOpen}
        onOpenFullView={onOpenFullView}
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
        background: `radial-gradient(circle at top, ${fgTint(5)} 0%, transparent 42%), var(--color-card)`,
      }}
    >
      <div className="ade-liquid-glass-menu flex w-full max-w-md flex-col gap-4 rounded-lg px-5 py-5">
        {/* Header: tool logo + session name */}
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md" style={{ background: fgTint(5) }}>
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

const WORK_AREA_MODE_TRANSITION = { duration: 0.3, ease: STANDARD_EASE } as const;
const WORK_AREA_DOCK_TRANSITION = { duration: 0.14, ease: STANDARD_EASE } as const;

/** `custom` = the switch is a composer dock (no blur, quick swap). */
const WORK_AREA_MODE_VARIANTS = {
  enter: (dock: boolean) => (dock
    ? { opacity: 1, filter: "blur(0px)", scale: 1 }
    : { opacity: 0, filter: "blur(12px)", scale: 0.992 }),
  visible: { opacity: 1, filter: "blur(0px)", scale: 1, transition: WORK_AREA_MODE_TRANSITION },
  exit: (dock: boolean) => (dock
    ? { opacity: 0, filter: "blur(0px)", scale: 1, transition: WORK_AREA_DOCK_TRANSITION }
    : { opacity: 0, filter: "blur(12px)", scale: 0.992, transition: WORK_AREA_MODE_TRANSITION }),
};

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
    <div className="ade-liquid-glass-pill inline-flex items-center gap-1 rounded-full p-1" data-onboarding-anchor="draft-mode-switch">
      {MODE_OPTIONS.map((opt) => {
        const active = draftKind === opt.kind;
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
                "inline-flex min-h-[36px] items-center gap-2 rounded-full px-4 py-2 text-[12px] font-medium transition-all",
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
              <Icon size={14} weight="regular" className="shrink-0 opacity-80" />
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
  draftMachineId = null,
  draftContextTargetId = null,
  onContinueCliSession,
  onResumeCliSession,
  onSelectItem,
  onCloseItem: _onCloseItem,
  onOpenChatSession,
  onLaunchPtySession,
  onImportedSession,
  onOpenExistingImportedSession,
  onDraftLaneChange,
  onDraftMachineChange,
  onShowDraftKind,
  closingPtyIds,
  onContextMenu,
  workSidebarOpen = false,
  onToggleWorkSidebar,
  terminalPaneOpen = false,
  onToggleTerminalPane,
  onOpenTerminalPane,
  initialLinearIssueContext = null,
  initialLinearIssueContextSource = "lane_link",
  initialModelId = null,
  onInitialLinearIssueContextConsumed,
  suppressDraftLaunchNavigation = false,
  onGoToLane: _onGoToLane,
  onInfoClick,
  onStopRunningSession,
  gridSets = EMPTY_GRID_SETS,
  onAddSessionToGrid,
  onCreateGridFromSingle,
  onRemoveSessionFromGrid,
  resolveSessionRuntimePin,
}: {
  pageActive?: boolean;
  lanes: LaneSummary[];
  /** Open-session cross-machine union; active and grid lookups must use it. */
  sessions: TerminalSessionSummary[];
  visibleSessions: TerminalSessionSummary[];
  activeItemId: string | null;
  draftKind: WorkDraftKind;
  draftLaneId?: string | null;
  draftMachineId?: string | null;
  draftContextTargetId?: string | null;
  onSelectItem: (sessionId: string) => void;
  onCloseItem: (sessionId: string) => void;
  onOpenChatSession: (session: AgentChatSession, options?: AgentChatSessionCreatedOptions) => void | Promise<void>;
  onLaunchPtySession: (args: WorkPtyLaunchArgs) => Promise<WorkPtyLaunchResult>;
  onImportedSession?: (
    summary: ExternalSessionSummary,
    result: ExternalSessionImportResult,
    source?: ExternalSessionSource,
  ) => void;
  onOpenExistingImportedSession?: (
    ref: { kind: "chat" | "cli"; sessionId: string },
    source?: ExternalSessionSource,
  ) => void;
  onDraftLaneChange?: (laneId: string) => void;
  onDraftMachineChange?: (machineId: string | null) => void;
  onShowDraftKind: (kind: WorkDraftKind) => void;
  closingPtyIds: Set<string>;
  onContextMenu?: (session: TerminalSessionSummary, e: React.MouseEvent) => void;
  onContinueCliSession?: (
    session: TerminalSessionSummary,
    text: string,
    launch: TerminalResumeLaunchConfig | null,
  ) => Promise<void> | void;
  onResumeCliSession?: (session: TerminalSessionSummary) => Promise<void> | void;
  onGoToLane?: (laneId: string) => void;
  workSidebarOpen?: boolean;
  onToggleWorkSidebar?: () => void;
  terminalPaneOpen?: boolean;
  onToggleTerminalPane?: () => void;
  onOpenTerminalPane?: () => void;
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
  /**
   * Per-session runtime routing: the binding a session's PTY calls must target,
   * or `null` when it lives on the machine the project tab is already bound to.
   *
   * The Work sidebar is a union across machines, so a CLI/shell surface here can
   * belong to another machine — it is opened in place and its calls carry this
   * pin instead of the tab being rebound. Omitted (or `null`) is the hot path
   * for every local terminal and is behaviorally identical to before.
   */
  resolveSessionRuntimePin?: (session: TerminalSessionSummary) => OpenProjectBinding | null;
}) {
  const { menu: laneContextMenuPortal } = useWorkLaneContextMenu();
  const theme = useAppStore((s) => s.theme);
  // Right-click on the new chat page's empty background.
  const draftBackgroundMenu = useBackgroundContextMenu();
  const sessionsById = useMemo(() => {
    const map = new Map<string, TerminalSessionSummary>();
    for (const session of sessions) map.set(session.id, session);
    return map;
  }, [sessions]);
  const sessionTitleById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session.title] as const)),
    [sessions],
  );

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
      sessionTitleById={sessionTitleById}
      lanes={lanes}
      // Exactly the focused grid member is active; every displayed tile stays
      // visible (terminalVisible) and keeps receiving live output. Only the
      // active tile accepts keyboard input / autofocus; pointer-down on a tile
      // transfers activeItemId (WorkGridView's onPaneMouseDown) before typing.
      isActive={session.id === activeItemId}
      pageActive={pageActive}
      runtimePin={resolveSessionRuntimePin?.(session)}
      shouldAutofocus={session.id === activeItemId}
      terminalVisible
      onInfoClick={onInfoClick}
      onContextMenu={onContextMenu}
      onStopRunningSession={onStopRunningSession}
      stopping={Boolean(session.ptyId && closingPtyIds.has(session.ptyId))}
      onOpenChatSession={onOpenChatSession}
      onContinueCliSession={onContinueCliSession}
      onResumeCliSession={onResumeCliSession}
      // One Tools pane serves the focused tile. Only that tile's toggle reads
      // open; another tile's toggle moves the pane to that chat rather than
      // closing it.
      onToggleToolsPane={onToggleWorkSidebar
        ? () => {
          if (session.id === activeItemId || !workSidebarOpen) {
            if (session.id !== activeItemId) onSelectItem(session.id);
            onToggleWorkSidebar();
            return;
          }
          onSelectItem(session.id);
        }
        : undefined}
      toolsPaneOpen={workSidebarOpen && session.id === activeItemId}
      onToggleTerminalPane={onToggleTerminalPane}
      onOpenTerminalPane={onOpenTerminalPane}
      terminalPaneOpen={terminalPaneOpen}
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
        className="ade-work-grid-tiling h-full min-h-0"
      />
    ) : workAreaMode === "single" && activeSession ? (
      <SingleSessionGridDropZone
        targetSessionId={activeSession.id}
        onDropSession={(dragged, edge) => onCreateGridFromSingle?.(dragged, activeSession.id, edge)}
      >
        <SessionSurface
          session={activeSession}
          sessionTitleById={sessionTitleById}
          lanes={lanes}
          isActive
          pageActive={pageActive}
          runtimePin={resolveSessionRuntimePin?.(activeSession)}
          terminalVisible
          onInfoClick={onInfoClick}
          onContextMenu={onContextMenu}
          onStopRunningSession={onStopRunningSession}
          stopping={Boolean(activeSession.ptyId && closingPtyIds.has(activeSession.ptyId))}
          onOpenChatSession={onOpenChatSession}
          onContinueCliSession={onContinueCliSession}
          onResumeCliSession={onResumeCliSession}
          onToggleToolsPane={onToggleWorkSidebar}
          toolsPaneOpen={workSidebarOpen}
          onToggleTerminalPane={onToggleTerminalPane}
          onOpenTerminalPane={onOpenTerminalPane}
          terminalPaneOpen={terminalPaneOpen}
        />
      </SingleSessionGridDropZone>
    ) : (
      <div
        className="relative flex h-full min-h-0 flex-col overflow-hidden"
        data-work-draft-surface=""
        onContextMenu={draftBackgroundMenu.onContextMenu}
      >
        {draftBackgroundMenu.menu}
        {/* The new chat pane is part of the window gradient, so the top bar above
            flows into it with no seam. */}
        <WorkToolPickerBackdrop theme={theme} playing={pageActive} field="window" />
        <div className="relative z-10 flex shrink-0 items-center justify-center pb-8 pt-6">
          {/* Flies up off screen when a sent chat opens (`chatLaunchDock`). */}
          <div data-draft-depart="rise">
            <ModeSwitcherPills draftKind={draftKind} onShowDraftKind={onShowDraftKind} />
          </div>
        </div>
        <div className="relative z-10 min-h-0 flex-1">
          <WorkStartSurface
            draftKind={draftKind}
            draftLaneId={draftLaneId}
            draftMachineId={draftMachineId}
            draftContextTargetId={draftContextTargetId}
            lanes={lanes}
            onOpenChatSession={onOpenChatSession}
            onLaunchPtySession={onLaunchPtySession}
            onImportedSession={onImportedSession}
            onOpenExistingImportedSession={onOpenExistingImportedSession}
            onDraftLaneChange={onDraftLaneChange}
            onDraftMachineChange={onDraftMachineChange}
            initialLinearIssueContext={initialLinearIssueContext}
            initialLinearIssueContextSource={initialLinearIssueContextSource}
            initialModelId={initialModelId}
            onInitialLinearIssueContextConsumed={onInitialLinearIssueContextConsumed}
            suppressDraftLaunchNavigation={suppressDraftLaunchNavigation}
          />
        </div>
      </div>
    );

  // A foreground new-lane launch opens its chat while the draft composer is
  // still on screen. That one switch skips the blur dissolve: the chat's own
  // composer glides down from the draft's position (`chatLaunchDock`), so the
  // surface underneath just swaps quickly instead of blurring the glide away.
  const composerDockTransition = workAreaMode === "single" && hasPendingComposerDock(activeSession?.id);
  const tabBody = (
    <div className="relative min-h-0 flex-1" style={{ background: workAreaMode === "empty" ? "transparent" : "var(--chat-canvas-bg)" }}>
      <AnimatePresence initial={false} custom={composerDockTransition}>
        <motion.div
          key={workAreaMode}
          className="absolute inset-0"
          custom={composerDockTransition}
          variants={WORK_AREA_MODE_VARIANTS}
          initial="enter"
          animate="visible"
          exit="exit"
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

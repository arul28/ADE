import { useMemo, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { AnimatePresence, motion } from "motion/react";
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
import { ModelRowLogo } from "../shared/ProviderLogos";
import { resolveModelDescriptorWithRuntimeCatalog, createUnknownModelPlaceholder } from "../shared/ModelPicker/modelCatalog";
import { WorkStartSurface } from "./WorkStartSurface";
import { CliSessionWorkSurfaceHeader } from "./CliSessionWorkSurfaceHeader";
import { ChatPrPane } from "../chat/ChatPrPane";
import { useChatPrAutoPop } from "../chat/useChatPrAutoPop";
import { isChatToolType, primarySessionLabel, stripTerminalLabelControls, formatToolTypeLabel } from "../../lib/sessions";
import { SmartTooltip } from "../ui/SmartTooltip";
import { cn } from "../ui/cn";
import {
  launchProfileForTerminalSession,
  mergeContinuationLaunch,
  recoverImportedContinuationLaunch,
  type WorkPtyLaunchArgs,
  type WorkPtyLaunchResult,
} from "./cliLaunch";
import type { ExternalSessionImportResult, ExternalSessionSummary } from "./importSessions/contract";
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

function continuationPermissionLabel(launch: TerminalResumeLaunchConfig | null): string | null {
  if (launch?.codexApprovalPolicy === "on-request") return "Ask first";
  if (launch?.codexApprovalPolicy === "on-failure") return "On failure";
  if (launch?.codexApprovalPolicy === "untrusted") return "Restricted";
  if (launch?.codexApprovalPolicy === "never" && launch.codexSandbox === "danger-full-access") return "Full access";
  const mode = launch?.permissionMode;
  if (mode === "full-auto") return "Full access";
  if (mode === "plan") return "Plan";
  if (mode === "edit") return "Edit";
  if (mode === "auto") return "Auto";
  if (mode === "config-toml") return "Config";
  if (mode === "default") return "Default";
  return null;
}

function WorkCliContinuationComposer({
  session,
  onContinue,
}: {
  session: TerminalSessionSummary;
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
  const modelId = resolvedLaunch?.model?.trim() || null;
  const modelDescriptor = modelId
    ? (resolveModelDescriptorWithRuntimeCatalog(modelId) ?? createUnknownModelPlaceholder(modelId))
    : null;
  const permissionLabel = continuationPermissionLabel(resolvedLaunch);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const commandMenuRef = useRef<ChatCommandMenuHandle | null>(null);
  const [draft, setDraft] = useState("");
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
    const request = recoverImportedContinuationLaunch(provider, importedProvider, importedTargetId);
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
  }, [importedProvider, importedTargetId, provider, recoveryIdentity]);

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
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              {modelDescriptor ? (
                <span className="inline-flex min-w-0 max-w-[min(12rem,42vw)] items-center gap-1.5 rounded-md border border-white/[0.06] bg-white/[0.03] px-2 py-1 text-[11px] text-fg/80">
                  <ModelRowLogo
                    modelFamily={modelDescriptor.family}
                    cliCommand={modelDescriptor.cliCommand}
                    modelId={modelDescriptor.id}
                    providerModelId={modelDescriptor.providerModelId}
                    size={13}
                    className="shrink-0"
                  />
                  <span className="min-w-0 truncate font-medium leading-none">{modelDescriptor.displayName}</span>
                </span>
              ) : (
                <span className="min-w-0 shrink truncate px-1 text-[11px] font-medium text-fg/70">{providerLabel}</span>
              )}
              {resolvedLaunch?.reasoningEffort ? (
                <span className="rounded-md border border-white/[0.06] bg-white/[0.03] px-1.5 py-1 text-[10px] font-semibold uppercase text-fg/65">
                  {resolvedLaunch.reasoningEffort}
                </span>
              ) : null}
              {(resolvedLaunch?.fastMode ?? resolvedLaunch?.codexFastMode) ? (
                <span className="rounded-md border border-amber-300/15 bg-amber-500/[0.06] px-1.5 py-1 text-[10px] font-semibold text-amber-100/80">
                  Fast
                </span>
              ) : null}
              {permissionLabel ? (
                <span className="rounded-md border border-white/[0.06] bg-white/[0.03] px-1.5 py-1 text-[10px] text-fg/60">
                  {permissionLabel}
                </span>
              ) : null}
            </div>
            <button
              type="button"
              disabled={sending || !draft.trim()}
              onClick={() => void submit()}
              aria-label="Send"
              className={cn(
                "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-all active:scale-[0.97]",
                sending || !draft.trim()
                  ? "bg-white/[0.06] text-muted-fg/20"
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
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
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
  layoutVariant,
  onInfoClick,
  onContextMenu,
  onContinue,
  onResume,
  onToggleSessionsPane,
  sessionsPaneCollapsed,
  sessionsPaneCount,
  onToggleToolsPane,
  toolsPaneOpen,
}: {
  session: TerminalSessionSummary;
  lanes: LaneSummary[];
  layoutVariant: "standard" | "grid-tile";
  onInfoClick?: (session: TerminalSessionSummary, event: React.MouseEvent<HTMLElement>) => void;
  onContextMenu?: (session: TerminalSessionSummary, event: React.MouseEvent<HTMLElement>) => void;
  onContinue?: (
    session: TerminalSessionSummary,
    text: string,
    launch: TerminalResumeLaunchConfig | null,
  ) => Promise<void> | void;
  onResume?: (session: TerminalSessionSummary) => Promise<void> | void;
  onToggleSessionsPane?: () => void;
  sessionsPaneCollapsed?: boolean;
  sessionsPaneCount?: number;
  onToggleToolsPane?: () => void;
  toolsPaneOpen?: boolean;
}) {
  const [preview, setPreview] = useState<ChatTerminalPreviewResult | null>(null);
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
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-[color:var(--chat-canvas-bg)]">
      {layoutVariant !== "grid-tile" ? (
        <CliSessionWorkSurfaceHeader
          session={session}
          lanes={lanes}
          onInfoClick={onInfoClick}
          onContextMenu={onContextMenu}
          onToggleSessionsPane={onToggleSessionsPane}
          sessionsPaneCollapsed={sessionsPaneCollapsed}
          sessionsPaneCount={sessionsPaneCount}
          onToggleToolsPane={onToggleToolsPane}
          toolsPaneOpen={toolsPaneOpen}
        />
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-4 py-3">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/[0.06] pb-2">
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

const CLI_PR_PANE_FADE = { duration: 0.16, ease: [0.4, 0, 0.2, 1] as const };
const CLI_FLOATING_PANE_CARD_CLASS =
  "ade-floating-side-pane flex w-full flex-col overflow-y-auto rounded-xl border border-white/[0.07] bg-[color:var(--work-sidebar-bg,#161618)] shadow-[0_20px_60px_-30px_rgba(0,0,0,0.8)]";

/**
 * CLI session work surface: the header + PTY terminal, with the floating PR pane
 * overlaid on top of the terminal. The overlay is absolutely positioned inside a
 * wrapper that sizes the terminal — it never changes the terminal host's box, so
 * the PTY's ResizeObserver never fires and the running CLI process is not
 * re-flowed (no SIGWINCH). The pill in the header toggles it, and it auto-pops on
 * webhook-driven PR changes via the same useChatPrAutoPop hook the ADE chat uses.
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
  onToggleSessionsPane,
  sessionsPaneCollapsed,
  sessionsPaneCount,
  onToggleToolsPane,
  toolsPaneOpen,
}: {
  session: TerminalSessionSummary & { ptyId: string };
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
  onToggleSessionsPane?: () => void;
  sessionsPaneCollapsed?: boolean;
  sessionsPaneCount?: number;
  onToggleToolsPane?: () => void;
  toolsPaneOpen?: boolean;
}) {
  // Persist the pane per CLI session so reopening the surface restores it, the
  // same way the ADE chat pane keys its companion UI state.
  const { prPaneOpen, setPrPaneOpen, prPaneDelta } = useChatPrAutoPop(session.laneId, {
    persistKey: session.id,
  });
  const supportsSplit = layoutVariant !== "grid-tile";
  const prFloating = prPaneOpen && Boolean(session.laneId) && supportsSplit;
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
          onTogglePrPane={session.laneId ? () => setPrPaneOpen((v) => !v) : undefined}
          prPaneOpen={prPaneOpen}
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
          imagePasteMode="runtime-attachment"
          className="h-full w-full"
        />
        <AnimatePresence initial={false}>
          {prFloating && session.laneId ? (
            <motion.div
              key="cli-pr-floating-pane"
              className="absolute left-3 top-3 z-20 flex max-h-[calc(100%-1.5rem)] w-[min(16.5rem,calc(100%-1.5rem))]"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={CLI_PR_PANE_FADE}
            >
              <div className={CLI_FLOATING_PANE_CARD_CLASS}>
                <ChatPrPane
                  laneId={session.laneId}
                  branchName={null}
                  delta={prPaneDelta}
                  onClose={() => setPrPaneOpen(false)}
                />
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}

function SessionSurface({
  session,
  sessionTitleById,
  lanes,
  isActive,
  runtimePin = null,
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
  onToggleTerminalPane,
  onOpenTerminalPane,
  terminalPaneOpen,
}: {
  session: TerminalSessionSummary;
  sessionTitleById?: ReadonlyMap<string, string>;
  lanes: LaneSummary[];
  isActive: boolean;
  /**
   * Set only for a session that lives on another open binding; `null` means the
   * tab's own machine (the hot path — same calls as before per-session routing).
   * The ADE chat pane resolves its own pin from the lane, so this is consumed by
   * the PTY surfaces only.
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
  /** Far-left session-list expander (per-surface header now owns it). */
  onToggleSessionsPane?: () => void;
  sessionsPaneCollapsed?: boolean;
  sessionsPaneCount?: number;
  /** Far-right Tools-pane toggle (per-surface header now owns it). */
  onToggleToolsPane?: () => void;
  toolsPaneOpen?: boolean;
  onToggleTerminalPane?: () => void;
  onOpenTerminalPane?: () => void;
  terminalPaneOpen?: boolean;
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
        sessionTitleById={sessionTitleById}
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
          onToggleSessionsPane={onToggleSessionsPane}
          sessionsPaneCollapsed={sessionsPaneCollapsed}
          sessionsPaneCount={sessionsPaneCount}
          onToggleToolsPane={onToggleToolsPane}
          toolsPaneOpen={toolsPaneOpen}
        />
      );
    }
    return (
      <TerminalView
        key={session.id}
        ptyId={session.ptyId}
        sessionId={session.id}
        isActive={surfaceActive}
        isVisible={pageActive && terminalVisible}
        runtimePin={runtimePin}
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
        onToggleSessionsPane={onToggleSessionsPane}
        sessionsPaneCollapsed={sessionsPaneCollapsed}
        sessionsPaneCount={sessionsPaneCount}
        onToggleToolsPane={onToggleToolsPane}
        toolsPaneOpen={toolsPaneOpen}
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
    <div className="ade-liquid-glass-pill inline-flex items-center gap-1 rounded-full p-1">
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
  orchestratorEnabled = false,
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
  sessionsPaneCollapsed = false,
  onToggleSessionsPane,
  sessionsPaneListCount = 0,
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
  sessions: TerminalSessionSummary[];
  visibleSessions: TerminalSessionSummary[];
  activeItemId: string | null;
  draftKind: WorkDraftKind;
  /** Orthogonal orchestrator flag for the chat draft (forwarded to the composer). */
  orchestratorEnabled?: boolean;
  draftLaneId?: string | null;
  draftMachineId?: string | null;
  draftContextTargetId?: string | null;
  onSelectItem: (sessionId: string) => void;
  onCloseItem: (sessionId: string) => void;
  onOpenChatSession: (session: AgentChatSession, options?: AgentChatSessionCreatedOptions) => void | Promise<void>;
  onLaunchPtySession: (args: WorkPtyLaunchArgs) => Promise<WorkPtyLaunchResult>;
  onImportedSession?: (summary: ExternalSessionSummary, result: ExternalSessionImportResult) => void;
  onOpenExistingImportedSession?: (ref: { kind: "chat" | "cli"; sessionId: string }) => void;
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
  /** Whether the work sessions list pane is collapsed. */
  sessionsPaneCollapsed?: boolean;
  onToggleSessionsPane?: () => void;
  sessionsPaneListCount?: number;
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
      runtimePin={resolveSessionRuntimePin?.(session) ?? null}
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
        className="ade-work-grid-tiling h-full min-h-0 px-2 pb-2"
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
          runtimePin={resolveSessionRuntimePin?.(activeSession) ?? null}
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
          onToggleTerminalPane={onToggleTerminalPane}
          onOpenTerminalPane={onOpenTerminalPane}
          terminalPaneOpen={terminalPaneOpen}
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
            orchestratorEnabled={orchestratorEnabled}
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

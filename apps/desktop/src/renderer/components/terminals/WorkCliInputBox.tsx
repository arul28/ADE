import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowClockwise,
  ArrowUp,
  CloudSlash,
  Keyboard,
  PencilSimple,
  SpinnerGap,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import type {
  AgentChatSlashCommand,
  OpenProjectBinding,
  TerminalResumeLaunchConfig,
  TerminalResumeProvider,
  TerminalRuntimeState,
} from "../../../shared/types";
import { CliLaunchChips } from "./CliLaunchChips";
import {
  composerFileSearchQuery,
  composerTriggerSpansWholeDraft,
  detectComposerTrigger,
  replaceComposerTriggerSpan,
  type ComposerTrigger,
} from "../../../shared/composerTriggers";
import { ChatCommandMenu, handleCommandMenuKeyDown, type ChatCommandMenuHandle, type ChatCommandMenuItem } from "../chat/ChatCommandMenu";
import { ChatComposerShell } from "../chat/ChatComposerShell";
import { useAppStore } from "../../state/appStore";
import { useRemoteConnectionSnapshot } from "../../state/projectMachines";
import { connectionOnline } from "../../state/laneMachineRouting";
import { effectiveRuntimeBinding } from "../../lib/chatMachineRouting";
import { isImeComposing } from "../../lib/imeComposition";
import { SmartTooltip } from "../ui/SmartTooltip";
import { cn } from "../ui/cn";
import { showToast } from "../app/toast/toastStore";
import {
  cliInputHistoryVersion,
  cliInputQueueSummary,
  enqueueCliInput,
  kickCliInputQueue,
  readCliInputDraft,
  readCliInputHistory,
  removeCliInput,
  retryCliInput,
  setCliInputMode,
  setCliInputRoute,
  useCliInputMode,
  useCliInputQueue,
  writeCliInputDraft,
  type CliInputQueueItem,
} from "./cliInputBoxState";

type CommandMenuAnchor = { top: number; left: number; bottom: number };

const DRAFT_SAVE_DELAY_MS = 400;
const MAX_BOX_HEIGHT_PX = 180;

function menuAnchor(element: HTMLElement | null): CommandMenuAnchor | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom, left: rect.left + 16 };
}

/** `@path` as the CLI reads it; a path with spaces is quoted so it stays one token. */
function pathMention(path: string): string {
  return /\s/.test(path) ? `@"${path}" ` : `@${path} `;
}

/**
 * Whether the CLI's machine is connected. Only a remote machine can be
 * offline; the snapshot is read only while the box is shown for one.
 */
function useCliMachineOffline(pin: OpenProjectBinding | null): { offline: boolean; machineName: string | null } {
  const projectBinding = useAppStore((s) => s.projectBinding);
  const binding = effectiveRuntimeBinding(pin, projectBinding);
  const remoteTargetId = binding?.kind === "remote" ? binding.targetId : null;
  const machineName = binding?.kind === "remote" ? binding.runtimeName : null;
  const { snapshot, loaded } = useRemoteConnectionSnapshot(remoteTargetId != null);
  const offline = useMemo(() => {
    if (!remoteTargetId || !loaded || !snapshot) return false;
    // Only a machine the snapshot lists, in a state other than connected, is
    // offline. One it does not list (the web client's own host) is left to
    // the call itself, whose refusal the queue reads the same way.
    const connection = snapshot.connections.find((entry) => entry.target?.id === remoteTargetId);
    return connection != null && !connectionOnline(connection);
  }, [loaded, remoteTargetId, snapshot]);
  return { offline, machineName };
}

/**
 * The header button that switches a running agent CLI between typing in the
 * terminal and the ADE input box. One choice for every CLI session; a dot
 * says texts are still waiting while the box is hidden.
 */
export const CliInputModeToggle = memo(function CliInputModeToggle({ sessionId }: { sessionId: string }) {
  const mode = useCliInputMode();
  const queue = useCliInputQueue(sessionId);
  const { waiting, needsAttention } = cliInputQueueSummary(queue);
  const boxOn = mode === "box";
  const label = boxOn ? "Type in the terminal" : "Use the input box";
  return (
    <SmartTooltip content={{ label, description: boxOn ? "Hide the input box and type straight into the CLI." : "Write in an ADE box with history, @files and a queue; the terminal stays usable." }}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={boxOn}
        onClick={() => setCliInputMode(boxOn ? "terminal" : "box")}
        className={cn(
          "relative inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors",
          boxOn ? "bg-fg/[0.08] text-fg/85" : "text-muted-fg/70 hover:bg-fg/[0.06] hover:text-fg/85",
        )}
        data-testid="work-cli-input-mode-toggle"
      >
        <Keyboard size={15} weight={boxOn ? "fill" : "regular"} />
        {!boxOn && waiting > 0 ? (
          <span
            aria-hidden
            className={cn(
              "absolute right-1 top-1 h-1.5 w-1.5 rounded-full",
              needsAttention ? "bg-amber-300" : "bg-sky-300",
            )}
          />
        ) : null}
      </button>
    </SmartTooltip>
  );
});

function queueItemLabel(item: CliInputQueueItem, providerLabel: string, machineName: string | null): string {
  if (item.state === "sending") return "Typing it now…";
  if (item.state === "offline") {
    return machineName
      ? `Sends when ${machineName} reconnects`
      : "Sends when the computer reconnects";
  }
  if (item.state === "unconfirmed" || item.state === "failed") return item.error ?? "Not sent.";
  return `Queued · sends when ${providerLabel} is free`;
}

function QueueRow({
  item,
  providerLabel,
  machineName,
  onEdit,
  onCancel,
  onRetry,
}: {
  item: CliInputQueueItem;
  providerLabel: string;
  machineName: string | null;
  onEdit: (item: CliInputQueueItem) => void;
  onCancel: (item: CliInputQueueItem) => void;
  onRetry: (item: CliInputQueueItem) => void;
}) {
  const problem = item.state === "failed" || item.state === "unconfirmed";
  const sending = item.state === "sending";
  return (
    <div className="flex min-w-0 items-start gap-2 px-3 py-1.5" data-testid="work-cli-input-queued">
      <span className="mt-0.5 shrink-0">
        {sending ? (
          <SpinnerGap size={12} className="animate-spin text-sky-200/80" />
        ) : item.state === "offline" ? (
          <CloudSlash size={12} className="text-muted-fg/60" />
        ) : problem ? (
          <WarningCircle size={12} className="text-amber-300/90" />
        ) : (
          <span className="mt-[3px] block h-1.5 w-1.5 rounded-full bg-sky-300/70" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] text-fg/80">{item.text.split("\n")[0]}</div>
        <div className={cn("truncate text-[10.5px]", problem ? "text-amber-200/80" : "text-muted-fg/55")}>
          {queueItemLabel(item, providerLabel, machineName)}
        </div>
      </div>
      {!sending ? (
        <div className="flex shrink-0 items-center gap-0.5">
          {problem ? (
            <button
              type="button"
              aria-label="Send again"
              onClick={() => onRetry(item)}
              className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-fg/70 hover:bg-fg/[0.06] hover:text-fg/85"
            >
              <ArrowClockwise size={12} />
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Edit"
            onClick={() => onEdit(item)}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-fg/70 hover:bg-fg/[0.06] hover:text-fg/85"
          >
            <PencilSimple size={12} />
          </button>
          <button
            type="button"
            aria-label="Remove from queue"
            onClick={() => onCancel(item)}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-fg/70 hover:bg-fg/[0.06] hover:text-fg/85"
          >
            <X size={12} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The ADE input box docked below a running agent CLI's terminal. Text goes
 * through the host's CLI typing path (`chat.typeIntoCli`), on the CLI's own
 * machine, and only at a free prompt: a send while the CLI is busy, or while
 * its machine is offline, waits in a visible queue. The terminal stays
 * usable the whole time.
 */
export const WorkCliInputBox = memo(function WorkCliInputBox({
  sessionId,
  laneId,
  provider,
  providerLabel,
  runtimeState,
  pin,
  autoFocus,
  launch,
}: {
  sessionId: string;
  laneId: string | null;
  provider: TerminalResumeProvider | null;
  providerLabel: string;
  runtimeState: TerminalRuntimeState;
  /** The CLI's machine; null for the tab's own machine. Required on purpose. */
  pin: OpenProjectBinding | null;
  autoFocus: boolean;
  /** What the CLI was launched with, for the model and permission chips. */
  launch: TerminalResumeLaunchConfig | null;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const commandMenuRef = useRef<ChatCommandMenuHandle | null>(null);
  const [draft, setDraft] = useState(() => readCliInputDraft(sessionId));
  const [commandMenuTrigger, setCommandMenuTrigger] = useState<ComposerTrigger | null>(null);
  const [commandMenuAnchor, setCommandMenuAnchor] = useState<CommandMenuAnchor | null>(null);
  const [slashCommands, setSlashCommands] = useState<AgentChatSlashCommand[]>([]);
  const queue = useCliInputQueue(sessionId);
  const { offline, machineName } = useCliMachineOffline(pin);
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? null;

  // History recall: index into the sent texts, newest last; null = editing the draft.
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number | null>(null);
  const stashedDraftRef = useRef("");
  const loadedHistoryVersionRef = useRef(-1);

  // Route this session's queue to its machine, and tell it when that machine
  // comes back. Keyed on the pin's key: a rebuilt pin is the same machine.
  const projectKey = useAppStore((s) => s.projectBinding?.key ?? null);
  useEffect(() => {
    // The box shows only while this CLI's project is the active tab, so this
    // is its project; queued sends keep it after the box unmounts.
    setCliInputRoute(sessionId, { pin: pinRef.current, offline, ...(pinRef.current ? {} : { projectKey }) });
  }, [offline, pinKey, projectKey, sessionId]);

  // A CLI that changes state (a turn ended) may have a free prompt now.
  useEffect(() => {
    if (runtimeState !== "running") kickCliInputQueue(sessionId);
  }, [runtimeState, sessionId]);

  // Draft saved shortly after typing stops, so a keystroke is not a storage write.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    const timer = setTimeout(() => writeCliInputDraft(sessionId, draft), DRAFT_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft, sessionId]);
  useEffect(() => () => writeCliInputDraft(sessionId, draftRef.current), [sessionId]);

  // The box takes focus when its surface becomes active. The terminal focuses
  // itself on activation too (a frame, then 100 ms later), so focus after it.
  useEffect(() => {
    if (!autoFocus) return;
    const timer = setTimeout(() => {
      const node = textareaRef.current;
      if (node && document.activeElement !== node) node.focus({ preventScroll: true });
    }, 160);
    return () => clearTimeout(timer);
  }, [autoFocus]);

  useEffect(() => {
    let cancelled = false;
    setSlashCommands([]);
    if (!provider || !laneId) return () => {
      cancelled = true;
    };
    const args = { laneId, provider };
    const currentPin = pinRef.current;
    void (currentPin
      ? window.ade.agentChat.slashCommands(args, currentPin)
      : window.ade.agentChat.slashCommands(args))
      .then((commands) => {
        if (!cancelled) setSlashCommands(commands.filter((command) => command.source !== "local"));
      })
      .catch(() => {
        if (!cancelled) setSlashCommands([]);
      });
    return () => {
      cancelled = true;
    };
  }, [laneId, pinKey, provider]);

  const searchFiles = useCallback(async (query: string) => {
    const trimmed = composerFileSearchQuery(query).trim();
    if (!laneId || !trimmed) return [];
    const args = { workspaceId: laneId, query: trimmed, limit: 40, allowComposerPrefixFallback: true, includeDirectories: true };
    const currentPin = pinRef.current;
    const hits = await (currentPin ? window.ade.files.quickOpen(args, currentPin) : window.ade.files.quickOpen(args));
    return hits.map((hit) => ({ path: hit.path, ...(hit.isDirectory ? { isDirectory: true as const } : {}) }));
  }, [laneId]);

  // Auto-grow from one line, capped so the terminal keeps the room.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, MAX_BOX_HEIGHT_PX)}px`;
  }, [draft]);

  const placeCaret = useCallback((caret: number) => {
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus({ preventScroll: true });
      try {
        node.setSelectionRange(caret, caret);
      } catch {
        // The node may have been detached.
      }
    });
  }, []);

  const updateDraft = useCallback((next: string, element: HTMLTextAreaElement | null) => {
    setDraft(next);
    historyIndexRef.current = null;
    const trigger = detectComposerTrigger(next, element?.selectionStart ?? next.length);
    if (trigger && (trigger.type === "slash" || trigger.type === "at")) {
      setCommandMenuTrigger(trigger);
      const anchor = menuAnchor(element);
      if (anchor) setCommandMenuAnchor(anchor);
      return;
    }
    setCommandMenuTrigger(null);
  }, []);

  const handleMenuSelect = useCallback((item: ChatCommandMenuItem) => {
    if (!commandMenuTrigger) return;
    let insertion: string | null = null;
    if (item.type === "command") {
      const command = slashCommands.find((candidate) => candidate.name.replace(/^\//, "") === item.name);
      const argumentHint = command?.argumentHint && composerTriggerSpansWholeDraft(draft, commandMenuTrigger)
        ? ` ${command.argumentHint}`
        : "";
      insertion = `/${item.name}${argumentHint} `;
    } else if (item.type === "file") {
      insertion = pathMention(item.path);
    }
    if (insertion == null) return;
    const next = replaceComposerTriggerSpan(draft, commandMenuTrigger, insertion);
    setDraft(next.text);
    setCommandMenuTrigger(null);
    placeCaret(next.caret);
  }, [commandMenuTrigger, draft, placeCaret, slashCommands]);

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    if (!enqueueCliInput(sessionId, text)) {
      showToast({
        title: "This message isn't saved yet",
        message: "ADE couldn't save it (storage is full). It still sends from this window, but reloading ADE before then loses it.",
        tone: "warning",
      });
    }
    setDraft("");
    writeCliInputDraft(sessionId, "");
    setCommandMenuTrigger(null);
    historyIndexRef.current = null;
  }, [draft, sessionId]);

  const recallHistory = useCallback((direction: -1 | 1): boolean => {
    const version = cliInputHistoryVersion(sessionId);
    if (loadedHistoryVersionRef.current !== version) {
      historyRef.current = readCliInputHistory(sessionId);
      loadedHistoryVersionRef.current = version;
    }
    const history = historyRef.current;
    if (history.length === 0) return false;
    const current = historyIndexRef.current;
    if (direction === -1) {
      const nextIndex = current == null ? history.length - 1 : Math.max(0, current - 1);
      if (current == null) stashedDraftRef.current = draft;
      historyIndexRef.current = nextIndex;
      const text = history[nextIndex] ?? "";
      setDraft(text);
      placeCaret(text.length);
      return true;
    }
    if (current == null) return false;
    const nextIndex = current + 1;
    if (nextIndex >= history.length) {
      historyIndexRef.current = null;
      const text = stashedDraftRef.current;
      setDraft(text);
      placeCaret(text.length);
      return true;
    }
    historyIndexRef.current = nextIndex;
    const text = history[nextIndex] ?? "";
    setDraft(text);
    placeCaret(text.length);
    return true;
  }, [draft, placeCaret, sessionId]);

  const editQueued = useCallback((item: CliInputQueueItem) => {
    const removed = removeCliInput(sessionId, item.id);
    if (!removed) return;
    const next = draft.trim() ? `${removed.text}\n${draft}` : removed.text;
    setDraft(next);
    placeCaret(removed.text.length);
  }, [draft, placeCaret, sessionId]);

  const cancelQueued = useCallback((item: CliInputQueueItem) => {
    removeCliInput(sessionId, item.id);
  }, [sessionId]);

  const retryQueued = useCallback((item: CliInputQueueItem) => {
    retryCliInput(sessionId, item.id);
  }, [sessionId]);

  const hasText = draft.trim().length > 0;
  const busy = runtimeState === "running";
  const willQueue = offline || busy || queue.length > 0;
  const placeholder = offline
    ? `${machineName ?? "This computer"} is offline. What you send goes out when it reconnects.`
    : busy
      ? `${providerLabel} is working. What you send waits for its turn to end.`
      : `Message ${providerLabel}…`;

  return (
    <div className="shrink-0 bg-[color:var(--chat-canvas-bg)] px-3 pb-3 pt-2" data-testid="work-cli-input-box">
      <ChatComposerShell
        mode="standard"
        className="mx-auto w-full max-w-[var(--chat-column,46rem)]"
        trays={queue.length > 0 ? (
          <div className="max-h-36 overflow-y-auto py-0.5">
            {queue.map((item) => (
              <QueueRow
                key={item.id}
                item={item}
                providerLabel={providerLabel}
                machineName={machineName}
                onEdit={editQueued}
                onCancel={cancelQueued}
                onRetry={retryQueued}
              />
            ))}
          </div>
        ) : null}
        footer={(
          <div className="flex min-h-10 flex-wrap items-center justify-between gap-2 px-2.5 py-1.5">
            <CliLaunchChips launch={launch} providerLabel={providerLabel} />
            <button
              type="button"
              disabled={!hasText}
              onClick={send}
              aria-label={willQueue ? "Queue" : "Send"}
              className={cn(
                "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-all",
                !hasText ? "bg-fg/[0.06] text-muted-fg/20" : "bg-white/90 text-zinc-900 hover:bg-white",
              )}
            >
              <ArrowUp size={14} weight="bold" />
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
          onFileSearch={laneId ? searchFiles : undefined}
          anchor={commandMenuAnchor}
          onSelect={handleMenuSelect}
          onClose={() => setCommandMenuTrigger(null)}
          onNoMatches={() => setCommandMenuTrigger(null)}
        />
        <textarea
          ref={textareaRef}
          value={draft}
          rows={1}
          onChange={(event) => updateDraft(event.currentTarget.value, event.currentTarget)}
          onKeyDown={(event) => {
            if (commandMenuTrigger && handleCommandMenuKeyDown(event, commandMenuRef, () => setCommandMenuTrigger(null))) {
              return;
            }
            if (commandMenuTrigger && event.key === "Enter" && !event.shiftKey && !isImeComposing(event)) {
              // Nothing matched: close the menu; a second Enter sends as typed.
              event.preventDefault();
              setCommandMenuTrigger(null);
              return;
            }
            if (event.key === "Enter" && !event.shiftKey && !isImeComposing(event)) {
              event.preventDefault();
              send();
              return;
            }
            if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
              const node = event.currentTarget;
              const caret = node.selectionStart ?? 0;
              const onFirstLine = !node.value.slice(0, caret).includes("\n");
              const onLastLine = !node.value.slice(node.selectionEnd ?? caret).includes("\n");
              if (event.key === "ArrowUp" && onFirstLine && recallHistory(-1)) event.preventDefault();
              else if (event.key === "ArrowDown" && onLastLine && recallHistory(1)) event.preventDefault();
            }
          }}
          className="block w-full resize-none overflow-y-auto bg-transparent px-4 py-2.5 text-[length:calc(var(--chat-font-size)*13/14)] leading-[1.6] text-fg/88 outline-none placeholder:text-muted-fg/35"
          placeholder={placeholder}
          aria-label={`Message ${providerLabel}`}
          data-testid="work-cli-input-textarea"
        />
      </ChatComposerShell>
    </div>
  );
});

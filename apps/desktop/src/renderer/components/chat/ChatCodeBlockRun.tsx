import React, { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowUp, CheckCircle, Play, Terminal, Warning } from "@phosphor-icons/react";
import type { OpenProjectBinding, PtyExitEvent, TerminalSerializedSnapshot } from "../../../shared/types";
import { SHELL_BLOCK_RUN_ENV } from "../../../shared/types/sync";
import { confirmDialog } from "../ui/dialog";
import { isWindowsAbsolutePath } from "../../lib/pathUtils";
import { useChatRuntimeScope, type ChatRuntimeScope } from "./ChatRuntimeScope";
import { planShellBlockRun, shellRunResultMessage, shellRunTerminalTitle } from "./shellCodeBlockRun";
import { requestChatTerminalFocus } from "./chatTerminalFocus";
import { CODE_BLOCK_ACTION_BUTTON_CLASS, CODE_BLOCK_ACTION_BUTTON_STYLE } from "./codeBlockActionButton";
import { captureError } from "../../../shared/sentry/capture";
import { useChatMachineWake } from "./useChatMachineWake";
import { WOKEN_MACHINE_CONNECT_WAIT_MS } from "../../../shared/wokenMachine";
import { withChatPin } from "./chatMachinePin";

type RevealTerminal = (terminal: { chatSessionId: string; terminalId: string; ptyId: string; label: string }) => void;

/**
 * Opens the chat's terminal pane on a terminal: the pane that owns the chat
 * provides it. Context rather than a prop, so the transcript's row memos never
 * see it. Absent (null), a run still starts; its terminal is in the chat's
 * tools pane. `false` means this transcript runs nothing (a subagent's view,
 * whose blocks are not this chat's replies).
 */
export const ChatTerminalRevealContext = createContext<RevealTerminal | null | false>(null);

/*
 * Run a shell code block from a reply in a new terminal of the chat's tools
 * pane, on the chat's machine, in the chat's lane, after a confirm. When it
 * ends, "Send output to the agent" sends what it printed; nothing is sent
 * without that click.
 *
 * A code block mounts none of this until someone points at it or focuses it
 * (`HighlightedCode` arms it), so a long transcript pays one boolean per shell
 * block. Runs live in a module store rather than in the block: a virtualized
 * row that scrolls away and back, or a chat switched away from and back to,
 * still shows its run and can still send it.
 */

type SendState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent" }
  | { kind: "error"; message: string };

type ShellRun = {
  id: number;
  /** The chat it ran for, and the machine everything about it is addressed to. */
  sessionId: string;
  pin: OpenProjectBinding | null;
  script: string;
  language: string;
  machineName: string;
  folder: string;
  terminalId: string | null;
  ptyId: string | null;
  title: string;
  status: "starting" | "running" | "exited" | "failed";
  exitCode: number | null;
  error: string | null;
  send: SendState;
};

const runsByKey = new Map<string, ShellRun>();
/** Blocks (by language and text) with a run in any chat: lets an unarmed block remount armed. */
const blocksWithRuns = new Set<string>();
const listenersByKey = new Map<string, Set<() => void>>();
let nextRunId = 1;

function blockIdentity(language: string, code: string): string {
  return `${language}\u0000${code}`;
}

function runKey(sessionId: string, language: string, code: string): string {
  return `${sessionId}\u0000${blockIdentity(language, code)}`;
}

/** Has this block (in any chat) been run? Synchronous and context-free, for the unarmed block. */
export function shellBlockHasRun(language: string, code: string): boolean {
  return blocksWithRuns.has(blockIdentity(language, code));
}

function emit(key: string): void {
  for (const listener of listenersByKey.get(key) ?? []) listener();
}

function setRun(key: string, run: ShellRun): void {
  runsByKey.set(key, run);
  emit(key);
}

/** Change the run under `key` only if it is still run `id`: a newer run owns the block. */
function updateRun(key: string, id: number, patch: Partial<ShellRun>): void {
  const current = runsByKey.get(key);
  if (!current || current.id !== id) return;
  setRun(key, { ...current, ...patch });
}

function subscribe(key: string, listener: () => void): () => void {
  let listeners = listenersByKey.get(key);
  if (!listeners) {
    listeners = new Set();
    listenersByKey.set(key, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) listenersByKey.delete(key);
  };
}

function useShellRun(key: string | null): ShellRun | null {
  const subscribeKey = useCallback((listener: () => void) => (key ? subscribe(key, listener) : () => {}), [key]);
  return useSyncExternalStore(subscribeKey, () => (key ? runsByKey.get(key) ?? null : null));
}

const DAY_MS = 24 * 60 * 60_000;

/**
 * Whether people run code blocks from chat, and send the output back
 * (`docs/logging.md`). Emitted here because a run has no backend mutation of
 * its own: on the desktop it is an ordinary terminal create. Closed and
 * content-free; a per-action 24-hour key allows at most two accepted events
 * per installation per UTC day.
 */
function captureCodeBlockRunFact(action: "code_block_run" | "code_block_output_sent"): void {
  try {
    void window.ade?.analytics?.capture({
      event: "ade_feature_used",
      properties: {
        feature: "chat",
        action,
        outcome: action === "code_block_run" ? "started" : "completed",
        source: "renderer_route",
      },
      dedupeKey: `chat_${action}`,
      minimumIntervalMs: DAY_MS,
    }).catch(() => undefined);
  } catch {
    // Analytics must never change what Run does.
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function startRun(args: {
  key: string;
  blockId: string;
  scope: ChatRuntimeScope & { sessionId: string; laneId: string };
  folder: string;
  plan: { script: string; command: string; args: string[] };
  language: string;
  reveal: RevealTerminal | null;
}): Promise<void> {
  const { key, scope, plan } = args;
  const title = shellRunTerminalTitle(plan.script);
  const pin = scope.pin;
  const id = nextRunId++;
  blocksWithRuns.add(args.blockId);
  setRun(key, {
    id,
    sessionId: scope.sessionId,
    pin,
    script: plan.script,
    language: args.language,
    machineName: scope.machineName,
    folder: args.folder,
    terminalId: null,
    ptyId: null,
    title,
    status: "starting",
    exitCode: null,
    error: null,
    send: { kind: "idle" },
  });

  // Listen before the terminal exists: a quick command can end before
  // `create` answers, and its exit must not be missed. Exits arrive on the
  // chat's machine's own feed.
  let ptyId: string | null = null;
  const earlyExits: PtyExitEvent[] = [];
  let done = false;
  // No known machine: no feed; the create below fails with the reason.
  const unsubscribe = pin
    ? window.ade.pty.onExit((event: PtyExitEvent) => {
      if (ptyId === null) earlyExits.push(event);
      else if (event.ptyId === ptyId) finish(event.exitCode);
    }, pin)
    : () => undefined;
  function finish(exitCode: number | null): void {
    if (done) return;
    done = true;
    unsubscribe?.();
    updateRun(key, id, { status: "exited", exitCode });
  }

  try {
    const created = await withChatPin(pin, (chatPin) => window.ade.pty.create({
      laneId: scope.laneId,
      chatSessionId: scope.sessionId,
      cols: 100,
      rows: 28,
      title,
      tracked: true,
      toolType: "shell",
      command: plan.command,
      args: plan.args,
      env: { ...SHELL_BLOCK_RUN_ENV },
    }, chatPin));
    ptyId = created.ptyId;
    updateRun(key, id, { terminalId: created.sessionId, ptyId: created.ptyId, status: "running" });
    captureCodeBlockRunFact("code_block_run");
    const early = earlyExits.find((event) => event.ptyId === created.ptyId);
    showTerminal(scope.sessionId, { terminalId: created.sessionId, ptyId: created.ptyId, label: title, ended: Boolean(early) }, args.reveal);
    if (early) {
      finish(early.exitCode);
      return;
    }
    // The exit event can miss: a machine's feed can start after the command
    // ended, and the hosted web reports a terminal's exit only once a view
    // subscribes to it. The session's own status settles the run then: read
    // now, and again at a slow pace while it runs.
    void settleFromSessionStatus(created.sessionId, pin, () => done, finish);
  } catch (error) {
    done = true;
    unsubscribe?.();
    // A lane folder that is gone, or a host too old for the hosted client's
    // launch, is the person's state and the block says so; anything else is
    // ours to hear about.
    if (!/worktree is unavailable|Update ADE on this machine/i.test(errorText(error))) {
      captureError(error, { fingerprint: ["chat-code-block-run", "start-failed"], level: "warning", handled: true });
    }
    updateRun(key, id, { status: "failed", error: errorText(error) });
  }
}

const SESSION_STATUS_CHECK_DELAYS_MS = [0, 2_000, 5_000, 15_000];
const SESSION_STATUS_CHECK_INTERVAL_MS = 30_000;

async function settleFromSessionStatus(
  terminalId: string,
  pin: OpenProjectBinding | null,
  isDone: () => boolean,
  finish: (exitCode: number | null) => void,
): Promise<void> {
  for (let check = 0; !isDone(); check += 1) {
    const delay = SESSION_STATUS_CHECK_DELAYS_MS[check] ?? SESSION_STATUS_CHECK_INTERVAL_MS;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    if (isDone()) return;
    try {
      const session = await withChatPin(pin, (chatPin) => window.ade.sessions.get(terminalId, chatPin));
      // A terminal deleted while it ran leaves the run to its exit event.
      if (!session) return;
      if (session.status !== "running") {
        finish(session.exitCode ?? null);
        return;
      }
    } catch (error) {
      // The exit event still settles the run; stop asking a machine that
      // cannot answer.
      captureError(error, { fingerprint: ["chat-code-block-run", "exit-status-read"], level: "warning", handled: true });
      return;
    }
  }
}

/** Open the chat's terminal pane on this terminal, running or ended. */
function showTerminal(
  chatSessionId: string,
  terminal: { terminalId: string; ptyId: string; label: string; ended: boolean },
  reveal: RevealTerminal | null,
): void {
  requestChatTerminalFocus(chatSessionId, terminal);
  reveal?.({ chatSessionId, terminalId: terminal.terminalId, ptyId: terminal.ptyId, label: terminal.label });
}

/**
 * What a finished run printed, as its terminal shows it, scrollback included.
 *
 * Read from the screen the host's terminal keeps where there is one, not from
 * the raw output: a Windows terminal (ConPTY) repaints its whole screen with
 * cursor moves instead of writing a log, so its raw output holds every
 * repaint, blank rows and repeated lines included. Without a screen (an older
 * host, the hosted web), the raw output, cleaned by `shellRunResultMessage`.
 */
async function readRunOutput(terminalId: string, pin: OpenProjectBinding | null): Promise<string> {
  const preview = pin ? await window.ade.terminal.preview({ terminalId }, pin).catch(() => null) : null;
  const snapshot = preview?.snapshot;
  if (snapshot?.serialized) {
    const text = await terminalSnapshotText(snapshot).catch(() => null);
    if (text !== null) return text;
  }
  // Raw, so a progress bar's carriage returns survive to be collapsed.
  return withChatPin(pin, (chatPin) => window.ade.sessions.readTranscriptTail({ sessionId: terminalId, maxBytes: 64_000, raw: true }, chatPin));
}

/** A terminal snapshot's normal buffer (scrollback, then screen) as plain lines. */
async function terminalSnapshotText(snapshot: TerminalSerializedSnapshot): Promise<string> {
  const { Terminal: Xterm } = await import("@xterm/xterm");
  const terminal = new Xterm({
    allowProposedApi: true,
    cols: Math.max(1, snapshot.cols),
    rows: Math.max(1, snapshot.rows),
    scrollback: 10_000,
  });
  try {
    // `write` parses asynchronously; the buffer is complete only in its callback.
    await new Promise<void>((resolve) => terminal.write(snapshot.serialized, resolve));
    const buffer = terminal.buffer.normal;
    const lines: string[] = [];
    for (let y = 0; y < buffer.length; y += 1) {
      const line = buffer.getLine(y);
      if (!line) continue;
      // A row that wraps onto the next keeps its trailing spaces: they are text.
      const text = line.translateToString(!buffer.getLine(y + 1)?.isWrapped);
      if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    return lines.join("\n").replace(/^(?:[ \t]*\n)+/, "").replace(/\s+$/, "");
  } finally {
    terminal.dispose();
  }
}

async function sendRunOutput(key: string): Promise<void> {
  const run = runsByKey.get(key);
  if (!run || run.status !== "exited" || !run.terminalId) return;
  if (run.send.kind === "sending" || run.send.kind === "sent") return;
  updateRun(key, run.id, { send: { kind: "sending" } });
  try {
    const output = await readRunOutput(run.terminalId, run.pin);
    const text = shellRunResultMessage({
      script: run.script,
      language: run.language,
      machineName: run.machineName,
      folder: run.folder,
      exitCode: run.exitCode,
      output,
    });
    await withChatPin(run.pin, (chatPin) => window.ade.agentChat.send({ sessionId: run.sessionId, text }, chatPin));
    updateRun(key, run.id, { send: { kind: "sent" } });
    captureCodeBlockRunFact("code_block_output_sent");
  } catch (error) {
    const busy = /already active/i.test(errorText(error));
    if (!busy) {
      captureError(error, { fingerprint: ["chat-code-block-run", "send-output-failed"], level: "warning", handled: true });
    }
    const message = busy ? "The agent is busy with a turn. Send the output when it finishes." : errorText(error);
    updateRun(key, run.id, { send: { kind: "error", message } });
  }
}

/** The chat's machine is Windows when its lane folder (or project) is a Windows path. */
function scopeIsWindows(scope: ChatRuntimeScope): boolean {
  const path = scope.laneWorktreePath ?? scope.rootPath ?? "";
  return path.length > 0 && isWindowsAbsolutePath(path);
}

const NO_PROJECT_LANE = "This chat has no project lane to run commands in.";

function blockedReason(scope: ChatRuntimeScope): string | null {
  // A personal chat's lane is its own workspace, not a lane of this project.
  if (!scope.laneId || !scope.lane) return NO_PROJECT_LANE;
  if (!scope.online) return `${scope.machineName} is offline.`;
  if (scope.lane?.archivedAt) return "This chat's lane is archived. Restore it to run commands.";
  if (!scope.laneWorktreePath) return `This lane's folder isn't known on ${scope.machineName}.`;
  if (!window.ade?.pty?.create) return "Terminals aren't available here.";
  return null;
}

/** The Run control beside Copy. Rendered only once the block is armed. */
export function ShellCodeBlockRunButton({ code, language }: { code: string; language: string }) {
  const scope = useChatRuntimeScope();
  const reveal = useContext(ChatTerminalRevealContext);
  // The chat's machine as the chat found it: a sleeping cloud computer wakes
  // on the person's click, an unreachable machine stays "offline".
  const machine = useChatMachineWake();
  // A click on a sleeping computer: true while its wake runs.
  const [runAfterWake, setRunAfterWake] = useState(false);
  // After the wake: the run waits for the woken machine's own lane read (the
  // saved copy's lane has no folder), until this time (ms).
  const [laneWaitUntil, setLaneWaitUntil] = useState<number | null>(null);
  // Why a run a wake asked for did not start, as one sentence.
  const [runFailure, setRunFailure] = useState<string | null>(null);
  // The latest render's start and scope, for the wait below.
  const runNowRef = useRef<(() => void) | null>(null);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const liveFolder = scope.online ? scope.laneWorktreePath : null;
  useEffect(() => {
    if (laneWaitUntil == null) return;
    if (liveFolder) {
      // Once: the wait ends before the start, so a later render starts nothing.
      setLaneWaitUntil(null);
      runNowRef.current?.();
      return;
    }
    const timer = window.setTimeout(() => {
      setLaneWaitUntil(null);
      const current = scopeRef.current;
      setRunFailure(blockedReason(current) ?? `${current.machineName} didn't come back online in time. Try again.`);
    }, Math.max(0, laneWaitUntil - Date.now()));
    return () => window.clearTimeout(timer);
  }, [laneWaitUntil, liveFolder]);
  // Outside a chat (a PR description, a preview) there is nowhere to run it.
  if (!scope.sessionId || reveal === false) return null;
  const plan = planShellBlockRun({ code, language, machineIsWindows: scopeIsWindows(scope) });
  if (!plan) return null;
  const asleep = !scope.online && machine.resting;
  // A sleeping cloud computer is no reason to refuse: the click wakes it, and
  // the lane's facts are read once it is up. It still needs a project lane.
  const machineBlocked = asleep ? (scope.laneId ? null : NO_PROJECT_LANE) : blockedReason(scope);
  const blocked = machineBlocked ?? (plan.ok ? null : plan.reason);
  const waking = machine.waking || runAfterWake || laneWaitUntil != null;
  const reason = waking ? `Waking ${scope.machineName}…` : blocked;
  const sessionId = scope.sessionId;
  const laneId = scope.laneId;
  const folder = scope.laneWorktreePath;

  /** Asks, then starts the run in a new terminal, with this render's lane and folder. */
  const runNow = async () => {
    if (blocked || !plan.ok || !laneId || !folder) return;
    const confirmed = await confirmDialog({
      title: "Run this command?",
      message: "The agent wrote it. Read it before you run it.",
      confirmLabel: "Run",
      icon: <Terminal size={16} weight="bold" />,
      children: (
        <div className="flex flex-col gap-2">
          <pre
            dir="ltr"
            className="m-0 max-h-[40vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-[color:var(--chat-code-border)] bg-[var(--chat-code-bg)] px-3 py-2 font-mono text-[11px] leading-[1.6] text-[var(--chat-code-fg)]"
          >
            {plan.script}
          </pre>
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-sans text-[12px]">
            <dt className="text-muted-fg">Machine</dt>
            <dd className="m-0 min-w-0 truncate text-fg">{scope.machineName}</dd>
            <dt className="text-muted-fg">Folder</dt>
            <dd className="m-0 min-w-0 break-all font-mono text-[11px] text-fg" dir="ltr">{folder}</dd>
            <dt className="text-muted-fg">Shell</dt>
            <dd className="m-0 text-fg">{plan.shellLabel}, in a new terminal</dd>
          </dl>
        </div>
      ),
    });
    if (!confirmed) return;
    await startRun({
      key: runKey(sessionId, language, code),
      blockId: blockIdentity(language, code),
      scope: { ...scope, sessionId, laneId },
      folder,
      plan,
      language,
      reveal,
    });
  };
  runNowRef.current = () => void runNow();

  const handleClick = () => {
    if (waking || blocked || !plan.ok || !laneId) return;
    setRunFailure(null);
    if (!asleep) {
      void runNow();
      return;
    }
    // The person's click wakes the chat's own machine. Once it reads online,
    // the run waits for its lane's folder (the effect above), then starts
    // once. A failed or timed-out wake starts nothing and leaves the hook's
    // sentence.
    setRunAfterWake(true);
    void machine
      .wakeThen(() => setLaneWaitUntil(Date.now() + WOKEN_MACHINE_CONNECT_WAIT_MS))
      .finally(() => setRunAfterWake(false));
  };

  // A failed or timed-out wake says why while the machine is still offline; Run stays clickable.
  const wakeFailure = !scope.online ? machine.error : null;
  // A run a wake asked for that never started, until the lane's folder is known.
  const shownRunFailure = liveFolder ? null : runFailure;
  const label = (waking ? null : wakeFailure ?? shownRunFailure)
    ?? reason
    ?? (asleep ? `${scope.machineName} is asleep. Run wakes it, then runs this.` : "Run in a new terminal");
  return (
    <button
      type="button"
      className={`${CODE_BLOCK_ACTION_BUTTON_CLASS} opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 ${reason ? "cursor-not-allowed" : ""}`}
      style={reason ? { ...CODE_BLOCK_ACTION_BUTTON_STYLE, color: "color-mix(in srgb, var(--chat-copy-button-fg) 55%, transparent)" } : CODE_BLOCK_ACTION_BUTTON_STYLE}
      aria-disabled={reason ? true : undefined}
      onClick={handleClick}
      title={label}
      aria-label={label}
    >
      <Play size={10} weight="fill" />
      <span>Run</span>
    </button>
  );
}

/** The latest run of this block in this chat: where it is, how it ended, and the send. */
export function ShellCodeBlockRunStatus({ code, language }: { code: string; language: string }) {
  const sessionId = useChatRuntimeScope().sessionId;
  const reveal = useContext(ChatTerminalRevealContext);
  const key = sessionId ? runKey(sessionId, language, code) : null;
  const run = useShellRun(key);
  if (!run || !key) return null;
  const { terminalId, ptyId } = run;

  let status: React.ReactNode;
  if (run.status === "starting") status = `Starting on ${run.machineName}…`;
  else if (run.status === "running") status = `Running in the terminal on ${run.machineName}…`;
  else if (run.status === "failed") status = run.error ?? "The terminal didn't start.";
  else status = run.exitCode === null ? "Ended" : `Exited with code ${run.exitCode}`;
  const failed = run.status === "failed" || (run.status === "exited" && run.exitCode !== 0);

  return (
    <div
      dir="ltr"
      data-thread-find-ignore=""
      className="flex flex-wrap items-center gap-2 border-t border-[color:var(--chat-code-border)] px-4 py-1.5 font-sans text-[11px]"
      role="status"
    >
      {failed ? (
        <Warning size={12} weight="bold" className="shrink-0 text-amber-300/80" aria-hidden />
      ) : (
        <Terminal size={12} weight="bold" className="shrink-0 text-[var(--chat-code-fg)] opacity-60" aria-hidden />
      )}
      <span className="min-w-0 flex-1 text-[var(--chat-code-fg)] opacity-75">{status}</span>
      {terminalId && ptyId ? (
        <button
          type="button"
          className={CODE_BLOCK_ACTION_BUTTON_CLASS}
          style={CODE_BLOCK_ACTION_BUTTON_STYLE}
          onClick={() => showTerminal(run.sessionId, { terminalId, ptyId, label: run.title, ended: run.status === "exited" }, reveal || null)}
        >
          <Terminal size={10} weight="bold" />
          <span>Show terminal</span>
        </button>
      ) : null}
      {run.status === "exited" ? (
        run.send.kind === "sent" ? (
          <span className="inline-flex items-center gap-1 text-[var(--chat-code-fg)] opacity-75">
            <CheckCircle size={12} weight="fill" aria-hidden />
            Sent to the agent
          </span>
        ) : (
          <button
            type="button"
            className={CODE_BLOCK_ACTION_BUTTON_CLASS}
            style={CODE_BLOCK_ACTION_BUTTON_STYLE}
            disabled={run.send.kind === "sending"}
            onClick={() => void sendRunOutput(key)}
          >
            <ArrowUp size={10} weight="bold" />
            <span>{run.send.kind === "sending" ? "Sending…" : "Send output to the agent"}</span>
          </button>
        )
      ) : null}
      {run.send.kind === "error" ? (
        <span className="basis-full text-[10px] text-amber-200/80">{run.send.message}</span>
      ) : null}
    </div>
  );
}

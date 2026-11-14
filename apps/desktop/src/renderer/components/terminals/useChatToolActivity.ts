import { useEffect, useRef, useState } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import type { AgentChatEventEnvelope } from "../../../shared/types/chat";
import { summarizeComputerUseCommand, type ComputerUseDomain } from "../../../shared/computerUseActionSummary";
import { computerUseActionText } from "../../../shared/computerUseActionPresentation";
import { subscribeWhenChatApiReady } from "../chat/chatEventSubscription";

/*
 * What the agent is doing with each tool right now, for the tools pane's
 * cards: "Tapping “General”…", "npm test running".
 *
 * No new logging. ADE already streams every tool call a chat makes to the
 * renderer (the Work row's activity is detected from the same calls in the
 * brain); this listens to that stream for the one chat the pane serves, on
 * that chat's machine (`agentChat.onEvent` with its pin, which joins the
 * pump the chat pane already runs). The words come from the same parser the
 * transcript's computer-use rows use (`summarizeComputerUseCommand`), so a card
 * and the transcript name an action the same way.
 */

export type ToolActivityTool =
  | "ios"
  | "android"
  | "screen"
  | "app-control"
  | "browser"
  | "terminal"
  | "git"
  | "pr"
  | "issues";

export type ToolActivity = {
  tool: ToolActivityTool;
  /** One line, as a person would say it: "Tapping “General”…", "Ran npm test". */
  text: string;
  /** The call has not answered yet. */
  running: boolean;
  /** Epoch ms of the call (or its answer). */
  at: number;
};

export type ChatToolActivity = {
  byTool: Partial<Record<ToolActivityTool, ToolActivity>>;
  /** Commands running on other machines right now (`ade shell start --machine`). */
  remoteShellsRunning: number;
};

const EMPTY: ChatToolActivity = { byTool: {}, remoteShellsRunning: 0 };

const SHELL_TOOLS = new Set([
  "bash", "shell", "terminal", "run_terminal_cmd", "exec_command", "execute", "run_shell_command",
  "run_command", "command", "local_shell", "powershell",
]);

const DOMAIN_TOOL: Readonly<Record<ComputerUseDomain, ToolActivityTool | null>> = {
  apple: "ios",
  android: "android",
  screen: "screen",
  "app-control": "app-control",
  browser: "browser",
  proof: null,
};

const MAX_COMMAND_CHARS = 2_000;
/** The recent history read once when the pane opens, so a call already running shows. */
const SEED_HISTORY_EVENTS = 200;
const SEED_HISTORY_MAX_BYTES = 256_000;
const MAX_LINE_CHARS = 56;

/** The command text of a shell tool call, across providers' argument shapes. */
function shellCommandOf(tool: string, args: unknown): string | null {
  const name = tool.trim().toLowerCase().replace(/^.*__/, "");
  if (!SHELL_TOOLS.has(name) || !args || typeof args !== "object" || Array.isArray(args)) return null;
  const record = args as Record<string, unknown>;
  for (const key of ["command", "cmd", "commandLine", "script"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
    if (Array.isArray(value) && value.every((part) => typeof part === "string")) return value.join(" ");
  }
  return null;
}

/** `bash -lc '…'`, `powershell -Command "…"`, `cmd /c …`: the line inside. */
function unwrapShell(command: string): string {
  let text = command.slice(0, MAX_COMMAND_CHARS).trim();
  for (let pass = 0; pass < 2; pass += 1) {
    const inner = text.match(/^(?:"[^"]*"|\S*?)(?:ba|z|da)?sh(?:\.exe)?"?\s+-\w*c\s+(['"])([\s\S]*)\1\s*$/i)?.[2]
      ?? text.match(/^\S*(?:powershell|pwsh)(?:\.exe)?\s+(?:-\w+\s+)*-c(?:ommand)?\s+(['"]?)([\s\S]*)\1\s*$/i)?.[2]
      ?? text.match(/^\S*cmd(?:\.exe)?\s+\/c\s+([\s\S]*)$/i)?.[1];
    if (inner == null) break;
    text = inner.trim();
  }
  return text;
}

function machineFlag(command: string): string | null {
  const match = command.match(/--machine(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? null)?.trim() || null;
}

/** A short spelling of one command: its first segment, at most one line. */
function shortCommand(command: string): string {
  const first = command.split(/\n/)[0]!.split(/\s*(?:&&|\|\||;)\s*/)[0]!.trim();
  const bare = first.replace(/^(?:\w+=\S*\s+)+/, "").replace(/^(?:\S*[\\/])?/, "");
  return bare.length > MAX_LINE_CHARS ? `${bare.slice(0, MAX_LINE_CHARS - 1)}…` : bare;
}

/** A command after `--` in `ade shell start … -- npm test`, or the command itself. */
function innerCommand(text: string): string {
  const shellStart = text.match(/\bade(?:\.exe|\.cmd)?\s+shell\s+start\b[\s\S]*?\s--\s+([\s\S]+)$/);
  return shellStart?.[1]?.trim() ?? text;
}

type ClassifiedCommand = { tool: ToolActivityTool; text: string; remoteShell: boolean } | null;

/** Which card a shell command belongs on, and what to say about it. */
function classifyToolCommand(
  command: string,
  status: "running" | "completed" | "failed",
  output?: string | null,
): ClassifiedCommand {
  const text = unwrapShell(command);
  if (!text) return null;
  const summary = summarizeComputerUseCommand({ command: text, output: output ?? null, status });
  if (summary) {
    const tool = DOMAIN_TOOL[summary.domain];
    return tool ? { tool, text: computerUseActionText(summary), remoteShell: false } : null;
  }
  // The agent's own status reports and device choices are not tool use.
  if (/\bade(?:\.exe|\.cmd)?\s+(?:chat\s+(?:activity|note|ask)|devices)\b/.test(text)) return null;
  const isAdeShell = /\bade(?:\.exe|\.cmd)?\s+shell\s+start\b/.test(text);
  const run = shortCommand(isAdeShell ? innerCommand(text) : text);
  const said = status === "running" ? `${run} running` : status === "failed" ? `${run} failed` : `Ran ${run}`;
  if (/^(?:\S*[\\/])?git\s/.test(text) || /\bade\s+git\s/.test(text)) return { tool: "git", text: said, remoteShell: false };
  if (/^gh\s+pr\b|\bade\s+prs?\s/.test(text)) return { tool: "pr", text: said, remoteShell: false };
  if (/^gh\s+issue\b|\bade\s+linear\b/.test(text)) return { tool: "issues", text: said, remoteShell: false };
  return { tool: "terminal", text: said, remoteShell: isAdeShell && machineFlag(text) != null };
}

/** True for `ade devices use …`: the chat's device choice may have changed. */
export function isDeviceChoiceCommand(command: string): boolean {
  return /\bade(?:\.exe|\.cmd)?\s+devices\s+use\b/.test(unwrapShell(command));
}

type Pending = { tool: ToolActivityTool; command: string; remoteShell: boolean };

/**
 * The live activity per tool for one chat, on the chat's machine (`pin`: its
 * copy, the tab's own included). `sessionId` or `pin` null subscribes to
 * nothing. Keyed on the pin's key: a rebuilt pin is the same machine.
 * `onDeviceChoice` runs after the agent's `ade devices use` answers.
 *
 * It starts from the chat's recent history (one bounded read), so a call
 * already running when the pane opens shows as the agent's; live events that
 * land during that read are applied after it, each once.
 */
export function useChatToolActivity(
  sessionId: string | null,
  pin: OpenProjectBinding | null,
  active: boolean,
  onDeviceChoice?: () => void,
): ChatToolActivity {
  const [activity, setActivity] = useState<ChatToolActivity>(EMPTY);
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const onDeviceChoiceRef = useRef(onDeviceChoice);
  onDeviceChoiceRef.current = onDeviceChoice;
  const pinKey = pin?.key ?? null;

  useEffect(() => {
    setActivity(EMPTY);
    const feedPin = pinRef.current;
    if (!active || !sessionId || !feedPin) return undefined;
    const pending = new Map<string, Pending>();
    const deviceChoiceItems = new Set<string>();
    let byTool: ChatToolActivity["byTool"] = {};

    const publish = () => {
      let remoteShellsRunning = 0;
      for (const entry of pending.values()) if (entry.remoteShell) remoteShellsRunning += 1;
      setActivity((current) => {
        if (current.byTool === byTool && current.remoteShellsRunning === remoteShellsRunning) return current;
        return { byTool, remoteShellsRunning };
      });
    };
    const record = (entry: ToolActivity) => {
      const previous = byTool[entry.tool];
      if (previous && previous.text === entry.text && previous.running === entry.running) return;
      byTool = { ...byTool, [entry.tool]: entry };
    };
    const startCommand = (itemId: string, command: string, at: number) => {
      if (isDeviceChoiceCommand(command)) deviceChoiceItems.add(itemId);
      const classified = classifyToolCommand(command, "running");
      if (!classified) return;
      pending.set(itemId, { tool: classified.tool, command, remoteShell: classified.remoteShell });
      record({ tool: classified.tool, text: classified.text, running: true, at });
    };
    let replaying = false;
    const finishCommand = (itemId: string, at: number, failed: boolean, output?: string | null, command?: string) => {
      if (deviceChoiceItems.delete(itemId) && !replaying) onDeviceChoiceRef.current?.();
      const started = pending.get(itemId);
      pending.delete(itemId);
      const text = command ?? started?.command;
      if (!text) return;
      const classified = classifyToolCommand(text, failed ? "failed" : "completed", output);
      if (!classified) return;
      // Another call on the same tool still runs (parallel commands): the tool stays the agent's.
      let still: Pending | null = null;
      for (const entry of pending.values()) if (entry.tool === classified.tool) still = entry;
      if (still) {
        const running = classifyToolCommand(still.command, "running");
        record({ tool: classified.tool, text: running?.text ?? classified.text, running: true, at });
        return;
      }
      record({ tool: classified.tool, text: classified.text, running: false, at });
    };
    const endTurn = (at: number) => {
      pending.clear();
      deviceChoiceItems.clear();
      let next: ChatToolActivity["byTool"] | null = null;
      for (const [tool, entry] of Object.entries(byTool) as Array<[ToolActivityTool, ToolActivity]>) {
        if (!entry.running) continue;
        next ??= { ...byTool };
        next[tool] = { ...entry, running: false, at };
      }
      if (next) byTool = next;
    };

    const apply = (envelope: AgentChatEventEnvelope) => {
      if (envelope.sessionId !== sessionId) return;
      const event = envelope.event;
      const at = Date.parse(envelope.timestamp) || Date.now();
      const before = byTool;
      const pendingBefore = pending.size;
      switch (event.type) {
        case "command": {
          if (event.status === "running") startCommand(event.itemId, event.command, at);
          else finishCommand(event.itemId, at, event.status === "failed", event.output, event.command);
          break;
        }
        case "tool_call": {
          // A subagent's calls are its own: the parent's card shows the parent.
          if (event.parentItemId) return;
          const command = shellCommandOf(event.tool, event.args);
          if (command) startCommand(event.itemId, command, at);
          break;
        }
        case "tool_result": {
          if (!pending.has(event.itemId) && !deviceChoiceItems.has(event.itemId)) return;
          const result = event.result;
          const output = typeof result === "string" ? result : null;
          const failed = Boolean(result && typeof result === "object" && (result as { is_error?: unknown }).is_error === true);
          finishCommand(event.itemId, at, failed, output);
          break;
        }
        case "done":
          endTurn(at);
          break;
        case "status":
          if (event.turnStatus !== "started") endTurn(at);
          break;
        default:
          return;
      }
      if (byTool !== before || pending.size !== pendingBefore) publish();
    };

    // Live events wait while the history read is out, then go after it,
    // skipping any the history already held (by `sequence`).
    let seeded = false;
    let stopped = false;
    let lastSeeded = Number.NEGATIVE_INFINITY;
    const waiting: AgentChatEventEnvelope[] = [];
    const onEnvelope = (envelope: AgentChatEventEnvelope) => {
      if (!seeded) {
        waiting.push(envelope);
        return;
      }
      if (typeof envelope.sequence === "number" && envelope.sequence <= lastSeeded) return;
      apply(envelope);
    };
    const finishSeed = (history: readonly AgentChatEventEnvelope[]) => {
      if (stopped || seeded) return;
      replaying = true;
      for (const envelope of history) {
        apply(envelope);
        if (typeof envelope.sequence === "number" && envelope.sequence > lastSeeded) lastSeeded = envelope.sequence;
      }
      replaying = false;
      seeded = true;
      for (const envelope of waiting.splice(0)) onEnvelope(envelope);
    };
    const unsubscribe = subscribeWhenChatApiReady(
      () => window.ade?.agentChat,
      (api) => {
        const off = api.onEvent(onEnvelope, feedPin);
        const readHistory = api.getEventHistory;
        if (typeof readHistory !== "function") {
          finishSeed([]);
        } else {
          void Promise.resolve()
            .then(() => readHistory({ sessionId, maxEvents: SEED_HISTORY_EVENTS, maxBytes: SEED_HISTORY_MAX_BYTES }, feedPin))
            .then(
              (snapshot) => finishSeed(snapshot?.sessionId === sessionId && Array.isArray(snapshot.events) ? snapshot.events : []),
              (error: unknown) => {
                console.warn("[tools-pane] could not read this chat's recent tool calls", error);
                finishSeed([]);
              },
            );
        }
        return off;
      },
    );
    return () => {
      stopped = true;
      unsubscribe();
    };
    // Keyed on the pin's key, not the object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, sessionId, pinKey]);

  return activity;
}

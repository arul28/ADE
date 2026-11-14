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
  /** The machine the call named with `--machine`, when it named one. */
  machine: string | null;
  /** The last lines of a finished shell command's output, for the Terminal card. */
  tail: string | null;
};

export type ChatToolActivity = {
  byTool: Partial<Record<ToolActivityTool, ToolActivity>>;
  /** Commands running on other machines right now (`ade shell start --machine`). */
  remoteShellsRunning: number;
  /** The machines (as the commands named them) those commands run on. */
  remoteShellMachines: readonly string[];
};

const EMPTY: ChatToolActivity = { byTool: {}, remoteShellsRunning: 0, remoteShellMachines: [] };

const MAX_TAIL_CHARS = 160;

/** The last two non-empty lines of an output, ANSI and carriage returns dropped. */
function outputTail(output: string | null | undefined): string | null {
  if (!output) return null;
  const lines = output
    .slice(-4_000)
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\r/g, "").trimEnd())
    .filter((line) => line.trim().length > 0);
  if (!lines.length) return null;
  const tail = lines.slice(-2).join("\n");
  return tail.length > MAX_TAIL_CHARS ? `…${tail.slice(-MAX_TAIL_CHARS)}` : tail;
}

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

export type ClassifiedCommand = { tool: ToolActivityTool; text: string; machine: string | null; remoteShell: boolean } | null;

/** Which card a shell command belongs on, and what to say about it. Exported for the mock and the pane. */
export function classifyToolCommand(
  command: string,
  status: "running" | "completed" | "failed",
  output?: string | null,
): ClassifiedCommand {
  const text = unwrapShell(command);
  if (!text) return null;
  const machine = machineFlag(text);
  const summary = summarizeComputerUseCommand({ command: text, output: output ?? null, status });
  if (summary) {
    const tool = DOMAIN_TOOL[summary.domain];
    return tool ? { tool, text: computerUseActionText(summary), machine, remoteShell: false } : null;
  }
  // The agent's own status reports and device choices are not tool use.
  if (/\bade(?:\.exe|\.cmd)?\s+(?:chat\s+(?:activity|note|ask)|devices)\b/.test(text)) return null;
  const isAdeShell = /\bade(?:\.exe|\.cmd)?\s+shell\s+start\b/.test(text);
  const run = shortCommand(isAdeShell ? innerCommand(text) : text);
  const said = status === "running" ? `${run} running` : status === "failed" ? `${run} failed` : `Ran ${run}`;
  if (/^(?:\S*[\\/])?git\s/.test(text) || /\bade\s+git\s/.test(text)) return { tool: "git", text: said, machine, remoteShell: false };
  if (/^gh\s+pr\b|\bade\s+prs?\s/.test(text)) return { tool: "pr", text: said, machine, remoteShell: false };
  if (/^gh\s+issue\b|\bade\s+linear\b/.test(text)) return { tool: "issues", text: said, machine, remoteShell: false };
  return { tool: "terminal", text: said, machine, remoteShell: isAdeShell && machine != null };
}

/** True for `ade devices use …`: the chat's device choice may have changed. */
export function isDeviceChoiceCommand(command: string): boolean {
  return /\bade(?:\.exe|\.cmd)?\s+devices\s+use\b/.test(unwrapShell(command));
}

type Pending = { tool: ToolActivityTool; command: string; machine: string | null; remoteShell: boolean };

/**
 * The live activity per tool for one chat, on the chat's machine (`pin`: its
 * copy, the tab's own included). `sessionId` or `pin` null subscribes to
 * nothing. Keyed on the pin's key: a rebuilt pin is the same machine.
 * `onDeviceChoice` runs after the agent's `ade devices use` answers.
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
      const remote = [...pending.values()].filter((entry) => entry.remoteShell);
      const remoteShellMachines = [...new Set(remote.map((entry) => entry.machine).filter((name): name is string => Boolean(name)))];
      setActivity((current) => {
        if (
          current.byTool === byTool
          && current.remoteShellsRunning === remote.length
          && current.remoteShellMachines.join("|") === remoteShellMachines.join("|")
        ) return current;
        return { byTool, remoteShellsRunning: remote.length, remoteShellMachines };
      });
    };
    const record = (entry: ToolActivity) => {
      const previous = byTool[entry.tool];
      if (previous && previous.text === entry.text && previous.running === entry.running
        && previous.machine === entry.machine && previous.tail === entry.tail) return;
      byTool = { ...byTool, [entry.tool]: entry };
    };
    const startCommand = (itemId: string, command: string, at: number) => {
      if (isDeviceChoiceCommand(command)) deviceChoiceItems.add(itemId);
      const classified = classifyToolCommand(command, "running");
      if (!classified) return;
      pending.set(itemId, { tool: classified.tool, command, machine: classified.machine, remoteShell: classified.remoteShell });
      record({ tool: classified.tool, text: classified.text, running: true, at, machine: classified.machine, tail: null });
    };
    const finishCommand = (itemId: string, at: number, failed: boolean, output?: string | null, command?: string) => {
      if (deviceChoiceItems.delete(itemId)) onDeviceChoiceRef.current?.();
      const started = pending.get(itemId);
      pending.delete(itemId);
      const text = command ?? started?.command;
      if (!text) return;
      const classified = classifyToolCommand(text, failed ? "failed" : "completed", output);
      if (!classified) return;
      record({
        tool: classified.tool,
        text: classified.text,
        running: false,
        at,
        machine: classified.machine,
        tail: classified.tool === "terminal" ? outputTail(output) : null,
      });
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

    const onEnvelope = (envelope: AgentChatEventEnvelope) => {
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

    return subscribeWhenChatApiReady(
      () => window.ade?.agentChat,
      (api) => api.onEvent(onEnvelope, feedPin),
    );
    // Keyed on the pin's key, not the object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, sessionId, pinKey]);

  return activity;
}

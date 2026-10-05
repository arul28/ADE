import type { AgentChatEvent } from "../../../shared/types";
import { detectDevServersInChunk, devServerRegistry } from "./devServerRegistry";

/**
 * Dev-server discovery from an agent's own shell, which is not an ADE terminal.
 *
 * An agent that runs `npx vite --port 4180` through its Bash tool prints the
 * same ready line a terminal would, but that output never passes through the
 * PTY pipeline, so the registry never heard about it. The same matcher runs
 * here. A server started in the background prints nothing the agent captures,
 * so the activity itself is also passed on: the listener scan
 * (`devServerWatcher.ts`) uses it as its cue to look.
 */

/** An agent's own shell ran a command (a Bash tool call, a Codex command). */
export type AgentShellActivity = {
  sessionId: string;
  laneId: string | null;
  projectRoot: string | null;
  /** The command finished; a server it started in the background may be binding now. */
  finished: boolean;
};

/** Tool names whose result is a shell command's output. */
const SHELL_TOOL_NAME_PATTERN = /^(bash|shell|exec|exec_command|run_terminal_cmd|run_shell_command|terminal|command)$/i;
/** Running commands whose last half-written line is held for the next chunk. */
const MAX_TRACKED_ITEMS = 256;

const listeners = new Set<(activity: AgentShellActivity) => void>();

export function onAgentShellActivity(listener: (activity: AgentShellActivity) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The text of a shell tool's result, whatever shape the provider gave it. */
function shellToolResultText(result: unknown): string {
  const partsText = (parts: unknown[]): string => parts
    .map((part) => (typeof part === "string" ? part : typeof (part as { text?: unknown })?.text === "string" ? (part as { text: string }).text : ""))
    .join("\n");
  if (typeof result === "string") return result;
  if (Array.isArray(result)) return partsText(result);
  if (!result || typeof result !== "object") return "";
  const record = result as Record<string, unknown>;
  for (const key of ["stdout", "output", "content", "text"]) {
    const value = record[key];
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return partsText(value);
  }
  return "";
}

function record(input: Omit<AgentShellActivity, "finished">, detections: ReturnType<typeof detectDevServersInChunk>["detections"]): void {
  for (const detection of detections) {
    devServerRegistry.record({
      port: detection.port,
      url: detection.url,
      sessionId: input.sessionId,
      laneId: input.laneId,
      projectRoot: input.projectRoot,
    });
  }
}

/** A command finished: a server it started in the background may be binding now. */
function announceFinished(activity: AgentShellActivity): void {
  for (const listener of [...listeners]) {
    try {
      listener(activity);
    } catch {
      // A bad subscriber must not break chat event processing.
    }
  }
}

/**
 * One per chat service. `observe` takes every chat event and acts only on
 * shell output: a Codex `command` event, or a shell tool's result.
 */
export function createAgentShellOutputObserver(projectRoot: string | null) {
  /**
   * Session and item → the unfinished last line of a running command's output. A
   * running command streams only its new output per event, so a ready line can
   * be split across two events, exactly like a terminal's PTY chunks.
   */
  const carryByItem = new Map<string, string>();
  return {
    observe(session: { sessionId: string; laneId: string | null }, event: AgentChatEvent): void {
      let output: string;
      let finished = true;
      if (event.type === "command") {
        output = event.output;
        finished = event.status !== "running";
      } else if (event.type === "tool_result" && SHELL_TOOL_NAME_PATTERN.test(event.tool)) {
        output = shellToolResultText(event.result);
      } else {
        return;
      }
      const sessionId = session.sessionId.trim();
      if (!sessionId) return;
      const source = { sessionId, laneId: session.laneId, projectRoot };
      // Item ids are only unique within a session.
      const carryKey = `${sessionId}\u0000${event.itemId}`;
      try {
        if (finished) {
          // A finished event carries the whole output; the carry is moot.
          carryByItem.delete(carryKey);
          if (output) record(source, detectDevServersInChunk(`${output}\n`).detections);
          announceFinished({ ...source, finished: true });
          return;
        }
        const scan = detectDevServersInChunk(output, carryByItem.get(carryKey) ?? "");
        carryByItem.delete(carryKey);
        carryByItem.set(carryKey, scan.carry);
        if (carryByItem.size > MAX_TRACKED_ITEMS) {
          const oldest = carryByItem.keys().next().value;
          if (oldest) carryByItem.delete(oldest);
        }
        record(source, scan.detections);
      } catch {
        // Discovery is best-effort; it must never break the chat stream.
      }
    },
  };
}

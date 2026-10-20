import type { IPty, IWindowsPtyForkOptions } from "node-pty";
import * as nodePty from "node-pty";

type SpawnMessage = {
  type: "spawn";
  requestId: string;
  ptyId: string;
  command: string;
  args: string[] | string;
  options: IWindowsPtyForkOptions;
};

type WriteMessage = {
  type: "write";
  ptyId: string;
  data: string;
};

type ResizeMessage = {
  type: "resize";
  ptyId: string;
  cols: number;
  rows: number;
};

type KillMessage = {
  type: "kill";
  ptyId: string;
  signal?: string;
};

type FlowMessage = {
  type: "pause" | "resume";
  ptyId: string;
};

type AckMessage = {
  type: "ack";
  ptyId: string;
  chars: number;
};

type DisposeMessage = {
  type: "dispose";
  ptyId: string;
};

type HostMessage = SpawnMessage | WriteMessage | ResizeMessage | KillMessage | FlowMessage | AckMessage | DisposeMessage;

/**
 * Output sent to the parent but not yet acknowledged as processed. IPC sends
 * queue without limit, so without this a flood is read as fast as the PTY can
 * produce it and piles up in the parent; past the high mark the PTY stops
 * being read until the parent catches up.
 */
const PTY_HOST_UNACKED_HIGH_CHARS = 256 * 1024;
const PTY_HOST_UNACKED_LOW_CHARS = 64 * 1024;

type FlowState = {
  unackedChars: number;
  ackPaused: boolean;
  /** The parent asked for a pause (its own client is behind, a transcript rollover). */
  parentPaused: boolean;
  paused: boolean;
};

const ptys = new Map<string, IPty>();
const flow = new Map<string, FlowState>();

/** A paused PTY is never read to EOF, so its exit would not be reported. */
function resumeForExit(ptyId: string, pty: IPty): void {
  const state = flow.get(ptyId);
  if (state) {
    state.ackPaused = false;
    state.parentPaused = false;
    if (!state.paused) return;
    state.paused = false;
  }
  try {
    pty.resume();
  } catch {
    // The PTY may already be gone.
  }
}

function applyFlow(ptyId: string): void {
  const pty = ptys.get(ptyId);
  const state = flow.get(ptyId);
  if (!pty || !state) return;
  const paused = state.ackPaused || state.parentPaused;
  if (paused === state.paused) return;
  state.paused = paused;
  if (paused) pty.pause();
  else pty.resume();
}

function send(message: Record<string, unknown>): void {
  try {
    process.send?.(message);
  } catch {
    // Parent is gone; shutdown handlers will clean up the PTYs.
  }
}

function errorPayload(error: unknown): { message: string; stack?: string; code?: string } {
  return {
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    ...(typeof error === "object" && error != null && "code" in error
      ? { code: String((error as { code?: unknown }).code ?? "") }
      : {}),
  };
}

function disposePty(ptyId: string, signal?: string): void {
  const pty = ptys.get(ptyId);
  if (!pty) return;
  resumeForExit(ptyId, pty);
  ptys.delete(ptyId);
  flow.delete(ptyId);
  try {
    pty.kill(signal);
  } catch {
    // Best effort; the parent will mark the session dead if the host exits.
  }
}

function disposeAll(signal?: string): void {
  for (const ptyId of [...ptys.keys()]) {
    disposePty(ptyId, signal);
  }
}

function handleMessage(message: HostMessage): void {
  if (!message || typeof message !== "object") return;
  if (message.type === "spawn") {
    try {
      const pty = nodePty.spawn(message.command, message.args as string[] | string, message.options);
      ptys.set(message.ptyId, pty);
      const state: FlowState = { unackedChars: 0, ackPaused: false, parentPaused: false, paused: false };
      flow.set(message.ptyId, state);
      pty.onData((data) => {
        send({ type: "data", ptyId: message.ptyId, data });
        state.unackedChars += data.length;
        if (!state.ackPaused && state.unackedChars > PTY_HOST_UNACKED_HIGH_CHARS) {
          state.ackPaused = true;
          applyFlow(message.ptyId);
        }
      });
      pty.onExit((event) => {
        ptys.delete(message.ptyId);
        flow.delete(message.ptyId);
        send({
          type: "exit",
          ptyId: message.ptyId,
          exitCode: event.exitCode ?? null,
          signal: event.signal ?? null,
        });
      });
      send({
        type: "spawned",
        requestId: message.requestId,
        ptyId: message.ptyId,
        pid: pty.pid ?? null,
        process: pty.process ?? "",
        cols: pty.cols ?? message.options.cols ?? 80,
        rows: pty.rows ?? message.options.rows ?? 24,
      });
    } catch (error) {
      send({
        type: "spawnError",
        requestId: message.requestId,
        ptyId: message.ptyId,
        error: errorPayload(error),
      });
    }
    return;
  }

  const pty = ptys.get(message.ptyId);
  if (!pty) return;

  try {
    if (message.type === "write") {
      pty.write(message.data);
    } else if (message.type === "resize") {
      pty.resize(message.cols, message.rows);
    } else if (message.type === "kill") {
      resumeForExit(message.ptyId, pty);
      pty.kill(message.signal);
    } else if (message.type === "pause" || message.type === "resume") {
      const state = flow.get(message.ptyId);
      if (state) {
        state.parentPaused = message.type === "pause";
        applyFlow(message.ptyId);
      }
    } else if (message.type === "ack") {
      const state = flow.get(message.ptyId);
      if (state) {
        state.unackedChars = Math.max(0, state.unackedChars - message.chars);
        if (state.ackPaused && state.unackedChars < PTY_HOST_UNACKED_LOW_CHARS) {
          state.ackPaused = false;
          applyFlow(message.ptyId);
        }
      }
    } else if (message.type === "dispose") {
      disposePty(message.ptyId);
    }
  } catch (error) {
    send({
      type: "operationError",
      ptyId: message.ptyId,
      operation: message.type,
      error: errorPayload(error),
    });
  }
}

process.on("message", (message) => handleMessage(message as HostMessage));

process.once("disconnect", () => {
  disposeAll("SIGHUP");
  process.exit(0);
});

process.once("SIGTERM", () => {
  disposeAll("SIGTERM");
  process.exit(0);
});

process.once("SIGINT", () => {
  disposeAll("SIGINT");
  process.exit(0);
});

process.on("uncaughtException", (error) => {
  send({ type: "fatal", error: errorPayload(error) });
  disposeAll("SIGHUP");
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  send({ type: "fatal", error: errorPayload(reason) });
  disposeAll("SIGHUP");
  process.exit(1);
});

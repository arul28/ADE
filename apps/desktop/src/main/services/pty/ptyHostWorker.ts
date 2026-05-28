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

type DisposeMessage = {
  type: "dispose";
  ptyId: string;
};

type HostMessage = SpawnMessage | WriteMessage | ResizeMessage | KillMessage | DisposeMessage;

const ptys = new Map<string, IPty>();

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
  ptys.delete(ptyId);
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
      pty.onData((data) => {
        send({ type: "data", ptyId: message.ptyId, data });
      });
      pty.onExit((event) => {
        ptys.delete(message.ptyId);
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
      pty.kill(message.signal);
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

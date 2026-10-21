/**
 * One JSON request to a Node child and one JSON answer back: the child is
 * `process.execPath` with `ELECTRON_RUN_AS_NODE=1` running the bundled `.cjs`
 * in a build or the `.ts` entry in a source run, reads its request on stdin,
 * writes its answer on stdout and exits.
 *
 * Every child is tracked in the caller's `live` set from spawn until its run
 * settles, and every settle path (answer, error, timeout, oversized output)
 * terminates it, so {@link terminateJsonChildProcesses} at app quit reaches
 * whatever is still running: Node does not reap non-detached children when the
 * parent exits on macOS.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { terminateProcessTree } from "./processExecution";

export type JsonChildProcessSet = Set<ChildProcessWithoutNullStreams>;

export type JsonChildOutcome =
  | { kind: "answered"; value: unknown }
  /** The child could not run at all: the request has not been read anywhere. */
  | { kind: "unavailable"; reason: string }
  /** The child ran and failed, hung, or answered garbage. */
  | { kind: "failed"; reason: string };

/** The worker script: an env override, else the bundled `.cjs` next to this build, else the `.ts` source entry. */
export function resolveJsonChildWorkerPath(args: {
  envVar: string;
  baseDir: string;
  bundledName: string;
  sourceEntryName: string;
}): string {
  const configured = process.env[args.envVar]?.trim();
  if (configured) return configured;
  const candidates = [path.join(args.baseDir, args.bundledName), path.join(args.baseDir, args.sourceEntryName)];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!;
}

/** Kills every child still in `live`; returns how many it reached. */
export function terminateJsonChildProcesses(live: JsonChildProcessSet): number {
  const children = [...live];
  live.clear();
  for (const child of children) {
    try {
      terminateProcessTree(child);
    } catch {
      // Best effort: a child that already exited is the good outcome.
    }
  }
  return children.length;
}

export function runJsonChildProcess(args: {
  workerPath: string;
  request: unknown;
  /** Where the child is tracked while it runs, for {@link terminateJsonChildProcesses}. */
  live: JsonChildProcessSet;
  /** Kills the child and fails the run when there is no answer by then. */
  timeoutMs?: number;
  /** Kills the child and fails the run when stdout grows past this. */
  maxOutputBytes?: number;
}): Promise<JsonChildOutcome> {
  const { workerPath, live } = args;
  if (!fs.existsSync(workerPath)) {
    return Promise.resolve({ kind: "unavailable", reason: "helper missing from this build" });
  }
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        process.execPath,
        [...(workerPath.endsWith(".ts") ? process.execArgv : []), workerPath],
        { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
      );
    } catch (error) {
      resolve({ kind: "unavailable", reason: error instanceof Error ? error.message : String(error) });
      return;
    }
    live.add(child);

    let settled = false;
    let spawned = false;
    const chunks: Buffer[] = [];
    let bytes = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (outcome: JsonChildOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (live.delete(child)) {
        try {
          terminateProcessTree(child);
        } catch {
          // Already gone: the ordinary case once it has answered.
        }
      }
      resolve(outcome);
    };
    if (args.timeoutMs != null) {
      const timeoutMs = args.timeoutMs;
      timer = setTimeout(() => {
        finish({ kind: "failed", reason: `no answer within ${timeoutMs} ms` });
      }, timeoutMs);
      timer.unref?.();
    }

    child.on("spawn", () => {
      spawned = true;
    });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (args.maxOutputBytes != null && bytes > args.maxOutputBytes) {
        finish({ kind: "failed", reason: "answer too large" });
        return;
      }
      chunks.push(chunk);
    });
    // Workers can print paths and prompts there; nothing of it is kept.
    child.stderr.resume();
    child.on("error", (error) => {
      const reason = error instanceof Error ? error.message : String(error);
      finish(spawned ? { kind: "failed", reason } : { kind: "unavailable", reason });
    });
    child.on("close", (code) => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) {
        finish({ kind: "failed", reason: `exited (${code ?? "signal"}) without answering` });
        return;
      }
      try {
        finish({ kind: "answered", value: JSON.parse(raw) as unknown });
      } catch {
        finish({ kind: "failed", reason: "unreadable answer" });
      }
    });
    child.stdin.on("error", () => {
      // A child that died before reading its request reports through `close`.
    });
    child.stdin.end(JSON.stringify(args.request));
  });
}

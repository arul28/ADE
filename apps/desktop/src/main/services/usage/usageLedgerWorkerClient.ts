import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { CostSnapshot, UsageProvider } from "../../../shared/types";
import { isRecord } from "../shared/utils";
import { terminateProcessTree } from "../shared/processExecution";

const LEDGER_WORKER_TIMEOUT_MS = 90_000;
const LEDGER_WORKER_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const LEDGER_WORKER_MAX_ERROR_BYTES = 64 * 1024;
const INTERNAL_LEDGER_WORKER_ARG = "__ade-usage-ledger-worker";

export type UsageLedgerScanResult = {
  costs: CostSnapshot[];
  projectCosts: CostSnapshot[];
  daily7d: Partial<Record<UsageProvider, number[]>>;
  entryCounts: Record<string, number>;
  providerErrors: Record<string, string>;
};

type WorkerOptions = {
  signal?: AbortSignal;
  workerPath?: string;
  spawnWorker?: typeof spawn;
  /** Test seam for the Node SEA runtime, whose executable embeds the worker. */
  embeddedRuntime?: boolean;
};

function abortError(): Error {
  const error = new Error("Usage ledger scan cancelled");
  error.name = "AbortError";
  return error;
}

export function resolveUsageLedgerWorkerPath(baseDir = __dirname): string {
  const configured = process.env.ADE_USAGE_LEDGER_WORKER_PATH?.trim();
  if (configured) return configured;
  const candidates = [
    path.join(baseDir, "usageLedgerWorker.cjs"),
    // `npm run dev` executes the source graph through tsx. Reuse its loader in
    // the child so development gets the same event-loop isolation as builds.
    path.join(baseDir, "usageLedgerWorkerEntry.ts"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!;
}

function isEmbeddedAdeRuntime(): boolean {
  const sea = process.getBuiltinModule?.("node:sea") as { isSea?: () => boolean } | undefined;
  return sea?.isSea?.() === true;
}

function isCostSnapshot(value: unknown): value is CostSnapshot {
  return isRecord(value)
    && typeof value.provider === "string"
    && typeof value.todayCostUsd === "number"
    && typeof value.last30dCostUsd === "number"
    && isRecord(value.tokenBreakdown);
}

function isUsageProvider(value: string): value is UsageProvider {
  return value === "claude" || value === "codex" || value === "cursor";
}

function invalidWorkerResult(): never {
  throw new Error("Usage ledger worker returned an invalid result");
}

export function parseUsageLedgerWorkerResult(raw: string): UsageLedgerScanResult {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)
    || !Array.isArray(parsed.costs)
    || !parsed.costs.every(isCostSnapshot)
    || !Array.isArray(parsed.projectCosts)
    || !parsed.projectCosts.every(isCostSnapshot)
    || !isRecord(parsed.daily7d)
    || !isRecord(parsed.entryCounts)
    || !isRecord(parsed.providerErrors)) {
    invalidWorkerResult();
  }

  const daily7d: Partial<Record<UsageProvider, number[]>> = {};
  for (const [provider, value] of Object.entries(parsed.daily7d)) {
    if (
      !isUsageProvider(provider)
      || !Array.isArray(value)
      || !value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
    ) {
      invalidWorkerResult();
    }
    daily7d[provider] = value;
  }

  const entryCounts: Record<string, number> = {};
  for (const [provider, value] of Object.entries(parsed.entryCounts)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      invalidWorkerResult();
    }
    entryCounts[provider] = value;
  }

  const providerErrors: Record<string, string> = {};
  for (const [provider, value] of Object.entries(parsed.providerErrors)) {
    if (typeof value !== "string") invalidWorkerResult();
    providerErrors[provider] = value;
  }

  return {
    costs: parsed.costs,
    projectCosts: parsed.projectCosts,
    daily7d,
    entryCounts,
    providerErrors,
  };
}

export function scanUsageLedgersInWorker(
  projectRoot: string | null | undefined,
  options: WorkerOptions = {},
): Promise<UsageLedgerScanResult> {
  const embeddedRuntime = options.embeddedRuntime ?? isEmbeddedAdeRuntime();
  const workerPath = options.workerPath ?? (embeddedRuntime ? null : resolveUsageLedgerWorkerPath());
  if (workerPath && !fs.existsSync(workerPath)) {
    return Promise.reject(new Error(`Usage ledger worker is missing: ${workerPath}`));
  }
  if (options.signal?.aborted) return Promise.reject(abortError());

  return new Promise((resolve, reject) => {
    const spawnWorker = options.spawnWorker ?? spawn;
    const env = { ...process.env };
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
    let child: ChildProcessWithoutNullStreams;
    try {
      const workerArgs = embeddedRuntime
        ? [INTERNAL_LEDGER_WORKER_ARG]
        : [
            ...(!options.workerPath && workerPath?.endsWith(".ts") ? process.execArgv : []),
            workerPath!,
          ];
      child = spawnWorker(process.execPath, workerArgs, {
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      reject(error);
      return;
    }
    if (!options.spawnWorker && typeof child.pid === "number") {
      try {
        os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch {
        // Best effort: isolation is the correctness boundary; priority is an
        // additional guard against ledger IO competing with active chats.
      }
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const fail = (error: Error) => {
      finish(() => {
        terminateProcessTree(child);
        reject(error);
      });
    };
    const onAbort = () => fail(abortError());
    const timeout = setTimeout(() => {
      fail(new Error(`Usage ledger worker timed out after ${LEDGER_WORKER_TIMEOUT_MS}ms`));
    }, LEDGER_WORKER_TIMEOUT_MS);
    timeout.unref?.();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout, "utf8") > LEDGER_WORKER_MAX_OUTPUT_BYTES) {
        fail(new Error("Usage ledger worker produced too much output"));
      }
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      if (Buffer.byteLength(stderr, "utf8") >= LEDGER_WORKER_MAX_ERROR_BYTES) return;
      stderr += chunk.toString();
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code, signal) => {
      finish(() => {
        if (code !== 0) {
          const detail = stderr.trim().slice(0, LEDGER_WORKER_MAX_ERROR_BYTES);
          reject(new Error(`Usage ledger worker exited with ${code ?? signal ?? "unknown"}${detail ? `: ${detail}` : ""}`));
          return;
        }
        try {
          resolve(parseUsageLedgerWorkerResult(stdout));
        } catch (error) {
          reject(error);
        }
      });
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") fail(error);
    });
    child.stdin.end(JSON.stringify({ projectRoot: projectRoot ?? null }));
  });
}

export const _testing = {
  LEDGER_WORKER_TIMEOUT_MS,
  LEDGER_WORKER_MAX_OUTPUT_BYTES,
  LEDGER_WORKER_MAX_ERROR_BYTES,
  INTERNAL_LEDGER_WORKER_ARG,
};

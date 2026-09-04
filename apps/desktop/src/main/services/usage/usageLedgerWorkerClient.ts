import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { CostSnapshot, UsageProvider } from "../../../shared/types";
import { isRecord } from "../shared/utils";
import { terminateProcessTree } from "../shared/processExecution";

/**
 * A ceiling for a wedged child, not a budget for a normal scan.
 *
 * Measured on a machine with 32 GB of Codex sessions: 78s for all nine
 * providers, 60s of it Codex alone — against the 90s this used to be. The scan
 * budgets allow up to 64 GB of Codex transcripts, which is roughly twice what
 * was measured, so 90s could not have finished the work it was asked to do.
 * A timeout there is not a slow page: `refreshHistory` rethrows,
 * `costCacheTimestamp` stays 0, the Usage page reads zero, and
 * `getUsageRollup()` returns null forever, so the machine reports to every peer
 * as permanently "still reading its history".
 *
 * Ten minutes because the only thing this now protects against is a child that
 * will never finish: the scan is out-of-process, priority-lowered, runs on a 1h
 * TTL, and — since the streaming protocol below — a timeout yields whatever
 * providers did land rather than nothing at all.
 */
export const LEDGER_WORKER_TIMEOUT_MS = 600_000;
/**
 * Measured payload for that same 32 GB machine: 0.21 MiB for all nine
 * providers' machine- and project-scoped snapshots together, so this cap has
 * ~75x of headroom even after `PROVIDER_SCOPE_SUPPORT` began emitting project
 * breakdowns for eight providers instead of two. It bounds a malformed or
 * runaway worker, nothing a real scan produces.
 */
const LEDGER_WORKER_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const LEDGER_WORKER_MAX_ERROR_BYTES = 64 * 1024;
const INTERNAL_LEDGER_WORKER_ARG = "__ade-usage-ledger-worker";

/**
 * First line of the streaming protocol: the roster the worker is about to walk.
 *
 * The worker used to buffer all nine providers and write one JSON object at the
 * very end, so a timeout — or any failure — discarded eight finished scans
 * along with the one that was still running. It now writes one line per
 * provider as that provider finishes, and this header names the full roster so
 * the client can tell "this provider reported nothing" from "this provider
 * never got to run", and mark the latter incomplete rather than removed.
 */
export const LEDGER_STREAM_HEADER_KIND = "ade-usage-ledger-stream/1";

export type UsageLedgerProviderChunk = {
  provider: string;
  costs: CostSnapshot[];
  projectCosts: CostSnapshot[];
  /**
   * Project-scoped snapshots keyed by project root, for every root the caller
   * asked about. One brain hosts several project scopes and polls the ledgers
   * once for all of them, so the single `projectCosts` above (the primary
   * root) is not enough to answer a second scope's project-scoped question.
   */
  projectCostsByRoot?: Record<string, CostSnapshot[]>;
  /** Seven daily buckets. Only Claude and Codex report these. */
  daily7d?: number[];
  entryCount: number;
  /** The scan threw outright. */
  error?: string;
  /** The scan returned, but could not read everything under its root. */
  incomplete?: boolean;
};

export type UsageLedgerScanResult = {
  costs: CostSnapshot[];
  projectCosts: CostSnapshot[];
  /** Per-project-root snapshots for every root the caller asked about. */
  projectCostsByRoot: Record<string, CostSnapshot[]>;
  daily7d: Partial<Record<UsageProvider, number[]>>;
  entryCounts: Record<string, number>;
  providerErrors: Record<string, string>;
  /**
   * Providers the scan reached but could not read in full — a directory that
   * refused to list, a locked ledger database, a transcript that would not
   * open — plus providers whose root exists and yielded nothing at all.
   *
   * Distinct from `providerErrors`, which is the coarser "the whole scan
   * threw". Both are consumed the same way, in exactly one place: they become
   * `publishLocalRollup`'s `skipReconcileProviders`, so the rows this round
   * failed to produce are not read as a deletion and do not wipe replicated
   * history on every peer. The same set also carries the previous round's cost
   * snapshots forward, so a partial scan cannot lower a provider's totals.
   */
  incompleteProviders: string[];
};

/** Nine providers, each an ASCII slug. This only bounds a malformed payload. */
const MAX_INCOMPLETE_PROVIDERS = 64;
const MAX_PROVIDER_NAME_LENGTH = 128;

type WorkerOptions = {
  signal?: AbortSignal;
  /**
   * Extra project roots to attribute this scan to, beyond `projectRoot`. The
   * ledgers are walked once and projected per root, which is what lets one
   * brain answer project-scoped usage for every project it hosts without
   * re-reading gigabytes of transcripts per scope.
   */
  additionalProjectRoots?: readonly (string | null | undefined)[];
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

function parseProjectCostsByRoot(value: unknown): Record<string, CostSnapshot[]> {
  if (!isRecord(value)) return {};
  const parsed: Record<string, CostSnapshot[]> = {};
  for (const [root, snapshots] of Object.entries(value)) {
    if (!root) continue;
    if (!Array.isArray(snapshots) || !snapshots.every(isCostSnapshot)) continue;
    parsed[root] = snapshots;
  }
  return parsed;
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

  // Absent is treated as "none", not as invalid: the field is additive, and a
  // worker result that predates it is still a perfectly good scan.
  if (parsed.incompleteProviders !== undefined && !Array.isArray(parsed.incompleteProviders)) {
    invalidWorkerResult();
  }
  const incompleteProviders: string[] = [];
  for (const provider of parsed.incompleteProviders ?? []) {
    if (typeof provider !== "string") invalidWorkerResult();
    if (!provider || provider.length > MAX_PROVIDER_NAME_LENGTH) continue;
    if (incompleteProviders.includes(provider)) continue;
    if (incompleteProviders.length >= MAX_INCOMPLETE_PROVIDERS) break;
    incompleteProviders.push(provider);
  }

  return {
    costs: parsed.costs,
    projectCosts: parsed.projectCosts,
    projectCostsByRoot: parseProjectCostsByRoot(parsed.projectCostsByRoot),
    daily7d,
    entryCounts,
    providerErrors,
    incompleteProviders,
  };
}

/**
 * Accumulates the worker's per-provider lines into one scan result.
 *
 * Tolerant by construction: a line that is not valid JSON, or is missing the
 * fields a provider chunk must have, is dropped rather than failing the scan.
 * The alternative is throwing away eight good providers over one malformed
 * line, which is the failure mode this protocol exists to remove.
 */
function createLedgerStreamReader() {
  let pending = "";
  let sawHeader = false;
  let roster: string[] = [];
  const chunks = new Map<string, UsageLedgerProviderChunk>();

  const readLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    if (parsed.kind === LEDGER_STREAM_HEADER_KIND) {
      sawHeader = true;
      roster = Array.isArray(parsed.providers)
        ? parsed.providers.filter((entry): entry is string =>
          typeof entry === "string" && entry.length > 0 && entry.length <= MAX_PROVIDER_NAME_LENGTH)
        : [];
      return;
    }
    if (typeof parsed.provider !== "string" || !parsed.provider) return;
    if (!Array.isArray(parsed.costs) || !parsed.costs.every(isCostSnapshot)) return;
    if (!Array.isArray(parsed.projectCosts) || !parsed.projectCosts.every(isCostSnapshot)) return;
    const daily7d = Array.isArray(parsed.daily7d)
      && parsed.daily7d.every((entry) => typeof entry === "number" && Number.isFinite(entry))
      ? (parsed.daily7d as number[])
      : undefined;
    chunks.set(parsed.provider, {
      provider: parsed.provider,
      costs: parsed.costs,
      projectCosts: parsed.projectCosts,
      projectCostsByRoot: parseProjectCostsByRoot(parsed.projectCostsByRoot),
      ...(daily7d ? { daily7d } : {}),
      entryCount: typeof parsed.entryCount === "number" && Number.isFinite(parsed.entryCount)
        ? Math.max(0, parsed.entryCount)
        : 0,
      ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
      ...(parsed.incomplete === true ? { incomplete: true } : {}),
    });
  };

  return {
    /** True once the header line has arrived, i.e. this really is a stream. */
    isStream: () => sawHeader,
    providersSeen: () => chunks.size,
    push(text: string): void {
      pending += text;
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        readLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    },
    /** Consume any trailing line that arrived without its newline. */
    flush(): void {
      if (!pending) return;
      readLine(pending);
      pending = "";
    },
    fold(): UsageLedgerScanResult {
      const result: UsageLedgerScanResult = {
        costs: [],
        projectCosts: [],
        projectCostsByRoot: {},
        daily7d: {},
        entryCounts: {},
        providerErrors: {},
        incompleteProviders: [],
      };
      for (const chunk of chunks.values()) {
        result.costs.push(...chunk.costs);
        result.projectCosts.push(...chunk.projectCosts);
        for (const [root, snapshots] of Object.entries(chunk.projectCostsByRoot ?? {})) {
          (result.projectCostsByRoot[root] ??= []).push(...snapshots);
        }
        result.entryCounts[chunk.provider] = chunk.entryCount;
        if (chunk.daily7d && isUsageProvider(chunk.provider)) {
          result.daily7d[chunk.provider] = chunk.daily7d;
        }
        if (chunk.error !== undefined) result.providerErrors[chunk.provider] = chunk.error;
        if (chunk.incomplete) result.incompleteProviders.push(chunk.provider);
      }
      // A provider on the roster that never wrote a line did not run — the scan
      // was cut short. Absent-because-unread is exactly what `incomplete` means,
      // and it is what keeps `publishLocalRollup` from reading the gap as a
      // removal and deleting that provider's replicated history.
      for (const provider of roster) {
        if (chunks.has(provider)) continue;
        if (result.incompleteProviders.includes(provider)) continue;
        if (result.incompleteProviders.length >= MAX_INCOMPLETE_PROVIDERS) break;
        result.incompleteProviders.push(provider);
      }
      return result;
    },
  };
}

export function scanUsageLedgersInWorker(
  projectRoot: string | null | undefined,
  options: WorkerOptions = {},
): Promise<UsageLedgerScanResult> {
  const projectRoots = [...new Set(
    [projectRoot, ...(options.additionalProjectRoots ?? [])]
      .filter((root): root is string => typeof root === "string" && root.trim().length > 0),
  )];
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
    const stream = createLedgerStreamReader();
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
      // Everything that finished before the deadline is still true. Handing
      // back eight providers and marking the ninth incomplete is strictly
      // better than the alternative, which leaves `costCacheTimestamp` at 0 and
      // the Usage page reading zero until the process is restarted.
      if (stream.isStream() && stream.providersSeen() > 0) {
        const partial = stream.fold();
        finish(() => {
          terminateProcessTree(child);
          resolve(partial);
        });
        return;
      }
      fail(new Error(`Usage ledger worker timed out after ${LEDGER_WORKER_TIMEOUT_MS}ms`));
    }, LEDGER_WORKER_TIMEOUT_MS);
    timeout.unref?.();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stdout += text;
      stream.push(text);
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
        stream.flush();
        if (stream.isStream()) {
          resolve(stream.fold());
          return;
        }
        // A worker that wrote one whole-result object instead of a stream: the
        // shape this protocol replaced, still parsed so the two can be swapped
        // independently.
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
    child.stdin.end(JSON.stringify({ projectRoot: projectRoot ?? null, projectRoots }));
  });
}

export const _testing = {
  LEDGER_WORKER_TIMEOUT_MS,
  LEDGER_WORKER_MAX_OUTPUT_BYTES,
  LEDGER_WORKER_MAX_ERROR_BYTES,
  INTERNAL_LEDGER_WORKER_ARG,
};

// cd apps/ade-cli && npx tsx ../../scripts/perf/service/slash-discovery.bench.mts
// Uncached slash-command discovery, the work `chat.getSlashCommands` does on a cache miss, run
// against the skill and command folders of this machine (CWD defaults to this checkout; set
// CWD to point elsewhere). Every run clears the discovery cache first. A 1 ms interval, plus a
// read after the discovery returns, records the longest gap between event-loop turns: the
// longest time any other RPC on the brain had to wait. One warm-up run is excluded.
// Parity: where the tree has an asynchronous discovery next to the synchronous one, both run
// on the same tree and their lists are compared entry by entry (mismatches must be 0).
// Full path: the same timing for the Claude listing the RPC returns, i.e. discovery, one row per
// command, then the merge that sorts by name. Run once with the pre-fix sort (`localeCompare` with
// options, copied from the old getSlashCommands closure) and once with `mergeSlashCommands`, back to
// back, alternating order. Parity: both sorts must give the same list (mismatches must be 0).
// Env: RUNS (default 12), CWD.
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import * as claude from "../../../apps/desktop/src/main/services/chat/claudeSlashCommandDiscovery";
import * as codex from "../../../apps/desktop/src/main/services/chat/codexSlashCommandDiscovery";
import * as cursor from "../../../apps/desktop/src/main/services/chat/cursorSlashCommandDiscovery";
import { mergeSlashCommands } from "../../../apps/desktop/src/main/services/chat/markdownSlashCommandDiscovery";

type AnyFn = (...args: never[]) => unknown;
const exported = (mod: object, name: string): AnyFn | undefined =>
  (mod as Record<string, unknown>)[name] as AnyFn | undefined;

const RUNS = Number(process.env.RUNS ?? 12);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cwd = process.env.CWD ?? repoRoot;

// The asynchronous discovery is what the chat-switch RPC runs; before it exists, the synchronous one is measured.
const claudeAsync = exported(claude, "discoverClaudeSlashCommandsAsync") as ((cwd: string) => Promise<unknown>) | undefined;
const claudeSync = claude.discoverClaudeSlashCommands;
const mode = claudeAsync ? "async" : "sync";
const discoverClaude = claudeAsync ?? claudeSync;

const median = (xs: number[]): number => {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const round = (x: number): number => Math.round(x * 10) / 10;
const summary = (xs: number[]) => ({
  median: round(median(xs)),
  min: round(Math.min(...xs)),
  max: round(Math.max(...xs)),
  perRun: xs.map(round),
});

async function timeUncached(run: () => unknown): Promise<{ maxBlockMs: number; wallMs: number; count: number }> {
  claude.invalidateClaudeSlashCommandCache();
  let last = performance.now();
  let maxBlockMs = 0;
  const tick = setInterval(() => {
    const now = performance.now();
    maxBlockMs = Math.max(maxBlockMs, now - last);
    last = now;
  }, 1);
  const start = performance.now();
  let result: unknown;
  try {
    result = await run();
  } finally {
    clearInterval(tick);
  }
  const end = performance.now();
  // A synchronous walk never returns control to the timer, so its whole length shows up here.
  maxBlockMs = Math.max(maxBlockMs, end - last);
  return { maxBlockMs, wallMs: end - start, count: Array.isArray(result) ? result.length : 0 };
}

/** Entries that differ between two lists by position, plus any difference in length. */
function mismatchesBetween(a: unknown, b: unknown): number {
  if (!Array.isArray(a) || !Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b) ? 0 : 1;
  let differing = Math.abs(a.length - b.length);
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) differing += 1;
  }
  return differing;
}

async function parityFor(label: string, syncRun: () => unknown, asyncRun: (() => Promise<unknown>) | undefined, invalidate: () => void) {
  if (!asyncRun) return null;
  invalidate();
  const expected = syncRun();
  invalidate();
  const actual = await asyncRun();
  return { label, entries: Array.isArray(expected) ? expected.length : 0, mismatches: mismatchesBetween(expected, actual) };
}

// Warm-up: the first walk pays for cold module loading and page-cache misses that a chat switch does not.
await timeUncached(() => discoverClaude(cwd));

const codexAsync = exported(codex, "discoverCodexSlashCommandsAsync") as ((cwd: string) => Promise<unknown>) | undefined;
const cursorAsync = exported(cursor, "discoverCursorSlashCommandsAsync") as ((cwd: string) => Promise<unknown>) | undefined;

const parity = [
  await parityFor(
    "claude",
    () => claudeSync(cwd),
    claudeAsync ? () => claudeAsync(cwd) : undefined,
    () => claude.invalidateClaudeSlashCommandCache(),
  ),
  await parityFor(
    "codex",
    () => codex.discoverCodexSlashCommands(cwd),
    codexAsync ? () => codexAsync(cwd) : undefined,
    () => {},
  ),
  await parityFor(
    "cursor",
    () => cursor.discoverCursorSlashCommands(cwd),
    cursorAsync ? () => cursorAsync(cwd) : undefined,
    () => {},
  ),
].filter((row) => row !== null);

const runs: { maxBlockMs: number; wallMs: number; count: number }[] = [];
for (let i = 0; i < RUNS; i += 1) runs.push(await timeUncached(() => discoverClaude(cwd)));

// Full path. The row shape mirrors the Claude branch of getSlashCommands; the built-in list and the
// GUI filter are left out (small and linear, not sorts).
type ListingRow = { name: string; description: string; argumentHint?: string; source: "sdk"; kind: "command" | "skill" };
type MergeFn = <T extends { name: string }>(groups: readonly (readonly T[])[]) => T[];

/** The merge as the pre-fix getSlashCommands closure had it (65ee42e25): the same Map, sorted with localeCompare and its options. */
function legacyMerge<T extends { name: string }>(groups: readonly (readonly T[])[]): T[] {
  const merged = new Map<string, T>();
  for (const group of groups) {
    for (const command of group) merged.set(command.name.trim().toLowerCase(), command);
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

const variants: [label: string, merge: MergeFn][] = [
  ["legacySort", legacyMerge],
  ["sharedCollator", mergeSlashCommands],
];

const toListingRow = (cmd: claude.DiscoveredClaudeSlashCommand): ListingRow => ({
  name: cmd.name,
  description: cmd.description,
  argumentHint: cmd.argumentHint,
  source: "sdk",
  kind: cmd.source === "skill" ? "skill" : "command",
});

/** Discovery, then the Claude listing merge: what chat.getSlashCommands does for a Claude chat on a cache miss. */
async function claudeListing(merge: MergeFn): Promise<ListingRow[]> {
  const discovered = (await discoverClaude(cwd)) as claude.DiscoveredClaudeSlashCommand[];
  return merge([discovered.map(toListingRow)]);
}

const fullPathParity = await (async () => {
  claude.invalidateClaudeSlashCommandCache();
  const expected = await claudeListing(legacyMerge);
  claude.invalidateClaudeSlashCommandCache();
  const actual = await claudeListing(mergeSlashCommands);
  return { entries: expected.length, mismatches: mismatchesBetween(expected, actual) };
})();

const fullPathRuns: Record<string, { maxBlockMs: number; wallMs: number; count: number }[]> = {};
for (const [label] of variants) fullPathRuns[label] = [];
for (const [, merge] of variants) await timeUncached(() => claudeListing(merge));
for (let i = 0; i < RUNS; i += 1) {
  for (const [label, merge] of i % 2 ? [...variants].reverse() : variants) {
    fullPathRuns[label]!.push(await timeUncached(() => claudeListing(merge)));
  }
}

// The merge alone, without any discovery time, on the rows the RPC would merge (discovery order),
// and on the same rows shuffled with a fixed seed (a worst-case input for the sort).
const sampleRows = ((await discoverClaude(cwd)) as claude.DiscoveredClaudeSlashCommand[]).map(toListingRow);
const shuffledRows = [...sampleRows];
for (let i = shuffledRows.length - 1, seed = 1; i > 0; i -= 1) {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  const j = seed % (i + 1);
  [shuffledRows[i], shuffledRows[j]] = [shuffledRows[j]!, shuffledRows[i]!];
}
const orders: [label: string, rows: ListingRow[]][] = [["rpcOrder", sampleRows], ["shuffled", shuffledRows]];
const mergeMs: Record<string, number[]> = {};
for (const [order] of orders) for (const [label] of variants) mergeMs[`${label}.${order}`] = [];
for (let i = 0; i < RUNS; i += 1) {
  for (const [order, rows] of orders) {
    for (const [label, merge] of i % 2 ? [...variants].reverse() : variants) {
      const start = performance.now();
      merge([rows]);
      mergeMs[`${label}.${order}`]!.push(performance.now() - start);
    }
  }
}

const perVariant = (pick: (run: { maxBlockMs: number; wallMs: number }) => number) =>
  Object.fromEntries(variants.map(([label]) => [label, summary(fullPathRuns[label]!.map(pick))]));

console.log(JSON.stringify({
  mode,
  cwd,
  n: RUNS,
  commands: runs[0]?.count ?? 0,
  maxBlockMs: summary(runs.map((r) => r.maxBlockMs)),
  wallMs: summary(runs.map((r) => r.wallMs)),
  parity,
  fullPath: {
    entries: fullPathParity.entries,
    parityMismatches: fullPathParity.mismatches,
    maxBlockMs: perVariant((r) => r.maxBlockMs),
    wallMs: perVariant((r) => r.wallMs),
    mergeMs: Object.fromEntries(Object.entries(mergeMs).map(([key, xs]) => [key, summary(xs)])),
  },
}));

#!/usr/bin/env node
/**
 * Desktop lint for CI, with a ratchet for the `ade-ui/*` rules.
 *
 *   npm run lint:ci         lint once; exit 1 on any error, or when a file's
 *                           count for an ade-ui rule grows past the baseline
 *   npm run lint:baseline   lint once and rewrite lint-baseline.json
 *
 * The ade-ui rules (eslint-rules/ade-ui.mjs) are warnings, so existing code
 * keeps building; the baseline records how many each file has today and CI
 * only lets those numbers go down. Guide: docs/design/notices.md.
 *
 * Flags: --update (write the baseline), --baseline <path> (read/write a
 * different baseline file), --warnings (also print every warning),
 * --workers <n> (lint in n worker threads; default: one per CPU, up to
 * MAX_WORKERS; 1 lints in this process).
 *
 * The files are the ones `npm run lint` lints (see LINT_DIR). They are split
 * across worker threads by size, and the results are merged and sorted by path
 * before the ratchet compares them, so the output does not depend on the
 * number of workers. No rule keeps state across files, so the split cannot
 * change a result.
 *
 * The npm scripts pass --max-old-space-size=8192, like `npm run lint`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

export const RATCHET_RULE_PREFIX = "ade-ui/";
// The same files as `eslint "src/**/*.{ts,tsx}"`: every .ts/.tsx under src
// that the config does not ignore.
const LINT_DIR = "src";
const LINT_FILE = /\.tsx?$/;
// Each worker loads ESLint, the plugins and the TypeScript parser once and
// holds about 1 GB. Measured on a 14-core Mac: 1 worker 36 s, 4 workers 14 s,
// 8 workers 12 s. More workers add memory for little gain. CI has 4 CPUs.
const MAX_WORKERS = 8;
const WORKER_MARKER = "adeLintRatchetWorker";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopDir, "..", "..");
const DEFAULT_BASELINE = path.join(desktopDir, "lint-baseline.json");

/** Repo-relative, forward-slash path (stable across macOS, Linux, Windows). */
export function repoRelative(filePath, root = repoRoot) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

/** `{ [file]: { [rule]: count } }` for ratcheted rules, keys sorted. */
export function countRatchetViolations(results, root = repoRoot) {
  const counts = {};
  for (const result of results) {
    // Suppressed messages count too: an `eslint-disable` comment must not be a
    // way to shrink the number the ratchet compares against the baseline.
    for (const message of [...result.messages, ...(result.suppressedMessages ?? [])]) {
      if (!message.ruleId || !message.ruleId.startsWith(RATCHET_RULE_PREFIX)) continue;
      const file = repoRelative(result.filePath, root);
      counts[file] ??= {};
      counts[file][message.ruleId] = (counts[file][message.ruleId] ?? 0) + 1;
    }
  }
  return sortCounts(counts);
}

function sortCounts(counts) {
  const sorted = {};
  for (const file of Object.keys(counts).sort()) {
    const rules = {};
    for (const rule of Object.keys(counts[file]).sort()) {
      if (counts[file][rule] > 0) rules[rule] = counts[file][rule];
    }
    if (Object.keys(rules).length > 0) sorted[file] = rules;
  }
  return sorted;
}

export function serializeBaseline(counts) {
  return `${JSON.stringify({ version: 1, files: sortCounts(counts) }, null, 2)}\n`;
}

export function parseBaseline(text) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || typeof parsed.files !== "object" || parsed.files === null) {
    throw new Error("expected { version: 1, files: { [path]: { [rule]: count } } }");
  }
  return parsed.files;
}

/**
 * Compare current counts to the baseline. `grown` lists every file/rule whose
 * count went up (including files the baseline never saw); `dropped` is the total
 * number of violations fixed since the baseline was written.
 */
export function compareCounts(baseline, current) {
  const grown = [];
  let dropped = 0;
  for (const [file, rules] of Object.entries(current)) {
    for (const [rule, count] of Object.entries(rules)) {
      const before = baseline[file]?.[rule] ?? 0;
      if (count > before) grown.push({ file, rule, before, after: count });
    }
  }
  for (const [file, rules] of Object.entries(baseline)) {
    for (const [rule, before] of Object.entries(rules)) {
      const after = current[file]?.[rule] ?? 0;
      if (after < before) dropped += before - after;
    }
  }
  grown.sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule));
  return { grown, dropped };
}

function parseWorkers(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--workers needs a positive integer, got: ${value}`);
  return n;
}

function parseArgs(argv) {
  const args = { update: false, baseline: DEFAULT_BASELINE, warnings: false, workers: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--update") args.update = true;
    else if (arg === "--warnings") args.warnings = true;
    else if (arg === "--baseline") args.baseline = path.resolve(argv[++i] ?? "");
    else if (arg.startsWith("--baseline=")) args.baseline = path.resolve(arg.slice("--baseline=".length));
    else if (arg === "--workers") args.workers = parseWorkers(argv[++i]);
    else if (arg.startsWith("--workers=")) args.workers = parseWorkers(arg.slice("--workers=".length));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

async function createESLint() {
  const { loadESLint } = await import("eslint");
  const ESLint = await loadESLint({ useFlatConfig: true });
  return { ESLint, eslint: new ESLint({ cwd: desktopDir }) };
}

/** Every .ts/.tsx file under LINT_DIR that the config does not ignore, sorted. */
async function listLintFiles(eslint) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      // node_modules is one of ESLint's default ignores; do not walk into it.
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
      } else if (entry.isFile() && LINT_FILE.test(entry.name)) {
        found.push(full);
      }
    }
  };
  walk(path.join(desktopDir, LINT_DIR));
  const ignored = await Promise.all(found.map((file) => eslint.isPathIgnored(file)));
  return found.filter((_, i) => !ignored[i]).sort(comparePaths);
}

function comparePaths(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Splits files into `count` groups of about the same total size. */
function partitionBySize(files, count) {
  const groups = Array.from({ length: count }, () => ({ bytes: 0, files: [] }));
  const sized = files.map((file) => ({ file, bytes: fs.statSync(file).size }));
  sized.sort((a, b) => b.bytes - a.bytes || comparePaths(a.file, b.file));
  for (const { file, bytes } of sized) {
    let smallest = groups[0];
    for (const group of groups) if (group.bytes < smallest.bytes) smallest = group;
    smallest.files.push(file);
    smallest.bytes += bytes;
  }
  return groups.map((group) => group.files).filter((group) => group.length > 0);
}

async function lintFileList(files) {
  const { eslint } = await createESLint();
  return eslint.lintFiles(files);
}

function lintInWorker(files) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { [WORKER_MARKER]: true, files } });
    let results = null;
    worker.once("message", (message) => {
      results = message;
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (results) resolve(results);
      else reject(new Error(`lint worker exited with code ${code} before it sent its results`));
    });
  });
}

/** Lints every file, split across `workers` threads; results sorted by path. */
async function lintAll(files, workers) {
  if (workers <= 1) return (await lintFileList(files)).sort((a, b) => comparePaths(a.filePath, b.filePath));
  const groups = partitionBySize(files, workers);
  const parts = await Promise.all(groups.map((group) => lintInWorker(group)));
  return parts.flat().sort((a, b) => comparePaths(a.filePath, b.filePath));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const { ESLint, eslint } = await createESLint();
  const files = await listLintFiles(eslint);
  const workers = Math.max(1, Math.min(args.workers ?? Math.min(os.availableParallelism(), MAX_WORKERS), files.length));
  const results = await lintAll(files, workers);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  const formatter = await eslint.loadFormatter("stylish");
  const errorResults = ESLint.getErrorResults(results);
  const printable = args.warnings ? results : errorResults;
  const output = await formatter.format(printable);
  if (output) process.stdout.write(output);

  const errorCount = results.reduce((sum, r) => sum + r.errorCount + r.fatalErrorCount, 0);
  const warningCount = results.reduce((sum, r) => sum + r.warningCount, 0);
  console.log(`eslint: ${plural(results.length, "file")} in ${seconds}s (${plural(workers, "worker")}), ${plural(errorCount, "error")}, ${plural(warningCount, "warning")}${args.warnings ? "" : " (--warnings to list them)"}`);

  const current = countRatchetViolations(results);
  const relativeBaseline = repoRelative(args.baseline);
  const baselineLabel = relativeBaseline.startsWith("..") ? args.baseline : relativeBaseline;

  if (args.update) {
    fs.writeFileSync(args.baseline, serializeBaseline(current));
    const total = Object.values(current).reduce((sum, rules) => sum + Object.values(rules).reduce((a, b) => a + b, 0), 0);
    console.log(`ade-ui ratchet: wrote ${baselineLabel} (${plural(total, "violation")} in ${plural(Object.keys(current).length, "file")}).`);
    process.exitCode = errorCount > 0 ? 1 : 0;
    return;
  }

  let baseline;
  try {
    baseline = parseBaseline(fs.readFileSync(args.baseline, "utf8"));
  } catch (error) {
    console.error(`ade-ui ratchet: cannot read ${baselineLabel}: ${error.message}`);
    console.error("Run `npm run lint:baseline` in apps/desktop to create it.");
    process.exitCode = 1;
    return;
  }

  const { grown, dropped } = compareCounts(baseline, current);
  if (grown.length > 0) {
    const added = grown.reduce((sum, g) => sum + g.after - g.before, 0);
    console.error("");
    console.error(`ade-ui ratchet: ${plural(added, "new UI-primitive violation")} (baseline ${baselineLabel}).`);
    console.error("These rules may only go down. Use the shared primitive instead — see docs/design/notices.md.");
    const byPath = new Map(results.map((r) => [repoRelative(r.filePath), r]));
    let lastFile = null;
    for (const g of grown) {
      if (g.file !== lastFile) console.error(`\n  ${g.file}`);
      lastFile = g.file;
      console.error(`    ${g.rule}: ${g.before} → ${g.after}`);
      for (const m of byPath.get(g.file)?.messages ?? []) {
        if (m.ruleId === g.rule) console.error(`      ${m.line}:${m.column}  ${m.message}`);
      }
    }
    console.error("\nOnly if a violation is genuinely intended (a new shared primitive), re-run `npm run lint:baseline` and explain why in the PR.");
    process.exitCode = 1;
  } else {
    console.log(`ade-ui ratchet: no new violations against ${baselineLabel}.`);
  }
  if (dropped > 0) {
    console.log(`ade-ui ratchet: ${plural(dropped, "violation")} fixed since the baseline. Run \`npm run lint:baseline\` to lock in ${dropped} fewer.`);
  }
  if (errorCount > 0) process.exitCode = 1;
}

/**
 * True when this file is the script node was asked to run. Compares real paths
 * (symlinked checkouts resolve differently from `import.meta.url`), and
 * case-insensitively on Windows where the drive letter's case can differ.
 */
export function isEntryScript(argvPath, moduleUrl = import.meta.url, platform = process.platform) {
  if (!argvPath) return false;
  let entry;
  try {
    entry = fs.realpathSync.native(path.resolve(argvPath));
  } catch {
    return false;
  }
  const self = fs.realpathSync.native(fileURLToPath(moduleUrl));
  return platform === "win32" ? entry.toLowerCase() === self.toLowerCase() : entry === self;
}

if (!isMainThread && workerData?.[WORKER_MARKER]) {
  // A worker started by lintInWorker. A rejection here becomes the worker's
  // "error" event, which fails the run in the main thread.
  parentPort.postMessage(await lintFileList(workerData.files));
} else if (isMainThread && isEntryScript(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

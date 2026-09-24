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
 * different baseline file), --warnings (also print every warning).
 *
 * Needs a large heap like `npm run lint`: the npm scripts pass
 * --max-old-space-size=8192.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RATCHET_RULE_PREFIX = "ade-ui/";
const LINT_PATTERNS = ["src/**/*.{ts,tsx}"];

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

function parseArgs(argv) {
  const args = { update: false, baseline: DEFAULT_BASELINE, warnings: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--update") args.update = true;
    else if (arg === "--warnings") args.warnings = true;
    else if (arg === "--baseline") args.baseline = path.resolve(argv[++i] ?? "");
    else if (arg.startsWith("--baseline=")) args.baseline = path.resolve(arg.slice("--baseline=".length));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const { loadESLint } = await import("eslint");
  const ESLint = await loadESLint({ useFlatConfig: true });
  const eslint = new ESLint({ cwd: desktopDir });
  const results = await eslint.lintFiles(LINT_PATTERNS);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  const formatter = await eslint.loadFormatter("stylish");
  const errorResults = ESLint.getErrorResults(results);
  const printable = args.warnings ? results : errorResults;
  const output = await formatter.format(printable);
  if (output) process.stdout.write(output);

  const errorCount = results.reduce((sum, r) => sum + r.errorCount + r.fatalErrorCount, 0);
  const warningCount = results.reduce((sum, r) => sum + r.warningCount, 0);
  console.log(`eslint: ${plural(results.length, "file")} in ${seconds}s, ${plural(errorCount, "error")}, ${plural(warningCount, "warning")}${args.warnings ? "" : " (--warnings to list them)"}`);

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

if (isEntryScript(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

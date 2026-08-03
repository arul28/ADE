/**
 * Platform-gate registry check.
 *
 * A platform-gated test assertion can exist with no CI runner that ever
 * executes it. Nothing in a normal test run detects that: the gate reports as
 * "skipped" (or, in the vacuous-`return` form, as a green pass) on every runner
 * the repo actually has, so the file's presence in a job reads as coverage that
 * does not exist.
 *
 * This script closes that gap. It
 *   1. parses every `apps/**\/*.test.ts(x)` for platform gates in all the forms
 *      this repo uses, including alias constants and the vacuous `return`;
 *   2. emits a registry of `{file, line, gatedPlatform, form}`;
 *   3. asserts the invariant that every gated assertion has a runner that
 *      executes it, by parsing `.github/workflows/ci.yml` for which test files
 *      each job runs and on which `runs-on`; and
 *   4. bans the vacuous `return` form, which reports green while asserting
 *      nothing.
 *
 * Known violations live in `scripts/platform-gate-baseline.json`. The baseline
 * is a ratchet: it is tolerated but may not grow, and it may not go stale.
 *
 * Usage:
 *   node scripts/validate-platform-gates.mjs
 *   node scripts/validate-platform-gates.mjs --registry     # print the registry
 *   node scripts/validate-platform-gates.mjs --update-baseline
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = process.cwd();

/**
 * The platforms a gate condition can select. `linux` is the platform every
 * default `ubuntu-latest` job runs on, so a gate that still runs on linux is
 * covered by the ordinary unit jobs and needs no dedicated runner.
 */
export const KNOWN_PLATFORMS = ["darwin", "linux", "win32"];

const TEST_FILE_PATTERN = /\.test\.tsx?$/;
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "dist-static",
  "build",
  "out",
  "coverage",
  ".vite",
  ".next",
  ".turbo",
]);

/**
 * File identifiers are repo-relative and always forward-slash separated, on
 * every host OS, so a gate site parsed on Windows compares equal to the path
 * spelled in `ci.yml`. This is the single boundary where a native path becomes
 * an identifier. `sep` is injectable so Windows behaviour stays testable on a
 * POSIX runner.
 */
export function toFileId(nativeRelativePath, sep = path.sep) {
  if (sep === "/") return nativeRelativePath;
  return nativeRelativePath.split(sep).join("/");
}

// ── Platform condition parsing ────────────────────────────────────────────
//
// Conditions are parsed rather than evaluated so that an unrecognised
// expression (`!isCrsqliteAvailable()`, an env-var check) is reported as "not a
// platform gate" instead of being silently mis-classified.

function tokenizeCondition(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const end = source.indexOf(char, index + 1);
      if (end === -1) throw new Error("unterminated string literal");
      tokens.push({ type: "string", value: source.slice(index + 1, end) });
      index = end + 1;
      continue;
    }
    const operator = ["===", "!==", "==", "!=", "&&", "||"].find((candidate) =>
      source.startsWith(candidate, index),
    );
    if (operator) {
      tokens.push({ type: "operator", value: operator });
      index += operator.length;
      continue;
    }
    if (char === "(" || char === ")" || char === "!") {
      tokens.push({ type: char === "!" ? "not" : char, value: char });
      index += 1;
      continue;
    }
    const identifier = /^[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*/.exec(source.slice(index));
    if (!identifier) throw new Error(`unexpected character ${JSON.stringify(char)}`);
    tokens.push({ type: "identifier", value: identifier[0].replace(/\s+/g, "") });
    index += identifier[0].length;
  }
  return tokens;
}

/**
 * Parses a condition into a predicate over a platform string. Throws when the
 * expression is not built purely out of `process.platform` comparisons.
 */
function parseConditionTokens(tokens) {
  let position = 0;
  const peek = () => tokens[position];

  function parseOr() {
    let left = parseAnd();
    while (peek()?.value === "||") {
      position += 1;
      const right = parseAnd();
      const previous = left;
      left = (platform) => previous(platform) || right(platform);
    }
    return left;
  }

  function parseAnd() {
    let left = parseUnary();
    while (peek()?.value === "&&") {
      position += 1;
      const right = parseUnary();
      const previous = left;
      left = (platform) => previous(platform) && right(platform);
    }
    return left;
  }

  function parseUnary() {
    if (peek()?.type === "not") {
      position += 1;
      const operand = parseUnary();
      return (platform) => !operand(platform);
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const token = peek();
    if (!token) throw new Error("unexpected end of condition");
    if (token.type === "(") {
      position += 1;
      const inner = parseOr();
      if (peek()?.type !== ")") throw new Error("unbalanced parentheses");
      position += 1;
      return inner;
    }
    return parseComparison();
  }

  function parseComparison() {
    const left = tokens[position];
    const operator = tokens[position + 1];
    const right = tokens[position + 2];
    if (!left || !operator || !right || operator.type !== "operator") {
      throw new Error("expected a process.platform comparison");
    }
    position += 3;

    const negated = operator.value === "!==" || operator.value === "!=";
    let literal;
    if (left.type === "identifier" && left.value === "process.platform" && right.type === "string") {
      literal = right.value;
    } else if (
      right.type === "identifier" &&
      right.value === "process.platform" &&
      left.type === "string"
    ) {
      literal = left.value;
    } else {
      throw new Error("comparison does not reference process.platform");
    }
    return (platform) => (platform === literal) !== negated;
  }

  const predicate = parseOr();
  if (position !== tokens.length) throw new Error("trailing tokens in condition");
  return predicate;
}

/**
 * Returns the sorted list of `KNOWN_PLATFORMS` the condition is true for, or
 * `null` when the expression is not a platform condition at all.
 */
export function platformsMatching(conditionSource) {
  if (!conditionSource || !conditionSource.includes("process.platform")) return null;
  let predicate;
  try {
    predicate = parseConditionTokens(tokenizeCondition(conditionSource));
  } catch {
    return null;
  }
  try {
    return KNOWN_PLATFORMS.filter((platform) => predicate(platform));
  } catch {
    return null;
  }
}

/** A human-readable label for the platforms a gated assertion runs on. */
export function gatedPlatformLabel(platforms) {
  if (platforms.length === 0) return "none";
  if (platforms.length === KNOWN_PLATFORMS.length) return "all";
  return platforms.join("|");
}

// ── Gate-site extraction ──────────────────────────────────────────────────

const RUNNER_CALLEES = new Set(["it", "test", "describe"]);

/** `it` and `test` run; `it.skip`/`describe.skip`/`it.todo` do not. */
function calleeRuns(callee) {
  const [head, ...rest] = callee.split(".");
  if (!RUNNER_CALLEES.has(head)) return null;
  if (rest.length === 0) return true;
  if (rest.length === 1 && (rest[0] === "skip" || rest[0] === "todo")) return false;
  if (rest.length === 1 && (rest[0] === "only" || rest[0] === "concurrent")) return true;
  return null;
}

function lineNumberForIndex(source, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/** Reads the balanced `(...)` starting at `openIndex`; returns the inner text. */
function readBalancedParens(source, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    const char = source[i];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return { inner: source.slice(openIndex + 1, i), endIndex: i };
    }
  }
  return null;
}

/**
 * `// WINDOWS-GATE: <reason>` / `// DARWIN-GATE: <reason>` is the documented
 * escape hatch. It is honoured on the gate line itself or on any of the three
 * preceding lines, so a comment block above the gate works.
 */
const ANNOTATION_PATTERN = /\/\/\s*(WINDOWS|DARWIN)-GATE:\s*(\S.*)$/;
const ANNOTATION_LOOKBACK = 3;

export function annotationFor(lines, lineNumber) {
  const first = Math.max(1, lineNumber - ANNOTATION_LOOKBACK);
  for (let candidate = lineNumber; candidate >= first; candidate -= 1) {
    const match = ANNOTATION_PATTERN.exec(lines[candidate - 1] ?? "");
    if (match) {
      return { platform: match[1] === "WINDOWS" ? "win32" : "darwin", reason: match[2].trim() };
    }
  }
  return null;
}

const CONDITIONAL_RUNNER_PATTERN = /\b(it|test|describe)\s*\.\s*(skipIf|runIf)\s*\(/g;
const TERNARY_CALL_PATTERN =
  /\(\s*([^;{}]*?process\.platform[^;{}]*?)\s*\?\s*((?:it|test|describe)(?:\.\w+)?)\s*:\s*((?:it|test|describe)(?:\.\w+)?)\s*\)\s*\(/g;
const ALIAS_DECLARATION_PATTERN =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;=]*?process\.platform[^;]*?)\s*\?\s*((?:it|test|describe)(?:\.\w+)?)\s*:\s*((?:it|test|describe)(?:\.\w+)?)\s*;/g;
const VACUOUS_RETURN_PATTERN =
  /^\s*if\s*\(([^)]*process\.platform[^)]*)\)\s*(?:return;?|\{\s*return;?\s*\})\s*$/;

/**
 * The set of platforms a `cond ? whenTrue : whenFalse` runner selection
 * actually runs on, or `null` when neither branch is a recognisable runner.
 */
function ternaryRunPlatforms(condition, whenTrue, whenFalse) {
  const matching = platformsMatching(condition);
  if (!matching) return null;
  const trueRuns = calleeRuns(whenTrue);
  const falseRuns = calleeRuns(whenFalse);
  if (trueRuns === null || falseRuns === null) return null;
  const matched = new Set(matching);
  return KNOWN_PLATFORMS.filter((platform) => (matched.has(platform) ? trueRuns : falseRuns));
}

/**
 * Extracts every platform gate in one test file.
 *
 * Returns records of `{file, line, form, platforms, gatedPlatform, snippet}`
 * plus, for the banned form, `{form: "vacuous-return"}`.
 */
export function collectGates(source, file) {
  const lines = source.split(/\r?\n/);
  const gates = [];

  const push = (index, form, platforms, snippet, extra = {}) => {
    const line = lineNumberForIndex(source, index);
    gates.push({
      file,
      line,
      form,
      platforms,
      gatedPlatform: gatedPlatformLabel(platforms),
      snippet: snippet.trim().slice(0, 160),
      annotation: annotationFor(lines, line),
      ...extra,
    });
  };

  // `it.skipIf(...)` / `describe.runIf(...)`
  CONDITIONAL_RUNNER_PATTERN.lastIndex = 0;
  let match;
  while ((match = CONDITIONAL_RUNNER_PATTERN.exec(source)) !== null) {
    const openIndex = CONDITIONAL_RUNNER_PATTERN.lastIndex - 1;
    const balanced = readBalancedParens(source, openIndex);
    if (!balanced) continue;
    const matching = platformsMatching(balanced.inner);
    if (!matching) continue;
    const matched = new Set(matching);
    const runs =
      match[2] === "runIf"
        ? KNOWN_PLATFORMS.filter((platform) => matched.has(platform))
        : KNOWN_PLATFORMS.filter((platform) => !matched.has(platform));
    push(match.index, `${match[1]}.${match[2]}`, runs, `${match[0]}${balanced.inner})`);
  }

  // `(process.platform === "win32" ? it : it.skip)(...)`
  TERNARY_CALL_PATTERN.lastIndex = 0;
  while ((match = TERNARY_CALL_PATTERN.exec(source)) !== null) {
    const runs = ternaryRunPlatforms(match[1], match[2], match[3]);
    if (!runs) continue;
    push(match.index, "ternary-runner", runs, match[0]);
  }

  // `const itUnix = process.platform === "win32" ? it.skip : it;` and each use.
  // The alias is the sneakiest form: the gate is invisible at the call site.
  ALIAS_DECLARATION_PATTERN.lastIndex = 0;
  const aliases = [];
  while ((match = ALIAS_DECLARATION_PATTERN.exec(source)) !== null) {
    const runs = ternaryRunPlatforms(match[2], match[3], match[4]);
    if (!runs) continue;
    aliases.push({ name: match[1], runs, declarationIndex: match.index });
    push(match.index, "alias-declaration", runs, match[0], { alias: match[1] });
  }

  for (const alias of aliases) {
    const usePattern = new RegExp(`(^|[^\\w$.])(${alias.name})\\s*\\(`, "g");
    let use;
    while ((use = usePattern.exec(source)) !== null) {
      if (use.index === alias.declarationIndex) continue;
      const useIndex = use.index + use[1].length;
      if (useIndex < alias.declarationIndex + alias.name.length) continue;
      push(useIndex, "alias-use", alias.runs, use[0], { alias: alias.name });
    }
  }

  // `if (process.platform === "win32") return;` — reports as a GREEN PASS while
  // asserting nothing.
  for (let index = 0; index < lines.length; index += 1) {
    const inline = VACUOUS_RETURN_PATTERN.exec(lines[index]);
    let condition = inline?.[1] ?? null;
    if (!condition) {
      const opener = /^\s*if\s*\(([^)]*process\.platform[^)]*)\)\s*\{\s*$/.exec(lines[index]);
      if (opener && /^\s*return;?\s*$/.test(lines[index + 1] ?? "") && /^\s*\}\s*$/.test(lines[index + 2] ?? "")) {
        condition = opener[1];
      }
    }
    if (!condition) continue;
    const matching = platformsMatching(condition);
    if (!matching) continue;
    const matched = new Set(matching);
    const runs = KNOWN_PLATFORMS.filter((platform) => !matched.has(platform));
    gates.push({
      file,
      line: index + 1,
      form: "vacuous-return",
      platforms: runs,
      gatedPlatform: gatedPlatformLabel(runs),
      snippet: lines[index].trim().slice(0, 160),
      annotation: annotationFor(lines, index + 1),
    });
  }

  gates.sort((a, b) => a.line - b.line || (a.form < b.form ? -1 : a.form > b.form ? 1 : 0));
  return gates;
}

// ── CI workflow parsing ───────────────────────────────────────────────────

function indentOf(line) {
  return line.length - line.trimStart().length;
}

/**
 * Minimal, dependency-free reader for the slice of `ci.yml` this check needs:
 * every job's `runs-on` (including a `${{ matrix.os }}` fan-out) and the text
 * of every step's `run:`, block scalars included.
 */
export function parseCiWorkflow(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const jobs = [];
  let current = null;
  let jobsIndent = null;
  let jobIndent = null;

  let index = 0;
  const readScalar = (rawValue, ownerIndent) => {
    const trimmed = rawValue.trim();
    if (trimmed === "|" || trimmed === "|-" || trimmed === ">" || trimmed === ">-" || trimmed === "|+") {
      const folded = trimmed.startsWith(">");
      const collected = [];
      let cursor = index + 1;
      while (cursor < lines.length) {
        const line = lines[cursor];
        if (line.trim() !== "" && indentOf(line) <= ownerIndent) break;
        collected.push(line.trim());
        cursor += 1;
      }
      index = cursor - 1;
      return folded ? collected.join(" ") : collected.join("\n");
    }
    return trimmed.replace(/^["'](.*)["']$/, "$1");
  };

  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const indent = indentOf(line);
    const content = line.trim();

    if (jobsIndent === null) {
      if (indent === 0 && content === "jobs:") jobsIndent = 0;
      continue;
    }

    const jobHeader = /^([A-Za-z0-9_.-]+):$/.exec(content);
    if (jobHeader && (jobIndent === null || indent === jobIndent) && indent > jobsIndent) {
      if (indent === 0) break; // left the jobs mapping entirely
      jobIndent = indent;
      current = { name: jobHeader[1], runsOn: [], runCommands: [] };
      jobs.push(current);
      continue;
    }
    if (!current || indent <= jobsIndent) continue;

    const runsOn = /^runs-on:\s*(.+)$/.exec(content);
    if (runsOn) {
      current.runsOn.push(runsOn[1].trim().replace(/^["'](.*)["']$/, "$1"));
      continue;
    }
    const matrixOs = /^(?:-\s+)?os:\s*(.+)$/.exec(content);
    if (matrixOs) {
      current.matrixOs = current.matrixOs ?? [];
      current.matrixOs.push(matrixOs[1].trim().replace(/^["'](.*)["']$/, "$1"));
      continue;
    }
    const run = /^(?:-\s+)?run:\s*(.*)$/.exec(content);
    if (run) {
      current.runCommands.push(readScalar(run[1], indent));
    }
  }

  for (const job of jobs) {
    if (job.runsOn.some((value) => value.includes("matrix.os"))) {
      job.runsOn = job.runsOn.filter((value) => !value.includes("matrix.os")).concat(job.matrixOs ?? []);
    }
    delete job.matrixOs;
  }
  return jobs;
}

/** Maps a GitHub `runs-on` label onto the `process.platform` it reports. */
export function runnerPlatform(runsOnLabel) {
  const label = runsOnLabel.toLowerCase();
  if (label.startsWith("windows")) return "win32";
  if (label.startsWith("macos")) return "darwin";
  if (label.startsWith("ubuntu")) return "linux";
  return null;
}

const WHOLE_SUITE_PATTERN = /^(?:npm\s+(?:test|t)|npm\s+run\s+test|npx\s+vitest\s+run)(?:\s|$)/;

/**
 * Works out which test files a job's shell commands run, and in which package.
 * Returns `{files: Set<string>, wholeSuiteDirs: Set<string>}` where a
 * whole-suite dir means "every test file under this directory runs here"
 * (`npm test`, or a sharded `vitest run` with no explicit file arguments).
 */
export function testTargetsForCommand(command, { defaultDir = "" } = {}) {
  const files = new Set();
  const wholeSuiteDirs = new Set();

  for (const rawLine of command.split("\n")) {
    let cwd = defaultDir;
    for (const rawSegment of rawLine.split(/&&|\|\||;/)) {
      const segment = rawSegment.trim();
      if (!segment) continue;
      const cd = /^cd\s+(\S+)$/.exec(segment);
      if (cd) {
        cwd = cd[1].replace(/\/+$/, "");
        continue;
      }
      const prefix = /--prefix\s+(\S+)/.exec(segment);
      const segmentDir = prefix ? prefix[1].replace(/\/+$/, "") : cwd;
      const normalized = segment.replace(/--prefix\s+\S+\s*/, "").replace(/\s+/g, " ").trim();
      if (!WHOLE_SUITE_PATTERN.test(normalized)) continue;

      const targets = normalized
        .split(/\s+/)
        .filter((token) => TEST_FILE_PATTERN.test(token) && !token.startsWith("-"));
      if (targets.length === 0) {
        wholeSuiteDirs.add(segmentDir);
        continue;
      }
      for (const target of targets) {
        const joined = segmentDir ? `${segmentDir}/${target}` : target;
        files.add(path.posix.normalize(joined));
      }
    }
  }
  return { files, wholeSuiteDirs };
}

/** Aggregates a workflow into `platform -> {files, wholeSuiteDirs}` coverage. */
export function coverageByPlatform(jobs) {
  const coverage = new Map();
  for (const job of jobs) {
    const platforms = new Set(job.runsOn.map(runnerPlatform).filter(Boolean));
    if (platforms.size === 0) continue;
    const targets = { files: new Set(), wholeSuiteDirs: new Set() };
    for (const command of job.runCommands) {
      const parsed = testTargetsForCommand(command);
      for (const file of parsed.files) targets.files.add(file);
      for (const dir of parsed.wholeSuiteDirs) targets.wholeSuiteDirs.add(dir);
    }
    if (targets.files.size === 0 && targets.wholeSuiteDirs.size === 0) continue;
    for (const platform of platforms) {
      const bucket = coverage.get(platform) ?? { files: new Set(), wholeSuiteDirs: new Set(), jobs: [] };
      for (const file of targets.files) bucket.files.add(file);
      for (const dir of targets.wholeSuiteDirs) bucket.wholeSuiteDirs.add(dir);
      bucket.jobs.push(job.name);
      coverage.set(platform, bucket);
    }
  }
  return coverage;
}

export function isFileCovered(coverage, platform, file) {
  const bucket = coverage.get(platform);
  if (!bucket) return false;
  if (bucket.files.has(file)) return true;
  for (const dir of bucket.wholeSuiteDirs) {
    if (dir && file.startsWith(`${dir}/`)) return true;
  }
  return false;
}

// ── Invariant evaluation ──────────────────────────────────────────────────

export const VIOLATION_KINDS = {
  uncoveredGate: "uncovered-gate",
  unsatisfiableGate: "unsatisfiable-gate",
  vacuousReturn: "vacuous-return",
};

function fixHintFor(violation) {
  if (violation.kind === VIOLATION_KINDS.vacuousReturn) {
    return `replace the bare \`return\` with \`it.skipIf(${violation.snippetCondition ?? "process.platform === \"win32\""})(...)\` so the skip is reported instead of passing green`;
  }
  if (violation.kind === VIOLATION_KINDS.unsatisfiableGate) {
    return "the condition selects no platform, so this assertion can never run anywhere; delete the gate or fix the condition";
  }
  const platforms = violation.platforms.join(" or ");
  const label = violation.platforms.includes("win32") ? "windows-latest" : "macos-*";
  return `add ${violation.file} to a ${label} job in .github/workflows/ci.yml, or annotate the gate with \`// ${violation.platforms.includes("win32") ? "WINDOWS" : "DARWIN"}-GATE: <reason>\` (runs only on: ${platforms})`;
}

export function evaluateGates(gates, coverage) {
  const violations = [];
  for (const gate of gates) {
    if (gate.form === "vacuous-return") {
      violations.push({
        kind: VIOLATION_KINDS.vacuousReturn,
        file: gate.file,
        line: gate.line,
        form: gate.form,
        platforms: gate.platforms,
        requires: "n/a",
        snippet: gate.snippet,
      });
      continue;
    }
    if (gate.platforms.length === 0) {
      violations.push({
        kind: VIOLATION_KINDS.unsatisfiableGate,
        file: gate.file,
        line: gate.line,
        form: gate.form,
        platforms: gate.platforms,
        requires: "none",
        snippet: gate.snippet,
      });
      continue;
    }
    const covered = gate.platforms.some((platform) => isFileCovered(coverage, platform, gate.file));
    if (covered) continue;
    if (gate.annotation && gate.platforms.includes(gate.annotation.platform)) continue;
    violations.push({
      kind: VIOLATION_KINDS.uncoveredGate,
      file: gate.file,
      line: gate.line,
      form: gate.form,
      platforms: gate.platforms,
      requires: gate.platforms.join("|"),
      snippet: gate.snippet,
    });
  }
  return violations;
}

// ── Baseline ratchet ──────────────────────────────────────────────────────

export const BASELINE_PATH = "scripts/platform-gate-baseline.json";

/**
 * Line numbers churn on every edit, so the baseline is keyed on the stable
 * `(file, kind, form, requires)` tuple and counted. That lets the backlog burn
 * down file by file while a new gate in an already-listed file still fails.
 */
export function baselineKey(entry) {
  return [entry.file, entry.kind, entry.form, entry.requires].join("|");
}

export function summarizeViolations(violations) {
  const counts = new Map();
  for (const violation of violations) {
    const key = baselineKey(violation);
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
      existing.lines.push(violation.line);
      continue;
    }
    counts.set(key, {
      file: violation.file,
      kind: violation.kind,
      form: violation.form,
      requires: violation.requires,
      count: 1,
      lines: [violation.line],
    });
  }
  return [...counts.values()].sort((a, b) => (baselineKey(a) < baselineKey(b) ? -1 : 1));
}

/**
 * Compares the current violations against the baseline. New or grown entries
 * fail immediately; entries that shrank or disappeared fail too, with an
 * instruction to re-record the baseline, so the ratchet cannot go stale.
 */
export function diffAgainstBaseline(violations, baseline) {
  const current = new Map(summarizeViolations(violations).map((entry) => [baselineKey(entry), entry]));
  const recorded = new Map((baseline?.violations ?? []).map((entry) => [baselineKey(entry), entry]));

  const newViolations = [];
  const staleEntries = [];

  for (const [key, entry] of current) {
    const allowed = recorded.get(key)?.count ?? 0;
    if (entry.count > allowed) {
      newViolations.push({ ...entry, allowed, excess: entry.count - allowed });
    }
  }
  for (const [key, entry] of recorded) {
    const actual = current.get(key)?.count ?? 0;
    if (actual < entry.count) staleEntries.push({ ...entry, actual });
  }
  return { newViolations, staleEntries };
}

export function renderBaseline(violations) {
  return `${JSON.stringify(
    {
      $comment: [
        "Known platform-gate violations, tolerated by scripts/validate-platform-gates.mjs.",
        "This file is a ratchet: it may shrink, never grow. Every entry is a test",
        "assertion that no CI runner executes, or a vacuous `return` that reports",
        "green while asserting nothing.",
        "Re-record after burning one down with:",
        "node scripts/validate-platform-gates.mjs --update-baseline",
      ].join(" "),
      $tracking: {
        "uncovered-gate, requires darwin":
          "There is no macOS unit-test job in ci.yml at all, so every darwin-gated" +
          " assertion in the repo runs nowhere. Adding one is its own lane; until it" +
          " lands these entries cannot be burned down.",
        "uncovered-gate, requires win32":
          "The file is not in any windows-latest job. Fix by adding it to" +
          " `windows-foundation` in .github/workflows/ci.yml once it is verified green" +
          " on a native Windows host, or -- for a deliberate exception -- by annotating" +
          " the gate with `// WINDOWS-GATE: <reason>` and dropping the entry here.",
        "vacuous-return":
          "`if (process.platform === ...) return;` inside a test body reports as a" +
          " GREEN PASS while asserting nothing. Fix by converting the test to" +
          " `it.skipIf(<same condition>)(...)` so the skip is reported. Owned by the" +
          " lanes that own each file.",
      },
      violations: summarizeViolations(violations).map(({ lines, ...entry }) => entry),
    },
    null,
    2,
  )}\n`;
}

// ── Scanning ──────────────────────────────────────────────────────────────

async function walkTestFiles(dir, found) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      await walkTestFiles(fullPath, found);
      continue;
    }
    if (TEST_FILE_PATTERN.test(entry.name)) {
      found.push({ absolutePath: fullPath, file: toFileId(path.relative(repoRoot, fullPath)) });
    }
  }
}

export async function buildRegistry({ root = repoRoot } = {}) {
  const found = [];
  await walkTestFiles(path.join(root, "apps"), found);
  const gates = [];
  for (const { absolutePath, file } of found) {
    const source = await fs.readFile(absolutePath, "utf8");
    if (!source.includes("process.platform")) continue;
    gates.push(...collectGates(source, file));
  }
  gates.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  return { gates, scannedFiles: found.length };
}

async function readBaseline(baselinePath) {
  try {
    return JSON.parse(await fs.readFile(baselinePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { violations: [] };
    throw error;
  }
}

async function main(argv) {
  const wantsRegistry = argv.includes("--registry");
  const updateBaseline = argv.includes("--update-baseline");

  const { gates, scannedFiles } = await buildRegistry();
  const workflowPath = path.join(repoRoot, ".github", "workflows", "ci.yml");
  const jobs = parseCiWorkflow(await fs.readFile(workflowPath, "utf8"));
  const coverage = coverageByPlatform(jobs);

  if (wantsRegistry) {
    console.log(
      JSON.stringify(
        {
          scannedFiles,
          coverage: Object.fromEntries(
            [...coverage].map(([platform, bucket]) => [
              platform,
              { jobs: bucket.jobs, wholeSuiteDirs: [...bucket.wholeSuiteDirs], files: [...bucket.files].sort() },
            ]),
          ),
          gates: gates.map(({ file, line, gatedPlatform, form, annotation }) => ({
            file,
            line,
            gatedPlatform,
            form,
            ...(annotation ? { annotation: annotation.reason } : {}),
          })),
        },
        null,
        2,
      ),
    );
  }

  const violations = evaluateGates(gates, coverage);
  const baselinePath = path.join(repoRoot, ...BASELINE_PATH.split("/"));

  if (updateBaseline) {
    await fs.writeFile(baselinePath, renderBaseline(violations), "utf8");
    console.log(
      `Recorded ${violations.length} platform-gate violation(s) in ${BASELINE_PATH}.`,
    );
    return;
  }

  const baseline = await readBaseline(baselinePath);
  const { newViolations, staleEntries } = diffAgainstBaseline(violations, baseline);

  if (newViolations.length > 0 || staleEntries.length > 0) {
    console.error("Platform-gate validation failed:");
    const byKey = new Map(summarizeViolations(violations).map((entry) => [baselineKey(entry), entry]));
    for (const entry of newViolations) {
      const lines = (byKey.get(baselineKey(entry))?.lines ?? []).join(", ");
      console.error(
        `- ${entry.file}:${lines}: ${entry.count} ${entry.kind} (form: ${entry.form}) but the baseline allows ${entry.allowed}`,
      );
      console.error(
        `  fix: ${fixHintFor({ ...entry, platforms: entry.requires === "n/a" || entry.requires === "none" ? [] : entry.requires.split("|") })}`,
      );
    }
    for (const entry of staleEntries) {
      console.error(
        `- ${BASELINE_PATH}: stale entry for ${entry.file} (${entry.kind}, form: ${entry.form}) records ${entry.count} but only ${entry.actual} remain`,
      );
      console.error("  fix: node scripts/validate-platform-gates.mjs --update-baseline, and commit the shrunk baseline");
    }
    process.exit(1);
  }

  const baselineCount = (baseline.violations ?? []).reduce((total, entry) => total + entry.count, 0);
  console.log(
    `Platform-gate validation passed: ${gates.length} gate site(s) across ${scannedFiles} test file(s); ` +
      `${baselineCount} known violation(s) remain in ${BASELINE_PATH}.`,
  );
}

const isDirectRun = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) {
  await main(process.argv.slice(2));
}

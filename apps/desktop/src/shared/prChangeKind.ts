/**
 * Sorts a pull request's changed files into what a reviewer reads (code) and
 * what they mostly skim (tests, test support, docs, generated output), so a
 * PR's `+N −N` can say how much of it is logic.
 *
 * Path-only and pure: no file reads, no network.
 */

export type PrChangeKind = "code" | "tests" | "mocks" | "docs" | "generated";

/** Display order: code first, then the buckets a reviewer can skim. */
export const PR_CHANGE_KINDS: readonly PrChangeKind[] = ["code", "tests", "mocks", "docs", "generated"];

export type PrChangeKindTally = { files: number; additions: number; deletions: number };

export type PrChangeKindSummary = {
  kinds: Record<PrChangeKind, PrChangeKindTally>;
  total: PrChangeKindTally;
};

/**
 * GitHub's pull request files API stops at 3000 files. A list that long may be
 * cut off, so a split over it could not add up to the PR's real total.
 */
export const GITHUB_PR_FILES_CAP = 3000;

const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "shrinkwrap.yaml",
  "bun.lockb",
  "bun.lock",
  "deno.lock",
  "cargo.lock",
  "poetry.lock",
  "uv.lock",
  "pipfile.lock",
  "pdm.lock",
  "gemfile.lock",
  "composer.lock",
  "go.sum",
  "go.work.sum",
  "package.resolved",
  "podfile.lock",
  "cartfile.resolved",
  "flake.lock",
  "mix.lock",
  "pubspec.lock",
  "packages.lock.json",
  "gradle.lockfile",
  "paket.lock",
  ".terraform.lock.hcl",
]);

// Matched against the lowercased file name.
const GENERATED_NAME = new RegExp(
  [
    String.raw`\.(?:generated|gen)\.[a-z0-9]+$`,
    String.raw`[._]generated\.[a-z0-9]+$`,
    String.raw`^zz_generated\.`,
    String.raw`\.g\.(?:dart|cs)$`,
    String.raw`\.freezed\.dart$`,
    String.raw`\.designer\.cs$`,
    String.raw`\.pb(?:\.gw)?\.(?:go|cc|h|swift|dart)$`,
    String.raw`_pb2(?:_grpc)?\.pyi?$`,
    String.raw`_pb\.(?:js|ts|d\.ts)$`,
    String.raw`_grpc_pb\.(?:js|ts|d\.ts)$`,
    String.raw`\.min\.(?:js|mjs|cjs|css)$`,
    String.raw`\.map$`,
  ].join("|"),
);

// Directory segments, lowercased.
const GENERATED_DIRS = new Set([
  "node_modules",
  "vendor",
  "vendored",
  "third_party",
  "third-party",
  "thirdparty",
  "bower_components",
  "__generated__",
  "generated",
]);

const MOCK_NAME = /\.(?:mocks?|fixtures?|stubs?)\.[a-z0-9]+$|\.snap$/;
const MOCK_DIRS = new Set([
  "__mocks__",
  "mocks",
  "__fixtures__",
  "fixtures",
  "__snapshots__",
  "testdata",
  "test-data",
  "test_data",
]);

// Lowercased name.
const TEST_NAME = new RegExp(
  [
    String.raw`\.(?:test|spec|e2e|cy)\.[a-z0-9]+$`,
    String.raw`_(?:test|spec)\.(?:go|py|rb|rs|exs?|dart|c|cc|cpp|js|ts)$`,
    String.raw`^test_[^/]*\.py$`,
    String.raw`^conftest\.py$`,
  ].join("|"),
);
// Case-sensitive: `FooTest.java`, `FooTests.swift`, `FooSpec.scala`, not `Contest.java`.
const CLASS_TEST_NAME = /[A-Za-z0-9](?:Tests?|Spec)\.(?:java|kt|kts|scala|groovy|cs|swift|m|mm)$/;
const TEST_DIRS = new Set([
  "test",
  "tests",
  "__tests__",
  "spec",
  "specs",
  "e2e",
  "cypress",
  "androidtest",
  "uitests",
]);

const DOCS_NAME = /\.(?:md|mdx|markdown|rst|adoc|asciidoc|txt)$/;
// Plain text a tool reads as input, not prose.
const NOT_DOCS_NAME = /^(?:requirements.*|constraints.*|cmakelists|robots|llms(?:-full)?)\.txt$/;
const DOCS_BARE_NAMES = new Set(["license", "licence", "copying", "notice", "authors", "contributors", "changelog", "readme"]);

function normalizePath(path: string): string {
  let normalized = path.indexOf("\\") >= 0 ? path.replace(/\\/g, "/") : path;
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  if (normalized.startsWith("/")) normalized = normalized.replace(/^\/+/, "");
  return normalized;
}

const IN_GENERATED_DIR = 1;
const IN_MOCK_DIR = 2;
const IN_TEST_DIR = 4;
const DIR_FLAGS = new Map<string, number>();
for (const [dirs, flag] of [[GENERATED_DIRS, IN_GENERATED_DIR], [MOCK_DIRS, IN_MOCK_DIR], [TEST_DIRS, IN_TEST_DIR]] as const) {
  for (const dir of dirs) DIR_FLAGS.set(dir, (DIR_FLAGS.get(dir) ?? 0) | flag);
}

/** Which special directories the path's folders (not its file name) sit in, in one pass. */
function dirFlags(lowerPath: string, nameStart: number): number {
  let flags = 0;
  let start = 0;
  while (start < nameStart) {
    const end = lowerPath.indexOf("/", start);
    if (end < 0 || end >= nameStart) break;
    if (end > start) flags |= DIR_FLAGS.get(lowerPath.slice(start, end)) ?? 0;
    start = end + 1;
  }
  return flags;
}

/**
 * The bucket one changed path belongs to. Pass the file's current name; a
 * rename is judged by where it ended up.
 */
export function classifyChangedPath(path: string): PrChangeKind {
  const normalized = normalizePath(path);
  const lower = normalized.toLowerCase();
  const nameStart = lower.lastIndexOf("/") + 1;
  const lowerName = nameStart > 0 ? lower.slice(nameStart) : lower;

  const dirs = nameStart > 0 ? dirFlags(lower, nameStart) : 0;

  if (LOCKFILE_NAMES.has(lowerName) || GENERATED_NAME.test(lowerName) || (dirs & IN_GENERATED_DIR) !== 0) {
    return "generated";
  }
  if (MOCK_NAME.test(lowerName) || (dirs & IN_MOCK_DIR) !== 0) return "mocks";
  const name = nameStart > 0 ? normalized.slice(nameStart) : normalized;
  if (TEST_NAME.test(lowerName) || CLASS_TEST_NAME.test(name) || (dirs & IN_TEST_DIR) !== 0) {
    return "tests";
  }
  if ((DOCS_NAME.test(lowerName) && !NOT_DOCS_NAME.test(lowerName)) || DOCS_BARE_NAMES.has(lowerName)) {
    return "docs";
  }
  return "code";
}

export type PrChangeFileLike = {
  filename: string;
  additions: number;
  deletions: number;
};

function emptyTally(): PrChangeKindTally {
  return { files: 0, additions: 0, deletions: 0 };
}

/** Per-bucket files, additions and deletions, plus the totals they add up to. */
export function summarizePrChangeKinds(files: readonly PrChangeFileLike[]): PrChangeKindSummary {
  const kinds: Record<PrChangeKind, PrChangeKindTally> = {
    code: emptyTally(),
    tests: emptyTally(),
    mocks: emptyTally(),
    docs: emptyTally(),
    generated: emptyTally(),
  };
  const total = emptyTally();
  for (const file of files) {
    const additions = Number.isFinite(file.additions) ? Math.max(0, file.additions) : 0;
    const deletions = Number.isFinite(file.deletions) ? Math.max(0, file.deletions) : 0;
    const tally = kinds[classifyChangedPath(file.filename)];
    tally.files += 1;
    tally.additions += additions;
    tally.deletions += deletions;
    total.files += 1;
    total.additions += additions;
    total.deletions += deletions;
  }
  return { kinds, total };
}

export type PrChangeTotalsExpectation = {
  additions?: number | null;
  deletions?: number | null;
  changedFiles?: number | null;
};

/**
 * Whether a summary describes the whole PR. False when the file list may be
 * cut off at GitHub's cap, or when it disagrees with totals the caller already
 * knows (a stale list, or one GitHub truncated). A split that does not add up
 * to the PR's total is worse than no split.
 */
export function isPrChangeSummaryComplete(
  summary: PrChangeKindSummary,
  expected?: PrChangeTotalsExpectation | null,
): boolean {
  if (summary.total.files === 0 || summary.total.files >= GITHUB_PR_FILES_CAP) return false;
  if (expected?.changedFiles != null && expected.changedFiles > 0 && expected.changedFiles !== summary.total.files) return false;
  if (expected?.additions != null && expected.additions !== summary.total.additions) return false;
  if (expected?.deletions != null && expected.deletions !== summary.total.deletions) return false;
  return true;
}

/** Lines (added + deleted) outside the code bucket. */
export function prChangeNonCodeLines(summary: PrChangeKindSummary): number {
  return summary.total.additions + summary.total.deletions
    - summary.kinds.code.additions - summary.kinds.code.deletions;
}

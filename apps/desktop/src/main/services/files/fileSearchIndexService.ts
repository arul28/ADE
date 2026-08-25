import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { FilesQuickOpenItem, FilesSearchTextMatch } from "../../../shared/types";
import { destroyChildProcessStreams, hasNullByte, normalizeRelative } from "../shared/utils";
import { terminateProcessTree } from "../shared/processExecution";
import { pathKey } from "../shared/pathCompare";
import { resolveGitExecutable, runGit } from "../git/git";

const MAX_INDEXED_FILES = 25_000;
const MAX_TEXT_FILE_BYTES = 1_000_000;
const QUICK_OPEN_QUERY_CACHE_MAX = 50;
const YIELD_EVERY_FILES = 120;
const PREVIEW_MAX_CHARS = 240;
const GIT_WORK_TREE_PROBE_TIMEOUT_MS = 5_000;
const GIT_GREP_TIMEOUT_MS = 10_000;
/**
 * A minified bundle is one enormous "line", so a record can arrive far larger
 * than any preview needs. Clip the fragment while waiting for its newline so a
 * single pathological line cannot re-introduce the unbounded buffering this
 * whole path exists to remove.
 */
const MAX_GIT_GREP_RECORD_CHARS = 8_192;
const VOLATILE_ADE_PREFIXES = [
  ".ade/artifacts/",
  ".ade/cache/",
  ".ade/secrets/",
  ".ade/transcripts/",
  ".ade/worktrees/",
];
const VOLATILE_ADE_FILES = new Set([
  ".ade/ade.db",
  ".ade/ade.db-shm",
  ".ade/ade.db-wal",
  ".ade/ade.sock",
  ".ade/local.secret.yaml",
]);
const ALWAYS_SKIPPED_DIRECTORY_NAMES = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".vite",
  "coverage",
  "dist",
  "node_modules",
]);

/**
 * Name-index entry only. File CONTENT is deliberately absent: retaining decoded
 * lines here cost hundreds of megabytes of heap (80 MiB of raw bytes becomes
 * millions of small JS strings) and crashed the app once "include ignored
 * files" widened the pile. Content search reads, scans, and discards.
 */
type IndexedFile = {
  path: string;
  lowerPath: string;
  size: number;
  mtimeMs: number;
};

type WorkspaceIndex = {
  workspaceId: string;
  rootPath: string;
  includeIgnored: boolean;
  files: Map<string, IndexedFile>;
  quickOpenCache: Map<string, FilesQuickOpenItem[]>;
  buildingPromise: Promise<void> | null;
  builtAt: string | null;
};

type IgnoreOptions = {
  shouldIgnore: (relPath: string, includeIgnored: boolean) => Promise<boolean>;
  primeIgnoreCache?: (relPaths: string[], includeIgnored: boolean) => Promise<void>;
};

function isVolatileAdeRuntimePath(relPath: string): boolean {
  return VOLATILE_ADE_FILES.has(relPath)
    || VOLATILE_ADE_PREFIXES.some((prefix) => relPath === prefix.slice(0, -1) || relPath.startsWith(prefix));
}

function shouldSkipPathPrefix(relPath: string, includeIgnored: boolean): boolean {
  if (isVolatileAdeRuntimePath(relPath)) return true;
  if (includeIgnored) return false;
  return relPath === ".ade" || relPath.startsWith(".ade/");
}

/** Starting score for the empty-query browse ranking; one point per path segment is deducted. */
const BROWSE_BASE_SCORE = 100;

/**
 * Empty query browses the workspace: rank shallower paths first. Both
 * separators count so Windows-style paths depth-rank identically.
 */
function scoreBrowseDepth(normalizedPath: string): number {
  let depth = 0;
  for (const ch of normalizedPath) if (ch === "/" || ch === "\\") depth += 1;
  return Math.max(1, BROWSE_BASE_SCORE - depth);
}

function scorePathForNeedle(normalized: string, needle: string): number {
  if (normalized === needle) return 1000;
  if (normalized.endsWith(`/${needle}`) || normalized.endsWith(`\\${needle}`)) return 900;
  const idx = normalized.indexOf(needle);
  return idx < 0 ? -1 : 600 - idx;
}

function scorePath(pathValue: string, query: string, allowComposerPrefixFallback: boolean): number {
  const normalized = pathValue.toLowerCase();
  const needle = query.toLowerCase().trim();
  if (!needle) return scoreBrowseDepth(normalized);
  const directScore = scorePathForNeedle(normalized, needle);
  if (directScore >= 0) return directScore;

  if (!allowComposerPrefixFallback) return -1;

  // Composer @-file queries can contain ordinary prose after an extensionless
  // path whose filename or directory contains spaces. A path index cannot
  // know that boundary from the string alone, so try progressively shorter
  // space-delimited prefixes and keep the longest matching one. This is kept
  // behind an explicit composer-only mode so generic quick-open searches keep
  // their whole-query semantics.
  const isRootLevelPath = !normalized.includes("/") && !normalized.includes("\\");
  const words = needle.split(/[ \t]+/);
  let best = -1;
  for (let end = words.length - 1; end > 0; end -= 1) {
    const prefix = words.slice(0, end).join(" ");
    const score = isRootLevelPath
      ? (normalized.startsWith(prefix) ? 600 : -1)
      : scorePathForNeedle(normalized, prefix);
    if (score < 0) continue;
    // Prefer a longer path prefix when multiple indexed paths share the same
    // beginning. The tiny fractional tie-break preserves existing score tiers.
    best = Math.max(best, score + Math.min(prefix.length, 999) / 1000);
  }
  return best;
}

async function cooperativeYield(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(() => resolve());
  });
}

function cloneQuickOpenItems(items: FilesQuickOpenItem[]): FilesQuickOpenItem[] {
  return items.map((item) => ({ ...item }));
}

/** True when any directory segment of `relPath` is one the index never walks. */
function hasAlwaysSkippedDirectorySegment(relPath: string): boolean {
  const segments = relPath.split("/");
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (ALWAYS_SKIPPED_DIRECTORY_NAMES.has(segments[i] ?? "")) return true;
  }
  return false;
}

/**
 * The one rule for "can this path appear in results", shared by both search
 * tiers. It was previously written out as two different hand-built conjunctions
 * — one in the git-grep result filter, one in the index walk — which is exactly
 * how the two tiers drift apart.
 */
function isSearchableRelPath(relPath: string, includeIgnored: boolean): boolean {
  return !shouldSkipPathPrefix(relPath, includeIgnored) && !hasAlwaysSkippedDirectorySegment(relPath);
}

/**
 * Pathspecs that give `git grep` the same visibility the name index has.
 *
 * Exclusion is pushed into git rather than done on the parsed output because
 * `--no-exclude-standard` otherwise lets one `node_modules` flood the stream
 * with matches we would only discard. The parsed results are filtered too — git
 * does the volume work, the filter is the correctness backstop.
 */
function gitGrepPathspecs(includeIgnored: boolean): string[] {
  const specs = ["."];
  for (const name of ALWAYS_SKIPPED_DIRECTORY_NAMES) {
    specs.push(`:(exclude,glob)**/${name}/**`);
  }
  if (includeIgnored) {
    for (const prefix of VOLATILE_ADE_PREFIXES) specs.push(`:(exclude,glob)${prefix}**`);
    for (const file of VOLATILE_ADE_FILES) specs.push(`:(exclude)${file}`);
  } else {
    specs.push(":(exclude,glob).ade/**", ":(exclude).ade");
  }
  return specs;
}

/**
 * Exported for tests: the argv is the whole Windows-safety story. It is passed
 * to `spawn` as an array and never through a shell, so a query containing
 * `%PATH%`, a quote, or a leading `-` cannot be re-parsed by `cmd.exe`.
 */
export function gitGrepArgs(args: { query: string; limit: number; includeIgnored: boolean }): string[] {
  return [
    // Paths must arrive verbatim and relative to the workspace root: quotePath
    // octal-escapes non-ASCII names, and a user's `grep.fullName = true` would
    // rewrite every path relative to the repo root instead — wrong whenever the
    // workspace is a subdirectory of a larger repo.
    "-c", "core.quotePath=false",
    "-c", "grep.fullName=false",
    "grep",
    "--no-color",
    // -I skips binaries, -n numbers lines, -F keeps the query literal (users
    // type `foo.ts(`, and a regex parse error must never reach them), -i
    // matches the case-insensitive contract, -z removes the parse ambiguity of
    // a colon inside a path or a matched line.
    "-I", "-n", "-z", "-F", "-i",
    // Files that exist but were never committed are still the user's files.
    "--untracked",
    ...(args.includeIgnored ? ["--no-exclude-standard"] : []),
    // Per-file cap; the reader stops the whole run at the overall limit.
    "-m", String(args.limit),
    // `-e` and `--` so a query or path starting with `-` cannot become a flag.
    "-e", args.query,
    "--",
    ...gitGrepPathspecs(args.includeIgnored),
  ];
}

/**
 * Parse one `git grep -z -n` record into its three fields.
 *
 * `-z` currently delimits both the path and the line number with NUL, but older
 * git only replaced the path delimiter, and a caller with neither would be left
 * with `path:line:text`. Accept all three shapes: the text may contain colons
 * and the path may contain them too, so nothing here may split blindly.
 */
export function parseGitGrepRecord(record: string): { path: string; line: number; text: string } | null {
  const splitLineAndText = (pathValue: string, rest: string, delimiter: string): {
    path: string;
    line: number;
    text: string;
  } | null => {
    const at = rest.indexOf(delimiter);
    if (at < 0) return null;
    const line = Number.parseInt(rest.slice(0, at), 10);
    if (!Number.isFinite(line) || line <= 0) return null;
    return { path: pathValue, line, text: rest.slice(at + 1) };
  };

  const firstNul = record.indexOf("\0");
  if (firstNul >= 0) {
    const pathValue = record.slice(0, firstNul);
    const rest = record.slice(firstNul + 1);
    return splitLineAndText(pathValue, rest, "\0") ?? splitLineAndText(pathValue, rest, ":");
  }
  const firstColon = record.indexOf(":");
  if (firstColon < 0) return null;
  return splitLineAndText(record.slice(0, firstColon), record.slice(firstColon + 1), ":");
}

function toSearchTextMatch(args: { path: string; line: number; text: string; queryLower: string }): FilesSearchTextMatch {
  // git's own case folding is not JavaScript's, so a match it found may not be
  // locatable here (non-ASCII locales especially). Column 1 is the honest
  // answer then — the line is right, only the caret position is approximate.
  const column = args.text.toLowerCase().indexOf(args.queryLower);
  return {
    path: args.path,
    line: args.line,
    column: column < 0 ? 1 : column + 1,
    preview: args.text.slice(0, PREVIEW_MAX_CHARS),
  };
}

/**
 * What one `git grep` run tells us: it answered, it could not finish this time
 * (kill/timeout — say nothing about future runs), or this git cannot serve the
 * tier at all and should not be tried again for this workspace.
 */
type GitGrepOutcome =
  | { kind: "answered"; matches: FilesSearchTextMatch[] }
  | { kind: "unfinished" }
  | { kind: "unusable" };

/**
 * Stream `git grep` and stop the moment `limit` matches are in hand.
 *
 * Returns `null` when git could not answer — missing, not a work tree it likes,
 * a crash, or the timeout — so the caller can fall back to the JS scan. Exit
 * code 1 is NOT such a case: for grep it means "no matches", which is a
 * complete and correct answer.
 */
async function searchTextWithGitGrep(args: {
  rootPath: string;
  query: string;
  limit: number;
  includeIgnored: boolean;
}): Promise<GitGrepOutcome> {
  const executable = await resolveGitExecutable();
  const queryLower = args.query.toLowerCase();

  return await new Promise<GitGrepOutcome>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      // argv array, never a shell — and deliberately NOT through
      // `resolveCliSpawnInvocation`: git is a native `.exe` on Windows, and the
      // cmd.exe wrapper that helper adds for shims would re-parse the user's
      // query, expanding any `%VAR%` in it beyond rescue (windows-quirks #8).
      child = spawn(executable, gitGrepArgs(args), {
        cwd: args.rootPath,
        // GIT_OPTIONAL_LOCKS=0 keeps a background search from taking
        // `index.lock` to refresh the index while the user runs their own git.
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      // spawn threw (missing executable, NUL in an argument) — never recoverable.
      resolve({ kind: "unusable" });
      return;
    }

    const matches: FilesSearchTextMatch[] = [];
    let pending = "";
    let settled = false;

    const settle = (value: GitGrepOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const stopChild = (): void => {
      terminateProcessTree(child, "SIGKILL");
      destroyChildProcessStreams(child);
    };
    const timer = setTimeout(() => {
      stopChild();
      // Transient: a slow run says nothing about whether this git CAN grep.
      settle({ kind: "unfinished" });
    }, GIT_GREP_TIMEOUT_MS);

    const emit = (record: string): boolean => {
      const parsed = parseGitGrepRecord(record);
      if (!parsed) return false;
      const relPath = normalizeRelative(parsed.path);
      if (!relPath) return false;
      if (!isSearchableRelPath(relPath, args.includeIgnored)) return false;
      matches.push(toSearchTextMatch({ path: relPath, line: parsed.line, text: parsed.text, queryLower }));
      return matches.length >= args.limit;
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (settled) return;
      let start = 0;
      while (start <= chunk.length) {
        const newline = chunk.indexOf("\n", start);
        const fragment = chunk.slice(start, newline < 0 ? undefined : newline);
        // A clipped record still carries its path and line number, and the
        // preview never needed more than PREVIEW_MAX_CHARS anyway.
        pending += pending.length + fragment.length > MAX_GIT_GREP_RECORD_CHARS
          ? fragment.slice(0, Math.max(0, MAX_GIT_GREP_RECORD_CHARS - pending.length))
          : fragment;
        if (newline < 0) return;
        const record = pending;
        pending = "";
        if (emit(record)) {
          stopChild();
          settle({ kind: "answered", matches });
          return;
        }
        start = newline + 1;
      }
    });
    // Drained but discarded: git writes warnings here and an unread pipe would
    // eventually block the child.
    child.stderr?.resume();

    child.once("error", () => {
      stopChild();
      // The executable could not be run at all — retrying costs a spawn per
      // keystroke and cannot start working.
      settle({ kind: "unusable" });
    });
    child.once("close", (code) => {
      if (settled) return;
      if (pending.length > 0) emit(pending);
      // 0 = matches, 1 = no matches. Both are complete answers. Anything else
      // is git refusing the invocation itself — an unsupported flag on an older
      // git (`-m` needs 2.38) exits 129, a bad pathspec 128 — which will fail
      // identically every time, so the tier is retired rather than retried.
      if (code === 0 || code === 1) {
        settle({ kind: "answered", matches });
        return;
      }
      // `null` means the process was killed from outside (OOM killer, an
      // operator SIGKILL). Every internal kill settles before this fires, so a
      // null here says nothing about whether this git can grep — retiring the
      // tier on it would lose the fast path to an unrelated event.
      settle(code == null ? { kind: "unfinished" } : { kind: "unusable" });
    });
  });
}

export function createFileSearchIndexService() {
  const byWorkspace = new Map<string, WorkspaceIndex>();
  // `git rev-parse` per keystroke would be absurd, so the answer is cached per
  // workspace root and dropped on the same signals that drop the name index.
  const gitWorkTreeByWorkspace = new Map<string, Promise<boolean>>();
  /**
   * Workspaces whose git cannot serve the grep tier at all.
   *
   * `git grep -m` needs git >= 2.38. On an older git every keystroke would pay a
   * failed spawn AND the full tier-2 walk, with nothing in the UI to say why.
   * One hard failure retires the tier for that workspace until the index is
   * invalidated, so the cost is paid once instead of per search.
   */
  const gitGrepUnusableWorkspaces = new Set<string>();

  const workspaceIndexKey = (workspaceId: string, includeIgnored: boolean): string =>
    `${workspaceId}::${includeIgnored ? "all" : "default"}`;

  const gitWorkTreeKey = (workspaceId: string, rootPath: string): string =>
    `${workspaceId}::${pathKey(rootPath)}`;

  const isInsideGitWorkTree = async (workspaceId: string, rootPath: string): Promise<boolean> => {
    const key = gitWorkTreeKey(workspaceId, rootPath);
    const cached = gitWorkTreeByWorkspace.get(key);
    if (cached) return await cached;
    const probe = runGit(["rev-parse", "--is-inside-work-tree"], {
      cwd: rootPath,
      timeoutMs: GIT_WORK_TREE_PROBE_TIMEOUT_MS,
    })
      .then((result) => result.exitCode === 0 && result.stdout.trim() === "true")
      .catch(() => false);
    gitWorkTreeByWorkspace.set(key, probe);
    return await probe;
  };

  const getOrCreateWorkspaceIndex = (workspaceId: string, rootPath: string, includeIgnored: boolean): WorkspaceIndex => {
    const key = workspaceIndexKey(workspaceId, includeIgnored);
    const existing = byWorkspace.get(key);
    if (existing && existing.rootPath === rootPath) return existing;

    const next: WorkspaceIndex = {
      workspaceId,
      rootPath,
      includeIgnored,
      files: new Map(),
      quickOpenCache: new Map(),
      buildingPromise: null,
      builtAt: null
    };
    byWorkspace.set(key, next);
    return next;
  };

  const toAbsolute = (rootPath: string, relPath: string): string => path.join(rootPath, normalizeRelative(relPath));

  const invalidateQuickOpenCache = (index: WorkspaceIndex): void => {
    index.quickOpenCache.clear();
  };

  const removePath = (index: WorkspaceIndex, relPath: string): void => {
    const normalized = normalizeRelative(relPath);
    if (!normalized) return;
    const descendantsPrefix = `${normalized}/`;

    for (const key of index.files.keys()) {
      if (key === normalized || key.startsWith(descendantsPrefix)) {
        index.files.delete(key);
      }
    }
  };

  const upsertFile = (index: WorkspaceIndex, relPath: string): void => {
    const normalized = normalizeRelative(relPath);
    if (!normalized) return;
    const absPath = toAbsolute(index.rootPath, normalized);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch {
      removePath(index, normalized);
      return;
    }

    if (stat.isDirectory()) return;
    if (!stat.isFile()) return;

    index.files.set(normalized, {
      path: normalized,
      lowerPath: normalized.toLowerCase(),
      size: stat.size,
      mtimeMs: stat.mtimeMs
    });
  };

  /**
   * Scan one file for `queryLower` and return its matches. The buffer and the
   * decoded text are local on purpose — they must be collectable the moment
   * this returns.
   */
  const scanFileForMatches = async (args: {
    index: WorkspaceIndex;
    entry: IndexedFile;
    queryLower: string;
    remaining: number;
  }): Promise<FilesSearchTextMatch[]> => {
    if (args.entry.size > MAX_TEXT_FILE_BYTES) return [];
    let buf: Buffer;
    try {
      buf = await fs.promises.readFile(toAbsolute(args.index.rootPath, args.entry.path));
    } catch {
      return [];
    }
    if (hasNullByte(buf)) return [];

    const text = buf.toString("utf8");
    const out: FilesSearchTextMatch[] = [];
    let lineStart = 0;
    let lineNumber = 1;
    while (lineStart <= text.length && out.length < args.remaining) {
      const newline = text.indexOf("\n", lineStart);
      const lineEnd = newline < 0 ? text.length : newline;
      const line = text.slice(lineStart, lineEnd);
      const column = line.toLowerCase().indexOf(args.queryLower);
      if (column >= 0) {
        out.push({
          path: args.entry.path,
          line: lineNumber,
          column: column + 1,
          preview: line.slice(0, PREVIEW_MAX_CHARS)
        });
      }
      if (newline < 0) break;
      lineStart = newline + 1;
      lineNumber += 1;
    }
    return out;
  };

  const quickOpenCacheKey = (query: string, limit: number, allowComposerPrefixFallback: boolean): string =>
    `${query.toLowerCase().trim()}\0${limit}\0${allowComposerPrefixFallback ? "composer" : "generic"}`;

  const rememberQuickOpenCache = (index: WorkspaceIndex, cacheKey: string, items: FilesQuickOpenItem[]): void => {
    if (index.quickOpenCache.has(cacheKey)) {
      index.quickOpenCache.delete(cacheKey);
    }
    index.quickOpenCache.set(cacheKey, cloneQuickOpenItems(items));
    while (index.quickOpenCache.size > QUICK_OPEN_QUERY_CACHE_MAX) {
      const oldest = index.quickOpenCache.keys().next().value;
      if (typeof oldest !== "string") break;
      index.quickOpenCache.delete(oldest);
    }
  };

  const shouldSkipDirectoryName = (name: string): boolean => ALWAYS_SKIPPED_DIRECTORY_NAMES.has(name);

  const buildWorkspace = async (index: WorkspaceIndex, opts: IgnoreOptions): Promise<void> => {
    index.files.clear();
    invalidateQuickOpenCache(index);

    const stack: string[] = [""];
    let visitedFiles = 0;

    while (stack.length > 0) {
      const relDir = stack.pop() ?? "";
      const absDir = toAbsolute(index.rootPath, relDir);

      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(absDir, { withFileTypes: true });
      } catch {
        continue;
      }

      const candidates = entries
        .map((entry) => ({ entry, relPath: normalizeRelative(path.join(relDir, entry.name)) }))
        .filter((candidate) => Boolean(candidate.relPath));

      await opts.primeIgnoreCache?.(candidates.map((candidate) => candidate.relPath), index.includeIgnored);

      for (const { entry, relPath } of candidates) {
        if (!relPath) continue;
        if (shouldSkipPathPrefix(relPath, index.includeIgnored)) continue;
        if (entry.isDirectory() && shouldSkipDirectoryName(entry.name)) continue;
        if (await opts.shouldIgnore(relPath, index.includeIgnored)) continue;

        if (entry.isDirectory()) {
          stack.push(relPath);
          continue;
        }

        if (!entry.isFile()) continue;
        upsertFile(index, relPath);
        visitedFiles += 1;
        if (visitedFiles >= MAX_INDEXED_FILES) {
          index.builtAt = new Date().toISOString();
          invalidateQuickOpenCache(index);
          return;
        }
        if (visitedFiles % YIELD_EVERY_FILES === 0) {
          await cooperativeYield();
        }
      }
    }

    index.builtAt = new Date().toISOString();
    // Drop anything cached against the partially-built file map.
    invalidateQuickOpenCache(index);
  };

  const ensureBuilt = async (workspaceId: string, rootPath: string, opts: IgnoreOptions & {
    includeIgnored: boolean;
  }): Promise<WorkspaceIndex> => {
    const index = getOrCreateWorkspaceIndex(workspaceId, rootPath, opts.includeIgnored);
    // An in-flight build (e.g. a warmQuickOpenIndex kicked off by the chat
    // composer) fills `files` incrementally — wait for it rather than serving
    // a partial index that quickOpen would then cache.
    if (index.buildingPromise) {
      await index.buildingPromise;
      return index;
    }
    if (index.files.size > 0 || index.builtAt) return index;

    index.buildingPromise = buildWorkspace(index, opts).finally(() => {
      index.buildingPromise = null;
    });
    await index.buildingPromise;
    return index;
  };

  return {
    async ensureIndexed(args: {
      workspaceId: string;
      rootPath: string;
      includeIgnored: boolean;
      shouldIgnore: (relPath: string, includeIgnored: boolean) => Promise<boolean>;
      primeIgnoreCache?: (relPaths: string[], includeIgnored: boolean) => Promise<void>;
    }): Promise<void> {
      await ensureBuilt(args.workspaceId, args.rootPath, {
        includeIgnored: args.includeIgnored,
        shouldIgnore: args.shouldIgnore,
        primeIgnoreCache: args.primeIgnoreCache
      });
    },

    async quickOpen(args: {
      workspaceId: string;
      rootPath: string;
      query: string;
      limit: number;
      includeIgnored: boolean;
      allowComposerPrefixFallback?: boolean;
      shouldIgnore: (relPath: string, includeIgnored: boolean) => Promise<boolean>;
      primeIgnoreCache?: (relPaths: string[], includeIgnored: boolean) => Promise<void>;
    }): Promise<FilesQuickOpenItem[]> {
      const index = await ensureBuilt(args.workspaceId, args.rootPath, {
        includeIgnored: args.includeIgnored,
        shouldIgnore: args.shouldIgnore,
        primeIgnoreCache: args.primeIgnoreCache
      });

      const allowComposerPrefixFallback = Boolean(args.allowComposerPrefixFallback);
      const cacheKey = quickOpenCacheKey(args.query, args.limit, allowComposerPrefixFallback);
      const cached = index.quickOpenCache.get(cacheKey);
      if (cached) return cloneQuickOpenItems(cached);

      const scored: FilesQuickOpenItem[] = [];
      for (const entry of index.files.values()) {
        const score = scorePath(entry.lowerPath, args.query, allowComposerPrefixFallback);
        if (score < 0) continue;
        scored.push({ path: entry.path, score });
      }
      scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
      const result = scored.slice(0, args.limit);
      rememberQuickOpenCache(index, cacheKey, result);
      return cloneQuickOpenItems(result);
    },

    async searchText(args: {
      workspaceId: string;
      rootPath: string;
      query: string;
      limit: number;
      includeIgnored: boolean;
      shouldIgnore: (relPath: string, includeIgnored: boolean) => Promise<boolean>;
      primeIgnoreCache?: (relPaths: string[], includeIgnored: boolean) => Promise<void>;
    }): Promise<FilesSearchTextMatch[]> {
      // Tier 1: git greps the workspace itself. It is roughly 5x faster than
      // the walk below on a mid-size repo, and it needs no name index at all —
      // a query that matches nothing no longer costs a full tree walk plus a
      // read of every file in the workspace.
      //
      // Two known, deliberate divergences from tier 2, both in git's favour:
      // it also searches files above `MAX_TEXT_FILE_BYTES` (which the JS scan
      // skips so one enormous file cannot be read whole), and it searches
      // tracked-but-gitignored files. Both mean a git workspace can return
      // slightly MORE than a non-git one for the same query.
      //
      // The third divergence goes the other way: `git grep` does not descend
      // into submodules. `--recurse-submodules` would fix that but is rejected
      // outright when combined with `--untracked` (git exits 128), and untracked
      // files matter far more here — a file an agent just wrote is the common
      // case, a submodule is not.
      const gitGrepKey = gitWorkTreeKey(args.workspaceId, args.rootPath);
      if (
        !gitGrepUnusableWorkspaces.has(gitGrepKey)
        && await isInsideGitWorkTree(args.workspaceId, args.rootPath)
      ) {
        const outcome = await searchTextWithGitGrep({
          rootPath: args.rootPath,
          query: args.query,
          limit: args.limit,
          includeIgnored: args.includeIgnored
        });
        if (outcome.kind === "answered") return outcome.matches;
        if (outcome.kind === "unusable") gitGrepUnusableWorkspaces.add(gitGrepKey);
      }

      // Tier 2: workspaces that are not git work trees (a folder opened from
      // Finder), and any run where git was missing, failed, or timed out.
      const index = await ensureBuilt(args.workspaceId, args.rootPath, {
        includeIgnored: args.includeIgnored,
        shouldIgnore: args.shouldIgnore,
        primeIgnoreCache: args.primeIgnoreCache
      });

      const out: FilesSearchTextMatch[] = [];
      const queryLower = args.query.toLowerCase();
      let scannedFiles = 0;
      for (const entry of index.files.values()) {
        if (out.length >= args.limit) break;
        const matches = await scanFileForMatches({
          index,
          entry,
          queryLower,
          remaining: args.limit - out.length
        });
        for (const match of matches) out.push(match);
        scannedFiles += 1;
        if (scannedFiles % YIELD_EVERY_FILES === 0) {
          await cooperativeYield();
        }
      }
      return out;
    },

    onFileChanged(args: {
      workspaceId: string;
      rootPath: string;
      path: string;
      type: "created" | "modified" | "deleted" | "renamed";
      oldPath?: string;
      shouldIgnore: (relPath: string, includeIgnored: boolean) => Promise<boolean>;
    }): void {
      const relPath = normalizeRelative(args.path);
      const matchingIndexes = Array.from(byWorkspace.values()).filter(
        (index) => index.workspaceId === args.workspaceId && index.rootPath === args.rootPath
      );

      for (const index of matchingIndexes) {
        // If this workspace/mode was never indexed yet, defer indexing until first query.
        if (!index.builtAt && index.files.size === 0) continue;
        invalidateQuickOpenCache(index);

        if (args.oldPath) {
          removePath(index, args.oldPath);
        }

        if (args.type === "deleted") {
          removePath(index, args.path);
          continue;
        }

        void args.shouldIgnore(relPath, index.includeIgnored).then((ignored) => {
          if (ignored || shouldSkipPathPrefix(relPath, index.includeIgnored)) {
            removePath(index, relPath);
          } else {
            upsertFile(index, relPath);
          }
          // A quickOpen between the sync invalidation above and this async
          // update can repopulate the cache from the pre-update file map, so
          // invalidate again once the entry is actually applied.
          invalidateQuickOpenCache(index);
        }).catch(() => {
          // ignore indexing failures
        });
      }
    },

    invalidateWorkspace(workspaceId: string): void {
      const prefix = `${workspaceId}::`;
      for (const key of byWorkspace.keys()) {
        if (key.startsWith(prefix)) {
          byWorkspace.delete(key);
        }
      }
      for (const key of gitGrepUnusableWorkspaces) {
        if (key.startsWith(prefix)) gitGrepUnusableWorkspaces.delete(key);
      }
      for (const key of gitWorkTreeByWorkspace.keys()) {
        if (key.startsWith(prefix)) {
          gitWorkTreeByWorkspace.delete(key);
        }
      }
    },

    dispose(): void {
      byWorkspace.clear();
      gitWorkTreeByWorkspace.clear();
      gitGrepUnusableWorkspaces.clear();
    }
  };
}

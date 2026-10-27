import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import type { RecentProjectSummary } from "../../../shared/types";
import type { RecentProjectRemote } from "../state/globalState";
import { hasTable, openReadOnlyDatabase } from "./readOnlySqlite";
import { readOriginRemoteUrlFromGitConfig } from "./repoProjectResolver";
import { resolveGitMetadataDirectory, resolveWorktreeParentRef } from "./worktreeParent";
import { canonicalGitOriginUrl } from "../github/githubSshAlias";

type RecentProjectEntry = {
  rootPath: string;
  displayName: string;
  lastOpenedAt: string;
  remote?: RecentProjectRemote;
  pinned?: boolean;
};

export type RecentProjectInspection = {
  summary: RecentProjectSummary;
  projectId: string | null;
  defaultBaseRef: string | null;
};

type LaneCountRow = {
  lane_type: string | null;
  worktree_path: string | null;
  attached_root_path: string | null;
};

function normalizePath(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? path.resolve(trimmed) : null;
}

/**
 * A lane reduced to the only thing counting it needs: whether it is the
 * project's primary lane (counted by the root's own existence) or which path
 * has to be on disk for it to count.
 *
 * Keeping the *path* rather than a resolved boolean is what lets the count be
 * recomputed on every call while the database read behind it stays memoized:
 * a lane worktree deleted anywhere on disk still drops out immediately, with
 * no database open or query involved. (The call still fingerprints the
 * database first, which is two `statSync` calls.)
 */
type CountedLane = {
  isPrimary: boolean;
  candidatePath: string | null;
};

function countedLane(row: LaneCountRow): CountedLane {
  if ((row.lane_type ?? "").trim() === "primary") {
    return { isPrimary: true, candidatePath: null };
  }
  return {
    isPrimary: false,
    candidatePath: normalizePath(row.worktree_path) ?? normalizePath(row.attached_root_path),
  };
}

function laneExistsOnDisk(lane: CountedLane, projectRoot: string): boolean {
  if (lane.isPrimary) {
    return fs.existsSync(projectRoot);
  }
  return lane.candidatePath ? fs.existsSync(lane.candidatePath) : false;
}

function countLiveLanes(lanes: CountedLane[], projectRoot: string): number | null {
  let count = 0;
  for (const lane of lanes) {
    if (laneExistsOnDisk(lane, projectRoot)) count += 1;
  }
  return count > 0 ? count : null;
}

type AdeProjectInspection = {
  projectId: string | null;
  defaultBaseRef: string | null;
  laneCount: number | null;
};

const EMPTY_ADE_PROJECT: AdeProjectInspection = {
  projectId: null,
  defaultBaseRef: null,
  laneCount: null,
};

type AdeProjectMemoEntry = {
  fingerprint: string;
  projectId: string | null;
  defaultBaseRef: string | null;
  /** `null` when the database has no `lanes` table at all. */
  lanes: CountedLane[] | null;
};

// The database-opening callers are project-context creation (`main.ts`
// `recentProjectInspectionForRoot`, which inspects every recent to find the one
// it wants) and the mobile/web project catalog, so a user with a few dozen
// registered projects opens every project database repeatedly. The window's own
// recent-projects list is NOT one of them: it goes through `projectListRecent`
// -> `toShallowRecentProjectSummary` behind a 5s TTL and never opens a
// database. The open is the whole cost of a summary (measured ~2.6ms per
// project with a database, ~0.05ms without); the queries behind it and the
// per-lane disk checks are noise. Memoize the read, never the count.
const ADE_PROJECT_MEMO_LIMIT = 256;
const adeProjectMemo = new Map<string, AdeProjectMemoEntry>();

/**
 * Every errno means "treat this file as absent", deliberately and with no log
 * line: ENOENT is the designed path (most projects have no `.ade/ade.db`) and
 * fires for every project on every pass, and this module carries no logger. An
 * unexpected code (EACCES, EIO) degrades exactly the way `readGitOriginUrl`
 * below already degrades on an unreadable git config — and, like the main-file
 * stat failing, it can only ever cause a re-read, never a stale answer.
 */
function statOrNull(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

/**
 * Identity of a project database's *contents* for memo purposes, or `null`
 * when there is no database to read.
 *
 * ADE opens these stores in WAL mode, which splits a write across two files in
 * a way that makes either half alone insufficient:
 *
 * - While a writer holds the store open, a commit appends to `ade.db-wal` and
 *   leaves `ade.db`'s mtime and size completely untouched. A fingerprint built
 *   from `ade.db` alone would keep serving the lane count from before the
 *   commit — the exact staleness this memo must not have.
 * - When that writer closes (or the WAL is reset), the checkpoint moves those
 *   bytes into `ade.db` and removes the WAL. So `ade.db` alone would catch the
 *   close but miss everything in between, and the WAL alone would miss the
 *   close.
 *
 * Absence is part of the value rather than a skipped term, so a WAL appearing
 * or vanishing is itself a change.
 *
 * (mtime, size) is a heuristic, not a content hash — a hash would require the
 * database open this memo exists to avoid. It is sufficient on a local
 * filesystem with sub-second mtime resolution; a coarse or network filesystem
 * can under-invalidate, which is the same assumption `readGitOriginUrl` below
 * already makes.
 */
function adeDatabaseFingerprint(dbPath: string): string | null {
  const main = statOrNull(dbPath);
  if (!main) return null;
  const wal = statOrNull(`${dbPath}-wal`);
  return [main.mtimeMs, main.size, wal ? wal.mtimeMs : "-", wal ? wal.size : "-"].join(":");
}

/**
 * Recomputes the disk-dependent half of a memoized read. Cheap: one
 * `existsSync` per non-archived lane, against a database open it replaces.
 */
function materializeAdeProject(projectRoot: string, memo: AdeProjectMemoEntry): AdeProjectInspection {
  return {
    projectId: memo.projectId,
    defaultBaseRef: memo.defaultBaseRef,
    laneCount: memo.lanes === null ? null : countLiveLanes(memo.lanes, projectRoot),
  };
}

function inspectAdeProject(projectRoot: string): AdeProjectInspection {
  const dbPath = resolveAdeLayout(projectRoot).dbPath;
  // The fingerprint is taken *before* the read on purpose. A write that lands
  // in between leaves the entry keyed to the older state, so the next call
  // sees a mismatch and reads again — one wasted read, never a stale answer.
  // Taking it after the read would key fresh bytes to the newer state and
  // serve them forever.
  const fingerprint = adeDatabaseFingerprint(dbPath);
  if (fingerprint === null) return EMPTY_ADE_PROJECT;

  const memoized = adeProjectMemo.get(projectRoot);
  if (memoized && memoized.fingerprint === fingerprint) {
    return materializeAdeProject(projectRoot, memoized);
  }

  let db: DatabaseSyncType | null = null;
  try {
    db = openReadOnlyDatabase(dbPath);
    db.exec("PRAGMA busy_timeout = 5000");
    const hasProjectsTable = hasTable(db, "projects");
    const hasLanesTable = hasTable(db, "lanes");

    const projectRow = hasProjectsTable
      ? db.prepare(
        `
          select id, default_base_ref as defaultBaseRef
          from projects
          where root_path = ?
          order by last_opened_at desc, created_at desc
          limit 1
        `,
      ).get<{ id?: string; defaultBaseRef?: string | null }>(projectRoot)
        ?? db.prepare(
          `
            select id, default_base_ref as defaultBaseRef
            from projects
            order by last_opened_at desc, created_at desc
            limit 1
          `,
        ).get<{ id?: string; defaultBaseRef?: string | null }>()
      : null;

    const lanes = hasLanesTable
      ? db.prepare(
        `
          select lane_type, worktree_path, attached_root_path
          from lanes
          where coalesce(status, 'active') != 'archived'
            and archived_at is null
        `,
      ).all<LaneCountRow>().map(countedLane)
      : null;

    const entry: AdeProjectMemoEntry = {
      fingerprint,
      projectId: projectRow?.id ?? null,
      defaultBaseRef: projectRow?.defaultBaseRef ?? null,
      lanes,
    };
    // Only successful reads are memoized, so a transient open failure is
    // retried on the next call instead of being pinned for the process.
    // Bounded like the neighbouring caches in this folder, and — unlike them —
    // evicting the oldest root rather than clearing the map: this memo exists
    // to avoid database opens, so dropping every entry at once is the one
    // failure mode it should not have. The key space is already bounded by the
    // registered projects, so this is a backstop rather than a working limit.
    if (adeProjectMemo.size >= ADE_PROJECT_MEMO_LIMIT) {
      const oldestRoot = adeProjectMemo.keys().next().value;
      if (oldestRoot !== undefined) adeProjectMemo.delete(oldestRoot);
    }
    adeProjectMemo.set(projectRoot, entry);
    return materializeAdeProject(projectRoot, entry);
  } catch {
    return EMPTY_ADE_PROJECT;
  } finally {
    db?.close();
  }
}

function readGitLaneCount(projectRoot: string): number | undefined {
  try {
    const actualGitDir = resolveGitMetadataDirectory(projectRoot);
    if (!actualGitDir) return undefined;

    let laneCount = 1;
    const worktreesPath = path.join(actualGitDir, "worktrees");
    if (fs.existsSync(worktreesPath)) {
      laneCount += fs.readdirSync(worktreesPath, { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory())
        .length;
    }
    return laneCount;
  } catch {
    return undefined;
  }
}

/**
 * Undecorates a git-config value: git strips surrounding quotes and honours
 * `\` escapes inside them, and treats an unquoted `;` or `#` as the start of a
 * trailing comment. Leaving either in place corrupts the origin URL, and the
 * origin URL is what decides whether two checkouts are the same repository.
 */
export function cleanGitConfigValue(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("\"")) {
    let out = "";
    for (let i = 1; i < trimmed.length; i += 1) {
      const char = trimmed[i];
      if (char === "\\" && i + 1 < trimmed.length) {
        out += trimmed[i + 1];
        i += 1;
        continue;
      }
      if (char === "\"") break;
      out += char;
    }
    return out.trim() || null;
  }
  const commentIdx = trimmed.search(/[;#]/);
  const value = (commentIdx === -1 ? trimmed : trimmed.slice(0, commentIdx)).trim();
  return value || null;
}

/**
 * `origin`'s url from raw git-config text.
 *
 * Section scanning is delegated to the line-based parser the repo resolver
 * already uses, which anchors on whole `[...]` lines (so an indented
 * `  [remote "upstream"]` still ends origin's section) and case-folds the
 * section name. Only value undecoration is added on top.
 */
export function parseGitOriginUrlFromConfig(configText: string): string | null {
  const raw = readOriginRemoteUrlFromGitConfig(configText);
  return raw ? cleanGitConfigValue(raw) : null;
}

/**
 * The directory whose `config` holds a checkout's remotes.
 *
 * A linked worktree's metadata dir contains a `commondir` pointer to the
 * repository-wide Git directory, whose config owns the remotes. Reading that
 * pointer works for ordinary `.git` directories, bare repositories, and
 * separately named Git directories without guessing from path basenames.
 *
 * The path-shape check remains only as a compatibility fallback for incomplete
 * metadata (including older synthetic fixtures). It is deliberately strict: a
 * repo that merely lives under a folder named `worktrees` must not be
 * truncated to that folder's parent, and a submodule nested inside a linked
 * worktree must keep its own config.
 */
export function resolveGitConfigDirectory(gitDir: string): string {
  try {
    const rawCommonDir = fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim();
    if (rawCommonDir) return path.resolve(gitDir, rawCommonDir);
  } catch {
    // Fall through to the legacy path-shape check.
  }

  const parent = path.dirname(gitDir);
  if (path.basename(parent) !== "worktrees") return gitDir;
  const commonGitDir = path.dirname(parent);
  if (path.basename(commonGitDir) !== ".git") return gitDir;
  return commonGitDir;
}

type GitOriginCacheEntry = {
  configPath: string;
  mtimeMs: number;
  url: string | null;
};

// Recents are re-summarized on every focus and every project change. The config
// file is small, but re-reading and re-parsing one per recent on every pass is
// pure waste when it almost never changes — key on its mtime.
const GIT_ORIGIN_CACHE_LIMIT = 256;
const gitOriginCache = new Map<string, GitOriginCacheEntry>();

/**
 * The origin URL from the checkout's git config file, without starting git.
 * `undefined` whenever the file alone may not give git's answer: no readable
 * config, no origin URL in it (a global config can still name one), more than
 * one (git takes the last), a value git would decode (quotes, an inline
 * comment, an escape), includes (an `[include]` or `[includeIf]` can replace
 * it), or per-worktree config (`extensions.worktreeConfig`).
 */
export function readGitOriginUrlWithoutGit(projectRoot: string): string | undefined {
  try {
    const gitDir = resolveGitMetadataDirectory(projectRoot);
    if (!gitDir) return undefined;
    const text = fs.readFileSync(path.join(resolveGitConfigDirectory(gitDir), "config"), "utf8");
    if (/^\s*\[\s*include/im.test(text) || /^\s*worktreeConfig\s*=\s*true\b/im.test(text)) return undefined;
    const urls = originUrlLines(text);
    // A quoted value, an inline comment or an escape needs git's own decoding.
    return urls.length === 1 && !/["\\;#]/.test(urls[0]!) ? urls[0] : undefined;
  } catch {
    return undefined;
  }
}

/** Every `url` value in the config's `[remote "origin"]` sections, in order. */
function originUrlLines(configText: string): string[] {
  const urls: string[] = [];
  let inOrigin = false;
  for (const rawLine of configText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      inOrigin = /^remote\s+"origin"$/i.test(section[1]?.trim() ?? "");
      continue;
    }
    const url = inOrigin ? line.match(/^url\s*=\s*(.+)$/i)?.[1]?.trim() : undefined;
    if (url) urls.push(url);
  }
  return urls;
}

/**
 * The origin URL from the checkout's git config file, or from `git config`
 * when the file alone cannot settle it; null when there is none. The brain's
 * project registration takes this path: starting `git` there blocked its event
 * loop for 50-160 ms per new project.
 */
export function readGitOriginUrlFromConfigOrGit(projectRoot: string): string | null {
  const fromFile = readGitOriginUrlWithoutGit(projectRoot);
  if (fromFile !== undefined) return fromFile;
  const result = spawnSync("git", ["config", "--get", "remote.origin.url"], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  const value = typeof result.stdout === "string" ? result.stdout.trim() : "";
  return value || null;
}

/**
 * Reads `origin` straight out of the repo's git config, as written there,
 * cached by the config file's mtime.
 *
 * Deliberately a plain file read rather than `git remote get-url`: spawning
 * `git` once per recent would not be free. Identity code wants
 * {@link readGitOriginUrl}; this raw form is for code that must see the alias.
 */
export function readGitConfigOriginUrl(projectRoot: string): string | null {
  try {
    const gitDir = resolveGitMetadataDirectory(projectRoot);
    if (!gitDir) return null;
    const configPath = path.join(resolveGitConfigDirectory(gitDir), "config");

    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(configPath).mtimeMs;
    } catch {
      return null;
    }
    const cached = gitOriginCache.get(projectRoot);
    if (cached && cached.configPath === configPath && cached.mtimeMs === mtimeMs) {
      return cached.url;
    }

    const url = parseGitOriginUrlFromConfig(fs.readFileSync(configPath, "utf8"));
    if (gitOriginCache.size >= GIT_ORIGIN_CACHE_LIMIT) gitOriginCache.clear();
    gitOriginCache.set(projectRoot, { configPath, mtimeMs, url });
    return url;
  } catch {
    return null;
  }
}

/**
 * The repository's origin for identity: the git config value, with an SSH
 * alias of GitHub (`git@github.com-work:org/repo`) given as its `github.com`
 * form. This is what lets the top bar join a local checkout and a remote
 * checkout of the same repository into one tab, and what keys the account's
 * repo-scoped settings and secrets.
 */
export function readGitOriginUrl(projectRoot: string): string | null {
  return canonicalGitOriginUrl(readGitConfigOriginUrl(projectRoot));
}

function remoteRecentSummary(entry: RecentProjectEntry): RecentProjectSummary {
  return {
    rootPath: entry.rootPath,
    displayName: entry.displayName,
    lastOpenedAt: entry.lastOpenedAt,
    // A remote project always "exists" from the desktop's point of view — its
    // reachability is a live connection concern resolved by the renderer
    // against the remote connection snapshot, not a local-disk check.
    exists: true,
    kind: "remote",
    remote: entry.remote,
    ...(entry.remote?.gitOriginUrl
      ? { gitOriginUrl: entry.remote.gitOriginUrl }
      : {}),
    ...(entry.pinned ? { pinned: true } : {}),
  };
}

export function inspectRecentProject(entry: RecentProjectEntry): RecentProjectInspection {
  if (entry.remote) {
    return {
      summary: remoteRecentSummary(entry),
      projectId: null,
      defaultBaseRef: null,
    };
  }
  const exists = fs.existsSync(entry.rootPath);
  const adeProject = exists ? inspectAdeProject(entry.rootPath) : EMPTY_ADE_PROJECT;
  const laneCount = exists ? (adeProject.laneCount ?? readGitLaneCount(entry.rootPath)) : undefined;
  const worktreeOf = exists ? resolveWorktreeParentRef(entry.rootPath) : null;

  return {
    summary: {
      rootPath: entry.rootPath,
      displayName: entry.displayName,
      lastOpenedAt: entry.lastOpenedAt,
      exists,
      ...(worktreeOf ? { worktreeOf } : {}),
      laneCount,
      kind: "local",
      ...(exists ? { gitOriginUrl: readGitOriginUrl(entry.rootPath) } : {}),
      ...(entry.pinned ? { pinned: true } : {}),
    },
    projectId: adeProject.projectId,
    defaultBaseRef: adeProject.defaultBaseRef,
  };
}

export function toShallowRecentProjectSummary(entry: RecentProjectEntry): RecentProjectSummary {
  if (entry.remote) {
    return remoteRecentSummary(entry);
  }
  const exists = fs.existsSync(entry.rootPath);
  const worktreeOf = exists ? resolveWorktreeParentRef(entry.rootPath) : null;
  return {
    rootPath: entry.rootPath,
    displayName: entry.displayName,
    lastOpenedAt: entry.lastOpenedAt,
    exists,
    ...(worktreeOf ? { worktreeOf } : {}),
    kind: "local",
    // The renderer's tab bar joins local and remote checkouts of one repo on
    // this key, and IPC.projectListRecent serves the tab bar from this shallow
    // path — without it every tab would arrive origin-less and nothing would
    // ever merge. The read is mtime-cached, so it stays cheap on the repeated
    // focus/project-change passes the recents cache already absorbs.
    ...(exists ? { gitOriginUrl: readGitOriginUrl(entry.rootPath) } : {}),
    ...(entry.pinned ? { pinned: true } : {}),
  };
}

export function toRecentProjectSummary(entry: RecentProjectEntry): RecentProjectSummary {
  return inspectRecentProject(entry).summary;
}

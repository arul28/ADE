import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OnboardingProjectCandidate, OnboardingProjectDiscovery } from "../../../shared/types";
import { parseGithubRemoteUrl } from "../../../shared/githubRemote";
import { gitRemoteRepoSlug } from "../../../shared/cursorCloudRepoMatch";
import {
  findAdeManagedWorktreeRoot,
  gitCommonDirOf,
  linkedWorktreeParentRoot,
  realpathIfExists,
} from "../../../../../ade-cli/src/services/projects/projectRoots";
import { claudeConfigDir } from "../externalSessions/discoverClaude";
import {
  closeExternalSessionDb,
  isUuidLike,
  normalizeProviderCwd,
  openExternalSessionDb,
  resolveHomeDir,
} from "../externalSessions/discoveryUtils";
import { resolveDeviceDisplayNameSettled } from "../../../../../ade-cli/src/services/sync/deviceRegistryService";
import { listLinkedLaneWorktreeRoots } from "../projects/worktreeParent";
import { readOriginRemoteUrlFromGitConfig } from "../projects/repoProjectResolver";
import { pathKey } from "../shared/pathCompare";

/**
 * First-run setup: the git projects on this computer that Claude Code and Codex
 * have worked in, so ADE can add them (and their chats and worktrees) for the
 * user instead of asking them to find each folder.
 *
 * Built to stay off the main thread's critical path: Codex is one aggregate
 * query on its own thread index, Claude is a directory listing plus a small
 * read of the newest transcript per project folder (for its cwd), and every
 * git question is answered from files, never by spawning git. It reads, and
 * never writes, anything outside ADE.
 */

const DAY_MS = 24 * 3_600_000;
/** Chats active this recently are what setup imports, and what makes a project suggested. */
export const ONBOARDING_RECENT_CHAT_WINDOW_MS = 30 * DAY_MS;
/** Sessions older than this do not make a folder a candidate on their own. */
const DISCOVERY_WINDOW_MS = 180 * DAY_MS;
const SUGGESTED_MIN_RECENT_CHATS = 2;
const MAX_CANDIDATES = 40;
const CLAUDE_HEAD_BYTES = 64 * 1024;
const MAX_CHECKOUT_WALK_DEPTH = 40;
const CODEX_STATE_DB_BASENAME = "state_5.sqlite";

type FolderActivity = {
  cwd: string;
  chats: number;
  recentChats: number;
  lastActiveAt: number;
  providers: Set<"claude" | "codex">;
};

type DiscoveryLogger = {
  warn?: (message: string, fields?: Record<string, unknown>) => void;
  info?: (message: string, fields?: Record<string, unknown>) => void;
};

function addActivity(
  activity: Map<string, FolderActivity>,
  cwd: string,
  provider: "claude" | "codex",
  chats: number,
  recentChats: number,
  lastActiveAt: number,
): void {
  const key = pathKey(cwd);
  const existing = activity.get(key);
  if (existing) {
    existing.chats += chats;
    existing.recentChats += recentChats;
    existing.lastActiveAt = Math.max(existing.lastActiveAt, lastActiveAt);
    existing.providers.add(provider);
    return;
  }
  activity.set(key, { cwd, chats, recentChats, lastActiveAt, providers: new Set([provider]) });
}

/** The first `"cwd":"…"` in a transcript's head, without parsing whole lines. */
function cwdFromTranscriptHead(text: string): string | null {
  const match = text.match(/"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/);
  if (!match?.[1]) return null;
  try {
    const value = JSON.parse(match[1]) as unknown;
    return typeof value === "string" ? normalizeProviderCwd(value) : null;
  } catch {
    return null;
  }
}

async function readHead(filePath: string, bytes: number): Promise<string | null> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(filePath, "r");
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Claude keeps one folder per working directory under `projects/`, named by a
 * lossy slug of the path, with one `<uuid>.jsonl` per session. Count sessions
 * from the listing and file times; read only the newest transcript's head for
 * the real cwd.
 */
async function collectClaudeActivity(activity: Map<string, FolderActivity>, now: number): Promise<void> {
  const projectsDir = path.join(claudeConfigDir(), "projects");
  let projectDirs: fs.Dirent[];
  try {
    projectDirs = await fs.promises.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(projectDirs.filter((entry) => entry.isDirectory()).map(async (projectEntry) => {
    const projectDir = path.join(projectsDir, projectEntry.name);
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(projectDir, { withFileTypes: true });
    } catch {
      return;
    }
    const sessionFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl") && isUuidLike(entry.name.slice(0, -".jsonl".length)))
      .map((entry) => path.join(projectDir, entry.name));
    if (!sessionFiles.length) return;
    const times = await Promise.all(sessionFiles.map(async (filePath) => {
      try {
        return { filePath, mtimeMs: (await fs.promises.stat(filePath)).mtimeMs };
      } catch {
        return null;
      }
    }));
    const live = times.filter((entry): entry is { filePath: string; mtimeMs: number } => entry !== null);
    if (!live.length) return;
    live.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const newest = live[0]!;
    if (now - newest.mtimeMs > DISCOVERY_WINDOW_MS) return;
    const head = await readHead(newest.filePath, CLAUDE_HEAD_BYTES);
    const cwd = head ? cwdFromTranscriptHead(head) : null;
    if (!cwd) return;
    const recent = live.filter((entry) => now - entry.mtimeMs <= ONBOARDING_RECENT_CHAT_WINDOW_MS).length;
    addActivity(activity, cwd, "claude", live.length, recent, newest.mtimeMs);
  }));
}

function codexHomeDir(): string {
  const configured = typeof process.env.CODEX_HOME === "string" ? process.env.CODEX_HOME.trim() : "";
  return configured ? path.resolve(configured) : path.join(resolveHomeDir(), ".codex");
}

/**
 * Codex indexes every thread, with its cwd, in a local SQLite file. One
 * grouped query gives the folders, the counts and the newest activity. The
 * filters match the import list's: no archived threads, no subagent threads,
 * no `exec`/`vscode` runs.
 */
function collectCodexActivity(activity: Map<string, FolderActivity>, now: number, logger?: DiscoveryLogger): void {
  const db = openExternalSessionDb(path.join(codexHomeDir(), CODEX_STATE_DB_BASENAME), logger);
  if (!db) return;
  try {
    const rows = db.prepare(`
      SELECT t.cwd AS cwd,
             COUNT(*) AS chats,
             SUM(CASE WHEN COALESCE(NULLIF(t.updated_at_ms, 0), t.updated_at * 1000) >= ? THEN 1 ELSE 0 END) AS recentChats,
             MAX(COALESCE(NULLIF(t.updated_at_ms, 0), t.updated_at * 1000)) AS lastActiveAt
        FROM threads t
       WHERE t.archived = 0
         AND t.agent_role IS NULL
         AND t.cwd IS NOT NULL AND t.cwd != ''
         AND (t.source IS NULL OR (t.source NOT IN ('exec', 'vscode') AND substr(t.source, 1, 1) NOT IN ('{', '[')))
         AND NOT EXISTS (SELECT 1 FROM thread_spawn_edges e WHERE e.child_thread_id = t.id)
       GROUP BY t.cwd
    `).all(now - ONBOARDING_RECENT_CHAT_WINDOW_MS) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const cwd = normalizeProviderCwd(typeof row.cwd === "string" ? row.cwd : null);
      const lastActiveAt = Number(row.lastActiveAt);
      if (!cwd || !Number.isFinite(lastActiveAt) || now - lastActiveAt > DISCOVERY_WINDOW_MS) continue;
      addActivity(activity, cwd, "codex", Number(row.chats) || 0, Number(row.recentChats) || 0, lastActiveAt);
    }
  } catch (error) {
    logger?.warn?.("onboarding.codex_discovery_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    closeExternalSessionDb(db);
  }
}

/** The checkout a folder sits in: the nearest ancestor with a `.git` entry. */
function findCheckoutRoot(start: string, stopAt: Set<string>): string | null {
  let current = path.resolve(start);
  for (let depth = 0; depth < MAX_CHECKOUT_WALK_DEPTH; depth += 1) {
    if (stopAt.has(pathKey(current))) return null;
    try {
      fs.statSync(path.join(current, ".git"));
      return current;
    } catch {
      // keep walking up
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/**
 * The project a checkout belongs to: an ADE lane's project, a linked
 * worktree's main checkout, or the checkout itself.
 */
function projectRootForCheckout(checkoutRoot: string): string {
  const managed = findAdeManagedWorktreeRoot(checkoutRoot);
  if (managed) return managed.projectRoot;
  return linkedWorktreeParentRoot(checkoutRoot) ?? realpathIfExists(checkoutRoot);
}

/** Folders that are never projects: scratch, downloads, temp, the home folder. */
function excludedRoots(home: string): { exact: Set<string>; prefixes: string[] } {
  const exact = new Set([pathKey(home), pathKey(path.parse(home).root)]);
  const prefixes = [
    os.tmpdir(),
    "/private/var/folders",
    "/tmp",
    path.join(home, "Downloads"),
    path.join(home, "Library"),
    path.join(home, "Documents", "Codex"),
    path.join(home, ".ade"),
    path.join(home, ".claude"),
    path.join(home, ".codex"),
  ].map((value) => pathKey(realpathIfExists(value)));
  return { exact, prefixes };
}

function isExcluded(root: string, excluded: { exact: Set<string>; prefixes: string[] }): boolean {
  const key = pathKey(root);
  if (excluded.exact.has(key)) return true;
  return excluded.prefixes.some((prefix) => key === prefix || key.startsWith(`${prefix}/`) || key.startsWith(`${prefix}\\`));
}

function repoLabelFor(projectRoot: string): string | null {
  const commonDir = gitCommonDirOf(projectRoot);
  if (!commonDir) return null;
  try {
    const remote = readOriginRemoteUrlFromGitConfig(fs.readFileSync(path.join(commonDir, "config"), "utf8"));
    if (!remote) return null;
    const github = parseGithubRemoteUrl(remote);
    if (github) return `${github.owner}/${github.repo}`;
    return gitRemoteRepoSlug(remote) || null;
  } catch {
    return null;
  }
}

export async function discoverOnboardingProjects(args: {
  /** Projects already in ADE on this computer: left out. */
  knownRoots: string[];
  logger?: DiscoveryLogger;
  now?: number;
}): Promise<OnboardingProjectDiscovery> {
  const now = args.now ?? Date.now();
  const activity = new Map<string, FolderActivity>();
  await collectClaudeActivity(activity, now);
  collectCodexActivity(activity, now, args.logger);

  const home = realpathIfExists(os.homedir());
  const excluded = excludedRoots(home);
  const stopAt = new Set([pathKey(path.dirname(home))]);
  const known = new Set(args.knownRoots.map((root) => pathKey(realpathIfExists(root))));

  const byProject = new Map<string, { rootPath: string; folders: FolderActivity[] }>();
  const checkoutCache = new Map<string, string | null>();
  for (const folder of activity.values()) {
    if (!fs.existsSync(folder.cwd)) continue;
    const cacheKey = pathKey(folder.cwd);
    let rootPath = checkoutCache.get(cacheKey);
    if (rootPath === undefined) {
      const checkout = findCheckoutRoot(folder.cwd, stopAt);
      rootPath = checkout ? projectRootForCheckout(checkout) : null;
      checkoutCache.set(cacheKey, rootPath);
    }
    if (!rootPath || isExcluded(rootPath, excluded)) continue;
    const key = pathKey(rootPath);
    if (known.has(key)) continue;
    const entry = byProject.get(key) ?? { rootPath, folders: [] };
    entry.folders.push(folder);
    byProject.set(key, entry);
  }

  const projects: OnboardingProjectCandidate[] = [];
  for (const { rootPath, folders } of byProject.values()) {
    const providers = new Set<"claude" | "codex">();
    let chatCount = 0;
    let recentChatCount = 0;
    let lastActiveAt = 0;
    for (const folder of folders) {
      chatCount += folder.chats;
      recentChatCount += folder.recentChats;
      lastActiveAt = Math.max(lastActiveAt, folder.lastActiveAt);
      for (const provider of folder.providers) providers.add(provider);
    }
    projects.push({
      rootPath,
      name: path.basename(rootPath),
      repoLabel: repoLabelFor(rootPath),
      chatCount,
      recentChatCount,
      lastActiveAt: lastActiveAt || null,
      providers: (["claude", "codex"] as const).filter((provider) => providers.has(provider)),
      laneCount: listLinkedLaneWorktreeRoots(rootPath).length,
      suggested: recentChatCount >= SUGGESTED_MIN_RECENT_CHATS,
    });
  }
  projects.sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0));

  args.logger?.info?.("onboarding.projects_discovered", {
    folders: activity.size,
    projects: projects.length,
  });
  // The name the user gave this computer (macOS ComputerName), not its network hostname.
  const machineName = (await resolveDeviceDisplayNameSettled()).replace(/\.(local|lan|home)$/i, "").trim();
  return { machineName: machineName || "this computer", projects: projects.slice(0, MAX_CANDIDATES) };
}

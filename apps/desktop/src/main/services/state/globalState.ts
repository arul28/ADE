import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AppWelcomeVideoState,
  AutoUpdatePreferences,
  KeepAwakePreferences,
  OpenProjectBinding,
  RecentProjectRemoteRef,
  RecentlyInstalledUpdate,
  UpdateInterruptedChat,
} from "../../../shared/types";
import type {
  BuiltInBrowserAgentAccessMode,
  BuiltInBrowserAgentChatGrant,
  BuiltInBrowserAgentLaneGrant,
  BuiltInBrowserSettingsPersisted,
} from "../../../shared/types/builtInBrowser";
import { projectRefStateKey } from "../../../shared/projectIdentity";
import { sanitizePortableGitRemote } from "../../../shared/crossMachineHandoff";
import type { MainWindowState } from "./mainWindowState";

export type RecentProjectRemote = RecentProjectRemoteRef;

export type RecentProject = {
  rootPath: string;
  displayName: string;
  lastOpenedAt: string;
  /** Present iff this recent points at a project on a remote machine. */
  remote?: RecentProjectRemote;
  /** Pinned projects are kept above the recency order and never auto-evicted. */
  pinned?: boolean;
};

/**
 * Stable identity for a recent project. Local projects are keyed by their
 * absolute root path (so a remote path string can never collide with a local
 * one); remote projects are keyed by their owning target + remote project id.
 *
 * Delegates to the shared definition so main, preload, and renderer cannot
 * drift — they previously each had their own copy of this format, which is how
 * the renderer ended up writing its lane cache under one key and reading it
 * back under another.
 */
export function recentProjectKey(
  proj: { rootPath: string; remote?: RecentProjectRemote },
): string {
  return projectRefStateKey(proj);
}

export type UpdateWorkspaceState = {
  localRoots: string[];
  activeLocalRoot?: string | null;
};

export type PendingInstallUpdate = {
  fromVersion: string;
  targetVersion: string;
  releaseNotesUrl: string | null;
  requestedAt: string;
  /** "Update & restart" was pressed on another machine (see `remoteUpdateInstall`). */
  requestedRemotely?: boolean;
  /**
   * The install ran because the person quit ADE with automatic install on. The
   * launch that lands it restarts the background service on the new build
   * with no window, then closes again (see `installOnQuit.ts`).
   */
  closeAfterInstall?: boolean;
  /**
   * Chats ADE armed a "continue" row for before this install, when the user
   * asked for it. Written by the quit that installs and read by the launch that
   * lands it, so the post-update notice can name what came back.
   *
   * Lives inside `pendingInstallUpdate` on purpose: an install that fails or is
   * declined clears the whole pending record, so a resume list can never drift
   * onto a later, unrelated update.
   */
  resumedChats?: UpdateInterruptedChat[];
};

// Consecutive installs of the same version that quit without landing. The
// archive was already checksum-verified before it went "ready", so the first
// failure keeps it and a retry skips re-downloading; a repeat says the archive
// itself is suspect and earns a clean slate.
export type FailedInstallAttempts = {
  targetVersion: string;
  count: number;
  lastFailedAt: string;
};

/**
 * Records that startup has already settled Terminal access to the `ade`
 * command on this machine, so it is never attempted a second time. Removing the
 * binary or the shell PATH line afterwards is a deliberate act, and this marker
 * is what stops the next launch from silently undoing it.
 */
export type AdeCliAutoInstall = {
  completedAt: string;
  /** `installed` = ADE placed it; `already-available` = another install owns it. */
  outcome: "installed" | "already-available";
  command: string;
};

export type GlobalState = {
  lastProjectRoot?: string;
  lastRemoteProjectBinding?: Extract<OpenProjectBinding, { kind: "remote" }> & {
    updatedAt?: string;
  };
  recentProjects?: RecentProject[];
  pendingInstallUpdate?: PendingInstallUpdate;
  recentlyInstalledUpdate?: RecentlyInstalledUpdate;
  /**
   * Open local project tabs, written as they change. Read only on the launch
   * that just finished installing an update.
   */
  updateWorkspace?: UpdateWorkspaceState;
  /**
   * Set only by the update quit. The next launch reopens `updateWorkspace`
   * once, then clears this so a later ordinary launch stays on welcome.
   */
  restoreUpdateWorkspaceOnLaunch?: boolean;
  failedInstallAttempts?: FailedInstallAttempts;
  /**
   * The build "Go back" left because it could not start
   * (`startupRecovery.ts`). Ordinary update checks never offer that build
   * again; a newer one is offered as usual.
   */
  wentBackFrom?: { version: string; toVersion: string; at: string };
  autoUpdatePreferences?: AutoUpdatePreferences;
  /** Whether ADE may hold this machine awake while agents run. Default: never. */
  keepAwakePreferences?: KeepAwakePreferences;
  welcomeVideo?: AppWelcomeVideoState;
  /** Set once Terminal access to `ade` has been settled; see `AdeCliAutoInstall`. */
  adeCliAutoInstall?: AdeCliAutoInstall;
  /**
   * The user picked "Don't ask again" on Claude's resume-return dialog.
   *
   * Machine-wide and durable: the dialog asks whether to compact a session on
   * resume, and a person who has said no once should not be asked again by the
   * next chat. ADE stops declaring the `resume_return` dialog kind while this
   * is set, which is what makes the CLI stop emitting it.
   */
  claudeResumeReturnDismissed?: boolean;
  /**
   * False once the person ticked "Don't ask again" on the quit confirmation.
   * Absent means ask. Settings turns it back on. Never silences the warning
   * shown when quitting would stop running agents.
   */
  askBeforeQuit?: boolean;
  /**
   * "Agents can use the ADE browser" and the lanes and chats the user allowed.
   * Machine-wide because the browser's signed-in profile is one per install.
   * Absent: every agent may use it (the default).
   */
  builtInBrowserAgentAccess?: {
    enabled?: boolean;
    mode?: BuiltInBrowserAgentAccessMode;
    laneGrants?: BuiltInBrowserAgentLaneGrant[];
    chatGrants?: BuiltInBrowserAgentChatGrant[];
  };
  /** Machine-wide browser settings: tab limit, download folder, auto-grants. */
  builtInBrowserSettings?: BuiltInBrowserSettingsPersisted;
  /** Where the last ADE window sat; read through `parseMainWindowState`. */
  mainWindow?: MainWindowState;
};

export function readGlobalState(filePath: string): GlobalState {
  try {
    return readGlobalStateForUpdate(filePath);
  } catch {
    return {};
  }
}

/**
 * `readGlobalState` for a read-modify-write: a missing file is `{}`, but an
 * unreadable or corrupt one throws, so the write cannot wipe what it held.
 */
export function readGlobalStateForUpdate(filePath: string): GlobalState {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const parsed = JSON.parse(raw) as GlobalState;
  return parsed && typeof parsed === "object" ? parsed : {};
}

export function writeGlobalState(filePath: string, state: GlobalState): void {
  let tempPath: string | null = null;
  let fd: number | null = null;
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    fd = fs.openSync(tempPath, "w");
    fs.writeFileSync(fd, serialized, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, filePath);
    tempPath = null;
    try {
      const dirFd = fs.openSync(dir, "r");
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // Directory fsync is best effort across filesystems/platforms.
    }
  } catch {
    if (fd != null) {
      try { fs.closeSync(fd); } catch {}
    }
    if (tempPath) {
      try { fs.unlinkSync(tempPath); } catch {}
    }
    // Non-fatal; global state is a convenience.
  }
}

type UpsertRecentProjectOptions = {
  recordLastProject?: boolean;
  recordRecent?: boolean;
  preserveRecentOrder?: boolean;
};

// Recents are recency-ordered. We keep more than the visible window so a few
// pinned-but-stale projects don't crowd out fresh ones, and pinned entries are
// retained beyond the cap entirely (they are never auto-evicted).
const RECENT_PROJECT_CAP = 24;
const REMOTE_PROJECT_ICON_DATA_URL_MAX_BYTES = 128 * 1024;
const REMOTE_PROJECT_ICON_DATA_URL_RE = /^data:image\/[a-z0-9.+-]+;base64,/i;

// Global state should only store small, already-bounded project icon payloads.
// Callers with full-size remote icons should thumbnail before this boundary.
export function persistableRemoteProjectIconDataUrl(
  value: string | null | undefined,
): string | null {
  const dataUrl = typeof value === "string" ? value.trim() : "";
  if (!dataUrl || !REMOTE_PROJECT_ICON_DATA_URL_RE.test(dataUrl)) return null;
  return Buffer.byteLength(dataUrl, "utf8") <= REMOTE_PROJECT_ICON_DATA_URL_MAX_BYTES
    ? dataUrl
    : null;
}

export function withPersistableRemoteProjectIcon<T extends { iconDataUrl?: string | null }>(
  value: T,
): T {
  const next = { ...value };
  const iconDataUrl = persistableRemoteProjectIconDataUrl(value.iconDataUrl);
  if (iconDataUrl) {
    next.iconDataUrl = iconDataUrl;
  } else {
    delete next.iconDataUrl;
  }
  return next;
}

export function persistableRemoteProjectBinding<
  T extends Extract<OpenProjectBinding, { kind: "remote" }>,
>(value: T): T {
  const next = withPersistableRemoteProjectIcon(value);
  const gitOriginUrl = typeof value.gitOriginUrl === "string" && value.gitOriginUrl.trim()
    ? sanitizePortableGitRemote(value.gitOriginUrl)
    : null;
  if (gitOriginUrl) {
    next.gitOriginUrl = gitOriginUrl;
  } else {
    delete next.gitOriginUrl;
  }
  return next;
}

export function persistableRecentProjectRemote(
  remote: RecentProjectRemote,
): RecentProjectRemote {
  const iconDataUrl = persistableRemoteProjectIconDataUrl(remote.iconDataUrl);
  const gitOriginUrl = typeof remote.gitOriginUrl === "string" && remote.gitOriginUrl.trim()
    ? sanitizePortableGitRemote(remote.gitOriginUrl)
    : null;
  return {
    targetId: remote.targetId,
    projectId: remote.projectId,
    runtimeName: remote.runtimeName,
    hostname: remote.hostname,
    ...(remote.transport ? { transport: remote.transport } : {}),
    ...(gitOriginUrl ? { gitOriginUrl } : {}),
    ...(iconDataUrl ? { iconDataUrl } : {}),
  };
}

/** The recents entry for an open of `proj` at `now`, keeping its pin from `prev`. */
function recentProjectEntry(
  proj: { rootPath: string; displayName: string; remote?: RecentProjectRemote },
  prev: readonly RecentProject[],
  now: string,
): RecentProject {
  const key = recentProjectKey(proj);
  const existing = prev.find((p) => recentProjectKey(p) === key);
  const remote = proj.remote ? persistableRecentProjectRemote(proj.remote) : undefined;
  return {
    rootPath: proj.rootPath,
    displayName: proj.displayName,
    lastOpenedAt: now,
    ...(remote ? { remote } : {}),
    ...(existing?.pinned ? { pinned: true } : {}),
  };
}

export function upsertRecentProject(
  state: GlobalState,
  proj: { rootPath: string; displayName: string; remote?: RecentProjectRemote },
  options: UpsertRecentProjectOptions = {}
): GlobalState {
  const next: GlobalState = { ...state };
  const now = new Date().toISOString();
  if (options.recordLastProject ?? false) {
    next.lastProjectRoot = proj.rootPath;
  } else {
    delete next.lastProjectRoot;
  }
  if (options.recordRecent === false) {
    return next;
  }
  const prev = next.recentProjects ?? [];
  const key = recentProjectKey(proj);
  const nextEntry = recentProjectEntry(proj, prev, now);
  if (options.preserveRecentOrder === true) {
    const existingIndex = prev.findIndex((p) => recentProjectKey(p) === key);
    if (existingIndex >= 0 && existingIndex < RECENT_PROJECT_CAP) {
      const updated = prev.slice();
      updated[existingIndex] = nextEntry;
      next.recentProjects = updated;
      return next;
    }
  }
  const filtered = prev.filter((p) => recentProjectKey(p) !== key);
  const merged = [nextEntry, ...filtered];
  next.recentProjects = merged.filter((entry, index) => entry.pinned || index < RECENT_PROJECT_CAP);
  return next;
}

/**
 * Adds local projects to the recents in the given order, without evicting
 * anything, so first-run setup can never cause a project the user already had
 * listed (local or remote) to be dropped, now or later:
 * - When the list with the new projects still fits within the cap, the new
 *   projects go to the front.
 * - When it would not, they go after the projects already listed, so the
 *   positional trim of a later open (`upsertRecentProject`) drops the newest
 *   additions first and never the user's earlier projects. The list may exceed
 *   the cap until then.
 * A picked project that is already listed keeps its place in the overflow
 * case. Leaves `lastProjectRoot` alone.
 */
export function addRecentProjectsWithoutEviction(
  state: GlobalState,
  projects: ReadonlyArray<{ rootPath: string; displayName: string }>,
): GlobalState {
  if (projects.length === 0) return state;
  const prev = state.recentProjects ?? [];
  const now = new Date().toISOString();
  const added = new Map<string, RecentProject>();
  for (const proj of projects) {
    const key = recentProjectKey(proj);
    if (!added.has(key)) added.set(key, recentProjectEntry(proj, prev, now));
  }
  const kept = prev.filter((p) => !added.has(recentProjectKey(p)));
  if (kept.length + added.size <= RECENT_PROJECT_CAP) {
    return { ...state, recentProjects: [...added.values(), ...kept] };
  }
  const updatedInPlace = prev.map((p) => added.get(recentProjectKey(p)) ?? p);
  const prevKeys = new Set(prev.map(recentProjectKey));
  const appended = [...added].filter(([key]) => !prevKeys.has(key)).map(([, entry]) => entry);
  return { ...state, recentProjects: [...updatedInPlace, ...appended] };
}

export function setRecentProjectPinned(
  state: GlobalState,
  key: string,
  pinned: boolean,
): GlobalState {
  const prev = state.recentProjects ?? [];
  const nextProjects = prev.map((p) =>
    recentProjectKey(p) === key ? { ...p, pinned } : p,
  );
  return { ...state, recentProjects: nextProjects };
}

export function reorderRecentProjects(
  state: GlobalState,
  orderedKeys: string[]
): GlobalState {
  const prev = state.recentProjects ?? [];
  const byKey = new Map(prev.map((p) => [recentProjectKey(p), p]));
  const reordered: RecentProject[] = [];
  for (const key of orderedKeys) {
    const entry = byKey.get(key);
    if (entry) {
      reordered.push(entry);
      byKey.delete(key);
    }
  }
  // Append any entries not in the new order (shouldn't happen, but be safe).
  for (const entry of byKey.values()) {
    reordered.push(entry);
  }
  return { ...state, recentProjects: reordered };
}

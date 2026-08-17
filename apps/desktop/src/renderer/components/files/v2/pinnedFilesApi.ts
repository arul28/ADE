import type { OpenProjectBinding } from "../../../../shared/types/core";
import type {
  FileContent,
  FileTreeNode,
  FilesGitStatusEvent,
  FilesListTreeArgs,
  FilesListTreeChildrenArgs,
  FilesListTreeChildrenResult,
  FilesListWorkspacesArgs,
  FilesQuickOpenItem,
  FilesReadFileRangeResult,
  FilesWorkspace,
  WriteTextAtomicArgs,
} from "../../../../shared/types";

/**
 * The Files API with a machine already bound to it.
 *
 * Coverage matters more than it looks: a Files workspace id IS the lane id, and
 * lane rows sync across machines, so the same id resolves on BOTH. An unpinned
 * write while pinned elsewhere does not fail — it silently writes to this
 * machine's worktree for that lane. Every read and write the editor performs has
 * to come through here.
 *
 * Every `window.ade.files.*` call takes the machine as a second argument. Passing
 * it at each of a dozen call sites forced the pin to be read from a ref, because
 * the callers are memoized on workspace identity and listing the pin as a
 * dependency would make the file watcher tear down and re-subscribe on unrelated
 * renders. That ref then lied: a callback built before the pin arrived kept
 * reading the current value, so a subscribe could happen on one machine and its
 * cleanup fire against another — leaving a chokidar watcher running on a remote
 * host with nothing left to stop it.
 *
 * Binding the machine once, here, makes the dependency honest instead. The
 * object's identity changes exactly when the machine does, so effects that hold
 * it re-run — a watcher unsubscribes from the machine it subscribed to, and only
 * then subscribes to the new one.
 */
export type PinnedFilesApi = {
  listWorkspaces: (args?: FilesListWorkspacesArgs) => Promise<FilesWorkspace[]>;
  listTree: (args: FilesListTreeArgs) => Promise<FileTreeNode[]>;
  listTreeChildren: (args: FilesListTreeChildrenArgs) => Promise<FilesListTreeChildrenResult>;
  refreshGitDecorations: (args: { workspaceId: string; forceFresh?: boolean }) => Promise<FilesGitStatusEvent | null>;
  readFile: (args: { workspaceId: string; path: string }) => Promise<FileContent>;
  readFileRange: (args: {
    workspaceId: string;
    path: string;
    offset: number;
    length: number;
  }) => Promise<FilesReadFileRangeResult>;
  writeText: (args: { workspaceId: string; path: string; text: string }) => Promise<void>;
  writeTextAtomic: (args: WriteTextAtomicArgs) => Promise<void>;
  quickOpen: (args: {
    workspaceId: string;
    query: string;
    limit: number;
    includeIgnored: boolean;
  }) => Promise<FilesQuickOpenItem[]>;
  createFile: (args: { workspaceId: string; path: string }) => Promise<void>;
  createDirectory: (args: { workspaceId: string; path: string }) => Promise<void>;
  rename: (args: { workspaceId: string; oldPath: string; newPath: string }) => Promise<void>;
  delete: (args: { workspaceId: string; path: string }) => Promise<void>;
  watchChanges: (args: { workspaceId: string; includeIgnored?: boolean }) => Promise<void>;
  stopWatching: (args: { workspaceId: string; includeIgnored?: boolean }) => Promise<void>;
};

/**
 * `pin` of `null` means "the machine this project tab is bound to" — the
 * unpinned path, byte-for-byte what every caller did before pins existed.
 */
/**
 * Cached per machine so the returned object is referentially stable.
 *
 * The API is a pure function of the pin, and consumers put it in effect
 * dependency arrays — that is the whole point of binding the machine here. A
 * fresh object per call would make those effects re-run on every render, which
 * for `useFileContent` is an infinite loop rather than merely wasteful. The
 * cache is keyed by binding key and is at most one entry per machine ever
 * pinned in this window.
 *
 * `window.ade.files` is read inside each method rather than captured, so an api
 * built before the preload bridge is installed still works.
 */
const apiByPinKey = new Map<string, PinnedFilesApi>();

export function createPinnedFilesApi(pin: OpenProjectBinding | null): PinnedFilesApi {
  const cacheKey = pin?.key ?? "";
  const cached = apiByPinKey.get(cacheKey);
  if (cached) return cached;
  const api: PinnedFilesApi = {
    listWorkspaces: (args = {}) => window.ade.files.listWorkspaces(args, pin),
    listTree: (args) => window.ade.files.listTree(args, pin),
    listTreeChildren: (args) => window.ade.files.listTreeChildren(args, pin),
    refreshGitDecorations: (args) => window.ade.files.refreshGitDecorations(args, pin),
    readFile: (args) => window.ade.files.readFile(args, pin),
    readFileRange: (args) => window.ade.files.readFileRange(args, pin),
    writeText: (args) => window.ade.files.writeText(args, pin),
    writeTextAtomic: (args) => window.ade.files.writeTextAtomic(args, pin),
    quickOpen: (args) => window.ade.files.quickOpen(args, pin),
    createFile: (args) => window.ade.files.createFile(args, pin),
    createDirectory: (args) => window.ade.files.createDirectory(args, pin),
    rename: (args) => window.ade.files.rename(args, pin),
    delete: (args) => window.ade.files.delete(args, pin),
    watchChanges: (args) => window.ade.files.watchChanges(args, pin),
    stopWatching: (args) => window.ade.files.stopWatching(args, pin),
  };
  apiByPinKey.set(cacheKey, api);
  return api;
}

/** Test seam: drop cached bindings so a fresh preload mock is picked up. */
export function resetPinnedFilesApiForTests(): void {
  apiByPinKey.clear();
}

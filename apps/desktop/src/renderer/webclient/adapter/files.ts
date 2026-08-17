import type { FileChangeEvent, FileContent, FilesReadFileRangeResult, FilesWorkspace } from "../../../shared/types";
import type { SupportedFileAction } from "../sync";
import type { AdapterInfra, AdeNamespace } from "./types";
import { stableCacheKey } from "./infra/cacheKey";
import { createCoalescingReadCache } from "./infra/coalescingReadCache";
import { fileContentFromBlob, requestFileBlob } from "./infra/fileBlob";
import { assertWebRuntimePinRoutable } from "./runtimePinGuard";

export function createFilesNamespace(infra: AdapterInfra): AdeNamespace<"files"> {
  const { client, events, state } = infra;
  const knownWorkspaceIdsByProject = new Map<string, Set<string>>();
  const HOT_FILE_READ_TTL_MS = 3_000;
  const readCache = createCoalescingReadCache(HOT_FILE_READ_TTL_MS);
  const KEY_SEPARATOR = "\u0000";

  function clearReadCache(): void {
    readCache.clear();
  }

  // Read-cache keys carry their scope in dedicated segments so eviction can match
  // project/action/workspace/path exactly instead of substring-matching the
  // serialized args.
  function readCacheKey(action: string, args: Record<string, unknown>): string {
    const scopePath = args.parentPath ?? args.path;
    return [
      state.getProjectId() ?? "missing-project",
      action,
      stringField(args, "workspaceId"),
      typeof scopePath === "string" ? scopePath : "",
      stableCacheKey(args),
    ].join(KEY_SEPARATOR);
  }

  function parsedReadCacheKey(key: string): { action: string; workspaceId: string; path: string } | null {
    const parts = key.split(KEY_SEPARATOR);
    if (parts.length < 5) return null;
    return { action: parts[1]!, workspaceId: parts[2]!, path: parts[3]! };
  }

  /**
   * Drop only the cached listings a write can invalidate: the workspace roster
   * is unaffected by file writes, and a directory listing only changes when the
   * write lands at or under it. Clearing the whole cache made every save re-list
   * the tree and re-resolve workspaces on the next read.
   */
  function evictReadsForWrite(args: unknown, changedPaths: string[]): void {
    const record = asRecord(args);
    const workspaceId = stringField(record, "workspaceId");
    if (!workspaceId) {
      clearReadCache();
      return;
    }
    const changed = changedPaths.filter(Boolean);
    const parents = changed.map(parentDirectoryPath);
    readCache.invalidate((key) => {
      const parsed = parsedReadCacheKey(key);
      if (!parsed) return true;
      if (parsed.workspaceId !== workspaceId) return false;
      if (parsed.action === "listWorkspaces") return false;
      if (parsed.action === "listTreeChildren") {
        // Ancestor listings show the changed entry itself; descendant listings
        // are stale wholesale when a directory is renamed or removed.
        return parents.some((parent) => isAtOrUnder(parent, parsed.path))
          || changed.some((changedPath) => isAtOrUnder(parsed.path, changedPath));
      }
      return true;
    });
  }

  function rememberWorkspaceId(workspaceId: string): void {
    if (!workspaceId) return;
    const projectKey = state.getProjectId() ?? "missing-project";
    const known = knownWorkspaceIdsByProject.get(projectKey) ?? new Set<string>();
    known.add(workspaceId);
    knownWorkspaceIdsByProject.set(projectKey, known);
  }

  // The host answers file_request with a structured `result`: an array/object for
  // listing/search/range actions, and a SyncFileBlob ONLY for readFile/readArtifact.
  // The sync client resolves requestFile() with that `result` directly, so return
  // it as-is. (The earlier code treated every result as a blob and JSON.parsed a
  // `content` field, which silently emptied listWorkspaces/listTree and crashed the
  // Files tab downstream on undefined paths.)
  async function requestResult<T>(
    action: SupportedFileAction,
    args: unknown,
    fallback: T,
    options: { cache?: boolean; surfaceErrors?: boolean } = {},
  ): Promise<T> {
    const projectId = state.getProjectId();
    const cacheKey = options.cache ? readCacheKey(action, asRecord(args)) : null;
    const fetchResult = async (): Promise<T> => {
      try {
        const result = await client.requestFile(action, asRecord(args) as never, {
          projectId,
        });
        return (result ?? fallback) as T;
      } catch (error) {
        if (options.surfaceErrors) throw error;
        return fallback;
      }
    };

    return cacheKey
      ? await readCache.coalesce(cacheKey, fetchResult)
      : await fetchResult();
  }

  // Write failures must reach the caller. Swallowing them let the Files
  // workbench mark a tab saved for bytes that never left the browser.
  async function requestVoid(action: SupportedFileAction, args: unknown, event?: FileChangeEvent): Promise<void> {
    await requestFileBlob(client, state, action, asRecord(args));
    evictReadsForWrite(args, event ? [event.path, event.oldPath ?? ""] : []);
    if (event) events.emit("filesChanged", event);
  }

  infra.addDispose(
    events.on("filesInvalidated", (event) => {
      clearReadCache();
      const projectKey = state.getProjectId() ?? "missing-project";
      const workspaceIds = knownWorkspaceIdsByProject.get(projectKey) ?? new Set(["*"]);
      for (const workspaceId of workspaceIds) {
        events.emit("filesChanged", {
          workspaceId,
          type: "modified",
          path: "",
          ts: event.at,
        });
      }
    })
  );

  // Every pinned member of the Electron `files.*` contract routes through this:
  // the web adapter speaks to one machine, so a pin naming another must fail
  // loudly instead of reading or writing the wrong machine's files.
  function guardPin(operation: string, pin: unknown): void {
    assertWebRuntimePinRoutable(`files.${operation}`, pin, infra);
  }

  const files: Record<string, unknown> = {
    writeTextAtomic: async (args: unknown, pin?: unknown) => {
      guardPin("writeTextAtomic", pin);
      await requestVoid("writeText", args, changeEvent(args, "modified"));
    },
    listWorkspaces: async (args?: unknown, pin?: unknown) => {
      guardPin("listWorkspaces", pin);
      const workspaces = await requestResult<FilesWorkspace[]>(
        "listWorkspaces",
        args,
        [],
        { cache: true, surfaceErrors: true },
      );
      for (const workspace of workspaces) rememberWorkspaceId(workspace.id);
      return workspaces;
    },
    listTree: async (args: unknown, pin?: unknown) => {
      guardPin("listTree", pin);
      rememberWorkspaceId(stringField(asRecord(args), "workspaceId"));
      return await requestResult("listTree", args, [], { cache: true, surfaceErrors: true });
    },
    listTreeChildren: async (args: unknown, pin?: unknown) => {
      guardPin("listTreeChildren", pin);
      rememberWorkspaceId(stringField(asRecord(args), "workspaceId"));
      return await requestResult("listTreeChildren", args, {
        parentPath: stringField(asRecord(args), "parentPath"),
        children: [],
        offset: numberField(asRecord(args), "offset") ?? 0,
        limit: numberField(asRecord(args), "limit") ?? 500,
        total: 0,
        nextOffset: null,
      }, { cache: true, surfaceErrors: true });
    },
    refreshGitDecorations: async (args: unknown, pin?: unknown) => {
      guardPin("refreshGitDecorations", pin);
      const result = await requestResult("refreshGitDecorations", args, {
        workspaceId: stringField(asRecord(args), "workspaceId"),
        files: [],
        directories: [],
      });
      events.emit("filesGitStatus", result);
      return result;
    },
    openExternalPath: async (args: unknown) => ({
      workspace: stringField(asRecord(args), "workspaceId"),
      openPath: stringField(asRecord(args), "path"),
      pathType: "file",
      ok: false,
      error: "unsupported",
    }),
    // Rejects on a transport failure, exactly as the desktop host's `readFile`
    // does. Answering a dropped relay call with empty content made a failure
    // indistinguishable from a genuinely empty file: callers cached the "" and
    // rendered a blank editor over a file that was fine on disk.
    readFile: async (args: unknown, pin?: unknown): Promise<FileContent> => {
      guardPin("readFile", pin);
      return fileContentFromBlob(await requestFileBlob(client, state, "readFile", asRecord(args)));
    },
    readFileRange: async (args: unknown, pin?: unknown): Promise<FilesReadFileRangeResult> => {
      guardPin("readFileRange", pin);
      const record = asRecord(args);
      return await requestResult("readFileRange", args, {
        path: stringField(record, "path"),
        encoding: "utf-8",
        content: "",
        rangeStart: numberField(record, "offset") ?? 0,
        rangeEnd: numberField(record, "offset") ?? 0,
        nextOffset: null,
        totalSize: 0,
        eof: true,
      });
    },
    gitBlame: async (args: unknown, pin?: unknown) => {
      guardPin("gitBlame", pin);
      return await requestResult("gitBlame", args, { path: stringField(asRecord(args), "path"), lines: [] });
    },
    writeText: async (args: unknown, pin?: unknown) => {
      guardPin("writeText", pin);
      await requestVoid("writeText", args, changeEvent(args, "modified"));
    },
    createFile: async (args: unknown, pin?: unknown) => {
      guardPin("createFile", pin);
      await requestVoid("createFile", args, changeEvent(args, "created"));
    },
    createDirectory: async (args: unknown, pin?: unknown) => {
      guardPin("createDirectory", pin);
      await requestVoid("createDirectory", args, changeEvent(args, "created"));
    },
    rename: async (args: unknown, pin?: unknown) => {
      guardPin("rename", pin);
      const record = asRecord(args);
      await requestVoid("rename", args, {
        workspaceId: stringField(record, "workspaceId"),
        type: "renamed",
        path: stringField(record, "newPath"),
        oldPath: stringField(record, "oldPath"),
        ts: new Date().toISOString(),
        origin: "self",
      });
    },
    delete: async (args: unknown, pin?: unknown) => {
      guardPin("delete", pin);
      await requestVoid("deletePath", args, changeEvent(args, "deleted"));
    },
    watchChanges: async (_args?: unknown, pin?: unknown) => {
      guardPin("watchChanges", pin);
      return undefined;
    },
    stopWatching: async (_args?: unknown, pin?: unknown) => {
      guardPin("stopWatching", pin);
      return undefined;
    },
    quickOpen: async (args: unknown, pin?: unknown) => {
      guardPin("quickOpen", pin);
      return await requestResult("quickOpen", args, []);
    },
    searchText: async (args: unknown, pin?: unknown) => {
      guardPin("searchText", pin);
      return await requestResult("searchText", args, []);
    },
    onChange: (listener: (event: unknown) => void) => events.on("filesChanged", listener as never),
  };
  return files as AdeNamespace<"files">;
}

function asRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" ? (args as Record<string, unknown>) : {};
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function changeEvent(args: unknown, type: FileChangeEvent["type"]): FileChangeEvent {
  const record = asRecord(args);
  return {
    workspaceId: stringField(record, "workspaceId"),
    type,
    path: stringField(record, "path"),
    ts: new Date().toISOString(),
    origin: "self",
  };
}

/** `""` for a root-level entry, otherwise the containing directory. */
function parentDirectoryPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "" : normalized.slice(0, index);
}

function isAtOrUnder(path: string, directory: string): boolean {
  if (!directory) return true;
  return path === directory || path.startsWith(`${directory}/`);
}

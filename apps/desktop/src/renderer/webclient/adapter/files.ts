import type { FileChangeEvent, FileContent, FilesReadFileRangeResult, FilesWorkspace } from "../../../shared/types";
import type { SupportedFileAction } from "../sync";
import type { AdapterInfra, AdeNamespace } from "./types";
import { stableCacheKey } from "./infra/cacheKey";
import { fileContentFromBlob, requestFileBlob } from "./infra/fileBlob";

export function createFilesNamespace(infra: AdapterInfra): AdeNamespace<"files"> {
  const { client, events, state } = infra;
  const readCache = new Map<string, { expiresAt: number; promise: Promise<unknown> }>();
  const knownWorkspaceIdsByProject = new Map<string, Set<string>>();
  const HOT_FILE_READ_TTL_MS = 3_000;

  function clearReadCache(): void {
    readCache.clear();
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
    const cacheKey = options.cache
      ? `${projectId ?? "missing-project"}\u0000${action}\u0000${stableCacheKey(asRecord(args))}`
      : null;
    if (cacheKey) {
      const cached = readCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) return await cached.promise as T;
      if (cached) readCache.delete(cacheKey);
    }

    const request = (async () => {
      try {
        const result = await client.requestFile(action, asRecord(args) as never, {
          projectId,
        });
        return (result ?? fallback) as T;
      } catch (error) {
        if (options.surfaceErrors) throw error;
        return fallback;
      }
    })();

    if (cacheKey) {
      const entry = {
        expiresAt: Number.POSITIVE_INFINITY,
        promise: request as Promise<unknown>,
      };
      readCache.set(cacheKey, entry);
      void request.then(
        () => {
          if (readCache.get(cacheKey) === entry) {
            entry.expiresAt = Date.now() + HOT_FILE_READ_TTL_MS;
          }
        },
        () => {
          if (readCache.get(cacheKey) === entry) readCache.delete(cacheKey);
        },
      );
    }
    return await request;
  }

  async function requestVoid(action: SupportedFileAction, args: unknown, event?: FileChangeEvent): Promise<void> {
    try {
      await requestFileBlob(client, state, action, asRecord(args));
    } catch {
      return;
    }
    clearReadCache();
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

  const files: Record<string, unknown> = {
    writeTextAtomic: async (args: unknown) => {
      await requestVoid("writeText", args, changeEvent(args, "modified"));
    },
    listWorkspaces: async (args?: unknown) => {
      const workspaces = await requestResult<FilesWorkspace[]>(
        "listWorkspaces",
        args,
        [],
        { cache: true, surfaceErrors: true },
      );
      for (const workspace of workspaces) rememberWorkspaceId(workspace.id);
      return workspaces;
    },
    listTree: (args: unknown) => {
      rememberWorkspaceId(stringField(asRecord(args), "workspaceId"));
      return requestResult("listTree", args, [], { cache: true, surfaceErrors: true });
    },
    listTreeChildren: (args: unknown) => {
      rememberWorkspaceId(stringField(asRecord(args), "workspaceId"));
      return requestResult("listTreeChildren", args, {
        parentPath: stringField(asRecord(args), "parentPath"),
        children: [],
        offset: numberField(asRecord(args), "offset") ?? 0,
        limit: numberField(asRecord(args), "limit") ?? 500,
        total: 0,
        nextOffset: null,
      }, { cache: true, surfaceErrors: true });
    },
    refreshGitDecorations: async (args: unknown) => {
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
    readFile: async (args: unknown): Promise<FileContent> => {
      try {
        return fileContentFromBlob(await requestFileBlob(client, state, "readFile", asRecord(args)));
      } catch {
        return {
          content: "",
          encoding: "utf-8",
          size: 0,
          languageId: "plaintext",
          isBinary: false,
          totalSize: 0,
        };
      }
    },
    readFileRange: (args: unknown): Promise<FilesReadFileRangeResult> => {
      const record = asRecord(args);
      return requestResult("readFileRange", args, {
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
    gitBlame: (args: unknown) => requestResult("gitBlame", args, { path: stringField(asRecord(args), "path"), lines: [] }),
    writeText: async (args: unknown) => {
      await requestVoid("writeText", args, changeEvent(args, "modified"));
    },
    createFile: async (args: unknown) => {
      await requestVoid("createFile", args, changeEvent(args, "created"));
    },
    createDirectory: async (args: unknown) => {
      await requestVoid("createDirectory", args, changeEvent(args, "created"));
    },
    rename: async (args: unknown) => {
      const record = asRecord(args);
      await requestVoid("rename", args, {
        workspaceId: stringField(record, "workspaceId"),
        type: "renamed",
        path: stringField(record, "newPath"),
        oldPath: stringField(record, "oldPath"),
        ts: new Date().toISOString(),
      });
    },
    delete: async (args: unknown) => {
      await requestVoid("deletePath", args, changeEvent(args, "deleted"));
    },
    watchChanges: async () => undefined,
    stopWatching: async () => undefined,
    quickOpen: (args: unknown) => requestResult("quickOpen", args, []),
    searchText: (args: unknown) => requestResult("searchText", args, []),
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
  };
}

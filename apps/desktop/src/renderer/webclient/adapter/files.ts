import type { FileChangeEvent, FileContent, FilesReadFileRangeResult } from "../../../shared/types";
import type { SupportedFileAction } from "../sync";
import type { AdapterInfra, AdeNamespace } from "./types";
import { fileContentFromBlob, requestFileBlob } from "./infra/fileBlob";

export function createFilesNamespace(infra: AdapterInfra): AdeNamespace<"files"> {
  const { client, events, state } = infra;

  async function requestJson<T>(action: SupportedFileAction, args: unknown, fallback: T): Promise<T> {
    try {
      const blob = await requestFileBlob(client, state, action, asRecord(args));
      if (!blob.content) return fallback;
      return JSON.parse(blob.content) as T;
    } catch {
      return fallback;
    }
  }

  async function requestVoid(action: SupportedFileAction, args: unknown, event?: FileChangeEvent): Promise<void> {
    try {
      await requestFileBlob(client, state, action, asRecord(args));
    } catch {
      return;
    }
    if (event) events.emit("filesChanged", event);
  }

  infra.addDispose(
    events.on("filesInvalidated", (event) => {
      events.emit("filesChanged", {
        workspaceId: "*",
        type: "modified",
        path: "",
        ts: event.at,
      });
    })
  );

  const files: Record<string, unknown> = {
    writeTextAtomic: async (args: unknown) => {
      await requestVoid("writeText", args, changeEvent(args, "modified"));
    },
    listWorkspaces: (args?: unknown) => requestJson("listWorkspaces", args, []),
    listTree: (args: unknown) => requestJson("listTree", args, []),
    listTreeChildren: (args: unknown) =>
      requestJson("listTreeChildren", args, {
        parentPath: stringField(asRecord(args), "parentPath"),
        children: [],
        offset: numberField(asRecord(args), "offset") ?? 0,
        limit: numberField(asRecord(args), "limit") ?? 500,
        total: 0,
        nextOffset: null,
      }),
    refreshGitDecorations: async (args: unknown) => {
      const result = await requestJson("refreshGitDecorations", args, {
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
    readFileRange: async (args: unknown): Promise<FilesReadFileRangeResult> => {
      try {
        return JSON.parse((await requestFileBlob(client, state, "readFileRange", asRecord(args))).content);
      } catch {
        const record = asRecord(args);
        return {
          path: stringField(record, "path"),
          encoding: "utf-8",
          content: "",
          rangeStart: numberField(record, "offset") ?? 0,
          rangeEnd: numberField(record, "offset") ?? 0,
          nextOffset: null,
          totalSize: 0,
          eof: true,
        };
      }
    },
    gitBlame: (args: unknown) => requestJson("gitBlame", args, { path: stringField(asRecord(args), "path"), lines: [] }),
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
    quickOpen: (args: unknown) => requestJson("quickOpen", args, []),
    searchText: (args: unknown) => requestJson("searchText", args, []),
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

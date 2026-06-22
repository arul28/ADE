import fs, { promises as fsp } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type {
  FilesOpenExternalPathArgs,
  FilesOpenExternalPathResult,
  FilesWorkspace,
} from "../../../shared/types";
import { EXTERNAL_FILES_WORKSPACE_ID_PREFIX as EXTERNAL_WORKSPACE_PREFIX } from "../../../shared/types/files";
import { normalizeRelative } from "../shared/utils";

export type ExternalFilesWorkspaceRegistry = {
  list: () => FilesWorkspace[];
  resolve: (workspaceId: string) => FilesWorkspace | null;
  openPath: (args: FilesOpenExternalPathArgs) => Promise<FilesOpenExternalPathResult>;
  isExternalWorkspaceId: (workspaceId: string) => boolean;
  isRegisteredRoot: (rootPath: string) => boolean;
};

function externalWorkspaceIdForRoot(rootPath: string): string {
  const hash = createHash("sha256").update(rootPath).digest("hex").slice(0, 16);
  return `${EXTERNAL_WORKSPACE_PREFIX}${hash}`;
}

export function createExternalFilesWorkspaceRegistry(maxWorkspaces = 100): ExternalFilesWorkspaceRegistry {
  const workspaces = new Map<string, FilesWorkspace>();

  const touchWorkspace = (workspace: FilesWorkspace): FilesWorkspace => {
    workspaces.delete(workspace.id);
    workspaces.set(workspace.id, workspace);
    while (workspaces.size > maxWorkspaces) {
      const oldest = workspaces.keys().next().value;
      if (!oldest) break;
      workspaces.delete(oldest);
    }
    return workspace;
  };

  return {
    list: () => Array.from(workspaces.values()),
    resolve: (workspaceId: string) => workspaces.get(workspaceId) ?? null,
    isExternalWorkspaceId: (workspaceId: string) => workspaceId.startsWith(EXTERNAL_WORKSPACE_PREFIX),
    isRegisteredRoot: (rootPath: string) => {
      try {
        const realRootPath = fs.realpathSync.native(path.resolve(rootPath));
        return Array.from(workspaces.values()).some((workspace) => workspace.rootPath === realRootPath);
      } catch {
        return false;
      }
    },
    openPath: async (args: FilesOpenExternalPathArgs): Promise<FilesOpenExternalPathResult> => {
      const requestedPath = args.path.trim();
      if (!requestedPath || requestedPath.includes("\0")) {
        throw new Error("Invalid external path.");
      }
      if (!path.isAbsolute(requestedPath)) {
        throw new Error("External path must be absolute.");
      }

      const realPath = await fsp.realpath(requestedPath);
      const stat = await fsp.stat(realPath);
      if (!stat.isFile() && !stat.isDirectory()) {
        throw new Error("External path must be a file or directory.");
      }

      const rootPath = stat.isDirectory() ? realPath : path.dirname(realPath);
      const id = externalWorkspaceIdForRoot(rootPath);
      const workspace = touchWorkspace({
        id,
        kind: "external",
        laneId: null,
        name: `${path.basename(rootPath) || rootPath} (External)`,
        rootPath,
        isReadOnlyByDefault: false,
        mobileReadOnly: true,
      });

      return {
        workspace,
        openPath: stat.isFile() ? normalizeRelative(path.relative(rootPath, realPath)) : null,
        pathType: stat.isDirectory() ? "directory" : "file",
      };
    },
  };
}

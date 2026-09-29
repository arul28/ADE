import path from "node:path";
import type { createFileService } from "../../../../desktop/src/main/services/files/fileService";
import { toOptionalString } from "../../../../desktop/src/main/services/shared/utils";
import type {
  FileContent,
  FilesWorkspace,
  SyncFileBlob,
  SyncFileRequest,
} from "../../../../desktop/src/shared/types";

// One project's `file_request` handling, with no sync-host state: the host
// runs it for its own project, and the brain runs it for a request that names
// another open project on the machine (a phone reading a lane of that
// checkout). Artifact reads stay with the host, which owns the artifacts.

export function syncFileRequestWorkspaceId(payload: SyncFileRequest): string | null {
  switch (payload.action) {
    case "listTree":
    case "listTreeChildren":
    case "refreshGitDecorations":
    case "readFile":
    case "readFileRange":
    case "gitBlame":
    case "writeText":
    case "createFile":
    case "createDirectory":
    case "rename":
    case "deletePath":
    case "watchChanges":
    case "stopWatching":
    case "quickOpen":
    case "searchText":
      return toOptionalString(payload.args.workspaceId);
    case "listWorkspaces":
    case "readArtifact":
    case "readArtifactRange":
      return null;
    default:
      return null;
  }
}

export function visibleFileWorkspacesForPeer(workspaces: FilesWorkspace[], opts: { isMobile: boolean }): FilesWorkspace[] {
  return opts.isMobile ? workspaces.filter((workspace) => workspace.kind !== "external") : workspaces;
}

export function assertFileRequestWorkspaceVisibleToPeer(args: {
  isMobile: boolean;
  workspace: FilesWorkspace | null;
}): void {
  if (args.isMobile && args.workspace?.kind === "external") {
    throw new Error("External local files are not available on mobile.");
  }
}

/**
 * Runs one `file_request` against a project's file service: every action but
 * the artifact reads, which belong to the sync host's own project. The host
 * uses it for its project; the brain uses it for a request that names another
 * open project (a phone reading a lane of this machine's other checkout).
 */
export async function runSyncFileServiceRequest(
  fileService: ReturnType<typeof createFileService>,
  payload: SyncFileRequest,
  opts: { isMobile: boolean },
): Promise<unknown> {
  if (opts.isMobile) {
    const workspaceId = syncFileRequestWorkspaceId(payload);
    assertFileRequestWorkspaceVisibleToPeer({
      isMobile: true,
      workspace: workspaceId
        ? fileService.listWorkspaces({ includeArchived: true }).find((entry) => entry.id === workspaceId) ?? null
        : null,
    });
  }
  switch (payload.action) {
    case "listWorkspaces":
      return visibleFileWorkspacesForPeer(fileService.listWorkspaces(payload.args ?? {}), { isMobile: opts.isMobile });
    case "listTree":
      return await fileService.listTree(payload.args);
    case "listTreeChildren":
      return await fileService.listTreeChildren(payload.args);
    case "refreshGitDecorations":
      return await fileService.refreshGitDecorations(payload.args);
    case "readFile":
      return fileContentToBlob(payload.args.path, await fileService.readFile(payload.args));
    case "readFileRange":
      return await fileService.readFileRange(payload.args);
    case "gitBlame":
      return await fileService.blame(payload.args);
    case "writeText":
      fileService.writeWorkspaceText(payload.args);
      return { ok: true };
    case "createFile":
      fileService.createFile(payload.args);
      return { ok: true };
    case "createDirectory":
      fileService.createDirectory(payload.args);
      return { ok: true };
    case "rename":
      fileService.rename(payload.args);
      return { ok: true };
    case "deletePath":
      fileService.deletePath(payload.args);
      return { ok: true };
    case "quickOpen":
      return await fileService.quickOpen(payload.args);
    case "searchText":
      return await fileService.searchText(payload.args);
    default:
      throw new Error(`Unsupported file action: ${(payload as { action?: string }).action ?? "unknown"}`);
  }
}

export function inferMimeType(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".mp4":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".zip":
      return "application/zip";
    case ".json":
      return "application/json";
    case ".md":
      return "text/markdown";
    case ".txt":
    case ".log":
      return "text/plain";
    case ".yaml":
    case ".yml":
      return "application/yaml";
    default:
      return null;
  }
}

export function fileContentToBlob(filePath: string, content: FileContent): SyncFileBlob {
  return {
    path: filePath,
    size: content.size,
    mimeType: content.mimeType ?? inferMimeType(filePath),
    encoding: content.encoding,
    isBinary: content.isBinary,
    content: content.content,
    languageId: content.languageId,
    ...(content.previewKind ? { previewKind: content.previewKind } : {}),
    ...(content.dataUrl ? { dataUrl: content.dataUrl } : {}),
    ...(typeof content.contentOmitted === "boolean" ? { contentOmitted: content.contentOmitted } : {}),
    ...(content.omittedReason ? { omittedReason: content.omittedReason } : {}),
    // Forwarded so a mobile client can say WHY only part of a large file
    // arrived. Without these the phone shows a prefix with no explanation.
    ...(typeof content.isPartial === "boolean" ? { isPartial: content.isPartial } : {}),
    ...(typeof content.totalSize === "number" ? { totalSize: content.totalSize } : {}),
  };
}

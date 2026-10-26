import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readArtifactByteRange } from "../../../../desktop/src/main/services/computerUse/artifactByteRange";
import type { createFileService } from "../../../../desktop/src/main/services/files/fileService";
import { hasNullByte, normalizeRelative, resolvePathWithinRoot, toOptionalString } from "../../../../desktop/src/main/services/shared/utils";
import { CURSOR_CLOUD_ARTIFACT_MAX_BYTES } from "../../../../desktop/src/shared/cursorCloudArtifactLimits";
import type {
  FileContent,
  FilesWorkspace,
  SyncArtifactRange,
  SyncFileBlob,
  SyncFileRequest,
} from "../../../../desktop/src/shared/types";

// One project's `file_request` handling, with no sync-host state: the host
// runs it for its own project, and the brain runs it for a request that names
// another open project on the machine (a phone reading a lane of that
// checkout, or the proof of a chat in it).

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
 * Runs one `file_request` against a project: its file service, and its proof
 * files through `opts.artifacts`. The host uses it for its project; the brain
 * uses it for a request that names another open project (a phone reading a
 * lane of this machine's other checkout, or the proof of a chat there).
 */
export async function runSyncFileServiceRequest(
  fileService: ReturnType<typeof createFileService>,
  payload: SyncFileRequest,
  opts: { isMobile: boolean; artifacts?: SyncArtifactReads },
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
    case "readArtifact":
      if (opts.artifacts) return await opts.artifacts.readArtifact(payload.args);
      break;
    case "readArtifactRange":
      if (opts.artifacts) return await opts.artifacts.readArtifactRange(payload.args);
      break;
    default:
      break;
  }
  throw new Error(`Unsupported file action: ${(payload as { action?: string }).action ?? "unknown"}`);
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

/** The largest proof file one whole-file `readArtifact` returns; larger ones are read in slices. */
const MAX_SYNC_ARTIFACT_BYTES = CURSOR_CLOUD_ARTIFACT_MAX_BYTES;

function createBlobFromBuffer(filePath: string, buf: Buffer): SyncFileBlob {
  const mimeType = inferMimeType(filePath);
  // An image is binary whatever its first 8 KiB holds: the NUL scan is only a guess
  // about the bytes, and the type is known. Read as UTF-8 an image has no data URL.
  const isBinary = hasNullByte(buf) || mimeType?.startsWith("image/") === true;
  return {
    path: filePath,
    size: buf.length,
    mimeType,
    encoding: isBinary ? "base64" : "utf-8",
    isBinary,
    content: isBinary ? buf.toString("base64") : buf.toString("utf8"),
    languageId: null,
    previewKind: isBinary ? "binary" : "text",
  };
}

/**
 * The proof-file reads of one project (`readArtifact`, `readArtifactRange`),
 * jailed to its `.ade/artifacts`. The sync host serves them for its project and
 * the brain for a request that names another open project; the brain's path
 * once had none, so a phone could not show the proof of a chat there.
 */
export type SyncArtifactReads = ReturnType<typeof createSyncArtifactReads>;

export function createSyncArtifactReads(deps: {
  projectRoot: string;
  artifactsDir: string;
  findArtifactUri: (artifactId: string) => string | null;
}) {
  function resolveArtifactPath(
    request: Extract<SyncFileRequest, { action: "readArtifact" | "readArtifactRange" }>["args"],
  ): string {
    const artifactId = toOptionalString(request.artifactId);
    const explicitUri = toOptionalString(request.uri) ?? toOptionalString(request.path);
    let candidate = explicitUri;
    if (artifactId) {
      candidate = deps.findArtifactUri(artifactId) ?? candidate;
    }
    if (!candidate) {
      throw new Error("Artifact request requires artifactId, uri, or path.");
    }
    if (/^https?:\/\//i.test(candidate)) {
      throw new Error("Remote artifact URLs are not supported by this sync host.");
    }
    // Stored URIs use the `ade-artifact://project/<relative>` form the renderer
    // and the remote-command service both understand. Without stripping the
    // scheme here the phone resolves a path that starts with "project/" and
    // every artifact read fails.
    if (/^ade-artifact:\/\/project(?:\/|$)/i.test(candidate)) {
      try {
        candidate = decodeURIComponent(new URL(candidate).pathname.replace(/^\/+/, ""));
      } catch {
        throw new Error("Artifact URI is invalid.");
      }
    }
    if (/^file:\/\//i.test(candidate)) {
      try {
        candidate = fileURLToPath(candidate);
      } catch {
        throw new Error("Artifact file URL is invalid.");
      }
    }
    const absolute = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(deps.projectRoot, candidate);
    let resolvedArtifactPath: string;
    try {
      resolvedArtifactPath = resolvePathWithinRoot(deps.artifactsDir, absolute);
    } catch {
      throw new Error("Artifact path must resolve within .ade/artifacts.");
    }
    return resolvedArtifactPath;
  }

  async function readArtifact(
    request: Extract<SyncFileRequest, { action: "readArtifact" }>["args"],
  ): Promise<SyncFileBlob> {
    const artifactPath = resolveArtifactPath(request);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(artifactPath);
    } catch {
      throw new Error("Artifact file does not exist.");
    }
    if (!stat.isFile()) {
      throw new Error("Artifact file does not exist.");
    }
    if (stat.size > MAX_SYNC_ARTIFACT_BYTES) {
      throw new Error(
        `Artifact is too large to sync (${stat.size} bytes; max ${MAX_SYNC_ARTIFACT_BYTES} bytes).`,
      );
    }
    const buffer = await fs.promises.readFile(artifactPath);
    return createBlobFromBuffer(normalizeRelative(path.relative(deps.projectRoot, artifactPath)), buffer);
  }

  /**
   * The same jail as `readArtifact`, one bounded slice at a time, so a phone
   * can play a recording larger than the whole-file cap.
   */
  async function readArtifactRange(
    request: Extract<SyncFileRequest, { action: "readArtifactRange" }>["args"],
  ): Promise<SyncArtifactRange> {
    const artifactPath = resolveArtifactPath(request);
    const range = await readArtifactByteRange(artifactPath, request.offset, request.length);
    return {
      path: normalizeRelative(path.relative(deps.projectRoot, artifactPath)),
      totalSize: range.totalSize,
      rangeStart: range.rangeStart,
      rangeEnd: range.rangeEnd,
      encoding: "base64",
      content: range.base64,
      eof: range.eof,
    };
  }

  return { readArtifact, readArtifactRange };
}

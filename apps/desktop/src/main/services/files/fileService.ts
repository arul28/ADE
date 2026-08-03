import fs, { promises as fsp } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type {
  FileChangeEvent,
  FileContent,
  FileTreeChangeStatus,
  FileTreeNode,
  FileTreeStatusEntry,
  FilesCreateDirectoryArgs,
  FilesCreateFileArgs,
  FilesDeleteArgs,
  FilesGitBlameArgs,
  FilesGitBlameLine,
  FilesGitBlameResult,
  FilesGitStatusEvent,
  FilesListTreeArgs,
  FilesListTreeChildrenArgs,
  FilesListTreeChildrenResult,
  FilesListWorkspacesArgs,
  FilesOpenExternalPathArgs,
  FilesOpenExternalPathResult,
  FilesQuickOpenArgs,
  FilesReadFileRangeArgs,
  FilesReadFileRangeResult,
  FilesRefreshGitDecorationsArgs,
  FilesQuickOpenItem,
  FilesReadFileArgs,
  FilesRenameArgs,
  FilesSearchTextArgs,
  FilesSearchTextMatch,
  FilesWatchArgs,
  FilesWorkspace,
  FilesWriteTextArgs
} from "../../../shared/types";
import type { createLaneService } from "../lanes/laneService";
import type { ExternalFilesWorkspaceRegistry } from "./externalFilesWorkspaceRegistry";
import { runGit } from "../git/git";
import {
  hasNullByte,
  normalizeRelative,
  resolvePathWithinRoot,
  secureMkdirWithinRoot,
  secureRenameWithinRoot,
  secureWriteFileWithinRoot,
  secureWriteTextAtomicWithinRoot,
} from "../shared/utils";
import { createFileWatcherService } from "./fileWatcherService";
import { createFileSearchIndexService } from "./fileSearchIndexService";
export { createExternalFilesWorkspaceRegistry, type ExternalFilesWorkspaceRegistry } from "./externalFilesWorkspaceRegistry";

export type FileServiceLaneAdapter = Pick<
  ReturnType<typeof createLaneService>,
  "getFilesWorkspaces" | "resolveWorkspaceById" | "getLaneBaseAndBranch"
>;

const MAX_EDITOR_TEXT_READ_BYTES = 1024 * 1024;
const MAX_INLINE_IMAGE_PREVIEW_BYTES = 1024 * 1024;
const MAX_INLINE_BINARY_BYTES = 256 * 1024;
const MAX_TREE_CHILDREN_PER_DIRECTORY = 1_000;
// Streaming reads: first chunk size for an oversized text file, and the hard cap
// on a single readFileRange request.
const STREAM_FIRST_CHUNK_BYTES = 256 * 1024;
const MAX_RANGE_READ_BYTES = 512 * 1024;
const DEFAULT_RANGE_READ_BYTES = 256 * 1024;
const GIT_BLAME_TIMEOUT_MS = 5_000;
const GIT_STATUS_CACHE_TTL_MS = 5_000;
const GIT_STATUS_BACKGROUND_TIMEOUT_MS = 2_000;
const GIT_STATUS_FOREGROUND_TIMEOUT_MS = 10_000;
const PAGED_DIRECTORY_ENTRIES_CACHE_TTL_MS = 2_000;
const PAGED_DIRECTORY_ENTRIES_CACHE_MAX = 32;
const VOLATILE_ADE_PREFIXES = [
  ".ade/artifacts/",
  ".ade/cache/",
  ".ade/secrets/",
  ".ade/transcripts/",
  ".ade/worktrees/",
];
const VOLATILE_ADE_FILES = new Set([
  ".ade/ade.db",
  ".ade/ade.db-shm",
  ".ade/ade.db-wal",
  ".ade/ade.sock",
  ".ade/local.secret.yaml",
]);
const TEXT_EXTENSIONS = new Set([
  ".bash",
  ".c",
  ".cc",
  ".cfg",
  ".cjs",
  ".conf",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".cts",
  ".env",
  ".fish",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".less",
  ".log",
  ".md",
  ".mdx",
  ".mjs",
  ".mts",
  ".py",
  ".rb",
  ".rs",
  ".sass",
  ".scss",
  ".sh",
  ".sql",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh",
]);
const BASE64_RANGE_EXTENSIONS = new Set([
  ".7z",
  ".bin",
  ".bz2",
  ".dat",
  ".db",
  ".dmg",
  ".gz",
  ".iso",
  ".rar",
  ".sqlite",
  ".tar",
  ".tgz",
  ".wasm",
  ".xz",
  ".zip",
  ".pdf",
  ".mp3",
  ".m4a",
  ".aac",
  ".wav",
  ".flac",
  ".ogg",
  ".oga",
  ".opus",
  ".mp4",
  ".m4v",
  ".mov",
  ".webm",
  ".ogv",
  ".avi",
  ".mkv",
  ".doc",
  ".docx",
  ".ppt",
  ".pptx",
  ".xls",
  ".xlsx",
]);

const DOCUMENT_MIME_BY_EXTENSION = new Map<string, string>([
  [".pdf", "application/pdf"],
  [".doc", "application/msword"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".ppt", "application/vnd.ms-powerpoint"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".xls", "application/vnd.ms-excel"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
]);

const AUDIO_MIME_BY_EXTENSION = new Map<string, string>([
  [".aac", "audio/aac"],
  [".flac", "audio/flac"],
  [".m4a", "audio/mp4"],
  [".mp3", "audio/mpeg"],
  [".oga", "audio/ogg"],
  [".ogg", "audio/ogg"],
  [".opus", "audio/ogg"],
  [".wav", "audio/wav"],
]);

const VIDEO_MIME_BY_EXTENSION = new Map<string, string>([
  [".avi", "video/x-msvideo"],
  [".m4v", "video/mp4"],
  [".mkv", "video/x-matroska"],
  [".mov", "video/quicktime"],
  [".mp4", "video/mp4"],
  [".ogv", "video/ogg"],
  [".webm", "video/webm"],
]);

function containsDotGit(absPath: string): boolean {
  const parts = absPath.split(path.sep);
  return parts.includes(".git");
}

function languageIdFromPath(relPath: string): string {
  const ext = path.extname(relPath).toLowerCase();
  if (isImagePath(relPath)) return "image";
  if (ext === ".ts" || ext === ".tsx") return "typescript";
  if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") return "javascript";
  if (ext === ".json") return "json";
  if (ext === ".yml" || ext === ".yaml") return "yaml";
  if (ext === ".md") return "markdown";
  if (ext === ".py") return "python";
  if (ext === ".rs") return "rust";
  if (ext === ".go") return "go";
  if (ext === ".java") return "java";
  if (ext === ".c" || ext === ".h" || ext === ".cpp" || ext === ".hpp") return "cpp";
  if (ext === ".sh" || ext === ".bash") return "shell";
  if (ext === ".css") return "css";
  if (ext === ".html") return "html";
  return "plaintext";
}

function isImagePath(relPath: string): boolean {
  return inferImageMimeType(relPath) !== null;
}

function inferImageMimeType(relPath: string): string | null {
  const ext = path.extname(relPath).toLowerCase();
  switch (ext) {
    case ".avif":
      return "image/avif";
    case ".bmp":
      return "image/bmp";
    case ".gif":
      return "image/gif";
    case ".ico":
    case ".cur":
      return "image/x-icon";
    case ".jpg":
    case ".jpeg":
    case ".jfif":
    case ".pjpeg":
    case ".pjp":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    default:
      return null;
  }
}

function inferBinaryMimeType(relPath: string): string {
  const ext = path.extname(relPath).toLowerCase();
  return (
    inferImageMimeType(relPath)
    ?? AUDIO_MIME_BY_EXTENSION.get(ext)
    ?? VIDEO_MIME_BY_EXTENSION.get(ext)
    ?? DOCUMENT_MIME_BY_EXTENSION.get(ext)
    ?? "application/octet-stream"
  );
}

function shouldReturnRangeAsBase64(relPath: string): boolean {
  return isImagePath(relPath) || BASE64_RANGE_EXTENSIONS.has(path.extname(relPath).toLowerCase());
}

function looksLikeBinary(buf: Buffer, relPath: string): boolean {
  if (hasNullByte(buf)) return true;
  if (TEXT_EXTENSIONS.has(path.extname(relPath).toLowerCase())) return false;

  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  if (sample.length === 0) return false;

  const decoded = sample.toString("utf8");
  const replacementChars = decoded.match(/\uFFFD/g)?.length ?? 0;
  if (replacementChars > 0) {
    return replacementChars / decoded.length > 0.01;
  }

  let suspiciousControlChars = 0;
  for (const byte of sample) {
    const isAllowedWhitespace = byte === 9 || byte === 10 || byte === 12 || byte === 13;
    if (byte < 32 && !isAllowedWhitespace) {
      suspiciousControlChars += 1;
    }
  }
  return suspiciousControlChars / sample.length > 0.3;
}

function isAlwaysIgnoredPath(normalized: string): boolean {
  return (
    normalized.startsWith(".git/") ||
    normalized === ".git" ||
    normalized.startsWith("node_modules/") ||
    normalized.startsWith(".ade/") ||
    normalized === ".ade"
  );
}

function isVolatileAdeRuntimePath(normalized: string): boolean {
  return VOLATILE_ADE_FILES.has(normalized)
    || VOLATILE_ADE_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix));
}

/**
 * Largest prefix length of `buf` that ends on a complete UTF-8 sequence, so a
 * range read never splits a multi-byte character across two chunks. Returns the
 * byte count to keep.
 */
function completeUtf8ByteLength(buf: Buffer): number {
  let trailing = 0;
  let i = buf.length;
  while (i > 0 && (buf[i - 1] & 0b1100_0000) === 0b1000_0000 && trailing < 3) {
    i -= 1;
    trailing += 1;
  }
  if (i === 0) return buf.length; // all continuation bytes — leave untouched
  const lead = buf[i - 1];
  let seqLen = 1;
  if ((lead & 0b1000_0000) === 0) seqLen = 1;
  else if ((lead & 0b1110_0000) === 0b1100_0000) seqLen = 2;
  else if ((lead & 0b1111_0000) === 0b1110_0000) seqLen = 3;
  else if ((lead & 0b1111_1000) === 0b1111_0000) seqLen = 4;
  const have = 1 + trailing;
  return have >= seqLen ? buf.length : i - 1;
}

async function readFilePrefix(absPath: string, maxBytes: number): Promise<Buffer> {
  const fd = await fsp.open(absPath, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    return bytesRead === buf.length ? buf : buf.subarray(0, bytesRead);
  } finally {
    await fd.close();
  }
}

function omittedFileContent(args: {
  relPath: string;
  size: number;
  encoding: "utf-8" | "base64";
  mimeType?: string | null;
  reason: FileContent["omittedReason"];
}): FileContent {
  return {
    content: "",
    encoding: args.encoding,
    size: args.size,
    languageId: languageIdFromPath(args.relPath),
    isBinary: true,
    previewKind: "binary",
    mimeType: args.mimeType ?? null,
    contentOmitted: true,
    omittedReason: args.reason,
  };
}

async function runGitCheckIgnoreBatch(args: { cwd: string; paths: string[]; timeoutMs?: number }): Promise<Set<string>> {
  if (args.paths.length === 0) return new Set<string>();
  const timeoutMs = args.timeoutMs ?? 7_000;

  return await new Promise<Set<string>>((resolve) => {
    const child = spawn("git", ["check-ignore", "--stdin"], {
      cwd: args.cwd,
      stdio: ["pipe", "pipe", "ignore"]
    });

    let settled = false;
    let stdout = "";

    const finish = (result: Set<string>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      finish(new Set<string>());
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    });

    child.on("error", () => finish(new Set<string>()));

    child.on("close", (code) => {
      if (code !== 0 && code !== 1) {
        finish(new Set<string>());
        return;
      }
      const ignored = new Set(
        stdout
          .split(/\r?\n/)
          .map((line) => normalizeRelative(line.trim()))
          .filter(Boolean)
      );
      finish(ignored);
    });

    child.stdin.on("error", () => finish(new Set<string>()));

    try {
      child.stdin.write(`${args.paths.join("\n")}\n`);
      child.stdin.end();
    } catch {
      finish(new Set<string>());
    }
  });
}

function ensureSafePath(
  rootPath: string,
  relPath: string,
  opts: { allowMissing?: boolean } = {},
): { absPath: string; normalizedRel: string } {
  const normalizedRel = normalizeRelative(relPath);
  if (isVolatileAdeRuntimePath(normalizedRel)) {
    throw new Error("Refusing to access ADE runtime paths");
  }
  const joinedPath = path.normalize(path.join(rootPath, normalizedRel));
  let absPath: string;
  try {
    absPath = resolvePathWithinRoot(rootPath, joinedPath, { allowMissing: opts.allowMissing });
  } catch (error) {
    if (error instanceof Error && error.message === "Path escapes root") {
      throw new Error("Refusing to access path outside workspace");
    }
    throw error;
  }
  if (containsDotGit(absPath)) {
    throw new Error("Refusing to access .git internals");
  }
  return { absPath, normalizedRel };
}

function assertMutablePathAllowed(rootPath: string, relPath: string): string {
  const normalizedRel = normalizeRelative(relPath);
  if (isVolatileAdeRuntimePath(normalizedRel)) {
    throw new Error("Refusing to mutate ADE runtime paths");
  }
  const candidatePath = path.join(rootPath, normalizedRel);
  if (containsDotGit(candidatePath)) {
    throw new Error("Refusing to access .git internals");
  }
  return normalizedRel;
}

function isWorkspaceRootRelativePath(normalizedRel: string): boolean {
  return normalizedRel === "" || normalizedRel === ".";
}

type GitStatusSnapshot = {
  fileStatus: Map<string, FileTreeChangeStatus>;
  changedDirectories: Set<string>;
};

type GitStatusCacheEntry = {
  fetchedAt: number;
  snapshot: GitStatusSnapshot;
  inFlight: Promise<GitStatusSnapshot> | null;
};

type VisibleChildEntries = { entry: fs.Dirent; rel: string }[];

type VisibleChildEntriesCacheEntry = {
  fetchedAt: number;
  entries: VisibleChildEntries;
};

function buildGitStatusSnapshot(fileStatus: Map<string, FileTreeChangeStatus>): GitStatusSnapshot {
  const changedDirectories = new Set<string>();
  for (const [filePath, status] of fileStatus) {
    if (!status) continue;
    const segments = normalizeRelative(filePath).split("/").filter(Boolean);
    for (let i = 1; i < segments.length; i++) {
      changedDirectories.add(segments.slice(0, i).join("/"));
    }
  }
  return { fileStatus, changedDirectories };
}

/**
 * Ceiling on how many decoration entries one `refreshGitDecorations` response
 * may carry. A dirty tree is unbounded in principle (a stray `rm -rf` or a
 * generated-output commit can make every file changed), and the sync transport
 * drops the whole peer socket once a single response overruns its byte budget.
 * Capping degrades the deep tail of the tree to undecorated instead.
 */
const MAX_GIT_DECORATION_ENTRIES = 20_000;
/**
 * The entry count alone does not bound the response: 20,000 deeply nested paths
 * serialize to megabytes, and it is bytes — not entries — that the transport
 * budget is denominated in. Cap the estimated serialized size too, well under
 * the socket's 16 MiB ceiling so the rest of the response has room.
 */
const MAX_GIT_DECORATION_BYTES = 2 * 1024 * 1024;
/** `{"path":"…","changeStatus":"untracked"},` minus the path itself. */
const GIT_DECORATION_ENTRY_OVERHEAD_BYTES = 48;

function capGitDecorationEntries(
  entries: FileTreeStatusEntry[],
  byteBudget: number,
): { entries: FileTreeStatusEntry[]; bytesUsed: number } {
  // Shallowest paths first: what the user can actually see near the tree root
  // keeps its decoration, and the deep tail is what gets dropped.
  const depthOf = (entry: FileTreeStatusEntry) => {
    let depth = 0;
    for (let i = 0; i < entry.path.length; i++) {
      if (entry.path.charCodeAt(i) === 47) depth += 1;
    }
    return depth;
  };
  const sizeOf = (entry: FileTreeStatusEntry) =>
    Buffer.byteLength(entry.path, "utf8") + GIT_DECORATION_ENTRY_OVERHEAD_BYTES;
  // Either cap can be the one that bites — at realistic path lengths the byte
  // budget runs out before 20,000 entries do — and truncating an unsorted list
  // drops whatever git happened to report last, not the deep tail. So order by
  // depth whenever either budget is in play, not just the entry one.
  let totalBytes = 0;
  for (const entry of entries) totalBytes += sizeOf(entry);
  const ordered = entries.length <= MAX_GIT_DECORATION_ENTRIES && totalBytes <= byteBudget
    ? entries
    : entries
      .slice()
      .sort((left, right) => depthOf(left) - depthOf(right) || left.path.localeCompare(right.path));
  const limit = Math.min(ordered.length, MAX_GIT_DECORATION_ENTRIES);
  const out: FileTreeStatusEntry[] = [];
  let bytesUsed = 0;
  for (let i = 0; i < limit; i++) {
    const entry = ordered[i];
    const entryBytes = sizeOf(entry);
    // Skip rather than stop: one very long path near the budget edge must not
    // forfeit the room that every shorter path after it would still fit in.
    if (bytesUsed + entryBytes > byteBudget) continue;
    bytesUsed += entryBytes;
    out.push(entry);
  }
  return { entries: out, bytesUsed };
}

function inferDirectoryStatus(statusSnapshot: GitStatusSnapshot, relPath: string): FileTreeChangeStatus {
  return statusSnapshot.changedDirectories.has(normalizeRelative(relPath)) ? "modified" : null;
}

function parseFileTreeStatus(code: string): FileTreeChangeStatus {
  if (code === "??") return "untracked";
  if (code === "!!") return "ignored";
  const combined = code.replace(/\s/g, "");
  if (!combined) return null;
  if (combined.includes("R")) return "renamed";
  if (combined.includes("D")) return "deleted";
  if (combined.includes("A")) return "added";
  if (combined.includes("M")) return "modified";
  return "unknown";
}

export function createFileService({
  laneService,
  onLaneWorktreeMutation,
  externalWorkspaces,
}: {
  laneService: FileServiceLaneAdapter;
  onLaneWorktreeMutation?: (args: { laneId: string; reason: string }) => void;
  externalWorkspaces?: ExternalFilesWorkspaceRegistry;
}) {
  const watcherService = createFileWatcherService();
  const indexService = createFileSearchIndexService();
  const ignoreCache = new Map<string, boolean>();
  const ignoredPrefixCache = new Set<string>();
  const emptyGitStatusSnapshot = buildGitStatusSnapshot(new Map());
  const gitStatusCache = new Map<string, GitStatusCacheEntry>();
  const pagedDirectoryEntriesCache = new Map<string, VisibleChildEntriesCacheEntry>();

  const clearIgnoreCacheForRoot = (rootPath: string): void => {
    const prefix = `${rootPath}::`;
    for (const key of ignoreCache.keys()) {
      if (key.startsWith(prefix)) {
        ignoreCache.delete(key);
      }
    }
    for (const key of ignoredPrefixCache) {
      if (key.startsWith(prefix)) {
        ignoredPrefixCache.delete(key);
      }
    }
  };

  const invalidateGitStatusCache = (rootPath: string): void => {
    const previous = gitStatusCache.get(rootPath);
    if (!previous) return;
    gitStatusCache.set(rootPath, {
      fetchedAt: 0,
      snapshot: previous.snapshot,
      inFlight: null,
    });
  };

  const clearPagedDirectoryEntriesCacheForRoot = (rootPath: string): void => {
    const prefix = `${rootPath}::`;
    for (const key of pagedDirectoryEntriesCache.keys()) {
      if (key.startsWith(prefix)) {
        pagedDirectoryEntriesCache.delete(key);
      }
    }
  };

  const pagedDirectoryEntriesCacheKey = (
    rootPath: string,
    parentPath: string,
    includeIgnored: boolean,
  ): string => `${rootPath}::${parentPath}::${includeIgnored ? "ignored" : "tracked"}`;

  const resolveWorkspace = (workspaceId: string) =>
    externalWorkspaces?.resolve(workspaceId) ?? laneService.resolveWorkspaceById(workspaceId);

  const primeIgnoreCache = async (rootPath: string, relPaths: string[], includeIgnored: boolean): Promise<void> => {
    if (includeIgnored || relPaths.length === 0) return;
    const keyPrefix = `${rootPath}::`;
    const unresolved: string[] = [];
    const seen = new Set<string>();

    for (const relPath of relPaths) {
      const normalized = normalizeRelative(relPath);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      if (isVolatileAdeRuntimePath(normalized)) continue;
      if (isAlwaysIgnoredPath(normalized)) continue;

      const segments = normalized.split("/");
      let coveredByParentIgnore = false;
      for (let i = segments.length; i > 0; i--) {
        const probe = segments.slice(0, i).join("/");
        if (ignoredPrefixCache.has(`${keyPrefix}${probe}`)) {
          coveredByParentIgnore = true;
          break;
        }
      }
      if (coveredByParentIgnore) continue;

      const cacheKey = `${rootPath}::${normalized}`;
      if (ignoreCache.has(cacheKey)) continue;
      unresolved.push(normalized);
    }

    if (unresolved.length === 0) return;
    const ignoredSet = await runGitCheckIgnoreBatch({ cwd: rootPath, paths: unresolved });
    for (const normalized of unresolved) {
      const cacheKey = `${rootPath}::${normalized}`;
      const ignored = ignoredSet.has(normalized);
      ignoreCache.set(cacheKey, ignored);
      if (ignored) {
        ignoredPrefixCache.add(cacheKey);
      }
    }
  };

  const shouldIgnoreForRoot = (rootPath: string) =>
    (relPath: string, includeIgnored: boolean) => isIgnoredPath(rootPath, relPath, includeIgnored);
  const primeIgnoreCacheForRoot = (rootPath: string) =>
    (relPaths: string[], includeIgnored: boolean) => primeIgnoreCache(rootPath, relPaths, includeIgnored);
  const workspaceRootExists = (rootPath: string): boolean => {
    try {
      return fs.existsSync(rootPath) && fs.statSync(rootPath).isDirectory();
    } catch {
      return false;
    }
  };

  const emitLaneMutation = (workspaceId: string, reason: string) => {
    if (!onLaneWorktreeMutation) return;
    const workspace = resolveWorkspace(workspaceId);
    if (!workspace.laneId) return;
    onLaneWorktreeMutation({
      laneId: workspace.laneId,
      reason
    });
  };

  const listWorkspaces = (_args: FilesListWorkspacesArgs = {}): FilesWorkspace[] => {
    const scopes = [...laneService.getFilesWorkspaces()]
      .filter((scope) => scope.kind === "primary" || workspaceRootExists(scope.rootPath))
      .sort((a, b) => {
        if (a.kind === b.kind) return 0;
        if (a.kind === "primary") return -1;
        if (b.kind === "primary") return 1;
        return 0;
      });
    return [
      ...scopes.map((scope) => ({
        id: scope.id,
        kind: scope.kind,
        laneId: scope.laneId,
        name: scope.name,
        branchRef: scope.branchRef,
        rootPath: scope.rootPath,
        isReadOnlyByDefault: scope.isReadOnlyByDefault,
        mobileReadOnly: true,
      })),
      ...(externalWorkspaces?.list() ?? []),
    ];
  };

  const resolveKnownWorkspaceOpenPath = async (requestedPath: string): Promise<FilesOpenExternalPathResult | null> => {
    const trimmedPath = requestedPath.trim();
    if (!trimmedPath || trimmedPath.includes("\0")) {
      throw new Error("Invalid external path.");
    }
    if (!path.isAbsolute(trimmedPath)) {
      throw new Error("External path must be absolute.");
    }

    const realPath = await fsp.realpath(trimmedPath);
    const stat = await fsp.stat(realPath);
    if (!stat.isFile() && !stat.isDirectory()) {
      throw new Error("External path must be a file or directory.");
    }

    const workspaceCandidates = await Promise.all(
      listWorkspaces().filter((workspace) => workspace.kind !== "external").map(async (workspace) => {
        try {
          const realRootPath = await fsp.realpath(workspace.rootPath);
          const relativePath = path.relative(realRootPath, realPath);
          if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return null;
          return { workspace, relativePath: normalizeRelative(relativePath), realRootPath };
        } catch {
          return null;
        }
      })
    );
    const candidates = workspaceCandidates
      .filter((candidate): candidate is { workspace: FilesWorkspace; relativePath: string; realRootPath: string } => candidate !== null)
      .sort((a, b) => b.realRootPath.length - a.realRootPath.length);

    const target = candidates[0] ?? null;
    if (!target) return null;
    return {
      workspace: target.workspace,
      openPath: stat.isFile() ? target.relativePath : target.relativePath || null,
      pathType: stat.isDirectory() ? "directory" : "file",
    };
  };

  const readGitStatusSnapshot = async (rootPath: string, timeoutMs: number): Promise<GitStatusSnapshot> => {
    const res = await runGit(["status", "--porcelain=v1"], { cwd: rootPath, timeoutMs });
    const out = new Map<string, FileTreeChangeStatus>();
    if (res.exitCode !== 0) return buildGitStatusSnapshot(out);
    const lines = res.stdout.split("\n").map((line) => line.trimEnd()).filter(Boolean);
    for (const line of lines) {
      const code = line.slice(0, 2);
      let rel = line.slice(3).trim();
      if (!rel) continue;
      if (rel.includes("->")) {
        rel = rel.split("->")[1]?.trim() ?? rel;
      }

      const normalized = normalizeRelative(rel);
      out.set(normalized, parseFileTreeStatus(code));
    }
    return buildGitStatusSnapshot(out);
  };

  const refreshGitStatusSnapshot = (
    rootPath: string,
    timeoutMs: number,
    opts: { forceFresh?: boolean } = {},
  ): Promise<GitStatusSnapshot> => {
    const cached = gitStatusCache.get(rootPath);
    if (cached?.inFlight && !opts.forceFresh) return cached.inFlight;

    const startedAt = Date.now();
    const inFlight = readGitStatusSnapshot(rootPath, timeoutMs)
      .catch(() => emptyGitStatusSnapshot)
      .then((snapshot) => {
        const current = gitStatusCache.get(rootPath);
        if (!opts.forceFresh && current && current.inFlight !== inFlight) {
          return current.snapshot;
        }
        if (!opts.forceFresh && current && current.fetchedAt > startedAt) {
          return current.snapshot;
        }
        gitStatusCache.set(rootPath, {
          fetchedAt: Date.now(),
          snapshot,
          inFlight: current?.inFlight === inFlight ? null : current?.inFlight ?? null,
        });
        return snapshot;
      });

    gitStatusCache.set(rootPath, {
      fetchedAt: cached?.fetchedAt ?? 0,
      snapshot: cached?.snapshot ?? emptyGitStatusSnapshot,
      inFlight: opts.forceFresh ? cached?.inFlight ?? null : inFlight,
    });

    return inFlight;
  };

  const getGitStatusSnapshot = async (
    rootPath: string,
    opts: { forceFresh?: boolean } = {},
  ): Promise<GitStatusSnapshot> => {
    if (opts.forceFresh) {
      return await refreshGitStatusSnapshot(rootPath, GIT_STATUS_FOREGROUND_TIMEOUT_MS, { forceFresh: true });
    }

    const cached = gitStatusCache.get(rootPath);
    const now = Date.now();
    if (cached && now - cached.fetchedAt <= GIT_STATUS_CACHE_TTL_MS) {
      return cached.snapshot;
    }

    void refreshGitStatusSnapshot(rootPath, GIT_STATUS_BACKGROUND_TIMEOUT_MS);
    return cached?.snapshot ?? emptyGitStatusSnapshot;
  };

  const isIgnoredPath = async (rootPath: string, relPath: string, includeIgnored: boolean): Promise<boolean> => {
    const normalized = normalizeRelative(relPath);
    if (!normalized) return false;
    if (isVolatileAdeRuntimePath(normalized)) return true;
    if (includeIgnored) return false;
    if (isAlwaysIgnoredPath(normalized)) return true;

    const keyPrefix = `${rootPath}::`;
    const segments = normalized.split("/");
    for (let i = segments.length; i > 0; i--) {
      const probe = segments.slice(0, i).join("/");
      if (ignoredPrefixCache.has(`${keyPrefix}${probe}`)) {
        return true;
      }
    }

    const cacheKey = `${rootPath}::${normalized}`;
    if (!ignoreCache.has(cacheKey)) {
      await primeIgnoreCache(rootPath, [normalized], includeIgnored);
    }
    if (ignoreCache.has(cacheKey)) return ignoreCache.get(cacheKey) ?? false;
    return false;
  };

  // Read, filter (volatile/ignored/.git) and deterministically sort a single
  // directory's entries. Shared by the recursive `listTreeNode` walk and the
  // paginated `listTreeChildren` so both apply identical visibility + ordering.
  const collectVisibleChildEntries = async (
    rootPath: string,
    parentPath: string,
    includeIgnored: boolean,
  ): Promise<VisibleChildEntries> => {
    const { absPath: dirPath } = ensureSafePath(rootPath, parentPath);
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    const entryPaths = entries.map((entry) => normalizeRelative(path.join(parentPath, entry.name)));
    await primeIgnoreCache(rootPath, entryPaths, includeIgnored);
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    const visible: { entry: fs.Dirent; rel: string }[] = [];
    for (const entry of entries) {
      const rel = normalizeRelative(path.join(parentPath, entry.name));
      if (isVolatileAdeRuntimePath(rel)) continue;
      if (entry.name === ".git") continue;
      if (await isIgnoredPath(rootPath, rel, includeIgnored)) continue;
      visible.push({ entry, rel });
    }
    return visible;
  };

  const collectPagedVisibleChildEntries = async (
    rootPath: string,
    parentPath: string,
    includeIgnored: boolean,
  ): Promise<VisibleChildEntries> => {
    const key = pagedDirectoryEntriesCacheKey(rootPath, parentPath, includeIgnored);
    const now = Date.now();
    const cached = pagedDirectoryEntriesCache.get(key);
    if (cached && now - cached.fetchedAt <= PAGED_DIRECTORY_ENTRIES_CACHE_TTL_MS) {
      return cached.entries;
    }
    const entries = await collectVisibleChildEntries(rootPath, parentPath, includeIgnored);
    pagedDirectoryEntriesCache.set(key, { fetchedAt: now, entries });
    while (pagedDirectoryEntriesCache.size > PAGED_DIRECTORY_ENTRIES_CACHE_MAX) {
      const oldestKey = pagedDirectoryEntriesCache.keys().next().value;
      if (!oldestKey) break;
      pagedDirectoryEntriesCache.delete(oldestKey);
    }
    return entries;
  };

  const buildChildNode = (
    entry: fs.Dirent,
    rel: string,
    statusSnapshot: GitStatusSnapshot,
  ): FileTreeNode => {
    const node: FileTreeNode = {
      name: entry.name,
      path: rel,
      type: entry.isDirectory() ? "directory" : "file",
      changeStatus: statusSnapshot.fileStatus.get(rel) ?? null,
    };
    if (entry.isDirectory() && !node.changeStatus) {
      node.changeStatus = inferDirectoryStatus(statusSnapshot, rel);
    }
    return node;
  };

  const listTreeNode = async ({
    rootPath,
    parentPath,
    depth,
    includeIgnored,
    statusSnapshot
  }: {
    rootPath: string;
    parentPath: string;
    depth: number;
    includeIgnored: boolean;
    statusSnapshot: GitStatusSnapshot;
  }): Promise<{ children: FileTreeNode[]; truncated: boolean }> => {
    const visible = await collectVisibleChildEntries(rootPath, parentPath, includeIgnored);

    const out: FileTreeNode[] = [];
    let truncated = false;
    for (const { entry, rel } of visible) {
      if (out.length >= MAX_TREE_CHILDREN_PER_DIRECTORY) {
        truncated = true;
        break;
      }

      const node = buildChildNode(entry, rel, statusSnapshot);

      if (entry.isDirectory() && depth > 1) {
        const sub = await listTreeNode({
          rootPath,
          parentPath: rel,
          depth: depth - 1,
          includeIgnored,
          statusSnapshot
        });
        node.children = sub.children;
        if (sub.truncated) {
          node.childrenTruncated = true;
          node.loadMoreOffset = MAX_TREE_CHILDREN_PER_DIRECTORY;
        }
        if (!node.changeStatus && node.children.some((child) => child.changeStatus)) {
          node.changeStatus = "modified";
        }
      }

      out.push(node);
    }
    return { children: out, truncated };
  };

  return {
    writeTextAtomic({ laneId, relPath, text }: { laneId: string; relPath: string; text: string }): void {
      const { worktreePath } = laneService.getLaneBaseAndBranch(laneId);
      assertMutablePathAllowed(worktreePath, relPath);
      secureWriteTextAtomicWithinRoot(worktreePath, relPath, text);
      invalidateGitStatusCache(worktreePath);
      clearPagedDirectoryEntriesCacheForRoot(worktreePath);
      if (onLaneWorktreeMutation) {
        onLaneWorktreeMutation({
          laneId,
          reason: "file_write_atomic"
        });
      }
    },

    listWorkspaces(args: FilesListWorkspacesArgs = {}): FilesWorkspace[] {
      return listWorkspaces(args);
    },

    async openExternalPath(args: FilesOpenExternalPathArgs): Promise<FilesOpenExternalPathResult> {
      if (!externalWorkspaces) {
        throw new Error("External files are not available in this runtime.");
      }
      const knownWorkspaceTarget = await resolveKnownWorkspaceOpenPath(args.path);
      if (knownWorkspaceTarget) {
        return knownWorkspaceTarget;
      }
      return await externalWorkspaces.openPath(args);
    },

    isExternalWorkspaceRoot(rootPath: string): boolean {
      return externalWorkspaces?.isRegisteredRoot(rootPath) ?? false;
    },

    async listTree(args: FilesListTreeArgs): Promise<FileTreeNode[]> {
      const workspace = resolveWorkspace(args.workspaceId);
      const depth = Number.isFinite(args.depth) ? Math.max(1, Math.min(8, Math.floor(args.depth ?? 1))) : 1;
      const parentPath = normalizeRelative(args.parentPath ?? "");
      const statusSnapshot = await getGitStatusSnapshot(workspace.rootPath, {
        forceFresh: args.forceFreshStatus === true,
      });
      const result = await listTreeNode({
        rootPath: workspace.rootPath,
        parentPath,
        depth,
        includeIgnored: Boolean(args.includeIgnored),
        statusSnapshot
      });
      return result.children;
    },

    /**
     * Resolve Git decorations for a workspace independently of the tree walk.
     * `listTree` returns structure immediately (cached/empty status); the
     * renderer calls this with `forceFresh` to stream real decorations in once
     * `git status` resolves, replacing the old fixed-delay double tree fetch.
     */
    async refreshGitDecorations(args: FilesRefreshGitDecorationsArgs): Promise<FilesGitStatusEvent> {
      const workspace = resolveWorkspace(args.workspaceId);
      const snapshot = await getGitStatusSnapshot(workspace.rootPath, {
        forceFresh: args.forceFresh === true,
      });
      const allFiles: FileTreeStatusEntry[] = [];
      for (const [filePath, changeStatus] of snapshot.fileStatus) {
        allFiles.push({ path: filePath, changeStatus });
      }
      const allDirectories: FileTreeStatusEntry[] = [];
      for (const dirPath of snapshot.changedDirectories) {
        allDirectories.push({ path: dirPath, changeStatus: "modified" });
      }
      // One shared byte budget: files and directories ride the same response, so
      // capping them independently would let the pair overrun it together.
      const cappedFiles = capGitDecorationEntries(allFiles, MAX_GIT_DECORATION_BYTES);
      const cappedDirectories = capGitDecorationEntries(
        allDirectories,
        MAX_GIT_DECORATION_BYTES - cappedFiles.bytesUsed,
      );
      const files = cappedFiles.entries;
      const directories = cappedDirectories.entries;
      const truncated = files.length < allFiles.length || directories.length < allDirectories.length;
      return {
        workspaceId: args.workspaceId,
        files,
        directories,
        ...(truncated ? { truncated: true } : {}),
      };
    },

    /**
     * Paginated lazy load of a directory's children. Replaces the silent
     * 1,000-child truncation: callers request a page via `offset`/`limit` and
     * follow `nextOffset` until it is null, so arbitrarily large directories
     * load fully without blocking or dropping entries.
     */
    async listTreeChildren(args: FilesListTreeChildrenArgs): Promise<FilesListTreeChildrenResult> {
      const workspace = resolveWorkspace(args.workspaceId);
      const parentPath = normalizeRelative(args.parentPath ?? "");
      const offset = Number.isFinite(args.offset) ? Math.max(0, Math.floor(args.offset ?? 0)) : 0;
      const limit = Number.isFinite(args.limit)
        ? Math.max(1, Math.min(2_000, Math.floor(args.limit ?? 500)))
        : 500;
      const includeIgnored = Boolean(args.includeIgnored);
      const statusSnapshot = await getGitStatusSnapshot(workspace.rootPath, { forceFresh: false });
      const visible = await collectPagedVisibleChildEntries(workspace.rootPath, parentPath, includeIgnored);

      const total = visible.length;
      const pageEnd = Math.min(offset + limit, total);
      const children: FileTreeNode[] = [];
      for (let i = offset; i < pageEnd; i++) {
        const { entry, rel } = visible[i];
        children.push(buildChildNode(entry, rel, statusSnapshot));
      }
      const nextOffset = pageEnd < total ? pageEnd : null;
      return { parentPath, children, offset, limit, total, nextOffset };
    },

    async readFile(args: FilesReadFileArgs): Promise<FileContent> {
      const workspace = resolveWorkspace(args.workspaceId);
      const { absPath, normalizedRel } = ensureSafePath(workspace.rootPath, args.path);
      const stat = await fsp.stat(absPath);
      if (!stat.isFile()) {
        throw new Error("Path is not a file.");
      }
      const imageMimeType = inferImageMimeType(normalizedRel);
      if (imageMimeType) {
        if (stat.size > MAX_INLINE_IMAGE_PREVIEW_BYTES) {
          return omittedFileContent({
            relPath: normalizedRel,
            size: stat.size,
            encoding: "base64",
            mimeType: imageMimeType,
            reason: "too_large",
          });
        }
        const buf = await fsp.readFile(absPath);
        const base64 = buf.toString("base64");
        return {
          content: base64,
          encoding: "base64",
          size: stat.size,
          languageId: languageIdFromPath(normalizedRel),
          isBinary: true,
          previewKind: "image",
          mimeType: imageMimeType,
        };
      }
      // One open instead of three: anything within the text cap is read whole
      // and sniffed from its own first 8 KB, and anything larger reads the
      // streaming first chunk once and sniffs that. `looksLikeBinary` only ever
      // saw an 8 KB prefix, so keep feeding it exactly that much.
      // Above the inline-binary cap a binary can only ever come back omitted, so
      // sniff those from an 8 KB prefix first rather than reading (say) 900 KB of
      // a video whole and throwing it away. Text in that range pays one extra
      // 8 KB open before its real read, which is noise next to the file itself.
      const withinTextCap = stat.size <= MAX_EDITOR_TEXT_READ_BYTES;
      const sniffBeforeFullRead = withinTextCap && stat.size > MAX_INLINE_BINARY_BYTES;
      const head = !withinTextCap
        ? await readFilePrefix(absPath, STREAM_FIRST_CHUNK_BYTES)
        : sniffBeforeFullRead
          ? await readFilePrefix(absPath, 8192)
          : await fsp.readFile(absPath);
      const isBinary = looksLikeBinary(head.subarray(0, 8192), normalizedRel);
      if (isBinary) {
        const mimeType = inferBinaryMimeType(normalizedRel);
        if (stat.size > MAX_INLINE_BINARY_BYTES) {
          return omittedFileContent({
            relPath: normalizedRel,
            size: stat.size,
            encoding: "base64",
            mimeType,
            reason: "unsupported_binary",
          });
        }
        // The inline-binary cap is below the text cap, so `head` is the whole file.
        return {
          content: head.toString("base64"),
          encoding: "base64",
          size: stat.size,
          languageId: languageIdFromPath(normalizedRel),
          isBinary: true,
          previewKind: "binary",
          mimeType,
        };
      }
      if (!withinTextCap) {
        // Oversized text: return the first chunk and mark it partial. The
        // renderer streams the remainder via readFileRange into a read-only
        // virtualized view, rather than showing a blank "preview unavailable".
        const keep = completeUtf8ByteLength(head);
        const rangeEnd = keep;
        return {
          content: head.subarray(0, keep).toString("utf8"),
          encoding: "utf-8",
          size: stat.size,
          languageId: languageIdFromPath(normalizedRel),
          isBinary: false,
          previewKind: "text",
          mimeType: null,
          totalSize: stat.size,
          isPartial: true,
          rangeStart: 0,
          rangeEnd,
          nextOffset: rangeEnd < stat.size ? rangeEnd : null,
        };
      }
      const body = sniffBeforeFullRead ? await fsp.readFile(absPath) : head;
      return {
        content: body.toString("utf8"),
        encoding: "utf-8",
        size: stat.size,
        languageId: languageIdFromPath(normalizedRel),
        isBinary: false,
        previewKind: "text",
        mimeType: null,
        totalSize: stat.size,
        isPartial: false,
      };
    },

    /**
     * Read a byte range of a file for streaming large text (and CSV/PDF byte
     * access). UTF-8 reads are trimmed to a complete code-point boundary so
     * chunks concatenate cleanly; binary/image ranges come back base64.
     */
    async readFileRange(args: FilesReadFileRangeArgs): Promise<FilesReadFileRangeResult> {
      const workspace = resolveWorkspace(args.workspaceId);
      const { absPath, normalizedRel } = ensureSafePath(workspace.rootPath, args.path);
      const stat = await fsp.stat(absPath);
      if (!stat.isFile()) {
        throw new Error("Path is not a file.");
      }
      const totalSize = stat.size;
      const offset = Math.max(0, Math.floor(args.offset ?? 0));
      const length = Number.isFinite(args.length)
        ? Math.max(1, Math.min(MAX_RANGE_READ_BYTES, Math.floor(args.length ?? DEFAULT_RANGE_READ_BYTES)))
        : DEFAULT_RANGE_READ_BYTES;

      if (offset >= totalSize) {
        return {
          path: normalizedRel,
          encoding: "utf-8",
          content: "",
          rangeStart: totalSize,
          rangeEnd: totalSize,
          totalSize,
          nextOffset: null,
          eof: true,
        };
      }

      const fd = await fsp.open(absPath, "r");
      try {
        const buf = Buffer.alloc(Math.min(length, totalSize - offset));
        const { bytesRead } = await fd.read(buf, 0, buf.length, offset);
        const slice = buf.subarray(0, bytesRead);
        const treatAsBinary = shouldReturnRangeAsBase64(normalizedRel)
          || looksLikeBinary(slice, normalizedRel);

        if (treatAsBinary) {
          const rangeEnd = offset + bytesRead;
          return {
            path: normalizedRel,
            encoding: "base64",
            content: slice.toString("base64"),
            rangeStart: offset,
            rangeEnd,
            totalSize,
            nextOffset: rangeEnd < totalSize ? rangeEnd : null,
            eof: rangeEnd >= totalSize,
          };
        }

        const atEof = offset + bytesRead >= totalSize;
        const keep = atEof ? bytesRead : completeUtf8ByteLength(slice);
        const rangeEnd = offset + keep;
        return {
          path: normalizedRel,
          encoding: "utf-8",
          content: slice.subarray(0, keep).toString("utf8"),
          rangeStart: offset,
          rangeEnd,
          totalSize,
          nextOffset: rangeEnd < totalSize ? rangeEnd : null,
          eof: rangeEnd >= totalSize,
        };
      } finally {
        await fd.close();
      }
    },

    /**
     * `git blame --line-porcelain` for a file (optionally a line range),
     * returning per-line author/sha/time/summary for hover annotations.
     */
    async blame(args: FilesGitBlameArgs): Promise<FilesGitBlameResult> {
      const workspace = resolveWorkspace(args.workspaceId);
      const { normalizedRel } = ensureSafePath(workspace.rootPath, args.path);
      const range = args.startLine && args.endLine && args.endLine >= args.startLine
        ? ["-L", `${Math.max(1, Math.floor(args.startLine))},${Math.floor(args.endLine)}`]
        : [];
      const res = await runGit(
        ["blame", "--line-porcelain", ...range, "--", normalizedRel],
        { cwd: workspace.rootPath, timeoutMs: GIT_BLAME_TIMEOUT_MS },
      );
      if (res.exitCode !== 0) {
        return { path: normalizedRel, lines: [] };
      }
      const lines: FilesGitBlameLine[] = [];
      let sha = "";
      let author = "";
      let authorTime = 0;
      let summary = "";
      let finalLine = 0;
      for (const raw of res.stdout.split("\n")) {
        if (/^[0-9a-f]{40} /.test(raw)) {
          const parts = raw.split(" ");
          sha = parts[0] ?? "";
          finalLine = Number.parseInt(parts[2] ?? "0", 10) || 0;
        } else if (raw.startsWith("author ")) {
          author = raw.slice("author ".length);
        } else if (raw.startsWith("author-time ")) {
          authorTime = Number.parseInt(raw.slice("author-time ".length), 10) || 0;
        } else if (raw.startsWith("summary ")) {
          summary = raw.slice("summary ".length);
        } else if (raw.startsWith("\t")) {
          if (finalLine > 0) {
            lines.push({ line: finalLine, sha, author, authorTime, summary });
          }
        }
      }
      return { path: normalizedRel, lines };
    },

    writeWorkspaceText(args: FilesWriteTextArgs): void {
      const workspace = resolveWorkspace(args.workspaceId);
      const normalizedRel = assertMutablePathAllowed(workspace.rootPath, args.path);
      secureWriteTextAtomicWithinRoot(workspace.rootPath, args.path, args.text);
      invalidateGitStatusCache(workspace.rootPath);
      clearPagedDirectoryEntriesCacheForRoot(workspace.rootPath);
      if (normalizedRel === ".gitignore") {
        clearIgnoreCacheForRoot(workspace.rootPath);
      }
      indexService.onFileChanged({
        workspaceId: args.workspaceId,
        rootPath: workspace.rootPath,
        path: normalizedRel,
        type: "modified",
        shouldIgnore: shouldIgnoreForRoot(workspace.rootPath)
      });
      emitLaneMutation(args.workspaceId, "file_write");
    },

    createFile(args: FilesCreateFileArgs): void {
      const workspace = resolveWorkspace(args.workspaceId);
      const normalizedRel = assertMutablePathAllowed(workspace.rootPath, args.path);
      const { absPath } = ensureSafePath(workspace.rootPath, args.path, { allowMissing: true });
      if (!fs.existsSync(absPath)) {
        secureWriteFileWithinRoot(workspace.rootPath, args.path, args.content ?? "", "utf8");
      }
      invalidateGitStatusCache(workspace.rootPath);
      clearPagedDirectoryEntriesCacheForRoot(workspace.rootPath);
      indexService.onFileChanged({
        workspaceId: args.workspaceId,
        rootPath: workspace.rootPath,
        path: normalizedRel,
        type: "created",
        shouldIgnore: shouldIgnoreForRoot(workspace.rootPath)
      });
      emitLaneMutation(args.workspaceId, "file_create");
    },

    createDirectory(args: FilesCreateDirectoryArgs): void {
      const workspace = resolveWorkspace(args.workspaceId);
      assertMutablePathAllowed(workspace.rootPath, args.path);
      secureMkdirWithinRoot(workspace.rootPath, args.path);
      invalidateGitStatusCache(workspace.rootPath);
      clearPagedDirectoryEntriesCacheForRoot(workspace.rootPath);
      indexService.invalidateWorkspace(args.workspaceId);
      emitLaneMutation(args.workspaceId, "directory_create");
    },

    rename(args: FilesRenameArgs): void {
      const workspace = resolveWorkspace(args.workspaceId);
      const oldRel = assertMutablePathAllowed(workspace.rootPath, args.oldPath);
      const newRel = assertMutablePathAllowed(workspace.rootPath, args.newPath);
      secureRenameWithinRoot(workspace.rootPath, args.oldPath, args.newPath);
      invalidateGitStatusCache(workspace.rootPath);
      clearPagedDirectoryEntriesCacheForRoot(workspace.rootPath);
      if (oldRel === ".gitignore" || newRel === ".gitignore") {
        clearIgnoreCacheForRoot(workspace.rootPath);
      }
      indexService.onFileChanged({
        workspaceId: args.workspaceId,
        rootPath: workspace.rootPath,
        type: "renamed",
        oldPath: oldRel,
        path: newRel,
        shouldIgnore: shouldIgnoreForRoot(workspace.rootPath)
      });
      emitLaneMutation(args.workspaceId, "file_rename");
    },

    deletePath(args: FilesDeleteArgs): void {
      const workspace = resolveWorkspace(args.workspaceId);
      const { absPath, normalizedRel } = ensureSafePath(workspace.rootPath, args.path, { allowMissing: true });
      if (isWorkspaceRootRelativePath(normalizedRel)) {
        throw new Error("Refusing to delete workspace root.");
      }
      fs.rmSync(absPath, { recursive: true, force: true });
      invalidateGitStatusCache(workspace.rootPath);
      clearPagedDirectoryEntriesCacheForRoot(workspace.rootPath);
      if (normalizedRel === ".gitignore") {
        clearIgnoreCacheForRoot(workspace.rootPath);
      }
      indexService.onFileChanged({
        workspaceId: args.workspaceId,
        rootPath: workspace.rootPath,
        path: normalizedRel,
        type: "deleted",
        shouldIgnore: shouldIgnoreForRoot(workspace.rootPath)
      });
      emitLaneMutation(args.workspaceId, "file_delete");
    },

    async watchWorkspace(args: FilesWatchArgs, callback: (ev: FileChangeEvent) => void, senderId: number): Promise<void> {
      const workspace = resolveWorkspace(args.workspaceId);
      if (!args.includeIgnored) {
        await indexService.ensureIndexed({
          workspaceId: args.workspaceId,
          rootPath: workspace.rootPath,
          includeIgnored: false,
          shouldIgnore: shouldIgnoreForRoot(workspace.rootPath)
        });
      }
      watcherService.watch(
        {
          workspaceId: args.workspaceId,
          rootPath: workspace.rootPath,
          senderId,
          includeIgnored: Boolean(args.includeIgnored)
        },
        (ev) => {
          invalidateGitStatusCache(workspace.rootPath);
          clearPagedDirectoryEntriesCacheForRoot(workspace.rootPath);
          if (ev.path === ".gitignore") {
            clearIgnoreCacheForRoot(workspace.rootPath);
          }
          indexService.onFileChanged({
            workspaceId: ev.workspaceId,
            rootPath: workspace.rootPath,
            type: ev.type,
            path: ev.path,
            oldPath: ev.oldPath,
            shouldIgnore: shouldIgnoreForRoot(workspace.rootPath)
          });
          callback(ev);
        }
      );
    },

    stopWatching(args: FilesWatchArgs, senderId: number): void {
      watcherService.stop(args.workspaceId, senderId, Boolean(args.includeIgnored));
    },

    stopWatchingBySender(senderId: number): void {
      watcherService.stopAllForSender(senderId);
    },

    stopAllWatchersForWorkspace(workspaceId: string): number {
      return watcherService.stopAllForWorkspace(workspaceId);
    },

    countActiveWatchersForWorkspace(workspaceId: string): number {
      return watcherService.countActiveForWorkspace(workspaceId);
    },

    async quickOpen(args: FilesQuickOpenArgs): Promise<FilesQuickOpenItem[]> {
      const workspace = resolveWorkspace(args.workspaceId);
      const query = args.query.trim();
      if (!query) return [];
      const limit = typeof args.limit === "number" ? Math.max(1, Math.min(500, args.limit)) : 120;
      return await indexService.quickOpen({
        workspaceId: args.workspaceId,
        rootPath: workspace.rootPath,
        query,
        limit,
        includeIgnored: Boolean(args.includeIgnored),
        shouldIgnore: shouldIgnoreForRoot(workspace.rootPath),
        primeIgnoreCache: primeIgnoreCacheForRoot(workspace.rootPath)
      });
    },

    async warmQuickOpenIndex(args: { workspaceId: string; includeIgnored?: boolean }): Promise<void> {
      try {
        const workspace = resolveWorkspace(args.workspaceId);
        await indexService.ensureIndexed({
          workspaceId: args.workspaceId,
          rootPath: workspace.rootPath,
          includeIgnored: Boolean(args.includeIgnored),
          shouldIgnore: shouldIgnoreForRoot(workspace.rootPath),
          primeIgnoreCache: primeIgnoreCacheForRoot(workspace.rootPath)
        });
      } catch {
        // Warming is best-effort; the interactive query path reports real errors.
      }
    },

    async searchText(args: FilesSearchTextArgs): Promise<FilesSearchTextMatch[]> {
      const workspace = resolveWorkspace(args.workspaceId);
      const query = args.query.trim();
      if (!query) return [];
      const limit = typeof args.limit === "number" ? Math.max(1, Math.min(5000, args.limit)) : 250;
      return await indexService.searchText({
        workspaceId: args.workspaceId,
        rootPath: workspace.rootPath,
        query,
        limit,
        includeIgnored: Boolean(args.includeIgnored),
        shouldIgnore: shouldIgnoreForRoot(workspace.rootPath),
        primeIgnoreCache: primeIgnoreCacheForRoot(workspace.rootPath)
      });
    },

    dispose(): void {
      watcherService.disposeAll();
      indexService.dispose();
      ignoreCache.clear();
    }
  };
}

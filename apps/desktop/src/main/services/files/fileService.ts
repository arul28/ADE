import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type {
  FileChangeEvent,
  FileContent,
  FileTreeChangeStatus,
  FileTreeNode,
  FilesCreateDirectoryArgs,
  FilesCreateFileArgs,
  FilesDeleteArgs,
  FilesListTreeArgs,
  FilesListWorkspacesArgs,
  FilesQuickOpenArgs,
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

const MAX_EDITOR_TEXT_READ_BYTES = 1024 * 1024;
const MAX_INLINE_IMAGE_PREVIEW_BYTES = 1024 * 1024;
const MAX_INLINE_BINARY_BYTES = 256 * 1024;
const MAX_TREE_CHILDREN_PER_DIRECTORY = 1_000;
const GIT_STATUS_CACHE_TTL_MS = 5_000;
const GIT_STATUS_BACKGROUND_TIMEOUT_MS = 2_000;
const GIT_STATUS_FOREGROUND_TIMEOUT_MS = 10_000;
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

function readFilePrefix(absPath: string, maxBytes: number): Buffer {
  const fd = fs.openSync(absPath, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    return bytesRead === buf.length ? buf : buf.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
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
  onLaneWorktreeMutation
}: {
  laneService: ReturnType<typeof createLaneService>;
  onLaneWorktreeMutation?: (args: { laneId: string; reason: string }) => void;
}) {
  const watcherService = createFileWatcherService();
  const indexService = createFileSearchIndexService();
  const ignoreCache = new Map<string, boolean>();
  const ignoredPrefixCache = new Set<string>();
  const emptyGitStatusSnapshot = buildGitStatusSnapshot(new Map());
  const gitStatusCache = new Map<string, GitStatusCacheEntry>();

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

  const resolveWorkspace = (workspaceId: string) => laneService.resolveWorkspaceById(workspaceId);

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
    return scopes.map((scope) => ({
      id: scope.id,
      kind: scope.kind,
      laneId: scope.laneId,
      name: scope.name,
      branchRef: scope.branchRef,
      rootPath: scope.rootPath,
      isReadOnlyByDefault: scope.isReadOnlyByDefault,
      mobileReadOnly: true,
    }));
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
    const { absPath: dirPath } = ensureSafePath(rootPath, parentPath);
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const entryPaths = entries.map((entry) => normalizeRelative(path.join(parentPath, entry.name)));
    await primeIgnoreCache(rootPath, entryPaths, includeIgnored);
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    const out: FileTreeNode[] = [];
    let truncated = false;
    for (const entry of entries) {
      if (out.length >= MAX_TREE_CHILDREN_PER_DIRECTORY) {
        truncated = true;
        break;
      }
      const rel = normalizeRelative(path.join(parentPath, entry.name));
      if (isVolatileAdeRuntimePath(rel)) continue;
      if (await isIgnoredPath(rootPath, rel, includeIgnored)) continue;
      if (entry.name === ".git") continue;

      const node: FileTreeNode = {
        name: entry.name,
        path: rel,
        type: entry.isDirectory() ? "directory" : "file",
        changeStatus: statusSnapshot.fileStatus.get(rel) ?? null
      };

      if (entry.isDirectory()) {
        if (!node.changeStatus) {
          node.changeStatus = inferDirectoryStatus(statusSnapshot, rel);
        }

        if (depth > 1) {
          const sub = await listTreeNode({
            rootPath,
            parentPath: rel,
            depth: depth - 1,
            includeIgnored,
            statusSnapshot
          });
          node.children = sub.children;
          if (sub.truncated) node.childrenTruncated = true;
          if (!node.changeStatus && node.children.some((child) => child.changeStatus)) {
            node.changeStatus = "modified";
          }
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

    readFile(args: FilesReadFileArgs): FileContent {
      const workspace = resolveWorkspace(args.workspaceId);
      const { absPath, normalizedRel } = ensureSafePath(workspace.rootPath, args.path);
      const stat = fs.statSync(absPath);
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
        const buf = fs.readFileSync(absPath);
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
      const sample = readFilePrefix(absPath, Math.min(stat.size, 8192));
      const isBinary = looksLikeBinary(sample, normalizedRel);
      if (isBinary) {
        if (stat.size > MAX_INLINE_BINARY_BYTES) {
          return omittedFileContent({
            relPath: normalizedRel,
            size: stat.size,
            encoding: "base64",
            mimeType: "application/octet-stream",
            reason: "unsupported_binary",
          });
        }
        const buf = fs.readFileSync(absPath);
        return {
          content: buf.toString("base64"),
          encoding: "base64",
          size: stat.size,
          languageId: languageIdFromPath(normalizedRel),
          isBinary: true,
          previewKind: "binary",
          mimeType: "application/octet-stream",
        };
      }
      if (stat.size > MAX_EDITOR_TEXT_READ_BYTES) {
        return omittedFileContent({
          relPath: normalizedRel,
          size: stat.size,
          encoding: "utf-8",
          mimeType: null,
          reason: "too_large",
        });
      }
      const buf = fs.readFileSync(absPath);
      return {
        content: buf.toString("utf8"),
        encoding: "utf-8",
        size: stat.size,
        languageId: languageIdFromPath(normalizedRel),
        isBinary: false,
        previewKind: "text",
        mimeType: null,
      };
    },

    writeWorkspaceText(args: FilesWriteTextArgs): void {
      const workspace = resolveWorkspace(args.workspaceId);
      const normalizedRel = assertMutablePathAllowed(workspace.rootPath, args.path);
      secureWriteTextAtomicWithinRoot(workspace.rootPath, args.path, args.text);
      invalidateGitStatusCache(workspace.rootPath);
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
      indexService.invalidateWorkspace(args.workspaceId);
      emitLaneMutation(args.workspaceId, "directory_create");
    },

    rename(args: FilesRenameArgs): void {
      const workspace = resolveWorkspace(args.workspaceId);
      const oldRel = assertMutablePathAllowed(workspace.rootPath, args.oldPath);
      const newRel = assertMutablePathAllowed(workspace.rootPath, args.newPath);
      secureRenameWithinRoot(workspace.rootPath, args.oldPath, args.newPath);
      invalidateGitStatusCache(workspace.rootPath);
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

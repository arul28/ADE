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

const MAX_EDITOR_READ_BYTES = 5 * 1024 * 1024;
const GIT_STATUS_CACHE_TTL_MS = 1_000;

function containsDotGit(absPath: string): boolean {
  const parts = absPath.split(path.sep);
  return parts.includes(".git");
}

function languageIdFromPath(relPath: string): string {
  const ext = path.extname(relPath).toLowerCase();
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

function isAlwaysIgnoredPath(normalized: string): boolean {
  return (
    normalized.startsWith(".git/") ||
    normalized === ".git" ||
    normalized.startsWith("node_modules/") ||
    normalized.startsWith(".ade/") ||
    normalized === ".ade"
  );
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
  const candidatePath = path.join(rootPath, normalizedRel);
  if (containsDotGit(candidatePath)) {
    throw new Error("Refusing to access .git internals");
  }
  return normalizedRel;
}

function isWorkspaceRootRelativePath(normalizedRel: string): boolean {
  return normalizedRel === "" || normalizedRel === ".";
}

function inferDirectoryStatus(statusMap: Map<string, FileTreeChangeStatus>, relPath: string): FileTreeChangeStatus {
  const prefix = `${normalizeRelative(relPath)}/`;
  for (const [filePath, status] of statusMap) {
    if (!status) continue;
    if (filePath.startsWith(prefix)) return "M";
  }
  return null;
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
  const gitStatusCache = new Map<string, { fetchedAt: number; map: Map<string, FileTreeChangeStatus> }>();

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
    gitStatusCache.delete(rootPath);
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
    const scopes = laneService.getFilesWorkspaces();
    return scopes.map((scope) => ({
      id: scope.id,
      kind: scope.kind,
      laneId: scope.laneId,
      name: scope.name,
      rootPath: scope.rootPath,
      isReadOnlyByDefault: scope.isReadOnlyByDefault
    }));
  };

  const getGitStatusMap = async (rootPath: string): Promise<Map<string, FileTreeChangeStatus>> => {
    const cached = gitStatusCache.get(rootPath);
    const now = Date.now();
    if (cached && now - cached.fetchedAt <= GIT_STATUS_CACHE_TTL_MS) {
      return cached.map;
    }

    const res = await runGit(["status", "--porcelain=v1"], { cwd: rootPath, timeoutMs: 10_000 });
    const out = new Map<string, FileTreeChangeStatus>();
    if (res.exitCode !== 0) return out;
    const lines = res.stdout.split("\n").map((line) => line.trimEnd()).filter(Boolean);
    for (const line of lines) {
      const code = line.slice(0, 2);
      let rel = line.slice(3).trim();
      if (!rel) continue;
      if (rel.includes("->")) {
        rel = rel.split("->")[1]?.trim() ?? rel;
      }

      const normalized = normalizeRelative(rel);
      if (code === "??") {
        out.set(normalized, "A");
        continue;
      }
      const combined = code.replace(/\s/g, "");
      if (combined.includes("D")) out.set(normalized, "D");
      else if (combined.includes("A")) out.set(normalized, "A");
      else if (combined.length) out.set(normalized, "M");
      else out.set(normalized, null);
    }
    gitStatusCache.set(rootPath, { fetchedAt: now, map: out });
    return out;
  };

  const isIgnoredPath = async (rootPath: string, relPath: string, includeIgnored: boolean): Promise<boolean> => {
    if (includeIgnored) return false;
    const normalized = normalizeRelative(relPath);
    if (!normalized) return false;
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
    statusMap
  }: {
    rootPath: string;
    parentPath: string;
    depth: number;
    includeIgnored: boolean;
    statusMap: Map<string, FileTreeChangeStatus>;
  }): Promise<FileTreeNode[]> => {
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
    for (const entry of entries) {
      const rel = normalizeRelative(path.join(parentPath, entry.name));
      if (await isIgnoredPath(rootPath, rel, includeIgnored)) continue;
      if (entry.name === ".git") continue;

      const childAbs = path.join(dirPath, entry.name);
      const node: FileTreeNode = {
        name: entry.name,
        path: rel,
        type: entry.isDirectory() ? "directory" : "file",
        changeStatus: statusMap.get(rel) ?? null
      };

      if (entry.isFile()) {
        try {
          node.size = fs.statSync(childAbs).size;
        } catch {
          node.size = 0;
        }
      }

      if (entry.isDirectory()) {
        let hasChildren = false;
        try {
          const children = fs.readdirSync(childAbs);
          hasChildren = children.length > 0;
        } catch {
          hasChildren = false;
        }

        node.hasChildren = hasChildren;
        if (!node.changeStatus) {
          node.changeStatus = inferDirectoryStatus(statusMap, rel);
        }

        if (depth > 1 && hasChildren) {
          node.children = await listTreeNode({
            rootPath,
            parentPath: rel,
            depth: depth - 1,
            includeIgnored,
            statusMap
          });
          if (!node.changeStatus && node.children.some((child) => child.changeStatus)) {
            node.changeStatus = "M";
          }
        }
      }

      out.push(node);
    }
    return out;
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
      const statusMap = await getGitStatusMap(workspace.rootPath);
      return await listTreeNode({
        rootPath: workspace.rootPath,
        parentPath,
        depth,
        includeIgnored: Boolean(args.includeIgnored),
        statusMap
      });
    },

    readFile(args: FilesReadFileArgs): FileContent {
      const workspace = resolveWorkspace(args.workspaceId);
      const { absPath, normalizedRel } = ensureSafePath(workspace.rootPath, args.path);
      const stat = fs.statSync(absPath);
      if (!stat.isFile()) {
        throw new Error("Path is not a file.");
      }
      if (stat.size > MAX_EDITOR_READ_BYTES) {
        throw new Error(
          `Refusing to open files larger than ${Math.round(MAX_EDITOR_READ_BYTES / (1024 * 1024))}MB in the editor.`
        );
      }
      const buf = fs.readFileSync(absPath);
      const isBinary = hasNullByte(buf);
      return {
        content: isBinary ? "" : buf.toString("utf8"),
        encoding: "utf-8",
        size: stat.size,
        languageId: languageIdFromPath(normalizedRel),
        isBinary
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
        shouldIgnore: (relPath) => isIgnoredPath(workspace.rootPath, relPath, false)
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
        shouldIgnore: (relPath) => isIgnoredPath(workspace.rootPath, relPath, false)
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
        shouldIgnore: (relPath) => isIgnoredPath(workspace.rootPath, relPath, false)
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
        shouldIgnore: (relPath) => isIgnoredPath(workspace.rootPath, relPath, false)
      });
      emitLaneMutation(args.workspaceId, "file_delete");
    },

    async watchWorkspace(args: FilesWatchArgs, callback: (ev: FileChangeEvent) => void, senderId: number): Promise<void> {
      const workspace = resolveWorkspace(args.workspaceId);
      await indexService.ensureIndexed({
        workspaceId: args.workspaceId,
        rootPath: workspace.rootPath,
        shouldIgnore: (relPath) => isIgnoredPath(workspace.rootPath, relPath, false)
      });
      watcherService.watch(
        {
          workspaceId: args.workspaceId,
          rootPath: workspace.rootPath,
          senderId
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
            shouldIgnore: (relPath) => isIgnoredPath(workspace.rootPath, relPath, false)
          });
          callback(ev);
        }
      );
    },

    stopWatching(args: FilesWatchArgs, senderId: number): void {
      watcherService.stop(args.workspaceId, senderId);
    },

    stopWatchingBySender(senderId: number): void {
      watcherService.stopAllForSender(senderId);
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
        shouldIgnore: (relPath) => isIgnoredPath(workspace.rootPath, relPath, false)
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
        shouldIgnore: (relPath) => isIgnoredPath(workspace.rootPath, relPath, false)
      });
    },

    dispose(): void {
      watcherService.disposeAll();
      indexService.dispose();
      ignoreCache.clear();
    }
  };
}

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
import { createFileWatcherService } from "./fileWatcherService";
import { createFileSearchIndexService } from "./fileSearchIndexService";

function isWithinDir(dir: string, candidate: string): boolean {
  const rel = path.relative(dir, candidate);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

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

function hasNullByte(buf: Buffer): boolean {
  const max = Math.min(buf.length, 8192);
  for (let i = 0; i < max; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function normalizeRelative(relPath: string): string {
  return relPath.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
}

function ensureSafePath(rootPath: string, relPath: string): { absPath: string; normalizedRel: string } {
  const normalizedRel = normalizeRelative(relPath);
  const absPath = path.normalize(path.join(rootPath, normalizedRel));
  if (!isWithinDir(rootPath, absPath)) {
    throw new Error("Refusing to access path outside workspace");
  }
  if (containsDotGit(absPath)) {
    throw new Error("Refusing to access .git internals");
  }
  return { absPath, normalizedRel };
}

function writeTextAtomicAbs(absPath: string, text: string): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.tmp-${randomUUID()}`;
  fs.writeFileSync(tmp, text, "utf8");
  try {
    fs.renameSync(tmp, absPath);
  } catch (err: any) {
    try {
      fs.copyFileSync(tmp, absPath);
      fs.unlinkSync(tmp);
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // ignore
      }
      throw err;
    }
  }
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

  const clearIgnoreCacheForRoot = (rootPath: string): void => {
    const prefix = `${rootPath}::`;
    for (const key of ignoreCache.keys()) {
      if (key.startsWith(prefix)) {
        ignoreCache.delete(key);
      }
    }
  };

  const resolveWorkspace = (workspaceId: string) => laneService.resolveWorkspaceById(workspaceId);

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
    return out;
  };

  const isIgnoredPath = async (rootPath: string, relPath: string, includeIgnored: boolean): Promise<boolean> => {
    if (includeIgnored) return false;
    const normalized = normalizeRelative(relPath);
    if (!normalized) return false;
    if (normalized.startsWith(".git/") || normalized === ".git") return true;
    if (normalized.startsWith("node_modules/")) return true;

    const cacheKey = `${rootPath}::${normalized}`;
    if (ignoreCache.has(cacheKey)) {
      return ignoreCache.get(cacheKey) ?? false;
    }

    const check = await runGit(["check-ignore", "-q", "--", normalized], { cwd: rootPath, timeoutMs: 3_000 });
    const ignored = check.exitCode === 0;
    ignoreCache.set(cacheKey, ignored);
    return ignored;
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
      const { absPath } = ensureSafePath(worktreePath, relPath);
      writeTextAtomicAbs(absPath, text);
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
      const { absPath, normalizedRel } = ensureSafePath(workspace.rootPath, args.path);
      writeTextAtomicAbs(absPath, args.text);
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
      const { absPath, normalizedRel } = ensureSafePath(workspace.rootPath, args.path);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      if (!fs.existsSync(absPath)) {
        fs.writeFileSync(absPath, args.content ?? "", "utf8");
      }
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
      const { absPath } = ensureSafePath(workspace.rootPath, args.path);
      fs.mkdirSync(absPath, { recursive: true });
      indexService.invalidateWorkspace(args.workspaceId);
      emitLaneMutation(args.workspaceId, "directory_create");
    },

    rename(args: FilesRenameArgs): void {
      const workspace = resolveWorkspace(args.workspaceId);
      const { absPath: oldAbs, normalizedRel: oldRel } = ensureSafePath(workspace.rootPath, args.oldPath);
      const { absPath: newAbs, normalizedRel: newRel } = ensureSafePath(workspace.rootPath, args.newPath);
      fs.mkdirSync(path.dirname(newAbs), { recursive: true });
      fs.renameSync(oldAbs, newAbs);
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
      const { absPath, normalizedRel } = ensureSafePath(workspace.rootPath, args.path);
      fs.rmSync(absPath, { recursive: true, force: true });
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

import fs from "node:fs";
import path from "node:path";
import type { FilesQuickOpenItem, FilesSearchTextMatch } from "../../../shared/types";

const MAX_INDEXED_FILES = 25_000;
const MAX_TEXT_FILE_BYTES = 1_000_000;
const MAX_TOTAL_CONTENT_BYTES = 80 * 1024 * 1024;
const YIELD_EVERY_FILES = 120;

type IndexedFile = {
  path: string;
  lowerPath: string;
  size: number;
  mtimeMs: number;
  hasTextContent: boolean;
  lines: string[];
};

type WorkspaceIndex = {
  workspaceId: string;
  rootPath: string;
  files: Map<string, IndexedFile>;
  totalContentBytes: number;
  buildingPromise: Promise<void> | null;
  builtAt: string | null;
};

function normalizeRelative(relPath: string): string {
  return relPath.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
}

function hasNullByte(buf: Buffer): boolean {
  const max = Math.min(buf.length, 8192);
  for (let i = 0; i < max; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function scorePath(pathValue: string, query: string): number {
  const normalized = pathValue.toLowerCase();
  const needle = query.toLowerCase().trim();
  if (!needle) return 0;
  if (normalized === needle) return 1000;
  if (normalized.endsWith(`/${needle}`) || normalized.endsWith(`\\${needle}`)) return 900;
  const idx = normalized.indexOf(needle);
  if (idx < 0) return -1;
  return 600 - idx;
}

async function cooperativeYield(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(() => resolve());
  });
}

export function createFileSearchIndexService() {
  const byWorkspace = new Map<string, WorkspaceIndex>();

  const getOrCreateWorkspaceIndex = (workspaceId: string, rootPath: string): WorkspaceIndex => {
    const existing = byWorkspace.get(workspaceId);
    if (existing && existing.rootPath === rootPath) return existing;

    const next: WorkspaceIndex = {
      workspaceId,
      rootPath,
      files: new Map(),
      totalContentBytes: 0,
      buildingPromise: null,
      builtAt: null
    };
    byWorkspace.set(workspaceId, next);
    return next;
  };

  const toAbsolute = (rootPath: string, relPath: string): string => path.join(rootPath, normalizeRelative(relPath));

  const removePath = (index: WorkspaceIndex, relPath: string): void => {
    const normalized = normalizeRelative(relPath);
    if (!normalized) return;
    const descendantsPrefix = `${normalized}/`;

    for (const [key, entry] of index.files.entries()) {
      if (key === normalized || key.startsWith(descendantsPrefix)) {
        if (entry.hasTextContent) {
          index.totalContentBytes = Math.max(0, index.totalContentBytes - entry.size);
        }
        index.files.delete(key);
      }
    }
  };

  const upsertFile = (index: WorkspaceIndex, relPath: string): void => {
    const normalized = normalizeRelative(relPath);
    if (!normalized) return;
    const absPath = toAbsolute(index.rootPath, normalized);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch {
      removePath(index, normalized);
      return;
    }

    if (stat.isDirectory()) return;
    if (!stat.isFile()) return;

    const existing = index.files.get(normalized);
    if (existing?.hasTextContent) {
      index.totalContentBytes = Math.max(0, index.totalContentBytes - existing.size);
    }

    let hasTextContent = false;
    let lines: string[] = [];
    const size = stat.size;

    if (size <= MAX_TEXT_FILE_BYTES) {
      try {
        const buf = fs.readFileSync(absPath);
        if (!hasNullByte(buf)) {
          const nextBytes = index.totalContentBytes + size;
          if (nextBytes <= MAX_TOTAL_CONTENT_BYTES) {
            hasTextContent = true;
            lines = buf.toString("utf8").split("\n");
            index.totalContentBytes = nextBytes;
          }
        }
      } catch {
        // keep path-only index entry
      }
    }

    index.files.set(normalized, {
      path: normalized,
      lowerPath: normalized.toLowerCase(),
      size,
      mtimeMs: stat.mtimeMs,
      hasTextContent,
      lines
    });
  };

  const shouldSkipDirectoryName = (name: string): boolean => {
    if (name === ".git") return true;
    if (name === "node_modules") return true;
    return false;
  };

  const buildWorkspace = async (index: WorkspaceIndex, opts: {
    shouldIgnore: (relPath: string) => Promise<boolean>;
  }): Promise<void> => {
    index.files.clear();
    index.totalContentBytes = 0;

    const stack: string[] = [""];
    let visitedFiles = 0;

    while (stack.length > 0) {
      const relDir = stack.pop() ?? "";
      const absDir = toAbsolute(index.rootPath, relDir);

      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(absDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const relPath = normalizeRelative(path.join(relDir, entry.name));
        if (!relPath) continue;
        if (entry.isDirectory() && shouldSkipDirectoryName(entry.name)) continue;
        if (await opts.shouldIgnore(relPath)) continue;

        if (entry.isDirectory()) {
          stack.push(relPath);
          continue;
        }

        if (!entry.isFile()) continue;
        upsertFile(index, relPath);
        visitedFiles += 1;
        if (visitedFiles >= MAX_INDEXED_FILES) {
          index.builtAt = new Date().toISOString();
          return;
        }
        if (visitedFiles % YIELD_EVERY_FILES === 0) {
          await cooperativeYield();
        }
      }
    }

    index.builtAt = new Date().toISOString();
  };

  const ensureBuilt = async (workspaceId: string, rootPath: string, opts: {
    shouldIgnore: (relPath: string) => Promise<boolean>;
  }): Promise<WorkspaceIndex> => {
    const index = getOrCreateWorkspaceIndex(workspaceId, rootPath);
    if (index.files.size > 0 || index.builtAt) return index;
    if (index.buildingPromise) {
      await index.buildingPromise;
      return index;
    }

    index.buildingPromise = buildWorkspace(index, opts).finally(() => {
      index.buildingPromise = null;
    });
    await index.buildingPromise;
    return index;
  };

  return {
    async ensureIndexed(args: {
      workspaceId: string;
      rootPath: string;
      shouldIgnore: (relPath: string) => Promise<boolean>;
    }): Promise<void> {
      await ensureBuilt(args.workspaceId, args.rootPath, {
        shouldIgnore: args.shouldIgnore
      });
    },

    async quickOpen(args: {
      workspaceId: string;
      rootPath: string;
      query: string;
      limit: number;
      shouldIgnore: (relPath: string) => Promise<boolean>;
    }): Promise<FilesQuickOpenItem[]> {
      const index = await ensureBuilt(args.workspaceId, args.rootPath, {
        shouldIgnore: args.shouldIgnore
      });

      const scored: FilesQuickOpenItem[] = [];
      for (const entry of index.files.values()) {
        const score = scorePath(entry.lowerPath, args.query);
        if (score < 0) continue;
        scored.push({ path: entry.path, score });
      }
      scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
      return scored.slice(0, args.limit);
    },

    async searchText(args: {
      workspaceId: string;
      rootPath: string;
      query: string;
      limit: number;
      shouldIgnore: (relPath: string) => Promise<boolean>;
    }): Promise<FilesSearchTextMatch[]> {
      const index = await ensureBuilt(args.workspaceId, args.rootPath, {
        shouldIgnore: args.shouldIgnore
      });

      const out: FilesSearchTextMatch[] = [];
      const queryLower = args.query.toLowerCase();
      for (const entry of index.files.values()) {
        if (out.length >= args.limit) break;
        if (!entry.hasTextContent) continue;
        for (let i = 0; i < entry.lines.length && out.length < args.limit; i++) {
          const line = entry.lines[i] ?? "";
          const col = line.toLowerCase().indexOf(queryLower);
          if (col < 0) continue;
          out.push({
            path: entry.path,
            line: i + 1,
            column: col + 1,
            preview: line.slice(0, 240)
          });
        }
      }
      return out;
    },

    onFileChanged(args: {
      workspaceId: string;
      rootPath: string;
      path: string;
      type: "created" | "modified" | "deleted" | "renamed";
      oldPath?: string;
      shouldIgnore: (relPath: string) => Promise<boolean>;
    }): void {
      const index = getOrCreateWorkspaceIndex(args.workspaceId, args.rootPath);
      // If this workspace was never indexed yet, defer indexing until first search/quick-open query.
      if (!index.builtAt && index.files.size === 0) return;

      if (args.oldPath) {
        removePath(index, args.oldPath);
      }

      if (args.type === "deleted") {
        removePath(index, args.path);
        return;
      }

      const relPath = normalizeRelative(args.path);
      void args.shouldIgnore(relPath).then((ignored) => {
        if (ignored) {
          removePath(index, relPath);
          return;
        }
        upsertFile(index, relPath);
      }).catch(() => {
        // ignore indexing failures
      });
    },

    invalidateWorkspace(workspaceId: string): void {
      byWorkspace.delete(workspaceId);
    },

    dispose(): void {
      byWorkspace.clear();
    }
  };
}

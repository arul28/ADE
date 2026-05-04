import fs from "node:fs";
import path from "node:path";
import type { FilesQuickOpenItem, FilesSearchTextMatch } from "../../../shared/types";
import { hasNullByte, normalizeRelative } from "../shared/utils";

const MAX_INDEXED_FILES = 25_000;
const MAX_TEXT_FILE_BYTES = 1_000_000;
const MAX_TOTAL_CONTENT_BYTES = 80 * 1024 * 1024;
const YIELD_EVERY_FILES = 120;
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
const ALWAYS_SKIPPED_DIRECTORY_NAMES = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".vite",
  "coverage",
  "dist",
  "node_modules",
]);

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
  includeIgnored: boolean;
  files: Map<string, IndexedFile>;
  totalContentBytes: number;
  buildingPromise: Promise<void> | null;
  builtAt: string | null;
};

type IgnoreOptions = {
  shouldIgnore: (relPath: string, includeIgnored: boolean) => Promise<boolean>;
  primeIgnoreCache?: (relPaths: string[], includeIgnored: boolean) => Promise<void>;
};

function isVolatileAdeRuntimePath(relPath: string): boolean {
  return VOLATILE_ADE_FILES.has(relPath)
    || VOLATILE_ADE_PREFIXES.some((prefix) => relPath === prefix.slice(0, -1) || relPath.startsWith(prefix));
}

function shouldSkipPathPrefix(relPath: string, includeIgnored: boolean): boolean {
  if (isVolatileAdeRuntimePath(relPath)) return true;
  if (includeIgnored) return false;
  return relPath === ".ade" || relPath.startsWith(".ade/");
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

  const workspaceIndexKey = (workspaceId: string, includeIgnored: boolean): string =>
    `${workspaceId}::${includeIgnored ? "all" : "default"}`;

  const getOrCreateWorkspaceIndex = (workspaceId: string, rootPath: string, includeIgnored: boolean): WorkspaceIndex => {
    const key = workspaceIndexKey(workspaceId, includeIgnored);
    const existing = byWorkspace.get(key);
    if (existing && existing.rootPath === rootPath) return existing;

    const next: WorkspaceIndex = {
      workspaceId,
      rootPath,
      includeIgnored,
      files: new Map(),
      totalContentBytes: 0,
      buildingPromise: null,
      builtAt: null
    };
    byWorkspace.set(key, next);
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

  const shouldSkipDirectoryName = (name: string): boolean => ALWAYS_SKIPPED_DIRECTORY_NAMES.has(name);

  const buildWorkspace = async (index: WorkspaceIndex, opts: IgnoreOptions): Promise<void> => {
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

      const candidates = entries
        .map((entry) => ({ entry, relPath: normalizeRelative(path.join(relDir, entry.name)) }))
        .filter((candidate) => Boolean(candidate.relPath));

      await opts.primeIgnoreCache?.(candidates.map((candidate) => candidate.relPath), index.includeIgnored);

      for (const { entry, relPath } of candidates) {
        if (!relPath) continue;
        if (shouldSkipPathPrefix(relPath, index.includeIgnored)) continue;
        if (entry.isDirectory() && shouldSkipDirectoryName(entry.name)) continue;
        if (await opts.shouldIgnore(relPath, index.includeIgnored)) continue;

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

  const ensureBuilt = async (workspaceId: string, rootPath: string, opts: IgnoreOptions & {
    includeIgnored: boolean;
  }): Promise<WorkspaceIndex> => {
    const index = getOrCreateWorkspaceIndex(workspaceId, rootPath, opts.includeIgnored);
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
      includeIgnored: boolean;
      shouldIgnore: (relPath: string, includeIgnored: boolean) => Promise<boolean>;
      primeIgnoreCache?: (relPaths: string[], includeIgnored: boolean) => Promise<void>;
    }): Promise<void> {
      await ensureBuilt(args.workspaceId, args.rootPath, {
        includeIgnored: args.includeIgnored,
        shouldIgnore: args.shouldIgnore,
        primeIgnoreCache: args.primeIgnoreCache
      });
    },

    async quickOpen(args: {
      workspaceId: string;
      rootPath: string;
      query: string;
      limit: number;
      includeIgnored: boolean;
      shouldIgnore: (relPath: string, includeIgnored: boolean) => Promise<boolean>;
      primeIgnoreCache?: (relPaths: string[], includeIgnored: boolean) => Promise<void>;
    }): Promise<FilesQuickOpenItem[]> {
      const index = await ensureBuilt(args.workspaceId, args.rootPath, {
        includeIgnored: args.includeIgnored,
        shouldIgnore: args.shouldIgnore,
        primeIgnoreCache: args.primeIgnoreCache
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
      includeIgnored: boolean;
      shouldIgnore: (relPath: string, includeIgnored: boolean) => Promise<boolean>;
      primeIgnoreCache?: (relPaths: string[], includeIgnored: boolean) => Promise<void>;
    }): Promise<FilesSearchTextMatch[]> {
      const index = await ensureBuilt(args.workspaceId, args.rootPath, {
        includeIgnored: args.includeIgnored,
        shouldIgnore: args.shouldIgnore,
        primeIgnoreCache: args.primeIgnoreCache
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
      shouldIgnore: (relPath: string, includeIgnored: boolean) => Promise<boolean>;
    }): void {
      const relPath = normalizeRelative(args.path);
      const matchingIndexes = Array.from(byWorkspace.values()).filter(
        (index) => index.workspaceId === args.workspaceId && index.rootPath === args.rootPath
      );

      for (const index of matchingIndexes) {
        // If this workspace/mode was never indexed yet, defer indexing until first query.
        if (!index.builtAt && index.files.size === 0) continue;

        if (args.oldPath) {
          removePath(index, args.oldPath);
        }

        if (args.type === "deleted") {
          removePath(index, args.path);
          continue;
        }

        void args.shouldIgnore(relPath, index.includeIgnored).then((ignored) => {
          if (ignored || shouldSkipPathPrefix(relPath, index.includeIgnored)) {
            removePath(index, relPath);
            return;
          }
          upsertFile(index, relPath);
        }).catch(() => {
          // ignore indexing failures
        });
      }
    },

    invalidateWorkspace(workspaceId: string): void {
      for (const key of byWorkspace.keys()) {
        if (key.startsWith(`${workspaceId}::`)) {
          byWorkspace.delete(key);
        }
      }
    },

    dispose(): void {
      byWorkspace.clear();
    }
  };
}

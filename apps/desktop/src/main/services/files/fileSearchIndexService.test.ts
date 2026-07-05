import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileSearchIndexService } from "./fileSearchIndexService";

const shouldIgnore = vi.fn(async () => false);
const primeIgnoreCache = vi.fn(async () => undefined);

function createTempWorkspace(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function flushFileChange(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("fileSearchIndexService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    shouldIgnore.mockClear();
    primeIgnoreCache.mockClear();
  });

  it("returns quickOpen matches without reading file contents", async () => {
    const rootPath = createTempWorkspace("ade-file-index-quick-open-");
    const service = createFileSearchIndexService();

    try {
      fs.mkdirSync(path.join(rootPath, "src"), { recursive: true });
      fs.writeFileSync(path.join(rootPath, "src", "feature.ts"), "const secret = 'needle';\n", "utf8");
      const readFileSync = vi.spyOn(fs, "readFileSync").mockImplementation((() => {
        throw new Error("quickOpen should not read file contents");
      }) as typeof fs.readFileSync);

      const matches = await service.quickOpen({
        workspaceId: "workspace-1",
        rootPath,
        query: "feature",
        limit: 10,
        includeIgnored: false,
        shouldIgnore,
        primeIgnoreCache,
      });

      expect(matches).toEqual([expect.objectContaining({ path: "src/feature.ts" })]);
      expect(readFileSync).not.toHaveBeenCalled();
    } finally {
      service.dispose();
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("loads text content lazily for searchText and reuses cached lines", async () => {
    const rootPath = createTempWorkspace("ade-file-index-lazy-text-");
    const service = createFileSearchIndexService();

    try {
      fs.mkdirSync(path.join(rootPath, "notes"), { recursive: true });
      fs.writeFileSync(path.join(rootPath, "notes", "plan.md"), "alpha\nlazy needle\n", "utf8");
      const readFileSync = vi.spyOn(fs, "readFileSync");

      await expect(service.quickOpen({
        workspaceId: "workspace-1",
        rootPath,
        query: "plan",
        limit: 10,
        includeIgnored: false,
        shouldIgnore,
        primeIgnoreCache,
      })).resolves.toEqual([expect.objectContaining({ path: "notes/plan.md" })]);
      expect(readFileSync).not.toHaveBeenCalled();

      const firstSearch = await service.searchText({
        workspaceId: "workspace-1",
        rootPath,
        query: "lazy needle",
        limit: 10,
        includeIgnored: false,
        shouldIgnore,
        primeIgnoreCache,
      });
      expect(firstSearch).toEqual([
        expect.objectContaining({ path: "notes/plan.md", line: 2, column: 1 }),
      ]);
      expect(readFileSync).toHaveBeenCalledTimes(1);

      readFileSync.mockClear();
      await expect(service.searchText({
        workspaceId: "workspace-1",
        rootPath,
        query: "lazy needle",
        limit: 10,
        includeIgnored: false,
        shouldIgnore,
        primeIgnoreCache,
      })).resolves.toEqual(firstSearch);
      expect(readFileSync).not.toHaveBeenCalled();
    } finally {
      service.dispose();
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("caches quickOpen queries and invalidates them after file changes", async () => {
    const rootPath = createTempWorkspace("ade-file-index-cache-");
    const service = createFileSearchIndexService();

    try {
      fs.writeFileSync(path.join(rootPath, "alpha-one.ts"), "export const one = 1;\n", "utf8");

      const first = await service.quickOpen({
        workspaceId: "workspace-1",
        rootPath,
        query: "alpha",
        limit: 10,
        includeIgnored: false,
        shouldIgnore,
        primeIgnoreCache,
      });
      expect(first.map((item) => item.path)).toEqual(["alpha-one.ts"]);

      fs.writeFileSync(path.join(rootPath, "alpha-two.ts"), "export const two = 2;\n", "utf8");
      const cached = await service.quickOpen({
        workspaceId: "workspace-1",
        rootPath,
        query: "alpha",
        limit: 10,
        includeIgnored: false,
        shouldIgnore,
        primeIgnoreCache,
      });
      expect(cached.map((item) => item.path)).toEqual(["alpha-one.ts"]);

      service.onFileChanged({
        workspaceId: "workspace-1",
        rootPath,
        path: "alpha-two.ts",
        type: "created",
        shouldIgnore,
      });
      await flushFileChange();

      const afterCreate = await service.quickOpen({
        workspaceId: "workspace-1",
        rootPath,
        query: "alpha",
        limit: 10,
        includeIgnored: false,
        shouldIgnore,
        primeIgnoreCache,
      });
      expect(afterCreate.map((item) => item.path)).toEqual(["alpha-one.ts", "alpha-two.ts"]);

      fs.rmSync(path.join(rootPath, "alpha-one.ts"), { force: true });
      service.onFileChanged({
        workspaceId: "workspace-1",
        rootPath,
        path: "alpha-one.ts",
        type: "deleted",
        shouldIgnore,
      });

      const afterDelete = await service.quickOpen({
        workspaceId: "workspace-1",
        rootPath,
        query: "alpha",
        limit: 10,
        includeIgnored: false,
        shouldIgnore,
        primeIgnoreCache,
      });
      expect(afterDelete.map((item) => item.path)).toEqual(["alpha-two.ts"]);
    } finally {
      service.dispose();
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("keeps content byte accounting bounded across repeated invalidations", async () => {
    const rootPath = createTempWorkspace("ade-file-index-content-bytes-");
    const service = createFileSearchIndexService();
    const filePath = path.join(rootPath, "budget.txt");
    const padding = "x".repeat(999_980);

    try {
      for (let i = 0; i < 86; i += 1) {
        fs.writeFileSync(filePath, `needle ${i}\n${padding}`, "utf8");
        service.onFileChanged({
          workspaceId: "workspace-1",
          rootPath,
          path: "budget.txt",
          type: i === 0 ? "created" : "modified",
          shouldIgnore,
        });
        await flushFileChange();

        const matches = await service.searchText({
          workspaceId: "workspace-1",
          rootPath,
          query: "needle",
          limit: 1,
          includeIgnored: false,
          shouldIgnore,
          primeIgnoreCache,
        });
        expect(matches).toEqual([
          expect.objectContaining({ path: "budget.txt", preview: `needle ${i}` }),
        ]);
      }

      fs.rmSync(filePath, { force: true });
      service.onFileChanged({
        workspaceId: "workspace-1",
        rootPath,
        path: "budget.txt",
        type: "deleted",
        shouldIgnore,
      });

      await expect(service.searchText({
        workspaceId: "workspace-1",
        rootPath,
        query: "needle",
        limit: 1,
        includeIgnored: false,
        shouldIgnore,
        primeIgnoreCache,
      })).resolves.toEqual([]);
    } finally {
      service.dispose();
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });
});

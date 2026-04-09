import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileService } from "./fileService";

function createLaneServiceStub(rootPath: string) {
  return {
    resolveWorkspaceById: vi.fn(() => ({
      id: "workspace-1",
      laneId: "lane-1",
      rootPath,
    })),
    getFilesWorkspaces: vi.fn(() => []),
  } as any;
}

describe("fileService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves non-escape filesystem errors while resolving workspace paths", () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-file-service-"));
    const rootReal = fs.realpathSync(rootPath);
    const blockedPath = path.join(rootReal, "blocked");
    const permissionError = Object.assign(new Error("permission denied"), { code: "EACCES" as const });
    const originalLstatSync = fs.lstatSync.bind(fs);

    const laneService = createLaneServiceStub(rootPath);

    const service = createFileService({ laneService });
    const spy = vi.spyOn(fs, "lstatSync").mockImplementation(((filePath: fs.PathLike) => {
      if (String(filePath) === blockedPath) {
        throw permissionError;
      }
      return originalLstatSync(filePath);
    }) as typeof fs.lstatSync);

    try {
      expect(() =>
        service.readFile({
          workspaceId: "workspace-1",
          path: "blocked/child.txt",
        })
      ).toThrow(permissionError);
    } finally {
      spy.mockRestore();
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("includes ignored files in quick open and search when requested", async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-file-service-search-"));
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: rootPath, stdio: "ignore" });
    const laneService = createLaneServiceStub(rootPath);
    const service = createFileService({ laneService });

    try {
      fs.mkdirSync(path.join(rootPath, ".ade", "context"), { recursive: true });
      fs.mkdirSync(path.join(rootPath, "src"), { recursive: true });
      fs.writeFileSync(path.join(rootPath, ".ade", "context", "PRD.ade.md"), "# PRD\nRenderer-safe content\n", "utf8");
      fs.writeFileSync(path.join(rootPath, "src", "index.ts"), "export const visible = true;\n", "utf8");

      const quickOpenDefault = await service.quickOpen({
        workspaceId: "workspace-1",
        query: "prd",
        includeIgnored: false,
      });
      const quickOpenIgnored = await service.quickOpen({
        workspaceId: "workspace-1",
        query: "prd",
        includeIgnored: true,
      });
      const searchDefault = await service.searchText({
        workspaceId: "workspace-1",
        query: "renderer-safe",
        includeIgnored: false,
      });
      const searchIgnored = await service.searchText({
        workspaceId: "workspace-1",
        query: "renderer-safe",
        includeIgnored: true,
      });

      expect(quickOpenDefault).toEqual([]);
      expect(quickOpenIgnored.map((item) => item.path)).toContain(".ade/context/PRD.ade.md");
      expect(searchDefault).toEqual([]);
      expect(searchIgnored.map((item) => item.path)).toContain(".ade/context/PRD.ade.md");
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });
});

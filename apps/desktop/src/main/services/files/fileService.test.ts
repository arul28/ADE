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

  it("lists only the requested tree depth without extra file metadata", async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-file-service-tree-"));
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: rootPath, stdio: "ignore" });
    const laneService = createLaneServiceStub(rootPath);
    const service = createFileService({ laneService });

    try {
      fs.mkdirSync(path.join(rootPath, "src"), { recursive: true });
      fs.writeFileSync(path.join(rootPath, "package.json"), "{\n  \"name\": \"fixture\"\n}\n", "utf8");
      fs.writeFileSync(path.join(rootPath, "src", "index.ts"), "export const value = 1;\n", "utf8");

      const rootNodes = await service.listTree({
        workspaceId: "workspace-1",
        depth: 1,
        includeIgnored: true,
      });
      const nestedNodes = await service.listTree({
        workspaceId: "workspace-1",
        parentPath: "src",
        depth: 1,
        includeIgnored: true,
      });

      expect(rootNodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "src",
            path: "src",
            type: "directory",
          }),
          expect.objectContaining({
            name: "package.json",
            path: "package.json",
            type: "file",
          }),
        ]),
      );
      expect(rootNodes.find((node) => node.path === "src")).not.toHaveProperty("children");
      expect(rootNodes.find((node) => node.path === "src")).not.toHaveProperty("hasChildren");
      expect(rootNodes.find((node) => node.path === "package.json")).not.toHaveProperty("size");
      expect(nestedNodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "index.ts",
            path: "src/index.ts",
            type: "file",
          }),
        ]),
      );
      expect(nestedNodes[0]).not.toHaveProperty("size");
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("returns the primary workspace first", () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-file-service-workspaces-"));
    const laneService = {
      resolveWorkspaceById: vi.fn(),
      getFilesWorkspaces: vi.fn(() => [
        {
          id: "lane-2",
          kind: "lane",
          laneId: "lane-2",
          name: "Lane 2",
          rootPath: path.join(rootPath, "lane-2"),
          isReadOnlyByDefault: false,
        },
        {
          id: "primary",
          kind: "primary",
          laneId: null,
          name: "Repo",
          rootPath,
          isReadOnlyByDefault: true,
        },
        {
          id: "lane-1",
          kind: "lane",
          laneId: "lane-1",
          name: "Lane 1",
          rootPath: path.join(rootPath, "lane-1"),
          isReadOnlyByDefault: false,
        },
      ]),
    } as any;
    const service = createFileService({ laneService });

    try {
      const workspaces = service.listWorkspaces();
      expect(workspaces.map((workspace) => workspace.id)).toEqual([
        "primary",
        "lane-2",
        "lane-1",
      ]);
      expect(workspaces.every((workspace) => workspace.mobileReadOnly === true)).toBe(true);
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });
});

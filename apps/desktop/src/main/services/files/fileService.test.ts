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

  it("returns an inline image preview for image files", () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-file-service-image-"));
    const laneService = createLaneServiceStub(rootPath);
    const service = createFileService({ laneService });

    try {
      const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      fs.writeFileSync(path.join(rootPath, "logo.png"), pngBytes);

      const result = service.readFile({
        workspaceId: "workspace-1",
        path: "logo.png",
      });

      expect(result).toMatchObject({
        content: pngBytes.toString("base64"),
        encoding: "base64",
        size: pngBytes.length,
        languageId: "image",
        isBinary: true,
        previewKind: "image",
        mimeType: "image/png",
      });
      expect(result.dataUrl).toBeUndefined();
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("omits oversized text and image payloads instead of sending them to the renderer", () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-file-service-large-"));
    const laneService = createLaneServiceStub(rootPath);
    const service = createFileService({ laneService });

    try {
      fs.writeFileSync(path.join(rootPath, "huge.ts"), "x".repeat(1024 * 1024 + 1), "utf8");
      fs.writeFileSync(path.join(rootPath, "huge.png"), Buffer.alloc(1024 * 1024 + 1, 1));

      const text = service.readFile({ workspaceId: "workspace-1", path: "huge.ts" });
      const image = service.readFile({ workspaceId: "workspace-1", path: "huge.png" });

      expect(text).toMatchObject({
        content: "",
        encoding: "utf-8",
        size: 1024 * 1024 + 1,
        languageId: "typescript",
        isBinary: true,
        previewKind: "binary",
        contentOmitted: true,
        omittedReason: "too_large",
      });
      expect(image).toMatchObject({
        content: "",
        encoding: "base64",
        size: 1024 * 1024 + 1,
        languageId: "image",
        isBinary: true,
        previewKind: "binary",
        mimeType: "image/png",
        contentOmitted: true,
        omittedReason: "too_large",
      });
      expect(image.dataUrl).toBeUndefined();
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("treats invalid non-null bytes as unsupported binary content", () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-file-service-binary-"));
    const laneService = createLaneServiceStub(rootPath);
    const service = createFileService({ laneService });

    try {
      const bytes = Buffer.from([0xff, 0xfe, 0xfd, 0xfc]);
      fs.writeFileSync(path.join(rootPath, "payload.bin"), bytes);

      const result = service.readFile({
        workspaceId: "workspace-1",
        path: "payload.bin",
      });

      expect(result).toMatchObject({
        content: bytes.toString("base64"),
        encoding: "base64",
        size: bytes.length,
        languageId: "plaintext",
        isBinary: true,
        previewKind: "binary",
        mimeType: "application/octet-stream",
      });
      expect(result.dataUrl).toBeUndefined();
    } finally {
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
      fs.mkdirSync(path.join(rootPath, ".ade", "notes"), { recursive: true });
      fs.mkdirSync(path.join(rootPath, "src"), { recursive: true });
      fs.writeFileSync(path.join(rootPath, ".ade", "notes", "project.md"), "# Project notes\nRenderer-safe content\n", "utf8");
      fs.writeFileSync(path.join(rootPath, "src", "index.ts"), "export const visible = true;\n", "utf8");

      const quickOpenDefault = await service.quickOpen({
        workspaceId: "workspace-1",
        query: "project",
        includeIgnored: false,
      });
      const quickOpenIgnored = await service.quickOpen({
        workspaceId: "workspace-1",
        query: "project",
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
      expect(quickOpenIgnored.map((item) => item.path)).toContain(".ade/notes/project.md");
      expect(searchDefault).toEqual([]);
      expect(searchIgnored.map((item) => item.path)).toContain(".ade/notes/project.md");
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("keeps useful dotfiles searchable while skipping volatile ADE runtime paths", async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-file-service-volatile-"));
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: rootPath, stdio: "ignore" });
    const laneService = createLaneServiceStub(rootPath);
    const service = createFileService({ laneService });

    try {
      fs.mkdirSync(path.join(rootPath, ".ade", "notes"), { recursive: true });
      fs.mkdirSync(path.join(rootPath, ".ade", "worktrees", "lane-a"), { recursive: true });
      fs.mkdirSync(path.join(rootPath, ".ade", "cache"), { recursive: true });
      fs.writeFileSync(path.join(rootPath, ".ade", "notes", "project.md"), "keep searchable\n", "utf8");
      fs.writeFileSync(path.join(rootPath, ".ade", "worktrees", "lane-a", "ghost.ts"), "hidden worktree payload\n", "utf8");
      fs.writeFileSync(path.join(rootPath, ".ade", "cache", "scratch.log"), "hidden cache payload\n", "utf8");

      const quickOpen = await service.quickOpen({
        workspaceId: "workspace-1",
        query: "ghost",
        includeIgnored: true,
      });
      const search = await service.searchText({
        workspaceId: "workspace-1",
        query: "payload",
        includeIgnored: true,
      });
      const notes = await service.searchText({
        workspaceId: "workspace-1",
        query: "searchable",
        includeIgnored: true,
      });
      const adeChildren = await service.listTree({
        workspaceId: "workspace-1",
        parentPath: ".ade",
        includeIgnored: true,
      });

      expect(quickOpen).toEqual([]);
      expect(search).toEqual([]);
      expect(notes.map((item) => item.path)).toEqual([".ade/notes/project.md"]);
      expect(adeChildren.map((node) => node.path)).toEqual([".ade/notes"]);
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("keeps generated output directories out of the file search index", async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-file-service-generated-search-"));
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: rootPath, stdio: "ignore" });
    const laneService = createLaneServiceStub(rootPath);
    const service = createFileService({ laneService });

    try {
      fs.mkdirSync(path.join(rootPath, "src"), { recursive: true });
      fs.mkdirSync(path.join(rootPath, "dist"), { recursive: true });
      fs.writeFileSync(path.join(rootPath, "src", "index.ts"), "needle source\n", "utf8");
      fs.writeFileSync(path.join(rootPath, "dist", "bundle.js"), "needle bundled output\n", "utf8");

      const quickOpen = await service.quickOpen({
        workspaceId: "workspace-1",
        query: "bundle",
        includeIgnored: true,
      });
      const search = await service.searchText({
        workspaceId: "workspace-1",
        query: "needle",
        includeIgnored: true,
      });

      expect(quickOpen).toEqual([]);
      expect(search.map((item) => item.path)).toEqual(["src/index.ts"]);
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
          branchRef: "refs/heads/lane-2",
          rootPath: path.join(rootPath, "lane-2"),
          isReadOnlyByDefault: false,
        },
        {
          id: "primary",
          kind: "primary",
          laneId: null,
          name: "Repo",
          branchRef: "refs/heads/main",
          rootPath,
          isReadOnlyByDefault: true,
        },
        {
          id: "lane-1",
          kind: "lane",
          laneId: "lane-1",
          name: "Lane 1",
          branchRef: "refs/heads/lane-1",
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

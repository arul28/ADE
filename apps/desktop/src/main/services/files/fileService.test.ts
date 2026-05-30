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

  it("preserves non-escape filesystem errors while resolving workspace paths", async () => {
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
      await expect(
        service.readFile({
          workspaceId: "workspace-1",
          path: "blocked/child.txt",
        })
      ).rejects.toThrow(permissionError);
    } finally {
      spy.mockRestore();
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("returns an inline image preview for image files", async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-file-service-image-"));
    const laneService = createLaneServiceStub(rootPath);
    const service = createFileService({ laneService });

    try {
      const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      fs.writeFileSync(path.join(rootPath, "logo.png"), pngBytes);

      const result = await service.readFile({
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

  it("streams oversized text as a partial first chunk and omits oversized images", async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-file-service-large-"));
    const laneService = createLaneServiceStub(rootPath);
    const service = createFileService({ laneService });

    try {
      const hugeSize = 1024 * 1024 + 1;
      fs.writeFileSync(path.join(rootPath, "huge.ts"), "x".repeat(hugeSize), "utf8");
      fs.writeFileSync(path.join(rootPath, "huge.png"), Buffer.alloc(hugeSize, 1));

      const text = await service.readFile({ workspaceId: "workspace-1", path: "huge.ts" });
      const image = await service.readFile({ workspaceId: "workspace-1", path: "huge.png" });

      // Oversized text now returns a streamable first chunk (not omitted).
      expect(text).toMatchObject({
        encoding: "utf-8",
        size: hugeSize,
        totalSize: hugeSize,
        languageId: "typescript",
        isBinary: false,
        previewKind: "text",
        isPartial: true,
        rangeStart: 0,
      });
      expect(text.contentOmitted).toBeUndefined();
      expect(text.content.length).toBeGreaterThan(0);
      expect(text.content.length).toBeLessThan(hugeSize);
      expect(text.nextOffset).toBe(text.rangeEnd);

      // Oversized images are still omitted.
      expect(image).toMatchObject({
        content: "",
        encoding: "base64",
        size: hugeSize,
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

  it("streams a file in UTF-8-safe byte ranges via readFileRange", async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-file-service-range-"));
    const laneService = createLaneServiceStub(rootPath);
    const service = createFileService({ laneService });

    try {
      // Multi-byte chars (é = 2 bytes) so a naive byte split would corrupt text.
      const unit = "café\n"; // 6 bytes
      const body = unit.repeat(1000);
      fs.writeFileSync(path.join(rootPath, "data.txt"), body, "utf8");
      const totalBytes = Buffer.byteLength(body, "utf8");

      let offset = 0;
      let assembled = "";
      let guard = 0;
      for (;;) {
        const page = await service.readFileRange({
          workspaceId: "workspace-1",
          path: "data.txt",
          offset,
          length: 101, // deliberately lands mid-character
        });
        expect(page.encoding).toBe("utf-8");
        assembled += page.content;
        if (page.nextOffset == null) {
          expect(page.eof).toBe(true);
          break;
        }
        expect(page.nextOffset).toBe(page.rangeEnd);
        offset = page.nextOffset;
        if (++guard > 10_000) throw new Error("readFileRange did not terminate");
      }

      expect(Buffer.byteLength(assembled, "utf8")).toBe(totalBytes);
      expect(assembled).toBe(body);
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("streams PDF byte ranges as base64 for every chunk", async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-file-service-pdf-range-"));
    const laneService = createLaneServiceStub(rootPath);
    const service = createFileService({ laneService });

    try {
      const pdfBytes = Buffer.concat([
        Buffer.from("%PDF-1.7\n", "utf8"),
        Buffer.from([0x00, 0xff, 0xd8, 0x11, 0x22, 0x33, 0x44, 0x55]),
        Buffer.alloc(96, 0x61),
      ]);
      fs.writeFileSync(path.join(rootPath, "report.pdf"), pdfBytes);

      let offset = 0;
      const chunks: Buffer[] = [];
      let guard = 0;
      for (;;) {
        const page = await service.readFileRange({
          workspaceId: "workspace-1",
          path: "report.pdf",
          offset,
          length: 7,
        });
        expect(page.encoding).toBe("base64");
        chunks.push(Buffer.from(page.content, "base64"));
        if (page.nextOffset == null) break;
        offset = page.nextOffset;
        if (++guard > 10_000) throw new Error("readFileRange did not terminate");
      }

      expect(Buffer.concat(chunks)).toEqual(pdfBytes);
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("returns per-line blame records", async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-file-service-blame-"));
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: rootPath, stdio: "ignore" });
    execSync("git config user.email test@example.com && git config user.name Tester", { cwd: rootPath, stdio: "ignore" });
    const laneService = createLaneServiceStub(rootPath);
    const service = createFileService({ laneService });

    try {
      fs.writeFileSync(path.join(rootPath, "a.txt"), "line one\nline two\n", "utf8");
      execSync("git add -A && git commit -m seed", { cwd: rootPath, stdio: "ignore" });

      const blame = await service.blame({ workspaceId: "workspace-1", path: "a.txt" });

      expect(blame.path).toBe("a.txt");
      expect(blame.lines).toHaveLength(2);
      expect(blame.lines[0]).toMatchObject({ line: 1, author: "Tester" });
      expect(blame.lines[1]).toMatchObject({ line: 2, author: "Tester" });
      expect(blame.lines[0].summary).toBe("seed");
      expect(blame.lines[0].sha).toMatch(/^[0-9a-f]{40}$/);
      expect(blame.lines[0].authorTime).toBeGreaterThan(0);
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("treats invalid non-null bytes as unsupported binary content", async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-file-service-binary-"));
    const laneService = createLaneServiceStub(rootPath);
    const service = createFileService({ laneService });

    try {
      const bytes = Buffer.from([0xff, 0xfe, 0xfd, 0xfc]);
      fs.writeFileSync(path.join(rootPath, "payload.bin"), bytes);

      const result = await service.readFile({
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

  it("preserves distinct git status labels in tree listings", async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-file-service-status-"));
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: rootPath, stdio: "ignore" });
    execSync("git config user.email test@example.com && git config user.name Test", { cwd: rootPath, stdio: "ignore" });
    const laneService = createLaneServiceStub(rootPath);
    const service = createFileService({ laneService });

    try {
      fs.writeFileSync(path.join(rootPath, "package.json"), "{\n  \"name\": \"fixture\"\n}\n", "utf8");
      execSync("git add package.json && git commit -m init", { cwd: rootPath, stdio: "ignore" });
      execSync("git mv package.json package-renamed.json", { cwd: rootPath, stdio: "ignore" });
      fs.writeFileSync(path.join(rootPath, "scratch.ts"), "export const value = 1;\n", "utf8");

      const rootNodes = await service.listTree({
        workspaceId: "workspace-1",
        depth: 1,
        includeIgnored: true,
        forceFreshStatus: true,
      });

      expect(rootNodes.find((node) => node.path === "package-renamed.json")?.changeStatus).toBe("renamed");
      expect(rootNodes.find((node) => node.path === "scratch.ts")?.changeStatus).toBe("untracked");
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("paginates directory children without dropping entries", async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-file-service-paginate-"));
    const laneService = createLaneServiceStub(rootPath);
    const service = createFileService({ laneService });

    try {
      fs.mkdirSync(path.join(rootPath, "data"), { recursive: true });
      const names = Array.from({ length: 5 }, (_, i) => `f${i}.txt`);
      for (const name of names) {
        fs.writeFileSync(path.join(rootPath, "data", name), "x", "utf8");
      }

      const page1 = await service.listTreeChildren({
        workspaceId: "workspace-1",
        parentPath: "data",
        offset: 0,
        limit: 2,
        includeIgnored: true,
      });
      const page2 = await service.listTreeChildren({
        workspaceId: "workspace-1",
        parentPath: "data",
        offset: page1.nextOffset ?? 0,
        limit: 2,
        includeIgnored: true,
      });
      const page3 = await service.listTreeChildren({
        workspaceId: "workspace-1",
        parentPath: "data",
        offset: page2.nextOffset ?? 0,
        limit: 2,
        includeIgnored: true,
      });

      expect(page1).toMatchObject({ total: 5, offset: 0, nextOffset: 2 });
      expect(page2).toMatchObject({ total: 5, offset: 2, nextOffset: 4 });
      expect(page3).toMatchObject({ total: 5, offset: 4, nextOffset: null });
      expect(page1.children).toHaveLength(2);
      expect(page2.children).toHaveLength(2);
      expect(page3.children).toHaveLength(1);

      // The union of pages covers every entry exactly once, in stable order.
      const collected = [...page1.children, ...page2.children, ...page3.children].map((node) => node.path);
      expect(collected).toEqual(names.map((name) => `data/${name}`));
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("orders directories before files within a page", async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-file-service-paginate-order-"));
    const laneService = createLaneServiceStub(rootPath);
    const service = createFileService({ laneService });

    try {
      fs.mkdirSync(path.join(rootPath, "root", "zeta-dir"), { recursive: true });
      fs.writeFileSync(path.join(rootPath, "root", "alpha.txt"), "x", "utf8");

      const page = await service.listTreeChildren({
        workspaceId: "workspace-1",
        parentPath: "root",
        includeIgnored: true,
      });

      expect(page.children.map((node) => ({ path: node.path, type: node.type }))).toEqual([
        { path: "root/zeta-dir", type: "directory" },
        { path: "root/alpha.txt", type: "file" },
      ]);
      expect(page.nextOffset).toBeNull();
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("resolves git decorations with file statuses and ancestor directories", async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-file-service-decorations-"));
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: rootPath, stdio: "ignore" });
    execSync("git config user.email test@example.com && git config user.name Test", { cwd: rootPath, stdio: "ignore" });
    const laneService = createLaneServiceStub(rootPath);
    const service = createFileService({ laneService });

    try {
      fs.mkdirSync(path.join(rootPath, "src", "nested"), { recursive: true });
      fs.writeFileSync(path.join(rootPath, "src", "nested", "deep.ts"), "export const a = 1;\n", "utf8");
      execSync("git add -A && git commit -m init", { cwd: rootPath, stdio: "ignore" });
      // Modify a deeply nested file so its ancestor directories roll up.
      fs.writeFileSync(path.join(rootPath, "src", "nested", "deep.ts"), "export const a = 2;\n", "utf8");

      const event = await service.refreshGitDecorations({
        workspaceId: "workspace-1",
        forceFresh: true,
      });

      const fileEntry = event.files.find((entry) => entry.path === "src/nested/deep.ts");
      expect(fileEntry?.changeStatus).toBe("modified");
      // Every ancestor directory of the changed file is decorated for free.
      const dirPaths = event.directories.map((entry) => entry.path);
      expect(dirPaths).toContain("src");
      expect(dirPaths).toContain("src/nested");
      expect(event.directories.every((entry) => entry.changeStatus === "modified")).toBe(true);
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("returns no decorations for a clean workspace", async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-file-service-clean-decorations-"));
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: rootPath, stdio: "ignore" });
    execSync("git config user.email test@example.com && git config user.name Test", { cwd: rootPath, stdio: "ignore" });
    const laneService = createLaneServiceStub(rootPath);
    const service = createFileService({ laneService });

    try {
      fs.writeFileSync(path.join(rootPath, "committed.ts"), "export const ok = true;\n", "utf8");
      execSync("git add -A && git commit -m init", { cwd: rootPath, stdio: "ignore" });

      const event = await service.refreshGitDecorations({
        workspaceId: "workspace-1",
        forceFresh: true,
      });

      expect(event.workspaceId).toBe("workspace-1");
      expect(event.files).toEqual([]);
      expect(event.directories).toEqual([]);
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
      fs.mkdirSync(path.join(rootPath, "lane-1"), { recursive: true });
      fs.mkdirSync(path.join(rootPath, "lane-2"), { recursive: true });
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

  it("does not list missing non-primary workspaces", () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-file-service-missing-workspaces-"));
    const laneRoot = path.join(rootPath, "lane-existing");
    const laneService = {
      resolveWorkspaceById: vi.fn(),
      getFilesWorkspaces: vi.fn(() => [
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
          id: "lane-existing",
          kind: "worktree",
          laneId: "lane-existing",
          name: "Existing lane",
          branchRef: "refs/heads/existing",
          rootPath: laneRoot,
          isReadOnlyByDefault: false,
        },
        {
          id: "lane-missing",
          kind: "worktree",
          laneId: "lane-missing",
          name: "Missing lane",
          branchRef: "refs/heads/missing",
          rootPath: path.join(rootPath, "missing"),
          isReadOnlyByDefault: false,
        },
      ]),
    } as any;
    const service = createFileService({ laneService });

    try {
      fs.mkdirSync(laneRoot, { recursive: true });
      expect(service.listWorkspaces().map((workspace) => workspace.id)).toEqual(["primary", "lane-existing"]);
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });
});

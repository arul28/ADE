import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createExternalFilesWorkspaceRegistry, createFileService } from "./fileService";
import { createFileSearchIndexService, parseGitGrepRecord,
  gitGrepArgs } from "./fileSearchIndexService";

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

function removeTestTree(rootPath: string): void {
  fs.rmSync(rootPath, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
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
      removeTestTree(rootPath);
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
      removeTestTree(rootPath);
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
      removeTestTree(rootPath);
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
      removeTestTree(rootPath);
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
      removeTestTree(rootPath);
    }
  });

  it("streams media and Office document byte ranges as base64 for every chunk", async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-file-service-binary-range-"));
    const laneService = createLaneServiceStub(rootPath);
    const service = createFileService({ laneService });

    try {
      for (const fileName of ["clip.mp4", "slides.pptx"]) {
        const bytes = Buffer.concat([
          Buffer.from([0x00, 0xff, 0x10, 0x20, 0x30]),
          Buffer.alloc(31, fileName.length),
        ]);
        fs.writeFileSync(path.join(rootPath, fileName), bytes);

        let offset = 0;
        const chunks: Buffer[] = [];
        for (;;) {
          const page = await service.readFileRange({
            workspaceId: "workspace-1",
            path: fileName,
            offset,
            length: 5,
          });
          expect(page.encoding).toBe("base64");
          chunks.push(Buffer.from(page.content, "base64"));
          if (page.nextOffset == null) break;
          offset = page.nextOffset;
        }

        expect(Buffer.concat(chunks)).toEqual(bytes);
      }
    } finally {
      removeTestTree(rootPath);
    }
  });

  it("streams generic binary byte ranges as base64 after the first chunk", async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-file-service-generic-binary-range-"));
    const laneService = createLaneServiceStub(rootPath);
    const service = createFileService({ laneService });

    try {
      const bytes = Buffer.concat([
        Buffer.from([0x00, 0xff, 0x10, 0x20, 0x30]),
        Buffer.alloc(30, 0x41),
      ]);
      fs.writeFileSync(path.join(rootPath, "archive.dat"), bytes);

      let offset = 0;
      const chunks: Buffer[] = [];
      for (;;) {
        const page = await service.readFileRange({
          workspaceId: "workspace-1",
          path: "archive.dat",
          offset,
          length: 5,
        });
        expect(page.encoding).toBe("base64");
        chunks.push(Buffer.from(page.content, "base64"));
        if (page.nextOffset == null) break;
        offset = page.nextOffset;
      }

      expect(Buffer.concat(chunks)).toEqual(bytes);
    } finally {
      removeTestTree(rootPath);
    }
  });

  it("registers external file and folder workspaces for explicit local opens", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-file-service-external-project-"));
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-file-service-external-root-"));
    const laneService = createLaneServiceStub(projectRoot);
    const externalWorkspaces = createExternalFilesWorkspaceRegistry();
    const service = createFileService({ laneService, externalWorkspaces });

    try {
      fs.writeFileSync(path.join(projectRoot, "inside.txt"), "inside", "utf8");
      fs.writeFileSync(path.join(externalRoot, "note.txt"), "hello", "utf8");
      laneService.getFilesWorkspaces.mockReturnValue([
        {
          id: "primary",
          kind: "primary",
          laneId: null,
          name: "Project",
          branchRef: "refs/heads/main",
          rootPath: projectRoot,
          isReadOnlyByDefault: true,
        },
      ]);

      const projectFileOpen = await service.openExternalPath({ path: path.join(projectRoot, "inside.txt") });
      expect(projectFileOpen.pathType).toBe("file");
      expect(projectFileOpen.openPath).toBe("inside.txt");
      expect(projectFileOpen.workspace).toMatchObject({
        id: "primary",
        kind: "primary",
        rootPath: projectRoot,
      });
      expect(externalWorkspaces.list()).toEqual([]);

      const fileOpen = await service.openExternalPath({ path: path.join(externalRoot, "note.txt") });
      expect(fileOpen.pathType).toBe("file");
      expect(fileOpen.openPath).toBe("note.txt");
      expect(fileOpen.workspace).toMatchObject({
        kind: "external",
        rootPath: fs.realpathSync(externalRoot),
        mobileReadOnly: true,
      });

      const directoryOpen = await service.openExternalPath({ path: externalRoot });
      expect(directoryOpen.pathType).toBe("directory");
      expect(directoryOpen.openPath).toBeNull();
      expect(directoryOpen.workspace.id).toBe(fileOpen.workspace.id);
      expect(service.listWorkspaces().some((workspace) => workspace.id === fileOpen.workspace.id)).toBe(true);
    } finally {
      removeTestTree(projectRoot);
      removeTestTree(externalRoot);
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
      removeTestTree(rootPath);
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
      removeTestTree(rootPath);
    }
  });

  it("browses the workspace shallowest-first when quick open gets an empty query", async () => {
    // A bare `@` in any composer (desktop, TUI, iOS, web) sends query "".
    // That must return a navigable list, not nothing.
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-file-service-quick-open-browse-"));
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: rootPath, stdio: "ignore" });
    const laneService = createLaneServiceStub(rootPath);
    const service = createFileService({ laneService });

    try {
      fs.mkdirSync(path.join(rootPath, "src", "deep", "deeper"), { recursive: true });
      fs.writeFileSync(path.join(rootPath, "README.md"), "# root\n", "utf8");
      fs.writeFileSync(path.join(rootPath, "src", "index.ts"), "export const a = 1;\n", "utf8");
      fs.writeFileSync(path.join(rootPath, "src", "deep", "deeper", "buried.ts"), "export const b = 2;\n", "utf8");

      const browsed = await service.quickOpen({ workspaceId: "workspace-1", query: "" });
      const paths = browsed.map((item) => item.path);

      expect(paths).toContain("README.md");
      expect(paths).toContain("src/index.ts");
      expect(paths).toContain("src/deep/deeper/buried.ts");
      // Shallower paths outrank deeper ones so the browse list opens at the top
      // of the tree rather than in some arbitrary nested directory.
      expect(paths.indexOf("README.md")).toBeLessThan(paths.indexOf("src/index.ts"));
      expect(paths.indexOf("src/index.ts")).toBeLessThan(paths.indexOf("src/deep/deeper/buried.ts"));
      // Whitespace-only is the same browse request, not a distinct query.
      const whitespace = await service.quickOpen({ workspaceId: "workspace-1", query: "   " });
      expect(whitespace.map((item) => item.path)).toEqual(paths);
    } finally {
      removeTestTree(rootPath);
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
      removeTestTree(rootPath);
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
      removeTestTree(rootPath);
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
      removeTestTree(rootPath);
    }
  });

  it("matches an extensionless path with spaces before trailing prose", async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-file-service-spaced-path-"));
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: rootPath, stdio: "ignore" });
    const laneService = createLaneServiceStub(rootPath);
    const service = createFileService({ laneService });

    try {
      fs.mkdirSync(path.join(rootPath, "src"), { recursive: true });
      fs.writeFileSync(path.join(rootPath, "src", "my folder"), "extensionless path\n", "utf8");

      const quickOpen = await service.quickOpen({
        workspaceId: "workspace-1",
        query: "src/my folder about this",
        includeIgnored: true,
        allowComposerPrefixFallback: true,
      });

      expect(quickOpen.map((item) => item.path)).toContain("src/my folder");
    } finally {
      removeTestTree(rootPath);
    }
  });

  it("matches a root-level spaced extensionless file before trailing prose", async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-file-service-root-spaced-prose-"));
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: rootPath, stdio: "ignore" });
    const laneService = createLaneServiceStub(rootPath);
    const service = createFileService({ laneService });

    try {
      fs.writeFileSync(path.join(rootPath, "my file"), "extensionless root file\n", "utf8");

      const quickOpen = await service.quickOpen({
        workspaceId: "workspace-1",
        query: "my file review this",
        includeIgnored: true,
        allowComposerPrefixFallback: true,
      });

      expect(quickOpen.map((item) => item.path)).toContain("my file");
    } finally {
      removeTestTree(rootPath);
    }
  });

  it("matches a nested extensionless basename before trailing prose", async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-file-service-nested-basename-prose-"));
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: rootPath, stdio: "ignore" });
    const laneService = createLaneServiceStub(rootPath);
    const service = createFileService({ laneService });

    try {
      fs.mkdirSync(path.join(rootPath, "docs"), { recursive: true });
      fs.writeFileSync(path.join(rootPath, "docs", "README"), "nested extensionless file\n", "utf8");

      const quickOpen = await service.quickOpen({
        workspaceId: "workspace-1",
        query: "README review this",
        includeIgnored: true,
        allowComposerPrefixFallback: true,
      });

      expect(quickOpen.map((item) => item.path)).toContain("docs/README");
    } finally {
      removeTestTree(rootPath);
    }
  });

  it("keeps composer prefix fallback out of generic quickOpen", async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-file-service-generic-prefix-"));
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: rootPath, stdio: "ignore" });
    const laneService = createLaneServiceStub(rootPath);
    const service = createFileService({ laneService });

    try {
      fs.writeFileSync(path.join(rootPath, "package.json"), "{}\n", "utf8");

      const generic = await service.quickOpen({
        workspaceId: "workspace-1",
        query: "package manager",
        includeIgnored: true,
      });
      const composer = await service.quickOpen({
        workspaceId: "workspace-1",
        query: "package manager",
        includeIgnored: true,
        allowComposerPrefixFallback: true,
      });

      expect(generic.map((item) => item.path)).not.toContain("package.json");
      expect(composer.map((item) => item.path)).toContain("package.json");
    } finally {
      removeTestTree(rootPath);
    }
  });

  it("warms the quick open index for subsequent lookups", async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-file-service-warm-search-"));
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: rootPath, stdio: "ignore" });
    const laneService = createLaneServiceStub(rootPath);
    const service = createFileService({ laneService });

    try {
      fs.mkdirSync(path.join(rootPath, "src"), { recursive: true });
      fs.writeFileSync(path.join(rootPath, "src", "warmTarget.ts"), "export const warmed = true;\n", "utf8");

      await expect(service.warmQuickOpenIndex({ workspaceId: "workspace-1" })).resolves.toBeUndefined();

      const readdirSync = vi.spyOn(fs, "readdirSync").mockImplementation((() => {
        throw new Error("quickOpen should use the warmed index");
      }) as typeof fs.readdirSync);
      try {
        const quickOpen = await service.quickOpen({
          workspaceId: "workspace-1",
          query: "warmTarget",
        });

        expect(quickOpen).toEqual([expect.objectContaining({ path: "src/warmTarget.ts" })]);
        expect(readdirSync).not.toHaveBeenCalled();
      } finally {
        readdirSync.mockRestore();
      }
    } finally {
      removeTestTree(rootPath);
    }
  });

  it("swallows warmQuickOpenIndex errors for unknown workspaces", async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-file-service-warm-missing-"));
    const laneService = {
      ...createLaneServiceStub(rootPath),
      resolveWorkspaceById: vi.fn(() => {
        throw new Error("unknown workspace");
      }),
    } as any;
    const service = createFileService({ laneService });

    try {
      await expect(service.warmQuickOpenIndex({ workspaceId: "missing" })).resolves.toBeUndefined();
      expect(laneService.resolveWorkspaceById).toHaveBeenCalledWith("missing");
    } finally {
      removeTestTree(rootPath);
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
      removeTestTree(rootPath);
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
      removeTestTree(rootPath);
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
      removeTestTree(rootPath);
    }
  });

  it("writes workspace text atomically for any resolved workspace and reports real failures", async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-file-service-write-"));
    const laneService = createLaneServiceStub(rootPath);
    const service = createFileService({ laneService });

    try {
      fs.mkdirSync(path.join(rootPath, "docs"), { recursive: true });
      fs.writeFileSync(path.join(rootPath, "docs", "notes.md"), "# old\n", "utf8");

      // Immediate save path: no trust step, no read-only gate, atomic replace.
      service.writeWorkspaceText({ workspaceId: "workspace-1", path: "docs/notes.md", text: "# new\n" });
      expect(fs.readFileSync(path.join(rootPath, "docs", "notes.md"), "utf8")).toBe("# new\n");

      // Honest failure: an unwritable directory surfaces the filesystem error
      // instead of claiming success. Permission bits do not constrain root
      // (CAP_DAC_OVERRIDE in containerized CI) and chmod is a no-op on
      // Windows, so this branch only runs for unprivileged POSIX users.
      if (process.platform !== "win32" && process.getuid?.() !== 0) {
        const locked = path.join(rootPath, "locked");
        fs.mkdirSync(locked, { recursive: true });
        fs.writeFileSync(path.join(locked, "file.txt"), "x", "utf8");
        fs.chmodSync(locked, 0o500);
        try {
          expect(() =>
            service.writeWorkspaceText({ workspaceId: "workspace-1", path: "locked/file.txt", text: "y" }),
          ).toThrow(/EACCES|EPERM|permission/i);
          expect(fs.readFileSync(path.join(locked, "file.txt"), "utf8")).toBe("x");
        } finally {
          fs.chmodSync(locked, 0o700);
        }
      }
    } finally {
      removeTestTree(rootPath);
    }
  });

  it("refuses writes that escape the workspace root or touch .git internals", async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-file-service-write-safety-"));
    const laneService = createLaneServiceStub(rootPath);
    const service = createFileService({ laneService });

    try {
      fs.mkdirSync(path.join(rootPath, ".git"), { recursive: true });
      expect(() =>
        service.writeWorkspaceText({ workspaceId: "workspace-1", path: "../outside.txt", text: "nope" }),
      ).toThrow();
      expect(() =>
        service.writeWorkspaceText({ workspaceId: "workspace-1", path: ".git/config", text: "nope" }),
      ).toThrow(/\.git/i);
      expect(fs.existsSync(path.join(path.dirname(rootPath), "outside.txt"))).toBe(false);
    } finally {
      removeTestTree(rootPath);
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
      removeTestTree(rootPath);
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
      removeTestTree(rootPath);
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
      removeTestTree(rootPath);
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
      removeTestTree(rootPath);
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
      removeTestTree(rootPath);
    }
  });
});

// fileSearchIndexService is an internal helper consumed only by fileService,
// so its contract tests live here with the parent module's suite.
const shouldIgnore = vi.fn(async () => false);
const primeIgnoreCache = vi.fn(async () => undefined);

function createTempWorkspace(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Whether a usable git is on PATH. The production code resolves git carefully
 * (see `resolveGitExecutable`); a test that hard-codes the bare name throws an
 * opaque ENOENT out of a helper on a host without it and takes the whole suite
 * with it. The JS-fallback tests below use `breakGitWorkTree` instead and stay
 * unconditional, so the fallback path keeps its coverage either way.
 */
const hasGit = ((): boolean => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** Make `rootPath` a real work tree so content search takes the `git grep` tier. */
function initGitWorkTree(rootPath: string): void {
  execFileSync("git", ["init", "-q", rootPath], { stdio: "ignore" });
}

/**
 * Make `rootPath` a directory git refuses to work in. A `.git` file pointing at
 * a missing gitdir both fails `rev-parse` and stops discovery from walking up
 * into whatever repository happens to own the OS temp directory, so the JS
 * fallback tier is exercised deterministically on any machine.
 */
function breakGitWorkTree(rootPath: string): void {
  fs.writeFileSync(path.join(rootPath, ".git"), "gitdir: /ade-nonexistent-gitdir\n", "utf8");
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

  it("waits for an in-flight build so quickOpen never caches a partial index", async () => {
    const rootPath = createTempWorkspace("ade-file-index-inflight-build-");
    const service = createFileSearchIndexService();

    try {
      for (let i = 0; i < 10; i += 1) {
        fs.writeFileSync(path.join(rootPath, `alpha-${i}.ts`), `export const v${i} = ${i};\n`, "utf8");
      }
      // Slow the walk down so the quickOpen below is issued mid-build.
      const slowIgnore = vi.fn(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        return false;
      });

      const warm = service.ensureIndexed({
        workspaceId: "workspace-1",
        rootPath,
        includeIgnored: false,
        shouldIgnore: slowIgnore,
      });
      const matches = await service.quickOpen({
        workspaceId: "workspace-1",
        rootPath,
        query: "alpha",
        limit: 20,
        includeIgnored: false,
        shouldIgnore: slowIgnore,
        primeIgnoreCache,
      });
      expect(matches).toHaveLength(10);

      await warm;
      const cached = await service.quickOpen({
        workspaceId: "workspace-1",
        rootPath,
        query: "alpha",
        limit: 20,
        includeIgnored: false,
        shouldIgnore: slowIgnore,
        primeIgnoreCache,
      });
      expect(cached).toHaveLength(10);
    } finally {
      service.dispose();
      removeTestTree(rootPath);
    }
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
      removeTestTree(rootPath);
    }
  });

  it.skipIf(!hasGit)("greps a git work tree without reading files or building the name index", async () => {
    const rootPath = createTempWorkspace("ade-file-index-git-grep-");
    initGitWorkTree(rootPath);
    const service = createFileSearchIndexService();

    try {
      fs.mkdirSync(path.join(rootPath, "notes"), { recursive: true });
      fs.writeFileSync(path.join(rootPath, "notes", "plan.md"), "alpha\nfind Lazy Needle here\n", "utf8");
      const readFile = vi.spyOn(fs.promises, "readFile");
      const readFileSync = vi.spyOn(fs, "readFileSync");

      const matches = await service.searchText({
        workspaceId: "workspace-1",
        rootPath,
        query: "lazy needle",
        limit: 10,
        includeIgnored: false,
        shouldIgnore,
        primeIgnoreCache,
      });

      expect(matches).toEqual([
        { path: "notes/plan.md", line: 2, column: 6, preview: "find Lazy Needle here" },
      ]);
      // The whole point of tier 1: no file bytes cross into this process, and
      // the name-index walk never runs.
      expect(readFile).not.toHaveBeenCalled();
      expect(readFileSync).not.toHaveBeenCalled();
      expect(shouldIgnore).not.toHaveBeenCalled();
    } finally {
      service.dispose();
      removeTestTree(rootPath);
    }
  });

  it.skipIf(!hasGit)("treats a git grep exit code of 1 as no matches rather than a failure", async () => {
    const rootPath = createTempWorkspace("ade-file-index-git-no-match-");
    initGitWorkTree(rootPath);
    const service = createFileSearchIndexService();

    try {
      for (let i = 0; i < 20; i += 1) {
        fs.writeFileSync(path.join(rootPath, `file-${i}.ts`), `export const v${i} = ${i};\n`, "utf8");
      }
      const readFile = vi.spyOn(fs.promises, "readFile");

      await expect(service.searchText({
        workspaceId: "workspace-1",
        rootPath,
        query: "zzz-nothing-matches-this-zzz",
        limit: 10,
        includeIgnored: false,
        shouldIgnore,
        primeIgnoreCache,
      })).resolves.toEqual([]);

      // Exit 1 is git's "no matches", which is a complete answer. Reading a
      // single file here would mean it had been mistaken for a failure and the
      // whole workspace re-scanned in JS.
      expect(readFile).not.toHaveBeenCalled();
    } finally {
      service.dispose();
      removeTestTree(rootPath);
    }
  });

  it.skipIf(!hasGit)("matches regex metacharacters literally in both search tiers", async () => {
    const gitRoot = createTempWorkspace("ade-file-index-meta-git-");
    const plainRoot = createTempWorkspace("ade-file-index-meta-plain-");
    initGitWorkTree(gitRoot);
    breakGitWorkTree(plainRoot);
    const service = createFileSearchIndexService();

    try {
      for (const root of [gitRoot, plainRoot]) {
        fs.writeFileSync(path.join(root, "meta.txt"), "axbxxc\na.b*c\ncall foo(bar)\n", "utf8");
      }

      for (const [workspaceId, rootPath] of [["workspace-git", gitRoot], ["workspace-plain", plainRoot]] as const) {
        await expect(service.searchText({
          workspaceId,
          rootPath,
          query: "a.b*c",
          limit: 10,
          includeIgnored: false,
          shouldIgnore,
          primeIgnoreCache,
        })).resolves.toEqual([
          { path: "meta.txt", line: 2, column: 1, preview: "a.b*c" },
        ]);

        await expect(service.searchText({
          workspaceId,
          rootPath,
          query: "foo(",
          limit: 10,
          includeIgnored: false,
          shouldIgnore,
          primeIgnoreCache,
        })).resolves.toEqual([
          { path: "meta.txt", line: 3, column: 6, preview: "call foo(bar)" },
        ]);
      }
    } finally {
      service.dispose();
      removeTestTree(gitRoot);
      removeTestTree(plainRoot);
    }
  });

  it.skipIf(!hasGit)("falls back to the JS scan with the same results when git cannot answer", async () => {
    const gitRoot = createTempWorkspace("ade-file-index-parity-git-");
    const plainRoot = createTempWorkspace("ade-file-index-parity-plain-");
    initGitWorkTree(gitRoot);
    // A `.git` pointing nowhere is what an unusable repo looks like to
    // `rev-parse`, so this pins the fallback without depending on where the
    // OS put its temp directory.
    breakGitWorkTree(plainRoot);
    const service = createFileSearchIndexService();

    try {
      for (const root of [gitRoot, plainRoot]) {
        fs.mkdirSync(path.join(root, "src", "nested"), { recursive: true });
        fs.writeFileSync(path.join(root, "src", "one.ts"), "const needle = 1;\nconst other = 2;\n", "utf8");
        fs.writeFileSync(path.join(root, "src", "nested", "two.ts"), "// NEEDLE in a comment\n", "utf8");
        fs.writeFileSync(path.join(root, "README.md"), "no match here\n", "utf8");
        // Both tiers must skip binaries: git via -I, the JS scan via its null
        // byte probe.
        fs.writeFileSync(path.join(root, "blob.bin"), Buffer.from([0x6e, 0x00, 0x65, 0x65, 0x64, 0x6c, 0x65]));
      }

      const sorted = (matches: { path: string; line: number }[]) =>
        [...matches].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);

      const viaGit = await service.searchText({
        workspaceId: "workspace-git",
        rootPath: gitRoot,
        query: "needle",
        limit: 50,
        includeIgnored: false,
        shouldIgnore,
        primeIgnoreCache,
      });
      const viaScan = await service.searchText({
        workspaceId: "workspace-plain",
        rootPath: plainRoot,
        query: "needle",
        limit: 50,
        includeIgnored: false,
        shouldIgnore,
        primeIgnoreCache,
      });

      expect(sorted(viaGit)).toEqual([
        { path: "src/nested/two.ts", line: 1, column: 4, preview: "// NEEDLE in a comment" },
        { path: "src/one.ts", line: 1, column: 7, preview: "const needle = 1;" },
      ]);
      expect(sorted(viaScan)).toEqual(sorted(viaGit));
    } finally {
      service.dispose();
      removeTestTree(gitRoot);
      removeTestTree(plainRoot);
    }
  });

  it.skipIf(!hasGit)("widens a git grep to ignored files only when includeIgnored is set", async () => {
    const rootPath = createTempWorkspace("ade-file-index-git-ignored-");
    initGitWorkTree(rootPath);
    const service = createFileSearchIndexService();

    try {
      fs.mkdirSync(path.join(rootPath, "build"), { recursive: true });
      fs.writeFileSync(path.join(rootPath, ".gitignore"), "build/\n", "utf8");
      fs.writeFileSync(path.join(rootPath, "build", "out.js"), "needle in ignored output\n", "utf8");
      fs.writeFileSync(path.join(rootPath, "src.js"), "needle in tracked source\n", "utf8");

      const search = (includeIgnored: boolean) => service.searchText({
        workspaceId: `workspace-${includeIgnored ? "all" : "default"}`,
        rootPath,
        query: "needle",
        limit: 10,
        includeIgnored,
        shouldIgnore,
        primeIgnoreCache,
      });

      expect((await search(false)).map((match) => match.path)).toEqual(["src.js"]);
      expect((await search(true)).map((match) => match.path).sort()).toEqual(["build/out.js", "src.js"]);
    } finally {
      service.dispose();
      removeTestTree(rootPath);
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
      removeTestTree(rootPath);
    }
  });

  it("never retains file contents across JS-scan searches", async () => {
    const rootPath = createTempWorkspace("ade-file-index-no-retention-");
    breakGitWorkTree(rootPath);
    const service = createFileSearchIndexService();
    const fileCount = 12;

    try {
      for (let i = 0; i < fileCount; i += 1) {
        fs.writeFileSync(path.join(rootPath, `doc-${i}.txt`), `line one ${i}\nline two ${i}\n`, "utf8");
      }
      const readFile = vi.spyOn(fs.promises, "readFile");
      const docReadCount = () => readFile.mock.calls
        .filter(([target]) => String(target).includes(`${path.sep}doc-`)).length;

      const runNoMatchSearch = () => service.searchText({
        workspaceId: "workspace-1",
        rootPath,
        query: "zzz-nothing-matches-this-zzz",
        limit: 50,
        includeIgnored: false,
        shouldIgnore,
        primeIgnoreCache,
      });

      await expect(runNoMatchSearch()).resolves.toEqual([]);
      // Exactly once per file, not once per file per pass: the scan may not
      // read anything twice inside a single search.
      expect(docReadCount()).toBe(fileCount);

      readFile.mockClear();
      await expect(runNoMatchSearch()).resolves.toEqual([]);
      // Re-reading is the proof that nothing was kept. The old index cached
      // every decoded line here, which is what exhausted the heap.
      expect(docReadCount()).toBe(fileCount);
    } finally {
      service.dispose();
      removeTestTree(rootPath);
    }
  });

  it("parses git grep records whose path or text contains colons", () => {
    expect(parseGitGrepRecord("src/a.ts\u000012\u0000const url = \"http://x:8080\";")).toEqual({
      path: "src/a.ts",
      line: 12,
      text: "const url = \"http://x:8080\";",
    });
    // Older git only replaced the delimiter after the path.
    expect(parseGitGrepRecord("we:ird/a.ts\u00007:time: 10:30")).toEqual({
      path: "we:ird/a.ts",
      line: 7,
      text: "time: 10:30",
    });
    // No NUL at all: only the first two colons are separators.
    expect(parseGitGrepRecord("src/a.ts:3:a:b:c")).toEqual({
      path: "src/a.ts",
      line: 3,
      text: "a:b:c",
    });
    expect(parseGitGrepRecord("not a grep record")).toBeNull();
  });

  it.skipIf(!hasGit)("searches a file the JS tier skips for size, and says so on purpose", async () => {
    // The two tiers are not identical and it is better to pin that than to let
    // it drift: git has no size cap, while the JS scan skips anything over
    // MAX_TEXT_FILE_BYTES so one huge file cannot be read whole into memory.
    const rootPath = createTempWorkspace("ade-files-bigfile-");
    initGitWorkTree(rootPath);
    const filler = "x".repeat(64);
    const big = `${Array.from({ length: 20_000 }, () => filler).join("\n")}\nneedle_in_big_file\n`;
    fs.writeFileSync(path.join(rootPath, "big.txt"), big, "utf8");
    expect(fs.statSync(path.join(rootPath, "big.txt")).size).toBeGreaterThan(1_000_000);

    // Same content in a non-git workspace: the JS tier skips the oversized file.
    // A separate root rather than removing `.git`, which `git init` made a
    // directory that `breakGitWorkTree`'s file write cannot replace.
    const fallbackRoot = createTempWorkspace("ade-files-bigfile-nogit-");
    breakGitWorkTree(fallbackRoot);
    fs.writeFileSync(path.join(fallbackRoot, "big.txt"), big, "utf8");
    const service = createFileSearchIndexService();
    const fallbackService = createFileSearchIndexService();
    try {
      const gitMatches = await service.searchText({
        workspaceId: "ws-big",
        rootPath,
        query: "needle_in_big_file",
        limit: 10,
        includeIgnored: false,
        shouldIgnore,
        primeIgnoreCache,
      });
      expect(gitMatches).toHaveLength(1);

      const fallbackMatches = await fallbackService.searchText({
        workspaceId: "ws-big-fallback",
        rootPath: fallbackRoot,
        query: "needle_in_big_file",
        limit: 10,
        includeIgnored: false,
        shouldIgnore,
        primeIgnoreCache,
      });
      expect(fallbackMatches).toHaveLength(0);
    } finally {
      // Two roots each holding a >1 MB file; a failed assertion must not leave
      // them (or the services) behind on a CI runner.
      service.dispose();
      fallbackService.dispose();
      removeTestTree(rootPath);
      removeTestTree(fallbackRoot);
    }
  });

  it("builds a git grep argv that a Windows shell cannot re-interpret", () => {
    // Windows is where this bites: if the query ever reached a cmd.exe wrapper
    // it would expand %VAR%, eat quotes, and read a leading `-` as a flag. The
    // argv array is the defence, so pin its shape.
    const args = gitGrepArgs({ query: "-rf %PATH% \"quoted\" a.b*c", limit: 25, includeIgnored: false });

    // `-F` makes the query literal; `-e` + `--` keep it out of flag position.
    expect(args).toContain("-F");
    const eIndex = args.indexOf("-e");
    expect(eIndex).toBeGreaterThan(-1);
    expect(args[eIndex + 1]).toBe("-rf %PATH% \"quoted\" a.b*c");
    expect(args.indexOf("--")).toBeGreaterThan(eIndex);
    // The query is one argv entry, never split or re-quoted.
    expect(args.filter((a) => a.includes("%PATH%"))).toHaveLength(1);
  });

  it("only widens to ignored files when asked", () => {
    const strict = gitGrepArgs({ query: "needle", limit: 10, includeIgnored: false });
    const wide = gitGrepArgs({ query: "needle", limit: 10, includeIgnored: true });
    expect(strict).not.toContain("--no-exclude-standard");
    expect(wide).toContain("--no-exclude-standard");
    // Untracked files are searched either way — a file an agent just wrote is
    // the common case and is not committed yet.
    expect(strict).toContain("--untracked");
    expect(wide).toContain("--untracked");
  });
});

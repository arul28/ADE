/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { editor as monacoEditor } from "monaco-editor";
import type { FileChangeEvent, FileContent, FileTreeNode } from "../../../shared/types";
import { FilesPage } from "./FilesPage";
import { useAppStore } from "../../state/appStore";

type MockEditorInstance = {
  setModel: (next: any) => void;
  getValue: () => string;
  setValue: (next: string) => void;
  revealLineInCenter: ReturnType<typeof vi.fn>;
  setPosition: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  updateOptions: ReturnType<typeof vi.fn>;
  onDidChangeModelContent: (cb: () => void) => { dispose: ReturnType<typeof vi.fn> };
  dispose: ReturnType<typeof vi.fn>;
};

let latestMockEditor: MockEditorInstance | null = null;
let createdMockEditors: MockEditorInstance[] = [];
const adeDiffViewerMock = vi.hoisted(() => ({
  getModifiedValue: vi.fn(() => ""),
  revealLineInCenter: vi.fn(),
}));

vi.mock("../lanes/MonacoDiffView", () => ({
  MonacoDiffView: () => <div data-testid="monaco-diff" />,
}));

vi.mock("../shared/AdeDiffViewer", async () => {
  const React = await import("react");
  const AdeDiffViewer = React.forwardRef((_props: any, ref: any) => {
    React.useImperativeHandle(ref, () => ({
      getModifiedValue: adeDiffViewerMock.getModifiedValue,
      revealLineInCenter: adeDiffViewerMock.revealLineInCenter,
    }));
    return React.createElement("div", { "data-testid": "ade-diff-viewer" });
  });
  AdeDiffViewer.displayName = "MockAdeDiffViewer";
  return { AdeDiffViewer };
});

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => {
    const size = estimateSize();
    return {
      getTotalSize: () => count * size,
      getVirtualItems: () => Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        size,
        start: index * size,
      })),
    };
  },
}));

vi.mock("monaco-editor/esm/vs/editor/editor.worker?worker", () => ({
  default: class MockEditorWorker {},
}));

vi.mock("monaco-editor/esm/vs/language/typescript/ts.worker?worker", () => ({
  default: class MockTsWorker {},
}));

vi.mock("monaco-editor", () => {
  const createModel = (value: string, language: string) => ({
    value,
    language,
    dispose: vi.fn(),
  });

  return {
    editor: {
      create: vi.fn((element: HTMLElement) => {
        let model: ReturnType<typeof createModel> | null = null;
        let onChange: (() => void) | null = null;
        element.setAttribute("data-testid", "mock-monaco-editor");
        latestMockEditor = {
          setModel(next: ReturnType<typeof createModel> | null) {
            model = next;
            element.textContent = next?.value ?? "";
          },
          getValue() {
            return model?.value ?? "";
          },
          setValue(next: string) {
            if (model) model.value = next;
            element.textContent = next;
            onChange?.();
          },
          revealLineInCenter: vi.fn(),
          setPosition: vi.fn(),
          focus: vi.fn(),
          updateOptions: vi.fn(),
          onDidChangeModelContent(cb: () => void) {
            onChange = cb;
            return { dispose: vi.fn() };
          },
          dispose: vi.fn(),
        };
        createdMockEditors.push(latestMockEditor);
        return latestMockEditor;
      }),
      createModel: vi.fn(createModel),
      setTheme: vi.fn(),
    },
  };
});

const visibleTree: FileTreeNode[] = [
  {
    name: "src",
    path: "src",
    type: "directory",
    children: [
      {
        name: "index.ts",
        path: "src/index.ts",
        type: "file",
      },
    ],
  },
];

const ignoredTree: FileTreeNode[] = [
  ...visibleTree,
  {
    name: ".ade",
    path: ".ade",
    type: "directory",
    children: [
      {
        name: "notes",
        path: ".ade/notes",
        type: "directory",
      },
    ],
  },
];

let currentTree: FileTreeNode[] = [];
let fileContents: Record<string, string> = {};
let fileReadOverrides: Record<string, FileContent> = {};
let changeListener: ((event: FileChangeEvent) => void) | null = null;
let projectRoot = "";
let projectCounter = 0;

function cloneTree(nodes: FileTreeNode[]): FileTreeNode[] {
  return nodes.map((node) => ({
    ...node,
    children: node.children ? cloneTree(node.children) : node.children,
  }));
}

function findNode(nodes: FileTreeNode[], targetPath: string): FileTreeNode | null {
  for (const node of nodes) {
    if (node.path === targetPath) return node;
    if (node.children?.length) {
      const found = findNode(node.children, targetPath);
      if (found) return found;
    }
  }
  return null;
}

function listTreeForRequest(parentPath?: string, includeIgnored?: boolean): FileTreeNode[] {
  const source = includeIgnored ? currentTree : visibleTree;
  if (!parentPath) return cloneTree(source);
  return cloneTree(findNode(source, parentPath)?.children ?? []);
}

function emitFileChange(event: FileChangeEvent) {
  act(() => {
    changeListener?.(event);
  });
}

function resetStore() {
  useAppStore.setState({
    project: { rootPath: projectRoot, name: "ADE" } as any,
    projectHydrated: true,
    showWelcome: false,
    selectedLaneId: null,
    focusedSessionId: null,
    lanes: [],
    laneInspectorTabs: {},
    terminalAttention: {
      runningCount: 0,
      activeCount: 0,
      needsAttentionCount: 0,
      indicator: "none",
      byLaneId: {},
    },
    workViewByProject: {},
    laneWorkViewByScope: {},
  });
}

function LanesNavCapture() {
  const loc = useLocation();
  return <div data-testid="lanes-nav">{`${loc.pathname}${loc.search}`}</div>;
}

function renderFilesPage(initialState?: Record<string, unknown>, props?: React.ComponentProps<typeof FilesPage>) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/files", state: initialState }]}>
      <Routes>
        <Route path="/files" element={<FilesPage {...props} />} />
        <Route path="/lanes" element={<LanesNavCapture />} />
      </Routes>
    </MemoryRouter>,
  );
}

function useLaneWorkspace(laneId = "lane-diff") {
  useAppStore.setState({
    selectedLaneId: laneId,
    lanes: [{ id: laneId, name: "Diff lane", branchRef: "refs/heads/feat/diff" }] as any,
  });
  vi.mocked(window.ade.files.listWorkspaces).mockResolvedValue([
    {
      id: "primary",
      kind: "primary",
      laneId: null,
      name: "ADE",
      branchRef: "refs/heads/main",
      rootPath: projectRoot,
      isReadOnlyByDefault: false,
    },
    {
      id: "lane-ws",
      kind: "worktree",
      laneId,
      name: "Diff lane",
      branchRef: "refs/heads/feat/diff",
      rootPath: `${projectRoot}/.ade/worktrees/diff-lane`,
      isReadOnlyByDefault: false,
    },
  ]);
}

async function waitForEditorText(text: string) {
  await waitFor(() => {
    expect(screen.getByTestId("mock-monaco-editor").textContent).toContain(text);
  });
}

async function waitForFilesWatcherStartup() {
  await waitFor(() => {
    expect((window.ade.files.watchChanges as any).mock.calls.length).toBeGreaterThan(0);
  });
}

async function switchOpenLaneFileToDiff(laneId: string) {
  renderFilesPage({
    openFilePath: "src/index.ts",
    laneId,
  });
  await waitForEditorText("value = 1");
  fireEvent.click(screen.getByRole("button", { name: "CHANGES" }));
}

describe("FilesPage", () => {
  const originalAde = globalThis.window.ade;
  const originalConfirm = globalThis.window.confirm;

  beforeEach(() => {
    projectCounter += 1;
    projectRoot = `/Users/arul/ADE-${projectCounter}`;
    resetStore();
    latestMockEditor = null;
    createdMockEditors = [];
    vi.mocked(monacoEditor.create).mockClear();
    vi.mocked(monacoEditor.createModel).mockClear();
    vi.mocked(monacoEditor.setTheme).mockClear();
    adeDiffViewerMock.getModifiedValue.mockClear();
    adeDiffViewerMock.revealLineInCenter.mockClear();
    changeListener = null;
    currentTree = cloneTree(ignoredTree);
    fileContents = {
      "src/index.ts": "export const value = 1;\n",
      "src/main.ts": "export const value = 2;\n",
      ".ade/notes/project.md": "# Project notes\n\nRenderer-safe content",
    };
    fileReadOverrides = {};
    window.localStorage.clear();
    globalThis.window.confirm = vi.fn(() => true);

    globalThis.window.ade = {
      files: {
        listWorkspaces: vi.fn(async () => [
          {
            id: "primary",
            kind: "primary",
            laneId: null,
            name: "ADE",
            branchRef: "refs/heads/main",
            rootPath: projectRoot,
            isReadOnlyByDefault: false,
          },
        ]),
        listTree: vi.fn(async ({ parentPath, includeIgnored }: { parentPath?: string; includeIgnored?: boolean }) =>
          listTreeForRequest(parentPath, includeIgnored)
        ),
        watchChanges: vi.fn(async () => undefined),
        stopWatching: vi.fn(async () => undefined),
        onChange: vi.fn((cb: (event: FileChangeEvent) => void) => {
          changeListener = cb;
          return () => {
            if (changeListener === cb) changeListener = null;
          };
        }),
        readFile: vi.fn(async ({ path }: { path: string }) => {
          const override = fileReadOverrides[path]
            ?? fileReadOverrides[Object.keys(fileReadOverrides).find((candidate) => candidate.toLowerCase() === path.toLowerCase()) ?? ""];
          if (override) return override;
          const content = fileContents[path]
            ?? fileContents[Object.keys(fileContents).find((candidate) => candidate.toLowerCase() === path.toLowerCase()) ?? ""];
          if (content == null) {
            throw new Error(`ENOENT: ${path}`);
          }
          return {
            content,
            encoding: "utf-8",
            size: content.length,
            languageId: path.endsWith(".ts") ? "typescript" : "markdown",
            isBinary: false,
          };
        }),
        quickOpen: vi.fn(async ({ includeIgnored, query }: { includeIgnored?: boolean; query: string }) => (
          includeIgnored && query.toLowerCase().includes("project")
            ? [{ path: ".ade/notes/project.md", score: 100 }]
            : []
        )),
        searchText: vi.fn(async ({ includeIgnored, query }: { includeIgnored?: boolean; query: string }) => (
          includeIgnored && query.toLowerCase().includes("renderer")
            ? [{ path: ".ade/notes/project.md", line: 3, column: 1, preview: "Renderer-safe content" }]
            : []
        )),
        writeText: vi.fn(async () => undefined),
        rename: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
        createFile: vi.fn(async () => undefined),
        createDirectory: vi.fn(async () => undefined),
      },
      git: {
        stageFile: vi.fn(async () => undefined),
        unstageFile: vi.fn(async () => undefined),
        discardFile: vi.fn(async () => undefined),
        listRecentCommits: vi.fn(async () => []),
      },
      diff: {
        getFile: vi.fn(async ({ path, mode }: { path: string; mode: string }) => ({
          path,
          mode,
          original: { exists: true, text: fileContents[path] ?? "" },
          modified: { exists: true, text: fileContents[path] ?? "" },
          language: path.endsWith(".ts") ? "typescript" : "markdown",
        })),
        getFilePatch: vi.fn(async ({ path, mode }: { path: string; mode: string }) => ({
          path,
          mode,
          patch: "",
        })),
      },
      app: {
        openPathInEditor: vi.fn(async () => undefined),
        revealPath: vi.fn(async () => undefined),
        writeClipboardText: vi.fn(async () => undefined),
      },
    } as any;
  });

  afterEach(() => {
    cleanup();
    latestMockEditor = null;
    createdMockEditors = [];
    changeListener = null;
    window.localStorage.clear();
    globalThis.window.confirm = originalConfirm;
    if (originalAde === undefined) {
      delete (globalThis.window as any).ade;
    } else {
      globalThis.window.ade = originalAde;
    }
  });

  it("shows ignored paths by default and opens ignored dotfile notes without a toggle", async () => {
    renderFilesPage({
      openFilePath: ".ade/notes/project.md",
      preferPrimaryWorkspace: true,
    });

    await waitForEditorText("# Project notes");
    expect(screen.queryByText(/OPEN A FILE TO START EDITING/i)).toBeNull();
    expect(await screen.findByTitle(".ade")).toBeTruthy();
    expect(screen.queryByTitle("Hide dotfiles")).toBeNull();
    expect(screen.queryByTitle("Show dotfiles")).toBeNull();
    expect((window.ade.files.listTree as any).mock.calls[0]?.[0]).toMatchObject({
      includeIgnored: true,
      depth: 1,
    });
    await waitForFilesWatcherStartup();
    const watchArgs = (window.ade.files.watchChanges as any).mock.calls[0]?.[0];
    expect(watchArgs).toMatchObject({ workspaceId: "primary" });
    expect(watchArgs).not.toHaveProperty("includeIgnored");
  });

  it("starts the workspace watcher before a file is opened without watching ADE runtime churn", async () => {
    renderFilesPage({ preferPrimaryWorkspace: true });

    await waitForFilesWatcherStartup();
    const watchArgs = (window.ade.files.watchChanges as any).mock.calls[0]?.[0];
    expect(watchArgs).toMatchObject({ workspaceId: "primary" });
    expect(watchArgs).not.toHaveProperty("includeIgnored");
  });

  it("filters loaded tree paths locally and keeps content search explicit", async () => {
    renderFilesPage({
      openFilePath: ".ade/notes/project.md",
      preferPrimaryWorkspace: true,
    });

    await waitForEditorText("# Project notes");

    fireEvent.change(screen.getByPlaceholderText("Filter paths"), {
      target: { value: "src" },
    });

    expect(await screen.findByTitle("src")).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByTitle(".ade")).toBeNull();
    });
    expect(window.ade.files.searchText).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /content/i }));
    fireEvent.change(screen.getByPlaceholderText(/Search file contents/i), {
      target: { value: "renderer" },
    });

    await waitFor(() => {
      expect((window.ade.files.searchText as any).mock.calls.at(-1)?.[0]).toMatchObject({
        workspaceId: "primary",
        query: "renderer",
        includeIgnored: true,
      });
    });
    expect(await screen.findByText(".ade/notes/project.md:3:1")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });

    fireEvent.click(screen.getByText(/QUICK OPEN/i));
    fireEvent.change(screen.getByPlaceholderText(/Type to search files/i), {
      target: { value: "project" },
    });

    await waitFor(() => {
      expect((window.ade.files.quickOpen as any).mock.calls.at(-1)?.[0]).toMatchObject({
        workspaceId: "primary",
        query: "project",
        includeIgnored: true,
      });
    });
    expect(await screen.findByText(".ade/notes/project.md")).toBeTruthy();
  });

  it("copies a file path from the tree context menu", async () => {
    renderFilesPage({
      openFilePath: "src/index.ts",
      preferPrimaryWorkspace: true,
    });

    await waitForEditorText("value = 1");
    fireEvent.click(await screen.findByTitle("src"));

    fireEvent.contextMenu(await screen.findByTitle("src/index.ts"), {
      clientX: 100,
      clientY: 100,
    });
    fireEvent.click(await screen.findByText("COPY PATH"));

    await waitFor(() => {
      expect(window.ade.app.writeClipboardText).toHaveBeenCalledWith("src/index.ts");
    });
  });

  it("keeps one editor instance and swaps models when opening another text file", async () => {
    currentTree = [
      {
        name: "src",
        path: "src",
        type: "directory",
        children: [
          {
            name: "index.ts",
            path: "src/index.ts",
            type: "file",
          },
          {
            name: "main.ts",
            path: "src/main.ts",
            type: "file",
          },
        ],
      },
    ];

    renderFilesPage({
      openFilePath: "src/index.ts",
      preferPrimaryWorkspace: true,
    });

    await waitForEditorText("value = 1");
    fireEvent.click(await screen.findByTitle("src"));
    fireEvent.click(await screen.findByTitle("src/main.ts"));

    await waitForEditorText("value = 2");
    expect(screen.getByTestId("mock-monaco-editor").textContent).not.toContain("value = 1");
    expect(createdMockEditors).toHaveLength(1);
    expect((monacoEditor.createModel as any).mock.calls.map(([content]: [string]) => content)).toEqual([
      "export const value = 1;\n",
      "export const value = 2;\n",
    ]);
  });

  it("renders image files inline without starting the code editor", async () => {
    fileReadOverrides["assets/logo.png"] = {
      content: "iVBORw0KGgo=",
      encoding: "base64",
      size: 8,
      languageId: "image",
      isBinary: true,
      previewKind: "image",
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,iVBORw0KGgo=",
    };

    renderFilesPage({
      openFilePath: "assets/logo.png",
      preferPrimaryWorkspace: true,
    });

    const image = await screen.findByAltText("assets/logo.png");
    expect(image.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(screen.getByText(/IMAGE PREVIEW/i)).toBeTruthy();
    expect(screen.queryByTestId("mock-monaco-editor")).toBeNull();
  });

  it("shows a stable fallback for unsupported binary files", async () => {
    fileReadOverrides["dist/app.bin"] = {
      content: "AQIDBA==",
      encoding: "base64",
      size: 4,
      languageId: "plaintext",
      isBinary: true,
      previewKind: "binary",
      mimeType: "application/octet-stream",
    };

    renderFilesPage({
      openFilePath: "dist/app.bin",
      preferPrimaryWorkspace: true,
    });

    expect(await screen.findByText(/PREVIEW UNAVAILABLE/i)).toBeTruthy();
    expect(screen.getByText(/This file type cannot be displayed inline/i)).toBeTruthy();
    expect(screen.getByText(/application\/octet-stream/i)).toBeTruthy();
    expect(screen.queryByTestId("mock-monaco-editor")).toBeNull();
  });

  it("does not start Monaco for omitted oversized file payloads", async () => {
    fileReadOverrides["dist/large.bundle.js"] = {
      content: "",
      encoding: "utf-8",
      size: 1024 * 1024 + 1,
      languageId: "javascript",
      isBinary: true,
      previewKind: "binary",
      mimeType: null,
      contentOmitted: true,
      omittedReason: "too_large",
    };

    renderFilesPage({
      openFilePath: "dist/large.bundle.js",
      preferPrimaryWorkspace: true,
    });

    expect(await screen.findByText(/PREVIEW UNAVAILABLE/i)).toBeTruthy();
    expect(screen.getByText(/too large to display inline/i)).toBeTruthy();
    expect(screen.queryByTestId("mock-monaco-editor")).toBeNull();
  });

  it("stacks merge conflict panes when Files is embedded in a narrow Work drawer", async () => {
    fileContents["src/index.ts"] = [
      "export function title() {",
      "<<<<<<< HEAD",
      "  return \"ours\";",
      "=======",
      "  return \"theirs\";",
      ">>>>>>> feature",
      "}",
      "",
    ].join("\n");

    renderFilesPage(
      {
        openFilePath: "src/index.ts",
        preferPrimaryWorkspace: true,
      },
      { embedded: true },
    );

    await waitForEditorText("<<<<<<< HEAD");
    fireEvent.click(screen.getByRole("button", { name: "MERGE" }));

    const layout = await screen.findByTestId("files-conflict-layout");
    expect(layout.getAttribute("data-layout")).toBe("stacked");
    expect(layout.className).toContain("flex-col");
    expect(layout.style.gridTemplateColumns).toBe("");

    const hunks = screen.getByTestId("files-conflict-hunks");
    expect(hunks.style.maxHeight).toBe("42%");
    const mergeEditor = screen.getAllByRole("textbox")
      .find((node): node is HTMLTextAreaElement => node instanceof HTMLTextAreaElement);
    expect(mergeEditor?.value).toContain("<<<<<<< HEAD");
  });

  it("hides the workspace selector chrome when embedded in the Work sidebar", async () => {
    const laneId = "lane-work-chat";
    useAppStore.setState({
      selectedLaneId: laneId,
      lanes: [{ id: laneId, name: "Work chat lane", branchRef: "refs/heads/feat/work-chat" }] as any,
    });
    vi.mocked(window.ade.files.listWorkspaces).mockResolvedValue([
      {
        id: "primary",
        kind: "primary",
        laneId: null,
        name: "ADE",
        branchRef: "refs/heads/main",
        rootPath: projectRoot,
        isReadOnlyByDefault: false,
      },
      {
        id: "lane-ws",
        kind: "worktree",
        laneId,
        name: "Work chat lane",
        branchRef: "refs/heads/feat/work-chat",
        rootPath: `${projectRoot}/.ade/worktrees/work-chat`,
        isReadOnlyByDefault: false,
      },
    ]);

    renderFilesPage(undefined, { embedded: true, preferredLaneId: laneId });

    await waitFor(() => {
      expect(window.ade.files.listTree).toHaveBeenCalledWith(expect.objectContaining({
        workspaceId: "lane-ws",
      }));
    });
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByTestId("files.header")).toBeNull();
    expect(screen.getByText("EXPLORER")).toBeTruthy();
  });

  it("remaps clean open tabs when files are renamed", async () => {
    renderFilesPage({
      openFilePath: "src/index.ts",
      preferPrimaryWorkspace: true,
    });

    await waitForEditorText("value = 1");
    await waitForFilesWatcherStartup();
    fireEvent.click(await screen.findByTitle("src"));
    expect(await screen.findByTitle("src/index.ts")).toBeTruthy();

    currentTree = [
      {
        name: "src",
        path: "src",
        type: "directory",
        children: [
          {
            name: "main.ts",
            path: "src/main.ts",
            type: "file",
          },
        ],
      },
      {
        name: ".ade",
        path: ".ade",
        type: "directory",
        children: [
          {
            name: "notes",
            path: ".ade/notes",
            type: "directory",
          },
        ],
      },
    ];

    emitFileChange({
      workspaceId: "primary",
      type: "renamed",
      oldPath: "src/index.ts",
      path: "src/main.ts",
      ts: new Date().toISOString(),
    });

    await waitForEditorText("value = 2");
    expect(await screen.findByTitle("src/main.ts")).toBeTruthy();
    expect(screen.queryByTitle("src/index.ts")).toBeNull();
    expect((window.ade.files.readFile as any).mock.calls.some(([arg]: [{ path: string }]) => arg.path === "src/main.ts")).toBe(true);
  });

  it("renames the selected tree row inline with F2", async () => {
    renderFilesPage({ preferPrimaryWorkspace: true });

    fireEvent.click(await screen.findByTitle("src"));
    const fileRow = await screen.findByTitle("src/index.ts");
    fireEvent.click(fileRow);
    await waitForEditorText("value = 1");

    fireEvent.keyDown(window, { key: "F2" });
    const renameInput = await screen.findByDisplayValue("index.ts");
    fireEvent.change(renameInput, { target: { value: "main.ts" } });
    fireEvent.keyDown(renameInput, { key: "Enter" });

    await waitFor(() => {
      expect(window.ade.files.rename).toHaveBeenCalledWith({
        workspaceId: "primary",
        oldPath: "src/index.ts",
        newPath: "src/main.ts",
      });
    });
  });

  it("closes deleted tabs without crashing the page", async () => {
    renderFilesPage({
      openFilePath: "src/index.ts",
      preferPrimaryWorkspace: true,
    });

    await waitForEditorText("value = 1");
    await waitForFilesWatcherStartup();
    fireEvent.click(await screen.findByTitle("src"));
    expect(await screen.findByTitle("src/index.ts")).toBeTruthy();

    currentTree = [
      {
        name: "src",
        path: "src",
        type: "directory",
        children: [],
      },
      {
        name: ".ade",
        path: ".ade",
        type: "directory",
        children: [
          {
            name: "notes",
            path: ".ade/notes",
            type: "directory",
          },
        ],
      },
    ];
    delete fileContents["src/index.ts"];

    emitFileChange({
      workspaceId: "primary",
      type: "deleted",
      path: "src/index.ts",
      ts: new Date().toISOString(),
    });

    await waitFor(() => {
      expect(screen.getByText(/OPEN A FILE TO START EDITING/i)).toBeTruthy();
    });
    expect(screen.getByText("0 OPEN")).toBeTruthy();
  });

  it("refreshes clean tabs from disk but preserves dirty tabs", async () => {
    renderFilesPage({
      openFilePath: "src/index.ts",
      preferPrimaryWorkspace: true,
    });

    await waitForEditorText("value = 1");
    await waitForFilesWatcherStartup();

    fileContents["src/index.ts"] = "export const value = 2;\n";
    emitFileChange({
      workspaceId: "primary",
      type: "modified",
      path: "src/index.ts",
      ts: new Date().toISOString(),
    });

    await waitForEditorText("value = 2");

    expect(latestMockEditor).toBeTruthy();
    act(() => {
      latestMockEditor?.setValue("export const value = 99;\n");
    });
    await waitForEditorText("value = 99");

    fileContents["src/index.ts"] = "export const value = 3;\n";
    vi.useFakeTimers();
    try {
      emitFileChange({
        workspaceId: "primary",
        type: "modified",
        path: "src/index.ts",
        ts: new Date().toISOString(),
      });

      await act(async () => {
        vi.advanceTimersByTime(180);
        await Promise.resolve();
      });

      expect(screen.getByTestId("mock-monaco-editor").textContent).toContain("value = 99");
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves oversized dirty tabs when switching lane scopes", async () => {
    const laneA = "lane-large-a";
    const laneB = "lane-large-b";
    useAppStore.setState({
      selectedLaneId: laneA,
      lanes: [
        { id: laneA, name: "Large A", branchRef: "refs/heads/large-a" },
        { id: laneB, name: "Large B", branchRef: "refs/heads/large-b" },
      ] as any,
    });
    vi.mocked(window.ade.files.listWorkspaces).mockResolvedValue([
      {
        id: "primary",
        kind: "primary",
        laneId: null,
        name: "ADE",
        branchRef: "refs/heads/main",
        rootPath: projectRoot,
        isReadOnlyByDefault: false,
      },
      {
        id: "lane-large-a-ws",
        kind: "worktree",
        laneId: laneA,
        name: "Large A",
        branchRef: "refs/heads/large-a",
        rootPath: `${projectRoot}/.ade/worktrees/large-a`,
        isReadOnlyByDefault: false,
      },
      {
        id: "lane-large-b-ws",
        kind: "worktree",
        laneId: laneB,
        name: "Large B",
        branchRef: "refs/heads/large-b",
        rootPath: `${projectRoot}/.ade/worktrees/large-b`,
        isReadOnlyByDefault: false,
      },
    ]);

    renderFilesPage({
      openFilePath: "src/index.ts",
    });

    await waitForEditorText("value = 1");

    const oversizedDirtyContent = `dirty-start\n${"x".repeat(8 * 1024 * 1024 + 1)}\ndirty-end`;
    act(() => {
      latestMockEditor?.setValue(oversizedDirtyContent);
    });
    expect(latestMockEditor?.getValue().length).toBe(oversizedDirtyContent.length);

    act(() => {
      useAppStore.setState({ selectedLaneId: laneB });
    });
    await waitFor(() => {
      expect(screen.getByText(/OPEN A FILE TO START EDITING/i)).toBeTruthy();
    });

    act(() => {
      useAppStore.setState({ selectedLaneId: laneA });
    });
    await waitFor(() => {
      expect(latestMockEditor?.getValue().length).toBe(oversizedDirtyContent.length);
      expect(latestMockEditor?.getValue().endsWith("dirty-end")).toBe(true);
    });
  });

  it("treats Windows workspace paths case-insensitively for open tabs and watcher events", async () => {
    projectRoot = "C:/Repo";
    resetStore();
    currentTree = [
      {
        name: "src",
        path: "src",
        type: "directory",
        children: [
          {
            name: "Main.ts",
            path: "src/Main.ts",
            type: "file",
          },
        ],
      },
    ];
    fileContents = {
      "src/Main.ts": "export const value = 7;\n",
      "src/Renamed.ts": "export const value = 8;\n",
    };
    vi.mocked(window.ade.files.listWorkspaces).mockResolvedValue([
      {
        id: "primary",
        kind: "primary",
        laneId: null,
        name: "ADE",
        branchRef: "refs/heads/main",
        rootPath: "C:\\Repo",
        isReadOnlyByDefault: false,
      },
    ]);

    renderFilesPage({
      openFilePath: "src/main.ts",
    });

    await waitForEditorText("value = 7");
    await waitForFilesWatcherStartup();
    expect((window.ade.files.readFile as any).mock.calls.some(([arg]: [{ path: string }]) => arg.path.toLowerCase() === "src/main.ts")).toBe(true);

    emitFileChange({
      workspaceId: "primary",
      type: "renamed",
      oldPath: "SRC\\MAIN.ts",
      path: "src\\Renamed.ts",
      ts: new Date().toISOString(),
    });

    await waitForEditorText("value = 8");
    await waitFor(() => {
      expect(screen.getAllByText("Renamed.ts").length).toBeGreaterThan(0);
    });
    expect(screen.queryAllByText("Main.ts")).toHaveLength(0);

    emitFileChange({
      workspaceId: "primary",
      type: "deleted",
      path: "SRC\\RENAMED.ts",
      ts: new Date().toISOString(),
    });

    await waitFor(() => {
      expect(screen.getByText(/OPEN A FILE TO START EDITING/i)).toBeTruthy();
    });
  });

  it("reveals navigation line targets in the editor view", async () => {
    renderFilesPage({
      openFilePath: "src/index.ts",
      preferPrimaryWorkspace: true,
      startLine: 3,
      startColumn: 7,
    });

    await waitForEditorText("value = 1");
    await waitFor(() => {
      expect(createdMockEditors.some((editor) =>
        editor.revealLineInCenter.mock.calls.some(([line]) => line === 3)
      )).toBe(true);
      expect(createdMockEditors.some((editor) =>
        editor.setPosition.mock.calls.some(([position]) =>
          position?.lineNumber === 3 && position?.column === 7
        )
      )).toBe(true);
    });
  });

  it("renders the diff viewer mock with ref forwarding in diff view", async () => {
    const laneId = "lane-diff";
    useLaneWorkspace(laneId);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(window.ade.diff.getFile).mockResolvedValue({
      path: "src/index.ts",
      mode: "unstaged",
      original: { exists: true, text: "export const value = 1;\n" },
      modified: { exists: true, text: "export const value = 2;\n" },
      language: "typescript",
    });
    vi.mocked(window.ade.diff.getFilePatch).mockResolvedValue({
      path: "src/index.ts",
      mode: "unstaged",
      patch: "@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
    });

    try {
      await switchOpenLaneFileToDiff(laneId);

      await screen.findByTestId("ade-diff-viewer");
      expect(consoleError.mock.calls.some(([message]) =>
        String(message).includes("Function components cannot be given refs")
      )).toBe(false);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("surfaces diff load failures when the patch fallback is empty", async () => {
    const laneId = "lane-diff";
    useLaneWorkspace(laneId);
    vi.mocked(window.ade.diff.getFile).mockRejectedValue(new Error("diff unavailable"));
    vi.mocked(window.ade.diff.getFilePatch).mockResolvedValue({
      path: "src/index.ts",
      mode: "unstaged",
      patch: "",
    });

    await switchOpenLaneFileToDiff(laneId);

    expect(await screen.findByText("diff unavailable")).toBeTruthy();
    expect(screen.queryByTestId("ade-diff-viewer")).toBeNull();
  });

  it("surfaces patch load failures when the inline diff has no changes", async () => {
    const laneId = "lane-diff";
    useLaneWorkspace(laneId);
    vi.mocked(window.ade.diff.getFile).mockResolvedValue({
      path: "src/index.ts",
      mode: "unstaged",
      original: { exists: true, text: "export const value = 1;\n" },
      modified: { exists: true, text: "export const value = 1;\n" },
      language: "typescript",
    });
    vi.mocked(window.ade.diff.getFilePatch).mockRejectedValue(new Error("patch unavailable"));

    await switchOpenLaneFileToDiff(laneId);

    expect(await screen.findByText("patch unavailable")).toBeTruthy();
    expect(screen.queryByTestId("ade-diff-viewer")).toBeNull();
  });

  it("toggles editor theme from main Files header and persists", async () => {
    renderFilesPage({
      openFilePath: "src/index.ts",
      preferPrimaryWorkspace: true,
    });

    await waitForEditorText("value = 1");

    const toggle = screen.getByTestId("files-editor-theme-toggle");
    expect(toggle.getAttribute("aria-label")).toBe("Switch editor to light theme");

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(window.localStorage.getItem("ade.files.editorTheme")).toBe("light");
    });
    expect(vi.mocked(monacoEditor.setTheme).mock.calls.at(-1)?.[0]).toBe("vs");
    await waitFor(() => {
      expect(screen.getByTestId("files-editor-theme-toggle").getAttribute("aria-label")).toBe(
        "Switch editor to dark theme",
      );
    });

    fireEvent.click(screen.getByTestId("files-editor-theme-toggle"));

    await waitFor(() => {
      expect(window.localStorage.getItem("ade.files.editorTheme")).toBe("dark");
    });
    expect(vi.mocked(monacoEditor.setTheme).mock.calls.at(-1)?.[0]).toBe("vs-dark");
    await waitFor(() => {
      expect(screen.getByTestId("files-editor-theme-toggle").getAttribute("aria-label")).toBe(
        "Switch editor to light theme",
      );
    });
  });

  it("opens the active file in the system default app", async () => {
    renderFilesPage({
      openFilePath: "src/index.ts",
      preferPrimaryWorkspace: true,
    });

    await waitForEditorText("value = 1");

    fireEvent.click(screen.getByRole("button", { name: /open in/i }));
    fireEvent.click(await screen.findByText("SYSTEM DEFAULT"));

    expect(window.ade.app.openPathInEditor).toHaveBeenCalledWith({
      rootPath: projectRoot,
      relativePath: "src/index.ts",
      target: "default",
    });
  });

  it("opens the selected Work lane workspace by default", async () => {
    const laneId = "lane-work-chat";
    useAppStore.setState({
      selectedLaneId: laneId,
      lanes: [{ id: laneId, name: "Work chat lane", branchRef: "refs/heads/feat/work-chat" }] as any,
    });
    vi.mocked(window.ade.files.listWorkspaces).mockResolvedValue([
      {
        id: "primary",
        kind: "primary",
        laneId: null,
        name: "ADE",
        branchRef: "refs/heads/main",
        rootPath: projectRoot,
        isReadOnlyByDefault: false,
      },
      {
        id: "lane-ws",
        kind: "worktree",
        laneId,
        name: "Work chat lane",
        branchRef: "refs/heads/feat/work-chat",
        rootPath: `${projectRoot}/.ade/worktrees/work-chat`,
        isReadOnlyByDefault: false,
      },
    ]);

    renderFilesPage(undefined, { preferredLaneId: laneId });

    await waitFor(() => {
      expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("lane-ws");
    });
    await waitFor(() => {
      expect(window.ade.files.listTree).toHaveBeenCalledWith(expect.objectContaining({
        workspaceId: "lane-ws",
      }));
    });
  });

  it("falls back to primary when the selected lane workspace is missing", async () => {
    const laneId = "lane-missing";
    useAppStore.setState({
      selectedLaneId: laneId,
      lanes: [{ id: laneId, name: "Missing lane", branchRef: "refs/heads/feat/missing" }] as any,
    });
    vi.mocked(window.ade.files.listWorkspaces).mockResolvedValue([
      {
        id: "primary",
        kind: "primary",
        laneId: null,
        name: "ADE",
        branchRef: "refs/heads/main",
        rootPath: projectRoot,
        isReadOnlyByDefault: false,
      },
      {
        id: "lane-ws",
        kind: "worktree",
        laneId,
        name: "Missing lane",
        branchRef: "refs/heads/feat/missing",
        rootPath: `${projectRoot}/.ade/worktrees/missing`,
        isReadOnlyByDefault: false,
      },
    ]);
    vi.mocked(window.ade.files.listTree).mockImplementation(async ({ workspaceId, parentPath, includeIgnored }: { workspaceId: string; parentPath?: string; includeIgnored?: boolean }) => {
      if (workspaceId === "lane-ws") {
        throw new Error(
          "Error invoking remote method 'ade.files.listTree': Error: ENOENT: no such file or directory, realpath '/tmp/missing'",
        );
      }
      return listTreeForRequest(parentPath, includeIgnored);
    });

    renderFilesPage(undefined, { preferredLaneId: laneId });

    await waitFor(() => {
      expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("primary");
    });
    expect(window.ade.files.listTree).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "lane-ws" }));
    expect(window.ade.files.listTree).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "primary" }));
    expect(screen.queryByText(/Error invoking remote method/)).toBeNull();
    expect(screen.queryByRole("button", { name: /switch to: missing lane/i })).toBeNull();
  });

  it("View lane opens /lanes with no query for primary workspace", async () => {
    renderFilesPage({ preferPrimaryWorkspace: true });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /view lane/i })).toBeTruthy();
    });
    expect(screen.getAllByRole("button", { name: /view lane/i })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /view lane/i }));

    await waitFor(() => {
      expect(screen.getByTestId("lanes-nav").textContent).toBe("/lanes");
    });
  });

  it("toggles primary workspace edit allowance from the non-embedded chrome", async () => {
    vi.mocked(window.ade.files.listWorkspaces).mockResolvedValue([
      {
        id: "primary",
        kind: "primary",
        laneId: null,
        name: "ADE",
        branchRef: "refs/heads/main",
        rootPath: projectRoot,
        isReadOnlyByDefault: true,
      },
    ]);

    renderFilesPage({
      openFilePath: "src/index.ts",
      preferPrimaryWorkspace: true,
    });

    await waitForEditorText("value = 1");
    expect(screen.getByText("READ-ONLY")).toBeTruthy();
    expect(latestMockEditor?.updateOptions).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true }));

    fireEvent.click(screen.getByRole("button", { name: "TRUST & EDIT" }));

    expect(screen.getByRole("button", { name: "DISABLE EDITS" })).toBeTruthy();
    expect(screen.queryByText("READ-ONLY")).toBeNull();
    await waitFor(() => {
      expect(latestMockEditor?.updateOptions).toHaveBeenCalledWith(expect.objectContaining({ readOnly: false }));
    });

    fireEvent.click(screen.getByRole("button", { name: "DISABLE EDITS" }));

    expect(screen.getByRole("button", { name: "TRUST & EDIT" })).toBeTruthy();
    await waitFor(() => {
      expect(latestMockEditor?.updateOptions).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true }));
    });
  });

  it("View lane opens Lanes focused on the selected lane workspace", async () => {
    const laneId = "lane-wt-abc";
    vi.mocked(window.ade.files.listWorkspaces).mockResolvedValue([
      {
        id: "primary",
        kind: "primary",
        laneId: null,
        name: "ADE",
        branchRef: "refs/heads/main",
        rootPath: projectRoot,
        isReadOnlyByDefault: false,
      },
      {
        id: "lane-ws",
        kind: "worktree",
        laneId,
        name: "feature",
        branchRef: "refs/heads/feat/x",
        rootPath: `${projectRoot}/.ade/worktrees/feature`,
        isReadOnlyByDefault: false,
      },
    ]);

    renderFilesPage({ preferPrimaryWorkspace: true });

    await waitFor(() => {
      expect(screen.getByRole("combobox")).toBeTruthy();
    });

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "lane-ws" } });

    fireEvent.click(screen.getByRole("button", { name: /view lane/i }));

    await waitFor(() => {
      expect(screen.getByTestId("lanes-nav").textContent).toBe(
        `/lanes?laneId=${encodeURIComponent(laneId)}&focus=single`,
      );
    });
  });

  it("workspace selector shows branch in option labels", async () => {
    vi.mocked(window.ade.files.listWorkspaces).mockResolvedValue([
      {
        id: "primary",
        kind: "primary",
        laneId: "lane-p",
        name: "ADE",
        branchRef: "refs/heads/develop",
        rootPath: projectRoot,
        isReadOnlyByDefault: false,
      },
    ]);

    renderFilesPage({ preferPrimaryWorkspace: true });

    await waitFor(() => {
      expect(screen.getByRole("option", { name: /ADE · develop \(primary\)/ })).toBeTruthy();
    });
  });
});

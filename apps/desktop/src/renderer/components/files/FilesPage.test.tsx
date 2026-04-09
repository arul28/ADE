/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { FileChangeEvent, FileTreeNode } from "../../../shared/types";
import { FilesPage } from "./FilesPage";
import { useAppStore } from "../../state/appStore";

type MockEditorInstance = {
  setModel: (next: any) => void;
  getValue: () => string;
  setValue: (next: string) => void;
  updateOptions: ReturnType<typeof vi.fn>;
  onDidChangeModelContent: (cb: () => void) => { dispose: ReturnType<typeof vi.fn> };
  dispose: ReturnType<typeof vi.fn>;
};

let latestMockEditor: MockEditorInstance | null = null;

vi.mock("../ui/PaneTilingLayout", () => ({
  PaneTilingLayout: ({ panes }: { panes: Record<string, { children: React.ReactNode }> }) => (
    <div data-testid="mock-pane-layout">
      {Object.entries(panes).map(([id, pane]) => (
        <section key={id} data-testid={`pane-${id}`}>
          {pane.children}
        </section>
      ))}
    </div>
  ),
}));

vi.mock("../lanes/LaneTerminalsPanel", () => ({
  LaneTerminalsPanel: () => <div data-testid="lane-terminals" />,
}));

vi.mock("../lanes/MonacoDiffView", () => ({
  MonacoDiffView: () => <div data-testid="monaco-diff" />,
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
          updateOptions: vi.fn(),
          onDidChangeModelContent(cb: () => void) {
            onChange = cb;
            return { dispose: vi.fn() };
          },
          dispose: vi.fn(),
        };
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
        name: "context",
        path: ".ade/context",
        type: "directory",
      },
    ],
  },
];

let currentTree: FileTreeNode[] = [];
let fileContents: Record<string, string> = {};
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
    runLaneId: null,
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

function renderFilesPage(initialState?: Record<string, unknown>) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/files", state: initialState }]}>
      <Routes>
        <Route path="/files" element={<FilesPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function waitForEditorText(text: string) {
  await waitFor(() => {
    expect(screen.getByTestId("mock-monaco-editor").textContent).toContain(text);
  });
}

describe("FilesPage", () => {
  const originalAde = globalThis.window.ade;
  const originalConfirm = globalThis.window.confirm;

  beforeEach(() => {
    projectCounter += 1;
    projectRoot = `/Users/arul/ADE-${projectCounter}`;
    resetStore();
    latestMockEditor = null;
    changeListener = null;
    currentTree = cloneTree(ignoredTree);
    fileContents = {
      "src/index.ts": "export const value = 1;\n",
      "src/main.ts": "export const value = 2;\n",
      ".ade/context/PRD.ade.md": "# PRD.ade\n\n## What this is\nRenderer-safe content",
      ".ade/context/ARCHITECTURE.ade.md": "# ARCHITECTURE.ade\n\n## System shape\nRenderer-safe content",
    };
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
          const content = fileContents[path];
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
          includeIgnored && query.toLowerCase().includes("prd")
            ? [{ path: ".ade/context/PRD.ade.md", score: 100 }]
            : []
        )),
        searchText: vi.fn(async ({ includeIgnored, query }: { includeIgnored?: boolean; query: string }) => (
          includeIgnored && query.toLowerCase().includes("renderer")
            ? [{ path: ".ade/context/PRD.ade.md", line: 3, column: 1, preview: "Renderer-safe content" }]
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
    changeListener = null;
    window.localStorage.clear();
    globalThis.window.confirm = originalConfirm;
    if (originalAde === undefined) {
      delete (globalThis.window as any).ade;
    } else {
      globalThis.window.ade = originalAde;
    }
  });

  it("shows ignored paths by default and opens PRD context docs without a toggle", async () => {
    renderFilesPage({
      openFilePath: ".ade/context/PRD.ade.md",
      preferPrimaryWorkspace: true,
    });

    await waitForEditorText("# PRD.ade");
    expect(screen.queryByText(/OPEN A FILE TO START EDITING/i)).toBeNull();
    expect(await screen.findByTitle(".ade")).toBeTruthy();
    expect(screen.queryByTitle("Hide dotfiles")).toBeNull();
    expect(screen.queryByTitle("Show dotfiles")).toBeNull();
    expect((window.ade.files.listTree as any).mock.calls[0]?.[0]).toMatchObject({ includeIgnored: true });
    expect((window.ade.files.watchChanges as any).mock.calls[0]?.[0]).toMatchObject({
      workspaceId: "primary",
      includeIgnored: true,
    });
  });

  it("passes includeIgnored through quick open and search affordances", async () => {
    renderFilesPage({
      openFilePath: ".ade/context/PRD.ade.md",
      preferPrimaryWorkspace: true,
    });

    await waitForEditorText("# PRD.ade");

    fireEvent.change(screen.getByPlaceholderText("SEARCH FILES"), {
      target: { value: "renderer" },
    });

    await waitFor(() => {
      expect((window.ade.files.searchText as any).mock.calls.at(-1)?.[0]).toMatchObject({
        workspaceId: "primary",
        query: "renderer",
        includeIgnored: true,
      });
    });
    expect(await screen.findByText(".ade/context/PRD.ade.md:3:1")).toBeTruthy();

    fireEvent.click(screen.getByText(/QUICK OPEN/i));
    fireEvent.change(screen.getByPlaceholderText(/Type to search files/i), {
      target: { value: "prd" },
    });

    await waitFor(() => {
      expect((window.ade.files.quickOpen as any).mock.calls.at(-1)?.[0]).toMatchObject({
        workspaceId: "primary",
        query: "prd",
        includeIgnored: true,
      });
    });
    expect(await screen.findByText(".ade/context/PRD.ade.md")).toBeTruthy();
  });

  it("remaps clean open tabs when files are renamed", async () => {
    renderFilesPage({
      openFilePath: "src/index.ts",
      preferPrimaryWorkspace: true,
    });

    await waitForEditorText("value = 1");
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
            name: "context",
            path: ".ade/context",
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

  it("closes deleted tabs without crashing the page", async () => {
    renderFilesPage({
      openFilePath: "src/index.ts",
      preferPrimaryWorkspace: true,
    });

    await waitForEditorText("value = 1");
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
            name: "context",
            path: ".ade/context",
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
    await waitFor(() => {
      expect(screen.queryByTitle("src/index.ts")).toBeNull();
    });
    expect(screen.getByTestId("mock-pane-layout")).toBeTruthy();
  });

  it("refreshes clean tabs from disk but preserves dirty tabs", async () => {
    renderFilesPage({
      openFilePath: "src/index.ts",
      preferPrimaryWorkspace: true,
    });

    await waitForEditorText("value = 1");

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
});

/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { FilesPage } from "./FilesPage";
import { useAppStore } from "../../state/appStore";

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
        return {
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
      }),
      createModel: vi.fn(createModel),
      setTheme: vi.fn(),
    },
  };
});

const baseVisibleTree = [
  {
    name: "src",
    path: "src",
    type: "directory" as const,
    children: [
      {
        name: "index.ts",
        path: "src/index.ts",
        type: "file" as const,
      },
    ],
  },
];

const hiddenAwareTree = [
  ...baseVisibleTree,
  {
    name: ".ade",
    path: ".ade",
    type: "directory" as const,
    children: [
      {
        name: "context",
        path: ".ade/context",
        type: "directory" as const,
      },
    ],
  },
];

function resetStore() {
  useAppStore.setState({
    project: { rootPath: "/Users/arul/ADE", name: "ADE" } as any,
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

describe("FilesPage", () => {
  const originalAde = globalThis.window.ade;
  const originalConfirm = globalThis.window.confirm;

  beforeEach(() => {
    resetStore();
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
            rootPath: "/Users/arul/ADE",
            isReadOnlyByDefault: false,
          },
        ]),
        listTree: vi.fn(async ({ includeIgnored }: { includeIgnored?: boolean }) => (includeIgnored ? hiddenAwareTree : baseVisibleTree)),
        watchChanges: vi.fn(async () => undefined),
        stopWatching: vi.fn(async () => undefined),
        onChange: vi.fn(() => () => {}),
        readFile: vi.fn(async ({ path }: { path: string }) => ({
          content:
            path === ".ade/context/ARCHITECTURE.ade.md"
              ? "# ARCHITECTURE.ade\n\n## System shape\nRenderer-safe content"
              : "# PRD.ade\n\n## What this is\nRenderer-safe content",
          encoding: "utf-8",
          size: 128,
          languageId: "markdown",
          isBinary: false,
        })),
        quickOpen: vi.fn(async () => []),
        searchText: vi.fn(async () => []),
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
    window.localStorage.clear();
    globalThis.window.confirm = originalConfirm;
    if (originalAde === undefined) {
      delete (globalThis.window as any).ade;
    } else {
      globalThis.window.ade = originalAde;
    }
  });

  it("opens PRD context docs from navigation state without a blank editor tab", async () => {
    renderFilesPage({
      openFilePath: ".ade/context/PRD.ade.md",
      preferPrimaryWorkspace: true,
    });

    await waitFor(() => {
      expect(screen.getByTestId("mock-monaco-editor").textContent).toContain("# PRD.ade");
    });
    expect(screen.queryByText(/OPEN A FILE TO START EDITING/i)).toBeNull();
    expect(await screen.findByTitle(".ade")).toBeTruthy();
  });

  it("keeps an opened context doc visible while hidden files are toggled", async () => {
    renderFilesPage({
      openFilePath: ".ade/context/PRD.ade.md",
      preferPrimaryWorkspace: true,
    });

    await waitFor(() => {
      expect(screen.getByTestId("mock-monaco-editor").textContent).toContain("# PRD.ade");
    });

    await act(async () => {
      fireEvent.click(screen.getByTitle("Hide dotfiles"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("mock-monaco-editor").textContent).toContain("# PRD.ade");
    });
    expect(screen.queryByText(/OPEN A FILE TO START EDITING/i)).toBeNull();
    expect(screen.queryByTitle(".ade")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTitle("Show dotfiles"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("mock-monaco-editor").textContent).toContain("# PRD.ade");
    });
    expect(screen.getByTitle(".ade")).toBeTruthy();
  });
});

// @vitest-environment jsdom

import React from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consumeAppMenuCommand,
  resetAppMenuCommandsForTests,
} from "../../../../lib/appMenuCommands";
import type { MonacoModelRegistry } from "../../monacoModelRegistry";
import type { PinnedFilesApi } from "../pinnedFilesApi";
import type { EditorTab } from "../editorGroupsStore";
import { CodeViewer } from "./CodeViewer";

/**
 * ⌘F in the Files editor.
 *
 * `Edit ▸ Find…` is a native menu accelerator, so Electron consumes it in the
 * browser process before Monaco's own keybinding fires — the chord was dead on
 * the packaged app while passing every jsdom test that sent a keydown. The
 * editor claims the menu command instead, and the only things worth proving are
 * that focus decides who answers and that an unmounted editor stops answering.
 */

const findAction = vi.hoisted(() => ({ run: vi.fn() }));
const editorState = vi.hoisted(() => ({ hasTextFocus: true }));

const fakeEditor = vi.hoisted(() => () => ({
  getAction: (id: string) => (id === "actions.find" ? findAction : null),
  hasTextFocus: () => editorState.hasTextFocus,
  addCommand: vi.fn(),
  getModel: () => null,
  setModel: vi.fn(),
  getValue: () => "",
  updateOptions: vi.fn(),
  revealLineInCenter: vi.fn(),
  setPosition: vi.fn(),
  focus: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock("../monacoLoader", () => {
  // One editor object per mounted viewer is enough here: every test renders one.
  const editor = fakeEditor();
  return {
    adeMonacoTheme: () => "ade-dark",
    loadMonaco: async () => ({
      editor: { create: () => editor, setTheme: vi.fn() },
      KeyMod: { CtrlCmd: 1 },
      KeyCode: { KeyS: 2 },
    }),
  };
});

vi.mock("../pendingReveals", () => ({ takePendingReveal: () => null }));
vi.mock("../useFileContent", () => ({ updateCachedFileContentText: vi.fn() }));

const registry = {
  getOrCreate: () => ({ onDidChangeContent: () => ({ dispose: vi.fn() }) }),
  refreshClean: vi.fn(),
  getValue: () => "",
  markSaved: vi.fn(),
  isDirty: () => false,
} as unknown as MonacoModelRegistry;

const tab: EditorTab = {
  id: "ws-1::a.ts",
  workspaceId: "ws-1",
  laneId: null,
  path: "a.ts",
  title: "a.ts",
  viewerKind: "code",
  languageId: "typescript",
  preview: false,
  pinned: false,
};

function renderViewer() {
  return render(
    <CodeViewer
      workspaceId="ws-1"
      files={{} as PinnedFilesApi}
      rootPath="/repo"
      tab={tab}
      content={{
        content: "hello",
        encoding: "utf-8",
        size: 5,
        languageId: "typescript",
        isBinary: false,
      }}
      readOnly={false}
      theme="dark"
      registry={registry}
    />,
  );
}

afterEach(() => {
  cleanup();
  resetAppMenuCommandsForTests();
  findAction.run.mockClear();
  editorState.hasTextFocus = true;
});

describe("CodeViewer ⌘F claim", () => {
  it("claims the menu find command and runs Monaco's find while it has focus", async () => {
    renderViewer();
    await waitFor(() => expect(consumeAppMenuCommand("find")).toBe(true));
    expect(findAction.run).toHaveBeenCalled();
  });

  it("declines when focus is somewhere else, so another surface can answer", async () => {
    renderViewer();
    await waitFor(() => expect(consumeAppMenuCommand("find")).toBe(true));
    findAction.run.mockClear();

    editorState.hasTextFocus = false;
    expect(consumeAppMenuCommand("find")).toBe(false);
    expect(findAction.run).not.toHaveBeenCalled();
  });

  it("never answers close-tab, which is the window's chord", async () => {
    renderViewer();
    await waitFor(() => expect(consumeAppMenuCommand("find")).toBe(true));
    expect(consumeAppMenuCommand("close-tab")).toBe(false);
  });

  it("releases the claim on unmount", async () => {
    const view = renderViewer();
    await waitFor(() => expect(consumeAppMenuCommand("find")).toBe(true));

    view.unmount();
    findAction.run.mockClear();
    expect(consumeAppMenuCommand("find")).toBe(false);
    expect(findAction.run).not.toHaveBeenCalled();
  });
});

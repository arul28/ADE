import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow, ContextMenuParams, MenuItemConstructorOptions } from "electron";

const electronMocks = vi.hoisted(() => ({
  buildFromTemplate: vi.fn(),
  popup: vi.fn(),
}));

vi.mock("electron", () => ({
  Menu: {
    buildFromTemplate: electronMocks.buildFromTemplate,
  },
}));

import { buildEditableContextMenuTemplate, installEditableContextMenu } from "./editorContextMenu";

function contextMenuParams(overrides: Partial<ContextMenuParams> = {}): ContextMenuParams {
  return {
    x: 0,
    y: 0,
    frame: null,
    linkURL: "",
    linkText: "",
    pageURL: "http://localhost",
    frameURL: "http://localhost",
    srcURL: "",
    mediaType: "none",
    hasImageContents: false,
    isEditable: true,
    selectionText: "",
    titleText: "",
    altText: "",
    suggestedFilename: "",
    selectionRect: { x: 0, y: 0, width: 0, height: 0 },
    selectionStartOffset: 0,
    referrerPolicy: { policy: "default", url: "" },
    misspelledWord: "",
    dictionarySuggestions: [],
    frameCharset: "utf-8",
    formControlType: "text-area",
    spellcheckEnabled: true,
    menuSourceType: "mouse",
    mediaFlags: {
      inError: false,
      isPaused: false,
      isMuted: false,
      hasAudio: false,
      isLooping: false,
      isControlsVisible: false,
      canToggleControls: false,
      canPrint: false,
      canSave: false,
      canShowPictureInPicture: false,
      isShowingPictureInPicture: false,
      canRotate: false,
      canLoop: false,
    },
    editFlags: {
      canUndo: true,
      canRedo: false,
      canCut: true,
      canCopy: true,
      canPaste: true,
      canDelete: true,
      canSelectAll: true,
      canEditRichly: false,
    },
    ...overrides,
  };
}

function fakeWindow() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const replaceMisspelling = vi.fn();
  const addWordToSpellCheckerDictionary = vi.fn();
  const win = {
    webContents: {
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener)),
      replaceMisspelling,
      session: { addWordToSpellCheckerDictionary },
    },
  } as unknown as BrowserWindow;
  return { win, listeners, replaceMisspelling, addWordToSpellCheckerDictionary };
}

describe("editable context menu", () => {
  beforeEach(() => {
    electronMocks.popup.mockReset();
    electronMocks.buildFromTemplate.mockReset();
    electronMocks.buildFromTemplate.mockReturnValue({ popup: electronMocks.popup });
  });

  it("does not replace custom menus on non-editable renderer content", () => {
    const { win, listeners } = fakeWindow();
    installEditableContextMenu(win);

    listeners.get("context-menu")?.({}, contextMenuParams({ isEditable: false }));

    expect(win.webContents.on).toHaveBeenCalledWith("context-menu", expect.any(Function));
    expect(electronMocks.buildFromTemplate).not.toHaveBeenCalled();
    expect(electronMocks.popup).not.toHaveBeenCalled();
  });

  it("offers spelling suggestions and dictionary actions before edit commands", () => {
    const { win, replaceMisspelling, addWordToSpellCheckerDictionary } = fakeWindow();
    const template = buildEditableContextMenuTemplate(
      win.webContents,
      contextMenuParams({ misspelledWord: "mispelled", dictionarySuggestions: ["misspelled", "misapplied"] }),
    );

    expect(template?.slice(0, 5).map((item) => item.label ?? item.type)).toEqual([
      "misspelled",
      "misapplied",
      "separator",
      "Add to dictionary",
      "separator",
    ]);
    template?.[0]?.click?.({} as never, undefined, {} as never);
    template?.[3]?.click?.({} as never, undefined, {} as never);
    expect(replaceMisspelling).toHaveBeenCalledWith("misspelled");
    expect(addWordToSpellCheckerDictionary).toHaveBeenCalledWith("mispelled");
  });

  it("shows native edit roles using Chromium's enabled flags", () => {
    const { win, listeners } = fakeWindow();
    installEditableContextMenu(win);

    listeners.get("context-menu")?.({}, contextMenuParams());

    const template = electronMocks.buildFromTemplate.mock.calls[0]?.[0] as MenuItemConstructorOptions[];
    expect(template.map((item) => item.role ?? item.type)).toEqual([
      "undo",
      "redo",
      "separator",
      "cut",
      "copy",
      "paste",
      "pasteAndMatchStyle",
      "delete",
      "separator",
      "selectAll",
    ]);
    expect(template.find((item) => item.role === "redo")?.enabled).toBe(false);
    expect(electronMocks.popup).toHaveBeenCalledWith({
      window: win,
      frame: undefined,
      x: 0,
      y: 0,
      sourceType: "mouse",
    });
  });
});

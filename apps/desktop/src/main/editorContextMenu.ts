import { Menu, type BrowserWindow, type ContextMenuParams, type MenuItemConstructorOptions } from "electron";

type EditableContextMenuTarget = Pick<BrowserWindow["webContents"], "replaceMisspelling" | "session">;

export function buildEditableContextMenuTemplate(
  target: EditableContextMenuTarget,
  params: ContextMenuParams,
): MenuItemConstructorOptions[] | null {
  if (!params.isEditable) return null;

  const template: MenuItemConstructorOptions[] = [];
  if (params.misspelledWord) {
    if (params.dictionarySuggestions.length) {
      for (const suggestion of params.dictionarySuggestions) {
        template.push({
          label: suggestion,
          click: () => target.replaceMisspelling(suggestion),
        });
      }
    } else {
      template.push({ label: "No spelling suggestions", enabled: false });
    }
    template.push(
      { type: "separator" },
      {
        label: "Add to dictionary",
        click: () => target.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      },
      { type: "separator" },
    );
  }

  template.push(
    { role: "undo", enabled: params.editFlags.canUndo },
    { role: "redo", enabled: params.editFlags.canRedo },
    { type: "separator" },
    { role: "cut", enabled: params.editFlags.canCut },
    { role: "copy", enabled: params.editFlags.canCopy },
    { role: "paste", enabled: params.editFlags.canPaste },
    { role: "pasteAndMatchStyle", enabled: params.editFlags.canPaste },
    { role: "delete", enabled: params.editFlags.canDelete },
    { type: "separator" },
    { role: "selectAll", enabled: params.editFlags.canSelectAll },
  );

  return template;
}

export function installEditableContextMenu(win: BrowserWindow): void {
  win.webContents.on("context-menu", (_event, params) => {
    const template = buildEditableContextMenuTemplate(win.webContents, params);
    if (!template) return;
    Menu.buildFromTemplate(template).popup({
      window: win,
      frame: params.frame ?? undefined,
      x: params.x,
      y: params.y,
      sourceType: params.menuSourceType,
    });
  });
}

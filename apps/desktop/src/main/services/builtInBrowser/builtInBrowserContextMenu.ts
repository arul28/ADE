import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";
import { buildEditableContextMenuTemplate } from "../../editorContextMenu";

/**
 * The right-click menu of a page in the ADE browser.
 *
 * Electron gives a `WebContentsView` no menu at all, so a right-click on a
 * page did nothing: no Reload, no Copy, no Inspect. This builds the menu a
 * browser has, laid out the way Chrome lays it out: what you clicked on first
 * (a link, an image, a text field, a selection), and Back / Forward / Reload
 * when you clicked the page itself.
 *
 * Every action goes through `actions`, which the caller binds to the clicked
 * page. The menu can stay open while the page closes, so each action must
 * check that its page still exists rather than trust it did when the menu
 * opened.
 */
export type BuiltInBrowserPageContextMenuActions = {
  /** Undo, cut, paste and spelling target this page's text field. */
  editTarget: Parameters<typeof buildEditableContextMenuTemplate>[0];
  canGoBack: boolean;
  canGoForward: boolean;
  back: () => void;
  forward: () => void;
  reload: () => void;
  copySelection: () => void;
  copyText: (text: string) => void;
  copyImageAt: (x: number, y: number) => void;
  inspectAt: (x: number, y: number) => void;
};

export function buildBuiltInBrowserPageContextMenuTemplate(
  params: ContextMenuParams,
  actions: BuiltInBrowserPageContextMenuActions,
): MenuItemConstructorOptions[] {
  const groups: MenuItemConstructorOptions[][] = [];
  const linkUrl = httpUrlOrNull(params.linkURL);
  if (linkUrl) {
    groups.push([{ label: "Copy link address", click: () => actions.copyText(linkUrl) }]);
  }
  const imageUrl = params.mediaType === "image" ? httpOrDataUrlOrNull(params.srcURL) : null;
  if (params.mediaType === "image") {
    const imageItems: MenuItemConstructorOptions[] = [
      { label: "Copy image", click: () => actions.copyImageAt(params.x, params.y) },
    ];
    // A `data:` URL can be megabytes; it is not an address anyone wants copied.
    if (imageUrl && !imageUrl.startsWith("data:")) {
      imageItems.push({ label: "Copy image address", click: () => actions.copyText(imageUrl) });
    }
    groups.push(imageItems);
  }
  const editable = buildEditableContextMenuTemplate(actions.editTarget, params);
  if (editable) {
    groups.push(editable);
  } else if (params.selectionText.length > 0) {
    groups.push([{ label: "Copy", click: actions.copySelection }]);
  }
  // The page itself: nothing more specific was under the pointer.
  if (groups.length === 0) {
    groups.push([
      { label: "Back", enabled: actions.canGoBack, click: actions.back },
      { label: "Forward", enabled: actions.canGoForward, click: actions.forward },
      { label: "Reload", click: actions.reload },
    ]);
  }
  groups.push([{ label: "Inspect", click: () => actions.inspectAt(params.x, params.y) }]);

  const template: MenuItemConstructorOptions[] = [];
  for (const group of groups) {
    if (template.length > 0) template.push({ type: "separator" });
    template.push(...group);
  }
  return template;
}

function httpUrlOrNull(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  try {
    const parsed = new URL(text);
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:" ? text : null;
  } catch {
    return null;
  }
}

function httpOrDataUrlOrNull(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  if (text.startsWith("data:")) return text;
  return httpUrlOrNull(text);
}

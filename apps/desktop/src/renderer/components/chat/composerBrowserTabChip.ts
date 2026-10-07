import { chipDisplayLabel, chipFromBrowserTab } from "../../../shared/chips";
import {
  hasBrowserTabMention,
  parseBrowserTabMentions,
  type BrowserTabMentionMatch,
} from "../../../shared/browserTabMention";
import { hydrateTokenChipsInEditor } from "./composerChipDom";
import { COMPOSER_PILL_CHIP_BASE_CLASS, COMPOSER_TOKEN_CHIP_ICON_CLASS, GLOBE_MARK } from "./mentionChipMark";

// The composer's twin of the transcript's `browser_tab` pill: it shows the tab,
// and serializes the `<ade-browser-tab>` block the agent reads.

// Wider than a mention chip: a page title needs more room than a lane name.
const CHIP_CLASS = `${COMPOSER_PILL_CHIP_BASE_CLASS} max-w-[14rem] cursor-default`;

export function createBrowserTabChipNode(match: BrowserTabMentionMatch): HTMLElement {
  const model = chipFromBrowserTab(match, match.token);
  const label = chipDisplayLabel(model);
  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.dataset.composerChip = "browser-tab";
  chip.dataset.composerChipText = match.token;
  chip.dataset.browserTabId = match.tabId;
  chip.className = CHIP_CLASS;
  chip.title = match.url && match.url !== label ? `${label} — ${match.url}` : label;
  chip.setAttribute("aria-label", `Browser tab: ${label}`);
  const icon = document.createElement("span");
  icon.className = COMPOSER_TOKEN_CHIP_ICON_CLASS;
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = GLOBE_MARK;
  const text = document.createElement("span");
  text.dataset.composerChipLabel = "true";
  text.className = "truncate";
  text.textContent = label;
  chip.append(icon, text);
  return chip;
}

/** Turn every `<ade-browser-tab>` block in the editor's loose text into a chip. */
export function hydrateBrowserTabChipsInEditor(editor: HTMLElement): boolean {
  return hydrateTokenChipsInEditor(editor, {
    has: hasBrowserTabMention,
    parse: parseBrowserTabMentions,
    createNode: createBrowserTabChipNode,
  });
}

/**
 * Insert a tab chip at the caret the user last left in the editor (or at the
 * end), padded with a space from the text before it. Returns the chip.
 */
export function insertBrowserTabChip(
  editor: HTMLElement,
  savedRange: Range | null,
  match: BrowserTabMentionMatch,
): HTMLElement {
  const range = savedRange && editor.contains(savedRange.commonAncestorContainer)
    ? savedRange.cloneRange()
    : (() => {
      const end = document.createRange();
      end.selectNodeContents(editor);
      return end;
    })();
  // Insert beside a selection, never over it: the user was elsewhere when they
  // picked the tab, and a stale highlight is not an edit intent.
  range.collapse(false);
  const chip = createBrowserTabChipNode(match);
  range.insertNode(chip);
  const before = chip.previousSibling;
  if (before && !(before instanceof Text && /[\s\u00a0]$/.test(before.textContent ?? ""))) {
    chip.before(document.createTextNode(" "));
  }
  return chip;
}

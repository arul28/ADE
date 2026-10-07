import { chipDisplayLabel, chipFromBrowserTab } from "../../../shared/chips";
import {
  hasBrowserTabMention,
  parseBrowserTabMentions,
  type BrowserTabMentionMatch,
} from "../../../shared/browserTabMention";

// The composer's twin of the transcript's `browser_tab` pill: it shows the tab,
// and serializes the `<ade-browser-tab>` block the agent reads.

const CHIP_CLASS =
  "mx-0.5 inline-flex max-w-[14rem] translate-y-px cursor-default items-center gap-1 rounded border border-violet-300/22 bg-violet-500/12 px-1 py-px font-sans text-[length:calc(var(--chat-font-size)*11/14)] leading-4 text-violet-100/88 align-baseline";

// A globe in the same Lucide-style stroke as the mention marks (`mentionChipMark.ts`).
const GLOBE_SVG =
  '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" style="display:block"><circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" /><path d="M2 12h20" /></svg>';

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
  icon.className = "inline-flex h-3 w-3 shrink-0 items-center justify-center text-violet-100/75";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = GLOBE_SVG;
  const text = document.createElement("span");
  text.dataset.composerChipLabel = "true";
  text.className = "truncate";
  text.textContent = label;
  chip.append(icon, text);
  return chip;
}

/** Turn every `<ade-browser-tab>` block in the editor's loose text into a chip. */
export function hydrateBrowserTabChipsInEditor(editor: HTMLElement): boolean {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (
        !parent
        || parent.closest("[data-composer-chip], [data-ios-context-id], [data-app-control-context-id], [data-built-in-browser-context-id]")
      ) {
        return NodeFilter.FILTER_REJECT;
      }
      return hasBrowserTabMention(node.textContent ?? "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    nodes.push(current as Text);
    current = walker.nextNode();
  }
  let changed = false;
  for (const node of nodes) {
    const text = node.textContent ?? "";
    const matches = parseBrowserTabMentions(text);
    if (!matches.length) continue;
    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const match of matches) {
      if (match.start > offset) fragment.append(document.createTextNode(text.slice(offset, match.start)));
      fragment.append(createBrowserTabChipNode(match));
      offset = match.end;
    }
    if (offset < text.length) fragment.append(document.createTextNode(text.slice(offset)));
    node.replaceWith(fragment);
    changed = true;
  }
  return changed;
}

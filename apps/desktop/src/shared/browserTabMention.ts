// A built-in browser tab attached to a chat message ("Attach to chat" on a tab).
//
// The message carries one single-line `<ade-browser-tab …>` block. The agent
// reads the tab id, title and URL off it plus a sentence telling it how to take
// the tab over; every ADE surface that draws chips reads the same block back as
// a `browser_tab` pill (see `chips.ts`), so the user sees the tab, not the
// instruction. Single-line on purpose: the composer's rich editor and the chip
// parser both work one text node at a time.

export type BrowserTabMentionTarget = {
  tabId: string;
  title: string | null;
  url: string | null;
};

export type BrowserTabMentionMatch = BrowserTabMentionTarget & {
  start: number;
  end: number;
  token: string;
};

const OPEN_TAG = "<ade-browser-tab ";
const CLOSE_TAG = "</ade-browser-tab>";
const BROWSER_TAB_MENTION_RE = /<ade-browser-tab id="([^"\n]*)" title="([^"\n]*)" url="([^"\n]*)">[^\n]*?<\/ade-browser-tab>/g;

function oneLine(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function unescapeAttribute(value: string): string {
  return value.replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** The one sentence that tells an agent how to drive the tab it was handed. */
export function browserTabTakeoverHint(tabId: string): string {
  return `Take it over with \`ade browser claim --tab ${tabId} --text\`, then drive it with \`ade browser <command> --tab ${tabId}\` (or a browser session on that tab).`;
}

/** The serialized block a chat message carries for one attached tab. */
export function formatBrowserTabMentionToken(target: BrowserTabMentionTarget): string {
  const tabId = oneLine(target.tabId);
  const title = oneLine(target.title);
  const url = oneLine(target.url);
  return `${OPEN_TAG}id="${escapeAttribute(tabId)}" title="${escapeAttribute(title)}" url="${escapeAttribute(url)}">`
    + `The user attached ADE browser tab ${tabId}. ${browserTabTakeoverHint(tabId)}${CLOSE_TAG}`;
}

/** Plain text for a CLI agent's terminal, which has no chip to draw. */
export function formatBrowserTabMentionForPrompt(target: BrowserTabMentionTarget): string {
  const tabId = oneLine(target.tabId);
  const title = oneLine(target.title);
  const url = oneLine(target.url);
  const described = [title ? `"${title}"` : null, url ? `(${url})` : null].filter(Boolean).join(" ");
  return `ADE browser tab ${described ? `${described}, ` : ""}tab id ${tabId}. ${browserTabTakeoverHint(tabId)}`;
}

export function hasBrowserTabMention(text: string): boolean {
  return text.includes(OPEN_TAG);
}

export function parseBrowserTabMentions(text: string): BrowserTabMentionMatch[] {
  if (!hasBrowserTabMention(text)) return [];
  const out: BrowserTabMentionMatch[] = [];
  BROWSER_TAB_MENTION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BROWSER_TAB_MENTION_RE.exec(text)) !== null) {
    const tabId = unescapeAttribute(match[1] ?? "");
    if (!tabId) continue;
    out.push({
      tabId,
      title: unescapeAttribute(match[2] ?? "") || null,
      url: unescapeAttribute(match[3] ?? "") || null,
      start: match.index,
      end: match.index + match[0].length,
      token: match[0],
    });
  }
  return out;
}

import { isRedactedBuiltInBrowserQueryParam } from "./types/builtInBrowser";

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

// One line, and no control characters: a page title reaches a CLI agent as a
// bracketed paste, where an embedded escape sequence could end the paste early
// and type the rest as keystrokes.
function oneLine(value: string | null | undefined): string {
  return (value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function unescapeAttribute(value: string): string {
  return value.replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/**
 * What tells an agent how to use the tab it was handed. The tab is live in
 * front of the user, so a fetched copy of its URL misses the sign-in, the
 * scroll position and anything the page changed since it loaded.
 */
export function browserTabTakeoverHint(tabId: string): string {
  return `It is live in front of the user: take it over with \`ade browser claim --tab ${tabId} --text\`, then read it with \`ade browser text --tab ${tabId} --text\` (its words) or \`ade browser observe --tab ${tabId}\` (what to click), and act on it in place with \`ade browser <command> --tab ${tabId}\`. Do not web-fetch or curl its URL or open it in a new tab: a copy is not what the user sees.`;
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

/** Automatic page context omits credentials and fragments from the live URL. */
export function formatBrowserPaneContextForPrompt(target: BrowserTabMentionTarget): string {
  let url: string | null = oneLine(target.url) || null;
  if (url) {
    try {
      const parsed = new URL(url);
      let changed = Boolean(parsed.username || parsed.password || parsed.hash);
      parsed.username = "";
      parsed.password = "";
      parsed.hash = "";
      for (const name of [...parsed.searchParams.keys()]) {
        if (!isRedactedBuiltInBrowserQueryParam(name)
          && !/^(?:key|authorization|password|passwd)$|(?:token|secret|signature|credential|api[_-]?key)$/i.test(name)) continue;
        parsed.searchParams.set(name, "[redacted by ADE]");
        changed = true;
      }
      if (changed) url = parsed.toString();
    } catch {
      url = null;
    }
  }
  return formatBrowserTabMentionForPrompt({ ...target, url });
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

/**
 * `text` with every attached-tab block blanked out (same length, so offsets
 * still line up). A page title is the page's text, not the user's: an
 * `@chat:` or `@lane:` inside one must not expand into a mention.
 */
export function maskBrowserTabMentions(text: string): string {
  const matches = parseBrowserTabMentions(text);
  if (!matches.length) return text;
  let out = "";
  let offset = 0;
  for (const match of matches) {
    out += text.slice(offset, match.start) + " ".repeat(match.end - match.start);
    offset = match.end;
  }
  return out + text.slice(offset);
}

/**
 * Find in a chat (⌘F): the searchable text of each transcript row, and the
 * match list built from it.
 *
 * The search runs over the rows this pane already holds — the whole chat once
 * the history backfill has finished — not over the DOM, because the
 * transcript is virtualized and folded: most rows are not on the page. It
 * searches what a reader sees: the user's messages, the assistant's replies
 * (markdown reduced to its displayed text), and plan checklists. Reasoning,
 * tool calls and tool output are not searched.
 *
 * Painting is separate (ChatFindLayer): the rows that ARE mounted are searched
 * again in the DOM (`data-chat-find-text` elements) to place highlights.
 */
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { SCENE_FENCE_LANGUAGE } from "../../../shared/chatScene";
import { countOccurrences, foldFindCase } from "../../lib/findText";
import { resolveUserMessageBody, userMessageBodySearchText } from "./userMessageBody";
import { transcriptEventDrawsNothing } from "./chatThoughtRuns";
import type { ChatTranscriptGroupedEnvelope } from "./chatTranscriptRows";

/** Marks the elements of a row whose text find searches and paints. */
export const CHAT_FIND_TEXT_ATTRIBUTE = "data-chat-find-text";

type MdNode = {
  type: string;
  value?: string;
  lang?: string | null;
  children?: MdNode[];
};

/** Fences that render as something other than their source. */
const NON_TEXT_FENCES = new Set([SCENE_FENCE_LANGUAGE, "mermaid"]);

const BLOCK_NODES = new Set([
  "paragraph", "heading", "blockquote", "list", "listItem", "table", "tableRow", "tableCell", "code", "thematicBreak", "break",
]);

const markdownProcessor = unified().use(remarkParse).use(remarkGfm);

function appendDisplayedText(node: MdNode, out: string[]): void {
  switch (node.type) {
    case "text":
    case "inlineCode":
      out.push(node.value ?? "");
      return;
    case "code":
      if (NON_TEXT_FENCES.has((node.lang ?? "").trim().toLowerCase())) return;
      out.push("\n", node.value ?? "", "\n");
      return;
    // Raw HTML is not rendered, an image shows a picture (or a proof figure),
    // and a footnote/definition is not part of the reading text.
    case "html":
    case "image":
    case "imageReference":
    case "definition":
    case "footnoteDefinition":
      return;
    default:
      break;
  }
  const block = BLOCK_NODES.has(node.type);
  if (block) out.push("\n");
  for (const child of node.children ?? []) appendDisplayedText(child, out);
  if (block) out.push("\n");
}

const MAX_CACHED_TEXTS = 4_000;
const MAX_CACHED_CHARS = 16_000_000;
const displayedTextCache = new Map<string, string>();
let cachedChars = 0;

/**
 * The text a markdown body shows: link labels without their URLs, code
 * without fences, no scene/diagram source, blocks separated by "\n" so
 * a match never runs from one paragraph into the next. Cached by source text:
 * a reply is parsed once, however many queries are typed.
 */
function markdownDisplayedText(markdown: string): string {
  const cached = displayedTextCache.get(markdown);
  if (cached !== undefined) return cached;
  let text: string;
  try {
    const out: string[] = [];
    appendDisplayedText(markdownProcessor.parse(markdown) as MdNode, out);
    text = out.join("").replace(/\n{2,}/g, "\n").trim();
  } catch {
    text = markdown;
  }
  displayedTextCache.set(markdown, text);
  cachedChars += markdown.length + text.length;
  while (displayedTextCache.size > MAX_CACHED_TEXTS || cachedChars > MAX_CACHED_CHARS) {
    const oldest = displayedTextCache.keys().next().value;
    if (oldest === undefined) break;
    cachedChars -= oldest.length + (displayedTextCache.get(oldest)?.length ?? 0);
    displayedTextCache.delete(oldest);
  }
  return text;
}

type RowSource = { text: string; markdown: boolean } | null;

/**
 * Sources by event object. Rows are rebuilt on every streamed delta, but their
 * events keep their identity unless they changed, so each user message's
 * review-block and chip parsing runs once, not once per update.
 */
const rowSourceByEvent = new WeakMap<object, RowSource>();

/** The row's searchable source, or null when the row is not searched. No markdown parsing. */
function chatFindRowSource(row: ChatTranscriptGroupedEnvelope): RowSource {
  const event = row.event;
  const cached = rowSourceByEvent.get(event);
  if (cached !== undefined) return cached;
  const source = computeRowSource(event);
  rowSourceByEvent.set(event, source);
  return source;
}

function computeRowSource(event: ChatTranscriptGroupedEnvelope["event"]): RowSource {
  switch (event.type) {
    case "user_message":
      // A queued steer lives in the composer's staging area, not the timeline.
      if (transcriptEventDrawsNothing(event)) return null;
      return userMessageBodySearchText(resolveUserMessageBody(event));
    case "text":
      return event.text ? { text: event.text, markdown: true } : null;
    case "plan": {
      const steps = Array.isArray(event.steps) ? event.steps : [];
      const lines = [event.explanation?.trim() ?? "", ...steps.map((step) => step.text ?? "")].filter(Boolean);
      return lines.length ? { text: lines.join("\n"), markdown: false } : null;
    }
    default:
      return null;
  }
}

/** One searchable row: its key, and its displayed text case-folded. */
type ChatFindDoc = { key: string; folded: string };

/**
 * The searchable rows of a transcript, kept up to date incrementally.
 *
 * Markdown parsing is the one costly step (~70-80 ms for a whole 9 MB chat in
 * one go), so a fresh index is built in slices (`indexSome`) a few
 * milliseconds at a time, and a row whose text did not change keeps its
 * folded text across updates (streaming rebuilds only the streaming row).
 */
export class ChatFindIndex {
  private order: { key: string; text: string; markdown: boolean }[] = [];
  private folded = new Map<string, { source: string; folded: string }>();
  private cursor = 0;

  /** Point the index at a new row list. Returns true when the searchable rows changed. */
  update(rows: readonly ChatTranscriptGroupedEnvelope[], excludedKeys: ReadonlySet<string>): boolean {
    const next: { key: string; text: string; markdown: boolean }[] = [];
    for (const row of rows) {
      if (excludedKeys.has(row.key)) continue;
      const source = chatFindRowSource(row);
      if (!source || !source.text.trim()) continue;
      next.push({ key: row.key, text: source.text, markdown: source.markdown });
    }
    const changed = next.length !== this.order.length
      || next.some((entry, index) => {
        const previous = this.order[index]!;
        return previous.key !== entry.key || previous.text !== entry.text;
      });
    if (!changed) return false;
    this.order = next;
    this.cursor = 0;
    const live = new Set(next.map((entry) => entry.key));
    for (const key of this.folded.keys()) if (!live.has(key)) this.folded.delete(key);
    return true;
  }

  /** True while some rows' folded text is not computed yet. */
  hasPending(): boolean {
    this.skipReady();
    return this.cursor < this.order.length;
  }

  private skipReady(): void {
    while (this.cursor < this.order.length) {
      const entry = this.order[this.cursor]!;
      if (this.folded.get(entry.key)?.source !== entry.text) break;
      this.cursor += 1;
    }
  }

  /** Fold rows for about `budgetMs`. Returns true when every row is ready. */
  indexSome(budgetMs: number): boolean {
    const deadline = performance.now() + budgetMs;
    for (;;) {
      this.skipReady();
      if (this.cursor >= this.order.length) return true;
      const entry = this.order[this.cursor]!;
      const shown = entry.markdown ? markdownDisplayedText(entry.text) : entry.text;
      this.folded.set(entry.key, { source: entry.text, folded: foldFindCase(shown) });
      this.cursor += 1;
      if (performance.now() >= deadline) return this.cursor >= this.order.length;
    }
  }

  /** Searchable rows in transcript order; rows not folded yet are left out. */
  docs(): ChatFindDoc[] {
    const docs: ChatFindDoc[] = [];
    for (const entry of this.order) {
      const ready = this.folded.get(entry.key);
      if (ready && ready.source === entry.text) docs.push({ key: entry.key, folded: ready.folded });
    }
    return docs;
  }
}

/** Rows with at least one match, in transcript order, with running offsets. */
export type ChatFindMatches = {
  entries: { key: string; count: number; start: number }[];
  total: number;
};

export function computeChatFindMatches(docs: readonly ChatFindDoc[], query: string): ChatFindMatches {
  const needle = foldFindCase(query);
  const entries: ChatFindMatches["entries"] = [];
  let total = 0;
  if (!query.trim()) return { entries, total };
  for (const doc of docs) {
    const count = countOccurrences(doc.folded, needle);
    if (!count) continue;
    entries.push({ key: doc.key, count, start: total });
    total += count;
  }
  return { entries, total };
}

/** The row and occurrence of the match at `index` (0-based, in transcript order). */
export function chatFindMatchAt(
  matches: ChatFindMatches,
  index: number,
): { key: string; occurrence: number } | null {
  if (index < 0 || index >= matches.total) return null;
  let low = 0;
  let high = matches.entries.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const entry = matches.entries[mid]!;
    if (index < entry.start) high = mid - 1;
    else if (index >= entry.start + entry.count) low = mid + 1;
    else return { key: entry.key, occurrence: index - entry.start };
  }
  return null;
}

/**
 * Index of the match identified by row and occurrence, or null when that row
 * no longer has it. Used to keep the selection on the same words while
 * streaming adds or removes matches elsewhere.
 */
export function chatFindIndexOf(
  matches: ChatFindMatches,
  identity: { key: string; occurrence: number },
): number | null {
  const entry = matches.entries.find((candidate) => candidate.key === identity.key);
  if (!entry) return null;
  return entry.start + Math.min(identity.occurrence, entry.count - 1);
}

/**
 * The first match in or below the reader's position: the first match whose row
 * comes at or after `fromKey` in transcript order. Wraps to the first match.
 * `orderOf` gives a row's position among all rows (searchable or not).
 */
export function chatFindStartIndex(
  matches: ChatFindMatches,
  fromOrder: number | null,
  orderOf: (key: string) => number | undefined,
): number | null {
  if (matches.total === 0) return null;
  if (fromOrder == null) return 0;
  for (const entry of matches.entries) {
    const order = orderOf(entry.key);
    if (order !== undefined && order >= fromOrder) return entry.start;
  }
  return 0;
}

import { reasoningEffortToneRgb } from "../shared/ModelPicker/ReasoningEffortPicker";

/**
 * Claude Code reads the word "ultrathink" anywhere in a prompt (whole word, any
 * case) as a request to reason harder on that one turn. It does not change the
 * effort level, so it stacks on whichever level is selected. ADE sends the
 * word as part of the message; the composer only shows that it is there.
 */
const ULTRATHINK_PATTERN_GLOBAL = /\bultrathink\b/gi;
/** The word plus the separator the switch adds after it. */
const ULTRATHINK_WITH_SEPARATOR = /\bultrathink\b:?[ \t]?/gi;

/** One colour per letter, cycling, like Claude Code's own terminal. */
export const ULTRATHINK_LETTER_COLORS = [
  "#f87171",
  "#fb923c",
  "#facc15",
  "#4ade80",
  "#2dd4bf",
  "#60a5fa",
  "#c084fc",
] as const;

export function hasUltrathinkKeyword(
  text: string,
  excludedRanges: readonly { start: number; end: number }[] = [],
): boolean {
  return ultrathinkKeywordRanges(text).some((range) =>
    !excludedRanges.some((excluded) => range.start < excluded.end && excluded.start < range.end)
  );
}

export function ultrathinkKeywordRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const match of text.matchAll(ULTRATHINK_PATTERN_GLOBAL)) {
    if (match.index === undefined) continue;
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

/**
 * Adds the keyword to a draft. A slash command must stay first in the message,
 * so the keyword goes after it there and in front of everything else.
 */
export function addUltrathinkKeyword(
  text: string,
  excludedRanges: readonly { start: number; end: number }[] = [],
): string {
  if (hasUltrathinkKeyword(text, excludedRanges)) return text;
  if (text.trimStart().startsWith("/")) {
    return /\s$/.test(text) ? `${text}ultrathink` : `${text} ultrathink`;
  }
  return `ultrathink ${text}`;
}

export function removeUltrathinkKeyword(
  text: string,
  excludedRanges: readonly { start: number; end: number }[] = [],
): string {
  return text.replace(ULTRATHINK_WITH_SEPARATOR, (match, offset: number) => {
    const end = offset + "ultrathink".length;
    return excludedRanges.some((range) => offset < range.end && range.start < end) ? match : "";
  });
}

/** Only Claude Code reads the keyword. */
export function providerReadsUltrathink(provider: string | null | undefined): boolean {
  return provider === "claude";
}

export function hasUltrathinkKeywordInEditableText(root: HTMLElement | null): boolean {
  if (!root) return false;
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (!text.parentElement?.closest("[contenteditable='false']") && hasUltrathinkKeyword(text.data)) return true;
  }
  return false;
}

export type ComposerEffortFrame =
  | { kind: "ultrathink" }
  | { kind: "top"; ultra: boolean; rgb: string };

/**
 * The prompt box's frame: a rainbow when ultrathink is in the message, else the
 * colour of the model's highest thinking level while that level is selected.
 * Every provider and model gets the top-level frame; a model with a single
 * level has nothing to climb to, so it gets none.
 */
export function resolveComposerEffortFrame(args: {
  ultrathink: boolean;
  effort: string | null | undefined;
  tiers: readonly string[] | null | undefined;
}): ComposerEffortFrame | null {
  if (args.ultrathink) return { kind: "ultrathink" };
  const tiers = args.tiers ?? [];
  const effort = args.effort ?? null;
  if (tiers.length < 2 || !effort || effort !== tiers[tiers.length - 1]) return null;
  return {
    kind: "top",
    ultra: effort === "ultra" || effort === "ultracode",
    rgb: reasoningEffortToneRgb(effort, tiers),
  };
}

type HighlightCtor = new (...ranges: Range[]) => unknown;
type HighlightRegistry = { set: (name: string, highlight: unknown) => void; delete: (name: string) => void };

/**
 * Letter ranges each composer currently paints. CSS highlights are registered
 * per document, so composers side by side share one set of names and each
 * publish rebuilds them from every composer's ranges.
 */
const ultrathinkRangesByOwner = new Map<string, Range[][]>();

function highlightApi(): { Highlight: HighlightCtor; registry: HighlightRegistry } | null {
  const registry = (globalThis.CSS as unknown as { highlights?: HighlightRegistry } | undefined)?.highlights;
  const Highlight = (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight;
  return registry && Highlight ? { Highlight, registry } : null;
}

/**
 * Colours every "ultrathink" in an editable root, letter by letter, through the
 * CSS Custom Highlight API: nothing is added to the editor's DOM, so the text
 * the composer serializes and sends is untouched. Pass `root: null` to clear
 * an owner (on unmount, or when its provider does not read the word).
 */
export function paintUltrathinkHighlights(owner: string, root: HTMLElement | null): void {
  const api = highlightApi();
  if (!api) return;
  const groups: Range[][] = ULTRATHINK_LETTER_COLORS.map(() => []);
  if (root) {
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node as Text;
      // Chips are their own read-only spans; their labels are not prompt words.
      if (text.parentElement?.closest("[contenteditable='false']")) continue;
      for (const { start, end } of ultrathinkKeywordRanges(text.data)) {
        for (let offset = start; offset < end; offset += 1) {
          const range = root.ownerDocument.createRange();
          range.setStart(text, offset);
          range.setEnd(text, offset + 1);
          groups[(offset - start) % groups.length]!.push(range);
        }
      }
    }
  }
  if (groups.some((ranges) => ranges.length > 0)) ultrathinkRangesByOwner.set(owner, groups);
  else if (!ultrathinkRangesByOwner.delete(owner)) return;
  ULTRATHINK_LETTER_COLORS.forEach((_, index) => {
    const ranges = [...ultrathinkRangesByOwner.values()].flatMap((owned) => owned[index] ?? []);
    const name = `ade-ultrathink-${index}`;
    if (ranges.length) api.registry.set(name, new api.Highlight(...ranges));
    else api.registry.delete(name);
  });
}

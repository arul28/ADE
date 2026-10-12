/**
 * The PR Brief: a pull request description a person can read fast.
 *
 * It is plain markdown, so GitHub shows it as ordinary text and ADE needs no
 * second copy. The parts are headings an author would write anyway:
 *
 *   ## Why            the problem, in plain words
 *   ## What changed   what is different now, for the person who uses it
 *   ## Evidence       how the author checked it and what they saw
 *   ## Not checked    what they could not check
 *   ## Choices I made (optional) trade-offs the author settled alone
 *
 * Older and foreign templates answer the same questions under other names
 * (Problem, Change, Verification, Test plan), so those headings map to the same
 * parts. Nothing is dropped: a heading this file does not know stays in place
 * as an "other" part, and text before the first heading is the lead.
 *
 * `prBriefHints` is the checker the CLI prints after a PR is made. It guides
 * and never refuses.
 */

export type PrBriefPartKind = "why" | "changed" | "evidence" | "not_checked" | "choices" | "other";

export type PrBriefPart = {
  kind: PrBriefPartKind;
  /** The heading as the author wrote it. */
  heading: string;
  /** The markdown under the heading. */
  body: string;
};

export type PrBrief = {
  /** Markdown before the first heading. Empty when the text starts with one. */
  lead: string;
  parts: PrBriefPart[];
  /** Sign-off lines and ADE's own link block, cut from the last part. */
  footer: string;
};

export const PR_BRIEF_HEADINGS = {
  why: "Why",
  changed: "What changed",
  evidence: "Evidence",
  not_checked: "Not checked",
  choices: "Choices I made",
} as const satisfies Record<Exclude<PrBriefPartKind, "other">, string>;

const HEADING_KINDS: ReadonlyArray<[Exclude<PrBriefPartKind, "other">, RegExp]> = [
  ["not_checked", /^(not (checked|verified|tested|covered)|what i (could|did) not check|unverified|known gaps|limits)$/],
  ["why", /^(why|problem|the problem|motivation|context|background|cause|root cause)$/],
  ["changed", /^(what changed|what changed for the user|changes?|the change|change and boundary|summary|fix|the fix|solution)$/],
  ["evidence", /^(evidence|proof|verification|validation|testing|tests?|test plan|how i checked( it)?|how (it|this) was (tested|checked)|checks?)$/],
  ["choices", /^(choices i made|choices|decisions|trade-?offs|look closely|notes for review(ers)?|review notes)$/],
];

function headingKind(text: string): PrBriefPartKind {
  // "Performance (row measured)" and "Verification:" still name their part.
  const key = text
    .replace(/[*_`]/g, "")
    .replace(/\(.*\)\s*$/, "")
    .replace(/[:.]\s*$/, "")
    .trim()
    .toLowerCase();
  for (const [kind, pattern] of HEADING_KINDS) if (pattern.test(key)) return kind;
  return "other";
}

const FOOTER_START = /^(<!--\s*ade:link\b|🤖\s*Generated with\b|(authored|written|built|made) (with|by)\b|co-authored-by:)/i;

/** Cuts the sign-off and ADE's link block off the end of the last part. */
function splitFooter(text: string): { body: string; footer: string } {
  const lines = text.split("\n");
  let fence: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const mark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1] ?? null;
    if (mark) {
      if (!fence) fence = mark[0]!;
      else if (mark[0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    if (!FOOTER_START.test(line.trim())) continue;
    // A sign-off starts a paragraph; the same words mid-paragraph are prose.
    if (index > 0 && lines[index - 1]!.trim() !== "") continue;
    return { body: lines.slice(0, index).join("\n").trim(), footer: lines.slice(index).join("\n").trim() };
  }
  return { body: text.trim(), footer: "" };
}

/**
 * Splits a description at its top headings (`#` to `###`). Returns null when
 * the text does not answer at least two of the Brief's questions, one of them
 * what changed or how it was checked: such a text is shown as written.
 */
export function parsePrBrief(markdown: string | null | undefined): PrBrief | null {
  const text = (markdown ?? "").replace(/\r\n?/g, "\n");
  if (!text.trim()) return null;
  const lines = text.split("\n");
  const cuts: Array<{ line: number; heading: string; level: number }> = [];
  let fence: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const mark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1] ?? null;
    if (mark) {
      if (!fence) fence = mark[0]!;
      else if (mark[0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) cuts.push({ line: index, heading: heading[2]!.trim(), level: heading[1]!.length });
  }
  if (cuts.length === 0) return null;
  // The parts are the headings of the shallowest level that names one; a
  // deeper heading under a part belongs to that part's body.
  const named = cuts.filter((cut) => headingKind(cut.heading) !== "other");
  if (named.length === 0) return null;
  const level = Math.min(...named.map((cut) => cut.level));
  const top = cuts.filter((cut) => cut.level <= level);

  const lead = lines.slice(0, top[0]!.line).join("\n").trim();
  const parts: PrBriefPart[] = top.map((cut, index) => ({
    kind: headingKind(cut.heading),
    heading: cut.heading.replace(/[:.]\s*$/, ""),
    body: lines.slice(cut.line + 1, top[index + 1]?.line ?? lines.length).join("\n").trim(),
  }));

  const kinds = new Set(parts.map((part) => part.kind).filter((kind) => kind !== "other"));
  if (kinds.size < 2 || !(kinds.has("changed") || kinds.has("evidence"))) return null;

  const last = parts[parts.length - 1]!;
  const { body, footer } = splitFooter(last.body);
  last.body = body;
  return { lead, parts, footer };
}

/* ── What kind of evidence a part holds ─────────────────────────────── */

export type PrBriefEvidenceCounts = {
  pictures: number;
  videos: number;
  /** Shell commands and code blocks: what the author ran. */
  commands: number;
  /** Tables: measured numbers. */
  tables: number;
};

const VIDEO_URL = /\.(mp4|mov|webm|m4v)(\?|#|\)|\s|"|$)/i;

export function prBriefEvidenceCounts(markdown: string): PrBriefEvidenceCounts {
  const counts: PrBriefEvidenceCounts = { pictures: 0, videos: 0, commands: 0, tables: 0 };
  const withoutFences = markdown.replace(/(^|\n)\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\s*\2[^\n]*(?=\n|$)/g, (block) => {
    if (!/^\s*(`{3,}|~{3,})\s*(proof-compare|mermaid)\b/.test(block.trimStart())) counts.commands += 1;
    else if (/proof-compare/.test(block)) counts.pictures += 2;
    return "\n";
  });
  for (const match of withoutFences.matchAll(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)|<img\b[^>]*>|<video\b[^>]*>/gi)) {
    if (/^<video/i.test(match[0]) || VIDEO_URL.test(match[1] ?? "")) counts.videos += 1;
    else counts.pictures += 1;
  }
  const withoutImages = withoutFences.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  for (const match of withoutImages.matchAll(/(^|\s)(https:\/\/\S+)/g)) {
    if (VIDEO_URL.test(match[2]!)) counts.videos += 1;
  }
  counts.commands += (withoutFences.match(/`[^`\n]+`/g) ?? []).filter((span) => /\s/.test(span) || /^`(npm|npx|node|git|gh|ade|pnpm|yarn|bun|cargo|go|make|pytest|swift|xcodebuild)\b/.test(span)).length;
  counts.tables = (withoutFences.match(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/gm) ?? []).length;
  return counts;
}

/** "2 pictures · 1 video · 3 commands", or null when the part is words only. */
export function prBriefEvidenceSummary(counts: PrBriefEvidenceCounts): string | null {
  const plural = (count: number, one: string, many: string) => (count === 1 ? `1 ${one}` : `${count} ${many}`);
  const bits = [
    counts.pictures ? plural(counts.pictures, "picture", "pictures") : null,
    counts.videos ? plural(counts.videos, "video", "videos") : null,
    counts.tables ? plural(counts.tables, "table", "tables") : null,
    counts.commands ? plural(counts.commands, "command", "commands") : null,
  ].filter(Boolean);
  return bits.length ? bits.join(" · ") : null;
}

/* ── Hints: what the CLI tells an author after the PR is made ───────── */

export type PrBriefHint = {
  code:
    | "no_parts"
    | "no_why"
    | "no_changed"
    | "no_evidence"
    | "no_not_checked"
    | "tests_pass_only"
    | "placeholder"
    | "code_names"
    | "long";
  message: string;
};

/** The lines ADE's own empty draft holds, one for each part. */
export const PR_BRIEF_PLACEHOLDERS = {
  why: "_The problem, in one or two plain sentences._",
  changed: "_What is different now for the person who uses it._",
  evidence: "_How you checked it and what you saw._",
  not_checked: "_What you could not check._",
} as const;

const PLACEHOLDER = new RegExp(
  `(${[
    ...Object.values(PR_BRIEF_PLACEHOLDERS),
    // The draft ADE wrote before the Brief.
    "_Describe the change._", "_Key files and behaviors._", "_How you tested._", "_Anything to watch._",
  ].map((text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")}|\\bTBD\\b|\\bTODO\\b|\\bpending \\/\\w+)`,
  "i",
);
/** Words of author prose up to which a text needs no parts at all. */
export const PR_BRIEF_SHORT_WORDS = 60;
/** Words of author prose past which a description stops being read. */
export const PR_BRIEF_LONG_WORDS = 450;
/** Code names in the lead and Why past which a reader must stop to decode. */
export const PR_BRIEF_MAX_WHY_CODE_NAMES = 3;

function proseWords(markdown: string): number {
  return markdown
    .replace(/(^|\n)\s*(`{3,}|~{3,})[\s\S]*?\n\s*\2[^\n]*/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .split(/\s+/)
    .filter((word) => /[A-Za-z0-9]/.test(word)).length;
}

/**
 * What an author could do better, most useful first. Empty for a text that
 * follows the Brief. Each line says what is missing and what to write.
 */
export function prBriefHints(markdown: string | null | undefined): PrBriefHint[] {
  const text = (markdown ?? "").replace(/\r\n?/g, "\n");
  const hints: PrBriefHint[] = [];
  const brief = parsePrBrief(text);
  if (!brief) {
    // A small fix told in a few sentences needs no headings.
    if (proseWords(text) <= PR_BRIEF_SHORT_WORDS) return [];
    return [{
      code: "no_parts",
      message: `The text has no parts a reader can find. Use these headings: "## ${PR_BRIEF_HEADINGS.why}", "## ${PR_BRIEF_HEADINGS.changed}", "## ${PR_BRIEF_HEADINGS.evidence}", "## ${PR_BRIEF_HEADINGS.not_checked}".`,
    }];
  }
  const body = (kind: PrBriefPartKind) => brief.parts.filter((part) => part.kind === kind).map((part) => part.body).join("\n\n");
  const has = (kind: PrBriefPartKind) => brief.parts.some((part) => part.kind === kind && part.body.trim() !== "");

  if (!has("why")) hints.push({ code: "no_why", message: `No "${PR_BRIEF_HEADINGS.why}" part. Say the problem in one or two plain sentences.` });
  if (!has("changed")) hints.push({ code: "no_changed", message: `No "${PR_BRIEF_HEADINGS.changed}" part. Say what is different now for the person who uses it.` });
  if (!has("evidence")) {
    hints.push({ code: "no_evidence", message: `No "${PR_BRIEF_HEADINGS.evidence}" part. Say how you checked the change and what you saw, or say why no check is necessary.` });
  } else {
    const evidence = body("evidence");
    const counts = prBriefEvidenceCounts(evidence);
    const onlyPasses = proseWords(evidence) <= 14
      && /\b(tests?|ci|checks?|typecheck|lint|build)\b[^.\n]*\b(pass(es|ed|ing)?|green|clean|ok)\b/i.test(evidence)
      && counts.pictures + counts.videos + counts.tables === 0;
    if (onlyPasses) {
      hints.push({ code: "tests_pass_only", message: `"Tests pass" alone does not show that the change works. Say what you ran, on what, and what you saw.` });
    }
  }
  if (!has("not_checked")) {
    hints.push({ code: "no_not_checked", message: `No "${PR_BRIEF_HEADINGS.not_checked}" part. Say what you could not check, or write "Nothing".` });
  }
  const placeholder = PLACEHOLDER.exec(text);
  if (placeholder) hints.push({ code: "placeholder", message: `The text still holds a placeholder ("${placeholder[0]}"). Replace it with the real result.` });

  const opening = `${brief.lead}\n${body("why")}`;
  const codeNames = new Set(opening.match(/`[^`\n]+`/g) ?? []).size;
  if (codeNames > PR_BRIEF_MAX_WHY_CODE_NAMES) {
    hints.push({ code: "code_names", message: `The opening holds ${codeNames} code names. Say what each one is in plain words where it first appears, or move it to "${PR_BRIEF_HEADINGS.evidence}".` });
  }
  const words = proseWords(`${brief.lead}\n${brief.parts.map((part) => part.body).join("\n")}`);
  if (words > PR_BRIEF_LONG_WORDS) {
    hints.push({ code: "long", message: `The text has ${words} words. Cut what a reader does not need to decide; the diff holds the rest.` });
  }
  return hints;
}

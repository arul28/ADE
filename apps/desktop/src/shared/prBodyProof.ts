import { markdownFenceLines } from "./markdownFences";
import { parseProofCompareBlock, PROOF_COMPARE_FENCE_LANGUAGE, type ProofCompareBlock } from "./proofCitation";

/**
 * Proof inside a pull request's text.
 *
 * An author cites proof in a PR the way they cite it in a chat answer:
 * `![caption](ade-proof://<id>)` and the ```proof-compare fence. GitHub cannot
 * show either, so before the text is read there the CLI uploads the files and
 * rewrites each citation to ordinary markdown (`rewritePrBodyProofForGithub`):
 * a picture, or a Before | After table. Each uploaded picture keeps its proof
 * id in an HTML comment GitHub does not show.
 *
 * ADE reads that same text back (`preparePrBodyProofForAde`). The comment tells
 * it which proof a picture is, so the machine that holds the file shows its own
 * copy (a video plays with its chapters) and every other reader gets GitHub's.
 * The text stays the one source; nothing is stored beside it.
 */

const ID = "[A-Za-z0-9][A-Za-z0-9_-]{0,127}";
const ID_ONLY = new RegExp(`^${ID}$`);
const CITATION = new RegExp(`!\\[([^\\]]*)\\]\\(\\s*ade-proof:\\/{0,2}(${ID})\\/?\\s*\\)`, "g");
const MARKER = new RegExp(`<!--\\s*ade-proof:(${ID})\\s*-->`);
/** The fence ADE's PR markdown draws as a side-by-side figure. */
export const PR_COMPARE_FENCE_LANGUAGE = "pr-compare";
/** `title` prefix that carries a proof id on an image through the sanitizer. */
export const PR_PROOF_TITLE_PREFIX = "ade-proof:";
/** Host of the placeholder URL for a citation that was never uploaded. */
export const PR_PROOF_PLACEHOLDER_HOST = "ade-proof.invalid";

export type PrCompareSide = {
  /** "Before", "After", or the column's own heading. */
  title: string;
  /** GitHub's copy. Null for a citation that was never uploaded. */
  url: string | null;
  artifactId: string | null;
  label: string | null;
};

export type PrCompareFigure = { sides: PrCompareSide[]; caption: string | null };

type Segment =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "compare"; text: string; block: ProofCompareBlock };

/**
 * The text split at fenced code. A ```proof-compare fence that names a pair is
 * its own segment; every other fence is code and is passed through untouched.
 */
function segments(markdown: string): Segment[] {
  const out: Segment[] = [];
  let text: string[] = [];
  let fence: string[] = [];
  const flushText = () => {
    if (text.length) out.push({ kind: "text", text: text.join("\n") });
    text = [];
  };
  const flushFence = (language: string) => {
    const source = fence.join("\n");
    const block = language === PROOF_COMPARE_FENCE_LANGUAGE ? parseProofCompareBlock(fence.slice(1, -1).join("\n")) : null;
    out.push(block ? { kind: "compare", text: source, block } : { kind: "code", text: source });
    fence = [];
  };
  for (const entry of markdownFenceLines(markdown)) {
    if (entry.fence === null) {
      text.push(entry.line);
      continue;
    }
    if (entry.fence === "open") flushText();
    fence.push(entry.line);
    if (entry.fence === "close") flushFence(entry.language);
  }
  // A fence the text never closes runs to the end, and stays code.
  if (fence.length) out.push({ kind: "code", text: fence.join("\n") });
  flushText();
  return out;
}

/** Applies `fn` to prose only: inline code spans are left as they are. */
function outsideInlineCode(text: string, fn: (prose: string) => string): string {
  return text
    .split(/(`+[^`\n]*`+)/)
    .map((piece, index) => (index % 2 === 1 ? piece : fn(piece)))
    .join("");
}

/** Every proof id the text cites, in reading order, each once. */
export function prBodyProofIds(markdown: string | null | undefined): string[] {
  const ids: string[] = [];
  const add = (id: string) => {
    if (!ids.includes(id)) ids.push(id);
  };
  for (const segment of segments((markdown ?? "").replace(/\r\n?/g, "\n"))) {
    if (segment.kind === "compare") {
      add(segment.block.before.artifactId);
      add(segment.block.after.artifactId);
    } else if (segment.kind === "text") {
      outsideInlineCode(segment.text, (prose) => {
        for (const match of prose.matchAll(CITATION)) add(match[2]!);
        return prose;
      });
    }
  }
  return ids;
}

export type PrBodyProofFile = { file: string; video: boolean };

function altText(text: string | null | undefined): string {
  return (text ?? "").replace(/[[\]|\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function uploaded(caption: string | null | undefined, id: string, file: PrBodyProofFile): string {
  return `![${altText(caption)}](./${file.file})<!-- ade-proof:${id} -->`;
}

/**
 * The text GitHub will show. `fileFor` names the staged upload for a proof id,
 * or returns null for an item that cannot go up (no file on this machine, too
 * large); that citation is left as written, so ADE still shows it.
 */
export function rewritePrBodyProofForGithub(
  markdown: string,
  fileFor: (artifactId: string) => PrBodyProofFile | null,
): string {
  return segments(markdown.replace(/\r\n?/g, "\n")).map((segment) => {
    if (segment.kind === "code") return segment.text;
    if (segment.kind === "text") {
      return outsideInlineCode(segment.text, (prose) => prose.replace(CITATION, (whole, caption: string, id: string) => {
        const file = fileFor(id);
        return file ? uploaded(caption, id, file) : whole;
      }));
    }
    const { before, after, caption } = segment.block;
    const beforeFile = fileFor(before.artifactId);
    const afterFile = fileFor(after.artifactId);
    if (!beforeFile || !afterFile) return segment.text;
    const lines = beforeFile.video || afterFile.video
      // GitHub plays a video only on a line of its own, never in a table cell.
      ? [
        `**Before**${before.label ? ` — ${before.label}` : ""}`,
        "",
        uploaded(before.label ?? "Before", before.artifactId, beforeFile),
        "",
        `**After**${after.label ? ` — ${after.label}` : ""}`,
        "",
        uploaded(after.label ?? "After", after.artifactId, afterFile),
      ]
      : [
        "| Before | After |",
        "| --- | --- |",
        `| ${uploaded(before.label ?? "Before", before.artifactId, beforeFile)} | ${uploaded(after.label ?? "After", after.artifactId, afterFile)} |`,
      ];
    if (caption) lines.push("", caption);
    return lines.join("\n");
  }).join("\n");
}

/* ── Reading the text back in ADE ───────────────────────────────────── */

const IMAGE = /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"([^"]*)")?\s*\)/;
const IMAGE_ONLY = new RegExp(`^${IMAGE.source}$`);
/** An uploaded picture followed by the comment that carries its proof id. */
const MARKED_IMAGE = new RegExp(`${IMAGE.source}[ \\t]*${MARKER.source}`, "g");
/** gh may leave an uploaded video as a bare link. */
const MARKED_LINK = new RegExp(`(^|[\\s(])(https:\\/\\/[^\\s)<]+)[ \\t]*${MARKER.source}`, "g");
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

function readImageCell(cell: string): { url: string; artifactId: string | null; label: string | null } | null {
  const match = IMAGE_ONLY.exec(cell.trim());
  if (!match) return null;
  const title = match[3] ?? "";
  return {
    url: match[2]!,
    artifactId: title.startsWith(PR_PROOF_TITLE_PREFIX) ? title.slice(PR_PROOF_TITLE_PREFIX.length) : null,
    label: match[1]!.trim() || null,
  };
}

function compareFence(figure: PrCompareFigure): string {
  return `\`\`\`${PR_COMPARE_FENCE_LANGUAGE}\n${JSON.stringify(figure)}\n\`\`\``;
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

/** Most sides one figure shows; a wider table stays a table. */
const MAX_COMPARE_SIDES = 3;

/**
 * A table whose headings all start with Before or After and whose one row
 * holds one picture per cell is a comparison, whoever wrote it.
 */
function tablesToCompare(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index]!;
    const rule = lines[index + 1];
    const row = lines[index + 2];
    const after = lines[index + 3];
    const titles = header.includes("|") ? splitRow(header) : [];
    const isCompare = titles.length >= 2
      && titles.length <= MAX_COMPARE_SIDES
      && titles.every((title) => /^(before|after)\b/i.test(title))
      && rule !== undefined
      && TABLE_RULE.test(rule)
      && row !== undefined
      && (after === undefined || !after.includes("|"));
    const cells = isCompare ? splitRow(row!).map(readImageCell) : [];
    if (!isCompare || cells.length !== titles.length || cells.some((cell) => cell === null)) {
      out.push(header);
      continue;
    }
    out.push("", compareFence({
      sides: cells.map((cell, cellIndex) => ({ title: titles[cellIndex]!, ...cell! })),
      caption: null,
    }), "");
    index += 2;
  }
  return out.join("\n");
}

/** Cheap test for text that `preparePrBodyProofForAde` could change. */
export function prBodyMayHoldProof(markdown: string): boolean {
  return markdown.includes("ade-proof:") || /\|\s*(before|after)\b/i.test(markdown) || markdown.includes(PROOF_COMPARE_FENCE_LANGUAGE);
}

/**
 * The text as ADE's PR markdown draws it: proof ids moved from comments into
 * image titles, never-uploaded citations given a placeholder URL, and each
 * comparison turned into a ```pr-compare fence.
 */
export function preparePrBodyProofForAde(markdown: string): string {
  if (!prBodyMayHoldProof(markdown)) return markdown;
  return segments(markdown.replace(/\r\n?/g, "\n")).map((segment) => {
    if (segment.kind === "code") return segment.text;
    if (segment.kind === "compare") {
      const { before, after, caption } = segment.block;
      return compareFence({
        sides: [
          { title: "Before", url: null, artifactId: before.artifactId, label: before.label },
          { title: "After", url: null, artifactId: after.artifactId, label: after.label },
        ],
        caption,
      });
    }
    const marked = outsideInlineCode(segment.text, (prose) => prose
      .replace(MARKED_IMAGE, (_whole, alt: string, url: string, _title: string | undefined, id: string) =>
        `![${alt}](${url} "${PR_PROOF_TITLE_PREFIX}${id}")`)
      .replace(MARKED_LINK, (_whole, lead: string, url: string, id: string) =>
        `${lead}![](${url} "${PR_PROOF_TITLE_PREFIX}${id}")`)
      .replace(CITATION, (_whole, caption: string, id: string) =>
        `![${caption}](https://${PR_PROOF_PLACEHOLDER_HOST}/${id} "${PR_PROOF_TITLE_PREFIX}${id}")`));
    return tablesToCompare(stackedPairsToCompare(marked));
  }).join("\n");
}

/** The Before / After pair `rewritePrBodyProofForGithub` writes for videos. */
function stackedPairsToCompare(text: string): string {
  const side = (name: string) => `\\*\\*${name}\\*\\*(?: — ([^\\n]*))?\\n\\n(${IMAGE.source})`;
  return text.replace(new RegExp(`${side("Before")}\\n\\n${side("After")}`, "g"), (whole, ...groups: Array<string | undefined>) => {
    // Each side captures: label, the image, then the image's alt, url, title.
    const before = readImageCell(groups[1] ?? "");
    const after = readImageCell(groups[6] ?? "");
    if (!before || !after) return whole;
    return compareFence({
      sides: [
        { title: "Before", ...before, label: groups[0]?.trim() || before.label },
        { title: "After", ...after, label: groups[5]?.trim() || after.label },
      ],
      caption: null,
    });
  });
}

/** A proof id an image title or a figure carries, or null for anything else. */
export function prProofIdFromTitle(title: string | null | undefined): string | null {
  if (!title?.startsWith(PR_PROOF_TITLE_PREFIX)) return null;
  const id = title.slice(PR_PROOF_TITLE_PREFIX.length);
  return ID_ONLY.test(id) ? id : null;
}

/**
 * Anyone who can comment on a PR can write this fence, so its fields are
 * checked like any other markdown: an https URL, a well-formed proof id.
 */
export function parsePrCompareFence(source: string): PrCompareFigure | null {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return null;
  }
  const sides = value !== null && typeof value === "object" && Array.isArray((value as { sides?: unknown }).sides)
    ? (value as { sides: unknown[] }).sides
    : [];
  if (sides.length < 2 || sides.length > MAX_COMPARE_SIDES) return null;
  const text = (field: unknown): string | null => (typeof field === "string" && field.trim() ? field : null);
  const caption = text((value as { caption?: unknown }).caption);
  return {
    sides: sides.map((raw) => {
      const side = (raw ?? {}) as Record<string, unknown>;
      const url = text(side.url);
      const id = text(side.artifactId);
      return {
        title: text(side.title) ?? "",
        url: url && /^https:\/\//i.test(url) && !url.includes(PR_PROOF_PLACEHOLDER_HOST) ? url : null,
        artifactId: id && ID_ONLY.test(id) ? id : null,
        label: text(side.label),
      };
    }),
    caption,
  };
}

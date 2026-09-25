/**
 * Proof the agent puts inside its own answer.
 *
 * Two forms, both plain markdown so any provider can write them:
 *
 * - A citation: `![caption](ade-proof://<artifactId>)`. The answer shows the
 *   filed artifact at that spot, with the caption under it.
 * - A comparison: a fenced ```proof-compare block that names a before and an
 *   after artifact, shown side by side.
 *
 * The id is the proof record's id, which every `ade … proof` command prints
 * together with a ready citation. A client that does not know these forms
 * shows the alt text or the code fence, so an old client loses the picture
 * and keeps the words.
 */

export const PROOF_CITATION_SCHEME = "ade-proof";
export const PROOF_COMPARE_FENCE_LANGUAGE = "proof-compare";

const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CITATION_URL_PATTERN = /^ade-proof:\/{0,2}([^/?#\s]+)\/?$/i;

/** The artifact id an `ade-proof://<id>` URL names, or null for any other URL. */
export function parseProofCitationUrl(url: string | null | undefined): string | null {
  const match = CITATION_URL_PATTERN.exec((url ?? "").trim());
  if (!match) return null;
  let id = match[1]!;
  try {
    id = decodeURIComponent(id);
  } catch {
    return null;
  }
  return ARTIFACT_ID_PATTERN.test(id) ? id : null;
}

export function proofCitationUrl(artifactId: string): string {
  return `${PROOF_CITATION_SCHEME}://${artifactId}`;
}

/** Brackets and line breaks would end the alt text early, so they are dropped. */
function citationAltText(caption: string | null | undefined): string {
  return (caption ?? "").replace(/[[\]\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

/** The markdown an agent pastes into its answer to show this artifact. */
export function proofCitationMarkdown(artifactId: string, caption?: string | null): string {
  return `![${citationAltText(caption)}](${proofCitationUrl(artifactId)})`;
}

export type ProofCompareSide = {
  artifactId: string;
  /** The words after the id, shown under that side. */
  label: string | null;
};

export type ProofCompareBlock = {
  before: ProofCompareSide;
  after: ProofCompareSide;
  /** One sentence under both pictures. */
  caption: string | null;
};

function parseCompareSide(rest: string): ProofCompareSide | null {
  const [token = "", ...words] = rest.trim().split(/\s+/);
  const artifactId = parseProofCitationUrl(token) ?? (ARTIFACT_ID_PATTERN.test(token) ? token : null);
  if (!artifactId) return null;
  const label = words.join(" ").replace(/^[-–—:|]\s*/, "").trim();
  return { artifactId, label: label || null };
}

/**
 * Reads a ```proof-compare body:
 *
 * ```
 * before: <artifactId> The old sidebar
 * after: <artifactId> The new sidebar
 * caption: The rows now use the lane color.
 * ```
 *
 * Returns null unless both sides name an id, so a half-written block renders
 * as the code it is.
 */
export function parseProofCompareBlock(source: string): ProofCompareBlock | null {
  let before: ProofCompareSide | null = null;
  let after: ProofCompareSide | null = null;
  let caption: string | null = null;
  for (const rawLine of source.split(/\r?\n/)) {
    const match = /^\s*(before|after|caption)\s*:\s*(.*)$/i.exec(rawLine);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const rest = match[2] ?? "";
    if (key === "caption") caption = rest.trim() || null;
    else if (key === "before") before = parseCompareSide(rest) ?? before;
    else after = parseCompareSide(rest) ?? after;
  }
  return before && after ? { before, after, caption } : null;
}

/** Every ```proof-compare block in a markdown text that names a pair. */
export function proofCompareBlocks(markdown: string): ProofCompareBlock[] {
  const fence = new RegExp("```" + PROOF_COMPARE_FENCE_LANGUAGE + "[^\\n]*\\n([\\s\\S]*?)```", "gi");
  const blocks: ProofCompareBlock[] = [];
  for (const match of markdown.matchAll(fence)) {
    const block = parseProofCompareBlock(match[1] ?? "");
    if (block) blocks.push(block);
  }
  return blocks;
}

/**
 * The answer with code removed: fenced blocks other than ```proof-compare and
 * inline code spans. A citation written as an example inside code is shown as
 * code, not as proof, so it must not count as cited.
 */
function withoutCode(markdown: string): string {
  return markdown
    .replace(/(^|\n)(```|~~~)([^\n]*)\n[\s\S]*?(?:\n\2[^\n]*(?=\n|$)|$)/g, (block, lead: string, _fence: string, info: string) =>
      info.trim().toLowerCase().startsWith(PROOF_COMPARE_FENCE_LANGUAGE) ? block : lead)
    // A single-backtick span with content; never the backticks of a fence line.
    .replace(/(?<!`)`[^`\n]+`(?!`)/g, "");
}

/** Every artifact id an answer cites, without repeats: citations first, then compare blocks. */
export function citedProofArtifactIds(answer: string): string[] {
  const markdown = withoutCode(answer);
  const ids: string[] = [];
  const add = (id: string | null) => {
    if (id && !ids.includes(id)) ids.push(id);
  };
  for (const match of markdown.matchAll(/!\[[^\]]*\]\(\s*<?(ade-proof:[^)\s>]+)>?[^)]*\)/gi)) {
    add(parseProofCitationUrl(match[1]));
  }
  for (const block of proofCompareBlocks(markdown)) {
    add(block.before.artifactId);
    add(block.after.artifactId);
  }
  return ids;
}

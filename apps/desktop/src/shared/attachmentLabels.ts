// ---------------------------------------------------------------------------
// Attachment labels — the one grammar that ties prompt text to attachments.
// ---------------------------------------------------------------------------
//
// Attachments used to reach the agent as an unlabelled list after the prompt,
// so nothing in "make it look like this one" said which picture "this one" was.
// Every surface now names attachments the same way:
//
//   - The k-th IMAGE attachment (1-based, counting only images, in attachment
//     list order) is `[Image #k]`. An `image-url` attachment is an image.
//   - The k-th non-image FILE attachment (1-based among files) is
//     `[File #k: <basename>]`.
//
// The composer writes the token where the user pasted the attachment, the
// runtimes put the same label right before each attachment block they send,
// and the transcript turns the token back into a chip. iOS implements the same
// grammar; keep the two in step.
//
// Design invariants:
//   - Numbering is positional. The token never stores a path or an id, so a
//     draft and a sent message stay plain text; the attachment list is the
//     only thing a token resolves against.
//   - A token whose ordinal has no attachment is NOT a chip. It stays text.
//   - The file name in a file token is informational. Resolution is by ordinal.
//   - Pure and synchronous: no I/O, safe in main, renderer, and the CLI.

import { basenameCrossPlatform } from "./pathDisplay";

export type AttachmentLabelKind = "image" | "file";

/** The minimum an attachment needs for labelling. `AgentChatFileRef` fits. */
export type LabelableAttachment = {
  type: string;
  path: string;
  url?: string;
};

export type AttachmentLabel = {
  kind: AttachmentLabelKind;
  /** 1-based position among attachments of the same kind. */
  ordinal: number;
  /** Basename shown in a file token, and in legends. */
  name: string;
  /** `Image #2` / `File #1: notes.txt` — the token without brackets. */
  label: string;
  /** `[Image #2]` / `[File #1: notes.txt]` — what the prompt text carries. */
  token: string;
};

export type AttachmentTokenMatch = {
  kind: AttachmentLabelKind;
  ordinal: number;
  /** Present on file tokens only. */
  name?: string;
  token: string;
  start: number;
  end: number;
};

/** An `image-url` attachment counts as an image. */
export function isImageAttachmentRef(attachment: Pick<LabelableAttachment, "type">): boolean {
  return attachment.type === "image" || attachment.type === "image-url";
}

/**
 * Characters that would end or split a token. Replaced in the name so a file
 * called `a]b.txt` cannot close the token early and leave stray text behind.
 */
const TOKEN_NAME_UNSAFE_RE = /[[\]\r\n]/g;

function sanitizeTokenName(name: string): string {
  const cleaned = name.replace(TOKEN_NAME_UNSAFE_RE, "_").trim();
  return cleaned || "file";
}

/** The display name for an attachment: a file's basename, a URL's last segment. */
export function attachmentLabelName(attachment: LabelableAttachment): string {
  if (attachment.type === "image-url") {
    const raw = attachment.url?.trim() || attachment.path;
    try {
      const parsed = new URL(raw);
      return basenameCrossPlatform(parsed.pathname) || parsed.hostname || raw;
    } catch {
      return basenameCrossPlatform(raw) || raw;
    }
  }
  return basenameCrossPlatform(attachment.path) || attachment.path;
}

export function formatAttachmentLabel(kind: AttachmentLabelKind, ordinal: number, name?: string): string {
  return kind === "image"
    ? `Image #${ordinal}`
    : `File #${ordinal}: ${sanitizeTokenName(name ?? "")}`;
}

export function formatAttachmentToken(kind: AttachmentLabelKind, ordinal: number, name?: string): string {
  return `[${formatAttachmentLabel(kind, ordinal, name)}]`;
}

/**
 * Label every attachment, in order. The result is parallel to the input, so
 * `labels[i]` names `attachments[i]`.
 */
export function labelAttachments(attachments: readonly LabelableAttachment[]): AttachmentLabel[] {
  let images = 0;
  let files = 0;
  return attachments.map((attachment) => {
    const kind: AttachmentLabelKind = isImageAttachmentRef(attachment) ? "image" : "file";
    const ordinal = kind === "image" ? ++images : ++files;
    const name = attachmentLabelName(attachment);
    const label = formatAttachmentLabel(kind, ordinal, name);
    return { kind, ordinal, name, label, token: `[${label}]` };
  });
}

/**
 * Same labels, keyed by the attachment object. For builders that walk a
 * filtered subset of the list but must still number against the whole list.
 */
export function labelAttachmentsByRef<T extends LabelableAttachment>(
  attachments: readonly T[],
): Map<T, AttachmentLabel> {
  const labels = labelAttachments(attachments);
  const out = new Map<T, AttachmentLabel>();
  attachments.forEach((attachment, index) => {
    const label = labels[index];
    if (label) out.set(attachment, label);
  });
  return out;
}

const ATTACHMENT_TOKEN_RE = /\[(?:Image #(\d{1,4})|File #(\d{1,4}): ([^\][\r\n]{1,240}))\]/g;

/** Every `[Image #k]` / `[File #k: name]` token in `text`, in document order. */
export function parseAttachmentTokens(text: string): AttachmentTokenMatch[] {
  if (!text || !text.includes("[")) return [];
  const out: AttachmentTokenMatch[] = [];
  ATTACHMENT_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTACHMENT_TOKEN_RE.exec(text)) !== null) {
    const imageOrdinal = match[1];
    const fileOrdinal = match[2];
    const ordinal = Number(imageOrdinal ?? fileOrdinal);
    if (!Number.isInteger(ordinal) || ordinal < 1) continue;
    const base = { ordinal, token: match[0], start: match.index, end: match.index + match[0].length };
    out.push(imageOrdinal != null
      ? { ...base, kind: "image" }
      : { ...base, kind: "file", name: match[3] });
  }
  return out;
}

/** Index into `attachments` of the k-th attachment of `kind`, or -1. */
export function attachmentIndexForOrdinal(
  attachments: readonly LabelableAttachment[],
  kind: AttachmentLabelKind,
  ordinal: number,
): number {
  let seen = 0;
  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index]!;
    if (isImageAttachmentRef(attachment) !== (kind === "image")) continue;
    seen += 1;
    if (seen === ordinal) return index;
  }
  return -1;
}

/** The attachment a token points at, or null when the ordinal has none. */
export function resolveAttachmentToken<T extends LabelableAttachment>(
  attachments: readonly T[],
  token: Pick<AttachmentTokenMatch, "kind" | "ordinal">,
): T | null {
  const index = attachmentIndexForOrdinal(attachments, token.kind, token.ordinal);
  return index >= 0 ? attachments[index]! : null;
}

/**
 * Rewrite the tokens in `text` after the attachment list changed from
 * `previous` to `next`. Attachments are matched by path, so a token follows
 * its attachment to its new number. A token whose attachment was removed is
 * dropped; a token that resolved to nothing before is left as it was.
 */
export function renumberAttachmentTokens(
  text: string,
  previous: readonly LabelableAttachment[],
  next: readonly LabelableAttachment[],
): string {
  const tokens = parseAttachmentTokens(text);
  if (!tokens.length) return text;
  const nextLabels = labelAttachments(next);
  const nextIndexByPath = new Map(next.map((attachment, index) => [attachment.path, index]));
  let out = "";
  let cursor = 0;
  for (const token of tokens) {
    const previousAttachment = resolveAttachmentToken(previous, token);
    if (!previousAttachment) continue;
    const nextIndex = nextIndexByPath.get(previousAttachment.path);
    out += text.slice(cursor, token.start);
    if (nextIndex != null) out += nextLabels[nextIndex]!.token;
    cursor = token.end;
  }
  return out + text.slice(cursor);
}

/**
 * One line naming images that travel outside the prompt text, for runtimes
 * that cannot interleave a label with each image block:
 * `Attached images, in order: [Image #1] a.png, [Image #2] b.png`.
 */
export function formatAttachedImageLegend(labels: readonly AttachmentLabel[]): string {
  const images = labels.filter((label) => label.kind === "image");
  if (!images.length) return "";
  return `Attached images, in order: ${images.map((label) => `${label.token} ${label.name}`).join(", ")}`;
}

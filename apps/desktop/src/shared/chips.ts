// ---------------------------------------------------------------------------
// Chips — one model for every special token ADE renders as a pill.
// ---------------------------------------------------------------------------
//
// Before this module there were three unrelated grammars, and a chip behaved
// differently depending on which one produced it:
//
//   - `chatMentions.ts` owns `@chat:` / `@lane:` / `@term:` tokens.
//   - `smartLinks.ts` owns URL-shaped links, and collapses EVERY `ade://` URL
//     into one opaque `ade_deeplink` kind labelled "ADE · <path>", even though
//     `deeplinks.ts` right next to it parses those URLs into a precise typed
//     target.
//   - File paths are chips only because their label happens to equal their
//     token, so nothing has to serialize them.
//
// That last accident is why copy and paste loses chips: a native copy reads the
// DOM text, which is the LABEL, and only the file chips survive because label
// and token are the same string. The fix is not a clipboard patch on its own —
// it is this: one `Chip` that always carries its canonical `token` next to its
// display `label`, produced from all three grammars, consumed by the composer,
// the sent-message list, the TUI, and iOS.
//
// Design invariants:
//   - `token` is the canonical plain text. Copy, cut, drafts, and the plain
//     text fallback all write it, so a chip pasted into a terminal or another
//     app is still a meaningful, re-parseable string.
//   - `label` is display only. It may be enriched later (a lane name, a page
//     title); the token never changes underneath it.
//   - A chip is a POINTER. Nothing here reads a file, a transcript, or a URL.
//     Parsing is pure and synchronous so every surface can do it inline.
//   - The same entity gets the same `kind` no matter which grammar produced it.
//     `@lane:<id>` and `ade://lane/<id>` are both a `lane` chip; only the token
//     differs. That is what lets one renderer serve every surface.

import { formatChatMentionToken, parseChatMentions } from "./chatMentions";
import { looksLikeAdeDeeplink, parseDeeplink, type DeeplinkTarget } from "./deeplinks";
import { findSmartLinks, type SmartLinkPreview } from "./smartLinks";
import type { ChatMentionKind } from "./types/chatMentions";

/**
 * Every pill ADE can draw. Flat on purpose: the provider that produced a chip
 * is a property of its source, not of its identity, so a PR is one kind whether
 * it arrived as a github.com URL, an `ade://pr/...` link, or a `#123` trigger.
 */
export type ChipKind =
  | "file"
  | "folder"
  | "chat"
  | "lane"
  | "terminal"
  | "commit"
  | "branch"
  | "artifact"
  | "pr"
  | "issue"
  | "repo"
  | "actions_run"
  | "linear_issue"
  | "web_page"
  /** An `ade://` URL this build cannot parse — a newer ADE minted it. */
  | "ade_link";

/**
 * Where the chip came from, which is what a click needs in order to route.
 * Deeplink chips carry the parsed target so callers reach
 * `deeplinkToNavigationTarget` without re-parsing the URL.
 */
export type ChipSource =
  | { origin: "mention"; mentionKind: ChatMentionKind; id: string }
  | { origin: "path"; path: string }
  | { origin: "deeplink"; url: string; target: DeeplinkTarget }
  | { origin: "url"; url: string };

export type Chip = {
  kind: ChipKind;
  /** Canonical serialized form. The one string that must survive a round trip. */
  token: string;
  /** Compact, deterministic display label. Available with no network access. */
  label: string;
  /** Trailing context: the repo for a PR, the directory for a file. */
  detail?: string | null;
  /** Best-effort enriched title (page title, lane name). Never replaces `token`. */
  title?: string | null;
  /** Sanitized, bounded icon returned by the runtime preview service. */
  iconDataUrl?: string | null;
  source: ChipSource;
};

export type ChipMatch = Chip & {
  start: number;
  end: number;
};

/**
 * One glyph per kind. Short strings rather than icon components so the TUI and
 * any non-React surface render from the same table; the desktop maps these to
 * its icon set.
 */
export const CHIP_GLYPH: Record<ChipKind, string> = {
  file: "📄",
  folder: "📁",
  chat: "💬",
  lane: "◫",
  terminal: "▶",
  commit: "◆",
  branch: "⑂",
  artifact: "◈",
  pr: "⇄",
  issue: "◉",
  repo: "▣",
  actions_run: "⚙",
  linear_issue: "L",
  web_page: "↗",
  ade_link: "A",
};

export function chipGlyph(kind: ChipKind): string {
  return CHIP_GLYPH[kind];
}

/**
 * Terminal-safe glyphs. The table above uses emoji, which render at two cells
 * in some terminals and one in others, so a chip strip drawn with them makes
 * the TUI's column arithmetic wrong. These are all single-cell ASCII.
 */
export const CHIP_GLYPH_ASCII: Record<ChipKind, string> = {
  file: "F",
  folder: "D",
  chat: "C",
  lane: "L",
  terminal: "T",
  commit: "c",
  branch: "b",
  artifact: "a",
  pr: "#",
  issue: "i",
  repo: "R",
  actions_run: "r",
  linear_issue: "N",
  web_page: ">",
  ade_link: "A",
};

export function chipGlyphAscii(kind: ChipKind): string {
  return CHIP_GLYPH_ASCII[kind];
}

/** Display text. An enriched title wins only where the label is the raw URL. */
export function chipDisplayLabel(chip: Chip): string {
  if ((chip.kind === "web_page" || chip.kind === "ade_link") && chip.title?.trim()) {
    return chip.title.trim();
  }
  return chip.label;
}

function shortId(value: string): string {
  return value.length > 8 ? value.slice(0, 8) : value;
}

function splitPath(path: string): { name: string; dir: string | null } {
  const normalized = path.replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  if (index < 0) return { name: normalized, dir: null };
  return { name: normalized.slice(index + 1), dir: normalized.slice(0, index) || null };
}

// ---------------------------------------------------------------------------
// Builders — one per grammar.
// ---------------------------------------------------------------------------

/** A repo path chip. Folders are a distinct kind so the glyph and the click differ. */
export function chipFromPath(path: string, options: { isDirectory?: boolean } = {}): Chip {
  const isDirectory = options.isDirectory === true;
  const { name, dir } = splitPath(path);
  // A folder's token carries the trailing slash: it is what the composer
  // inserts, and the token is the one string that must round-trip.
  const token = isDirectory ? `${path.replace(/\/+$/, "")}/` : path;
  return {
    kind: isDirectory ? "folder" : "file",
    token,
    label: isDirectory ? `${name}/` : name,
    detail: dir,
    source: { origin: "path", path: token },
  };
}

/** A `@chat:` / `@lane:` / `@term:` mention chip. */
export function chipFromMention(mentionKind: ChatMentionKind, id: string, label?: string): Chip {
  const kind: ChipKind = mentionKind === "terminal" ? "terminal" : mentionKind;
  return {
    kind,
    token: formatChatMentionToken(mentionKind, id),
    label: label?.trim() || defaultMentionLabel(mentionKind, id),
    source: { origin: "mention", mentionKind, id },
  };
}

function defaultMentionLabel(mentionKind: ChatMentionKind, id: string): string {
  if (mentionKind === "chat") return `Chat ${shortId(id)}`;
  if (mentionKind === "lane") return `Lane ${shortId(id)}`;
  return `Terminal ${shortId(id)}`;
}

/**
 * A typed chip for a parsed `ade://` (or ade-app.dev) deeplink. This is the
 * difference between "ADE · pr/arul28/ade/1237" and a PR pill that looks and
 * behaves exactly like the one a github.com URL produces.
 */
export function chipFromDeeplinkTarget(url: string, target: DeeplinkTarget): Chip {
  const source: ChipSource = { origin: "deeplink", url, target };
  switch (target.kind) {
    case "lane":
      return { kind: "lane", token: url, label: `Lane ${shortId(target.laneId)}`, source };
    case "session":
      return { kind: "chat", token: url, label: `Chat ${shortId(target.sessionId)}`, source };
    case "file": {
      const { name, dir } = splitPath(target.path);
      return {
        kind: "file",
        token: url,
        label: target.line ? `${name}:${target.line}` : name,
        detail: dir,
        source,
      };
    }
    case "commit":
      return { kind: "commit", token: url, label: target.sha.slice(0, 7), source };
    case "artifact":
      return { kind: "artifact", token: url, label: `Artifact ${shortId(target.artifactId)}`, source };
    case "branch":
      return {
        kind: "branch",
        token: url,
        label: target.branch,
        detail: `${target.repoOwner}/${target.repoName}`,
        source,
      };
    case "pr":
      return {
        kind: "pr",
        token: url,
        label: `#${target.prNumber}`,
        detail: target.repoOwner && target.repoName ? `${target.repoOwner}/${target.repoName}` : null,
        source,
      };
    case "linear-issue":
      // Uppercased to match `parseLinearLink`, which already normalises the
      // identifier for the https form. Without this, ade://linear-issue/ade-431
      // and the linear.app url for the same issue drew different labels.
      return { kind: "linear_issue", token: url, label: target.issueIdentifier.toUpperCase(), source };
  }
}

/** Map one `SmartLinkPreview` onto the shared model, typing ADE links properly. */
export function chipFromSmartLink(preview: SmartLinkPreview): Chip {
  const source: ChipSource = { origin: "url", url: preview.url };
  const base = { token: preview.url, title: preview.title ?? null, iconDataUrl: preview.iconDataUrl ?? null };

  if (preview.kind === "ade_deeplink" || looksLikeAdeDeeplink(preview.url)) {
    const parsed = parseDeeplink(preview.url);
    if (parsed.ok) {
      const chip = chipFromDeeplinkTarget(preview.url, parsed.target);
      return { ...chip, title: base.title, iconDataUrl: base.iconDataUrl };
    }
    // A link this build cannot parse is still a link. Keep it addressable and
    // say what it is, rather than dropping it back to raw text.
    return { ...base, kind: "ade_link", label: preview.label, source };
  }

  const kind = smartLinkKindToChipKind(preview.kind);
  return { ...base, kind, label: preview.label, source };
}

function smartLinkKindToChipKind(kind: SmartLinkPreview["kind"]): ChipKind {
  switch (kind) {
    case "github_pr":
      return "pr";
    case "github_issue":
      return "issue";
    case "github_repo":
      return "repo";
    case "github_commit":
      return "commit";
    case "github_actions_run":
      return "actions_run";
    case "linear_issue":
      return "linear_issue";
    case "ade_deeplink":
      return "ade_link";
    case "web_page":
      return "web_page";
  }
}

// ---------------------------------------------------------------------------
// Parsing — one scan over text, every grammar, no overlaps.
// ---------------------------------------------------------------------------

/**
 * Find every chip in `text`, in document order. Mentions and links cannot
 * overlap in practice, but the scan drops any later match that starts inside an
 * earlier one rather than emitting two pills over the same characters.
 *
 * File-path chips are NOT detected here. A bare path is ambiguous with ordinary
 * prose, so paths become chips only when the composer inserts them from the
 * picker, or when a paste carries the chip payload.
 */
/**
 * `@`-prefixed file and folder paths, the token the composer inserts for a
 * quick-open selection (`@src/shared/chips.ts`, `@src/shared/`).
 *
 * Without this the transcript dropped the most common chip of all back to raw
 * text: the entity grammar only knows `@chat:` / `@lane:` / `@term:`, so a file
 * pill survived the composer and died on send.
 *
 * Two deliberate restrictions:
 *
 *   - **The token needs a `/` or a short file extension.** A root-level pick
 *     inserts `@README.md`, so requiring a slash silently dropped the chip for
 *     every file at the repo root — and `package.json`, `Dockerfile.web` and
 *     `README.md` are among the most-referenced files there are. The extension
 *     arm is capped at 1-8 word characters so prose like `@foo.` or a sentence
 *     fragment cannot qualify.
 *
 *     A slash-less token whose extension is a plainly non-code TLD
 *     (`WEB_ONLY_SUFFIXES`) is refused, so `@example.com` stays prose while
 *     `@README.md` chips. That list is deliberately TINY, because TLDs and
 *     source extensions collide badly: `.md` is Moldova, `.py` Paraguay, `.sh`
 *     St Helena, `.pl` Poland, `.rs` Serbia, `.ai` Anguilla. A "complete" TLD
 *     blocklist would refuse a README, which is the case this arm exists for.
 *     Only suffixes no language uses for source belong here.
 *   - **No `:` anywhere in the token.** That is what keeps `@chat:abc` and
 *     `@bogus:123` out of this matcher and leaves them to the entity grammar.
 *
 * The leading boundary mirrors `parseChatMentions`, so an email or a mid-word
 * `foo@bar/baz` is not a mention here either.
 */
const PATH_MENTION_RE = /(^|[ \t\r\n([{,])@([^\s:]*(?:\/[^\s:]*|\.\w{1,8}))/g;

/**
 * Suffixes that mean "web address", never "source file". Kept minimal on
 * purpose — see the collision list in the doc comment above. A token WITH a
 * `/` is a path regardless, so `@docs/example.com` is unaffected.
 */
const WEB_ONLY_SUFFIXES = new Set([
  "com", "org", "net", "edu", "gov", "info", "xyz", "online", "site",
]);

function parsePathMentions(text: string): ChipMatch[] {
  const out: ChipMatch[] = [];
  PATH_MENTION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PATH_MENTION_RE.exec(text)) !== null) {
    const lead = match[1] ?? "";
    let raw = match[2] ?? "";
    // Trailing sentence punctuation belongs to the prose, not the path. A
    // folder's own trailing slash is kept — it is what marks it as a folder.
    raw = raw.replace(/[.,;!?)\]}]+$/, "");
    // Re-checked AFTER the punctuation strip: `@foo.` would otherwise qualify
    // on an extension that the strip just removed.
    if (!raw.includes("/")) {
      const suffix = /\.(\w{1,8})$/.exec(raw)?.[1]?.toLowerCase();
      if (!suffix || WEB_ONLY_SUFFIXES.has(suffix)) continue;
    }
    const start = match.index + lead.length;
    const isDirectory = raw.endsWith("/");
    const chip = chipFromPath(isDirectory ? raw.slice(0, -1) : raw, { isDirectory });
    out.push({ ...chip, start, end: start + 1 + raw.length });
  }
  return out;
}

export function parseChips(text: string, limit = 24): ChipMatch[] {
  if (!text || limit <= 0) return [];

  const matches: ChipMatch[] = [];

  for (const mention of parseChatMentions(text)) {
    const chip = chipFromMention(mention.kind, mention.id);
    matches.push({ ...chip, start: mention.start, end: mention.end });
  }

  for (const link of findSmartLinks(text, limit)) {
    const chip = chipFromSmartLink(link);
    matches.push({ ...chip, start: link.start, end: link.end });
  }

  matches.push(...parsePathMentions(text));

  matches.sort((a, b) => a.start - b.start);

  const out: ChipMatch[] = [];
  let consumedTo = -1;
  for (const match of matches) {
    if (match.start < consumedTo) continue;
    out.push(match);
    consumedTo = match.end;
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Split text into plain runs and chips, which is what a message renderer wants:
 * it walks the parts in order and never has to compute offsets itself.
 */
export type ChipTextPart =
  | { type: "text"; text: string }
  | { type: "chip"; chip: Chip };

export function splitTextIntoChipParts(text: string, limit = 24): ChipTextPart[] {
  const matches = parseChips(text, limit);
  if (matches.length === 0) return text ? [{ type: "text", text }] : [];

  const parts: ChipTextPart[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) parts.push({ type: "text", text: text.slice(cursor, match.start) });
    const { start: _start, end: _end, ...chip } = match;
    parts.push({ type: "chip", chip });
    cursor = match.end;
  }
  if (cursor < text.length) parts.push({ type: "text", text: text.slice(cursor) });
  return parts;
}

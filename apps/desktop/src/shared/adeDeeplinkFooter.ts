// ---------------------------------------------------------------------------
// "Open in ADE" footer block — appended to GitHub PR descriptions (and used
// as Linear attachment subtitle).
//
// Idempotent: every block is wrapped in HTML comment markers so a second pass
// finds and replaces the block in place rather than appending duplicates.
// ---------------------------------------------------------------------------

import { buildDeeplink } from "./deeplinks";

export const ADE_DEEPLINK_FOOTER_LOGO_URL = "https://ade-app.dev/logo.png";

const MARKER_OPEN_RE = /<!--\s*ade:link\s+v=\d+[^>]*-->/i;
const MARKER_CLOSE = "<!-- /ade:link -->";
const MARKER_CLOSE_RE = /<!--\s*\/ade:link\s*-->/i;

export type AdeDeeplinkFooterOptions = {
  repoOwner: string;
  repoName: string;
  branch: string;
  prNumber?: number | null;
};

/**
 * Render the branded "Open in ADE" footer block as the markdown/HTML that
 * lives at the bottom of a PR description.
 *
 * The PR body's renderer is GitHub-flavored markdown which supports a useful
 * but small subset of HTML; <p>, <img>, and <a> all render. Linear's renderer
 * accepts the same subset.
 */
export function renderAdeDeeplinkFooter(opts: AdeDeeplinkFooterOptions): string {
  const branchUrl = buildDeeplink({
    kind: "branch",
    repoOwner: opts.repoOwner,
    repoName: opts.repoName,
    branch: opts.branch,
    ...(opts.prNumber ? { prNumber: opts.prNumber } : {}),
  });
  const prUrl = opts.prNumber
    ? buildDeeplink({
        kind: "pr",
        repoOwner: opts.repoOwner,
        repoName: opts.repoName,
        prNumber: opts.prNumber,
      })
    : null;
  const meta = formatMarker(opts);
  const lines = [
    meta,
    "<p>",
    `  <img src="${ADE_DEEPLINK_FOOTER_LOGO_URL}" height="18" align="left" alt="ADE">`,
    "  &nbsp;&nbsp;<strong>Open in ADE</strong>",
    `  &nbsp;·&nbsp; <a href="${escapeHtml(branchUrl)}">${escapeHtml(opts.branch)} branch</a>`,
    prUrl
      ? `  &nbsp;·&nbsp; <a href="${escapeHtml(prUrl)}">PR #${opts.prNumber}</a>`
      : null,
    "</p>",
    MARKER_CLOSE,
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
}

/**
 * Ensure `body` contains the "Open in ADE" footer block.
 * - If a marker block already exists, replace it in place (idempotent).
 * - Otherwise, append it after a blank line.
 */
export function ensureAdeDeeplinkFooter(
  body: string,
  opts: AdeDeeplinkFooterOptions,
): string {
  const block = renderAdeDeeplinkFooter(opts);
  const safeBody = typeof body === "string" ? body : "";
  const openIdx = safeBody.search(MARKER_OPEN_RE);
  if (openIdx >= 0) {
    const closeMatch = MARKER_CLOSE_RE.exec(safeBody.slice(openIdx));
    if (closeMatch) {
      const before = safeBody.slice(0, openIdx).trimEnd();
      const after = safeBody.slice(openIdx + closeMatch.index + closeMatch[0].length);
      let tail: string;
      if (!after) tail = "";
      else if (after.startsWith("\n")) tail = after;
      else tail = `\n${after}`;
      return `${before}\n\n${block}${tail}`.trimEnd() + "\n";
    }
  }
  const trimmed = safeBody.trimEnd();
  if (!trimmed) return `${block}\n`;
  return `${trimmed}\n\n${block}\n`;
}

/**
 * Detect whether `body` already carries an ADE deeplink footer block. Used by
 * callers that want to know whether to PATCH on update.
 */
export function hasAdeDeeplinkFooter(body: string | null | undefined): boolean {
  if (!body) return false;
  return MARKER_OPEN_RE.test(body);
}

function formatMarker(opts: AdeDeeplinkFooterOptions): string {
  const enc = (value: string) => encodeURIComponent(value);
  const parts = [
    "v=1",
    `type=${opts.prNumber ? "pr" : "branch"}`,
    `repo=${enc(opts.repoOwner)}/${enc(opts.repoName)}`,
    `branch=${enc(opts.branch)}`,
  ];
  if (opts.prNumber) parts.push(`num=${opts.prNumber}`);
  return `<!-- ade:link ${parts.join(" ")} -->`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

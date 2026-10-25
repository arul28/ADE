/**
 * Pictures and videos attached to a pull request in a private repository.
 *
 * GitHub serves an attachment at `github.com/user-attachments/assets/<uuid>`
 * (or the older `github.com/<owner>/<repo>/assets/<n>/<uuid>`). For a private
 * repository that URL answers 404 without a GitHub credential, so the renderer
 * cannot load it. The machine that owns the project asks GitHub with its own
 * token and hands back a short-lived signed URL (`prs.resolveMedia`), which
 * the renderer can load directly from anywhere. The token never leaves that
 * machine and no media bytes cross IPC.
 *
 * Everything here is pure: the URL shapes the resolver accepts, so the token
 * is only ever sent to github.com / api.github.com, and the signed sources it
 * may hand back.
 */

export type ResolvePrMediaArgs = {
  /** The attachment URL exactly as it appears in the PR's markdown. */
  url: string;
  /** The PR's own repository, the `context` GitHub renders the attachment in. */
  repoOwner: string;
  repoName: string;
};

export type PrMediaUnavailableReason =
  /** The URL is not a GitHub attachment, or the repository is malformed. */
  | "not_eligible"
  /** This machine has no GitHub credential. */
  | "no_credential"
  /** GitHub would not hand out a signed copy (no access, deleted, SSO). */
  | "not_found"
  /** The file is not a picture or a video ADE will show (HTML, SVG, …). */
  | "unsupported_type"
  | "rate_limited"
  /** GitHub errored, timed out, or answered in a shape ADE does not know. */
  | "github_error";

export type ResolvePrMediaResult =
  | {
      status: "resolved";
      /** A signed, tokenless URL; see {@link githubSignedMediaUrl}. */
      src: string;
      /** `image/*` or `video/*`. */
      contentType: string;
      /** When the signed URL stops working (ISO). */
      expiresAt: string;
    }
  | { status: "unavailable"; reason: PrMediaUnavailableReason };

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const USER_ATTACHMENT_PATH = new RegExp(`^/user-attachments/assets/${UUID}$`, "i");
const REPO_ATTACHMENT_PATH = new RegExp(
  `^/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}/assets/\\d{1,20}/${UUID}$`,
  "i",
);
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

function parseHttps(raw: string): URL | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * The attachment URL the resolver may send a token to, rebuilt from its parts,
 * or null. Only `https://github.com` with one of the two attachment paths and
 * no query passes; everything else (another host, `github.com/login`, an
 * internal address, a signed `private-user-images` copy) is rejected before
 * any credential is read.
 */
export function githubAttachmentCanonicalUrl(raw: string): string | null {
  const url = parseHttps(raw);
  if (!url || url.hostname !== "github.com" || url.search) return null;
  const path = url.pathname;
  if (!USER_ATTACHMENT_PATH.test(path)) {
    if (!REPO_ATTACHMENT_PATH.test(path)) return null;
    const repo = path.split("/")[2] ?? "";
    if (repo === "." || repo === "..") return null;
  }
  return `https://github.com${path}`;
}

/** A well-formed `owner/name`, or null. Used only as GitHub's render context. */
export function githubRepoContext(owner: unknown, name: unknown): string | null {
  if (typeof owner !== "string" || typeof name !== "string") return null;
  const o = owner.trim();
  const n = name.trim();
  if (!OWNER.test(o) || !REPO.test(n) || n === "." || n === "..") return null;
  return `${o}/${n}`;
}

/**
 * A signed copy the renderer may load, or null: https, no credentials or port,
 * one of GitHub's two attachment hosts, and that host's signature present
 * (`jwt` on private-user-images, `X-Amz-Signature` on the asset bucket). An
 * unsigned render means GitHub withheld access. These are the same hosts the
 * renderer's `media-src` names (rendererCsp.ts, `GITHUB_ATTACHMENT_MEDIA_SOURCES`);
 * a host missing there could not be shown even if it were handed back.
 */
export function githubSignedMediaUrl(raw: string): URL | null {
  const url = parseHttps(raw);
  if (!url) return null;
  if (url.hostname === "private-user-images.githubusercontent.com") {
    return url.searchParams.get("jwt") ? url : null;
  }
  if (url.hostname === "github-production-user-asset-6210df.s3.amazonaws.com") {
    return url.searchParams.get("X-Amz-Signature") ? url : null;
  }
  return null;
}

/**
 * Only pictures and videos. SVG is refused: it is a document that can carry
 * script, and GitHub does not accept SVG uploads as attachments anyway.
 */
export function isShowableGithubMediaType(contentType: string | null | undefined): boolean {
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (!/^(image|video)\/[a-z0-9.+-]+$/.test(type)) return false;
  return type !== "image/svg+xml";
}

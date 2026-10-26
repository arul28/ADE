import {
  githubAttachmentCanonicalUrl,
  githubRepoContext,
  githubSignedMediaUrl,
  isShowableGithubMediaType,
  type PrMediaUnavailableReason,
  type ResolvePrMediaArgs,
  type ResolvePrMediaResult,
} from "../../../shared/githubMedia";
import { setBounded } from "../../../shared/boundedMap";

/**
 * Turns a private repository's PR attachment URL into a short-lived signed URL
 * the renderer can load without a credential.
 *
 * Runs on the machine that owns the project (the brain, or the desktop's own
 * main process), so the GitHub token never leaves it and no media bytes cross
 * IPC or the remote-runtime socket. Video range requests then work natively.
 *
 * 1. `GET https://github.com/<attachment>` with the read token and manual
 *    redirects. GitHub answers 302 to a signed copy; its `Location` is checked
 *    against the signed-host allowlist and never fetched with the token.
 * 2. HTML (an SSO / EMU sign-in page), 401, 403 or 404: render `![](url)` with
 *    `POST /markdown` in the PR's own repository and take the signed `src`
 *    GitHub writes into the HTML. A render without a signature is "not found".
 *
 * The content type comes from the bucket's `response-content-type` parameter
 * or a tokenless one-byte ranged GET, and must be an image or a video.
 */

type ApiRequest = <T>(args: {
  method: "POST";
  path: string;
  body: unknown;
  capability: "read";
  accept?: string;
}) => Promise<{ data: T }>;

export type GithubMediaResolverDeps = {
  /** The read credential from the GitHub credential chain; throws when none. */
  getReadToken: () => Promise<string>;
  /** The credential-chain API request (rate limits, cooldowns, fallback). */
  apiRequest: ApiRequest;
  /**
   * Changes whenever the GitHub credential set does. A signed URL belongs to
   * the account that asked for it, so a cache entry from before a sign-out or
   * account switch must never be served afterwards.
   */
  credentialRevision?: () => number;
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  logger?: { info: (event: string, data?: Record<string, unknown>) => void };
};

const TOKEN_REQUEST_TIMEOUT_MS = 10_000;
const MARKDOWN_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 8_000;
const MAX_MARKDOWN_HTML_CHARS = 64 * 1024;
/** GitHub signs for five minutes; a copy older than this is asked again. */
const DEFAULT_SIGNED_LIFETIME_MS = 5 * 60_000;
/** Stop handing out a signed copy this long before it expires. */
const EXPIRY_MARGIN_MS = 60_000;
const UNAVAILABLE_TTL_MS = 2 * 60_000;
const MAX_CACHE_ENTRIES = 500;

type CacheEntry = { result: ResolvePrMediaResult; until: number };

class ResolveFailure extends Error {
  constructor(readonly reason: PrMediaUnavailableReason) {
    super(reason);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ResolveFailure("github_error")), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function reasonForError(error: unknown): PrMediaUnavailableReason {
  if (error instanceof ResolveFailure) return error.reason;
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "GitHubRateLimitError" || /rate limit/i.test(message)) return "rate_limited";
  if (/auth missing|credential is available|access is unavailable/i.test(message)) return "no_credential";
  return "github_error";
}

/** Drop a body without reading it; media is never buffered here. */
function release(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (entity, name: string) => {
    if (!name.startsWith("#")) return named[name.toLowerCase()] ?? entity;
    const code = name[1]?.toLowerCase() === "x" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

/** The first `<img src>` GitHub rendered, if it is a signed attachment copy. */
export function signedSourceFromRenderedMarkdown(html: string): URL | null {
  const tag = /<img\b[^>]*>/i.exec(html.slice(0, MAX_MARKDOWN_HTML_CHARS))?.[0];
  const match = tag ? /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag) : null;
  const src = match?.[1] ?? match?.[2];
  return src ? githubSignedMediaUrl(decodeEntities(src)) : null;
}

/** When a signed copy stops working: the bucket's own expiry, the jwt's `exp`, else five minutes. */
function signedExpiryMs(url: URL, now: number): number {
  const fallback = now + DEFAULT_SIGNED_LIFETIME_MS;
  const amzDate = url.searchParams.get("X-Amz-Date");
  const amzExpires = Number(url.searchParams.get("X-Amz-Expires"));
  if (amzDate && Number.isFinite(amzExpires) && amzExpires > 0) {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate);
    if (m) {
      const start = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
      return Math.min(start + amzExpires * 1000, now + 60 * 60_000);
    }
  }
  const jwt = url.searchParams.get("jwt");
  const payload = jwt?.split(".")[1];
  if (payload) {
    try {
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
      if (typeof claims.exp === "number" && claims.exp > 0) return Math.min(claims.exp * 1000, now + 60 * 60_000);
    } catch {
      // Unreadable claims: fall back to GitHub's usual five minutes.
    }
  }
  return fallback;
}

export function createGithubMediaResolver(deps: GithubMediaResolverDeps) {
  const fetchImpl = deps.fetchImpl ?? ((input: string, init: RequestInit) => fetch(input, init));
  const now = deps.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<ResolvePrMediaResult>>();

  const remember = (key: string, result: ResolvePrMediaResult): void => {
    const until = result.status === "resolved"
      ? Date.parse(result.expiresAt) - EXPIRY_MARGIN_MS
      : now() + UNAVAILABLE_TTL_MS;
    if (until <= now()) return;
    setBounded(cache, key, { result, until }, MAX_CACHE_ENTRIES);
  };

  /** A showable content type for a signed copy, or null. Tokenless. */
  const contentTypeFor = async (signed: URL): Promise<string | null> => {
    const declared = signed.searchParams.get("response-content-type");
    if (declared) return isShowableGithubMediaType(declared) ? declared : null;
    const response = await fetchImpl(signed.href, {
      method: "GET",
      headers: { range: "bytes=0-0" },
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    release(response);
    if (response.status !== 200 && response.status !== 206) return null;
    const type = response.headers.get("content-type");
    return isShowableGithubMediaType(type) ? type!.split(";")[0]!.trim() : null;
  };

  const finish = async (signed: URL): Promise<ResolvePrMediaResult> => {
    const contentType = await contentTypeFor(signed);
    if (!contentType) return { status: "unavailable", reason: "unsupported_type" };
    return {
      status: "resolved",
      src: signed.href,
      contentType,
      expiresAt: new Date(signedExpiryMs(signed, now())).toISOString(),
    };
  };

  /** Step 1. Null means "ask the markdown renderer instead". */
  const viaRedirect = async (canonical: string): Promise<URL | null> => {
    let token: string;
    try {
      token = await deps.getReadToken();
    } catch {
      return null;
    }
    const response = await fetchImpl(canonical, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, "user-agent": "ade-desktop" },
      redirect: "manual",
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
    release(response);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      const signed = location ? githubSignedMediaUrl(location) : null;
      // A redirect anywhere else (a sign-in page, a host ADE does not know) is
      // never followed; the markdown render is the second way in.
      return signed;
    }
    if (response.status === 429 || response.status >= 500) throw new ResolveFailure(response.status === 429 ? "rate_limited" : "github_error");
    return null;
  };

  /** Step 2: GitHub's own render of the attachment, in the PR's repository. */
  const viaMarkdown = async (canonical: string, context: string): Promise<URL | null> => {
    const { data } = await withTimeout(
      deps.apiRequest<unknown>({
        method: "POST",
        path: "/markdown",
        body: { text: `![](${canonical})`, mode: "gfm", context },
        capability: "read",
        accept: "text/html",
      }),
      MARKDOWN_TIMEOUT_MS,
    );
    return typeof data === "string" ? signedSourceFromRenderedMarkdown(data) : null;
  };

  const resolveFresh = async (canonical: string, context: string): Promise<ResolvePrMediaResult> => {
    try {
      const redirected = await viaRedirect(canonical).catch((error: unknown) => {
        if (error instanceof ResolveFailure && error.reason === "rate_limited") throw error;
        return null;
      });
      const signed = redirected ?? await viaMarkdown(canonical, context);
      if (!signed) return { status: "unavailable", reason: "not_found" };
      return await finish(signed);
    } catch (error) {
      const reason = reasonForError(error);
      // Never the URL's query or the token: just what kind of failure it was.
      deps.logger?.info("github.media_resolve_failed", { reason });
      return { status: "unavailable", reason };
    }
  };

  return {
    async resolve(args: ResolvePrMediaArgs): Promise<ResolvePrMediaResult> {
      const canonical = githubAttachmentCanonicalUrl(args?.url);
      const context = githubRepoContext(args?.repoOwner, args?.repoName);
      if (!canonical || !context) return { status: "unavailable", reason: "not_eligible" };
      // The revision is part of the key, so a credential change makes every
      // earlier entry and in-flight read unreachable instead of clearing maps.
      const revision = deps.credentialRevision?.() ?? 0;
      const key = `${canonical.toLowerCase()}|${context.toLowerCase()}|${revision}`;
      const cached = cache.get(key);
      if (cached) {
        if (cached.until > now()) {
          cache.delete(key);
          cache.set(key, cached);
          return cached.result;
        }
        cache.delete(key);
      }
      const pending = inFlight.get(key);
      if (pending) return await pending;
      const work = resolveFresh(canonical, context).then((result) => {
        remember(key, result);
        return result;
      });
      inFlight.set(key, work);
      try {
        return await work;
      } finally {
        if (inFlight.get(key) === work) inFlight.delete(key);
      }
    },
  };
}

export type GithubMediaResolver = ReturnType<typeof createGithubMediaResolver>;

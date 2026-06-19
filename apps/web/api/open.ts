/**
 * Vercel serverless function for the /open route. Serves the SPA shell with
 * OpenGraph + Twitter tags rewritten from query params so chat-app unfurlers
 * (Slack, Discord, iMessage, Gmail, Linear) show a rich card without needing
 * to execute JavaScript.
 *
 * The SPA still hydrates and refines tags client-side via OpenPage's
 * useEffect; this function just bakes the initial HTML so unfurlers see
 * useful content on first byte.
 *
 * The function self-fetches `/index.html` rather than reading from
 * `process.cwd()` because Vercel does not bundle the static-asset build
 * output (`dist/`) into serverless-function code. The catch-all SPA rewrite
 * in vercel.json explicitly excludes paths containing a dot, so `/index.html`
 * is served as a flat static asset and won't loop back into this function.
 */

type VercelQuery = Record<string, string | string[] | undefined>;

type VercelReq = {
  query: VercelQuery;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
};

type VercelRes = {
  status: (code: number) => VercelRes;
  setHeader: (name: string, value: string) => void;
  send: (body: string) => void;
  end: () => void;
};

type OpenTarget =
  | { kind: "lane"; laneId: string }
  | { kind: "session"; sessionId: string; laneId?: string }
  | { kind: "branch"; repo: string; branch: string; pr?: number }
  | { kind: "pr"; repo: string; number: number }
  | { kind: "linear-issue"; issue: string; branch?: string }
  | { kind: "unknown" };

const CANONICAL_OPEN_ORIGIN = "https://ade-app.dev";

// Fallback HTML used when the self-fetch of /index.html fails for any
// reason (network error, hostname missing). It's a complete page with the
// right OG meta tags + a small script that triggers a soft redirect to "/"
// so a real browser still lands on the SPA root.
function fallbackShell(title: string, description: string, canonical: string): string {
  const esc = (v: string) => escapeHtmlAttr(v);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:type" content="website" />
<meta property="og:url" content="${esc(canonical)}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(title)}" />
<meta name="twitter:description" content="${esc(description)}" />
</head>
<body>
<noscript>You need JavaScript enabled to view this page.</noscript>
<script>window.location.replace("/" + (window.location.search || ""));</script>
</body>
</html>`;
}

function pickQuery(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function parseTarget(query: VercelQuery): OpenTarget {
  const type = pickQuery(query.type).toLowerCase();
  if (type === "lane") {
    const laneId = pickQuery(query.id);
    if (laneId) return { kind: "lane", laneId };
  }
  if (type === "session") {
    const sessionId = pickQuery(query.id);
    if (sessionId) {
      const laneId = pickQuery(query.lane);
      return laneId ? { kind: "session", sessionId, laneId } : { kind: "session", sessionId };
    }
  }
  if (type === "branch") {
    const repo = pickQuery(query.repo);
    const branch = pickQuery(query.branch);
    if (repo && branch) {
      const pr = Number(pickQuery(query.pr));
      return Number.isInteger(pr) && pr > 0
        ? { kind: "branch", repo, branch, pr }
        : { kind: "branch", repo, branch };
    }
  }
  if (type === "pr") {
    const repo = pickQuery(query.repo);
    const numberRaw = pickQuery(query.number);
    const num = Number(numberRaw);
    if (repo && Number.isInteger(num) && num > 0) {
      return { kind: "pr", repo, number: num };
    }
  }
  if (type === "linear-issue") {
    const issue = pickQuery(query.issue);
    if (issue) {
      const branch = pickQuery(query.branch);
      return branch ? { kind: "linear-issue", issue, branch } : { kind: "linear-issue", issue };
    }
  }
  return { kind: "unknown" };
}

function describe(target: OpenTarget): { title: string; description: string } {
  switch (target.kind) {
    case "lane":
      return {
        title: "Open worktree in ADE",
        description: `Open this ADE worktree (${target.laneId.slice(0, 8)}…) on your desktop.`,
      };
    case "session":
      return {
        title: "Open work session in ADE",
        description: target.laneId
          ? `Open this ADE work session in worktree ${target.laneId.slice(0, 8)}…`
          : "Open this ADE work session on your desktop.",
      };
    case "branch":
      return {
        title: `${target.repo} · ${target.branch} — Open in ADE`,
        description: target.pr
          ? `Branch ${target.branch} (PR #${target.pr}) shared via ADE. One click to open its worktree.`
          : `Branch ${target.branch} shared via ADE. One click to open its worktree.`,
      };
    case "pr":
      return {
        title: `${target.repo} #${target.number} — Open in ADE`,
        description: `Pull request #${target.number} in ${target.repo}. Open it in your ADE desktop app.`,
      };
    case "linear-issue":
      return {
        title: `${target.issue} — Open in ADE`,
        description: target.branch
          ? `Linear issue ${target.issue} on branch ${target.branch}. Click to open in ADE.`
          : `Open Linear issue ${target.issue} in ADE.`,
      };
    case "unknown":
      return {
        title: "Open in ADE",
        description: "ADE is a local-first desktop app for orchestrating parallel AI coding agents.",
      };
  }
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function rewriteOg(template: string, target: OpenTarget, url: string): string {
  const { title, description } = describe(target);
  const escTitle = escapeHtmlAttr(title);
  const escDesc = escapeHtmlAttr(description);
  const escUrl = escapeHtmlAttr(url);

  return template
    // <title> element — match any whitespace/text inside, single-line only.
    .replace(/<title>[^<]*<\/title>/i, `<title>${escTitle}</title>`)
    // <meta name="description"> — attribute order may vary; tolerate single
    // OR double quotes, and self-closing OR open-ended form.
    .replace(
      /<meta\s+name=["']description["']\s+content=["'][^"']*["']\s*\/?>/i,
      `<meta name="description" content="${escDesc}" />`,
    )
    .replace(
      /<meta\s+property=["']og:title["']\s+content=["'][^"']*["']\s*\/?>/i,
      `<meta property="og:title" content="${escTitle}" />`,
    )
    .replace(
      /<meta\s+property=["']og:description["']\s+content=["'][^"']*["']\s*\/?>/i,
      `<meta property="og:description" content="${escDesc}" />`,
    )
    .replace(
      /<meta\s+property=["']og:url["']\s+content=["'][^"']*["']\s*\/?>/i,
      `<meta property="og:url" content="${escUrl}" />`,
    )
    .replace(
      /<meta\s+name=["']twitter:title["']\s+content=["'][^"']*["']\s*\/?>/i,
      `<meta name="twitter:title" content="${escTitle}" />`,
    )
    .replace(
      /<meta\s+name=["']twitter:description["']\s+content=["'][^"']*["']\s*\/?>/i,
      `<meta name="twitter:description" content="${escDesc}" />`,
    );
}

// Maximum time to wait for the self-fetch of /index.html before aborting and
// degrading to the inline fallback shell. Prevents a hung upstream from
// stalling the function (denial-of-wallet).
const SELF_FETCH_TIMEOUT_MS = 2000;

async function loadShellFromSelf(): Promise<string | null> {
  // Pin the self-fetch origin to the trusted canonical origin. Deriving it
  // from attacker-controllable x-forwarded-host/host headers would let a
  // spoofed host make this function fetch arbitrary HTML/JS and serve it from
  // the trusted origin (SSRF + reflected content).
  const origin = CANONICAL_OPEN_ORIGIN;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SELF_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${origin}/index.html`, {
      // Cache the SPA shell for 60s edge-to-edge — index.html changes only
      // on deploy.
      headers: { "cache-control": "max-age=60" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export default async function handler(req: VercelReq, res: VercelRes): Promise<void> {
  const target = parseTarget(req.query);
  const queryIdx = (req.url ?? "").indexOf("?");
  const search = queryIdx >= 0 ? (req.url ?? "").slice(queryIdx) : "";
  const canonical = `${CANONICAL_OPEN_ORIGIN}/open${search}`;
  const { title, description } = describe(target);

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // Allow CDN caching for 10 minutes; OG params are deterministic so identical
  // URLs are cheap. Serve a stale response while revalidating for a day.
  res.setHeader("Cache-Control", "public, max-age=600, stale-while-revalidate=86400");

  const shell = await loadShellFromSelf();
  if (shell) {
    res.status(200).send(rewriteOg(shell, target, canonical));
    return;
  }
  // Degraded mode: inline shell with OG + a soft redirect so the user still
  // lands on the SPA root. Unfurlers see the OG card; humans hit "/".
  res.status(200).send(fallbackShell(title, description, canonical));
}

// Exported for unit testing.
export {
  CANONICAL_OPEN_ORIGIN,
  describe as describeOpenTarget,
  fallbackShell,
  loadShellFromSelf,
  parseTarget as parseOpenTarget,
  rewriteOg,
};

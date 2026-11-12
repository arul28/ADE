/**
 * The pages a person sees in the browser during the GitHub App sign-in and
 * after an install. Plain short copy, light and dark, phone width. The
 * palette follows the website (paper and ink in light, the near-black
 * surface in dark, ADE violet for the one accent).
 *
 * The callback URL carries GitHub's `code` and `state`. The page loads
 * nothing (`default-src 'none'`) and sends no referrer, so neither leaves
 * the page through a link or a subresource.
 */

export type PageIdentity = {
  githubLogin: string;
  /** A masked address of the ADE account (`a…@example.com`), or null when Clerk could not be asked. */
  adeAccount: string | null;
};

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #f1ebd6;
  --panel: #f8f4e6;
  --ink: #18150f;
  --ink-soft: #5b5646;
  --line: rgba(24, 21, 15, 0.16);
  --accent: #6d28d9;
  --accent-ink: #ffffff;
  --broken: #a8a08a;
  --serif: "Instrument Serif", "Iowan Old Style", Georgia, "Times New Roman", serif;
  --sans: "Inter Tight", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0a0a0f;
    --panel: #121218;
    --ink: #f5f5f7;
    --ink-soft: #a1a1aa;
    --line: #27273a;
    --accent: #a78bfa;
    --accent-ink: #0a0a0f;
    --broken: #4a4a5c;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  min-height: 100vh;
  min-height: 100dvh;
  background: var(--bg);
  color: var(--ink);
  font: 16px/1.55 var(--sans);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 16px;
}
main { width: 100%; max-width: 30rem; }
.mark { display: block; width: 28px; height: 28px; margin-bottom: 28px; color: var(--ink); }
h1 {
  font-family: var(--serif);
  font-weight: 400;
  font-size: clamp(2rem, 7vw, 2.6rem);
  line-height: 1.08;
  letter-spacing: -0.01em;
  margin: 0 0 16px;
}
p { margin: 0 0 12px; color: var(--ink-soft); max-width: 34em; }
p.lead { color: var(--ink); }
.pair {
  margin: 28px 0 24px;
  padding: 18px 20px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  display: grid;
  gap: 14px;
  position: relative;
}
.pair::before {
  content: "";
  position: absolute;
  left: 25px;
  top: 32px;
  bottom: 32px;
  border-left: 2px solid var(--accent);
}
.pair.broken::before { border-left: 2px dashed var(--broken); }
.row { display: grid; grid-template-columns: 12px 1fr; gap: 14px; align-items: baseline; position: relative; }
.dot { width: 12px; height: 12px; border-radius: 50%; background: var(--accent); align-self: center; position: relative; z-index: 1; box-shadow: 0 0 0 4px var(--panel); }
.broken .dot { background: var(--broken); }
.label { display: block; font-size: 0.8125rem; color: var(--ink-soft); }
.value { display: block; font-size: 1.0625rem; font-weight: 600; overflow-wrap: anywhere; color: var(--ink); }
.note { font-size: 0.9375rem; }
.action {
  display: inline-block;
  margin-top: 8px;
  padding: 12px 20px;
  border-radius: 10px;
  background: var(--accent);
  color: var(--accent-ink);
  font-weight: 600;
  text-decoration: none;
}
.action:focus-visible { outline: 3px solid var(--ink); outline-offset: 3px; }
button.action { border: 0; font: inherit; font-weight: 600; cursor: pointer; }
button.action.quiet { background: transparent; color: var(--ink); box-shadow: inset 0 0 0 1px var(--line); }
.choices { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 8px; }
.choices .action { margin-top: 0; }
.done { margin-top: 28px; padding-top: 16px; border-top: 1px solid var(--line); font-size: 0.9375rem; }
`;

/** The ADE mark: two linked nodes, drawn in currentColor. */
const MARK = `<svg class="mark" viewBox="0 0 28 28" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="8" r="4.5"/><circle cx="20" cy="20" r="4.5"/><path d="M11.5 11.5l5 5"/></svg>`;

/** No form, no subresource, no frame. */
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function page(title: string, body: string, status: number, csp: string = PAGE_CSP): Response {
  const document = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>${MARK}${body}</main></body>
</html>`;
  return new Response(document, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": csp,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

function pair(rows: Array<{ label: string; value: string }>, broken = false): string {
  const items = rows.map((row) => `<div class="row"><span class="dot"></span><span><span class="label">${escapeHtml(row.label)}</span><span class="value">${escapeHtml(row.value)}</span></span></div>`).join("");
  return `<div class="pair${broken ? " broken" : ""}">${items}</div>`;
}

/**
 * The question before the grant is saved: connect this GitHub login to this
 * ADE account? It names both identities, so a person who opened someone
 * else's link sees an ADE account that is not theirs and cancels.
 *
 * The form posts to this Worker's callback. Browsers apply `form-action` to
 * the redirect that answers the post, so it also lists the one place that
 * redirect can go (`returnTarget`: `ade:` for the phone, the web client's
 * origin for the web), and nothing else.
 */
export function confirmPage(input: {
  identity: PageIdentity;
  replacedLogin: string | null;
  action: string;
  signInId: string;
  confirm: string;
  returnTarget: string | null;
}): Response {
  const { identity, replacedLogin } = input;
  const replaced = replacedLogin && replacedLogin.toLowerCase() !== identity.githubLogin.toLowerCase()
    ? `<p class="note">This replaces GitHub @${escapeHtml(replacedLogin)}, which is connected now.</p>`
    : "";
  const formAction = ["'self'", input.returnTarget].filter(Boolean).join(" ");
  return page("Connect GitHub to ADE?", `<h1>Connect GitHub to ADE?</h1>
<p class="lead">Connect only if you started this from ADE and the ADE account below is yours.</p>
${pair([
    { label: "GitHub", value: `@${identity.githubLogin}` },
    { label: "ADE account", value: identity.adeAccount ?? "The ADE account that started this sign-in" },
  ])}
${replaced}
<form method="post" action="${escapeHtml(input.action)}">
<input type="hidden" name="signIn" value="${escapeHtml(input.signInId)}">
<input type="hidden" name="confirm" value="${escapeHtml(input.confirm)}">
<div class="choices">
<button class="action" type="submit" name="choice" value="connect">Connect GitHub</button>
<button class="action quiet" type="submit" name="choice" value="cancel">Cancel</button>
</div>
</form>
<p class="done">The link works for ten minutes.</p>`, 200,
  `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action ${formAction}; frame-ancestors 'none'`);
}

/** Desktop and CLI: the grant is saved. `replacedLogin`: the account was connected to another GitHub user before. */
export function connectedPage(identity: PageIdentity, replacedLogin: string | null): Response {
  const replaced = replacedLogin && replacedLogin.toLowerCase() !== identity.githubLogin.toLowerCase()
    ? `<p class="note">This replaced GitHub @${escapeHtml(replacedLogin)}, which was connected before. If that is not what you wanted, disconnect GitHub in ADE Settings and connect again.</p>`
    : "";
  return page("GitHub is connected", `<h1>GitHub is connected</h1>
<p class="lead">ADE can now work with GitHub for you on every device where you sign in to this ADE account.</p>
${pair([
    { label: "GitHub", value: `@${identity.githubLogin}` },
    { label: "ADE account", value: identity.adeAccount ?? "Your ADE account" },
  ])}
${replaced || `<p class="note">Not you, or not the right account? Disconnect GitHub in ADE Settings.</p>`}
<p class="done">You can close this tab and go back to ADE.</p>`, 200);
}

export type FailureKind = "denied" | "error" | "expired" | "used" | "unknown" | "not_configured";

const FAILURES: Record<FailureKind, { title: string; lead: string; next: string; status: number }> = {
  denied: {
    title: "GitHub was not connected",
    lead: "You cancelled on GitHub, so nothing changed.",
    next: "To connect GitHub, start again from ADE.",
    status: 200,
  },
  error: {
    title: "GitHub was not connected",
    lead: "GitHub did not accept this sign-in.",
    next: "Start again from ADE. If it keeps happening, try again in a few minutes.",
    status: 502,
  },
  expired: {
    title: "This link has expired",
    lead: "A GitHub sign-in link works for ten minutes.",
    next: "Start again from ADE to get a new link.",
    status: 410,
  },
  used: {
    title: "This link was already used",
    lead: "A GitHub sign-in link works only once.",
    next: "If GitHub shows as connected in ADE, you are done. If not, start again from ADE.",
    status: 410,
  },
  unknown: {
    title: "This link does not work",
    lead: "ADE does not know this sign-in link.",
    next: "Start again from ADE to get a new link.",
    status: 400,
  },
  not_configured: {
    title: "GitHub sign-in is not available",
    lead: "ADE cannot connect GitHub here right now.",
    next: "Try again later, or sign in with a GitHub token in ADE Settings.",
    status: 503,
  },
};

export function failurePage(kind: FailureKind): Response {
  const copy = FAILURES[kind];
  return page(copy.title, `<h1>${escapeHtml(copy.title)}</h1>
<p class="lead">${escapeHtml(copy.lead)}</p>
${pair([{ label: "GitHub", value: "Not connected" }, { label: "ADE account", value: "No change" }], true)}
<p>${escapeHtml(copy.next)}</p>
<p class="done">You can close this tab.</p>`, copy.status);
}

/** The App's Setup URL. It ignores `installation_id`, which anyone can change (GitHub docs). */
export function installedPage(): Response {
  return page("ADE GitHub App installed", `<h1>The ADE GitHub App is installed</h1>
<p class="lead">Go back to ADE to keep working with your repositories.</p>
<a class="action" href="ade://github/installed">Open ADE</a>
<p class="done">On a computer, you can close this tab.</p>`, 200);
}

/** `a…@example.com`: enough to recognise the account, not enough to collect it. */
export function maskEmail(address: string | undefined): string | null {
  if (!address) return null;
  const at = address.lastIndexOf("@");
  if (at < 1) return null;
  return `${address[0]}…${address.slice(at)}`;
}

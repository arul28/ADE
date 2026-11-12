/**
 * The pages a person sees in the browser during the GitHub App sign-in and
 * after an install. They use the shared ADE page look (`../brandPage`): the
 * glass card over ADE's gradient, light and dark, phone width.
 *
 * The callback URL carries GitHub's `code` and `state`. The page loads
 * nothing but its own inlined logo (`img-src data:`), runs no script and
 * sends no referrer, so neither value leaves the page through a link or a
 * subresource.
 */

import { BRAND_IMG_SRC, brandDocument, escapeHtml, identityChain } from "../brandPage";

export type PageIdentity = {
  githubLogin: string;
  /** A masked address of the ADE account (`a…@example.com`), or null when Clerk could not be asked. */
  adeAccount: string | null;
};

/** No form, no frame, no subresource except the inlined logo. */
const PAGE_CSP = `default-src 'none'; style-src 'unsafe-inline'; ${BRAND_IMG_SRC}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

function page(document: string, status: number, csp: string = PAGE_CSP): Response {
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

const GITHUB_LABEL = "GitHub account";
const ADE_LABEL = "ADE account";

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
    ? `<p class="note">This replaces GitHub @${escapeHtml(replacedLogin)}, which is connected to this ADE account now.</p>`
    : "";
  const formAction = ["'self'", input.returnTarget].filter(Boolean).join(" ");
  const document = brandDocument({
    title: "Connect GitHub to ADE?",
    card: `<p class="sub">Check both accounts. Connect only if you started this in ADE.</p>
${identityChain({
    github: { label: GITHUB_LABEL, value: `@${identity.githubLogin}` },
    ade: { label: ADE_LABEL, value: identity.adeAccount ?? "The ADE account that started this", dim: !identity.adeAccount },
    state: "pending",
  })}
${replaced}
<form method="post" action="${escapeHtml(input.action)}">
<input type="hidden" name="signIn" value="${escapeHtml(input.signInId)}">
<input type="hidden" name="confirm" value="${escapeHtml(input.confirm)}">
<button class="primary" type="submit" name="choice" value="connect">Connect GitHub</button>
<button class="quiet" type="submit" name="choice" value="cancel">Cancel</button>
</form>
<p class="stop"><strong>Not you, or not your ADE account?</strong> Close this page. Nothing connects until you press Connect GitHub.</p>`,
    foot: "This page works for 10 minutes.",
  });
  return page(document, 200,
    `default-src 'none'; style-src 'unsafe-inline'; ${BRAND_IMG_SRC}; base-uri 'none'; form-action ${formAction}; frame-ancestors 'none'`);
}

/** Desktop and CLI: the grant is saved. `replacedLogin`: the account was connected to another GitHub user before. */
export function connectedPage(identity: PageIdentity, replacedLogin: string | null): Response {
  const replaced = replacedLogin && replacedLogin.toLowerCase() !== identity.githubLogin.toLowerCase()
    ? `<p class="note">This replaced GitHub @${escapeHtml(replacedLogin)}. If you did not want that, disconnect GitHub in ADE Settings and connect again.</p>`
    : "";
  const document = brandDocument({
    title: "GitHub is connected",
    card: `<p class="sub">ADE can use GitHub for you on every device where you use this ADE account.</p>
${identityChain({
    github: { label: GITHUB_LABEL, value: `@${identity.githubLogin}` },
    ade: { label: ADE_LABEL, value: identity.adeAccount ?? "Your ADE account", dim: !identity.adeAccount },
    state: "linked",
  })}
${replaced}
<p class="stop"><strong>Not you?</strong> Disconnect GitHub in ADE Settings.</p>`,
    foot: "You can close this page and go back to ADE.",
  });
  return page(document, 200);
}

export type FailureKind = "denied" | "error" | "expired" | "used" | "unknown" | "not_configured";

const FAILURES: Record<FailureKind, { title: string; lead: string; next: string; status: number }> = {
  denied: {
    title: "GitHub was not connected",
    lead: "You cancelled, so nothing changed.",
    next: "To connect GitHub, start again in ADE.",
    status: 200,
  },
  error: {
    title: "GitHub was not connected",
    lead: "GitHub did not accept this sign-in.",
    next: "Start again in ADE. If it keeps happening, wait a few minutes and try again.",
    status: 502,
  },
  expired: {
    title: "This link has expired",
    lead: "A GitHub sign-in link works for 10 minutes.",
    next: "Start again in ADE to get a new link.",
    status: 410,
  },
  used: {
    title: "This link was already used",
    lead: "A GitHub sign-in link works only once.",
    next: "If ADE shows GitHub as connected, you are done. If not, start again in ADE.",
    status: 410,
  },
  unknown: {
    title: "This link does not work",
    lead: "ADE does not know this sign-in link.",
    next: "Start again in ADE to get a new link.",
    status: 400,
  },
  not_configured: {
    title: "GitHub sign-in is not available",
    lead: "ADE cannot connect GitHub here right now.",
    next: "Try again later, or add a GitHub token in ADE Settings.",
    status: 503,
  },
};

export function failurePage(kind: FailureKind): Response {
  const copy = FAILURES[kind];
  const document = brandDocument({
    title: copy.title,
    card: `<p class="sub">${escapeHtml(copy.lead)}</p>
${identityChain({
    github: { label: GITHUB_LABEL, value: "Not connected", dim: true },
    ade: { label: ADE_LABEL, value: "No change", dim: true },
    state: "broken",
  })}
<p class="next">${escapeHtml(copy.next)}</p>`,
    foot: "You can close this page.",
  });
  return page(document, copy.status);
}

/** The App's Setup URL. It ignores `installation_id`, which anyone can change (GitHub docs). */
export function installedPage(): Response {
  const document = brandDocument({
    title: "ADE GitHub App installed",
    heading: "The ADE GitHub App is installed",
    card: `<p class="sub">Go back to ADE to keep working with your repositories.</p>
<a class="primary" href="ade://github/installed">Open ADE</a>`,
    foot: "On a computer, you can close this page.",
  });
  return page(document, 200);
}

/** `a…@example.com`: enough to recognise the account, not enough to collect it. */
export function maskEmail(address: string | undefined): string | null {
  if (!address) return null;
  const at = address.lastIndexOf("@");
  if (at < 1) return null;
  return `${address[0]}…${address.slice(at)}`;
}

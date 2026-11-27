/**
 * The look of every page this Worker shows in a browser: the GitHub App
 * sign-in pages, the device sign-in pages and the billing return page. It is
 * the desktop launch gate's look (a glass card over ADE's violet gradient),
 * so a person who leaves ADE for one of these pages sees the same product.
 *
 * Nothing here loads from the network. The logo is the Daex header logo
 * (`logo/daex-dark.png` and `logo/daex-light.png`, cut into a 264x128 WebP
 * box) and the badge is the flat icon (`assets/brand/daex/icon-flat-release.png`),
 * both inlined as data URIs, so a page needs only
 * `img-src data:` (`BRAND_IMG_SRC`) on top of its own strict CSP. No script.
 * Light and dark follow `prefers-color-scheme`.
 */

import { PRIVACY_URL, TERMS_URL } from "../../desktop/src/shared/legalLinks";

export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);

/** The one CSP addition a branded page needs: the inlined logo. */
export const BRAND_IMG_SRC = "img-src data:";

const LOGO_DARK = "data:image/webp;base64,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";
const LOGO_LIGHT = "data:image/webp;base64,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";
/** The Daex icon alone, for the 42 px identity badge where the wordmark's text would be unreadable. */
const LOGO_MARK = "data:image/webp;base64,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";

const STYLE = `
:root {
  color-scheme: light;
  --bg: #faf8f5;
  --fg: #1a1a1e;
  --text-2: color-mix(in srgb, var(--fg) 72%, transparent);
  --text-3: color-mix(in srgb, var(--fg) 62%, transparent);
  --lobe-a: color-mix(in srgb, #a5b4fc 46%, transparent);
  --lobe-b: color-mix(in srgb, #c4b5fd 40%, transparent);
  --glass-fill: color-mix(in srgb, var(--bg) 40%, transparent);
  --glass-top: color-mix(in srgb, white 52%, transparent);
  --glass-bottom: color-mix(in srgb, white 18%, transparent);
  --glass-edge: color-mix(in srgb, white 72%, transparent);
  --glass-rim: color-mix(in srgb, white 95%, transparent);
  --glass-shadow: 0 40px 90px -34px rgba(40, 24, 90, 0.34), 0 12px 32px -20px rgba(40, 24, 90, 0.24);
  --well: color-mix(in srgb, white 46%, transparent);
  --well-edge: color-mix(in srgb, var(--fg) 9%, transparent);
  --rule: color-mix(in srgb, var(--fg) 10%, transparent);
  --link: #7c3aed;
  --link-glow: color-mix(in srgb, #7c3aed 55%, transparent);
  --broken: color-mix(in srgb, var(--fg) 30%, transparent);
  --warn: #9a5b00;
  --warn-fill: color-mix(in srgb, #f59e0b 14%, transparent);
  --logo: url("${LOGO_LIGHT}");
  --sans: "Geist", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --mono: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --bg: #0c0b10;
    --fg: #f0f0f2;
    --text-2: color-mix(in srgb, var(--fg) 68%, transparent);
    --text-3: color-mix(in srgb, var(--fg) 48%, transparent);
    --lobe-a: color-mix(in srgb, #6366f1 30%, transparent);
    --lobe-b: color-mix(in srgb, #a78bfa 24%, transparent);
    --glass-fill: color-mix(in srgb, var(--bg) 30%, transparent);
    --glass-top: color-mix(in srgb, var(--fg) 10%, transparent);
    --glass-bottom: color-mix(in srgb, var(--fg) 3%, transparent);
    --glass-edge: color-mix(in srgb, var(--fg) 12%, transparent);
    --glass-rim: color-mix(in srgb, white 40%, transparent);
    --glass-shadow: 0 40px 90px -30px rgba(0, 0, 0, 0.7), 0 12px 32px -18px rgba(0, 0, 0, 0.5);
    --well: color-mix(in srgb, var(--fg) 6%, transparent);
    --well-edge: color-mix(in srgb, var(--fg) 10%, transparent);
    --rule: color-mix(in srgb, var(--fg) 10%, transparent);
    --link: #a78bfa;
    --link-glow: color-mix(in srgb, #a78bfa 60%, transparent);
    --broken: color-mix(in srgb, var(--fg) 28%, transparent);
    --warn: #fbbf24;
    --warn-fill: color-mix(in srgb, #f59e0b 13%, transparent);
    --logo: url("${LOGO_DARK}");
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 16px;
  color: var(--fg);
  font: 15px/1.55 var(--sans);
  -webkit-font-smoothing: antialiased;
  background:
    radial-gradient(42% 46% at 50% 50%, color-mix(in srgb, var(--bg) 22%, transparent), transparent 72%),
    radial-gradient(130% 100% at 18% 12%, var(--lobe-a), transparent 64%),
    radial-gradient(120% 90% at 82% 78%, var(--lobe-b), transparent 62%),
    var(--bg);
  background-attachment: fixed;
}
.stack {
  width: min(408px, 100%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  animation: rise 520ms cubic-bezier(0.16, 1, 0.3, 1) both;
}
.card {
  position: relative;
  width: 100%;
  padding: 34px 32px 26px;
  border-radius: 24px;
  border: 1px solid var(--glass-edge);
  background: linear-gradient(180deg, var(--glass-top), var(--glass-bottom)), var(--glass-fill);
  -webkit-backdrop-filter: blur(28px) saturate(1.3);
  backdrop-filter: blur(28px) saturate(1.3);
  box-shadow: inset 0 1px 0 var(--glass-rim), var(--glass-shadow);
  text-align: center;
}
.logo {
  display: block;
  width: 92px;
  height: 45px;
  margin: 0 auto;
  background: var(--logo) center / contain no-repeat;
  filter: drop-shadow(0 6px 18px rgba(0, 0, 0, 0.18));
}
h1 {
  margin: 18px 0 0;
  font-size: 27px;
  line-height: 1.15;
  font-weight: 600;
  letter-spacing: -0.025em;
  text-wrap: balance;
}
.sub {
  margin: 10px auto 0;
  max-width: 330px;
  color: var(--text-2);
  font-size: 14px;
  line-height: 1.55;
  text-wrap: pretty;
}
.sub strong, .stop strong { color: var(--fg); font-weight: 600; }

/* The two identities, joined by the bond: dashed while it waits, solid
   once connected, grey and open when nothing was connected. */
.chain {
  margin: 24px 0 0;
  padding: 4px;
  border-radius: 18px;
  border: 1px solid var(--well-edge);
  background: var(--well);
  text-align: left;
}
.who {
  display: grid;
  grid-template-columns: 42px 1fr;
  gap: 14px;
  align-items: center;
  padding: 12px 14px;
}
.badge {
  width: 42px;
  height: 42px;
  border-radius: 13px;
  display: grid;
  place-items: center;
}
.badge-gh { background: var(--fg); color: var(--bg); }
.badge-gh svg { width: 24px; height: 24px; }
.badge-ade { background: url("${LOGO_MARK}") center / contain no-repeat; }
.label { display: block; font-size: 12px; color: var(--text-3); line-height: 1.3; }
.value {
  display: block;
  margin-top: 2px;
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: 1.3;
  overflow-wrap: anywhere;
}
.value.dim { color: var(--text-3); font-weight: 500; }
.bond {
  position: relative;
  height: 12px;
  margin-left: 34px;
}
.bond::before {
  content: "";
  position: absolute;
  left: 0;
  top: -12px;
  bottom: -12px;
  border-left: 2px dashed var(--link);
}
.bond[data-state="linked"]::before {
  border-left-style: solid;
  box-shadow: 0 0 10px var(--link-glow);
  transform-origin: top;
  animation: draw 640ms 260ms cubic-bezier(0.65, 0, 0.35, 1) both;
}
.bond[data-state="broken"]::before { border-left-color: var(--broken); bottom: 75%; }
.bond[data-state="broken"]::after {
  content: "";
  position: absolute;
  left: 0;
  top: 75%;
  bottom: -12px;
  border-left: 2px dashed var(--broken);
}

.note {
  margin: 14px 0 0;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--warn-fill);
  color: var(--warn);
  font-size: 13px;
  line-height: 1.45;
  text-align: left;
}
.next { margin: 18px auto 0; max-width: 330px; color: var(--text-2); font-size: 14px; }
form { margin: 22px 0 0; }
.primary, .quiet {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  border: 0;
  font: inherit;
  text-decoration: none;
  cursor: pointer;
}
.primary {
  height: 46px;
  margin-top: 22px;
  border-radius: 13px;
  background: var(--fg);
  color: var(--bg);
  font-size: 14.5px;
  font-weight: 600;
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, white 30%, transparent),
    0 14px 30px -14px var(--link-glow);
  transition: transform 160ms ease, box-shadow 200ms ease;
}
form .primary { margin-top: 0; }
form input + .primary { margin-top: 14px; }
.primary:hover { transform: translateY(-1px); box-shadow: inset 0 1px 0 color-mix(in srgb, white 30%, transparent), 0 18px 36px -14px var(--link-glow); }
.quiet {
  height: 40px;
  margin-top: 6px;
  border-radius: 11px;
  background: transparent;
  color: var(--text-2);
  font-size: 13.5px;
  font-weight: 500;
}
.quiet:hover { background: var(--well); color: var(--fg); }
.primary:focus-visible, .quiet:focus-visible, input:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: 3px;
}
.stop {
  margin: 18px 0 0;
  padding-top: 16px;
  border-top: 1px solid var(--rule);
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.5;
}
.foot { margin: 0; color: var(--text-3); font-size: 12.5px; text-align: center; text-wrap: balance; }
.legal { margin: 16px 0 0; color: var(--text-3); font-size: 12px; line-height: 1.5; text-wrap: balance; }
.field-label { display: block; margin: 22px 0 8px; font-size: 13px; font-weight: 600; text-align: left; }
input {
  width: 100%;
  height: 50px;
  padding: 0 14px;
  border-radius: 13px;
  border: 1px solid var(--well-edge);
  background: var(--well);
  color: var(--fg);
  font: 600 20px/1 var(--mono);
  letter-spacing: 0.16em;
  text-align: center;
  text-transform: uppercase;
}
.code {
  margin: 20px 0 0;
  padding: 14px;
  border-radius: 14px;
  border: 1px solid var(--well-edge);
  background: var(--well);
  font: 600 24px/1.2 var(--mono);
  letter-spacing: 0.18em;
}
.code + form { margin-top: 18px; }
a { color: var(--link); }
@keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
@keyframes draw { from { transform: scaleY(0); } to { transform: scaleY(1); } }
@media (max-width: 420px) {
  body { padding: 20px 12px; align-items: flex-start; }
  .card { padding: 28px 20px 22px; border-radius: 22px; }
  h1 { font-size: 24px; }
  .who { padding: 11px 10px; gap: 12px; }
  .bond { margin-left: 30px; }
}
@media (prefers-reduced-motion: reduce) {
  .stack, .bond[data-state="linked"]::before { animation: none; }
  .primary { transition: none; }
  .primary:hover { transform: none; }
}
`;

/** GitHub's mark (the Octocat silhouette), drawn in currentColor. */
const GITHUB_MARK = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M12 .5C5.65.5.5 5.65.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.39-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z"/></svg>`;

export type BondState = "pending" | "linked" | "broken";

/**
 * The GitHub login and the ADE account, one above the other, with the bond
 * between them. Every value is escaped here.
 */
export function identityChain(input: {
  github: { label: string; value: string; dim?: boolean };
  ade: { label: string; value: string; dim?: boolean };
  state: BondState;
}): string {
  const row = (badge: string, item: { label: string; value: string; dim?: boolean }) =>
    `<div class="who">${badge}<span><span class="label">${escapeHtml(item.label)}</span><span class="value${item.dim ? " dim" : ""}">${escapeHtml(item.value)}</span></span></div>`;
  return `<div class="chain">${row(`<span class="badge badge-gh">${GITHUB_MARK}</span>`, input.github)}<div class="bond" data-state="${input.state}" aria-hidden="true"></div>${row(`<span class="badge badge-ade"></span>`, input.ade)}</div>`;
}

/**
 * The agree-to-Terms-and-Privacy line for a page that signs a person in or
 * up. A computer's sign-in can start here, so it carries the same line as the
 * apps' sign-in card.
 */
export const LEGAL_AGREEMENT_HTML =
  `<p class="legal">By continuing, you agree to Daex's <a href="${TERMS_URL}" target="_blank" rel="noreferrer">Terms</a> and <a href="${PRIVACY_URL}" target="_blank" rel="noreferrer">Privacy Policy</a>.</p>`;

/**
 * The whole document. `card` is the card's inner HTML after the heading;
 * `foot` is one quiet line under the card. Callers escape what they pass in
 * `card` and `foot`; the title and heading are escaped here.
 */
export function brandDocument(input: {
  title: string;
  heading?: string;
  card: string;
  foot?: string;
  head?: string;
  /** Must match the page's `referrer-policy` header. */
  referrer?: "no-referrer" | "same-origin";
}): string {
  const heading = input.heading ?? input.title;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="${input.referrer ?? "no-referrer"}">
<meta name="robots" content="noindex">${input.head ?? ""}
<title>${escapeHtml(input.title)}</title>
<style>${STYLE}</style>
</head>
<body><main class="stack"><div class="card"><span class="logo" role="img" aria-label="Daex"></span><h1>${escapeHtml(heading)}</h1>${input.card}</div>${input.foot ? `<p class="foot">${input.foot}</p>` : ""}</main></body>
</html>`;
}

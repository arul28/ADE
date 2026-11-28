/**
 * The look of every page this Worker shows in a browser: the GitHub App
 * sign-in pages, the device sign-in pages and the billing return page. It is
 * the desktop launch gate's look (a glass card over ADE's violet gradient),
 * so a person who leaves ADE for one of these pages sees the same product.
 *
 * Nothing here loads from the network. The logo is the DAEX header logo
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
/** The DAEX icon alone, for the 42 px identity badge where the wordmark's text would be unreadable. */
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
  `<p class="legal">By continuing, you agree to DAEX's <a href="${TERMS_URL}" target="_blank" rel="noreferrer">Terms</a> and <a href="${PRIVACY_URL}" target="_blank" rel="noreferrer">Privacy Policy</a>.</p>`;

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
<body><main class="stack"><div class="card"><span class="logo" role="img" aria-label="DAEX"></span><h1>${escapeHtml(heading)}</h1>${input.card}</div>${input.foot ? `<p class="foot">${input.foot}</p>` : ""}</main></body>
</html>`;
}

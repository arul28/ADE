/**
 * The look of every page this Worker shows in a browser: the GitHub App
 * sign-in pages, the device sign-in pages and the billing return page. It is
 * the desktop launch gate's look (a glass card over ADE's violet gradient),
 * so a person who leaves ADE for one of these pages sees the same product.
 *
 * Nothing here loads from the network. The logo is the real ADE wordmark
 * (`apps/desktop/src/renderer/public/logo.png` and `logo-light.png`, cut to
 * 264 px wide WebP) inlined as a data URI, so a page needs only
 * `img-src data:` (`BRAND_IMG_SRC`) on top of its own strict CSP. No script.
 * Light and dark follow `prefers-color-scheme`.
 */

export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);

/** The one CSP addition a branded page needs: the inlined logo. */
export const BRAND_IMG_SRC = "img-src data:";

const LOGO_DARK = "data:image/webp;base64,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";
const LOGO_LIGHT = "data:image/webp;base64,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";

const STYLE = `
:root {
  color-scheme: light;
  --bg: #faf8f5;
  --fg: #1a1a1e;
  --text-2: color-mix(in srgb, var(--fg) 72%, transparent);
  --text-3: color-mix(in srgb, var(--fg) 54%, transparent);
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
.badge-ade { background: color-mix(in srgb, var(--link) 12%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--link) 22%, transparent); }
.badge-ade .logo { width: 32px; height: 16px; filter: none; }
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
  return `<div class="chain">${row(`<span class="badge badge-gh">${GITHUB_MARK}</span>`, input.github)}<div class="bond" data-state="${input.state}" aria-hidden="true"></div>${row(`<span class="badge badge-ade"><span class="logo"></span></span>`, input.ade)}</div>`;
}

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
<body><main class="stack"><div class="card"><span class="logo" role="img" aria-label="ADE"></span><h1>${escapeHtml(heading)}</h1>${input.card}</div>${input.foot ? `<p class="foot">${input.foot}</p>` : ""}</main></body>
</html>`;
}

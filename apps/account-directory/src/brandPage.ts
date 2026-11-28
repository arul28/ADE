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
const LOGO_MARK = "data:image/webp;base64,UklGRhoHAABXRUJQVlA4WAoAAAAQAAAAUwAAUwAAQUxQSHgBAAABgBvbturmvP9CqQTKjC1gLHcgyUw1YRGYMVbAdsQRM7z77zEKb+6IYBuwbRuQstP3kB/gr7xD1DA2tX16/1Rj3Z1uT481RnAeZeUiJPpW31k3va/2J+CjMkTOFY+oGoJoHSQfQuVxMXKl7ZGep4oo6yYVUS6k4UtO+zlDzDorDjzvKGGP3BMDDUj41P3HHp2PFNKGHzt/2SF7+jNWfJJF9MMMA80ocAYOHn0U0pJ7vye5y9gSMXeSwICtnRQOAov2WEHzK9UWyufWsZ/d2jY0yWCP8S3G9lg/oVoj5u6dPZSXTxa5Mcn1v5vc2PzHt5lF2MxMpkxmO6MmM6imN4NZWYvFTG8Z6DeZPSb3GBv7ahIevbY2YS+8zcz5m4zBbBweXfYyfMAj92jipgY+5UoWGG3nDHW/KH87kRJOzVnobuZT8OU6pvwRlUFEtOaKJQRVHuWdiyrowvrXX1k3va6X7sJKd3ZoGprY2Lu8qrEu9zYmhptQsrMDVlA4IHwFAAAQHQCdASpUAFQAPjEYikOiIaERzAVAIAMEoA05nyft2pU9Y/JT2IrM/dt7TNJ2Ffqukt9wHqbdIDzAfrt/gPaG/wHqb9AD+c/2L0ZvYP9AD9jvS8/ZX4N/2E/aj4D/1nper1z8gP2wzAP3T8oNFB/ffyX/I7jjeJfzP/DaMlxg0cXqlf1X/R8oP0J/w/cC/kn9E/3HYi/Yz2Jv2cHjz9Zyzz5aoQgk1f0JJerGv6u7p16b3grRASogkM00b/esk97kxvaQBcDSe1NYbJksiblXFK8veZ66oOwkppyBDLW9xH+ggs7JvYpj164UTX75mWQAAP7/CWD2SYXGR/az501Ftv6hey3bOq65ZPkYBKBIrL/HpzQzYNefsOt9aOc47Efh6NXoCS/767j8QfHD3lF+NfofLB/B+u2o6/cs019/QbP4cimudTIxAUsrEP3nP/ptnu4q4FYFfIlr2W+TylAArTXtzwKf+n0FvomphjmwgTtl8mXkPvwAwlzmnzH1Ev4ZePd7yI2VLz4f+0s6k6oy49RypZ8B6tKrdtpctCwZlY3iwGgZFZpT/qu4UPKIpMZe9ZRRWh84T6bpryltMt91RZyhqCjX7ygPFPi8itcMeM8vuM/afnLL+B4qCaSK8Vig/RWUn08IJvYYnSugzsjflntj3qXGHtzeMXQJBLjy7Qcyi3WYbNupF3Zsagy+PTu4xACZNHm9H6P6rukzqCXxx7nervGDK1gkJ9+CU9CO/4B6obcmDs1D5xvDHGNIITZwmBblGOyFVAC8xb7i85+3v8sHC2OF/201zlqEhffspvhKX6oN1bv/0xXh5P5Z+8ON1UGNJZ9b1vUgySC5D9qF8fzAZ2TugDTmnDdfdyfItLunUF5Mce190/T0omButnq4eGo2v3RBi/dLV+xJv4aiClgk0/+M/KITJ/xk8snLKpf8hKYpnm5B7LtIGVtt90Z3eypUuGpyV8LXvEzhi1tSdlYJoVjo50SL3fOj9F/CRYut0c5iHCyfG5qxLjtSp4kox8SwZiO9g8Q2T/oavltPv3/qv7BMdh0tBCfpU4VpSVWo0QPZin+v9uCv7ad05neKhW0ZISx/zV4x3lBeh9l5tG9EG2H5L28KniPVNdNKN/Upy9ySRuTAXLuLPrFi5p/u8lw8zyFkmev/ycDPaYRv/8WDUD8ABtXVTCiUv8Oc1Gf6/YOkqSTvpqYWFSsL87+n68ofB2iVl0eC2em926UI5RSY49LFLAy5D53UMs76+d/CM5UrFjyAKzVLiwOx6iIADCRDNKIuxV8L5pMrvZeEIp8joxP/jZ5abGMKQANeC7/y959JOsvTQPchz8GrgepTZZjPn0ybRM4vs0mf+Iq3jjMFvDFaL/cmLqsFFm3lmqQXj/kX1P8t974GsxQTJGe7Tzh/hbPFgysG0AIriad0ljovzJ58F9NIhkW7V9GHFU4Bg7xWKTYRPr/4WiKMVS4ft81/CdD8F2aDFyk2/qAmR1GCqZvN10/KaR//z8c7Iji2wZfJ50lmeRWm6KFcKbIiAdu0xExv6mMPy/bl7FuJyWQxoMAM/voHwPLRRJHPkXW3l6PW5JNP42IQ/s/jladCeQDLmAlYyFC6dABXri2dxkxJhI6DM93/ba8uEiECNssnjKxwf5Ab4SEH9H+uu+LsONIA8VWUThjwQy7axWAxBP2OOC+HGrpP/x14EHDuKWNSOE2p2Tu6Mi//9DjwPDpmNw/ZVCx/d8MA/1S5HxUpxA3bxPkhvUQCnWcdURH4+svZdFAPxiIO0ljD3fWfwgtSSlEGLgdtVpx2yY6Uq605QLC2Idi5jM0/JedANCQv1OOTG2COl2L/juLJIJPSwbKf9chuoscAg+SEAAA=";

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

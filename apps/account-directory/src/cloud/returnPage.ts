import { escapeHtml } from "../brandPage";
import { CLOUD_PLANS, isPaidPlanId, type CloudPaidPlanId } from "./plans";

/**
 * The page Stripe sends a person back to after Checkout, the billing portal
 * or the free plan's card step (`GET /billing/return?to=…`). ADE Cloud's look
 * from the website: a dusk sky with stars and slow clouds, the ADE Cloud mark
 * (a violet-to-rose cloud with one lit gold window), gold accents and a slow
 * light around the main button. Light and dark follow `prefers-color-scheme`
 * (a dawn sky in light).
 *
 * Self-contained: no script, no network. The marks are inline SVG and the
 * stars one box-shadow list, so the CSP stays `default-src 'none'` with
 * inline styles only. Animations move transform and opacity only and stop
 * under reduced motion.
 *
 * "Open ADE" is the desktop's own deeplink to Settings › ADE Cloud
 * (`apps/desktop/src/shared/deeplinks.ts`, entry `integrations.ade-cloud`),
 * where the plan, extra hours and Manage billing are.
 */

const OPEN_ADE_CLOUD = "ade://settings/integrations.ade-cloud";
const DOCS = "https://ade-app.dev/docs/cloud/overview";
const LINKS = {
  firstLane: `${DOCS}#start-a-lane-on-ade-cloud`,
  hours: `${DOCS}#hours-and-disk`,
  billing: `${DOCS}#manage-your-plan-and-billing`,
  pricing: "https://ade-app.dev/pricing",
} as const;

type ReturnKind = "done" | "cancelled" | "portal" | "card" | "card_cancelled";

const PLAN_LABELS: Record<CloudPaidPlanId, string> = { plus: "Plus", pro: "Pro", max: "Max" };

/** The cloud outline the website's mark and sky share. */
const CLOUD_PATH = "M9 21H24A5.5 5.5 0 0 0 24.6 10.03A7.5 7.5 0 0 0 10.4 8.2A6.5 6.5 0 0 0 9 21Z";

/** The ADE Cloud mark; `id` keeps each copy's gradient its own. */
function cloudMark(id: string, className: string): string {
  return `<svg class="${className}" viewBox="1 3 30 20" overflow="visible" aria-hidden="true">
  <defs>
    <linearGradient id="${id}-fill" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#c4b5fd"/><stop offset="55%" stop-color="#8b5cf6"/><stop offset="100%" stop-color="#db2777"/></linearGradient>
    <filter id="${id}-glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="1.1"/></filter>
  </defs>
  <path d="${CLOUD_PATH}" fill="url(#${id}-fill)"/>
  <path d="${CLOUD_PATH}" fill="none" stroke="white" stroke-opacity="0.35" stroke-width="0.6"/>
  <rect x="15" y="12.2" width="4.4" height="4.4" rx="0.9" fill="#ffd27a" filter="url(#${id}-glow)" opacity="0.9"/>
  <rect x="15" y="12.2" width="4.4" height="4.4" rx="0.9" fill="#ffd27a"/>
</svg>`;
}

/** A small deterministic star field: the same sky every load, one element. */
function starShadows(seed: number, count: number, spread: { w: number; h: number }): string {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const stars: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const x = Math.round(next() * spread.w);
    const y = Math.round(next() * spread.h);
    const alpha = (0.35 + next() * 0.6).toFixed(2);
    stars.push(`${x}px ${y}px 0 rgba(255,246,222,${alpha})`);
  }
  return stars.join(",");
}

const STARS_NEAR = starShadows(7, 70, { w: 2400, h: 900 });
const STARS_FAR = starShadows(31, 90, { w: 2400, h: 900 });

/* Drifting clouds: left, top, width, opacity, seconds, delay, flipped. */
const DRIFTS: Array<[string, string, string, number, number, number, boolean]> = [
  ["-8%", "7%", "clamp(200px,28vw,440px)", 0.55, 95, -20, false],
  ["70%", "12%", "clamp(170px,22vw,360px)", 0.45, 120, -60, true],
  ["4%", "46%", "clamp(240px,34vw,560px)", 0.35, 140, -35, true],
  ["60%", "54%", "clamp(240px,36vw,600px)", 0.45, 125, -80, false],
];

const BANK_BACK = [16, 22, 18, 26, 20, 24, 17];
const BANK_FRONT = [20, 15, 24, 19, 27, 16, 22];

function bankRow(widths: number[], gradient: string, rim: number, className: string, flipOdd: boolean): string {
  const clouds = widths.map((width, index) =>
    `<svg viewBox="1 3 30 20" preserveAspectRatio="none" overflow="visible" style="width:${width}%;${flipOdd && index % 2 ? "transform:scaleX(-1);" : ""}"><path d="${CLOUD_PATH}" fill="url(#${gradient})"/><path d="${CLOUD_PATH}" fill="none" class="rim" stroke-opacity="${rim}" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`).join("");
  return `<div class="bank-row ${className}">${clouds}</div>`;
}

function sky(): string {
  const drifts = DRIFTS.map(([left, top, width, opacity, seconds, delay, flip]) =>
    `<div class="drift" style="left:${left};top:${top};width:${width};opacity:${opacity};animation-duration:${seconds}s;animation-delay:${delay}s"><svg viewBox="1 3 30 20" overflow="visible"${flip ? ' style="transform:scaleX(-1)"' : ""}><path d="${CLOUD_PATH}" fill="url(#drift-fill)" filter="url(#drift-soft)"/></svg></div>`).join("");
  return `<div class="sky" aria-hidden="true">
  <div class="stars far"></div><div class="stars near"></div>
  <span class="shooting"></span>
  <svg width="0" height="0" class="defs"><defs>
    <linearGradient id="drift-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" class="drift-top"/><stop offset="45%" class="drift-mid"/><stop offset="100%" class="drift-end"/></linearGradient>
    <filter id="drift-soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="0.5"/></filter>
    <linearGradient id="bank-back" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" class="bb-0"/><stop offset="45%" class="bb-1"/><stop offset="100%" class="bb-2"/></linearGradient>
    <linearGradient id="bank-front" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" class="bf-0"/><stop offset="40%" class="bf-1"/><stop offset="100%" class="bf-2"/></linearGradient>
  </defs></svg>
  ${drifts}
  <div class="bank">
    <div class="bank-glow"></div>
    ${bankRow(BANK_BACK, "bank-back", 0.22, "back drift-slow", true)}
    ${bankRow(BANK_FRONT, "bank-front", 0.3, "front", false)}
  </div>
</div>`;
}

const ARROW = `<svg class="arrow" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function icon(name: "lane" | "hours" | "card" | "plans"): string {
  const paths: Record<typeof name, string> = {
    lane: `<path d="M4 4v8M4 8h5a3 3 0 0 0 3-3V4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="4" cy="12.5" r="1.5" fill="currentColor"/><circle cx="12" cy="3.5" r="1.5" fill="currentColor"/>`,
    hours: `<circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 5v3.2l2 1.3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`,
    card: `<rect x="2" y="4" width="12" height="8.5" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M2 7h12" stroke="currentColor" stroke-width="1.5"/>`,
    plans: `<path d="M3 12.5 6.5 9l2.2 2.2L13 6.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  };
  return `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true">${paths[name]}</svg>`;
}

function tile(href: string, glyph: Parameters<typeof icon>[0], label: string): string {
  return `<a class="tile" href="${escapeHtml(href)}">${icon(glyph)}<span>${escapeHtml(label)}</span>${ARROW}</a>`;
}

const hoursText = (milli: number): string => (milli / 1000).toLocaleString("en-US");

/** The plan's three numbers, all from `CLOUD_PLANS`. */
function planFacts(plan: CloudPaidPlanId): string {
  const terms = CLOUD_PLANS[plan];
  const facts: Array<[string, string]> = [
    [hoursText(terms.includedMilli), "hours a month"],
    [`${terms.diskGb} GB`, "disk"],
    ["Any number", "of computers"],
  ];
  return `<ul class="facts">${facts.map(([value, label]) => `<li><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></li>`).join("")}</ul>`;
}

type Content = { title: string; eyebrow: string; heading: string; lede: string; body: string; tiles: string[] };

function contentFor(kind: ReturnKind, plan: CloudPaidPlanId | null): Content {
  switch (kind) {
    case "done":
      return {
        title: plan ? `You're on ADE Cloud ${PLAN_LABELS[plan]}` : "Thanks for buying ADE Cloud",
        eyebrow: "Payment complete",
        heading: plan ? `Thank you. You're on ${PLAN_LABELS[plan]}.` : "Thank you. Your plan is ready.",
        lede: "It shows in ADE in a moment. Your hours start fresh today.",
        body: plan ? planFacts(plan) : "",
        tiles: [tile(LINKS.firstLane, "lane", "Start your first cloud lane"), tile(LINKS.hours, "hours", "How hours and disk work"), tile(LINKS.billing, "card", "Manage billing")],
      };
    case "cancelled":
      return {
        title: "Nothing changed",
        eyebrow: "Checkout closed",
        heading: "Nothing changed.",
        lede: "You left checkout before paying, so you weren't charged. Your plan is as it was.",
        body: "",
        tiles: [tile(LINKS.pricing, "plans", "Compare the plans"), tile(LINKS.hours, "hours", "How hours and disk work")],
      };
    case "card":
      return {
        title: "Card saved",
        eyebrow: "Card saved",
        heading: "Your free hours are on.",
        lede: "You weren't charged. They show in ADE in a moment.",
        body: "",
        tiles: [tile(LINKS.firstLane, "lane", "Start your first cloud lane"), tile(LINKS.hours, "hours", "How hours and disk work")],
      };
    case "card_cancelled":
      return {
        title: "Nothing changed",
        eyebrow: "No card saved",
        heading: "Nothing changed.",
        lede: "You left before saving a card. Your free hours start when your GitHub account is 30 days old.",
        body: "",
        tiles: [tile(LINKS.hours, "hours", "How hours and disk work")],
      };
    case "portal":
      return {
        title: "Back to ADE",
        eyebrow: "Billing",
        heading: "All set.",
        lede: "Any change you made shows in ADE in a moment.",
        body: "",
        tiles: [tile(LINKS.billing, "card", "Manage billing"), tile(LINKS.pricing, "plans", "Compare the plans")],
      };
  }
}

const STYLE = `
:root {
  color-scheme: light;
  --fg: #1d1838;
  --fg-2: rgba(29, 24, 56, 0.72);
  --fg-3: rgba(29, 24, 56, 0.55);
  --gold: #a8660a;
  --gold-soft: rgba(196, 128, 20, 0.14);
  --card: rgba(255, 255, 255, 0.62);
  --card-edge: rgba(255, 255, 255, 0.85);
  --card-shadow: 0 40px 90px -40px rgba(76, 40, 140, 0.45), 0 12px 30px -18px rgba(76, 40, 140, 0.3);
  --tile: rgba(255, 255, 255, 0.5);
  --tile-hover: rgba(255, 255, 255, 0.78);
  --tile-edge: rgba(91, 33, 182, 0.12);
  --rule: rgba(91, 33, 182, 0.12);
  --sky: radial-gradient(ellipse 80% 40% at 50% 78%, rgba(244, 114, 182, 0.30) 0%, transparent 70%),
         radial-gradient(ellipse 60% 34% at 30% 70%, rgba(255, 210, 122, 0.32) 0%, transparent 70%),
         linear-gradient(180deg, #e9e3ff 0%, #f1e8ff 38%, #ffe8ef 70%, #fff3e4 100%);
  --star-opacity: 0;
  --drift-top: #ffffff; --drift-top-o: 0.95; --drift-mid: #efe7ff; --drift-mid-o: 0.6; --drift-end: #efe7ff;
  --bb-0: #f7dff0; --bb-1: #e8dcff; --bb-2: #f3eeff;
  --bf-0: #ffffff; --bf-1: #f4efff; --bf-2: #fbf8ff;
  --rim: #ffffff;
  --button-fill: linear-gradient(180deg, #2a1d5c, #1a1340);
  --button-fg: #fff7e6;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --fg: #f4f1ff;
    --fg-2: rgba(244, 241, 255, 0.74);
    --fg-3: rgba(244, 241, 255, 0.52);
    --gold: #ffd27a;
    --gold-soft: rgba(255, 210, 122, 0.12);
    --card: rgba(24, 18, 54, 0.58);
    --card-edge: rgba(196, 181, 253, 0.18);
    --card-shadow: 0 40px 100px -40px rgba(0, 0, 0, 0.8), 0 0 0 1px rgba(139, 92, 246, 0.06);
    --tile: rgba(30, 22, 66, 0.55);
    --tile-hover: rgba(48, 34, 100, 0.7);
    --tile-edge: rgba(196, 181, 253, 0.14);
    --rule: rgba(196, 181, 253, 0.14);
    --sky: radial-gradient(ellipse 70% 38% at 50% 74%, rgba(139, 92, 246, 0.42) 0%, rgba(139, 92, 246, 0.12) 45%, transparent 75%),
           radial-gradient(ellipse 30% 22% at 26% 74%, rgba(219, 39, 119, 0.22) 0%, transparent 70%),
           radial-gradient(ellipse 28% 20% at 76% 70%, rgba(255, 210, 122, 0.12) 0%, transparent 70%),
           linear-gradient(180deg, #07061a 0%, #0f0c2a 34%, #1a1240 66%, #0c0a1c 100%);
    --star-opacity: 1;
    --drift-top: #d8ccff; --drift-top-o: 0.32; --drift-mid: #a78bfa; --drift-mid-o: 0.14; --drift-end: #a78bfa;
    --bb-0: #6b2f7d; --bb-1: #2c1650; --bb-2: #1a1138;
    --bf-0: #4a3392; --bf-1: #24184f; --bf-2: #120e2a;
    --rim: #efe7ff;
    --button-fill: linear-gradient(180deg, #241a52, #140f33);
    --button-fg: #fff7e6;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
body {
  min-height: 100vh;
  min-height: 100dvh;
  background: #0c0a1c;
  background: var(--sky);
  background-attachment: fixed;
  color: var(--fg);
  font-family: "Geist", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
  overflow-x: hidden;
}
.sky { position: fixed; inset: 0; overflow: hidden; pointer-events: none; }
.sky .defs { position: absolute; }
.stars { position: absolute; left: 0; top: 0; width: 1px; height: 1px; border-radius: 50%; opacity: var(--star-opacity); }
.stars.near { box-shadow: ${STARS_NEAR}; animation: twinkle 5s ease-in-out infinite; }
.stars.far { box-shadow: ${STARS_FAR}; opacity: calc(var(--star-opacity) * 0.6); }
@keyframes twinkle { 0%, 100% { opacity: calc(var(--star-opacity) * 0.55); } 50% { opacity: var(--star-opacity); } }
.shooting {
  position: absolute; left: 16%; top: 10%; width: 120px; height: 1px; border-radius: 999px;
  background: linear-gradient(90deg, transparent, rgba(255, 241, 207, 0.9));
  opacity: 0; transform-origin: right center; animation: shoot 11s ease-in 3s infinite;
  visibility: hidden;
}
@media (prefers-color-scheme: dark) { .shooting { visibility: visible; } }
@keyframes shoot {
  0%, 82% { opacity: 0; transform: translate3d(0, 0, 0) rotate(-24deg); }
  84% { opacity: 1; }
  92%, 100% { opacity: 0; transform: translate3d(340px, 150px, 0) rotate(-24deg); }
}
.drift-top { stop-color: var(--drift-top); stop-opacity: var(--drift-top-o); }
.drift-mid { stop-color: var(--drift-mid); stop-opacity: var(--drift-mid-o); }
.drift-end { stop-color: var(--drift-end); stop-opacity: 0; }
.bb-0 { stop-color: var(--bb-0); } .bb-1 { stop-color: var(--bb-1); } .bb-2 { stop-color: var(--bb-2); }
.bf-0 { stop-color: var(--bf-0); } .bf-1 { stop-color: var(--bf-1); } .bf-2 { stop-color: var(--bf-2); }
.rim { stroke: var(--rim); }
.drift { position: absolute; animation: drift 110s ease-in-out infinite alternate; will-change: transform; }
.drift svg { display: block; width: 100%; }
@keyframes drift { from { transform: translate3d(-4vw, 0, 0); } to { transform: translate3d(4vw, -6px, 0); } }
.bank { position: absolute; left: 0; right: 0; bottom: 0; height: 30vh; min-height: 180px; overflow: hidden; -webkit-mask-image: linear-gradient(to bottom, black 62%, transparent 98%); mask-image: linear-gradient(to bottom, black 62%, transparent 98%); }
.bank-glow { position: absolute; left: 10%; right: 10%; bottom: 30%; height: 40%; border-radius: 50%; background: radial-gradient(ellipse at center, rgba(244, 114, 182, 0.35), transparent 70%); }
.bank-row { position: absolute; left: -6%; right: -6%; bottom: 0; display: flex; align-items: flex-end; justify-content: center; }
.bank-row.back { bottom: 16%; }
.bank-row svg { display: block; flex-shrink: 0; aspect-ratio: 30 / 13; height: auto; margin: 0 -2.5%; }
.drift-slow { animation: drift 160s ease-in-out infinite alternate; will-change: transform; }
.wrap { position: relative; z-index: 1; max-width: 600px; margin: 0 auto; padding: clamp(28px, 7vh, 72px) 16px 56px; }
.lockup { display: inline-flex; align-items: center; gap: 10px; font-weight: 650; font-size: 17px; letter-spacing: -0.01em; text-decoration: none; color: var(--fg); margin: 0 0 22px 4px; }
.lockup .mark { width: 34px; height: auto; }
.card {
  position: relative;
  background: var(--card);
  border: 1px solid var(--card-edge);
  border-radius: 24px;
  padding: clamp(24px, 5vw, 40px);
  box-shadow: var(--card-shadow);
  -webkit-backdrop-filter: blur(22px) saturate(1.3);
  backdrop-filter: blur(22px) saturate(1.3);
}
.hero-mark { display: block; width: 76px; height: auto; margin: 0 0 18px; filter: drop-shadow(0 10px 24px rgba(139, 92, 246, 0.45)); }
.hero-mark rect:last-of-type { animation: lamp 7s ease-in-out infinite; }
@keyframes lamp { 0%, 88%, 100% { opacity: 1; } 92% { opacity: 0.35; } 95% { opacity: 1; } }
.eyebrow { display: inline-flex; align-items: center; gap: 8px; margin: 0 0 12px; padding: 4px 10px; border-radius: 999px; background: var(--gold-soft); color: var(--gold); font-size: 12.5px; font-weight: 600; letter-spacing: 0.02em; }
.eyebrow::before { content: ""; width: 6px; height: 6px; border-radius: 2px; background: currentColor; box-shadow: 0 0 10px currentColor; }
h1 { margin: 0 0 10px; font-size: clamp(26px, 5.4vw, 34px); line-height: 1.12; letter-spacing: -0.025em; font-weight: 700; }
.lede { margin: 0; font-size: 16px; line-height: 1.55; color: var(--fg-2); }
.facts { list-style: none; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin: 24px 0 0; padding: 18px 0 0; border-top: 1px solid var(--rule); gap: 12px; }
.facts li { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.facts strong { font-size: clamp(19px, 4.4vw, 24px); font-weight: 700; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.facts span { font-size: 13px; color: var(--fg-3); }
.cta {
  position: relative; display: flex; align-items: center; justify-content: center; gap: 10px;
  margin: 28px 0 0; min-height: 54px; padding: 0 22px; border-radius: 999px;
  color: var(--button-fg); font-weight: 650; font-size: 16.5px; text-decoration: none;
  border: 1.5px solid transparent;
  background:
    var(--button-fill) padding-box,
    linear-gradient(90deg, rgba(167, 139, 250, 0.4), #ffd27a, #f472b6, rgba(167, 139, 250, 0.4), rgba(167, 139, 250, 0.4)) border-box;
  background-size: 100% 100%, 300% 100%;
  animation: ring 7s linear infinite;
  box-shadow: 0 14px 40px -14px rgba(139, 92, 246, 0.75);
  transition: transform 160ms ease, box-shadow 160ms ease;
}
.cta:hover { transform: translateY(-1px); box-shadow: 0 18px 48px -14px rgba(139, 92, 246, 0.9); }
.cta:focus-visible { outline: 2px solid var(--gold); outline-offset: 3px; }
.cta .mark { width: 26px; height: auto; }
.cta .arrow { width: 18px; height: 18px; opacity: 0.8; }
@keyframes ring { to { background-position: 0 0, 300% 0; } }
.tiles { display: grid; gap: 10px; margin: 18px 0 0; }
.tile {
  display: flex; align-items: center; gap: 12px; min-height: 52px; padding: 0 16px; border-radius: 14px;
  background: var(--tile); border: 1px solid var(--tile-edge); color: var(--fg); text-decoration: none; font-size: 15px; font-weight: 550;
  -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
  transition: background 160ms ease;
}
.tile:hover { background: var(--tile-hover); }
.tile:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
.tile .icon { width: 18px; height: 18px; color: var(--gold); flex-shrink: 0; }
.tile span { flex: 1; }
.tile .arrow { width: 16px; height: 16px; color: var(--fg-3); }
.foot { margin: 26px 0 0; text-align: center; font-size: 13px; color: var(--fg-3); }
@media (max-width: 640px) {
  .bank { height: 20vh; min-height: 140px; }
  .bank-row { left: -45%; right: -45%; }
}
@media (max-width: 420px) {
  .facts { grid-template-columns: 1fr; gap: 10px; }
  .facts li { flex-direction: row; align-items: baseline; gap: 8px; }
}
@media (prefers-reduced-motion: reduce) {
  .drift, .drift-slow, .stars.near, .shooting, .cta, .hero-mark rect:last-of-type { animation: none; }
}
`;

/** The return page's HTML for `to` (`done`, `cancelled`, `portal`, `card`, `card_cancelled`) and the plan bought, when known. */
export function cloudReturnPageHtml(to: string, planParam: string | null): string {
  const kinds: readonly ReturnKind[] = ["done", "cancelled", "portal", "card", "card_cancelled"];
  // Own values only: an unknown `to` reads as the portal's return.
  const kind: ReturnKind = (kinds as readonly string[]).includes(to) ? to as ReturnKind : "portal";
  const plan = kind === "done" && isPaidPlanId(planParam) ? planParam : null;
  const content = contentFor(kind, plan);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>${escapeHtml(content.title)} · ADE Cloud</title>
<style>${STYLE}</style>
</head>
<body>
${sky()}
<main class="wrap">
  <a class="lockup" href="https://ade-app.dev">${cloudMark("lockup", "mark")}ADE Cloud</a>
  <section class="card">
    ${cloudMark("hero", "hero-mark")}
    <p class="eyebrow">${escapeHtml(content.eyebrow)}</p>
    <h1>${escapeHtml(content.heading)}</h1>
    <p class="lede">${escapeHtml(content.lede)}</p>
    ${content.body}
    <a class="cta" href="${OPEN_ADE_CLOUD}">${cloudMark("cta", "mark")}<span>Open ADE</span>${ARROW}</a>
  </section>
  <nav class="tiles" aria-label="Next steps">${content.tiles.join("")}</nav>
  <p class="foot">You can close this page.</p>
</main>
</body>
</html>`;
}

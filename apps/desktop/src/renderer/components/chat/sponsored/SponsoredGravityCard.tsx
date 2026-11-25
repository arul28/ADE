import { Suspense, lazy, useLayoutEffect, useMemo, useRef, useState } from "react";
import { X } from "@phosphor-icons/react";
import type { GravityAdData } from "@gravity-ai/ui";
import { isGravityUrl, type CloudSponsoredGravityAd } from "../../../../shared/adeCloud";
import { openExternalUrl } from "../../../lib/openExternal";

/**
 * A sponsored card drawn by Gravity's own renderer (`@gravity-ai/ui`), as
 * Gravity recommends: the design comes from Gravity's server
 * (`renderer_spec`), and the renderer sends the view link and its
 * measured/viewable beacons itself. ADE keeps what is ADE's: where the card
 * sits, the hide button, ADE's colors, and opening links in the browser
 * (Gravity's own links only). Loaded only when a card shows, so the renderer
 * never weighs on start-up.
 */

const GravityAd = lazy(() => import("@gravity-ai/ui").then((module) => ({ default: module.GravityAd })));

/** Gravity's placement type for each ADE format: the renderer only reads it for its own requests. */
export type SponsoredGravityPlace = "below_response" | "bottom_page" | "inline_response";

type Props = {
  ad: CloudSponsoredGravityAd;
  place: SponsoredGravityPlace;
  brand: string;
  onHide: () => void;
};

export function SponsoredGravityCard({ ad, place, brand, onHide }: Props) {
  const ref = useRef<HTMLElement | null>(null);
  const theme = useGravityTheme(ref);
  // The design's links fall back to the landing page only when Gravity sent no tracked link; ADE always has one.
  const data = useMemo(() => ({ ...ad, url: ad.url ?? ad.clickUrl }) as GravityAdData, [ad]);
  // Gravity's links are `target="_blank"` anchors, and the desktop window opens no
  // windows: every click on the card opens Gravity's tracked link in the browser.
  const onClickCapture = (event: React.MouseEvent<HTMLElement>) => {
    const target = event.target as Element;
    if (target.closest(".ade-sponsored-gravity-hide")) return;
    event.preventDefault();
    event.stopPropagation();
    const href = target.closest("a[href]")?.getAttribute("href");
    const link = isGravityUrl(href) ? href : ad.clickUrl;
    if (isGravityUrl(link)) openExternalUrl(link);
  };
  return (
    <section
      ref={ref}
      className={`ade-sponsored-gravity ade-sponsored-gravity--${place}`}
      aria-label={`Sponsored: ${brand}`}
      style={theme}
      onClickCapture={onClickCapture}
      onAuxClickCapture={onClickCapture}
    >
      <Suspense fallback={null}>
        <GravityAd placement={place} ad={data} theme="auto" enableFrames={false} />
      </Suspense>
      <button type="button" className="ade-sponsored-gravity-hide" aria-label="Hide this sponsored card" title="Hide" onClick={onHide}>
        <X size={10} weight="bold" />
      </button>
    </section>
  );
}

/**
 * ADE's colors as the shadcn tokens Gravity's designs read
 * (`hsl(var(--card))`, `var(--radius)`): each an HSL triplet, with its alpha.
 * Read from the page's own variables, so every ADE theme gets its own card,
 * and read again when the theme changes.
 */
const TOKENS: ReadonlyArray<[string, string]> = [
  ["--background", "var(--color-bg, transparent)"],
  ["--foreground", "var(--color-fg)"],
  ["--card", "color-mix(in srgb, var(--color-fg) 2%, transparent)"],
  ["--card-foreground", "var(--color-fg)"],
  ["--muted", "color-mix(in srgb, var(--color-fg) 6%, transparent)"],
  ["--muted-foreground", "var(--kit-text-3)"],
  ["--accent", "color-mix(in srgb, var(--color-fg) 8%, transparent)"],
  ["--accent-foreground", "var(--color-fg)"],
  // The call to action stays as quiet as ADE's own buttons: a light fill, never an accent color.
  ["--primary", "color-mix(in srgb, var(--color-fg) 10%, transparent)"],
  ["--primary-foreground", "var(--color-fg)"],
  ["--border", "var(--kit-rule)"],
  ["--ring", "var(--adec-400)"],
];

function useGravityTheme(ref: React.RefObject<HTMLElement | null>): React.CSSProperties | undefined {
  const [theme, setTheme] = useState<React.CSSProperties>();
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return;
    const read = () => setTheme(readTheme(host));
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    if (document.body) observer.observe(document.body, { attributes: true, attributeFilter: ["data-theme", "class"] });
    return () => observer.disconnect();
  }, [ref]);
  return theme;
}

let canvas: CanvasRenderingContext2D | null | undefined;

function readTheme(host: HTMLElement): React.CSSProperties {
  const probe = document.createElement("span");
  probe.style.display = "none";
  host.appendChild(probe);
  const vars: Record<string, string> = { "--radius": "var(--radius-lg, 12px)" };
  try {
    for (const [name, value] of TOKENS) {
      probe.style.color = "";
      probe.style.color = value;
      const triplet = hslTriplet(getComputedStyle(probe).color);
      if (triplet) vars[name] = triplet;
    }
  } finally {
    probe.remove();
  }
  return vars as React.CSSProperties;
}

/**
 * A computed CSS color as `H S% L% / A`. `rgb()` and `color(srgb …)` (what
 * the browser computes `color-mix` to) are read exactly; any other syntax is
 * painted on a 1px canvas, which parses every color the browser knows.
 */
function hslTriplet(color: string): string | null {
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(color);
  const srgb = rgb ? null : /^color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(color);
  const match = rgb ?? srgb;
  if (match) {
    const scale = rgb ? 255 : 1;
    const alphaText = match[4];
    const alpha = alphaText === undefined ? 1 : alphaText.endsWith("%") ? Number.parseFloat(alphaText) / 100 : Number(alphaText);
    return tripletOf(Number(match[1]) / scale, Number(match[2]) / scale, Number(match[3]) / scale, alpha);
  }
  if (canvas === undefined) {
    const element = document.createElement("canvas");
    element.width = 1;
    element.height = 1;
    canvas = element.getContext("2d", { willReadFrequently: true });
  }
  if (!canvas || !color) return null;
  canvas.clearRect(0, 0, 1, 1);
  canvas.fillStyle = "#000";
  canvas.fillStyle = color;
  canvas.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, a = 0] = canvas.getImageData(0, 0, 1, 1).data;
  return tripletOf(r / 255, g / 255, b / 255, a / 255);
}

function tripletOf(r: number, g: number, b: number, alpha: number): string | null {
  if (![r, g, b, alpha].every(Number.isFinite)) return null;
  const [h, s, l] = rgbToHsl(clamp01(r), clamp01(g), clamp01(b));
  return `${h} ${s}% ${l}% / ${Math.round(clamp01(alpha) * 1000) / 1000}`;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, Math.round(l * 1000) / 10];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [Math.round(h * 60 * 10) / 10, Math.round(s * 1000) / 10, Math.round(l * 1000) / 10];
}

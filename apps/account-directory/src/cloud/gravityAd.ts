import { isGravityUrl, type CloudSponsoredAd, type CloudSponsoredGravityAd, type CloudSponsoredRenderer } from "./contract";

// Gravity's ad response as a card (`gravity.ts` asks, this module reads the
// answer): the checked links and copy, the design for Gravity's own
// renderer, and the advertiser's icon inlined for the desktop app.

export const httpsUrl = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
};
/** One of Gravity's own https links, or null: a card opens nothing else. */
export const gravityLink = (value: unknown): string | null => (isGravityUrl(value) ? httpsUrl(value) : null);
export const plainText = (value: unknown, max: number): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** One of Gravity's ads as a card, or null when it lacks what a card needs. */
export function adOfGravity(raw: unknown, test: boolean, renderer: CloudSponsoredRenderer | null): CloudSponsoredAd | null {
  if (!raw || typeof raw !== "object") return null;
  const ad = raw as Record<string, unknown>;
  const clickUrl = gravityLink(ad.clickUrl);
  const brand = plainText(ad.brandName, 80);
  const text = plainText(ad.adText, 300);
  if (!clickUrl || !brand || !text) return null;
  const impUrl = gravityLink(ad.impUrl);
  return {
    id: crypto.randomUUID(),
    brand,
    title: plainText(ad.title, 120) || brand,
    text,
    cta: plainText(ad.cta, 40) || null,
    clickUrl,
    impUrl,
    favicon: httpsUrl(ad.favicon),
    test,
    ...(renderer ? { gravity: gravityAdOf(ad, clickUrl, impUrl, renderer) } : {}),
  };
}

/** Gravity's designs are a few kilobytes; anything far past that is not one. */
const MAX_RENDERER_SPEC_CHARS = 32_000;
const optionalText = (value: unknown, max: number): string | undefined => plainText(value, max) || undefined;

/**
 * Gravity's ad for its own renderer: its design and copy, in its own field
 * names, with the links already checked. Only what ADE draws goes through: a
 * frame, a prompt action, an MCP connect or a data unit is left out (the
 * request asks for none), so the renderer falls back to the design.
 */
function gravityAdOf(ad: Record<string, unknown>, clickUrl: string, impUrl: string | null, renderer: CloudSponsoredRenderer): CloudSponsoredGravityAd {
  const render = ad.render && typeof ad.render === "object" ? ad.render as Record<string, unknown> : null;
  const mode = render?.mode === "spec" || render?.mode === "native" ? render.mode : null;
  let spec = typeof ad.renderer_spec === "string" ? (() => {
    try { return JSON.parse(ad.renderer_spec as string) as unknown; } catch { return null; }
  })() : ad.renderer_spec;
  if (!spec || typeof spec !== "object" || Array.isArray(spec) || JSON.stringify(spec).length > MAX_RENDERER_SPEC_CHARS) spec = null;
  const out: CloudSponsoredGravityAd = {
    adText: plainText(ad.adText, 300),
    clickUrl,
    ...(impUrl ? { impUrl } : {}),
    ...(mode ? { render: { mode, ...(typeof render?.layout === "string" ? { layout: render.layout.slice(0, 40) } : {}) } } : {}),
    ...(ad.hasDeeplink === true ? { hasDeeplink: true } : {}),
  };
  const texts: Array<[keyof CloudSponsoredGravityAd, number]> = [
    ["title", 120], ["cta", 40], ["brandName", 80], ["placement", 40], ["placement_id", 120], ["campaignId", 120],
    ["variant", 80], ["experiment_id", 120], ["composition_id", 120], ["renderer_key", 120],
  ];
  for (const [field, max] of texts) {
    const value = optionalText(ad[field], max);
    if (value) (out as Record<string, unknown>)[field] = value;
  }
  for (const field of ["url", "favicon", "brandImage"] as const) {
    const value = httpsUrl(ad[field]);
    if (value) out[field] = value;
  }
  if (spec && renderer === "psp1") {
    const design = spec as Record<string, unknown>;
    const fields = out as Record<string, unknown>;
    spec = { ...design, root: withRowSpacers(design.root, (node) => psp1Draws(node, fields)) };
  }
  if (spec) out.renderer_spec = spec as Record<string, unknown>;
  return out;
}

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** An empty, ungated `box` whose only style is `grow: 1`: a flexible gap, nothing drawn. */
function isGrowGap(node: unknown): boolean {
  if (!isObject(node) || node.type !== "box" || node.showIf !== undefined || (Array.isArray(node.children) && node.children.length > 0)) return false;
  const style = isObject(node.style) ? node.style : {};
  const keys = Object.keys(style);
  return keys.length === 1 && Number(style.grow) === 1;
}

/** The ad fields a PSP-1 design can bind (`SpecConstants.bindableFields` in Gravity's Swift SDK). */
const PSP1_FIELDS = new Set(["adText", "title", "cta", "brandName", "url", "favicon", "brandImage"]);

/**
 * Whether Gravity's Swift SDK draws a node for this ad (`SpecAdView`'s
 * `willRender`): a `showIf` field must be filled, text must resolve to
 * something (a `{field}` it can't fill becomes nothing), and an image needs
 * its link. The SDK leaves out children that draw nothing before it places
 * spacers, so a spacer on one of them would be lost.
 */
function psp1Draws(node: Record<string, unknown>, fields: Record<string, unknown>): boolean {
  const value = (name: unknown) => (typeof name === "string" && PSP1_FIELDS.has(name) && typeof fields[name] === "string" ? fields[name] as string : "");
  if (node.showIf !== undefined && !value(node.showIf)) return false;
  if (node.type === "box" || node.type === "link") return true;
  if (node.type === "image") return node.bind !== undefined ? Boolean(value(node.bind)) : typeof node.src === "string" && node.src.length > 0;
  if (node.type !== "text") return false;
  if (node.bind !== undefined) return Boolean(value(node.bind));
  return typeof node.text === "string" && node.text.replace(/\{([A-Za-z0-9_]+)\}/g, (_all, name: string) => value(name)).length > 0;
}

/**
 * A PSP-1 design with each flexible gap in a row turned into `spacerBefore`
 * on the next item the SDK draws for this ad: the same layout, PSP-1's own
 * way to push an item to the end. Gravity's Swift SDK (1.2.2) draws an empty
 * `grow` box as a frame that splits the row with the text beside it, so a
 * brand name wraps on a phone; it draws `spacerBefore` as a spacer. A gap
 * with nothing drawn after it, or a second gap before the same item, stays as
 * it is. Remove once the SDK is fixed.
 */
function withRowSpacers(node: unknown, draws: (node: Record<string, unknown>) => boolean): unknown {
  if (!isObject(node) || !Array.isArray(node.children)) return node;
  const inRow = !isObject(node.style) || node.style.direction !== "column";
  const children = node.children.map((child) => (inRow && isGrowGap(child) ? child : withRowSpacers(child, draws)));
  if (!inRow) return { ...node, children };
  const spaced = new Set<number>();
  const kept = new Set<number>();
  children.forEach((child, index) => {
    if (!isGrowGap(child)) return;
    const next = children.findIndex((item, at) => at > index && isObject(item) && !isGrowGap(item) && draws(item));
    if (next < 0 || spaced.has(next)) kept.add(index);
    else spaced.add(next);
  });
  return {
    ...node,
    children: children.flatMap((child, index) => {
      if (isGrowGap(child)) return kept.has(index) ? [child] : [];
      if (!spaced.has(index) || !isObject(child)) return [child];
      return [{ ...child, style: { ...(isObject(child.style) ? child.style : {}), spacerBefore: true } }];
    }),
  };
}

const FAVICON_MAX_BYTES = 24_000;
const FAVICON_TIMEOUT_MS = 1_500;
const FAVICON_TYPES = /^image\/(png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon)$/;

/**
 * The ad's icon as a `data:` image, for Gravity's web renderer: the desktop
 * app's page loads images only from hosts it lists (`rendererCsp.ts`), and an
 * advertiser's icon can be on any host. Null when it can't be read quickly
 * or isn't a small raster image; the design then draws without it.
 */
export async function inlineFavicon(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(FAVICON_TIMEOUT_MS),
      cf: { cacheTtl: 86_400, cacheEverything: true },
    } as RequestInit);
    const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!response.ok || !FAVICON_TYPES.test(type) || !response.body) return null;
    if (Number(response.headers.get("content-length") ?? 0) > FAVICON_MAX_BYTES) {
      await response.body.cancel();
      return null;
    }
    // Read only up to the cap: the advertiser's host decides how much it sends.
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > FAVICON_MAX_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    if (!size) return null;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return `data:${type};base64,${btoa(binary)}`;
  } catch {
    return null;
  }
}

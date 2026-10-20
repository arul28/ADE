/**
 * Shrinking a preset logo to an icon that can sync.
 *
 * A preset list reaches the account as one setting with a 16,000-character
 * cap, so a logo has to be a few KB. Logos are drawn at 26 px at most, so a
 * 64×64 WebP looks the same as the 256×256 PNG the cropper used to keep.
 */

import {
  DEFAULT_HARNESS_PRESET_LOGO,
  HARNESS_PRESET_LOGO_SYNC_MAX_BYTES,
  dataUrlByteLength,
  harnessPresetLogoTooLarge,
  type HarnessPreset,
  type HarnessPresetLogo,
} from "../../shared/harnessPresets";

const ATTEMPTS: ReadonlyArray<{ size: number; quality: number }> = [
  { size: 64, quality: 0.85 },
  { size: 64, quality: 0.6 },
  { size: 48, quality: 0.6 },
  { size: 32, quality: 0.5 },
];

async function loadImage(src: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = src;
  await image.decode();
  return image;
}

/**
 * The image as a data URL under the sync budget, or null when this renderer
 * cannot draw it (no 2D context, an undecodable image).
 */
export async function compactLogoDataUrl(src: string): Promise<string | null> {
  let image: HTMLImageElement;
  try {
    image = await loadImage(src);
  } catch {
    return null;
  }
  for (const { size, quality } of ATTEMPTS) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, 0, 0, size, size);
    let dataUrl: string;
    try {
      dataUrl = canvas.toDataURL("image/webp", quality);
    } catch {
      return null;
    }
    // A renderer without a WebP encoder answers with PNG; still fine if small.
    if (dataUrlByteLength(dataUrl) <= HARNESS_PRESET_LOGO_SYNC_MAX_BYTES) return dataUrl;
  }
  return null;
}

/** The logo as one that syncs; the ADE mark when the image cannot be shrunk. */
export async function compactHarnessPresetLogo(logo: HarnessPresetLogo): Promise<HarnessPresetLogo> {
  if (!harnessPresetLogoTooLarge(logo) || (logo.kind !== "upload" && logo.kind !== "generated")) return logo;
  const dataUrl = await compactLogoDataUrl(logo.dataUrl);
  return dataUrl ? { kind: logo.kind, dataUrl } : { ...DEFAULT_HARNESS_PRESET_LOGO };
}

/**
 * Shrinks every oversized logo in the saved list, in place in the store.
 *
 * For logos saved before uploads were shrunk, and for imports and lists pulled
 * from another machine running an older ADE. The shrink is async, so each
 * result lands only on a preset whose logo is still the one that was shrunk:
 * an edit made meanwhile wins.
 */
export async function compactStoredHarnessPresetLogos(store: {
  getState(): { harnessPresets: HarnessPreset[]; setHarnessPresets(presets: HarnessPreset[]): void };
}): Promise<void> {
  const oversized = store.getState().harnessPresets.filter((preset) => harnessPresetLogoTooLarge(preset.logo));
  if (!oversized.length) return;
  const shrunk = new Map<string, { from: HarnessPresetLogo; to: HarnessPresetLogo }>();
  for (const preset of oversized) {
    shrunk.set(preset.id, { from: preset.logo, to: await compactHarnessPresetLogo(preset.logo) });
  }
  const state = store.getState();
  let changed = false;
  const next = state.harnessPresets.map((preset) => {
    const entry = shrunk.get(preset.id);
    if (!entry || preset.logo !== entry.from) return preset;
    changed = true;
    return { ...preset, logo: entry.to };
  });
  if (changed) state.setHarnessPresets(next);
}

import { DEFAULT_CTO_AVATAR_LOOK, type CtoAvatarLook } from "../../../../shared/types/cto";
import { normalizeCtoAvatarLook, normalizeHexColor } from "../../../../shared/ctoAvatarLook";

/**
 * The ten body colours offered in Settings › Look, lower case like every stored colour.
 *
 * Mid-tone and fairly saturated on purpose: each one has to read as a filled
 * body on a near-black page and on a white one, and each one also becomes the
 * CTO page's accent. Graphite is the one quiet, dark choice (it gets white
 * eyes); every other colour gets ink eyes.
 */
export const CTO_AVATAR_SWATCHES: ReadonlyArray<{ name: string; color: string }> = [
  { name: "Periwinkle", color: "#7c9cff" },
  { name: "Glacier", color: "#46bdf0" },
  { name: "Mint", color: "#3ecf9c" },
  { name: "Pear", color: "#a8d35a" },
  { name: "Marigold", color: "#f4bf4f" },
  { name: "Tangerine", color: "#ff9150" },
  { name: "Watermelon", color: "#ff6b7e" },
  { name: "Bubblegum", color: "#f28ac9" },
  { name: "Grape", color: "#9a72ff" },
  { name: "Graphite", color: "#556079" },
];

/** Dark eyes on a light body. */
export const CTO_AVATAR_INK = "#161A2B";

export { normalizeHexColor };

/** A stored look, with anything unknown or malformed replaced by the default. */
export function resolveCtoAvatarLook(look: Partial<CtoAvatarLook> | null | undefined): CtoAvatarLook {
  return normalizeCtoAvatarLook(look) ?? DEFAULT_CTO_AVATAR_LOOK;
}

function relativeLuminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const channel = (shift: number) => {
    const c = ((value >> shift) & 0xff) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
}

/** Ink or white, whichever stands out more on the body colour. */
export function ctoAvatarEyeColor(bodyColor: string): string {
  const hex = normalizeHexColor(bodyColor) ?? DEFAULT_CTO_AVATAR_LOOK.color;
  const body = relativeLuminance(hex);
  const ink = relativeLuminance(CTO_AVATAR_INK);
  const againstInk = (body + 0.05) / (ink + 0.05);
  const againstWhite = 1.05 / (body + 0.05);
  return againstInk >= againstWhite ? CTO_AVATAR_INK : "#FFFFFF";
}

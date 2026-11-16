import {
  CTO_AVATAR_ENERGIES,
  CTO_AVATAR_EYES,
  CTO_AVATAR_SHAPES,
  DEFAULT_CTO_AVATAR_LOOK,
  type CtoAvatarLook,
} from "../../../../shared/types/cto";

/**
 * The ten body colours offered in Settings › Look.
 *
 * Mid-tone and fairly saturated on purpose: each one has to read as a filled
 * body on a near-black page and on a white one, and each one also becomes the
 * CTO page's accent. Graphite is the one quiet, dark choice (it gets white
 * eyes); every other colour gets ink eyes.
 */
export const CTO_AVATAR_SWATCHES: ReadonlyArray<{ name: string; color: string }> = [
  { name: "Periwinkle", color: "#7C9CFF" },
  { name: "Glacier", color: "#46BDF0" },
  { name: "Mint", color: "#3ECF9C" },
  { name: "Pear", color: "#A8D35A" },
  { name: "Marigold", color: "#F4BF4F" },
  { name: "Tangerine", color: "#FF9150" },
  { name: "Watermelon", color: "#FF6B7E" },
  { name: "Bubblegum", color: "#F28AC9" },
  { name: "Grape", color: "#9A72FF" },
  { name: "Graphite", color: "#556079" },
];

/** Dark eyes on a light body. */
export const CTO_AVATAR_INK = "#161A2B";

const HEX_COLOR = /^#?([0-9a-f]{6})$/i;

/** `#rrggbb` (lower case) for a six-digit hex with or without `#`, else null. */
export function normalizeHexColor(value: string | null | undefined): string | null {
  const match = HEX_COLOR.exec((value ?? "").trim());
  return match ? `#${match[1]!.toLowerCase()}` : null;
}

/** A stored look, with anything unknown or malformed replaced by the default. */
export function resolveCtoAvatarLook(look: Partial<CtoAvatarLook> | null | undefined): CtoAvatarLook {
  if (!look) return DEFAULT_CTO_AVATAR_LOOK;
  return {
    shape: (CTO_AVATAR_SHAPES as readonly string[]).includes(look.shape ?? "")
      ? look.shape!
      : DEFAULT_CTO_AVATAR_LOOK.shape,
    color: normalizeHexColor(look.color) ?? DEFAULT_CTO_AVATAR_LOOK.color,
    eyes: (CTO_AVATAR_EYES as readonly string[]).includes(look.eyes ?? "")
      ? look.eyes!
      : DEFAULT_CTO_AVATAR_LOOK.eyes,
    energy: (CTO_AVATAR_ENERGIES as readonly string[]).includes(look.energy ?? "")
      ? look.energy!
      : DEFAULT_CTO_AVATAR_LOOK.energy,
  };
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

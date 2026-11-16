import {
  CTO_AVATAR_ENERGIES,
  CTO_AVATAR_EYES,
  CTO_AVATAR_SHAPES,
  DEFAULT_CTO_AVATAR_LOOK,
  type CtoAvatarLook,
} from "./types/cto";

const HEX_COLOR = /^#?([0-9a-f]{6})$/i;

/** `#rrggbb` (lower case) for a six-digit hex with or without `#`, else null. */
export function normalizeHexColor(value: unknown): string | null {
  const match = typeof value === "string" ? HEX_COLOR.exec(value.trim()) : null;
  return match ? `#${match[1]!.toLowerCase()}` : null;
}

/**
 * The CTO's look, field by field; anything off the closed lists falls back to
 * the default's value, and the colour is lower case. Null when there is no
 * look at all. The runtime stores this and the renderer draws it.
 */
export function normalizeCtoAvatarLook(value: unknown): CtoAvatarLook | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const pick = <T extends string>(list: readonly T[], raw: unknown, fallback: T): T =>
    typeof raw === "string" && (list as readonly string[]).includes(raw) ? raw as T : fallback;
  return {
    shape: pick(CTO_AVATAR_SHAPES, source.shape, DEFAULT_CTO_AVATAR_LOOK.shape),
    color: normalizeHexColor(source.color) ?? DEFAULT_CTO_AVATAR_LOOK.color,
    eyes: pick(CTO_AVATAR_EYES, source.eyes, DEFAULT_CTO_AVATAR_LOOK.eyes),
    energy: pick(CTO_AVATAR_ENERGIES, source.energy, DEFAULT_CTO_AVATAR_LOOK.energy),
  };
}

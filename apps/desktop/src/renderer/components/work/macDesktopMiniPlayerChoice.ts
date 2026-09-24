import type { FloatingPlayerChoice } from "../shared/FloatingPlayer";

/**
 * Where the floating Mac Desktop sits and how wide it is, kept across restarts.
 *
 * One choice for the window, not one per lane or chat: it is a layout
 * preference, like the width of the tools pane. Pixels, not fractions — the
 * shared layout clamps the stored place into the column on every pass, so a
 * narrower window moves the player inside rather than losing the choice.
 *
 * Browser storage can be missing or throw (a locked-down profile, a test), so
 * every read and write is guarded and a failure means "never moved".
 */

export const MAC_DESKTOP_MINI_PLAYER_STORAGE_KEY = "ade.macDesktop.floatingPlayer.v1";

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function normalizeMacDesktopMiniPlayerChoice(value: unknown): FloatingPlayerChoice | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { width?: unknown; position?: unknown };
  const width = finite(candidate.width);
  const rawPosition = candidate.position && typeof candidate.position === "object"
    ? candidate.position as { x?: unknown; y?: unknown }
    : null;
  const x = finite(rawPosition?.x);
  const y = finite(rawPosition?.y);
  const choice: FloatingPlayerChoice = {
    width: width != null && width > 0 ? Math.round(width) : null,
    position: x != null && y != null ? { x: Math.round(x), y: Math.round(y) } : null,
  };
  return choice.width == null && choice.position == null ? null : choice;
}

export function readMacDesktopMiniPlayerChoice(): FloatingPlayerChoice | null {
  try {
    const raw = window.localStorage.getItem(MAC_DESKTOP_MINI_PLAYER_STORAGE_KEY);
    return raw ? normalizeMacDesktopMiniPlayerChoice(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function writeMacDesktopMiniPlayerChoice(choice: FloatingPlayerChoice): void {
  const normalized = normalizeMacDesktopMiniPlayerChoice(choice);
  try {
    if (normalized) {
      window.localStorage.setItem(MAC_DESKTOP_MINI_PLAYER_STORAGE_KEY, JSON.stringify(normalized));
    } else {
      window.localStorage.removeItem(MAC_DESKTOP_MINI_PLAYER_STORAGE_KEY);
    }
  } catch {
    // Not remembered; the player still moves for this session.
  }
}

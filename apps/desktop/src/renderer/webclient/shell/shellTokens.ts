// Single import surface for the web shell's visual tokens. These re-export the
// desktop's own lane design tokens so the browser chrome and launch surfaces
// resolve against the exact same `[data-theme]` CSS variables as the app it
// wraps — no separate palette to drift.
export {
  COLORS,
  SANS_FONT,
  MONO_FONT,
  cardStyle,
  recessedStyle,
  outlineButton,
  primaryButton,
  dangerButton,
} from "../../components/lanes/laneDesignTokens";

import type { SyncConnectionState } from "../sync";
import { COLORS } from "../../components/lanes/laneDesignTokens";

export type ConnectionTone = {
  label: string;
  color: string;
  /** True while the socket is live enough to keep the app interactive. */
  live: boolean;
  /** True when saved authorization is invalid and must be replaced. */
  fatal: boolean;
};

export function connectionTone(state: SyncConnectionState): ConnectionTone {
  switch (state) {
    case "connected":
      return { label: "Connected", color: COLORS.success, live: true, fatal: false };
    case "connecting":
    case "restoring":
    case "reconnecting":
      return { label: "Reconnecting", color: COLORS.warning, live: false, fatal: false };
    case "auth_failed":
      return { label: "Can't reach this Mac", color: COLORS.danger, live: false, fatal: true };
    case "error":
      return { label: "Can't reach this Mac", color: COLORS.danger, live: false, fatal: false };
    case "disconnected":
    case "idle":
    default:
      return { label: "Can't reach this Mac", color: COLORS.textMuted, live: false, fatal: false };
  }
}

// Single import surface for the web shell's visual tokens. These re-export the
// desktop's own lane design tokens so the browser chrome and pairing surfaces
// resolve against the exact same `[data-theme]` CSS variables as the app it
// wraps — no separate palette to drift.
export {
  COLORS,
  SANS_FONT,
  MONO_FONT,
  LABEL_STYLE,
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
  /** True when the state means pairing/auth is gone and we must re-pair. */
  fatal: boolean;
};

export function connectionTone(state: SyncConnectionState): ConnectionTone {
  switch (state) {
    case "connected":
      return { label: "Connected", color: COLORS.success, live: true, fatal: false };
    case "connecting":
      return { label: "Connecting", color: COLORS.warning, live: false, fatal: false };
    case "reconnecting":
      return { label: "Reconnecting", color: COLORS.warning, live: true, fatal: false };
    case "auth_failed":
      return { label: "Disconnected", color: COLORS.danger, live: false, fatal: true };
    case "error":
      return { label: "Connection error", color: COLORS.danger, live: false, fatal: false };
    case "disconnected":
    case "idle":
    default:
      return { label: "Offline", color: COLORS.textMuted, live: false, fatal: false };
  }
}

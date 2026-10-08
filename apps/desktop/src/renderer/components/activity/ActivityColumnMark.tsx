import React from "react";
import {
  CheckCircle,
  Circle,
  CircleDashed,
  PauseCircle,
  Warning,
} from "@phosphor-icons/react";

import type { ActivityColumn } from "./activityPresentation";

/**
 * The glyph for one Work-board column: a filled dot for Needs you, a dashed
 * circle for Working, a pause for Waiting, a check for Done. `failed` swaps the
 * Needs you dot for the warning triangle — the red mark a failed agent keeps
 * inside its column. The hue comes from the parent's `activity-tone-*` class.
 *
 * The Needs you dot is small and filled rather than a 13px outline: it is the
 * one state allowed to shout, and a filled dot at 9px reads as urgent where a
 * bigger outline reads as decoration.
 */
export function ActivityColumnMark({
  column,
  failed = false,
  size = 12,
}: {
  column: ActivityColumn;
  failed?: boolean;
  size?: number;
}) {
  switch (column) {
    case "needs_you":
      return failed
        ? <Warning size={size} weight="fill" aria-hidden className="shrink-0" />
        : <Circle size={Math.round(size * 0.7)} weight="fill" aria-hidden className="shrink-0" />;
    case "working":
      return <CircleDashed size={size} weight="bold" aria-hidden className="shrink-0" />;
    case "waiting":
      return <PauseCircle size={size} weight="regular" aria-hidden className="shrink-0" />;
    case "done":
      return <CheckCircle size={size} weight="bold" aria-hidden className="shrink-0" />;
  }
}

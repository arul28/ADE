import React from "react";
import {
  CheckCircle,
  Circle,
  CircleDashed,
  NotePencil,
  Warning,
} from "@phosphor-icons/react";

import {
  ACTIVITY_STATE_GLYPHS,
  type ActivityStateGroup,
} from "./activityPresentation";

/**
 * The renderer's half of the state glyph language: Phosphor icons for the glyph
 * identities `ACTIVITY_STATE_GLYPHS` names. The identities live in the table so
 * the notch and the iOS widget can mirror them without importing React; only
 * this file knows which icon set draws them.
 *
 * Sizes differ on purpose. `needs-you` is a small filled dot rather than a
 * 13px outline because it is the one state allowed to shout, and a filled dot
 * at 9px reads as urgent where a bigger outline just reads as decoration —
 * exactly the treatment `SessionStatusLabel` gives the same identity.
 */
export function ActivityStateGlyphMark({
  group,
  size = 12,
}: {
  group: ActivityStateGroup;
  size?: number;
}) {
  switch (ACTIVITY_STATE_GLYPHS[group].glyph) {
    case "needs-you":
      return <Circle size={Math.round(size * 0.7)} weight="fill" aria-hidden className="shrink-0" />;
    case "failed":
      return <Warning size={size} weight="fill" aria-hidden className="shrink-0" />;
    case "planning":
      return <NotePencil size={size} weight="bold" aria-hidden className="shrink-0" />;
    case "done":
      return <CheckCircle size={size} weight="bold" aria-hidden className="shrink-0" />;
    default:
      return <CircleDashed size={size} weight="bold" aria-hidden className="shrink-0" />;
  }
}

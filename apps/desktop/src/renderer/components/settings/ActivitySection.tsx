import React from "react";

import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import { SavedFlash } from "./primitives";
import {
  ActivitySettingsControls,
  useActivitySettings,
} from "./ActivitySettingsControls";

/**
 * The Activity settings tab. It owns nothing: every control, every string, and
 * every write comes from `ActivitySettingsControls`, which the gear in the
 * Activity popover and pane mounts too. That is the whole point — the two
 * surfaces cannot say different things about the same setting because they are
 * literally the same component.
 */
export function ActivitySection() {
  const model = useActivitySettings();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      {model.signedOut ? (
        <div
          style={{
            padding: 12,
            fontFamily: SANS_FONT,
            fontSize: 12,
            color: COLORS.textMuted,
            background: COLORS.recessedBg,
            border: `1px solid ${COLORS.borderMuted}`,
            borderRadius: 10,
          }}
        >
          Sign in to ADE to sync Activity across your machines. The notch settings
          below still apply to this Mac.
        </div>
      ) : null}

      {model.error ? (
        <div role="alert" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <SavedFlash state={{ kind: "error", message: model.error }} />
        </div>
      ) : model.saved ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <SavedFlash state={{ kind: "saved" }} />
        </div>
      ) : null}

      <ActivitySettingsControls variant="page" model={model} />
    </div>
  );
}

export default ActivitySection;

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
          {/*
            The second sentence is a promise about what still works while
            signed out, and it is only true where the notch exists: every other
            control below is disabled by `busy` (`loading || signedOut`), and
            the notch cards are disabled by `!notchSupported`. Off macOS that
            leaves nothing on this page that "still applies", so the sentence
            is dropped rather than reworded — a Windows user was being pointed
            at a section that is inert for them.
          */}
          {model.notchSupported
            ? "Sign in to ADE to sync Activity across your machines. The notch settings below still apply to this computer."
            : "Sign in to ADE to sync Activity across your machines."}
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

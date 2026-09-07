import React, { useEffect, useState } from "react";
import { LinkSimple } from "@phosphor-icons/react";

import type { BrowserLinkOpenMode } from "../../../shared/types";
import { COLORS, SANS_FONT, cardStyle } from "../lanes/laneDesignTokens";
import { modifierKeyLabel } from "../../lib/platform";
import { refreshLinkOpenMode, setLinkOpenMode } from "../../lib/openExternal";
import { SavedFlash, SettingsSegmented, useSavedFlash } from "./primitives";

const OPTIONS: ReadonlyArray<{ value: BrowserLinkOpenMode; label: string }> = [
  { value: "in-app", label: "In ADE" },
  { value: "external", label: "In system browser" },
];

/**
 * Where links clicked inside ADE open.
 *
 * Machine-local (`.ade/local.yaml`): which browser a link lands in is a
 * property of the machine you are sitting at, not of the repository, so this
 * never travels to a teammate.
 */
export function BrowserLinksSection() {
  const [mode, setMode] = useState<BrowserLinkOpenMode>("in-app");
  const [busy, setBusy] = useState(false);
  const flash = useSavedFlash();

  useEffect(() => {
    let cancelled = false;
    // Optional: the browser-mock and hosted-web renderers reach this component
    // without an Electron config bridge, and an unreadable preference should
    // show the default rather than throw during mount.
    window.ade?.projectConfig
      ?.get()
      .then((snapshot) => {
        if (cancelled) return;
        setMode(snapshot.effective.browser?.linkOpenMode ?? "in-app");
      })
      .catch(() => {
        // An unreadable config leaves the in-app default showing, which is what
        // the link router falls back to as well — the two stay in agreement.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleChange = async (next: BrowserLinkOpenMode) => {
    const previous = mode;
    setMode(next);
    setBusy(true);
    try {
      const snapshot = await window.ade.projectConfig.get();
      await window.ade.projectConfig.save({
        shared: snapshot.shared,
        local: {
          ...snapshot.local,
          browser: { ...(snapshot.local.browser ?? {}), linkOpenMode: next },
        },
      });
      // Push it into the link router now rather than waiting for a reload:
      // the next click has to obey the choice that was just made.
      setLinkOpenMode(next);
      void refreshLinkOpenMode(true);
      flash.flash();
    } catch (error) {
      setMode(previous);
      flash.fail(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  // Icon-led, like "Project files" and "ADE command" directly above it, rather
  // than a bare LINKS band over an unillustrated card: one setting does not
  // earn its own section heading, and the group label plus the card's own
  // padding is where the ~28px of dead space at the bottom of General came from.
  return (
    <section
      id="link-open-mode"
      data-settings-anchor="link-open-mode"
      style={{ ...cardStyle(), scrollMarginTop: 16 }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          <LinkSimple size={28} weight="duotone" style={{ color: COLORS.textSecondary, flexShrink: 0 }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
              Links
            </div>
            <div style={{ marginTop: 4, fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: "18px" }}>
              Where a link clicked inside ADE opens. {modifierKeyLabel}-click always uses your system
              browser; Shift-click always uses ADE's, which stays signed in across chats.
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <SavedFlash state={flash.state} />
          <SettingsSegmented
            ariaLabel="Open links"
            value={mode}
            onChange={(next) => {
              void handleChange(next);
            }}
            options={OPTIONS}
            disabled={busy}
          />
        </div>
      </div>
    </section>
  );
}

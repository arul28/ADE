import React, { useEffect, useState } from "react";

import type { BrowserLinkOpenMode } from "../../../shared/types";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import { modifierKeyLabel } from "../../lib/platform";
import { refreshLinkOpenMode, setLinkOpenMode } from "../../lib/openExternal";
import { SavedFlash, SettingsCard, SettingsGroup, SettingsSegmented, useSavedFlash } from "./primitives";

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

  return (
    <SettingsGroup title="Links">
      <SettingsCard
        anchor="link-open-mode"
        title="Open links"
        description={
          <span style={{ fontFamily: SANS_FONT, color: COLORS.textSecondary }}>
            ADE's browser keeps you signed in across chats. {modifierKeyLabel}-click always opens in
            your system browser, and Shift-click always opens in ADE.
          </span>
        }
        scope="machine"
        control={
          <SettingsSegmented
            ariaLabel="Open links"
            value={mode}
            onChange={(next) => {
              void handleChange(next);
            }}
            options={OPTIONS}
            disabled={busy}
          />
        }
      >
        <SavedFlash state={flash.state} />
      </SettingsCard>
    </SettingsGroup>
  );
}

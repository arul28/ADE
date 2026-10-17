import React, { useEffect, useState } from "react";
import { AppWindow, Check, Globe, type Icon } from "@phosphor-icons/react";

import type { BrowserLinkOpenMode } from "../../../shared/types";
import { modifierKeyLabel } from "../../lib/platform";
import { refreshLinkOpenMode, setLinkOpenMode } from "../../lib/openExternal";
import { ModernSection, SavedFlash, useSavedFlash } from "./primitives";

const OPTIONS: ReadonlyArray<{ value: BrowserLinkOpenMode; label: string; hint: string; icon: Icon }> = [
  { value: "in-app", label: "In ADE", hint: "A tab in the ADE browser, beside your work.", icon: AppWindow },
  { value: "external", label: "In system browser", hint: "Your default browser, outside ADE.", icon: Globe },
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
    <ModernSection
      group="Links"
      anchor="link-open-mode"
      title="Open links"
      hint={
        <>
          Where a link clicked inside ADE opens. {modifierKeyLabel}-click always uses your system
          browser; Shift-click always uses ADE&apos;s, which stays signed in across chats.
        </>
      }
      actions={<SavedFlash state={flash.state} />}
    >
      <div role="radiogroup" aria-label="Open links" className="ade-modern-choices" style={{ opacity: busy ? 0.7 : 1 }}>
        {OPTIONS.map((option) => {
          const active = option.value === mode;
          const OptionIcon = option.icon;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={busy}
              onClick={() => { if (!active) void handleChange(option.value); }}
              className="ade-ap-choice"
              data-active={active}
            >
              <span className="ade-modern-choice-body">
                <span className="ade-modern-choice-title">
                  <OptionIcon size={14} />
                  {option.label}
                  {active ? <Check size={12} weight="bold" className="ade-ap-check" /> : null}
                </span>
                <span className="ade-modern-choice-hint">{option.hint}</span>
              </span>
            </button>
          );
        })}
      </div>
    </ModernSection>
  );
}

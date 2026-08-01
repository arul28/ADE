import React, { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowSquareOut,
  BellRinging,
  Check,
  GearSix,
  WarningCircle,
} from "@phosphor-icons/react";

import { navigateToAppTarget } from "../../lib/openExternal";
import {
  ActivitySettingsControls,
  useActivitySettings,
} from "../settings/ActivitySettingsControls";
import "./Activity.css";

/**
 * The gear in the Activity header popover and pane.
 *
 * It replaces the old settings popover, whose three toggles sat behind a Save
 * button while the settings page saved instantly — the same preference,
 * two different contracts. Every row here comes from
 * `settings/ActivitySettingsControls`, mounted in its `popover` variant, and
 * every change saves the moment it is made. There is no Save button anywhere in
 * ADE settings; there is no longer one here either.
 */
export function ActivitySettingsPopover() {
  const model = useActivitySettings();
  const [open, setOpen] = useState(false);
  const reducedMotion = useReducedMotion() ?? false;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const restoreTriggerFocusRef = useRef(false);

  const dialogElement = () =>
    rootRef.current?.querySelector<HTMLElement>('[role="dialog"]') ?? null;

  const closePopover = (returnFocus: boolean) => {
    restoreTriggerFocusRef.current = returnFocus;
    setOpen(false);
  };

  // An account switch invalidates everything on screen, so the popover closes
  // rather than showing the previous account's choices under a new name.
  useEffect(() => {
    if (!model.accountOwnerId) return;
    restoreTriggerFocusRef.current = false;
    setOpen(false);
  }, [model.accountOwnerId]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closePopover(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Stopped here so the surrounding pane or popover does not also close:
        // one Escape, one layer.
        event.stopPropagation();
        closePopover(true);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (open) dialogElement()?.focus();
  }, [open]);

  // Keep Tab inside the popover while it is open; Escape and the Done button
  // are the ways out.
  const onDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const dialog = dialogElement();
    if (!dialog) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        "button, select, [href], input, [tabindex]:not([tabindex='-1'])",
      ),
    ).filter((element) => !element.hasAttribute("disabled"));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === dialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div ref={rootRef} className="activity-settings-wrap">
      <button
        ref={triggerRef}
        type="button"
        className="activity-settings-trigger"
        aria-label="Activity settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? closePopover(true) : setOpen(true))}
      >
        <GearSix size={14} weight={open ? "fill" : "regular"} />
      </button>
      <AnimatePresence
        onExitComplete={() => {
          if (!restoreTriggerFocusRef.current) return;
          restoreTriggerFocusRef.current = false;
          triggerRef.current?.focus();
        }}
      >
        {open ? (
          <motion.div
            className="activity-settings-popover"
            role="dialog"
            aria-label="Activity settings"
            tabIndex={-1}
            onKeyDown={onDialogKeyDown}
            initial={reducedMotion ? false : { opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -4, scale: 0.985 }}
            transition={{ duration: reducedMotion ? 0.1 : 0.18, ease: [0.2, 0.8, 0.2, 1] }}
          >
            <header>
              <div>
                <span className="activity-settings-heading-icon">
                  <BellRinging size={17} weight="duotone" />
                </span>
                <span>
                  <strong>Activity settings</strong>
                  <small>Account delivery and this Mac’s notch</small>
                </span>
              </div>
              <span className="activity-settings-account-badge">Account</span>
            </header>

            {model.loading ? (
              <div className="activity-settings-loading">
                <span />
                Loading your preferences…
              </div>
            ) : (
              <ActivitySettingsControls variant="popover" model={model} />
            )}

            {model.error ? (
              <div className="activity-settings-error" role="alert">
                <WarningCircle size={14} weight="fill" />
                <span>{model.error}</span>
              </div>
            ) : null}

            <section>
              {/*
                Routed through the app navigation bus rather than `useNavigate`:
                Activity mounts outside the router in tests and in the notch,
                and must not take a Router dependency.
              */}
              <button
                type="button"
                className="activity-settings-open-full"
                onClick={() => {
                  closePopover(true);
                  navigateToAppTarget({ kind: "settings", tab: "activity" });
                }}
              >
                All Activity settings
                <ArrowSquareOut size={13} weight="bold" />
              </button>
            </section>

            <footer>
              <span>
                {model.saved
                  ? <><Check size={13} weight="bold" /> Saved</>
                  : "Changes save as you make them"}
              </span>
              <button
                type="button"
                className="activity-filter-clear"
                onClick={() => closePopover(true)}
              >
                Done
              </button>
            </footer>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

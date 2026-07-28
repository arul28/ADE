import React, { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  BellRinging,
  Check,
  Confetti,
  DeviceMobile,
  GearSix,
  HourglassMedium,
  LockKey,
  Notches,
  SpeakerHigh,
  WarningCircle,
} from "@phosphor-icons/react";

import {
  DEFAULT_ATTENTION_PREFERENCES,
  type AttentionPreferences,
} from "../../../shared/types";
import {
  attentionNotchSettingsFromPreferences,
  normalizeAttentionPreferences,
  readAttentionNotchEnabled,
  writeAttentionNotchEnabled,
} from "./attentionNotchLocalSettings";
import { useAccountStatus } from "../../lib/account";

const DESKTOP_FIRST_OPTIONS = [
  { value: 0, label: "Immediately" },
  { value: 30, label: "After 30 seconds" },
  { value: 120, label: "After 2 minutes" },
  { value: 300, label: "After 5 minutes" },
] as const;

type ToggleRowProps = {
  icon: React.ElementType;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  badge?: string;
  onChange: (checked: boolean) => void;
};

function ToggleRow({
  icon: Icon,
  label,
  description,
  checked,
  disabled = false,
  badge,
  onChange,
}: ToggleRowProps) {
  return (
    <div className="attention-settings-row" data-disabled={disabled || undefined}>
      <span className="attention-settings-row-icon" aria-hidden>
        <Icon size={16} weight="duotone" />
      </span>
      <span className="attention-settings-row-copy">
        <span>
          <strong>{label}</strong>
          {badge ? <small>{badge}</small> : null}
        </span>
        <em>{description}</em>
      </span>
      <button
        type="button"
        role="switch"
        aria-label={label}
        aria-checked={checked}
        disabled={disabled}
        className="attention-settings-switch"
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
    </div>
  );
}

export function AttentionSettingsPopover() {
  const { status: accountStatus } = useAccountStatus();
  const accountOwnerId = accountStatus.signedIn ? accountStatus.userId : null;
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preferences, setPreferences] =
    useState<AttentionPreferences>(DEFAULT_ATTENTION_PREFERENCES);
  const [notchEnabled, setNotchEnabled] = useState(readAttentionNotchEnabled);
  const reducedMotion = useReducedMotion() ?? false;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const restoreTriggerFocusRef = useRef(false);
  const accountOwnerRef = useRef(accountOwnerId);
  const previousAccountOwnerRef = useRef(accountOwnerId);
  const accountEffectMountedRef = useRef(false);
  const requestGenerationRef = useRef(0);
  accountOwnerRef.current = accountOwnerId;
  if (previousAccountOwnerRef.current !== accountOwnerId) {
    previousAccountOwnerRef.current = accountOwnerId;
    requestGenerationRef.current += 1;
  }

  const dialogElement = () =>
    rootRef.current?.querySelector<HTMLElement>('[role="dialog"]') ?? null;

  const closePopover = (returnFocus: boolean) => {
    requestGenerationRef.current += 1;
    restoreTriggerFocusRef.current = returnFocus;
    setOpen(false);
  };

  useEffect(() => {
    if (!accountEffectMountedRef.current) {
      accountEffectMountedRef.current = true;
      return;
    }
    restoreTriggerFocusRef.current = false;
    setOpen(false);
    setLoading(false);
    setSaving(false);
    setSaved(false);
    setError(null);
    setPreferences(DEFAULT_ATTENTION_PREFERENCES);
  }, [accountOwnerId]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closePopover(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePopover(true);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Land focus in the dialog on open so the whole panel is reachable without
  // tabbing back through the page behind it.
  useEffect(() => {
    if (open) dialogElement()?.focus();
  }, [open]);

  // Keep Tab inside the popover while it is open; Escape and the footer
  // buttons are the ways out.
  const onDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const dialog = dialogElement();
    if (!dialog) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>("button, select, [href], input, [tabindex]:not([tabindex='-1'])"),
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

  const openSettings = () => {
    if (open) {
      closePopover(true);
      return;
    }
    setOpen(true);
    setLoading(true);
    setError(null);
    setSaved(false);
    setNotchEnabled(readAttentionNotchEnabled());
    const ownerId = accountOwnerId;
    const generation = requestGenerationRef.current + 1;
    requestGenerationRef.current = generation;
    const isCurrentRequest = () =>
      requestGenerationRef.current === generation
      && accountOwnerRef.current === ownerId;
    const api = window.ade?.attention;
    if (!api || !ownerId) {
      setError("Attention settings are unavailable in this ADE session.");
      setLoading(false);
      return;
    }
    void api.getPreferences(ownerId)
      .then((nextPreferences) => {
        if (!isCurrentRequest()) return;
        setPreferences(normalizeAttentionPreferences(nextPreferences));
      })
      .catch((loadError: unknown) => {
        if (!isCurrentRequest()) return;
        setError(
          loadError instanceof Error && loadError.message.trim()
            ? loadError.message
            : "ADE couldn’t load your Attention settings.",
        );
      })
      .finally(() => {
        if (isCurrentRequest()) setLoading(false);
      });
  };

  const updateAccount = (
    patch: Partial<AttentionPreferences["account"]>,
  ) => {
    setSaved(false);
    setPreferences((current) => ({
      ...current,
      account: { ...current.account, ...patch },
    }));
  };

  const desktopFirstDelay = preferences.account.desktopFirstEnabled
    ? preferences.account.desktopFirstDelaySeconds
    : 0;

  const save = async () => {
    if (saving) return;
    const ownerId = accountOwnerId;
    const generation = requestGenerationRef.current;
    const isCurrentRequest = () =>
      requestGenerationRef.current === generation
      && accountOwnerRef.current === ownerId;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const api = window.ade?.attention;
      if (!api || !ownerId) {
        throw new Error("Attention settings are unavailable in this ADE session.");
      }
      await api.putPreferences(ownerId, preferences);
      if (!isCurrentRequest()) return;
      writeAttentionNotchEnabled(notchEnabled);
      await window.ade?.attentionNotch?.updateSettings(
        attentionNotchSettingsFromPreferences(preferences, notchEnabled),
      );
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1_800);
    } catch (saveError) {
      if (!isCurrentRequest()) return;
      setError(
        saveError instanceof Error && saveError.message.trim()
          ? saveError.message
          : "ADE couldn’t save your Attention settings.",
      );
    } finally {
      if (isCurrentRequest()) setSaving(false);
    }
  };

  return (
    <div ref={rootRef} className="attention-settings-wrap">
      <button
        ref={triggerRef}
        type="button"
        className="attention-settings-trigger"
        aria-label="Attention settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={openSettings}
      >
        <GearSix size={15} weight={open ? "fill" : "regular"} />
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
            className="attention-settings-popover"
            role="dialog"
            aria-label="Attention settings"
            tabIndex={-1}
            onKeyDown={onDialogKeyDown}
            initial={reducedMotion ? false : { opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -4, scale: 0.985 }}
            transition={{ duration: reducedMotion ? 0.1 : 0.18, ease: [0.2, 0.8, 0.2, 1] }}
          >
            <header>
              <div>
                <span className="attention-settings-heading-icon">
                  <BellRinging size={17} weight="duotone" />
                </span>
                <span>
                  <strong>Attention settings</strong>
                  <small>One policy across every project</small>
                </span>
              </div>
              <span className="attention-settings-account-badge">Account</span>
            </header>

            {loading ? (
              <div className="attention-settings-loading">
                <span />
                Loading your preferences…
              </div>
            ) : (
              <>
                <section>
                  <h3>Surfaces</h3>
                  <ToggleRow
                    icon={Notches}
                    label="ADE Notch"
                    description="Ambient agent status at the top of this display."
                    badge="This Mac"
                    checked={notchEnabled}
                    onChange={setNotchEnabled}
                  />
                  <ToggleRow
                    icon={BellRinging}
                    label="Phone notifications"
                    description="Send only events whose policy is set to notify."
                    checked={preferences.account.notificationsEnabled}
                    onChange={(notificationsEnabled) =>
                      updateAccount({ notificationsEnabled })}
                  />
                  <ToggleRow
                    icon={DeviceMobile}
                    label="Live Activities"
                    description="Show focused work on iPhone and Dynamic Island."
                    checked={preferences.account.liveActivitiesEnabled}
                    onChange={(liveActivitiesEnabled) =>
                      updateAccount({ liveActivitiesEnabled })}
                  />
                </section>

                <section>
                  <h3>Delivery</h3>
                  <label
                    className="attention-settings-delay"
                    data-disabled={!preferences.account.notificationsEnabled || undefined}
                  >
                    <span className="attention-settings-row-icon" aria-hidden>
                      <HourglassMedium size={16} weight="duotone" />
                    </span>
                    <span className="attention-settings-row-copy">
                      <span><strong>Phone escalation</strong></span>
                      <em>How long an active desktop gets before your phone rings.</em>
                    </span>
                    <select
                      aria-label="Phone escalation"
                      value={desktopFirstDelay}
                      disabled={!preferences.account.notificationsEnabled}
                      onChange={(event) => {
                        const delay = Number(event.target.value);
                        updateAccount({
                          desktopFirstEnabled: delay > 0,
                          desktopFirstDelaySeconds: delay > 0 ? delay : 30,
                        });
                      }}
                    >
                      {DESKTOP_FIRST_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                  <ToggleRow
                    icon={SpeakerHigh}
                    label="Sounds"
                    description="Play restrained cues for events that need you."
                    checked={preferences.account.soundsEnabled}
                    onChange={(soundsEnabled) => updateAccount({ soundsEnabled })}
                  />
                  <ToggleRow
                    icon={Confetti}
                    label="Celebrations"
                    description="Use a brief flourish for meaningful completed work."
                    checked={preferences.account.celebrationsEnabled}
                    onChange={(celebrationsEnabled) =>
                      updateAccount({ celebrationsEnabled })}
                  />
                  <ToggleRow
                    icon={LockKey}
                    label="Hide previews"
                    description="Use private summaries on the notch and phone."
                    checked={preferences.account.hideDetails}
                    onChange={(hideDetails) => updateAccount({ hideDetails })}
                  />
                </section>
              </>
            )}

            {error ? (
              <div className="attention-settings-error" role="alert">
                <WarningCircle size={14} weight="fill" />
                <span>{error}</span>
              </div>
            ) : null}

            <footer>
              <span>
                {saved ? <><Check size={13} weight="bold" /> Saved</> : "Changes apply across ADE"}
              </span>
              <button type="button" onClick={() => closePopover(true)}>Cancel</button>
              <button
                type="button"
                className="attention-settings-save"
                disabled={loading || saving}
                onClick={() => void save()}
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </footer>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

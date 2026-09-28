import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  EyeSlash,
  NumberCircleOne,
  Confetti,
  DesktopTower,
  HourglassMedium,
  LockKey,
  Notches,
  SpeakerHigh,
  ArrowsOutSimple,
  CursorClick,
} from "@phosphor-icons/react";

import {
  DEFAULT_ATTENTION_PREFERENCES,
  type AttentionNotchRevealMode,
  type AttentionPreferences,
} from "../../../shared/types";
import { THIS_MACHINE_NAME } from "../../../shared/machineIdentity";
import {
  activityNotchSupported,
  activityNotchSettingsFromPreferences,
  activityPreferencesWithNotchPresentation,
  normalizeActivityPreferences,
  onActivityNotchSettingsChanged,
  readActivityNotchEnabled,
  resolveActivityNotchPresentation,
  writeActivityNotchEnabled,
  writeActivityNotchPresentation,
  type ActivityNotchPresentation,
} from "../activity/activityNotchLocalSettings";
import { useAccountStatus } from "../../lib/account";
import { supportsNativeNotch } from "../../lib/platform";
import { useActivityStore } from "../../state/activityStore";
import { SettingsPanel, SettingsRow, SettingsSection, SettingsSelect, SettingsToggle } from "./primitives";
import { COLORS } from "../lanes/laneDesignTokens";

/**
 * Every Activity setting, once.
 *
 * Two surfaces show these: the gear inside the Activity popover and pane, and
 * the Activity settings tab. Before this file they were two hand-maintained
 * lists that had already drifted — the popover could turn the notch on with a
 * Save button while the settings page saved instantly, and only one of them
 * knew about hide-previews. Both now mount this component, so a row can only
 * exist in one place: here.
 *
 * The variants differ in chrome, not in content or behaviour. `popover` renders
 * the compact icon rows the header uses and includes the quick toggles whose
 * canonical card lives on another tab; `page` renders `SettingsCard`s carrying
 * the anchors the settings manifest promises.
 */

/**
 * Two modes, and only two. There were three, and the difference between them
 * was never the one the names promised: "Compact + peek" and "Click only"
 * rendered the same flush strip while "Reveal on hover" revealed into the
 * bigger expanded rect, so choosing a REVEAL mode silently chose a LAYOUT too.
 * Both modes now show the identical compact strip and both open the full panel
 * on click; the only question left is whether the strip is always there.
 */
const REVEAL_OPTIONS: { value: AttentionNotchRevealMode; label: string }[] = [
  { value: "always", label: "Always show" },
  { value: "hover", label: "Show on hover" },
];

const ESCALATION_OPTIONS = [
  { value: "0", label: "Immediately" },
  { value: "30", label: "After 30 seconds" },
  { value: "120", label: "After 2 minutes" },
  { value: "300", label: "After 5 minutes" },
];

const DOCK_BADGE_SCOPE_OPTIONS: {
  value: AttentionPreferences["account"]["dockBadgeScope"];
  label: string;
}[] = [
  { value: "local", label: "This computer" },
  { value: "account", label: "All machines" },
];

const NOTCH_REVEAL_HELP: Record<AttentionNotchRevealMode, string> = {
  always: "Keep the compact strip on the menu bar. Click it for the full list.",
  hover: "Show the same strip when the pointer reaches the top edge.",
};

export type ActivityMachineOption = {
  machineKey: string;
  name: string;
  online: boolean;
};

export type ActivitySettingsModel = ReturnType<typeof useActivitySettings>;

/**
 * Load, hold, and persist every Activity preference. Both surfaces call this,
 * so "what does saving mean" has exactly one answer no matter which gear the
 * user reached for.
 */
export function useActivitySettings() {
  const { status: accountStatus } = useAccountStatus();
  const accountOwnerId = accountStatus.signedIn ? accountStatus.userId : null;
  const itemsById = useActivityStore((state) => state.itemsById);

  const [preferences, setPreferences] = useState<AttentionPreferences>(
    DEFAULT_ATTENTION_PREFERENCES,
  );
  const [notchEnabled, setNotchEnabled] = useState(() => readActivityNotchEnabled());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const mounted = useRef(true);
  const savedTimer = useRef<number | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (savedTimer.current != null) window.clearTimeout(savedTimer.current);
    };
  }, []);

  // The native context menu can change reveal mode behind the app's back.
  useEffect(() => onActivityNotchSettingsChanged((settings) => {
    setNotchEnabled(settings.enabled);
    setPreferences((current) => activityPreferencesWithNotchPresentation(current, {
      revealMode: settings.revealMode,
      expandedPanelEnabled: settings.expandedPanelEnabled,
    }));
  }), []);

  useEffect(() => {
    const api = typeof window !== "undefined" ? window.ade?.attention : null;
    if (!api || !accountOwnerId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void api.getPreferences(accountOwnerId)
      .then((next) => {
        if (cancelled || !mounted.current) return;
        setPreferences(normalizeActivityPreferences(next));
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (cancelled || !mounted.current) return;
        setError(loadError instanceof Error && loadError.message.trim()
          ? loadError.message
          : "ADE couldn’t load your Activity settings.");
      })
      .finally(() => {
        if (!cancelled && mounted.current) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [accountOwnerId]);

  const flashSaved = useCallback(() => {
    setSaved(true);
    if (savedTimer.current != null) window.clearTimeout(savedTimer.current);
    savedTimer.current = window.setTimeout(() => {
      if (mounted.current) setSaved(false);
    }, 1_600);
  }, []);

  /**
   * Persist an explicit next value. Instant-save controls fire before their own
   * state update commits, so reading component state here would save the value
   * the user just replaced.
   */
  const persist = useCallback(async (
    next: AttentionPreferences,
    nextNotchEnabled = notchEnabled,
  ) => {
    const api = typeof window !== "undefined" ? window.ade?.attention : null;
    if (!api || !accountOwnerId) {
      setError("Sign in to ADE to change Activity settings.");
      return;
    }
    try {
      await api.putPreferences(accountOwnerId, next);
      // localStorage stays the offline cache of record for notch presentation:
      // a signed-out or offline launch still opens the notch the way this Mac
      // last had it rather than snapping back to the shipped default.
      if (supportsNativeNotch && activityNotchSupported()) {
        const presentation = resolveActivityNotchPresentation(next);
        writeActivityNotchEnabled(nextNotchEnabled);
        writeActivityNotchPresentation(presentation);
        await window.ade?.attentionNotch?.updateSettings(
          activityNotchSettingsFromPreferences(next, nextNotchEnabled, presentation),
        );
      }
      if (!mounted.current) return;
      setError(null);
      flashSaved();
    } catch (saveError) {
      if (!mounted.current) return;
      setError(saveError instanceof Error && saveError.message.trim()
        ? saveError.message
        : "ADE couldn’t save your Activity settings.");
    }
  }, [accountOwnerId, flashSaved, notchEnabled]);

  const updateAccount = useCallback((patch: Partial<AttentionPreferences["account"]>) => {
    const next: AttentionPreferences = {
      ...preferences,
      account: { ...preferences.account, ...patch },
    };
    setPreferences(next);
    void persist(next);
  }, [persist, preferences]);

  const setNotchPresentation = useCallback((patch: Partial<ActivityNotchPresentation>) => {
    const next = activityPreferencesWithNotchPresentation(preferences, {
      ...resolveActivityNotchPresentation(preferences),
      ...patch,
    });
    setPreferences(next);
    void persist(next);
  }, [persist, preferences]);

  const toggleNotchEnabled = useCallback((enabled: boolean) => {
    setNotchEnabled(enabled);
    void persist(preferences, enabled);
  }, [persist, preferences]);

  /**
   * Muting a machine is per-machine, not per-account, so it goes through its
   * own relay route. It lives in the account scope's `machines` map because the
   * web client strips `devices` before saving — a per-device home would appear
   * to save on web and quietly not persist.
   */
  const setMachineMuted = useCallback(async (machineKey: string, muted: boolean) => {
    const notificationsEnabled = !muted;
    const next: AttentionPreferences = {
      ...preferences,
      machines: {
        ...preferences.machines,
        [machineKey]: { ...preferences.machines[machineKey], notificationsEnabled },
      },
    };
    setPreferences(next);
    const api = typeof window !== "undefined" ? window.ade?.attention : null;
    if (!api?.putMachinePreferences || !accountOwnerId) {
      setError("This ADE build can’t change per-machine notifications yet.");
      return;
    }
    try {
      await api.putMachinePreferences(accountOwnerId, machineKey, { notificationsEnabled });
      if (!mounted.current) return;
      setError(null);
      flashSaved();
    } catch (saveError) {
      if (!mounted.current) return;
      setPreferences(preferences);
      setError(saveError instanceof Error && saveError.message.trim()
        ? saveError.message
        : "ADE couldn’t change notifications for that machine.");
    }
  }, [accountOwnerId, flashSaved, preferences]);

  // The roster comes from the snapshot on screen, so it can only ever offer
  // machines the account actually has.
  const machines = useMemo<ActivityMachineOption[]>(() => {
    const byKey = new Map<string, ActivityMachineOption>();
    for (const item of Object.values(itemsById)) {
      const existing = byKey.get(item.machine.machineKey);
      if (existing) {
        existing.online = existing.online || item.machine.online;
        continue;
      }
      byKey.set(item.machine.machineKey, {
        machineKey: item.machine.machineKey,
        name: item.machine.name,
        online: item.machine.online,
      });
    }
    return [...byKey.values()].sort((left, right) => left.name.localeCompare(right.name));
  }, [itemsById]);

  const notchPresentation = resolveActivityNotchPresentation(preferences);

  return {
    accountOwnerId,
    signedOut: !accountOwnerId,
    loading,
    error,
    saved,
    preferences,
    account: preferences.account,
    machines,
    notchEnabled,
    notchPresentation,
    notchSupported: supportsNativeNotch && activityNotchSupported(),
    updateAccount,
    toggleNotchEnabled,
    setNotchPresentation,
    setMachineMuted,
    machineMuted: (machineKey: string) =>
      preferences.machines[machineKey]?.notificationsEnabled === false,
  };
}

function PopoverRow({
  icon: Icon,
  label,
  description,
  badge,
  disabled,
  control,
}: {
  icon: React.ElementType;
  label: string;
  description: string;
  badge?: string;
  disabled?: boolean;
  control: React.ReactNode;
}) {
  return (
    <div className="activity-settings-row" data-disabled={disabled || undefined}>
      <span className="activity-settings-row-icon" aria-hidden>
        <Icon size={16} weight="duotone" />
      </span>
      <span className="activity-settings-row-copy">
        <span>
          <strong>{label}</strong>
          {badge ? <small>{badge}</small> : null}
        </span>
        <em>{description}</em>
      </span>
      {control}
    </div>
  );
}

function PopoverSwitch({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      className="activity-settings-switch"
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

/**
 * The rows themselves. `variant` picks the chrome; the copy, the ordering, and
 * every `onChange` come from the one model above.
 */
export function ActivitySettingsControls({
  variant,
  model,
}: {
  variant: "popover" | "page";
  model: ActivitySettingsModel;
}) {
  const {
    account,
    loading,
    signedOut,
    machines,
    notchEnabled,
    notchPresentation,
    notchSupported,
    updateAccount,
    toggleNotchEnabled,
    setNotchPresentation,
    setMachineMuted,
    machineMuted,
  } = model;
  const busy = loading || signedOut;

  if (variant === "popover") {
    return (
      <>
        {notchSupported ? (
          <section>
            {/*
              These two are scope labels, not macOS prose: the page variant
              renders the very same notch row,
              and this component exists so the two surfaces cannot say different
              things about one setting. A badge reading "This Mac" beside a chip
              reading "This computer" would be two names for one machine. The
              surrounding section is macOS-only, but the *scope* is not a
              platform claim, so it follows `THIS_MACHINE_NAME`.
            */}
            <h3>{THIS_MACHINE_NAME}</h3>
            <PopoverRow
              icon={Notches}
              label="ADE notch"
              description="Ambient agent status at the top of this display."
              badge={THIS_MACHINE_NAME}
              control={
                <PopoverSwitch
                  label="ADE notch"
                  checked={notchEnabled}
                  onChange={toggleNotchEnabled}
                />
              }
            />
            <PopoverRow
              icon={CursorClick}
              label="Notch behavior"
              description={NOTCH_REVEAL_HELP[notchPresentation.revealMode]}
              disabled={!notchEnabled}
              control={
                <select
                  aria-label="Notch behavior"
                  value={notchPresentation.revealMode}
                  disabled={!notchEnabled}
                  onChange={(event) => setNotchPresentation({
                    revealMode: event.target.value as AttentionNotchRevealMode,
                  })}
                >
                  {REVEAL_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              }
            />
            <PopoverRow
              icon={ArrowsOutSimple}
              label="Expanded panel"
              description="Allow the notch to grow into a full list of sessions."
              disabled={!notchEnabled}
              control={
                <PopoverSwitch
                  label="Expanded panel"
                  checked={notchPresentation.expandedPanelEnabled}
                  disabled={!notchEnabled}
                  onChange={(expandedPanelEnabled) =>
                    setNotchPresentation({ expandedPanelEnabled })}
                />
              }
            />
            {/* No "Automatic reveal" row, and no "Live ticker" row. Flashing
                the strip when something needs you is what the notch IS, and the
                strip has no ticker to cycle: it is two wings of state-group
                counts plus a top signal. Both switches survived the surfaces
                they described, which made them settings that promised
                something and did nothing. */}
          </section>
        ) : null}

        <section>
          <h3>Account</h3>
          <PopoverRow
            icon={DesktopTower}
            label="Dock badge counts"
            description="Choose whether the dock badge counts this computer or your whole account."
            disabled={busy}
            control={
              <select
                aria-label="Dock badge counts"
                value={account.dockBadgeScope}
                disabled={busy}
                onChange={(event) => updateAccount({
                  dockBadgeScope: event.target.value as AttentionPreferences["account"]["dockBadgeScope"],
                })}
              >
                {DOCK_BADGE_SCOPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            }
          />
          <PopoverRow
            icon={Confetti}
            label="Celebrations"
            description="A brief flourish when meaningful work lands."
            disabled={busy}
            control={
              <PopoverSwitch
                label="Celebrations"
                checked={account.celebrationsEnabled}
                disabled={busy}
                onChange={(celebrationsEnabled) => updateAccount({ celebrationsEnabled })}
              />
            }
          />
          <PopoverRow
            icon={SpeakerHigh}
            label="Activity sounds"
            description="Restrained cues for events that need you."
            disabled={busy}
            control={
              <PopoverSwitch
                label="Activity sounds"
                checked={account.soundsEnabled}
                disabled={busy}
                onChange={(soundsEnabled) => updateAccount({ soundsEnabled })}
              />
            }
          />
          <PopoverRow
            icon={LockKey}
            label="Hide previews"
            description="Use private summaries instead of agent text on ambient surfaces."
            disabled={busy}
            control={
              <PopoverSwitch
                label="Hide previews"
                checked={account.hideDetails}
                disabled={busy}
                onChange={(hideDetails) => updateAccount({ hideDetails })}
              />
            }
          />
          <PopoverRow
            icon={HourglassMedium}
            label="Escalate to phone"
            description="How long an event waits on the desktop before your phone is used too."
            disabled={busy || !account.desktopFirstEnabled}
            control={
              <select
                aria-label="Escalate to phone"
                value={String(account.desktopFirstDelaySeconds)}
                disabled={busy || !account.desktopFirstEnabled}
                onChange={(event) => updateAccount({
                  desktopFirstDelaySeconds: Number(event.target.value),
                })}
              >
                {ESCALATION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            }
          />
        </section>

        {machines.length > 0 ? (
          <section>
            <h3>Machines</h3>
            <div className="activity-settings-machines">
              {machines.map((machine) => (
                <PopoverRow
                  key={machine.machineKey}
                  icon={DesktopTower}
                  label={machine.name}
                  description={
                    machineMuted(machine.machineKey)
                      ? "Visible in Activity; never notifies."
                      : machine.online
                        ? "Online · notifies normally."
                        : "Offline · notifies when it reconnects."
                  }
                  control={
                    <PopoverSwitch
                      label={`Notify me about ${machine.name}`}
                      checked={!machineMuted(machine.machineKey)}
                      disabled={signedOut}
                      onChange={(enabled) =>
                        void setMachineMuted(machine.machineKey, !enabled)}
                    />
                  }
                />
              ))}
            </div>
          </section>
        ) : null}
      </>
    );
  }

  // The settings page composes the row sections below in its own layout.
  return (
    <>
      <ActivityNotchSection model={model} />
      <ActivityPrivacySection model={model} />
      <ActivityMachinesSection model={model} />
    </>
  );
}

/** The notch and its flourish. Rendered disabled, with the reason, off macOS. */
export function ActivityNotchSection({ model }: { model: ActivitySettingsModel }) {
  const { account, loading, signedOut, notchEnabled, notchPresentation, notchSupported, updateAccount, toggleNotchEnabled, setNotchPresentation } = model;
  const busy = loading || signedOut;
  const notchOff = !notchSupported || !notchEnabled;
  return (
    <SettingsSection title="Notch">
      <SettingsPanel>
        <SettingsRow
          anchor="activity-notch"
          icon={<Notches size={15} weight="duotone" />}
          tone="accent"
          title="ADE notch"
          description={
            notchSupported
              ? "A small HUD by the menu bar for work that needs you."
              : supportsNativeNotch
                ? "A macOS surface. Not available in the web client."
                : "A macOS surface. Not available on this computer."
          }
          control={
            <SettingsToggle
              label="ADE notch"
              checked={notchEnabled && notchSupported}
              disabled={!notchSupported}
              onChange={toggleNotchEnabled}
            />
          }
        />
        <SettingsRow
          anchor="activity-notch-reveal"
          icon={<CursorClick size={15} weight="duotone" />}
          tone="blue"
          title="Show the strip"
          description={NOTCH_REVEAL_HELP[notchPresentation.revealMode]}
          control={
            <SettingsSelect
              ariaLabel="Notch behavior"
              value={notchPresentation.revealMode}
              options={REVEAL_OPTIONS}
              disabled={notchOff}
              onChange={(revealMode) => setNotchPresentation({ revealMode })}
            />
          }
        />
        <SettingsRow
          anchor="activity-notch-expanded"
          icon={<ArrowsOutSimple size={15} weight="duotone" />}
          tone="teal"
          title="Expanded panel"
          description="Let the notch open into the full list of sessions."
          control={
            <SettingsToggle
              label="Expanded panel"
              checked={notchPresentation.expandedPanelEnabled}
              disabled={notchOff}
              onChange={(expandedPanelEnabled) => setNotchPresentation({ expandedPanelEnabled })}
            />
          }
        />
        <SettingsRow
          anchor="activity-celebrations"
          icon={<Confetti size={15} weight="duotone" />}
          tone="pink"
          title="Celebrations"
          description="A brief flourish when meaningful work lands."
          control={
            <SettingsToggle
              label="Celebrations"
              checked={account.celebrationsEnabled}
              disabled={busy}
              onChange={(celebrationsEnabled) => updateAccount({ celebrationsEnabled })}
            />
          }
        />
      </SettingsPanel>
    </SettingsSection>
  );
}

/** What Activity reveals, and what the Dock badge counts. */
export function ActivityPrivacySection({ model }: { model: ActivitySettingsModel }) {
  const { account, loading, signedOut, updateAccount } = model;
  const busy = loading || signedOut;
  return (
    <SettingsSection title="Privacy and badges">
      <SettingsPanel>
        <SettingsRow
          anchor="activity-hide-details"
          icon={<EyeSlash size={15} weight="duotone" />}
          tone="slate"
          title="Hide previews"
          description="Show private summaries, not agent text, on the notch, the phone, and the lock screen."
          control={
            <SettingsToggle
              label="Hide previews"
              checked={account.hideDetails}
              disabled={busy}
              onChange={(hideDetails) => updateAccount({ hideDetails })}
            />
          }
        />
        <SettingsRow
          anchor="activity-dock-badge"
          icon={<NumberCircleOne size={15} weight="duotone" />}
          tone="red"
          title="Dock badge counts"
          description="Work waiting on this computer, or on every machine."
          control={
            <SettingsSelect
              ariaLabel="Dock badge counts"
              value={account.dockBadgeScope}
              options={DOCK_BADGE_SCOPE_OPTIONS}
              disabled={busy}
              onChange={(dockBadgeScope) => updateAccount({ dockBadgeScope })}
            />
          }
        />
      </SettingsPanel>
    </SettingsSection>
  );
}

/** One switch per machine. Muted machines still show in Activity. */
export function ActivityMachinesSection({ model }: { model: ActivitySettingsModel }) {
  const { machines, signedOut, setMachineMuted, machineMuted } = model;
  return (
    <SettingsSection title="Machines">
      <SettingsPanel>
        <div id="activity-machines" data-settings-anchor="activity-machines" className="ade-settings-row-group">
          {machines.length === 0 ? (
            <SettingsRow title="No machines yet" description="Machines appear here once they report Activity." />
          ) : (
            machines.map((machine) => {
              const muted = machineMuted(machine.machineKey);
              return (
                <SettingsRow
                  key={machine.machineKey}
                  icon={<DesktopTower size={15} weight="duotone" />}
                  tone={machine.online ? "green" : "slate"}
                  title={machine.name}
                  description={
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <span
                        aria-hidden
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: 999,
                          background: machine.online ? COLORS.success : COLORS.textDim,
                        }}
                      />
                      {muted ? "Muted · still shown in Activity" : machine.online ? "Online" : "Offline"}
                    </span>
                  }
                  control={
                    <SettingsToggle
                      label={`Notify me about ${machine.name}`}
                      checked={!muted}
                      disabled={signedOut}
                      onChange={(enabled) => void setMachineMuted(machine.machineKey, !enabled)}
                    />
                  }
                />
              );
            })
          )}
        </div>
      </SettingsPanel>
    </SettingsSection>
  );
}

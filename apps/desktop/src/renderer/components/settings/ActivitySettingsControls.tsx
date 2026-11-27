import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  DesktopTower,
  DeviceMobile,
  DeviceTablet,
  HourglassMedium,
  LockKey,
  SpeakerHigh,
} from "@phosphor-icons/react";

import {
  DEFAULT_ATTENTION_PREFERENCES,
  upgradeAttentionEventPolicies,
  type AttentionAccountDevice,
  type AttentionPreferences,
} from "../../../shared/types";
import { ipcErrorMessage, relativeWhen } from "../../lib/format";
import { captureError } from "../../../shared/sentry/capture";
import { isMac } from "../../lib/platform";
import { useAccountStatus } from "../../lib/account";
import { useActivityStore } from "../../state/activityStore";
import { ModernRow, ModernRows, ModernSection, SettingsToggle } from "./primitives";
import { BRAND } from "../../../shared/brand";

/**
 * Every Activity setting, once.
 *
 * Two surfaces show these: the gear inside the Activity popover and pane, and
 * the Activity settings tab. Before this file they were two hand-maintained
 * lists that had already drifted — the popover saved with a Save button while
 * the settings page saved instantly, and only one of them knew about
 * hide-previews. Both now mount this component, so a row can only
 * exist in one place: here.
 *
 * The variants differ in chrome, not in content or behaviour. `popover` renders
 * the compact icon rows the header uses and includes the quick toggles whose
 * canonical card lives on another tab; `page` renders `SettingsCard`s carrying
 * the anchors the settings manifest promises.
 */

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

export type ActivityMachineOption = {
  machineKey: string;
  name: string;
  online: boolean;
};

export type ActivitySettingsModel = ReturnType<typeof useActivitySettings>;

/**
 * Account fields an older build may still carry. The notch that read them is
 * gone, so they are dropped on load and never saved back to the account.
 */
const RETIRED_ACCOUNT_PREFERENCE_KEYS = ["notchRevealMode", "notchExpandedPanel"] as const;

function normalizeActivityPreferences(
  preferences: AttentionPreferences,
): AttentionPreferences {
  const saved = upgradeAttentionEventPolicies(preferences.account ?? {});
  const account: AttentionPreferences["account"] & Record<string, unknown> = {
    ...DEFAULT_ATTENTION_PREFERENCES.account,
    ...saved,
    eventPolicies: {
      ...DEFAULT_ATTENTION_PREFERENCES.account.eventPolicies,
      ...saved.eventPolicies,
    },
    quietHours: {
      ...DEFAULT_ATTENTION_PREFERENCES.account.quietHours,
      ...saved.quietHours,
    },
  };
  for (const key of RETIRED_ACCOUNT_PREFERENCE_KEYS) delete account[key];
  return {
    ...DEFAULT_ATTENTION_PREFERENCES,
    ...preferences,
    account,
    devices: preferences.devices ?? {},
    machines: preferences.machines ?? {},
    projects: preferences.projects ?? {},
    mutedSessionIds: preferences.mutedSessionIds ?? [],
  };
}

/**
 * Load, hold, and persist every Activity preference. Both surfaces call this,
 * so "what does saving mean" has exactly one answer no matter which gear the
 * user reached for.
 */
export function useActivitySettings({ includeDevices = false }: { includeDevices?: boolean } = {}) {
  const { status: accountStatus } = useAccountStatus();
  const accountOwnerId = accountStatus.signedIn ? accountStatus.userId : null;
  const itemsById = useActivityStore((state) => state.itemsById);

  const [preferences, setPreferences] = useState<AttentionPreferences>(
    DEFAULT_ATTENTION_PREFERENCES,
  );
  const [loading, setLoading] = useState(true);
  // The account's real preferences never arrived. Every control is locked:
  // saving now would write the defaults above over them.
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveErrors, setSaveErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [saved, setSaved] = useState(false);
  const [loadedOwnerId, setLoadedOwnerId] = useState<string | null>(null);
  const [savingTargets, setSavingTargets] = useState<ReadonlySet<string>>(() => new Set());
  const accountScope = useRef({ ownerId: accountOwnerId, pending: new Set<string>() });
  useLayoutEffect(() => {
    accountScope.current = { ownerId: accountOwnerId, pending: new Set() };
    setSavingTargets(accountScope.current.pending);
    setSaved(false);
    setLoadError(null);
    setSaveErrors(new Map());
    setLoadedOwnerId(null);
  }, [accountOwnerId]);
  const mounted = useRef(true);
  const savedTimer = useRef<number | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (savedTimer.current != null) window.clearTimeout(savedTimer.current);
    };
  }, []);

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
        // `null`: the account service is unreachable right now.
        if (!next) {
          setLoadFailed(true);
          setLoadError(`${BRAND.NAME} can’t reach its account service right now, so your Activity settings didn’t load.`);
          return;
        }
        setPreferences(normalizeActivityPreferences(next));
        setLoadedOwnerId(accountOwnerId);
        setLoadFailed(false);
        setLoadError(null);
      })
      .catch((loadError: unknown) => {
        if (cancelled || !mounted.current) return;
        setLoadFailed(true);
        setLoadError(ipcErrorMessage(loadError)
          || `${BRAND.NAME} couldn’t load your Activity settings.`);
      })
      .finally(() => {
        if (!cancelled && mounted.current) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [accountOwnerId, loadAttempt]);

  // The account's phones. A host without the call lists none; a failed read
  // says so under Machines (with Retry), and every other setting still works.
  const [phoneLoadAttempt, setPhoneLoadAttempt] = useState(0);
  const [phoneRoster, setPhoneRoster] = useState<{
    ownerId: string;
    phones: AttentionAccountDevice[] | null;
  } | null>(null);
  const ownPhoneRoster = phoneRoster?.ownerId === accountOwnerId ? phoneRoster : null;
  const canReadDevices = includeDevices && typeof window !== "undefined" && Boolean(window.ade?.attention?.listDevices);
  useEffect(() => {
    setPhoneRoster(null);
    if (!canReadDevices || !accountOwnerId) return;
    const listDevices = window.ade.attention?.listDevices;
    if (!listDevices) return;
    let cancelled = false;
    void listDevices(accountOwnerId)
      .then((next) => {
        if (!cancelled && mounted.current) setPhoneRoster({ ownerId: accountOwnerId, phones: next });
      })
      .catch((listError: unknown) => {
        if (cancelled || !mounted.current) return;
        setPhoneRoster({ ownerId: accountOwnerId, phones: null });
        captureError(listError, { tags: { area: "activity_settings", step: "list_phones" }, fingerprint: ["activity_settings", "list_phones"] });
      });
    return () => { cancelled = true; };
  }, [accountOwnerId, canReadDevices, phoneLoadAttempt]);

  const retryLoad = useCallback(() => setLoadAttempt((attempt) => attempt + 1), []);
  const retryPhones = useCallback(() => setPhoneLoadAttempt((attempt) => attempt + 1), []);

  const flashSaved = useCallback(() => {
    setSaved(true);
    if (savedTimer.current != null) window.clearTimeout(savedTimer.current);
    savedTimer.current = window.setTimeout(() => {
      if (mounted.current) setSaved(false);
    }, 1_600);
  }, []);

  const setSaveError = useCallback((key: string, message: string | null) => {
    setSaveErrors((current) => {
      if (message == null && !current.has(key)) return current;
      const next = new Map(current);
      if (message == null) next.delete(key);
      else next.set(key, message);
      return next;
    });
  }, []);

  const updateAccount = useCallback(async (patch: Partial<AttentionPreferences["account"]>) => {
    const scope = accountScope.current;
    if (!accountOwnerId || loadFailed || loadedOwnerId !== accountOwnerId || scope.ownerId !== accountOwnerId || scope.pending.has("account")) return;
    const api = window.ade?.attention;
    if (!api) {
      setSaveError("account", `${BRAND.NAME} couldn’t save your Activity settings.`);
      return;
    }
    // The account endpoint replaces the whole account scope. Keep one save
    // in flight so a failed request can restore its last confirmed value.
    const previous = preferences.account;
    const account = { ...previous, ...patch };
    scope.pending.add("account");
    setSavingTargets(new Set(scope.pending));
    setPreferences((current) => ({ ...current, account }));
    try {
      await api.putPreferences(accountOwnerId, { ...preferences, account });
      if (!mounted.current || accountScope.current !== scope) return;
      setSaveError("account", null);
      flashSaved();
    } catch (saveError) {
      if (!mounted.current || accountScope.current !== scope) return;
      setPreferences((current) => ({ ...current, account: previous }));
      setSaveError("account", ipcErrorMessage(saveError)
        || `${BRAND.NAME} couldn’t save your Activity settings.`);
    } finally {
      scope.pending.delete("account");
      if (mounted.current && accountScope.current === scope) setSavingTargets(new Set(scope.pending));
    }
  }, [accountOwnerId, flashSaved, loadFailed, loadedOwnerId, preferences, setSaveError]);

  const setScopeNotificationsEnabled = useCallback(async (
    scope: "machines" | "devices",
    id: string,
    enabled: boolean,
  ) => {
    const account = accountScope.current;
    if (!accountOwnerId || loadedOwnerId !== accountOwnerId || loadFailed || account.ownerId !== accountOwnerId) return;
    const api = window.ade?.attention;
    const put = scope === "machines" ? api?.putMachinePreferences : api?.putDevicePreferences;
    const noun = scope === "machines" ? "machine" : "phone";
    const key = `${scope}:${id}`;
    if (!put) {
      setSaveError(key, `This ${BRAND.NAME} build can’t change per-${noun} notifications yet.`);
      return;
    }
    if (account.pending.has(key)) return;
    account.pending.add(key);
    setSavingTargets(new Set(account.pending));
    const patch = scope === "machines" ? { notificationsEnabled: enabled } : { deviceDeliveryEnabled: enabled };
    try {
      await put(accountOwnerId, id, patch);
      if (!mounted.current || accountScope.current !== account) return;
      setPreferences((current) => ({
        ...current,
        [scope]: { ...current[scope], [id]: { ...current[scope][id], ...patch } },
      }));
      setSaveError(key, null);
      flashSaved();
    } catch (saveError) {
      if (!mounted.current || accountScope.current !== account) return;
      setSaveError(key, ipcErrorMessage(saveError)
        || `${BRAND.NAME} couldn’t change notifications for that ${noun}.`);
    } finally {
      account.pending.delete(key);
      if (mounted.current && accountScope.current === account) setSavingTargets(new Set(account.pending));
    }
  }, [accountOwnerId, flashSaved, loadFailed, loadedOwnerId, setSaveError]);

  const setMachineMuted = useCallback(
    (machineKey: string, muted: boolean) => setScopeNotificationsEnabled("machines", machineKey, !muted),
    [setScopeNotificationsEnabled],
  );
  const setPhoneNotificationsEnabled = useCallback(
    (deviceId: string, enabled: boolean) => setScopeNotificationsEnabled("devices", deviceId, enabled),
    [setScopeNotificationsEnabled],
  );

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

  const busy = loading || !accountOwnerId || loadedOwnerId !== accountOwnerId || loadFailed;
  const error = loadError ?? saveErrors.get("account") ?? saveErrors.values().next().value ?? null;
  return {
    accountOwnerId,
    signedOut: !accountOwnerId,
    loading,
    loadFailed,
    retryLoad,
    retryPhones,
    /** Controls are read-only: loading, signed out, or the real values never arrived. */
    busy,
    accountBusy: busy || savingTargets.has("account"),
    savingTargets,
    error,
    saved: saved && error == null,
    preferences,
    account: preferences.account,
    machines,
    updateAccount,
    setMachineMuted,
    machineMuted: (machineKey: string) =>
      preferences.machines[machineKey]?.notificationsEnabled === false,
    phones: ownPhoneRoster?.phones ?? [],
    phonesFailed: ownPhoneRoster?.phones === null,
    phonesLoading: Boolean(accountOwnerId && canReadDevices && !ownPhoneRoster),
    setPhoneNotificationsEnabled,
    phoneNotificationsEnabled: (deviceId: string) =>
      preferences.devices[deviceId]?.deviceDeliveryEnabled !== false,
    phoneHasNotificationsEnabled: (deviceId: string) =>
      preferences.devices[deviceId]?.notificationsEnabled !== false,
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
    accountBusy: busy,
    machines,
    updateAccount,
    setMachineMuted,
    machineMuted,
  } = model;

  if (variant === "popover") {
    return (
      <>
        <section>
          <h3>Account</h3>
          <PopoverRow
            icon={DesktopTower}
            label={isMac ? "Dock badge counts" : "App badge counts"}
            description="Choose whether the app badge counts this computer or your whole account."
            disabled={busy}
            control={
              <select
                aria-label={isMac ? "Dock badge counts" : "App badge counts"}
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
                    model.loadFailed
                      ? "Notification setting didn’t load."
                      : machineMuted(machine.machineKey)
                      ? "Visible in Activity; never notifies."
                      : machine.online
                        ? "Online · notifies normally."
                        : "Offline · notifies when it reconnects."
                  }
                  control={
                    <PopoverSwitch
                      label={`Notify me about ${machine.name}`}
                      checked={!machineMuted(machine.machineKey)}
                      disabled={model.busy || model.savingTargets.has(`machines:${machine.machineKey}`)}
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
      <ActivityPrivacySection model={model} />
      <ActivityMachinesSection model={model} />
    </>
  );
}

/**
 * A two-or-three-way choice as a segmented control (`.kit-seg`), exposed as a
 * radio group under the same accessible name the old select carried.
 */
function SegmentedChoice<T extends string>({
  ariaLabel,
  value,
  options,
  disabled,
  onChange,
}: {
  ariaLabel: string;
  value: T;
  options: readonly { value: T; label: string }[];
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <div
      className="kit-seg"
      data-case="sentence"
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      style={disabled ? { opacity: 0.5 } : undefined}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            style={disabled ? { cursor: "not-allowed" } : undefined}
            onClick={() => { if (!active) onChange(option.value); }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** What Activity reveals, and what the Dock badge counts. */
export function ActivityPrivacySection({ model }: { model: ActivitySettingsModel }) {
  const { account, accountBusy: busy, updateAccount } = model;
  return (
    <ModernSection group="Privacy" title="Privacy and badges" hint="What ambient surfaces reveal, and what the badge counts.">
      <ModernRows>
        <ModernRow
          anchor="activity-hide-details"
          title="Hide previews"
          hint="Show private summaries, not agent text, on the phone and the lock screen."
          control={
            <SettingsToggle
              label="Hide previews"
              checked={account.hideDetails}
              disabled={busy}
              onChange={(hideDetails) => updateAccount({ hideDetails })}
            />
          }
        />
        <ModernRow
          anchor="activity-dock-badge"
          title={isMac ? "Dock badge counts" : "App badge counts"}
          hint="Work waiting on this computer, or on every machine."
          control={
            <SegmentedChoice
              ariaLabel={isMac ? "Dock badge counts" : "App badge counts"}
              value={account.dockBadgeScope}
              options={DOCK_BADGE_SCOPE_OPTIONS}
              disabled={busy}
              onChange={(dockBadgeScope) => updateAccount({ dockBadgeScope })}
            />
          }
        />
      </ModernRows>
    </ModernSection>
  );
}

function phoneName(phone: AttentionAccountDevice): string {
  return phone.name ?? (phone.kind === "tablet" ? "iPad" : "iPhone");
}

/** One computer or phone in the Machines list: its icon and name, a status line, and its switch. */
function NotificationTargetRow({
  icon: Icon,
  name,
  lit,
  hint,
  toggleLabel,
  checked,
  disabled,
  onChange,
}: {
  icon: React.ElementType;
  name: string;
  /** The status dot is lit: online and getting notifications. */
  lit: boolean;
  hint: string;
  toggleLabel: string;
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <ModernRow
      title={(
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Icon size={14} style={{ color: "var(--kit-text-3)" }} />
          {name}
        </span>
      )}
      hint={(
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span className="kit-dot" data-state={lit ? "ok" : undefined} aria-hidden />
          {hint}
        </span>
      )}
      control={<SettingsToggle label={toggleLabel} checked={checked} disabled={disabled} onChange={onChange} />}
    />
  );
}

/**
 * One switch per computer, then one per phone. A computer's switch is about
 * notifications that come from it; a phone's is about notifications sent to it.
 * Muted computers still show in Activity.
 */
export function ActivityMachinesSection({ model }: { model: ActivitySettingsModel }) {
  const {
    machines,
    phones,
    phonesFailed,
    phonesLoading,
    busy,
    account,
    setMachineMuted,
    machineMuted,
    setPhoneNotificationsEnabled,
    phoneNotificationsEnabled,
    phoneHasNotificationsEnabled,
  } = model;
  const phonesOff = !account.notificationsEnabled;
  return (
    <ModernSection
      group="Machines"
      anchor="activity-machines"
      title="Machines"
      hint="Mute a computer to stop notifications about it. Turn off a phone to stop sending notifications to it."
    >
      <ModernRows>
        {phonesLoading ? <ModernRow title="Loading notification devices…" /> : null}
        {!phonesLoading && !phonesFailed && machines.length === 0 && phones.length === 0 ? (
          <ModernRow title="No machines yet" hint="Machines appear here once they report Activity." />
        ) : null}
        {machines.map((machine) => {
          const muted = machineMuted(machine.machineKey);
          return (
            <NotificationTargetRow
              key={machine.machineKey}
              icon={DesktopTower}
              name={machine.name}
              lit={machine.online && !muted}
              hint={model.loadFailed
                ? "Notification setting didn’t load"
                : muted ? "Muted · still shown in Activity" : machine.online ? "Online" : "Offline"}
              toggleLabel={`Notify me about ${machine.name}`}
              checked={!muted}
              disabled={busy || model.savingTargets.has(`machines:${machine.machineKey}`)}
              onChange={(enabled) => void setMachineMuted(machine.machineKey, !enabled)}
            />
          );
        })}
        {phones.map((phone) => {
          const name = phoneName(phone);
          const enabled = phoneNotificationsEnabled(phone.deviceId);
          const deviceEnabled = phoneHasNotificationsEnabled(phone.deviceId);
          const lastSeen = phone.lastSeenAt ? ` · seen ${relativeWhen(phone.lastSeenAt)}` : "";
          return (
            <NotificationTargetRow
              key={phone.deviceId}
              icon={phone.kind === "tablet" ? DeviceTablet : DeviceMobile}
              name={name}
              lit={enabled && deviceEnabled && !phonesOff}
              hint={model.loadFailed
                ? "Notification setting didn’t load"
                : phonesOff
                  ? "Off · Phone notifications is off"
                  : !enabled
                    ? "Delivery muted for this device"
                    : deviceEnabled
                      ? `Delivery allowed${lastSeen}`
                      : `Notifications are off in ${BRAND.NAME} on this device`}
              toggleLabel={`Send notifications to ${name}`}
              checked={enabled && !phonesOff}
              disabled={busy || phonesOff || model.savingTargets.has(`devices:${phone.deviceId}`)}
              onChange={(next) => void setPhoneNotificationsEnabled(phone.deviceId, next)}
            />
          );
        })}
        {phonesFailed ? (
          <ModernRow
            icon={<DeviceMobile size={14} />}
            title="Couldn’t load your phones"
            hint={machines.length > 0 ? "Your computers above still work. Try again in a moment." : "Try again in a moment."}
            control={<button type="button" className="ade-modern-btn" onClick={model.retryPhones}>Retry</button>}
          />
        ) : null}
      </ModernRows>
    </ModernSection>
  );
}

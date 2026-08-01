import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_ATTENTION_PREFERENCES,
  type AttentionDeliveryPolicy,
  type AttentionEventKind,
  type AttentionPreferences,
} from "../../../shared/types/attention";
import { ACTIVITY_EVENT_CATALOG } from "../../../shared/activityCatalog";
import {
  attentionNotchSettingsFromPreferences,
  normalizeAttentionPreferences,
  readAttentionNotchEnabled,
  readAttentionNotchPresentation,
  writeAttentionNotchEnabled,
  writeAttentionNotchPresentation,
  type AttentionNotchPresentation,
} from "../attention/attentionNotchLocalSettings";
import { useAccountStatus } from "../../lib/account";
import { DEFAULT_LANE_BANNER_BUDGET } from "../../../shared/types/config";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import {
  SavedFlash,
  SettingsCard,
  SettingsGroup,
  SettingsNumber,
  SettingsSegmented,
  SettingsSelect,
  SettingsToggle,
  useSavedFlash,
} from "./primitives";
import { AgentCompletionSoundSection } from "./AgentCompletionSoundSection";

/**
 * Notifications & Sound.
 *
 * The delivery model (`AttentionPreferences`) already existed and already had
 * balanced defaults, but only a subset of it was reachable — through a popover
 * in the header, behind a Save button. The per-event policies and quiet hours
 * had no UI at all despite being fully modelled and honored.
 *
 * This section is the canonical home for that model. The popover stays as a
 * quick toggle; both write through `window.ade.attention.putPreferences`.
 */

/** The events worth giving a user a dial for, in the order they'll scan them. */
const EVENT_ROWS: readonly {
  kind: AttentionEventKind;
  label: string;
  description: string;
}[] = ACTIVITY_EVENT_CATALOG.map(({ kind, label, description }) => ({
  kind,
  label,
  description,
}));

const POLICY_OPTIONS: { value: AttentionDeliveryPolicy; label: string; hint: string }[] = [
  { value: "off", label: "Off", hint: "Don't track" },
  { value: "ambient", label: "Ambient", hint: "In the list only" },
  { value: "notify", label: "Notify", hint: "Interrupt me" },
];

const ESCALATION_OPTIONS = [
  { value: "0", label: "Immediately" },
  { value: "30", label: "After 30 seconds" },
  { value: "120", label: "After 2 minutes" },
  { value: "300", label: "After 5 minutes" },
];

const REVEAL_OPTIONS: { value: AttentionNotchPresentation["revealMode"]; label: string }[] = [
  { value: "minimal", label: "Compact + peek" },
  { value: "hover", label: "Reveal on hover" },
  { value: "click", label: "Click only" },
];

function minutesToTimeValue(minute: number): string {
  const safe = ((Math.floor(minute) % 1440) + 1440) % 1440;
  const hours = String(Math.floor(safe / 60)).padStart(2, "0");
  const minutes = String(safe % 60).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function timeValueToMinutes(value: string, fallback: number): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return fallback;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return fallback;
  return ((hours * 60 + minutes) % 1440 + 1440) % 1440;
}

export function NotificationsSection() {
  const { status: accountStatus } = useAccountStatus();
  const accountOwnerId = accountStatus.signedIn ? accountStatus.userId : null;

  const [preferences, setPreferences] = useState<AttentionPreferences>(DEFAULT_ATTENTION_PREFERENCES);
  const [notchEnabled, setNotchEnabled] = useState(() => readAttentionNotchEnabled());
  const [notchPresentation, setNotchPresentation] = useState<AttentionNotchPresentation>(
    () => readAttentionNotchPresentation(),
  );
  const [loading, setLoading] = useState(true);
  const { state: saveState, flash, fail } = useSavedFlash();
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const api = window.ade?.attention;
    if (!api || !accountOwnerId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    void api.getPreferences(accountOwnerId)
      .then((next) => {
        if (cancelled || !mounted.current) return;
        setPreferences(normalizeAttentionPreferences(next));
      })
      .catch((error: unknown) => {
        if (cancelled || !mounted.current) return;
        fail(error instanceof Error ? error.message : "Couldn't load notification settings");
      })
      .finally(() => {
        if (!cancelled && mounted.current) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [accountOwnerId, fail]);

  /**
   * Persist an explicit next value. Instant-save controls fire before their own
   * state update commits, so reading component state here would save the
   * previous value.
   */
  const persist = useCallback(async (
    nextPreferences: AttentionPreferences,
    nextNotch?: { enabled?: boolean; presentation?: AttentionNotchPresentation },
  ) => {
    const api = window.ade?.attention;
    if (!api || !accountOwnerId) {
      fail("Sign in to change notification settings.");
      return;
    }
    try {
      await api.putPreferences(accountOwnerId, nextPreferences);
      // Notch presentation is deliberately machine-local: the delivery policy
      // syncs across devices, but where the HUD sits on *this* screen doesn't.
      const enabled = nextNotch?.enabled ?? notchEnabled;
      const presentation = nextNotch?.presentation ?? notchPresentation;
      writeAttentionNotchEnabled(enabled);
      writeAttentionNotchPresentation(presentation);
      await window.ade?.attentionNotch?.updateSettings(
        attentionNotchSettingsFromPreferences(nextPreferences, enabled, presentation),
      );
      if (!mounted.current) return;
      flash();
    } catch (error) {
      if (!mounted.current) return;
      fail(error instanceof Error ? error.message : String(error));
    }
  }, [accountOwnerId, notchEnabled, notchPresentation, flash, fail]);

  // Build the next value outside the state updater and save it explicitly.
  // Saving *inside* an updater would fire twice under StrictMode, which
  // double-writes preferences on every click in development.
  const applyPreferences = useCallback((next: AttentionPreferences) => {
    setPreferences(next);
    void persist(next);
  }, [persist]);

  const updateAccount = useCallback((patch: Partial<AttentionPreferences["account"]>) => {
    applyPreferences({ ...preferences, account: { ...preferences.account, ...patch } });
  }, [applyPreferences, preferences]);

  const setEventPolicy = useCallback((kind: AttentionEventKind, policy: AttentionDeliveryPolicy) => {
    applyPreferences({
      ...preferences,
      account: {
        ...preferences.account,
        eventPolicies: { ...preferences.account.eventPolicies, [kind]: policy },
      },
    });
  }, [applyPreferences, preferences]);

  const account = preferences.account;
  const notifyCount = useMemo(
    () => EVENT_ROWS.filter((row) => account.eventPolicies[row.kind] === "notify").length,
    [account.eventPolicies],
  );

  const signedOut = !accountOwnerId;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      {signedOut ? (
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
          Sign in to ADE to change how notifications are delivered. Sound and on-screen banners below still apply.
        </div>
      ) : null}

      <SettingsGroup
        title="What interrupts you"
        description={`${notifyCount} of ${EVENT_ROWS.length} events currently interrupt you.`}
      >
        <SettingsCard
          anchor="notification-events"
          title="Notify me about"
          description="Ambient events appear in the attention list without interrupting. Notify sends a real notification."
          scope="machine"
          stacked
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {EVENT_ROWS.map((row, index) => (
              <div
                key={row.kind}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 16,
                  padding: "8px 0",
                  borderTop: index === 0 ? "none" : `1px solid ${COLORS.borderMuted}`,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textPrimary }}>
                    {row.label}
                  </div>
                  <div style={{ marginTop: 2, fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted }}>
                    {row.description}
                  </div>
                </div>
                <SettingsSegmented
                  ariaLabel={row.label}
                  value={account.eventPolicies[row.kind] ?? "ambient"}
                  disabled={loading || signedOut}
                  onChange={(policy) => setEventPolicy(row.kind, policy)}
                  options={POLICY_OPTIONS}
                />
              </div>
            ))}
          </div>
        </SettingsCard>

        <SettingsCard
          anchor="focus-suppression"
          title="Stay quiet while ADE is focused"
          description="If you're already looking at ADE, hold notifications back and let the attention list carry it."
          control={
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <SavedFlash state={saveState} />
              <SettingsToggle
                label="Stay quiet while ADE is focused"
                checked={account.desktopFirstEnabled}
                disabled={loading || signedOut}
                onChange={(desktopFirstEnabled) => updateAccount({ desktopFirstEnabled })}
              />
            </div>
          }
        />

        <SettingsCard
          anchor="quiet-hours"
          title="Quiet hours"
          description="Everything drops to ambient during this window."
          scope="machine"
          control={
            <SettingsToggle
              label="Quiet hours"
              checked={account.quietHours.enabled}
              disabled={loading || signedOut}
              onChange={(enabled) => updateAccount({ quietHours: { ...account.quietHours, enabled } })}
            />
          }
        >
          {account.quietHours.enabled ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <QuietHourField
                label="From"
                value={account.quietHours.startMinute}
                disabled={loading || signedOut}
                onChange={(startMinute) => updateAccount({ quietHours: { ...account.quietHours, startMinute } })}
              />
              <QuietHourField
                label="To"
                value={account.quietHours.endMinute}
                disabled={loading || signedOut}
                onChange={(endMinute) => updateAccount({ quietHours: { ...account.quietHours, endMinute } })}
              />
            </div>
          ) : null}
        </SettingsCard>
      </SettingsGroup>

      <SettingsGroup title="Delivery">
        <SettingsCard
          anchor="phone-notifications"
          title="Phone notifications"
          description="Send notify-level events to the ADE app on your phone."
          control={
            <SettingsToggle
              label="Phone notifications"
              checked={account.notificationsEnabled}
              disabled={loading || signedOut}
              onChange={(notificationsEnabled) => updateAccount({ notificationsEnabled })}
            />
          }
        />
        <SettingsCard
          anchor="live-activities"
          title="Live Activities"
          description="Keep a running agent visible on your lock screen."
          control={
            <SettingsToggle
              label="Live Activities"
              checked={account.liveActivitiesEnabled}
              disabled={loading || signedOut}
              onChange={(liveActivitiesEnabled) => updateAccount({ liveActivitiesEnabled })}
            />
          }
        />
        <SettingsCard
          anchor="phone-escalation"
          title="Escalate to phone"
          description="How long an event waits on the desktop before your phone is used too."
          control={
            <SettingsSelect
              ariaLabel="Escalate to phone"
              value={String(account.desktopFirstDelaySeconds)}
              options={ESCALATION_OPTIONS}
              disabled={loading || signedOut || !account.desktopFirstEnabled}
              onChange={(value) => updateAccount({ desktopFirstDelaySeconds: Number(value) })}
            />
          }
        />
        <SettingsCard
          anchor="hide-previews"
          title="Hide previews"
          description="Use private summaries instead of message content on the notch and phone."
          control={
            <SettingsToggle
              label="Hide previews"
              checked={account.hideDetails}
              disabled={loading || signedOut}
              onChange={(hideDetails) => updateAccount({ hideDetails })}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Sound">
        <SettingsCard
          anchor="attention-sounds"
          title="Attention sounds"
          description="Restrained cues for events that need you."
          control={
            <SettingsToggle
              label="Attention sounds"
              checked={account.soundsEnabled}
              disabled={loading || signedOut}
              onChange={(soundsEnabled) => updateAccount({ soundsEnabled })}
            />
          }
        />
        <AgentCompletionSoundSection />
      </SettingsGroup>

      <SettingsGroup title="On-screen banners">
        <LaneBannerBudgetCard />
      </SettingsGroup>

      <SettingsGroup title="Attention notch">
        <SettingsCard
          anchor="attention-notch"
          title="ADE notch"
          description="A small HUD near the menu bar for work that needs you."
          scope="machine"
          showScopeChip
          control={
            <SettingsToggle
              label="ADE notch"
              checked={notchEnabled}
              onChange={(enabled) => {
                setNotchEnabled(enabled);
                void persist(preferences, { enabled });
              }}
            />
          }
        >
          {notchEnabled ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <span style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textPrimary }}>Behavior</span>
                <SettingsSelect
                  ariaLabel="Notch behavior"
                  value={notchPresentation.revealMode}
                  options={REVEAL_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                  onChange={(revealMode) => {
                    const presentation = { ...notchPresentation, revealMode };
                    setNotchPresentation(presentation);
                    void persist(preferences, { presentation });
                  }}
                />
              </div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <span style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textPrimary }}>Expanded panel</span>
                <SettingsToggle
                  label="Expanded panel"
                  checked={notchPresentation.expandedPanelEnabled}
                  onChange={(expandedPanelEnabled) => {
                    const presentation = { ...notchPresentation, expandedPanelEnabled };
                    setNotchPresentation(presentation);
                    void persist(preferences, { presentation });
                  }}
                />
              </div>
            </div>
          ) : null}
        </SettingsCard>

        <SettingsCard
          anchor="celebrations"
          title="Celebrations"
          description="A brief flourish when meaningful work lands."
          control={
            <SettingsToggle
              label="Celebrations"
              checked={account.celebrationsEnabled}
              disabled={loading || signedOut}
              onChange={(celebrationsEnabled) => updateAccount({ celebrationsEnabled })}
            />
          }
        />
      </SettingsGroup>
    </div>
  );
}

function QuietHourField({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  disabled?: boolean;
  onChange: (minute: number) => void;
}) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted }}>{label}</span>
      <input
        type="time"
        value={minutesToTimeValue(value)}
        disabled={disabled}
        onChange={(event) => onChange(timeValueToMinutes(event.target.value, value))}
        style={{
          height: 30,
          padding: "0 8px",
          fontFamily: SANS_FONT,
          fontSize: 12,
          color: COLORS.textPrimary,
          background: COLORS.recessedBg,
          border: `1px solid ${COLORS.outlineBorder}`,
          borderRadius: 8,
        }}
      />
    </label>
  );
}

/**
 * The Lanes header banner budget. Project-scoped rather than account-scoped,
 * so it lives in project config alongside the rebase display mode it caps.
 */
function LaneBannerBudgetCard() {
  const [budget, setBudget] = useState(DEFAULT_LANE_BANNER_BUDGET);
  const { state, flash, fail } = useSavedFlash();
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    void window.ade.projectConfig.get()
      .then((snapshot) => {
        if (!mounted.current) return;
        const value = snapshot.effective.git?.laneBannerBudget;
        setBudget(typeof value === "number" && Number.isFinite(value)
          ? Math.max(0, Math.floor(value))
          : DEFAULT_LANE_BANNER_BUDGET);
      })
      .catch(() => {});
  }, []);

  const persist = useCallback(async (next: number) => {
    try {
      const snapshot = await window.ade.projectConfig.get();
      const currentGit = snapshot.local.git && typeof snapshot.local.git === "object"
        ? snapshot.local.git
        : {};
      await window.ade.projectConfig.save({
        shared: snapshot.shared,
        local: { ...snapshot.local, git: { ...currentGit, laneBannerBudget: next } },
      });
      if (mounted.current) flash();
    } catch (error) {
      if (mounted.current) fail(error instanceof Error ? error.message : String(error));
    }
  }, [flash, fail]);

  return (
    <SettingsCard
      anchor="lane-banner-budget"
      title="Lane banner budget"
      description="Most banners allowed above the lane list at once. Past this, they collapse to a single line instead of stacking."
      control={
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <SavedFlash state={state} />
          <SettingsNumber
            ariaLabel="Lane banner budget"
            value={budget}
            min={0}
            max={4}
            suffix={budget === 1 ? "banner" : "banners"}
            sentinelLabel="Always collapse"
            sentinelValue={0}
            onChange={(next) => {
              const clamped = Math.max(0, Math.min(4, Math.floor(next)));
              setBudget(clamped);
              void persist(clamped);
            }}
          />
        </div>
      }
    />
  );
}

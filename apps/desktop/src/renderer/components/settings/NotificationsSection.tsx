import React, { useMemo } from "react";
import {
    BellSimpleSlash,
  ChatCircleDots,
  CheckCircle,
  CircleDashed,
  DeviceMobile,
  Eye,
  GitMerge,
  GitPullRequest,
  Info,
  LockKey,
  MoonStars,
  PencilSimpleLine,
  Prohibit,
  ShieldWarning,
  SpeakerSimpleHigh,
  Timer,
  WarningCircle,
} from "@phosphor-icons/react";
import type { ActivityIconKey } from "../../../shared/activityCatalog";
import type { AttentionDeliveryPolicy, AttentionEventKind } from "../../../shared/types/attention";
import { ACTIVITY_EVENT_CATALOG, ACTIVITY_EVENT_GROUPS } from "../../../shared/activityCatalog";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import {
  SettingsColumn,
  SettingsPanel,
  SettingsRow,
  SettingsSection,
  SettingsSegmented,
  SettingsSelect,
  SettingsSplit,
  SettingsToggle,
  type SettingsTone,
} from "./primitives";
import { AgentCompletionSoundSection } from "./AgentCompletionSoundSection";
import {
  ActivityMachinesSection,
  ActivityNotchSection,
  ActivityPrivacySection,
  useActivitySettings,
} from "./ActivitySettingsControls";
import { AiFeaturesSection } from "./AiFeaturesSection";

/**
 * Notifications and Activity, on one page.
 *
 * They were two tabs about one thing — what ADE tells you about running work,
 * and where — and each held its own copy of the same preferences object, so a
 * change on one could be overwritten by a save from the other. The page now
 * reads and writes through one model (`useActivitySettings`), and lays the
 * sections out in pairs so a wide window is not half empty.
 */

const POLICY_OPTIONS: { value: AttentionDeliveryPolicy; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "ambient", label: "Activity" },
  { value: "notify", label: "Notify" },
];

/** The catalog names an icon per event; this is the glyph and hue for it. */
const EVENT_ICON: Record<ActivityIconKey, { Icon: React.ElementType; tone: SettingsTone }> = {
  working: { Icon: CircleDashed, tone: "blue" },
  "needs-you": { Icon: ChatCircleDots, tone: "amber" },
  failed: { Icon: WarningCircle, tone: "red" },
  done: { Icon: CheckCircle, tone: "green" },
  checks: { Icon: ShieldWarning, tone: "red" },
  review: { Icon: Eye, tone: "violet" },
  changes: { Icon: PencilSimpleLine, tone: "orange" },
  "merge-ready": { Icon: GitMerge, tone: "green" },
  "pull-request": { Icon: GitPullRequest, tone: "blue" },
  closed: { Icon: Prohibit, tone: "slate" },
};

const ICON = 15;

const ESCALATION_OPTIONS = [
  { value: "0", label: "Immediately" },
  { value: "30", label: "After 30 seconds" },
  { value: "120", label: "After 2 minutes" },
  { value: "300", label: "After 5 minutes" },
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
  const model = useActivitySettings();
  const { account, loading, signedOut, updateAccount } = model;
  const busy = loading || signedOut;

  const setEventPolicy = (kind: AttentionEventKind, policy: AttentionDeliveryPolicy) => {
    updateAccount({ eventPolicies: { ...account.eventPolicies, [kind]: policy } });
  };

  const notifyCount = useMemo(
    () => ACTIVITY_EVENT_CATALOG.filter((event) => account.eventPolicies[event.kind] === "notify").length,
    [account.eventPolicies],
  );

  const eventPanel = (group: (typeof ACTIVITY_EVENT_GROUPS)[number]) => (
    <SettingsPanel key={group.id}>
      <div className="ade-settings-panel-head">{group.label}</div>
      {ACTIVITY_EVENT_CATALOG.filter((event) => event.group === group.id).map((event) => {
        const { Icon, tone } = EVENT_ICON[event.iconKey];
        return (
          <SettingsRow
            key={event.kind}
            icon={<Icon size={ICON} weight="duotone" />}
            tone={tone}
            title={event.label}
            description={event.description}
            control={
              <SettingsSegmented
                ariaLabel={event.label}
                value={account.eventPolicies[event.kind] ?? "ambient"}
                disabled={busy}
                onChange={(policy) => setEventPolicy(event.kind, policy)}
                options={POLICY_OPTIONS}
              />
            }
          />
        );
      })}
    </SettingsPanel>
  );

  return (
    <SettingsColumn wide>
      {signedOut ? (
        <div className="ade-settings-note">
          <Info size={15} />
          {model.notchSupported
            ? "Sign in to sync these across your machines. Sound and the notch still apply here."
            : "Sign in to sync these across your machines. Sound still applies here."}
        </div>
      ) : null}
      {model.error ? (
        <div role="alert" className="ade-settings-note" style={{ color: COLORS.danger }}>
          <Info size={15} />
          {model.error}
        </div>
      ) : null}

      <div id="notification-events" data-settings-anchor="notification-events" style={{ scrollMarginTop: 16 }}>
        <SettingsSection
          title="Events"
          description="Activity lists an event quietly. Notify also interrupts you."
          actions={(
            <span className="ade-settings-summary" aria-live="polite">
              {model.saved ? (
                <>
                  <CheckCircle size={13} weight="fill" style={{ color: COLORS.success }} />
                  Saved
                </>
              ) : (
                `${notifyCount} of ${ACTIVITY_EVENT_CATALOG.length} notify`
              )}
            </span>
          )}
        >
          <SettingsSplit start={eventPanel(ACTIVITY_EVENT_GROUPS[0])} end={eventPanel(ACTIVITY_EVENT_GROUPS[1])} />
        </SettingsSection>
      </div>

      <SettingsSplit
        start={(
          <>
            <SettingsSection title="Delivery">
              <SettingsPanel>
                <SettingsRow
                  anchor="focus-suppression"
                  icon={<BellSimpleSlash size={ICON} weight="duotone" />}
                  tone="violet"
                  title="Quiet while ADE is focused"
                  description="If you are looking at ADE, Activity carries it instead."
                  control={
                    <SettingsToggle
                      label="Stay quiet while ADE is focused"
                      checked={account.desktopFirstEnabled}
                      disabled={busy}
                      onChange={(desktopFirstEnabled) => updateAccount({ desktopFirstEnabled })}
                    />
                  }
                />
                <SettingsRow
                  anchor="phone-escalation"
                  icon={<Timer size={ICON} weight="duotone" />}
                  tone="amber"
                  title="Escalate to phone"
                  description={
                    account.desktopFirstEnabled
                      ? "How long an event waits on the desktop before your phone gets it too."
                      : "Turn on “Quiet while ADE is focused” to delay the phone."
                  }
                  control={
                    <SettingsSelect
                      ariaLabel="Escalate to phone"
                      value={String(account.desktopFirstDelaySeconds)}
                      options={ESCALATION_OPTIONS}
                      disabled={busy || !account.desktopFirstEnabled}
                      onChange={(value) => updateAccount({ desktopFirstDelaySeconds: Number(value) })}
                    />
                  }
                />
                <SettingsRow
                  anchor="phone-notifications"
                  icon={<DeviceMobile size={ICON} weight="duotone" />}
                  tone="blue"
                  title="Phone notifications"
                  description="Send Notify events to the ADE app on your phone."
                  control={
                    <SettingsToggle
                      label="Phone notifications"
                      checked={account.notificationsEnabled}
                      disabled={busy}
                      onChange={(notificationsEnabled) => updateAccount({ notificationsEnabled })}
                    />
                  }
                />
                <SettingsRow
                  anchor="live-activities"
                  icon={<LockKey size={ICON} weight="duotone" />}
                  tone="teal"
                  title="Live Activities"
                  description="Keep a running agent on your lock screen."
                  control={
                    <SettingsToggle
                      label="Live Activities"
                      checked={account.liveActivitiesEnabled}
                      disabled={busy}
                      onChange={(liveActivitiesEnabled) => updateAccount({ liveActivitiesEnabled })}
                    />
                  }
                />
                <SettingsRow
                  anchor="quiet-hours"
                  icon={<MoonStars size={ICON} weight="duotone" />}
                  tone="violet"
                  title="Quiet hours"
                  description="Every event drops to Activity during this window."
                  control={(
                    <>
                      {account.quietHours.enabled ? (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                          <QuietHourField
                            label="From"
                            value={account.quietHours.startMinute}
                            disabled={busy}
                            onChange={(startMinute) => updateAccount({ quietHours: { ...account.quietHours, startMinute } })}
                          />
                          <span style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textDim }}>to</span>
                          <QuietHourField
                            label="To"
                            value={account.quietHours.endMinute}
                            disabled={busy}
                            onChange={(endMinute) => updateAccount({ quietHours: { ...account.quietHours, endMinute } })}
                          />
                        </span>
                      ) : null}
                      <SettingsToggle
                        label="Quiet hours"
                        checked={account.quietHours.enabled}
                        disabled={busy}
                        onChange={(enabled) => updateAccount({ quietHours: { ...account.quietHours, enabled } })}
                      />
                    </>
                  )}
                />
              </SettingsPanel>
            </SettingsSection>
            <ActivityNotchSection model={model} />
            <ActivityMachinesSection model={model} />
          </>
        )}
        end={(
          <>
            <SettingsSection title="Sound">
              <SettingsPanel>
                <AgentCompletionSoundSection />
                <SettingsRow
                  anchor="activity-sounds"
                  icon={<SpeakerSimpleHigh size={ICON} weight="duotone" />}
                  tone="teal"
                  title="Activity sounds"
                  description="Restrained cues for events that need you."
                  control={
                    <SettingsToggle
                      label="Activity sounds"
                      checked={account.soundsEnabled}
                      disabled={busy}
                      onChange={(soundsEnabled) => updateAccount({ soundsEnabled })}
                    />
                  }
                />
              </SettingsPanel>
            </SettingsSection>
            <ActivityPrivacySection model={model} />
            <AiFeaturesSection />
          </>
        )}
      />
    </SettingsColumn>
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
    <input
      type="time"
      aria-label={`Quiet hours ${label.toLowerCase()}`}
      value={minutesToTimeValue(value)}
      disabled={disabled}
      onChange={(event) => onChange(timeValueToMinutes(event.target.value, value))}
      className="ade-settings-time"
    />
  );
}

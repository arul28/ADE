import React, { useMemo } from "react";
import {
  ChatCircleDots,
  CheckCircle,
  CircleDashed,
  Eye,
  GitMerge,
  GitPullRequest,
  Info,
  PencilSimpleLine,
  Prohibit,
  ShieldWarning,
  WarningCircle,
} from "@phosphor-icons/react";
import type { ActivityIconKey } from "../../../shared/activityCatalog";
import type { AttentionDeliveryPolicy, AttentionEventKind } from "../../../shared/types/attention";
import { ACTIVITY_EVENT_CATALOG, ACTIVITY_EVENT_GROUPS } from "../../../shared/activityCatalog";
import {
  ModernPage,
  ModernRow,
  ModernRows,
  ModernSection,
  SettingsColumn,
  SettingsSelect,
  SettingsToggle,
} from "./primitives";
import { AgentCompletionSoundSection } from "./AgentCompletionSoundSection";
import {
  ActivityMachinesSection,
  ActivityPrivacySection,
  useActivitySettings,
} from "./ActivitySettingsControls";
import { AiFeaturesSection } from "./AiFeaturesSection";
import "./NotificationsSection.css";

/**
 * Notifications and Activity, on one page.
 *
 * They were two tabs about one thing — what ADE tells you about running work,
 * and where — and each held its own copy of the same preferences object, so a
 * change on one could be overwritten by a save from the other. The page now
 * reads and writes through one model (`useActivitySettings`). The events are
 * a matrix (event × delivery level); the rest sit in two columns of sections
 * so a wide window is not half empty.
 */

const POLICY_OPTIONS: { value: AttentionDeliveryPolicy; label: string; hint: string }[] = [
  { value: "off", label: "Off", hint: "Not shown anywhere" },
  { value: "ambient", label: "Activity", hint: "Listed quietly in Activity" },
  { value: "notify", label: "Notify", hint: "Listed, and interrupts you" },
];

type EventTone = "ok" | "warn" | "crit" | undefined;

/** The catalog names an icon per event; this is the glyph, and a status hue where the event is a status. */
const EVENT_ICON: Record<ActivityIconKey, { Icon: React.ElementType; tone: EventTone }> = {
  working: { Icon: CircleDashed, tone: undefined },
  "needs-you": { Icon: ChatCircleDots, tone: "warn" },
  failed: { Icon: WarningCircle, tone: "crit" },
  done: { Icon: CheckCircle, tone: "ok" },
  checks: { Icon: ShieldWarning, tone: "crit" },
  review: { Icon: Eye, tone: undefined },
  changes: { Icon: PencilSimpleLine, tone: "warn" },
  "merge-ready": { Icon: GitMerge, tone: "ok" },
  "pull-request": { Icon: GitPullRequest, tone: undefined },
  closed: { Icon: Prohibit, tone: undefined },
};

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

  /**
   * One group of events as a matrix: an event per row, a delivery level per
   * column. Each row's three cells are one radio group named for the event.
   */
  const eventMatrix = (group: (typeof ACTIVITY_EVENT_GROUPS)[number]) => (
    <div key={group.id} className="ade-nt-matrix">
      <div className="ade-nt-mhead" aria-hidden>
        <span className="kit-eyebrow">{group.label}</span>
        {POLICY_OPTIONS.map((option) => (
          <span key={option.value} className="kit-eyebrow" title={option.hint}>{option.label}</span>
        ))}
      </div>
      {ACTIVITY_EVENT_CATALOG.filter((event) => event.group === group.id).map((event) => {
        const { Icon, tone } = EVENT_ICON[event.iconKey];
        const value = account.eventPolicies[event.kind] ?? "ambient";
        return (
          <div key={event.kind} className="ade-nt-mrow">
            <div className="ade-nt-event">
              <span className="ade-nt-event-icon" data-tone={tone} aria-hidden>
                <Icon size={15} weight="duotone" />
              </span>
              <div className="ade-nt-event-copy">
                <div className="ade-nt-event-title">{event.label}</div>
                <div className="ade-nt-event-hint">{event.description}</div>
              </div>
            </div>
            <div role="radiogroup" aria-label={event.label} className="ade-nt-cells">
              {POLICY_OPTIONS.map((option) => {
                const active = option.value === value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    aria-label={option.label}
                    title={`${option.label} — ${option.hint}`}
                    data-level={option.value === "ambient" ? "activity" : option.value}
                    disabled={busy}
                    className="ade-nt-cell"
                    onClick={() => { if (!active) setEventPolicy(event.kind, option.value); }}
                  >
                    <span className="ade-nt-mark" />
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );

  return (
    <SettingsColumn wide>
      <ModernPage>
        {signedOut || model.error ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {signedOut ? (
              <div className="ade-nt-note">
                <Info size={15} />
                Sign in to sync these across your machines. Sound still applies here.
              </div>
            ) : null}
            {model.error ? (
              <div role="alert" className="ade-nt-note" data-tone="error">
                <Info size={15} />
                {model.error}
              </div>
            ) : null}
          </div>
        ) : null}

        <ModernSection
          group="Notifications"
          anchor="notification-events"
          title="Events"
          hint="Activity lists an event quietly. Notify also interrupts you."
          actions={(
            <span className="ade-nt-summary" aria-live="polite">
              {model.saved ? (
                <>
                  <CheckCircle size={13} weight="fill" style={{ color: "var(--kit-ok)" }} />
                  Saved
                </>
              ) : (
                <><b>{notifyCount}</b> of <b>{ACTIVITY_EVENT_CATALOG.length}</b> notify</>
              )}
            </span>
          )}
        >
          <div className="ade-nt-matrix-wrap">
            {ACTIVITY_EVENT_GROUPS.map((group) => eventMatrix(group))}
          </div>
        </ModernSection>

        <div className="ade-nt-columns">
          <div className="ade-nt-col">
            <ModernSection group="Notifications" title="Delivery" hint="Where Notify events reach you, and when they hold off.">
              <ModernRows>
                <ModernRow
                  anchor="focus-suppression"
                  title="Quiet while ADE is focused"
                  hint="If you are looking at ADE, Activity carries it instead."
                  control={
                    <SettingsToggle
                      label="Stay quiet while ADE is focused"
                      checked={account.desktopFirstEnabled}
                      disabled={busy}
                      onChange={(desktopFirstEnabled) => updateAccount({ desktopFirstEnabled })}
                    />
                  }
                />
                <ModernRow
                  anchor="phone-escalation"
                  title="Escalate to phone"
                  hint={
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
                <ModernRow
                  anchor="phone-notifications"
                  title="Phone notifications"
                  hint="Send Notify events to the ADE app on your phone."
                  control={
                    <SettingsToggle
                      label="Phone notifications"
                      checked={account.notificationsEnabled}
                      disabled={busy}
                      onChange={(notificationsEnabled) => updateAccount({ notificationsEnabled })}
                    />
                  }
                />
                <ModernRow
                  anchor="live-activities"
                  title="Live Activities"
                  hint="Keep a running agent on your lock screen."
                  control={
                    <SettingsToggle
                      label="Live Activities"
                      checked={account.liveActivitiesEnabled}
                      disabled={busy}
                      onChange={(liveActivitiesEnabled) => updateAccount({ liveActivitiesEnabled })}
                    />
                  }
                />
                <ModernRow
                  anchor="quiet-hours"
                  title="Quiet hours"
                  hint="Every event drops to Activity during this window."
                  control={(
                    <>
                      {account.quietHours.enabled ? (
                        <span className="ade-nt-quiet">
                          <QuietHourField
                            label="From"
                            value={account.quietHours.startMinute}
                            disabled={busy}
                            onChange={(startMinute) => updateAccount({ quietHours: { ...account.quietHours, startMinute } })}
                          />
                          <span>to</span>
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
              </ModernRows>
            </ModernSection>
            <ActivityMachinesSection model={model} />
          </div>
          <div className="ade-nt-col">
            <AgentCompletionSoundSection
              extraRows={(
                <ModernRow
                  anchor="activity-sounds"
                  title="Activity sounds"
                  hint="Restrained cues for events that need you."
                  control={
                    <SettingsToggle
                      label="Activity sounds"
                      checked={account.soundsEnabled}
                      disabled={busy}
                      onChange={(soundsEnabled) => updateAccount({ soundsEnabled })}
                    />
                  }
                />
              )}
            />
            <ActivityPrivacySection model={model} />
            <AiFeaturesSection />
          </div>
        </div>
      </ModernPage>
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

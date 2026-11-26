import React, { useEffect, useMemo, useState } from "react";
import {
  Bell,
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
  Target,
  WarningCircle,
  Wrench,
} from "@phosphor-icons/react";
import type { ActivityEventDescriptor, ActivityIconKey } from "../../../shared/activityCatalog";
import { attentionEventPolicy, localAttentionTimeZone } from "../../../shared/attention/attentionScope";
import {
  type AttentionDeliveryPolicy,
  type AttentionPolicyEventKind,
  type AttentionPreferenceScope,
} from "../../../shared/types/attention";
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
  SegmentedChoice,
  useActivitySettings,
  type ActivitySettingsModel,
  type NotificationScopeCollection,
} from "./ActivitySettingsControls";
import { AiFeaturesSection } from "./AiFeaturesSection";
import { ProjectSettingsNotice } from "./ProjectSettingsNotice";
import { isStandaloneSettings } from "./settingsManifest";
import { Banner } from "../ui/notice";
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
  message: { Icon: Bell, tone: undefined },
  goal: { Icon: Target, tone: "ok" },
  service: { Icon: Wrench, tone: "warn" },
};

/** Which settings the Events matrix shows: the account's, or one scope's overrides. */
type EventScope =
  | { collection: "account" }
  | { collection: NotificationScopeCollection; id: string };

type ScopeKind = "account" | NotificationScopeCollection;

const SCOPE_NOUN: Record<NotificationScopeCollection, string> = {
  projects: "project",
  machines: "computer",
  devices: "phone",
};

/**
 * The events a scope can change. A phone only gets what the relay pushes, so
 * events only a computer shows are left out; a notice about this computer
 * itself belongs to no project or machine.
 */
function eventsForScope(kind: ScopeKind): readonly ActivityEventDescriptor[] {
  if (kind === "account") return ACTIVITY_EVENT_CATALOG;
  if (kind === "devices") return ACTIVITY_EVENT_CATALOG.filter((event) => event.reach === "everywhere");
  return ACTIVITY_EVENT_CATALOG.filter((event) => event.scoped);
}

/** The scope's own settings, or undefined for the account. */
function scopeOverrides(
  model: ActivitySettingsModel,
  scope: EventScope,
): Partial<AttentionPreferenceScope> | undefined {
  return scope.collection === "account" ? undefined : model.preferences[scope.collection][scope.id];
}

/** Whether notifications are on in this scope (its own switch, not the account's). */
function scopeEnabled(overrides: Partial<AttentionPreferenceScope> | undefined, collection: NotificationScopeCollection): boolean {
  return collection === "devices"
    ? overrides?.deviceDeliveryEnabled !== false
    : overrides?.notificationsEnabled !== false;
}

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
  const model = useActivitySettings({ includeDevices: true });
  const { account, accountBusy: busy, signedOut, updateAccount } = model;
  const [scope, setScope] = useState<EventScope>({ collection: "account" });
  const localTimeZone = useMemo(() => localAttentionTimeZone(), []);

  // A scope whose project, computer or phone left the account falls back to Everywhere.
  // An account service that predates per-scope events offers none of them.
  const scoped = model.scopedEventsAvailable;
  const scopeTargets = useMemo(() => ({
    projects: scoped && model.projectScopesAvailable
      ? model.projects.map((project) => ({ value: project.projectId, label: project.name }))
      : [],
    machines: scoped ? model.machines.map((machine) => ({ value: machine.machineKey, label: machine.name })) : [],
    devices: scoped
      ? model.phones.map((phone) => ({
        value: phone.deviceId,
        label: phone.name ?? (phone.kind === "tablet" ? "iPad" : "iPhone"),
      }))
      : [],
  }), [scoped, model.machines, model.phones, model.projects, model.projectScopesAvailable]);
  useEffect(() => {
    if (scope.collection === "account") return;
    if (!scopeTargets[scope.collection].some((target) => target.value === scope.id)) {
      setScope({ collection: "account" });
    }
  }, [scope, scopeTargets]);

  const overrides = scopeOverrides(model, scope);
  const events = eventsForScope(scope.collection);
  const scopeKey = scope.collection === "account" ? "account" : `${scope.collection}:${scope.id}`;
  const scopeBusy = scope.collection === "account" ? busy : model.busy || model.savingTargets.has(scopeKey);
  const scopeOn = scope.collection === "account" ? true : scopeEnabled(overrides, scope.collection);

  /** What the event does in this scope, and whether that comes from Everywhere. */
  const eventValue = (kind: AttentionPolicyEventKind): { value: AttentionDeliveryPolicy; inherited: boolean } => {
    const own = overrides?.eventPolicies?.[kind];
    if (own) return { value: own, inherited: false };
    return { value: attentionEventPolicy(account, kind), inherited: scope.collection !== "account" };
  };

  const setEventPolicy = (kind: AttentionPolicyEventKind, policy: AttentionDeliveryPolicy | null) => {
    if (scope.collection === "account") {
      if (policy) updateAccount({ eventPolicies: { ...account.eventPolicies, [kind]: policy } });
      return;
    }
    void model.updateScope(scope.collection, scope.id, { eventPolicies: { [kind]: policy } });
  };

  const notifyCount = events.filter((event) => eventValue(event.kind).value === "notify").length;
  const overrideCount = Object.keys(overrides?.eventPolicies ?? {}).length;

  const scopeKinds: { value: ScopeKind; label: string }[] = [
    { value: "account", label: "Everywhere" },
    ...(scopeTargets.projects.length > 0 ? [{ value: "projects" as const, label: "Project" }] : []),
    ...(scopeTargets.machines.length > 0 ? [{ value: "machines" as const, label: "Computer" }] : []),
    ...(scopeTargets.devices.length > 0 ? [{ value: "devices" as const, label: "Phone" }] : []),
  ];

  const chooseScopeKind = (kind: ScopeKind) => {
    if (kind === "account") {
      setScope({ collection: "account" });
      return;
    }
    const first = scopeTargets[kind][0];
    if (first) setScope({ collection: kind, id: first.value });
  };

  const showScope = (collection: "machines" | "devices", id: string) => {
    setScope({ collection, id });
    document.getElementById("notification-events")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const scopeHint = scope.collection === "account"
    ? "Activity lists an event quietly. Notify also interrupts you."
    : scope.collection === "projects"
      ? "What this project's events do. Unchanged rows follow Everywhere."
      : scope.collection === "machines"
        ? "What events from this computer do. Unchanged rows follow Everywhere."
        : "What reaches this phone. Unchanged rows follow Everywhere.";

  /**
   * One group of events as a matrix: an event per row, a delivery level per
   * column. Each row's three cells are one radio group named for the event.
   * Inside a scope, a row that follows Everywhere shows its level faintly and
   * a changed row offers to follow Everywhere again.
   */
  const eventMatrix = (group: (typeof ACTIVITY_EVENT_GROUPS)[number]) => {
    const rows = events.filter((event) => event.group === group.id);
    if (rows.length === 0) return null;
    return (
      <div key={group.id} className="ade-nt-matrix" data-scope-off={!scopeOn || undefined}>
        <div className="ade-nt-mhead" aria-hidden>
          <span className="kit-eyebrow">{group.label}</span>
          {POLICY_OPTIONS.map((option) => (
            <span key={option.value} className="kit-eyebrow" title={option.hint}>{option.label}</span>
          ))}
        </div>
        {rows.map((event) => {
          const { Icon, tone } = EVENT_ICON[event.iconKey];
          const { value, inherited } = eventValue(event.kind);
          return (
            <div key={event.kind} className="ade-nt-mrow">
              <div className="ade-nt-event">
                <span className="ade-nt-event-icon" data-tone={tone} aria-hidden>
                  <Icon size={15} weight="duotone" />
                </span>
                <div className="ade-nt-event-copy">
                  <div className="ade-nt-event-title">{event.label}</div>
                  <div className="ade-nt-event-hint">
                    {scope.collection !== "account" && !inherited ? (
                      <button
                        type="button"
                        className="ade-nt-inherit"
                        disabled={scopeBusy}
                        onClick={() => setEventPolicy(event.kind, null)}
                      >
                        Use Everywhere
                      </button>
                    ) : null}
                    {event.description}
                  </div>
                </div>
              </div>
              <div role="radiogroup" aria-label={event.label} className="ade-nt-cells">
                {POLICY_OPTIONS.map((option) => {
                  const active = option.value === value;
                  // An event with no Activity row has nothing to list quietly.
                  const unavailable = option.value === "ambient" && !event.supportsAmbient;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      aria-label={inherited && active ? `${option.label} (from Everywhere)` : option.label}
                      title={unavailable
                        ? "This event has no Activity row"
                        : `${option.label} — ${option.hint}${inherited && active ? " (from Everywhere)" : ""}`}
                      data-level={option.value === "ambient" ? "activity" : option.value}
                      data-inherited={(inherited && active) || undefined}
                      disabled={scopeBusy || unavailable}
                      className="ade-nt-cell"
                      onClick={() => { if (!active || inherited) setEventPolicy(event.kind, option.value); }}
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
  };

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
              <Banner
                layout="inline"
                model={{
                  id: "notifications-settings-error",
                  // Signed out, the only error is "sign in first": not a failure.
                  tone: model.signedOut ? "warning" : "error",
                  title: model.error,
                  actions: model.loadFailed ? [{ label: "Try again", onClick: model.retryLoad }] : undefined,
                  report: model.signedOut ? false : { surface: "notifications_settings" },
                }}
              />
            ) : null}
          </div>
        ) : null}

        <ModernSection
          group="Notifications"
          anchor="notification-events"
          title="Events"
          hint={scopeHint}
          actions={(
            <span className="ade-nt-summary" aria-live="polite">
              {model.saved ? (
                <>
                  <CheckCircle size={13} weight="fill" style={{ color: "var(--kit-ok)" }} />
                  Saved
                </>
              ) : (
                <><b>{notifyCount}</b> of <b>{events.length}</b> notify</>
              )}
            </span>
          )}
        >
          {scopeKinds.length > 1 ? (
            <div className="ade-nt-scopebar">
              <SegmentedChoice
                ariaLabel="Settings for"
                value={scope.collection}
                options={scopeKinds}
                disabled={model.busy}
                onChange={chooseScopeKind}
              />
              {scope.collection !== "account" ? (
                <>
                  <SettingsSelect
                    ariaLabel={`Which ${SCOPE_NOUN[scope.collection]}`}
                    value={scope.id}
                    options={scopeTargets[scope.collection]}
                    disabled={model.busy}
                    onChange={(id) => setScope({ collection: scope.collection, id })}
                  />
                  <span className="ade-nt-scope-spacer" />
                  {overrideCount > 0 ? (
                    <button
                      type="button"
                      className="ade-modern-btn"
                      disabled={scopeBusy}
                      onClick={() => void model.updateScope(scope.collection, scope.id, { eventPolicies: null })}
                    >
                      Use Everywhere for all
                    </button>
                  ) : null}
                  <span className="ade-nt-summary">Notifications</span>
                  <SettingsToggle
                    label={`Notifications for this ${SCOPE_NOUN[scope.collection]}`}
                    checked={scopeOn}
                    disabled={scopeBusy}
                    onChange={(enabled) => {
                      void model.updateScope(
                        scope.collection,
                        scope.id,
                        scope.collection === "devices" ? { deviceDeliveryEnabled: enabled } : { notificationsEnabled: enabled },
                      );
                    }}
                  />
                </>
              ) : null}
            </div>
          ) : null}
          {scope.collection !== "account" && !scopeOn ? (
            <div className="ade-nt-note">
              <Info size={15} />
              {scope.collection === "devices"
                ? "Nothing is sent to this phone. Activity still lists everything."
                : `Nothing from this ${SCOPE_NOUN[scope.collection]} notifies. Activity still lists it.`}
            </div>
          ) : null}
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
                      ? "How long before your phone gets it too."
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
                  hint={account.quietHours.enabled && account.quietHours.timeZone ? (
                    <>
                      Nothing notifies during this window ({account.quietHours.timeZone} time). Activity still lists it.
                      {/* Windows saved from a computer before ADE stored the zone read as UTC. */}
                      {account.quietHours.timeZone !== localTimeZone ? (
                        <>
                          {" "}
                          <button
                            type="button"
                            className="ade-nt-inherit"
                            disabled={busy}
                            onClick={() => updateAccount({ quietHours: account.quietHours })}
                          >
                            Use {localTimeZone}
                          </button>
                        </>
                      ) : null}
                    </>
                  ) : "Nothing notifies during this window, on computers or phones. Activity still lists it."}
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
            <ActivityMachinesSection model={model} onChooseEvents={scoped ? showScope : undefined} />
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
            {isStandaloneSettings() ? (
              <ProjectSettingsNotice
                group="Scheduled work"
                title="Scheduled work"
                detail="Scheduled work is saved in each project, with its jobs and its pause."
              />
            ) : (
              <AiFeaturesSection />
            )}
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

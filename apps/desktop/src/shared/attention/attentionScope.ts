import {
  BALANCED_ATTENTION_EVENT_POLICIES,
  DEFAULT_ATTENTION_PREFERENCES,
  upgradeAttentionEventPolicies,
  type AttentionDeliveryPolicy,
  type AttentionPolicyEventKind,
  type AttentionPreferenceScope,
  type AttentionPreferences,
  type AttentionScopePatch,
} from "../types/attention";

/**
 * How one notification's settings are decided: the account, then the
 * project, machine and device it is about. The push relay applies the same
 * rules to phones (`resolveScopedDeliveryPreferences`, `quietWindowActive` and
 * `applyAttentionScopePatch` in `apps/push-relay/src/attention.ts`); keep the
 * two in step.
 */

/** The scopes one notification is about: its project, its machine, the device showing it. */
export type AttentionScopeTarget = {
  /** Every id the project goes by (the machine-independent id first). */
  projectIds?: readonly (string | null | undefined)[];
  machineKey?: string | null;
  deviceId?: string | null;
};

/**
 * The settings that apply to one notification: the account, then its project,
 * then its machine, then the device. Event policies merge per event, so a
 * scope that changes one event keeps the account's choice for the rest.
 * "Notifications off" in any scope below the account is a veto. The account's
 * own switch is "Phone notifications" and stays the caller's to read.
 *
 * The push relay resolves a phone's settings the same way
 * (`resolveScopedDeliveryPreferences` in `apps/push-relay/src/attention.ts`).
 */
export function resolveAttentionScope(
  preferences: AttentionPreferences,
  target: AttentionScopeTarget,
): {
  scope: AttentionPreferenceScope;
  scopedOff: boolean;
  quietHours: Array<AttentionPreferenceScope["quietHours"] | undefined>;
} {
  const layers: Partial<AttentionPreferenceScope>[] = [];
  const seenProjects = new Set<string>();
  for (const projectId of target.projectIds ?? []) {
    const id = projectId?.trim();
    if (!id || seenProjects.has(id)) continue;
    seenProjects.add(id);
    const layer = preferences.projects?.[id];
    if (layer) layers.push(layer);
  }
  layers.reverse();
  const machine = target.machineKey ? preferences.machines?.[target.machineKey] : undefined;
  if (machine) layers.push(machine);
  const device = target.deviceId ? preferences.devices?.[target.deviceId] : undefined;
  if (device) layers.push(device);
  const account = upgradeAttentionEventPolicies(preferences.account ?? DEFAULT_ATTENTION_PREFERENCES.account);
  const scope: AttentionPreferenceScope = Object.assign(
    {},
    DEFAULT_ATTENTION_PREFERENCES.account,
    account,
    ...layers,
  );
  scope.eventPolicies = Object.assign(
    {},
    DEFAULT_ATTENTION_PREFERENCES.account.eventPolicies,
    account.eventPolicies,
    ...layers.map((layer) => layer.eventPolicies ?? {}),
  );
  scope.notificationsEnabled = account.notificationsEnabled !== false;
  const scopedOff = layers.some((layer) =>
    layer.notificationsEnabled === false || layer.deviceDeliveryEnabled === false);
  return { scope, scopedOff, quietHours: [account.quietHours, ...layers.map((layer) => layer.quietHours)] };
}

/** This event's delivery level in a resolved scope, or its catalog default. */
export function attentionEventPolicy(
  scope: Pick<AttentionPreferenceScope, "eventPolicies">,
  kind: AttentionPolicyEventKind,
): AttentionDeliveryPolicy {
  return scope.eventPolicies?.[kind] ?? BALANCED_ATTENTION_EVENT_POLICIES[kind] ?? "ambient";
}

/**
 * Whether a quiet-hours window covers `nowMs`, read in the window's own time
 * zone (UTC when it names none). The push
 * relay reads phone windows with the same rule (`quietWindowActive`), including
 * staying quiet-free when the zone is unknown.
 */
export function attentionQuietHoursActive(
  quietHours: Partial<AttentionPreferenceScope["quietHours"]> | null | undefined,
  nowMs: number,
): boolean {
  if (!quietHours || quietHours.enabled !== true) return false;
  const startMinute = Number(quietHours.startMinute);
  const endMinute = Number(quietHours.endMinute);
  if (
    !Number.isInteger(startMinute)
    || !Number.isInteger(endMinute)
    || startMinute < 0
    || startMinute >= 24 * 60
    || endMinute < 0
    || endMinute >= 24 * 60
    || startMinute === endMinute
  ) {
    return false;
  }
  const minuteIn = (timeZone: string): number | null => {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).formatToParts(new Date(nowMs));
      const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0) % 24;
      const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
      return hour * 60 + minute;
    } catch {
      return null;
    }
  };
  const current = minuteIn(quietHours.timeZone?.trim() || "UTC");
  if (current == null) return false;
  return startMinute < endMinute
    ? current >= startMinute && current < endMinute
    : current >= startMinute || current < endMinute;
}

/**
 * This computer's time zone, for the quiet-hours window it saves. Quiet hours
 * are read in the zone they were set in; without one the relay reads UTC.
 */
export function localAttentionTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * Apply a scope patch to what the scope holds, the way the relay's scope
 * routes do: event policies merge per event, and `null` removes an override.
 */
export function applyAttentionScopePatchLocally(
  existing: Partial<AttentionPreferenceScope> | undefined,
  patch: AttentionScopePatch,
): Partial<AttentionPreferenceScope> {
  const next: Record<string, unknown> = { ...(existing ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "eventPolicies") {
      if (value === null) {
        delete next.eventPolicies;
        continue;
      }
      const policies: Record<string, unknown> = { ...(existing?.eventPolicies ?? {}) };
      for (const [kind, policy] of Object.entries(value as Record<string, unknown>)) {
        if (policy === null) delete policies[kind];
        else policies[kind] = policy;
      }
      if (Object.keys(policies).length > 0) next.eventPolicies = policies;
      else delete next.eventPolicies;
      continue;
    }
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next as Partial<AttentionPreferenceScope>;
}

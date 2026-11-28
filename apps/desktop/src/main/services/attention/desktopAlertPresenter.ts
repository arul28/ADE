import { ACTIVITY_EVENT_BY_KIND } from "../../../shared/activityCatalog";
import {
  attentionEventPolicy,
  attentionQuietHoursActive,
  resolveAttentionScope,
} from "../../../shared/attention/attentionScope";
import {
  DEFAULT_ATTENTION_PREFERENCES,
  type AttentionPolicyEventKind,
  type AttentionItem,
  type AttentionPreferences,
  type AttentionDesktopAlert,
  type AttentionSnapshot,
} from "../../../shared/types/attention";

/** See `AttentionDesktopAlert`. */
export type DesktopAlert = AttentionDesktopAlert;

export type DesktopAlertPresenterDeps = {
  isSupported: () => boolean;
  /** True while any ADE window has focus: the user is already looking at ADE. */
  isAppFocused: () => boolean;
  show: (alert: DesktopAlert, onClick: () => void) => void;
  /**
   * A focused window shows a message as an in-app toast instead: the user is
   * at ADE, the phone is waiting on them, and nothing else would say it.
   */
  toastInFocusedWindow: (alert: DesktopAlert) => void;
  open: (alert: DesktopAlert) => void;
  /** The last account preferences any window loaded; null when signed out or unknown. */
  getPreferences: () => AttentionPreferences | null;
  /**
   * The signed-in account, or null. Signed in, unknown preferences mean
   * "wait", not "allow"; a waiting alert is only replayed for its account.
   */
  getAccountOwnerId?: () => string | null;
  /** This desktop's device id, for its own scope in those preferences. */
  getDeviceId?: () => string | null;
  now?: () => number;
};

/** An alert older than this is backlog (a reconnect, a restart), not news. */
const MAX_ALERT_AGE_MS = 2 * 60_000;
/**
 * One state entry notifies once, whichever source reports it first. The local
 * brain stamps the moment it noticed; a snapshot carries the state's start.
 * Those agree to within seconds, while the next question from the same chat
 * starts minutes later.
 */
const SAME_ENTRY_WINDOW_MS = 60_000;
const MAX_REMEMBERED = 256;
/**
 * Alerts held while settings load. A startup burst past this is noise as
 * system notifications; the dropped ones are still in Activity's Inbox.
 */
const MAX_WAITING_FOR_PREFERENCES = 16;

const EVENT_BY_KIND: Record<Exclude<DesktopAlert["kind"], "activity">, AttentionPolicyEventKind> = {
  needs_you: "agent_needs_you",
  failed: "agent_failed",
  goal: "agent_goal",
  message: "agent_message",
};

const HIDDEN_DETAIL_TITLE: Record<Exclude<DesktopAlert["kind"], "activity" | "message">, string> = {
  needs_you: "Needs you",
  failed: "Failed",
  goal: "Goal update",
};

/** The item and event an alert is about, whatever phase of it. */
function alertSubjectKey(alert: DesktopAlert): string {
  return `${alert.itemId}\u0000${alertEvent(alert) ?? alert.kind}`;
}

function alertKey(alert: DesktopAlert): string {
  const key = alertSubjectKey(alert);
  // Snapshot-only events carry the identity of a phase entry, so two turns can
  // finish close together and still produce distinct alerts. For older rows,
  // desktopAlertFromItem supplies the phase timestamp.
  return alert.kind === "activity" ? `${key}\u0000${alert.alertFingerprint ?? alert.at}` : key;
}

function alertEvent(alert: DesktopAlert): AttentionPolicyEventKind | undefined {
  return alert.kind === "activity" ? alert.item?.eventKind : EVENT_BY_KIND[alert.kind];
}

/** A fresh, unseen event can alert independently of its Activity tier. */
export function desktopAlertFromItem(item: AttentionItem): DesktopAlert | null {
  if (item.seenAt || item.dismissedAt || item.activityTier === "idle" || item.phase === "stale") return null;
  const kind: DesktopAlert["kind"] = item.kind === "message"
    ? "message"
    : item.eventKind === "agent_needs_you"
      ? "needs_you"
      : item.eventKind === "agent_failed"
        ? "failed"
        : "activity";
  const body = kind === "message"
    ? (item.preview.trim() && item.preview.trim() !== item.title.trim() ? item.preview.trim() : null)
    : `${ACTIVITY_EVENT_BY_KIND[item.eventKind]?.label ?? "Update"} · ${item.project.name}`;
  return {
    itemId: item.id,
    kind,
    sessionId: item.destination.kind === "session" ? item.destination.sessionId : null,
    title: item.title,
    body,
    at: item.statusSince ?? item.updatedAt,
    accountMachineKey: item.machine.accountMachineKey ?? null,
    machineKey: item.machine.machineKey,
    projectId: item.project.projectId,
    canonicalProjectId: item.project.canonicalId ?? null,
    projectSettingsKey: item.project.settingsKey ?? null,
    alertFingerprint: item.alertFingerprint ?? null,
    item,
  };
}

/**
 * Decides which alerts become desktop notifications, and only for alerts the
 * user's notification settings would push: the event set to Notify in the
 * alert's project, machine and device scopes, none of those scopes turned off,
 * the chat not muted, and no quiet hours. A message and a goal outcome have
 * their own events, which notify by default: the user asked for them.
 *
 * A system notification only while no ADE window is focused. A focused window
 * already shows Needs you on its badge; a message there becomes an in-app
 * toast, since nothing else on screen carries its words.
 */
export function createDesktopAlertPresenter(deps: DesktopAlertPresenterDeps) {
  const now = deps.now ?? (() => Date.now());
  /** Alert key -> when the last handled entry began. */
  const handledEntryAt = new Map<string, number>();
  /**
   * Item and event -> the newest phase handled for it. A newer phase retires
   * the older key rather than leaving it to evict current ones, and a phase
   * older than this one (a snapshot reply that arrived late) is not news.
   */
  const activityPhaseKey = new Map<string, { key: string; at: number }>();
  /**
   * Alerts that arrived signed in before any settings loaded, re-checked once
   * settings load (the age limit still applies).
   */
  let waitingForPreferences: Array<{ alert: DesktopAlert; ownerId: string }> = [];

  const remember = (alert: DesktopAlert, key: string, at: number): void => {
    if (alert.kind === "activity") {
      const subject = alertSubjectKey(alert);
      const newest = activityPhaseKey.get(subject);
      if (newest === undefined || at >= newest.at) {
        if (newest !== undefined && newest.key !== key) handledEntryAt.delete(newest.key);
        activityPhaseKey.delete(subject);
        activityPhaseKey.set(subject, { key, at });
      }
      while (activityPhaseKey.size > MAX_REMEMBERED) {
        const oldest = activityPhaseKey.keys().next();
        if (oldest.done) break;
        activityPhaseKey.delete(oldest.value);
      }
    }
    handledEntryAt.delete(key);
    handledEntryAt.set(key, at);
    while (handledEntryAt.size > MAX_REMEMBERED) {
      const oldest = handledEntryAt.keys().next();
      if (oldest.done) break;
      handledEntryAt.delete(oldest.value);
    }
  };

  /**
   * The settings that apply to this alert on this desktop, layered the way the
   * relay layers them for a phone: account, then project, then the owning
   * machine (by its push identity, which is what "mute this machine" writes),
   * then this device.
   */
  const resolvedScope = (preferences: AttentionPreferences, alert: DesktopAlert) =>
    resolveAttentionScope(preferences, {
      projectIds: [alert.projectSettingsKey, alert.canonicalProjectId, alert.projectId],
      machineKey: alert.machineKey,
      deviceId: deps.getDeviceId?.() ?? null,
    });

  const allowedByPreferences = (alert: DesktopAlert): boolean => {
    const preferences = deps.getPreferences();
    const event = alertEvent(alert);
    if (!event) return false;
    if (!preferences) return attentionEventPolicy(DEFAULT_ATTENTION_PREFERENCES.account, event) === "notify";
    // The account's own switch is "Phone notifications": it is about the
    // phone, so this computer does not read it. A project, machine or device
    // turned off is a veto.
    const { scope, scopedOff, quietHours } = resolvedScope(preferences, alert);
    if (scopedOff) return false;
    if (alert.sessionId && (preferences.mutedSessionIds ?? []).includes(alert.sessionId)) return false;
    const nowMs = now();
    if (quietHours.some((window) => attentionQuietHoursActive(window, nowMs))) return false;
    return attentionEventPolicy(scope, event) === "notify";
  };

  /**
   * With Hide details on, a system notification says only what kind of thing
   * happened, like a phone's lock screen; a message keeps its title, which the
   * agent wrote for exactly this. The in-app toast is not redacted: it shows
   * inside ADE, where the chat itself is visible.
   */
  const redactedForSystemNotification = (alert: DesktopAlert): DesktopAlert => {
    const preferences = deps.getPreferences();
    if (!preferences || resolvedScope(preferences, alert).scope.hideDetails !== true) return alert;
    if (alert.kind === "message") return { ...alert, body: null };
    if (alert.kind === "activity") {
      const event = alertEvent(alert);
      return { ...alert, title: event ? ACTIVITY_EVENT_BY_KIND[event]?.label ?? "ADE update" : "ADE update", body: null };
    }
    return { ...alert, title: `Agent: ${HIDDEN_DETAIL_TITLE[alert.kind]}`, body: null };
  };

  const present = (alert: DesktopAlert): void => {
    const nowMs = now();
    const at = Date.parse(alert.at);
    if (!Number.isFinite(at) || nowMs - at > MAX_ALERT_AGE_MS) return;
    const key = alertKey(alert);
    const previous = handledEntryAt.get(key);
    if (previous !== undefined && Math.abs(at - previous) < SAME_ENTRY_WINDOW_MS) return;
    if (alert.kind === "activity") {
      // A late snapshot reply can carry a phase older than one already handled.
      const newest = activityPhaseKey.get(alertSubjectKey(alert));
      if (newest !== undefined && newest.key !== key && at < newest.at) return;
    }
    // Signed in but no settings loaded yet (startup, relay backing off): the
    // chat may be muted. Not remembered; it waits for `preferencesLoaded`.
    // Snapshot alerts wait too: snapshots are deltas, so the next poll does
    // not bring the item back.
    const ownerId = deps.getAccountOwnerId?.() ?? null;
    if (ownerId && !deps.getPreferences()) {
      // The newest alert for a key replaces an older one still waiting.
      waitingForPreferences = [
        ...waitingForPreferences.filter((entry) => alertKey(entry.alert) !== key),
        { alert, ownerId },
      ].slice(-MAX_WAITING_FOR_PREFERENCES);
      return;
    }
    // Remembered even when not shown, so the other source cannot show it a
    // moment later once a window loses focus.
    remember(alert, key, at);
    if (!allowedByPreferences(alert)) return;
    if (deps.isAppFocused()) {
      if (alert.kind === "message") deps.toastInFocusedWindow(alert);
      return;
    }
    if (!deps.isSupported()) return;
    deps.show(redactedForSystemNotification(alert), () => deps.open(alert));
  };

  return {
    /** An alert this computer's brain announced for one of its own chats. */
    presentLocal(alert: DesktopAlert): void {
      present(alert);
    },
    /** Settings just loaded: re-check local alerts that waited for them (age limit applies). */
    preferencesLoaded(): void {
      const waiting = waitingForPreferences;
      waitingForPreferences = [];
      // An alert that waited under another account is that account's, not this one's.
      const ownerId = deps.getAccountOwnerId?.() ?? null;
      for (const entry of waiting) {
        if (entry.ownerId === ownerId) present(entry.alert);
      }
    },
    /** Every account snapshot a window polled: other machines' chats arrive here. */
    observeSnapshot(snapshot: AttentionSnapshot): void {
      // A snapshot that finished after an account switch belongs to the old one.
      if (
        snapshot.accountOwnerId !== undefined
        && snapshot.accountOwnerId !== (deps.getAccountOwnerId?.() ?? null)
      ) {
        return;
      }
      for (const item of snapshot.items) {
        const alert = desktopAlertFromItem(item);
        if (alert) present(alert);
      }
    },
  };
}

export type DesktopAlertPresenter = ReturnType<typeof createDesktopAlertPresenter>;

/** Read a brain's `attention_alert` runtime event payload; null when malformed. */
export function readDesktopAlertEvent(payload: unknown): DesktopAlert | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (record.type !== "attention_alert") return null;
  const alert = record.alert;
  if (!alert || typeof alert !== "object") return null;
  const value = alert as Record<string, unknown>;
  const kind = value.kind;
  if (kind !== "needs_you" && kind !== "failed" && kind !== "goal" && kind !== "message") return null;
  const text = (field: unknown): string | null =>
    typeof field === "string" && field.trim() ? field.trim() : null;
  const itemId = text(value.itemId);
  const sessionId = text(value.sessionId);
  const title = text(value.title);
  const at = text(value.at);
  if (!itemId || !sessionId || !title || !at) return null;
  return {
    itemId,
    kind,
    sessionId,
    title,
    body: text(value.body),
    at,
    accountMachineKey: text(value.accountMachineKey),
    machineKey: text(value.machineKey),
    projectId: text(value.projectId),
    canonicalProjectId: text(value.canonicalProjectId),
    projectSettingsKey: text(value.projectSettingsKey),
    alertFingerprint: text(value.alertFingerprint),
  };
}


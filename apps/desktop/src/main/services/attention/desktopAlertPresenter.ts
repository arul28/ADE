import {
  DEFAULT_ATTENTION_PREFERENCES,
  type AttentionEventKind,
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
  /** True while signed in: then unknown preferences mean "wait", not "allow". */
  isSignedIn?: () => boolean;
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
const MAX_WAITING_FOR_PREFERENCES = 16;

const EVENT_BY_KIND: Record<"needs_you" | "failed", AttentionEventKind> = {
  needs_you: "agent_needs_you",
  failed: "agent_failed",
};

const HIDDEN_DETAIL_TITLE: Record<Exclude<DesktopAlert["kind"], "message">, string> = {
  needs_you: "Needs you",
  failed: "Failed",
  goal: "Goal update",
};

function alertKey(alert: Pick<DesktopAlert, "itemId" | "kind">): string {
  return `${alert.itemId}\u0000${alert.kind}`;
}

/**
 * The alert an account item would raise now, or null. Agents raise one on
 * Needs you and on failure; a message always does. Seen, dismissed and
 * non-signal items never do.
 */
export function desktopAlertFromItem(item: AttentionItem): DesktopAlert | null {
  if (item.seenAt || item.dismissedAt) return null;
  if (item.activityTier && item.activityTier !== "signal") return null;
  if (item.destination.kind !== "session") return null;
  const kind: DesktopAlert["kind"] | null = item.kind === "message"
    ? "message"
    : item.kind === "agent" && item.phase === "needs_you"
      ? "needs_you"
      : item.kind === "agent" && item.phase === "failed"
        ? "failed"
        : null;
  if (!kind) return null;
  const body = kind === "message"
    ? (item.preview.trim() && item.preview.trim() !== item.title.trim() ? item.preview.trim() : null)
    : `${kind === "failed" ? "Failed" : "Needs you"} · ${item.project.name}`;
  return {
    itemId: item.id,
    kind,
    sessionId: item.destination.sessionId,
    title: item.title,
    body,
    at: item.statusSince ?? item.updatedAt,
    accountMachineKey: item.machine.accountMachineKey ?? null,
    machineKey: item.machine.machineKey,
    projectId: item.project.projectId,
    alertFingerprint: item.alertFingerprint ?? null,
    item,
  };
}

/**
 * Decides which alerts become desktop notifications, and only for alerts the
 * user's Activity settings would push: notifications on, the chat and its
 * machine not muted, the event set to notify. A message has no event setting;
 * the user asked for it.
 *
 * A system notification only while no ADE window is focused. A focused window
 * already shows Needs you on its badge; a message there becomes an in-app
 * toast, since nothing else on screen carries its words.
 */
export function createDesktopAlertPresenter(deps: DesktopAlertPresenterDeps) {
  const now = deps.now ?? (() => Date.now());
  /** item + kind -> when the last state entry we handled began. */
  const handledEntryAt = new Map<string, number>();
  /**
   * Local alerts that arrived signed in before any settings loaded. A local
   * alert has no snapshot to bring it back (a goal outcome is not an Activity
   * item), so it waits here and is re-checked once settings load.
   */
  let waitingForPreferences: DesktopAlert[] = [];

  const remember = (key: string, at: number): void => {
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
  const resolvedScope = (
    preferences: AttentionPreferences,
    alert: DesktopAlert,
  ): Partial<AttentionPreferences["account"]> => {
    const deviceId = deps.getDeviceId?.() ?? null;
    return {
      ...preferences.account,
      ...(alert.projectId ? preferences.projects?.[alert.projectId] : undefined),
      ...(alert.machineKey ? preferences.machines?.[alert.machineKey] : undefined),
      ...(deviceId ? preferences.devices?.[deviceId] : undefined),
    };
  };

  const allowedByPreferences = (alert: DesktopAlert): boolean => {
    const preferences = deps.getPreferences();
    if (!preferences) return true;
    const scope = resolvedScope(preferences, alert);
    if (scope.notificationsEnabled === false) return false;
    if ((preferences.mutedSessionIds ?? []).includes(alert.sessionId)) return false;
    // A message and a goal outcome are things the user asked to hear about.
    if (alert.kind === "message" || alert.kind === "goal") return true;
    const event = EVENT_BY_KIND[alert.kind];
    const policy = scope.eventPolicies?.[event]
      ?? DEFAULT_ATTENTION_PREFERENCES.account.eventPolicies[event];
    return policy === "notify";
  };

  /**
   * With Hide details on, a system notification says only what kind of thing
   * happened, like a phone's lock screen; a message keeps its title, which the
   * agent wrote for exactly this. The in-app toast is not redacted: it shows
   * inside ADE, where the chat itself is visible.
   */
  const redactedForSystemNotification = (alert: DesktopAlert): DesktopAlert => {
    const preferences = deps.getPreferences();
    if (!preferences || resolvedScope(preferences, alert).hideDetails !== true) return alert;
    if (alert.kind === "message") return { ...alert, body: null };
    return { ...alert, title: `Agent: ${HIDDEN_DETAIL_TITLE[alert.kind]}`, body: null };
  };

  const present = (alert: DesktopAlert): void => {
    const nowMs = now();
    const at = Date.parse(alert.at);
    if (!Number.isFinite(at) || nowMs - at > MAX_ALERT_AGE_MS) return;
    const key = alertKey(alert);
    const previous = handledEntryAt.get(key);
    if (previous !== undefined && Math.abs(at - previous) < SAME_ENTRY_WINDOW_MS) return;
    // Signed in but no settings loaded yet (startup, relay backing off): the
    // chat may be muted. Not remembered: a snapshot alert comes back with the
    // next poll, and a local one waits for `preferencesLoaded`.
    if (deps.isSignedIn?.() && !deps.getPreferences()) {
      if (!alert.item && !waitingForPreferences.some((entry) => alertKey(entry) === key)) {
        waitingForPreferences = [...waitingForPreferences, alert].slice(-MAX_WAITING_FOR_PREFERENCES);
      }
      return;
    }
    // Remembered even when not shown, so the other source cannot show it a
    // moment later once a window loses focus.
    remember(key, at);
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
      for (const alert of waiting) present(alert);
    },
    /** Every account snapshot a window polled: other machines' chats arrive here. */
    observeSnapshot(snapshot: AttentionSnapshot): void {
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
    alertFingerprint: text(value.alertFingerprint),
  };
}


import {
  DEFAULT_ATTENTION_PREFERENCES,
  type AttentionEventKind,
  type AttentionItem,
  type AttentionPreferences,
  type AttentionDesktopAlert,
  type AttentionSnapshot,
} from "../../../shared/types/attention";
import { parseAttentionItem } from "./attentionItemRouting";

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

const EVENT_BY_KIND: Record<"needs_you" | "failed", AttentionEventKind> = {
  needs_you: "agent_needs_you",
  failed: "agent_failed",
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

  const remember = (key: string, at: number): void => {
    handledEntryAt.delete(key);
    handledEntryAt.set(key, at);
    while (handledEntryAt.size > MAX_REMEMBERED) {
      const oldest = handledEntryAt.keys().next();
      if (oldest.done) break;
      handledEntryAt.delete(oldest.value);
    }
  };

  const allowedByPreferences = (alert: DesktopAlert): boolean => {
    const preferences = deps.getPreferences();
    if (!preferences) return true;
    const machine = alert.accountMachineKey
      ? preferences.machines?.[alert.accountMachineKey] ?? {}
      : {};
    const scope = { ...preferences.account, ...machine };
    if (scope.notificationsEnabled === false) return false;
    if ((preferences.mutedSessionIds ?? []).includes(alert.sessionId)) return false;
    // A message and a goal outcome are things the user asked to hear about.
    if (alert.kind === "message" || alert.kind === "goal") return true;
    const event = EVENT_BY_KIND[alert.kind];
    const policy = scope.eventPolicies?.[event]
      ?? DEFAULT_ATTENTION_PREFERENCES.account.eventPolicies[event];
    return policy === "notify";
  };

  const present = (alert: DesktopAlert): void => {
    const nowMs = now();
    const at = Date.parse(alert.at);
    if (!Number.isFinite(at) || nowMs - at > MAX_ALERT_AGE_MS) return;
    const key = alertKey(alert);
    const previous = handledEntryAt.get(key);
    if (previous !== undefined && Math.abs(at - previous) < SAME_ENTRY_WINDOW_MS) return;
    // Remembered even when not shown, so the other source cannot show it a
    // moment later once a window loses focus.
    remember(key, at);
    if (!allowedByPreferences(alert)) return;
    if (deps.isAppFocused()) {
      if (alert.kind === "message") deps.toastInFocusedWindow(alert);
      return;
    }
    if (!deps.isSupported()) return;
    deps.show(alert, () => deps.open(alert));
  };

  return {
    /** An alert this computer's brain announced for one of its own chats. */
    presentLocal(alert: DesktopAlert): void {
      present(alert);
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
  return readDesktopAlert(record.alert);
}

/**
 * The alert a window's toast hands back when the user presses Open. It came
 * from main, but it crossed IPC, so it is read again; an attached Activity item
 * must pass the same validation every other opened item does.
 */
export function parseDesktopAlertOpenRequest(input: unknown): DesktopAlert | null {
  const alert = readDesktopAlert(input);
  if (!alert) return null;
  const rawItem = input && typeof input === "object" ? (input as Record<string, unknown>).item : undefined;
  if (rawItem === undefined || rawItem === null) return alert;
  const item = parseAttentionItem(rawItem);
  return item ? { ...alert, item } : null;
}

function readDesktopAlert(alert: unknown): DesktopAlert | null {
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
  };
}


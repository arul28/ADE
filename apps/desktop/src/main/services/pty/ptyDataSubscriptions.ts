import type { WebContents } from "electron";

const subscriptionsByWebContentsId = new Map<number, Set<string>>();
const cleanupRegistered = new Set<number>();

export function normalizePtyDataSubscriptions(value: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(value)) return ids;
  for (const item of value) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (id) ids.add(id);
  }
  return ids;
}

export function setPtyDataSubscriptionsForSender(
  sender: WebContents,
  ptyIds: Set<string>,
): void {
  const webContentsId = sender.id;
  subscriptionsByWebContentsId.set(webContentsId, ptyIds);
  if (cleanupRegistered.has(webContentsId)) return;
  cleanupRegistered.add(webContentsId);
  sender.once("destroyed", () => {
    cleanupRegistered.delete(webContentsId);
    subscriptionsByWebContentsId.delete(webContentsId);
    remoteFiltersByWebContentsId.delete(webContentsId);
  });
}

export function shouldSendPtyDataToWebContents(
  sender: WebContents,
  ptyId: string,
): boolean {
  const subscriptions = subscriptionsByWebContentsId.get(sender.id);
  if (!subscriptions) return true;
  return Boolean(subscriptions?.has(ptyId));
}

/**
 * The terminals a window shows, as the list a brain takes (`ptyDataIds`), or
 * null while the window has not said (it gets every terminal's output).
 */
export function ptyDataIdsForSender(sender: WebContents): string[] | null {
  const subscriptions = subscriptionsByWebContentsId.get(sender.id);
  return subscriptions ? [...subscriptions].sort() : null;
}

/**
 * The terminal-output filter of one push subscription on another machine.
 * The window drops the output of a terminal it does not show, so the brain
 * need not send it: on a slow link it competes with what the person looks at.
 * A terminal that comes back reads its screen again (`TerminalView`).
 */
export type RemotePtyDataFilter = {
  /** The list to subscribe with: the window's list now. */
  current(): string[] | null;
  /**
   * Set by the connection pool once the brain took the subscription, when the
   * brain takes a list (`ptyDataFilter`). Resolves once the brain applied it.
   */
  onChange: ((ptyIds: string[] | null) => Promise<void>) | null;
  /**
   * Resolves once the subscription exists and the list it opened with is on
   * the brain (or nothing will be sent: the subscribe failed, the brain takes
   * no list, or the subscription closed). A window's list change waits on it
   * while the subscription is still opening, so a terminal it just showed is
   * not filtered out between the push and the subscribe answer.
   */
  ready: Promise<void>;
  /** The pool's: the subscription is up with its list, or it will not be. Safe to call twice. */
  markReady: () => void;
};

type RemoteFilterEntry = { bindingKey: string; filter: RemotePtyDataFilter };

const remoteFiltersByWebContentsId = new Map<number, Set<RemoteFilterEntry>>();

/** A filter for one push subscription the window opens; `release` when it closes. */
export function openRemotePtyDataFilter(
  sender: WebContents,
  bindingKey: string,
): { filter: RemotePtyDataFilter; release: () => void } {
  let resolveReady: (() => void) | null = null;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const markReady = () => {
    resolveReady?.();
  };
  const entry: RemoteFilterEntry = {
    bindingKey,
    filter: {
      current: () => ptyDataIdsForSender(sender),
      onChange: null,
      ready,
      markReady,
    },
  };
  let entries = remoteFiltersByWebContentsId.get(sender.id);
  if (!entries) {
    entries = new Set();
    remoteFiltersByWebContentsId.set(sender.id, entries);
  }
  entries.add(entry);
  return {
    filter: entry.filter,
    release: () => {
      entry.filter.onChange = null;
      entry.filter.markReady();
      const current = remoteFiltersByWebContentsId.get(sender.id);
      current?.delete(entry);
      if (current?.size === 0) remoteFiltersByWebContentsId.delete(sender.id);
    },
  };
}

/** How long a terminal that comes back waits for its machine to take the new list. */
const REMOTE_PTY_DATA_FILTER_SETTLE_MS = 5_000;

/**
 * Sends the window's list to each of its push subscriptions on other machines.
 * Resolves once the subscriptions of `settleBindingKey` applied it (or after
 * 5 s), so a terminal on that machine reads its screen only after the brain
 * sends its output: nothing printed between the two is lost. A subscription
 * still opening has no sender yet; the wait covers the list it opens with.
 */
export async function pushRemotePtyDataFilters(
  sender: WebContents,
  settleBindingKey: string | null,
): Promise<void> {
  const entries = remoteFiltersByWebContentsId.get(sender.id);
  if (!entries?.size) return;
  const ptyIds = ptyDataIdsForSender(sender);
  const settling: Promise<void>[] = [];
  for (const entry of [...entries]) {
    const applied = entry.filter.onChange?.(ptyIds)?.catch(() => {});
    if (entry.bindingKey !== settleBindingKey) continue;
    settling.push(applied ?? entry.filter.ready);
  }
  if (!settling.length) return;
  let timer: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([
    Promise.all(settling),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, REMOTE_PTY_DATA_FILTER_SETTLE_MS);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

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

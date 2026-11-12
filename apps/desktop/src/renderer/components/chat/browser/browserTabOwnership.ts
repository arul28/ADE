/**
 * Who a browser tab belongs to, and how the strip groups and filters by it.
 *
 * Three answers, the only three a person needs:
 * - **You**: you opened it, or kept an agent's tab (you clicked or typed in
 *   it, navigated it, attached it to a chat, or pressed Keep). ADE never
 *   closes it on its own.
 * - **A chat**: an agent opened it for its work. It sits in that chat's group
 *   in the strip, like a Chrome tab group, and closes on its own 15 minutes
 *   after the chat goes idle.
 * - **Free**: an agent opened it and its chat let go (the chat ended on
 *   another machine, an older brain). Any agent may pick it up.
 */
import type { BuiltInBrowserTab } from "../../../../shared/types/builtInBrowser";
import { browserTabGroupKey } from "./browserTabGroups";

export type BrowserTabOwnerKind = "you" | "chat" | "free";

type OwnershipFields = Pick<
  BuiltInBrowserTab,
  "openedBy" | "openedByChatSessionId" | "openedByLaneId" | "ownerChatSessionId" | "ownerLaneId" | "handoff"
> & { keptByPerson?: boolean; groupLaneId?: string | null; autoCloseAt?: string | null };

export function browserTabOwnerKind(tab: OwnershipFields): BrowserTabOwnerKind {
  if (tab.handoff) return "you";
  if (tab.openedBy !== "chat" || tab.keptByPerson) {
    // A person's tab an agent is driving right now still belongs to the person.
    return "you";
  }
  return tab.ownerChatSessionId || tab.openedByChatSessionId ? "chat" : "free";
}

/** The chat whose group an agent tab sits in; null for a person's or a free tab. */
export function browserTabChatId(tab: OwnershipFields): string | null {
  if (browserTabOwnerKind(tab) !== "chat") return null;
  return tab.ownerChatSessionId ?? tab.openedByChatSessionId ?? null;
}

/** The lane a tab counts toward for the lane filter. */
export function browserTabLaneId(tab: OwnershipFields): string | null {
  return browserTabGroupKey(tab) ?? tab.openedByLaneId ?? null;
}

/**
 * The lane filter: this lane's tabs plus your own tabs that belong to no lane
 * (your mail is not another lane's work). With no lane there is nothing to
 * filter by, and every tab shows.
 */
export function browserTabVisibleInLane(tab: OwnershipFields, laneId: string | null): boolean {
  if (!laneId) return true;
  const tabLane = browserTabLaneId(tab);
  if (tabLane === laneId) return true;
  return tabLane == null && browserTabOwnerKind(tab) === "you";
}

export type BrowserTabStripItem<T> =
  | { kind: "tab"; tab: T }
  | { kind: "group"; chatSessionId: string; laneId: string | null; tabs: T[] };

/**
 * The strip's items in order: your tabs and free tabs as they come, then one
 * group per chat at the position of that chat's first tab. Grouping keeps a
 * chat's tabs together even when another tab was opened between them.
 */
export function buildBrowserTabStripItems<T extends OwnershipFields>(tabs: readonly T[]): BrowserTabStripItem<T>[] {
  const items: BrowserTabStripItem<T>[] = [];
  const groups = new Map<string, Extract<BrowserTabStripItem<T>, { kind: "group" }>>();
  for (const tab of tabs) {
    const chatSessionId = browserTabChatId(tab);
    if (!chatSessionId) {
      items.push({ kind: "tab", tab });
      continue;
    }
    const existing = groups.get(chatSessionId);
    if (existing) {
      existing.tabs.push(tab);
      continue;
    }
    const group = { kind: "group" as const, chatSessionId, laneId: browserTabLaneId(tab), tabs: [tab] };
    groups.set(chatSessionId, group);
    items.push(group);
  }
  return items;
}

/** "Closes in 12 min", "Closes in under a minute", or null. */
export function browserTabAutoCloseLabel(autoCloseAt: string | null | undefined, now = Date.now()): string | null {
  if (!autoCloseAt) return null;
  const at = Date.parse(autoCloseAt);
  if (!Number.isFinite(at)) return null;
  const minutes = Math.ceil((at - now) / 60_000);
  if (minutes <= 1) return "Closes in under a minute";
  return `Closes in ${minutes} min`;
}

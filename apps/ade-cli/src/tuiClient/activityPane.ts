import type {
  AttentionItem,
  AttentionSnapshot,
} from "../../../desktop/src/shared/types/attention";
import {
  ATTENTION_CONTRACT_VERSION,
  activityItemTier,
  attentionDestinationDeepLink,
  sortAttentionItems,
} from "../../../desktop/src/shared/types/attention";
import {
  activityStateGroup,
  type ActivityStateGroup,
} from "../../../desktop/src/renderer/components/activity/activityPresentation";
import {
  activityFeedItems,
  activityNotificationItems,
} from "../../../desktop/src/renderer/components/activity/activityPriority";
import { formatRelativePastTime } from "./relativeTime";
import type { AdeCodeConnection } from "./types";

export type ActivityPaneGroupId =
  | "needs-you"
  | "failing"
  | "done"
  | "live"
  | "recent"
  | "notifications";

export type ActivityPaneGroup = {
  id: ActivityPaneGroupId;
  label: string;
  items: AttentionItem[];
};

export type ActivityPaneModel = {
  snapshot: AttentionSnapshot;
  groups: ActivityPaneGroup[];
  items: AttentionItem[];
  title: string;
  message: string;
  recovery: NonNullable<AttentionSnapshot["availability"]>["recovery"];
  waitingCount: number;
  liveCount: number;
};

export type ActivityPaneEntry =
  | { kind: "heading"; key: string; label: string }
  | { kind: "item"; key: string; item: AttentionItem; itemIndex: number };

type AccountStatus = {
  signedIn: boolean;
};

function nowIso(): string {
  return new Date().toISOString();
}

function emptySnapshot(
  availability: NonNullable<AttentionSnapshot["availability"]>,
): AttentionSnapshot {
  return {
    contractVersion: ATTENTION_CONTRACT_VERSION,
    scope: "machine",
    availability,
    streamId: null,
    revision: 0,
    generatedAt: nowIso(),
    items: [],
    tombstones: [],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUnsupportedActivityError(error: unknown): boolean {
  return /unknown (?:ade )?action|unknown (?:attention|activity) action|method not found|unsupported.*attention|attention\.call.*not (?:available|found)/i
    .test(errorMessage(error));
}

async function callAttention<T>(
  connection: AdeCodeConnection,
  action: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  return await connection.request<T>("attention.call", { action, args });
}

async function getAccountStatus(connection: AdeCodeConnection): Promise<AccountStatus | null> {
  try {
    const raw = await connection.request<unknown>("account.call", {
      action: "status",
      args: {},
    });
    const envelope = raw && typeof raw === "object" && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : {};
    const result = envelope.result && typeof envelope.result === "object" && !Array.isArray(envelope.result)
      ? envelope.result as Record<string, unknown>
      : envelope;
    return { signedIn: result.signedIn === true };
  } catch {
    return null;
  }
}

async function machineFallback(
  connection: AdeCodeConnection,
  availability: NonNullable<AttentionSnapshot["availability"]>,
): Promise<AttentionSnapshot> {
  const snapshot = await callAttention<AttentionSnapshot>(
    connection,
    "getMachineSnapshot",
  );
  return {
    ...snapshot,
    scope: "machine",
    availability,
  };
}

/**
 * Reads account Activity from the machine-global RPC rather than from the
 * TUI's selected project action scope. A signed-out or temporarily unavailable
 * account falls back to this connected machine without pretending that the
 * result is account-wide.
 */
export async function loadActivitySnapshot(
  connection: AdeCodeConnection,
  options: { hostName?: string | null } = {},
): Promise<AttentionSnapshot> {
  const status = await getAccountStatus(connection);
  if (status?.signedIn === false) {
    try {
      return await machineFallback(connection, {
        state: "signed_out",
        title: "This machine only",
        message: "Run `ade login` to see every ADE machine. Local work remains available.",
        recovery: "sign_in",
        hostName: options.hostName ?? null,
      });
    } catch (error) {
      const hostName = options.hostName?.trim() || "this ADE host";
      if (isUnsupportedActivityError(error)) {
        return emptySnapshot({
          state: "incompatible",
          title: `Update ${hostName}`,
          message:
            "This host cannot provide machine Activity yet. Update ADE, restart its brain, then retry.",
          recovery: "update_host",
          hostName,
        });
      }
      return emptySnapshot({
        state: "unavailable",
        title: "Machine Activity is unavailable",
        message: `ADE Code could not read work from ${hostName}. Reconnect to the host, then retry.`,
        recovery: "retry",
        hostName,
      });
    }
  }

  try {
    const snapshot = await callAttention<AttentionSnapshot>(
      connection,
      "getSnapshot",
      { since: 0 },
    );
    return {
      ...snapshot,
      scope: snapshot.scope ?? "account",
      availability: snapshot.availability ?? {
        state: "ready",
        title: "Account Activity",
        message: "Live across your ADE account.",
        recovery: null,
      },
    };
  } catch (error) {
    const hostName = options.hostName?.trim() || "this ADE host";
    if (isUnsupportedActivityError(error)) {
      try {
        return await machineFallback(connection, {
          state: "incompatible",
          title: `Update ${hostName}`,
          message: "This host cannot read account-wide Activity yet. Update ADE, then restart its brain. Local work remains available.",
          recovery: "update_host",
          hostName,
        });
      } catch {
        return emptySnapshot({
          state: "incompatible",
          title: `Update ${hostName}`,
          message:
            "This host cannot provide Activity yet. Update ADE, restart its brain, then retry.",
          recovery: "update_host",
          hostName,
        });
      }
    }
    try {
      return await machineFallback(connection, {
        state: "degraded",
        title: "Account sync needs attention",
        message: "ADE could not refresh the account stream. Showing this machine while you retry.",
        recovery: "retry",
        hostName: options.hostName ?? null,
      });
    } catch {
      return emptySnapshot({
        state: "unavailable",
        title: "Activity is unavailable",
        message:
          "ADE Code could not read the account stream or this host. Reconnect to the host, then retry.",
        recovery: "retry",
        hostName: options.hostName ?? null,
      });
    }
  }
}

export async function acknowledgeActivityItem(
  connection: AdeCodeConnection,
  item: Pick<AttentionItem, "id" | "revision">,
  scope: AttentionSnapshot["scope"] = "account",
  accountOwnerId: string | null = null,
): Promise<void> {
  await callAttention(connection, "acknowledge", {
    itemIds: [item.id],
    sourceRevisions: { [item.id]: item.revision },
    expectedAccountOwnerId: accountOwnerId,
    seenAt: nowIso(),
    scope: scope === "machine" ? "machine" : "account",
  });
}

/**
 * The TUI's five headings, expressed purely as a function of the canonical
 * Activity state group. The pane keeps its own vocabulary (it splits the
 * canonical `done` band into unreviewed outcomes and the ambient tail, which a
 * scrolling terminal list needs), but it may not disagree with the rule about
 * WHICH band a row is in — that rule is mirrored across the renderer, the
 * notch, iOS, and the relay, and this pane is a fifth mirror.
 *
 * Pinned by `activityStateGroup.cases.json` in activityPane.test.ts.
 */
export const ACTIVITY_PANE_GROUP_BY_STATE_GROUP = {
  "needs-you": "needs-you",
  failed: "failing",
  planning: "live",
  working: "live",
  // `done` splits below on seen/idle; this is the band, not the final heading.
  done: "done",
} as const satisfies Record<ActivityStateGroup, ActivityPaneGroupId>;

export function groupForItem(item: AttentionItem): ActivityPaneGroupId {
  const group = ACTIVITY_PANE_GROUP_BY_STATE_GROUP[activityStateGroup(item)];
  if (group !== "done") return group;
  // Disk-only roster rows are quiet history: an ended chat still carries phase
  // `completed` with no seenAt, which would otherwise file every session the
  // account has ever finished under DONE, UNREVIEWED and count it as waiting.
  // Already-seen outcomes join them in the tail. Desktop orders the same rows
  // the same way inside its `done` section — see `activitySections` in
  // apps/desktop/src/renderer/components/activity/activityPriority.ts.
  if (activityItemTier(item) === "idle" || item.seenAt !== null) return "recent";
  return "done";
}

const GROUP_LABELS: Record<ActivityPaneGroupId, string> = {
  "needs-you": "NEEDS YOU",
  failing: "FAILING OR BLOCKED",
  done: "DONE, UNREVIEWED",
  live: "LIVE NOW",
  recent: "RECENT",
  notifications: "NOTIFICATIONS",
};

export function buildActivityPaneModel(
  snapshot: AttentionSnapshot,
  now = Date.now(),
): ActivityPaneModel {
  // Activity is an AGENT feed on every surface. Pull requests, checks and
  // review outcomes still arrive — they push and badge — but they are not
  // session rows, because a lane with an open PR rendered twice: once as the
  // agent working it and once as the PR. `activityFeedItems` /
  // `activityNotificationItems` are the same split the renderer and the notch
  // use, and they also drop dismissed and expired rows, which this pane
  // previously kept.
  const visible = sortAttentionItems(activityFeedItems(snapshot.items, now));
  const buckets = new Map<ActivityPaneGroupId, AttentionItem[]>();
  for (const item of visible) {
    const group = groupForItem(item);
    const bucket = buckets.get(group) ?? [];
    bucket.push(item);
    buckets.set(group, bucket);
  }
  // The notification tail, mirroring `activityFeedOrder`: agent sections first,
  // then everything that is not an agent and would have pushed a notification.
  buckets.set("notifications", activityNotificationItems(snapshot.items, now));
  const order: ActivityPaneGroupId[] = [
    "needs-you",
    "failing",
    "done",
    "live",
    "recent",
    "notifications",
  ];
  const groups = order
    .map((id): ActivityPaneGroup => ({
      id,
      label: GROUP_LABELS[id],
      items: buckets.get(id) ?? [],
    }))
    .filter((group) => group.items.length > 0);
  const items = groups.flatMap((group) => group.items);
  const waitingCount = groups
    .filter((group) => group.id === "needs-you" || group.id === "failing" || group.id === "done")
    .reduce((count, group) => count + group.items.length, 0);
  const liveCount = groups.find((group) => group.id === "live")?.items.length ?? 0;
  const availability = snapshot.availability ?? {
    state: snapshot.scope === "machine" ? "degraded" as const : "ready" as const,
    title: snapshot.scope === "machine" ? "This machine only" : "Account Activity",
    message: snapshot.scope === "machine"
      ? "Account sync is unavailable. Showing connected-machine work."
      : "Live across your ADE account.",
    recovery: snapshot.scope === "machine" ? "retry" as const : null,
  };

  return {
    snapshot,
    groups,
    items,
    title: availability.title,
    message: availability.message,
    recovery: availability.recovery,
    waitingCount,
    liveCount,
  };
}

export function activityItemDeepLink(item: AttentionItem): string {
  return attentionDestinationDeepLink(item.destination, item);
}

/**
 * How long the row has held its current phase. `statusSince` is the publisher's
 * phase anchor, so a long-running agent reads as "2h ago" for the phase rather
 * than for its last token; publishers older than this build omit it and
 * `updatedAt` is the honest fallback.
 */
export function activityItemElapsed(item: AttentionItem, nowMs = Date.now()): string {
  return formatRelativePastTime(item.statusSince ?? item.updatedAt, nowMs);
}

export function activityItemContext(item: AttentionItem): string {
  return [item.project.name, item.laneName, item.machine.name]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(" · ");
}

export function activityPaneEntries(
  model: ActivityPaneModel,
  selectedIndex: number,
  maxRows = 20,
): { entries: ActivityPaneEntry[]; hiddenBefore: number; hiddenAfter: number } {
  const all: ActivityPaneEntry[] = [];
  let itemIndex = 0;
  for (const group of model.groups) {
    all.push({ kind: "heading", key: `heading:${group.id}`, label: group.label });
    for (const item of group.items) {
      all.push({ kind: "item", key: item.id, item, itemIndex });
      itemIndex += 1;
    }
  }
  if (all.length <= maxRows) {
    return { entries: all, hiddenBefore: 0, hiddenAfter: 0 };
  }

  const selectedEntryIndex = Math.max(
    0,
    all.findIndex((entry) => entry.kind === "item" && entry.itemIndex === selectedIndex),
  );
  let start = Math.max(0, selectedEntryIndex - Math.floor(maxRows / 2));
  let end = Math.min(all.length, start + maxRows);
  start = Math.max(0, end - maxRows);
  // Never start with an orphaned item whose group heading is one row above.
  if (start > 0 && all[start]?.kind === "item" && all[start - 1]?.kind === "heading") {
    start -= 1;
    end = Math.min(all.length, start + maxRows);
  }
  return {
    entries: all.slice(start, end),
    hiddenBefore: start,
    hiddenAfter: all.length - end,
  };
}

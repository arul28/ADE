import type {
  AttentionItem,
  AttentionSnapshot,
} from "../../../desktop/src/shared/types/attention";
import {
  ATTENTION_CONTRACT_VERSION,
  attentionDestinationDeepLink,
  sortAttentionItems,
} from "../../../desktop/src/shared/types/attention";
import type { AdeCodeConnection } from "./types";

export type AttentionPaneGroupId =
  | "needs-you"
  | "failing"
  | "done"
  | "live"
  | "recent";

export type AttentionPaneGroup = {
  id: AttentionPaneGroupId;
  label: string;
  items: AttentionItem[];
};

export type AttentionPaneModel = {
  snapshot: AttentionSnapshot;
  groups: AttentionPaneGroup[];
  items: AttentionItem[];
  title: string;
  message: string;
  recovery: NonNullable<AttentionSnapshot["availability"]>["recovery"];
  waitingCount: number;
  liveCount: number;
};

export type AttentionPaneEntry =
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

function isUnsupportedAttentionError(error: unknown): boolean {
  return /unknown (?:ade )?action|unknown attention action|method not found|unsupported.*attention|attention\.call.*not (?:available|found)/i
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
 * Reads account Attention from the machine-global RPC rather than from the
 * TUI's selected project action scope. A signed-out or temporarily unavailable
 * account falls back to this connected machine without pretending that the
 * result is account-wide.
 */
export async function loadAttentionSnapshot(
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
      if (isUnsupportedAttentionError(error)) {
        return emptySnapshot({
          state: "incompatible",
          title: `Update ${hostName}`,
          message:
            "This host cannot provide machine Attention yet. Update ADE, restart its brain, then retry.",
          recovery: "update_host",
          hostName,
        });
      }
      return emptySnapshot({
        state: "unavailable",
        title: "Machine Attention is unavailable",
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
        title: "Account Attention",
        message: "Live across your ADE account.",
        recovery: null,
      },
    };
  } catch (error) {
    const hostName = options.hostName?.trim() || "this ADE host";
    if (isUnsupportedAttentionError(error)) {
      try {
        return await machineFallback(connection, {
          state: "incompatible",
          title: `Update ${hostName}`,
          message: "This host cannot read account-wide Attention yet. Update ADE, then restart its brain. Local work remains available.",
          recovery: "update_host",
          hostName,
        });
      } catch {
        return emptySnapshot({
          state: "incompatible",
          title: `Update ${hostName}`,
          message:
            "This host cannot provide Attention yet. Update ADE, restart its brain, then retry.",
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
        title: "Attention is unavailable",
        message:
          "ADE Code could not read the account stream or this host. Reconnect to the host, then retry.",
        recovery: "retry",
        hostName: options.hostName ?? null,
      });
    }
  }
}

export async function acknowledgeAttentionItem(
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

function groupForItem(item: AttentionItem): AttentionPaneGroupId {
  if (item.phase === "needs_you" || item.phase === "review_requested" || item.phase === "merge_ready") {
    return "needs-you";
  }
  if (
    item.phase === "failed"
    || item.phase === "blocked"
    || item.phase === "checks_failing"
    || item.phase === "changes_requested"
  ) {
    return "failing";
  }
  if ((item.phase === "completed" || item.phase === "merged") && item.seenAt === null) {
    return "done";
  }
  if (item.phase === "starting" || item.phase === "running") {
    return "live";
  }
  return "recent";
}

const GROUP_LABELS: Record<AttentionPaneGroupId, string> = {
  "needs-you": "NEEDS YOU",
  failing: "FAILING OR BLOCKED",
  done: "DONE, UNREVIEWED",
  live: "LIVE NOW",
  recent: "RECENT",
};

export function buildAttentionPaneModel(snapshot: AttentionSnapshot): AttentionPaneModel {
  const visible = sortAttentionItems(
    snapshot.items.filter((item) => item.dismissedAt === null),
  );
  const buckets = new Map<AttentionPaneGroupId, AttentionItem[]>();
  for (const item of visible) {
    const group = groupForItem(item);
    const bucket = buckets.get(group) ?? [];
    bucket.push(item);
    buckets.set(group, bucket);
  }
  const order: AttentionPaneGroupId[] = ["needs-you", "failing", "done", "live", "recent"];
  const groups = order
    .map((id): AttentionPaneGroup => ({
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
    title: snapshot.scope === "machine" ? "This machine only" : "Account Attention",
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

export function attentionItemDeepLink(item: AttentionItem): string {
  return attentionDestinationDeepLink(item.destination, item);
}

export function attentionItemContext(item: AttentionItem): string {
  return [item.project.name, item.laneName, item.machine.name]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(" · ");
}

export function attentionPaneEntries(
  model: AttentionPaneModel,
  selectedIndex: number,
  maxRows = 20,
): { entries: AttentionPaneEntry[]; hiddenBefore: number; hiddenAfter: number } {
  const all: AttentionPaneEntry[] = [];
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

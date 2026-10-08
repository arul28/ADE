import type {
  AttentionItem,
  AttentionSnapshot,
} from "../../../desktop/src/shared/types/attention";
import {
  ATTENTION_CONTRACT_VERSION,
  attentionDestinationDeepLink,
} from "../../../desktop/src/shared/types/attention";
import { activityBoardColumn } from "../../../desktop/src/shared/attention/activityBoardColumn";
import {
  ACTIVITY_COLUMN_PRESENTATION,
  ACTIVITY_COLUMNS,
  activityItemFailed,
  activityWaitingReasonLabel,
  type ActivityColumn,
} from "../../../desktop/src/renderer/components/activity/activityPresentation";
import {
  activityNotificationItems,
  activitySectionCounts,
  activitySections,
} from "../../../desktop/src/renderer/components/activity/activityPriority";
import type { AdeAccountSessionState } from "../../../desktop/src/shared/types/account";
import {
  describeReconnectOutcome,
  readReconnectResult,
  reconnectNeedsFreshSignIn,
} from "../../../desktop/src/shared/reconnectOutcome";
import { formatRelativePastTime } from "./relativeTime";
import type { AdeCodeConnection } from "./types";

export type ActivityPaneGroupId = ActivityColumn | "notifications";

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
  /** The chip in force: null is All. */
  column: ActivityColumn | null;
  /** Agents per column, unaffected by the chip so every chip keeps its count. */
  counts: Record<ActivityColumn, number>;
  /** Done rows folded into one line under All; 0 when Done is listed. */
  foldedDoneCount: number;
};

export type ActivityPaneEntry =
  | { kind: "heading"; key: string; label: string }
  | { kind: "item"; key: string; item: AttentionItem; itemIndex: number }
  | { kind: "fold"; key: string; label: string };

type AccountStatus = {
  signedIn: boolean;
  sessionState: AdeAccountSessionState;
};

/**
 * Derive the session state from an `account.call status` result. Prefers the
 * daemon's own `sessionState`; hosts older than that field only report
 * `sessionReadState`, and anything reporting neither is a plain sign-out.
 */
export function accountSessionStateFromResult(
  result: Record<string, unknown>,
): AdeAccountSessionState {
  if (result.signedIn === true) return "active";
  const state = typeof result.sessionState === "string" ? result.sessionState : "";
  if (state === "signed_out" || state === "expired" || state === "unreadable") {
    return state;
  }
  return result.sessionReadState === "unreadable" ? "unreadable" : "signed_out";
}

/**
 * The one line the header shows for a session that is not active. "unreadable"
 * never suggests `ade login`: signing in overwrites the stored session, so a
 * user who signs in to escape a bad read destroys the session that was fine.
 */
export function accountSessionLabel(state: AdeAccountSessionState): string | null {
  if (state === "signed_out") return "account signed out · ade login";
  if (state === "expired") return "account sign-in expired · ade login";
  if (state === "unreadable") return "account sign-in unreadable · retry";
  return null;
}

/**
 * The notice `/reconnect` shows for a `repairMachinePairing` result.
 *
 * The person is signed in here, so a refusal that wants proof of a fresh
 * sign-in says "confirm it's you", never "sign in again". ADE Code cannot
 * host the browser step, so it names the command that runs it.
 */
export function reconnectOutcomeNotice(
  value: unknown,
): { message: string; kind: "success" | "info" | "error" } {
  const result = readReconnectResult(value);
  if (!result) {
    return { kind: "error", message: "Couldn't reconnect this computer: the brain gave no result." };
  }
  if (reconnectNeedsFreshSignIn(result)) {
    return {
      kind: "error",
      message:
        "Confirm it's you in your browser to reconnect this computer. Run `ade machines reconnect` in a terminal to open the confirmation.",
    };
  }
  const outcome = describeReconnectOutcome(result);
  // The notice has no warning tone. "Back on your account but not delivering
  // yet" is unfinished, so it is info, not a success.
  const kind = outcome.tone === "danger" ? "error" : outcome.tone === "warning" ? "info" : "success";
  return { kind, message: outcome.message };
}

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
    return {
      signedIn: result.signedIn === true,
      sessionState: accountSessionStateFromResult(result),
    };
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
    // An unreadable session is not a sign-out. Telling the user to run
    // `ade login` over a session that merely could not be read is how a valid
    // session gets overwritten, so that case asks for a retry instead.
    const unreadable = status.sessionState === "unreadable";
    try {
      return await machineFallback(connection, {
        state: unreadable ? "degraded" : "signed_out",
        title: "This machine only",
        message: unreadable
          ? "ADE couldn't read this computer's sign-in — your session is still there. Try again in a moment."
          : status.sessionState === "expired"
            ? "Your ADE sign-in expired. Run `ade login` to see every ADE machine. Local work remains available."
            : "Run `ade login` to see every ADE machine. Local work remains available.",
        recovery: unreadable ? "retry" : "sign_in",
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
 * The chips, in key order: 0 is All, 1–4 the Work board's four columns. The
 * same five chips the desktop and phone panels show.
 */
export const ACTIVITY_PANE_CHIPS: readonly (ActivityColumn | null)[] = [null, ...ACTIVITY_COLUMNS];

/** The chip a digit key selects, or undefined for any other key. */
export function activityPaneChipForKey(input: string): ActivityColumn | null | undefined {
  if (!/^[0-4]$/.test(input)) return undefined;
  return ACTIVITY_PANE_CHIPS[Number(input)];
}

/**
 * Terminal mark for one Activity row, keyed off its column. A failed agent
 * sits under Needs you with its own red cross, like the desktop's red mark.
 * Tone names are TUI tokens, not desktop hues.
 */
export type ActivityPaneMarkTone =
  | "attention"
  | "error"
  | "running"
  | "neutral"
  | "done";

export type ActivityPaneMark = {
  column: ActivityColumn | null;
  glyph: string;
  tone: ActivityPaneMarkTone;
};

export const ACTIVITY_PANE_MARK_BY_COLUMN = {
  needs_you: { glyph: "!", tone: "attention" },
  working: { glyph: "●", tone: "running" },
  waiting: { glyph: "‖", tone: "neutral" },
  done: { glyph: "✓", tone: "done" },
} as const satisfies Record<ActivityColumn, Omit<ActivityPaneMark, "column">>;

export function activityItemMark(item: AttentionItem): ActivityPaneMark {
  const column = activityBoardColumn(item);
  if (!column) return { column: null, glyph: "◇", tone: "neutral" };
  if (activityItemFailed(item)) return { column, glyph: "×", tone: "error" };
  return { column, ...ACTIVITY_PANE_MARK_BY_COLUMN[column] };
}

const GROUP_LABELS: Record<ActivityPaneGroupId, string> = {
  needs_you: "NEEDS YOU",
  working: "WORKING",
  waiting: "WAITING",
  done: "DONE",
  notifications: "NOTIFICATIONS",
};

export function buildActivityPaneModel(
  snapshot: AttentionSnapshot,
  options: { column?: ActivityColumn | null; now?: number } = {},
): ActivityPaneModel {
  const now = options.now ?? Date.now();
  const column = options.column ?? null;
  // Activity is an AGENT feed on every surface. Pull requests, checks and
  // review outcomes still arrive — they push and badge — but they are not
  // session rows, so they sit in their own notification tail and are never
  // counted in a column. `activitySections` / `activityNotificationItems` are
  // the same split the desktop panel uses, and they drop dismissed and expired
  // rows.
  const sections = activitySections(snapshot.items, now);
  const counts = activitySectionCounts(sections);
  // Done folds into one line under All, as it does on desktop and the phone:
  // it is the most common state and the least urgent one. Picking the Done
  // chip lists it.
  const foldedDoneCount = column === null ? counts.done : 0;
  const groups: ActivityPaneGroup[] = sections
    .filter((section) => (column ? section.id === column : section.id !== "done"))
    .map((section) => ({ id: section.id, label: GROUP_LABELS[section.id], items: section.items }));
  if (column === null) {
    groups.push({
      id: "notifications",
      label: GROUP_LABELS.notifications,
      items: activityNotificationItems(snapshot.items, now),
    });
  }
  const populated = groups.filter((group) => group.items.length > 0);
  const items = populated.flatMap((group) => group.items);
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
    groups: populated,
    items,
    title: availability.title,
    message: availability.message,
    recovery: availability.recovery,
    column,
    counts,
    foldedDoneCount,
  };
}

/** "All 12 · Needs you 2 · Working 5 · Waiting 1 · Done 4", one entry per chip. */
export function activityPaneChips(
  model: ActivityPaneModel,
): { key: string; label: string; count: number; selected: boolean }[] {
  const total = ACTIVITY_COLUMNS.reduce((sum, id) => sum + model.counts[id], 0);
  return ACTIVITY_PANE_CHIPS.map((chip, index) => ({
    key: String(index),
    label: chip ? ACTIVITY_COLUMN_PRESENTATION[chip].label : "All",
    count: chip ? model.counts[chip] : total,
    selected: model.column === chip,
  }));
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
  return [activityWaitingReasonLabel(item), item.project.name, item.laneName, item.machine.name]
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
    // Done folds in below the live columns, ahead of the notification tail.
    if (group.id === "notifications" && model.foldedDoneCount > 0) {
      all.push({ kind: "fold", key: "fold:done", label: `✓ ${model.foldedDoneCount} done · 4 to show` });
    }
    all.push({ kind: "heading", key: `heading:${group.id}`, label: group.label });
    for (const item of group.items) {
      all.push({ kind: "item", key: item.id, item, itemIndex });
      itemIndex += 1;
    }
  }
  if (model.foldedDoneCount > 0 && !model.groups.some((group) => group.id === "notifications")) {
    all.push({ kind: "fold", key: "fold:done", label: `✓ ${model.foldedDoneCount} done · 4 to show` });
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

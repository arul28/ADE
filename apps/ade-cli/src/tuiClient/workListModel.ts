/**
 * The pure model behind ADE Code's sessions pane: rows → lane groups → shelves.
 *
 * This is the TUI half of the desktop Work list. Everything that decides WHAT a
 * row says is imported from the desktop tree rather than re-derived here — the
 * canonical state machine, the presentation vocabulary (label/tone/glyph/
 * elapsed), the filing rule, the snooze overlay, the label and relative-time
 * helpers, and the lane ordering. All of them are React-free, and the CLI has
 * imported renderer modules on exactly this basis since `activityPane.ts`.
 *
 * What is reimplemented is the SHAPE of the list: the desktop's group model
 * lives inside a 2136-line React hook, and its rendering assumes a mouse and a
 * DOM. This module produces a flat, ordered row list instead — the one thing an
 * arrow-key surface and a row-based hit test both need — and `workListLayout.ts`
 * turns that into terminal geometry.
 *
 * Pure: no React, no I/O, no clock beyond the injectable `nowMs`.
 */

import type { LaneSummary } from "../../../desktop/src/shared/types/lanes";
import type { TerminalSessionSummary } from "../../../desktop/src/shared/types/sessions";
import type { AttentionItem } from "../../../desktop/src/shared/types/attention";
import {
  canonicalStatusBucket,
  isSessionFiledAsSnoozed,
} from "../../../desktop/src/shared/sessionCanonicalState";
import {
  formatWorkingDuration,
  sessionStatusPresentation,
  type SessionStatusGlyph,
  type SessionStatusPresentation,
  type SessionStatusTone,
} from "../../../desktop/src/shared/sessionStatusPresentation";
import {
  canonicalInputFromSummary,
  sessionCanonicalUiState,
  sessionStatusDisplay,
  sessionFilingBucket,
  type SessionFilingBucket,
} from "../../../desktop/src/renderer/lib/terminalAttention";
import { primarySessionLabel } from "../../../desktop/src/renderer/lib/sessions";
import { snoozeWakeLabel, sessionWokeMarker } from "../../../desktop/src/renderer/lib/sessionSnooze";
import { relativeTimeCompact } from "../../../desktop/src/renderer/lib/format";
import {
  orderWorkLanes,
  workLaneTier,
  type WorkLaneOrderInput,
  type WorkLaneSortMode,
  type WorkLaneTier,
} from "../../../desktop/src/renderer/components/terminals/workLaneOrder";
import { ACTIVITY_STATE_GLYPHS, activityStateGroup } from "../../../desktop/src/renderer/components/activity/activityPresentation";
import type { TuiChatSessionSummary } from "./adeApi";
import type { AdeCodeProvider } from "./types";
import { getPreviewLine, partitionQuietSessions, toWorkSessionSummary, type SessionPreviewLine } from "./workRow";

export type WorkListShelfKind = "snoozed" | "settled";

/** Identity of the machine a row came from. Null on rows from this machine. */
export type WorkListMachineRef = {
  machineKey: string;
  accountMachineKey?: string | null;
  deviceId?: string | null;
  name: string;
  online: boolean;
  lastSeenAt: string | null;
};

export type WorkListSessionRow = {
  kind: "session";
  key: string;
  sessionId: string;
  laneId: string | null;
  laneName: string | null;
  /** Null for rows on this machine; set (and chipped) for every foreign row. */
  machine: WorkListMachineRef | null;
  title: string;
  /** Null exactly when the row is settled — the shelf it sits in IS its status. */
  status: SessionStatusPresentation | null;
  tone: SessionStatusTone;
  glyph: SessionStatusGlyph;
  /** "8m" tail for `showsElapsed` presentations; null otherwise. */
  elapsedLabel: string | null;
  /** Settled rows show this where a status word would go. */
  timestampLabel: string | null;
  preview: SessionPreviewLine | null;
  /** Compact age ("now"/"12h"), anchored on last activity. Line 1 left on grouped cards. */
  ageLabel: string;
  /** Raw anchor behind `ageLabel`; lane ordering needs the number, not the word. */
  activityAt: string | null;
  provider: AdeCodeProvider | null;
  hasDraft: boolean;
  filing: SessionFilingBucket;
  /** The chat currently open in the center pane. */
  isActiveSession: boolean;
  /**
   * The text-only lifecycle marker, present alongside colour so the pane still
   * says what it means in a terminal with no colour at all: `z` snoozed,
   * `*` woke, `done` settled.
   */
  marker: string | null;
  /**
   * Desktop singleton card: no lane header above this row; line 1 carries the
   * lane icon + name instead of the relative timestamp.
   */
  showLaneIdentity: boolean;
  laneColor: string | null;
  laneIcon: string | null;
  /** Present on foreign rows so a hop can open the same project on that machine. */
  projectCanonicalId?: string | null;
  projectRootPath?: string | null;
};

export type WorkListLaneHeaderRow = {
  kind: "lane-header";
  key: string;
  laneId: string | null;
  label: string;
  color: string | null;
  icon: string | null;
  tier: WorkLaneTier;
  machine: WorkListMachineRef | null;
  sessionCount: number;
  /** "last seen 2h" for an offline foreign group; null otherwise. */
  lastSeenLabel: string | null;
  worktreeAvailable: boolean;
};

export type WorkListNewChatRow = {
  kind: "new-chat";
  key: string;
  laneId: string;
};

export type WorkListShelfRow = {
  kind: "shelf";
  key: string;
  shelf: WorkListShelfKind;
  count: number;
  expanded: boolean;
};

export type WorkListRow =
  | WorkListLaneHeaderRow
  | WorkListSessionRow
  | WorkListNewChatRow
  | WorkListShelfRow;

export type WorkListGroup = {
  header: WorkListLaneHeaderRow;
  sessions: WorkListSessionRow[];
  newChat: WorkListNewChatRow | null;
};

export type WorkListModel = {
  /** Flat, ordered, exactly what is on screen — arrow keys walk this. */
  rows: WorkListRow[];
  groups: WorkListGroup[];
  snoozed: WorkListSessionRow[];
  settled: WorkListSessionRow[];
};

export type WorkListInput = {
  lanes: readonly LaneSummary[];
  sessions: readonly TuiChatSessionSummary[];
  /**
   * Attention rows for OTHER machines, first-pass cross-machine source. The
   * caller filters the snapshot (project + machine); this module only shapes
   * them. See `foreignRowsFromAttention`.
   */
  foreign?: readonly WorkListForeignSession[];
  activeSessionId: string | null;
  /** Sessions holding an unsent composer draft, for the pencil indicator. */
  draftSessionIds?: ReadonlySet<string>;
  expandedShelves?: ReadonlySet<WorkListShelfKind>;
  unavailableLaneIds?: ReadonlySet<string>;
  laneSortMode?: WorkLaneSortMode;
  laneManualOrder?: readonly string[];
  /** Suppress the per-lane "+ new chat" affordance (add-to-grid picker mode). */
  hideNewChat?: boolean;
  nowMs?: number;
};

/** A row sourced from another machine, already narrowed to the active project. */
export type WorkListForeignSession = {
  sessionId: string;
  machine: WorkListMachineRef;
  laneId: string | null;
  laneName: string | null;
  title: string;
  preview: string | null;
  provider: string | null;
  /** Canonical presentation, derived from the attention phase. */
  status: SessionStatusPresentation;
  lastActivityAt: string | null;
  projectCanonicalId?: string | null;
  projectRootPath?: string | null;
};

function compareSessionRows(left: WorkListSessionRow, right: WorkListSessionRow): number {
  const leftMs = parseMs(left.activityAt) ?? 0;
  const rightMs = parseMs(right.activityAt) ?? 0;
  if (leftMs !== rightMs) return rightMs - leftMs;
  return left.sessionId.localeCompare(right.sessionId);
}

function decorateShelfRows(
  shelfRows: WorkListSessionRow[],
  orderedLaneIds: readonly string[],
  laneById: Map<string, LaneSummary>,
  sortMode: WorkLaneSortMode,
): WorkListRow[] {
  const byLane = new Map<string, WorkListSessionRow[]>();
  const orphans: WorkListSessionRow[] = [];
  for (const row of shelfRows) {
    if (!row.laneId) {
      orphans.push(row);
      continue;
    }
    const list = byLane.get(row.laneId) ?? [];
    list.push(row);
    byLane.set(row.laneId, list);
  }

  const out: WorkListRow[] = [];
  const emitLane = (laneId: string) => {
    const list = (byLane.get(laneId) ?? []).sort(compareSessionRows);
    if (list.length === 0) return;
    byLane.delete(laneId);
    const lane = laneById.get(laneId);
    const headerless = list.length === 1 && sortMode !== "manual";
    const sessions = list.map((row) => ({
      ...row,
      showLaneIdentity: headerless,
      laneName: lane?.name ?? row.laneName,
      laneColor: lane?.color ?? row.laneColor,
      laneIcon: lane?.icon ?? row.laneIcon,
    }));
    if (!headerless && lane) {
      out.push({
        kind: "lane-header",
        key: `shelf-lane:${laneId}`,
        laneId,
        label: lane.name,
        color: lane.color ?? null,
        icon: lane.icon ?? null,
        tier: "quiet",
        machine: null,
        sessionCount: list.length,
        lastSeenLabel: null,
        worktreeAvailable: true,
      });
    }
    out.push(...sessions);
  };

  for (const laneId of orderedLaneIds) emitLane(laneId);
  for (const laneId of [...byLane.keys()]) emitLane(laneId);
  out.push(...orphans);
  return out;
}

function parseMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * The elapsed anchor, mirroring `SessionStatusSlot` (:91-93): a running row
 * counts from the start of its TURN, everything else from its last activity.
 * Counting from last output for a CLI repainting its TUI resets every few
 * seconds and reports a five-minute turn as "2s".
 */
function elapsedAnchor(session: TerminalSessionSummary, phase: string): string | null {
  return phase === "running"
    ? session.currentTurnStartedAt ?? session.lastActivityAt ?? session.startedAt
    : session.lastActivityAt ?? session.startedAt;
}

/**
 * The one text marker a row carries, in the same precedence the shared modules
 * file it under. Colour repeats this information; the text is what survives a
 * monochrome terminal.
 */
function textMarker(session: TerminalSessionSummary, filing: SessionFilingBucket, nowMs: number): string | null {
  if (filing === "snoozed") return "z";
  if (filing === "settled") return "done";
  return sessionWokeMarker(session, nowMs) ? "*" : null;
}

function providerOf(session: TuiChatSessionSummary): AdeCodeProvider | null {
  return (session.provider as AdeCodeProvider) ?? null;
}

function buildSessionRow(args: {
  session: TuiChatSessionSummary;
  laneName: string | null;
  activeSessionId: string | null;
  draftSessionIds: ReadonlySet<string>;
  nowMs: number;
}): WorkListSessionRow {
  const summary = toWorkSessionSummary(args.session, args.laneName);
  const input = canonicalInputFromSummary(summary);
  const phase = sessionCanonicalUiState({ ...input, nowMs: args.nowMs }).phase;
  const filing = sessionFilingBucket(summary, args.nowMs);
  const snoozed = isSessionFiledAsSnoozed(summary, phase, args.nowMs);
  const woke = !snoozed && sessionWokeMarker(summary, args.nowMs) !== null;
  const status = sessionStatusDisplay(
    { ...input, nowMs: args.nowMs },
    {
      snoozed,
      woke,
      snoozeWakeLabel: snoozed ? snoozeWakeLabel(summary.snoozedUntil, args.nowMs) : null,
    },
  );
  const settled = canonicalStatusBucket(phase) === "settled";
  const title = primarySessionLabel(summary);
  const anchorMs = parseMs(elapsedAnchor(summary, phase));
  return {
    kind: "session",
    key: `session:${args.session.sessionId}`,
    sessionId: args.session.sessionId,
    laneId: args.session.laneId,
    laneName: args.laneName,
    machine: null,
    title,
    status,
    tone: status?.tone ?? "neutral",
    glyph: status?.glyph ?? null,
    elapsedLabel: status?.showsElapsed && anchorMs != null
      ? formatWorkingDuration(Math.max(0, args.nowMs - anchorMs))
      : null,
    // Settled rows swap the status word for when they ended — the only fact in
    // the tail worth reading.
    timestampLabel: status === null
      ? relativeTimeCompact(summary.endedAt ?? summary.startedAt)
      : null,
    preview: getPreviewLine(summary, title, settled),
    ageLabel: relativeTimeCompact(summary.lastActivityAt ?? summary.startedAt),
    activityAt: summary.lastActivityAt ?? summary.startedAt ?? null,
    provider: providerOf(args.session),
    hasDraft: args.draftSessionIds.has(args.session.sessionId),
    filing,
    isActiveSession: args.session.sessionId === args.activeSessionId,
    marker: textMarker(summary, filing, args.nowMs),
    showLaneIdentity: false,
    laneColor: null,
    laneIcon: null,
  };
}

function buildForeignRow(foreign: WorkListForeignSession): WorkListSessionRow {
  return {
    kind: "session",
    key: `foreign:${foreign.machine.machineKey}:${foreign.sessionId}`,
    sessionId: foreign.sessionId,
    laneId: foreign.laneId,
    laneName: foreign.laneName,
    machine: foreign.machine,
    title: foreign.title,
    status: foreign.status,
    tone: foreign.status.tone,
    glyph: foreign.status.glyph,
    // The attention snapshot has no turn anchor, so a foreign row shows its age
    // rather than inventing an elapsed it cannot measure.
    elapsedLabel: null,
    timestampLabel: null,
    preview: foreign.preview
      ? { text: foreign.preview, linkify: false, source: "output" }
      : null,
    ageLabel: relativeTimeCompact(foreign.lastActivityAt),
    activityAt: foreign.lastActivityAt,
    provider: (foreign.provider as AdeCodeProvider) ?? null,
    hasDraft: false,
    filing: "running",
    isActiveSession: false,
    marker: null,
    showLaneIdentity: false,
    laneColor: null,
    laneIcon: null,
    projectCanonicalId: foreign.projectCanonicalId ?? null,
    projectRootPath: foreign.projectRootPath ?? null,
  };
}

/**
 * Which machine key is us, inferred from the items that point at sessions this
 * machine already has. Null when the snapshot contains none of our sessions —
 * in which case the `localSessionIds` filter alone still prevents duplicates.
 */
export function thisMachineKeyFromItems(
  items: readonly AttentionItem[],
  localSessionIds: ReadonlySet<string>,
): string | null {
  // A snapshot from an older/degraded publisher can arrive without `items`;
  // the pane must dim, not crash the whole TUI render.
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    if (item?.destination?.kind !== "session") continue;
    if (!localSessionIds.has(item.destination.sessionId)) continue;
    const key = item.machine?.machineKey;
    if (key) return key;
  }
  return null;
}

/**
 * Project attention items onto foreign session rows.
 *
 * Scope join is `AttentionProjectRef.canonicalId` (`deriveProjectId(rootPath)`)
 * because a publisher's own `projectId` is a per-machine UUID that means nothing
 * anywhere else; `rootPath` is the documented fallback for older publishers.
 * A row is foreign when its machine key differs from this machine's — never
 * merely because it is unknown locally, or a chat this machine has not
 * projected yet would masquerade as remote work.
 */
export function foreignRowsFromAttention(args: {
  items: readonly AttentionItem[];
  projectCanonicalId: string | null;
  projectRootPath?: string | null;
  /**
   * Session ids this machine already renders. Doubles as the machine-identity
   * probe: a session id is a per-machine UUID, so the machine publishing an item
   * about a LOCAL session is by definition this machine. That makes an extra
   * `machineInfo.get` round trip unnecessary and — more importantly — means a
   * local chat can never also appear as a remote row while identity is unknown.
   */
  localSessionIds: ReadonlySet<string>;
}): WorkListForeignSession[] {
  if (!Array.isArray(args.items)) return [];
  const thisMachineKey = thisMachineKeyFromItems(args.items, args.localSessionIds);
  const rows: WorkListForeignSession[] = [];
  const seen = new Set<string>();
  for (const item of args.items) {
    if (item?.kind !== "agent") continue;
    if (item.destination?.kind !== "session") continue;
    if (args.localSessionIds.has(item.destination.sessionId)) continue;
    const machineKey = item.machine?.machineKey;
    if (!machineKey) continue;
    if (thisMachineKey && machineKey === thisMachineKey) continue;
    const canonical = item.project?.canonicalId ?? null;
    const rootPath = item.project?.rootPath ?? null;
    const matchesProject = args.projectCanonicalId != null && canonical != null
      ? canonical === args.projectCanonicalId
      : Boolean(args.projectRootPath && rootPath && rootPath === args.projectRootPath);
    if (!matchesProject) continue;
    const sessionId = item.destination.sessionId;
    const dedupeKey = `${machineKey}:${sessionId}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const glyph = ACTIVITY_STATE_GLYPHS[activityStateGroup(item)];
    rows.push({
      sessionId,
      machine: {
        machineKey,
        accountMachineKey: item.machine.accountMachineKey ?? null,
        deviceId: item.machine.deviceId ?? null,
        name: item.machine.name || machineKey,
        online: item.machine.online !== false,
        lastSeenAt: item.machine.lastSeenAt ?? null,
      },
      laneId: item.laneId ?? null,
      laneName: item.laneName ?? null,
      title: item.title?.trim() || sessionId,
      preview: item.preview?.trim() || null,
      provider: item.provider ?? null,
      status: {
        label: glyph.label,
        // `ACTIVITY_STATE_GLYPHS` only ever names the five session hues, so the
        // narrowing below cannot lose a tone; it exists because AttentionTone
        // also carries two PR-only hues this pane never receives.
        tone: glyph.tone as SessionStatusTone,
        glyph: glyph.glyph,
        showsElapsed: false,
        prominent: glyph.tone === "amber" || glyph.tone === "red",
      },
      lastActivityAt: item.statusSince ?? item.updatedAt ?? null,
      projectCanonicalId: canonical,
      projectRootPath: rootPath,
    });
  }
  return rows;
}

/** Foreign group id for rows whose lane has no local counterpart. */
function foreignGroupKey(machineKey: string): string {
  return `machine:${machineKey}`;
}

export function buildWorkListModel(input: WorkListInput): WorkListModel {
  const nowMs = input.nowMs ?? Date.now();
  const draftSessionIds = input.draftSessionIds ?? new Set<string>();
  const expandedShelves = input.expandedShelves ?? new Set<WorkListShelfKind>();
  const unavailableLaneIds = input.unavailableLaneIds ?? new Set<string>();
  const laneById = new Map(input.lanes.map((lane) => [lane.id, lane] as const));

  const rowsBySession = input.sessions.map((session) => buildSessionRow({
    session,
    laneName: laneById.get(session.laneId)?.name ?? null,
    activeSessionId: input.activeSessionId,
    draftSessionIds,
    nowMs,
  }));

  // Quiet partition uses the shared filing rule, so a row's shelf and its status
  // word can never disagree.
  const active: WorkListSessionRow[] = [];
  const snoozed: WorkListSessionRow[] = [];
  const settled: WorkListSessionRow[] = [];
  for (const row of rowsBySession) {
    if (row.filing === "snoozed") snoozed.push(row);
    else if (row.filing === "settled") settled.push(row);
    else active.push(row);
  }

  const foreignRows = (input.foreign ?? []).map(buildForeignRow);
  const laneNameIndex = new Map<string, LaneSummary>();
  for (const lane of input.lanes) laneNameIndex.set(lane.name.toLowerCase(), lane);

  const foreignByLaneId = new Map<string, WorkListSessionRow[]>();
  const foreignByMachine = new Map<string, WorkListSessionRow[]>();
  for (const row of foreignRows) {
    // A foreign lane joins a local group only by NAME: lane ids are minted per
    // machine, so id equality across machines is coincidence, not identity.
    const localLane = row.laneName ? laneNameIndex.get(row.laneName.toLowerCase()) ?? null : null;
    if (localLane) {
      const list = foreignByLaneId.get(localLane.id) ?? [];
      list.push(row);
      foreignByLaneId.set(localLane.id, list);
    } else {
      const key = row.machine!.machineKey;
      const list = foreignByMachine.get(key) ?? [];
      list.push(row);
      foreignByMachine.set(key, list);
    }
  }

  const localByLane = new Map<string, WorkListSessionRow[]>();
  for (const row of active) {
    if (!row.laneId) continue;
    const list = localByLane.get(row.laneId) ?? [];
    list.push(row);
    localByLane.set(row.laneId, list);
  }

  const orderInputs = input.lanes.map((lane) => {
    const laneRows = localByLane.get(lane.id) ?? [];
    const quiet = laneRows.length === 0;
    const lastActivityMs = laneRows.reduce<number | null>((latest, row) => {
      const parsed = parseMs(row.activityAt);
      return parsed != null && (latest == null || parsed > latest) ? parsed : latest;
    }, null);
    return {
      id: lane.id,
      name: lane.name,
      laneType: lane.laneType ?? "worktree",
      createdAt: lane.createdAt ?? "",
      lastActivityMs,
      quiet,
      pinned: false,
    } satisfies WorkLaneOrderInput;
  });
  const orderedLaneIds = orderWorkLanes(
    orderInputs,
    input.laneSortMode ?? "activity",
    input.laneManualOrder ?? [],
  ).map((entry) => entry.id);

  const groups: WorkListGroup[] = [];
  const rows: WorkListRow[] = [];

  for (const laneId of orderedLaneIds) {
    const lane = laneById.get(laneId);
    if (!lane) continue;
    const laneRows = [...(localByLane.get(laneId) ?? []), ...(foreignByLaneId.get(laneId) ?? [])]
      .sort(compareSessionRows);
    const worktreeAvailable = !unavailableLaneIds.has(laneId);
    const orderInput = orderInputs.find((entry) => entry.id === laneId)!;
    const header: WorkListLaneHeaderRow = {
      kind: "lane-header",
      key: `lane:${laneId}`,
      laneId,
      label: lane.name,
      color: lane.color ?? null,
      icon: lane.icon ?? null,
      tier: workLaneTier(orderInput),
      machine: null,
      sessionCount: laneRows.length,
      lastSeenLabel: null,
      worktreeAvailable,
    };
    const headerless = laneRows.length === 1
      && (input.laneSortMode ?? "activity") !== "manual"
      && worktreeAvailable;
    const sessions = laneRows.map((row) => ({
      ...row,
      showLaneIdentity: headerless,
      laneColor: lane.color ?? null,
      laneIcon: lane.icon ?? null,
    }));
    groups.push({ header, sessions, newChat: null });
    // Fully-quiet lanes have no live rows. Desktop files them under
    // snoozed/settled; emitting an empty header here duplicated the lane name
    // above those shelves. Keep a header only when the worktree is gone, so
    // the missing folder is still visible.
    if (laneRows.length === 0) {
      if (!worktreeAvailable) rows.push(header);
      continue;
    }
    if (!headerless) rows.push(header);
    rows.push(...sessions);
  }

  // Machines whose lanes have no local twin get their own dim group, so a
  // foreign row is never silently filed under an unrelated lane.
  for (const [machineKey, machineRows] of foreignByMachine) {
    const machine = machineRows[0]!.machine!;
    const header: WorkListLaneHeaderRow = {
      kind: "lane-header",
      key: foreignGroupKey(machineKey),
      laneId: null,
      label: machine.name,
      color: null,
      icon: null,
      tier: "quiet",
      machine,
      sessionCount: machineRows.length,
      lastSeenLabel: machine.online
        ? null
        : machine.lastSeenAt
          ? `last seen ${relativeTimeCompact(machine.lastSeenAt) || "a while ago"}`
          : "offline",
      worktreeAvailable: true,
    };
    const headerless = machine.online && machineRows.length === 1;
    const sessions = [...machineRows].sort(compareSessionRows).map((row) => ({
      ...row,
      showLaneIdentity: headerless,
      laneColor: row.laneColor,
      laneIcon: row.laneIcon,
    }));
    groups.push({ header, sessions, newChat: null });
    if (!headerless) rows.push(header);
    rows.push(...sessions);
  }

  for (const shelf of ["snoozed", "settled"] as const) {
    const shelfRows = shelf === "snoozed" ? snoozed : settled;
    if (shelfRows.length === 0) continue;
    const expanded = expandedShelves.has(shelf);
    const contents = decorateShelfRows(
      shelfRows,
      orderedLaneIds,
      laneById,
      input.laneSortMode ?? "activity",
    );
    rows.push({
      kind: "shelf",
      key: `shelf:${shelf}`,
      shelf,
      count: shelfRows.length,
      expanded,
    });
    if (expanded) rows.push(...contents);
  }

  return { rows, groups, snoozed, settled };
}

/** Index of a row by key, or -1. */
export function workListRowIndex(rows: readonly WorkListRow[], key: string | null): number {
  if (!key) return -1;
  return rows.findIndex((row) => row.key === key);
}

/**
 * Keep the pane's selection on a row that still exists.
 *
 * Replaces `resolveDrawerChatSelection`: the drawer had to reconcile three
 * pieces of state (lane, chat id, pseudo-action) against two modes, which is
 * why selection could land on a row that was not rendered. One key over one
 * flat row list has no such gap. Returns null when the current key is still
 * valid, so the caller can skip the state write.
 */
export function resolveWorkListSelection(args: {
  rows: readonly WorkListRow[];
  selectedKey: string | null;
  activeSessionId: string | null;
  /** A new-chat draft is open: prefer that lane's "+ new chat" row. */
  draftLaneId?: string | null;
}): { selectedKey: string | null } | null {
  if (args.selectedKey && args.rows.some((row) => row.key === args.selectedKey)) return null;
  const activeRow = args.rows.find(
    (row) => row.kind === "session" && row.machine === null && row.sessionId === args.activeSessionId,
  );
  if (activeRow) return { selectedKey: activeRow.key };
  if (args.draftLaneId) {
    const laneRow = args.rows.find(
      (row) => row.kind === "lane-header" && row.laneId === args.draftLaneId,
    );
    if (laneRow) return { selectedKey: laneRow.key };
    const laneSession = args.rows.find(
      (row) => row.kind === "session" && row.laneId === args.draftLaneId,
    );
    if (laneSession) return { selectedKey: laneSession.key };
  }
  const firstSession = args.rows.find((row) => row.kind === "session");
  return { selectedKey: firstSession?.key ?? args.rows[0]?.key ?? null };
}

/** Move the selection by `delta` visible rows, clamped at both ends. */
export function stepWorkListSelection(
  rows: readonly WorkListRow[],
  selectedKey: string | null,
  delta: number,
): string | null {
  if (rows.length === 0) return null;
  const current = workListRowIndex(rows, selectedKey);
  const start = current >= 0 ? current : 0;
  const next = Math.max(0, Math.min(rows.length - 1, start + delta));
  return rows[next]?.key ?? null;
}

/** The copy text for ⌘C-style "copy what is selected" on a session row. */
export function workListSelectionCopyText(
  rows: readonly WorkListRow[],
  selectedKey: string | null,
): string | null {
  const index = workListRowIndex(rows, selectedKey);
  const row = index >= 0 ? rows[index] : null;
  if (!row || row.kind !== "session") return null;
  return row.title.trim() || row.sessionId;
}

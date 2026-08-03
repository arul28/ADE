/**
 * The cross-machine Work union.
 *
 * The Work sidebar shows every chat in flight on *every* connected machine,
 * always — independent of which machine the project tab is bound to. The tab's
 * machine stays the global execution context (Lanes/PRs/Files/Git/Run); this
 * module only widens what the sidebar can *see*.
 *
 * Shape of the model, which everything here follows:
 * - A lane owns its machine (`lanes.worktree_path` is an absolute path on
 *   exactly one machine). Chats inherit their machine through `laneId`, so
 *   machines are tagged onto LANES and never onto chats.
 * - Machines are named absolutely (`THIS_MACHINE_NAME`, "MacBook Pro (97)").
 *   The word "remote" is never a machine name: once the tab's machine can
 *   change, "remote" has no fixed referent.
 * - A machine that drops is dimmed, not deleted. Its lanes and chats stay on
 *   screen, collapsed and inert, marked with the machine that owns them. Rows
 *   leave the sidebar for two reasons only: the machine is gone from the
 *   registry, or it has been unreachable for a full day.
 *
 * Performance shape: active-binding refreshes are event-driven. Other machines
 * do not have a renderer change feed, so one shared, ref-counted fallback
 * refresh keeps them current while the window is visible, and stops entirely
 * while it is not. Foreign reads are bounded, timed out,
 * generation-cancellable, and never gate the local list.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { remoteProjectBindingKey } from "../../shared/projectIdentity";
import type {
  AgentChatSession,
  LaneSummary,
  OpenProjectBinding,
  PrSummary,
  RecentProjectSummary,
  RemoteRuntimeConnectionSnapshot,
  RemoteRuntimeConnectionState,
  RemoteRuntimeConnectionStatus,
  TerminalSessionSummary,
} from "../../shared/types";
import { buildOptimisticChatSessionSummary } from "../lib/sessions";
import {
  THIS_MACHINE_ID,
  THIS_MACHINE_NAME,
} from "../../shared/machineIdentity";
import { normalizeGitRemoteIdentity } from "../../shared/crossMachineHandoff";
import {
  EMPTY_MACHINE_BRANCH_STATES,
  toMachineBranchState,
  type MachineBranchState,
} from "../../shared/laneDivergence";
import {
  deriveLaneMachineOptions,
  type LaneMachineOption,
} from "../components/lanes/laneMachines";
import {
  rootAppStoreApi,
  selectActiveProjectStateKey,
  useAppStore,
  useRootAppStore,
  type AppState,
  type CrossMachineMachineLanes,
} from "./appStore";

/** Coalescing window for burst-y event sources (lane lifecycle, session churn). */
const REFRESH_COALESCE_MS = 400;
/** A machine that stops answering must never stall the sidebar. */
const MACHINE_READ_TIMEOUT_MS = 8_000;
/** Upper bound on machines read at once, so ten paired machines can't fan out. */
const MAX_PARALLEL_MACHINE_READS = 4;
/**
 * Fallback change feed for machines other than the active binding, and only
 * while the window is visible. Chats are what move between ticks; see
 * `FOREIGN_LANE_REFRESH_MS` for why the lane read runs at its own, slower rate.
 */
const FOREIGN_MACHINE_REFRESH_MS = 10_000;
/**
 * How often a foreign machine's lane list is re-read. `lane.list` with
 * `includeStatus` resolves a git status and a worktree probe per lane and
 * writes a state snapshot row per lane, on the OTHER machine, every time. Lane
 * records themselves change on the scale of minutes, so paying that cost at the
 * chat cadence bought nothing; a chat that appears on a lane we have never seen
 * still forces an immediate lane read (`readMachine`).
 */
const FOREIGN_LANE_REFRESH_MS = 30_000;
const OFFLINE_DIVERGENCE_MAX_AGE_MS = 60_000;
/**
 * Floor on how long a drop must persist before Work shows a machine as offline.
 * `connect()` publishes `connecting` before every automatic redial and a single
 * failed liveness ping publishes `error`, so believing the first non-connected
 * snapshot would dim a machine on every websocket blip. One connect candidate
 * alone is allowed ten seconds and candidates are tried in sequence, so this
 * floor sits above a full dial cycle.
 */
const UNREACHABLE_FLOOR_MS = 45_000;
/**
 * Backstop for a machine that never completes a reconnect attempt at all — a
 * dial wedged past its own timeout, or a target whose autoconnect sweep never
 * arrives. Without it, "wait for a failed attempt" would hold a dead machine
 * bright forever.
 */
const UNREACHABLE_CEILING_MS = 120_000;
/**
 * How long an unreachable machine keeps its rows. A laptop that is shut for the
 * night is still a machine you own with work on it; a machine you have not seen
 * for a day is clutter.
 */
const OFFLINE_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Foreign session reads are a sidebar preview, not an archive. */
const FOREIGN_SESSION_LIMIT = 60;
/** Match the local optimistic-session window while a foreign list catches up. */
const FOREIGN_OPTIMISTIC_SESSION_TTL_MS = 2 * 60 * 1000;

type PendingForeignOptimisticSession = {
  session: TerminalSessionSummary;
  createdAtMs: number;
};

const pendingForeignOptimisticSessionsByBinding = new Map<
  string,
  Map<string, PendingForeignOptimisticSession>
>();

export function resolveThisMachineBindingForOrigin(
  projects: readonly RecentProjectSummary[],
  originUrl: string | null | undefined,
): Extract<OpenProjectBinding, { kind: "local" }> | null {
  const originIdentity = normalizeGitRemoteIdentity(originUrl);
  if (!originIdentity) return null;
  const localProject = projects.find((candidate) =>
    candidate.kind !== "remote"
    && candidate.exists !== false
    && normalizeGitRemoteIdentity(candidate.gitOriginUrl) === originIdentity);
  if (!localProject) return null;
  return {
    kind: "local",
    key: `local:${localProject.rootPath}`,
    rootPath: localProject.rootPath,
    displayName: localProject.displayName,
  };
}

// ── Derived rows ────────────────────────────────────────────────────────────

export type CrossMachineLaneRow = {
  lane: LaneSummary;
  machineId: string;
  /** Absolute machine name; safe to show verbatim. */
  machineName: string;
  online: boolean;
  isThisMachine: boolean;
  /** True for the tab-bound machine whose lanes already render in the primary list. */
  isActiveBinding: boolean;
  /** Sessions belonging to this lane. Empty for local rows (the local list owns them). */
  sessions: TerminalSessionSummary[];
  /** Remote-runtime target id + project id, for "open this on that machine". */
  targetId: string | null;
  projectId: string | null;
  binding: OpenProjectBinding | null;
};

/**
 * Everything the Work sidebar is allowed to see.
 *
 * Rows for a machine that has dropped are present and flagged `online: false`,
 * not removed: the sidebar dims them and collapses their contents. Deciding
 * what has actually left happens once, in `applyReachability`, at the store —
 * so there is still no filter for a consumer here to get wrong.
 */
export type CrossMachineUnion = {
  /** Rows on machines other than this one, reachable first, then by activity. */
  foreignRows: CrossMachineLaneRow[];
  /**
   * Lane id → marker, present ONLY for lanes that are not on this machine.
   * Absence is the common case and costs nothing to render.
   */
  markersByLaneId: Map<string, CrossMachineLaneMarker>;
};

/**
 * The machine marker.
 *
 * ONE rule, and it is the whole vocabulary of this indicator: a marker exists
 * for a lane if and only if that lane is not on the physical Mac this app is
 * running on. Absence therefore means "this work is here" — which only reads as
 * information because the rule has no exceptions. It is deliberately blind to
 * the project tab's binding: the tab can point anywhere, and a badge that moved
 * with it would be answering a question nobody asked.
 *
 * The form is always a bare glyph; the name is on hover. An earlier version
 * promoted the name inline when a glyph alone looked ambiguous (offline, two
 * foreign machines, same branch elsewhere), which meant a row's shape changed
 * for reasons the reader could not see. A single resting form that never moves
 * beat a cleverer one that did. `mode` survives as a field because the command
 * palette renders the name — it has no lane header to disambiguate a glyph
 * against — and that exception is worth being explicit about rather than
 * implicit in a second component.
 *
 * The glyph is amber, in an amber pill. Amber is machine identity everywhere in
 * ADE (top bar, connections panel, Activity pane, session hover card), and
 * `SessionCard` states the rule directly: amber appears exactly once per row, on
 * the machine tower, because that glyph is identity and never status.
 */
export type CrossMachineLaneMarker = {
  machineId: string;
  machineName: string;
  /** False while the owning machine is unreachable; the row reads as dimmed. */
  online: boolean;
  /**
   * Always `"glyph"` from `resolveCrossMachineLaneMarkers`. Surfaces with no
   * lane header of their own (the command palette) override it to `"name"`.
   */
  mode: "glyph" | "name";
  /** Always the machine name — the glyph form still exposes it on hover. */
  title: string;
  /**
   * True when the same branch exists as a lane on another machine. No longer
   * changes the marker's form; the push-divergence guard reasons about the same
   * condition and this is the cheapest place to surface it.
   */
  sameBranchElsewhere: boolean;
};

const EMPTY_ROWS: CrossMachineLaneRow[] = [];
const EMPTY_SESSION_IDS: ReadonlySet<string> = new Set<string>();
const EMPTY_MARKERS = new Map<string, CrossMachineLaneMarker>();
export const EMPTY_CROSS_MACHINE_UNION: CrossMachineUnion = {
  foreignRows: EMPTY_ROWS,
  markersByLaneId: EMPTY_MARKERS,
};

/**
 * Immediately projects a foreign launch into its owning machine slice. The
 * periodic union refresh replaces this optimistic summary by stable session id.
 */
export function seedCrossMachineOptimisticChatSession(
  session: AgentChatSession,
  binding: OpenProjectBinding,
  laneName?: string | null,
): void {
  const store = rootAppStoreApi.getState();
  const existing = Object.values(store.crossMachineLanesByMachineId).find(
    (entry) => entry.binding?.key === binding.key,
  ) ?? null;
  const machineId = existing?.machineId ?? (
    binding.kind === "remote" ? binding.targetId : THIS_MACHINE_ID
  );
  const machineName = existing?.machineName ?? (
    binding.kind === "remote" ? binding.runtimeName : THIS_MACHINE_NAME
  );
  const optimistic = buildOptimisticChatSessionSummary({
    session,
    laneName: laneName
      ?? existing?.lanes.find((lane) => lane.id === session.laneId)?.name
      ?? session.laneId,
  });
  const pending = pendingForeignOptimisticSessionsByBinding.get(binding.key) ?? new Map();
  pending.set(session.id, { session: optimistic, createdAtMs: Date.now() });
  pendingForeignOptimisticSessionsByBinding.set(binding.key, pending);
  store.mergeCrossMachineLanes({
    machineId,
    machineName,
    targetId: binding.kind === "remote" ? binding.targetId : null,
    projectId: binding.kind === "remote" ? binding.projectId : null,
    binding,
    online: true,
    sessions: [
      optimistic,
      ...(existing?.sessions ?? []).filter((candidate) => candidate.id !== session.id),
    ],
    error: null,
  });
}

/** Removes a foreign optimistic row after a successful pinned delete. */
export function cancelCrossMachineOptimisticChatSession(
  binding: OpenProjectBinding,
  sessionId: string,
): void {
  const pending = pendingForeignOptimisticSessionsByBinding.get(binding.key);
  pending?.delete(sessionId);
  if (pending && pending.size === 0) {
    pendingForeignOptimisticSessionsByBinding.delete(binding.key);
  }
  const store = rootAppStoreApi.getState();
  const existing = Object.values(store.crossMachineLanesByMachineId).find(
    (entry) => entry.binding?.key === binding.key,
  );
  if (existing?.sessions.some((session) => session.id === sessionId)) {
    store.mergeCrossMachineLanes({
      machineId: existing.machineId,
      machineName: existing.machineName,
      sessions: existing.sessions.filter((session) => session.id !== sessionId),
    });
  }
}

/** Retains foreign optimistic rows across stale in-flight list responses. */
export function reconcileCrossMachineOptimisticSessions(
  binding: OpenProjectBinding,
  sessions: TerminalSessionSummary[],
  nowMs: number = Date.now(),
): TerminalSessionSummary[] {
  const pending = pendingForeignOptimisticSessionsByBinding.get(binding.key);
  if (!pending?.size) return sessions;
  const authoritativeIds = new Set(sessions.map((session) => session.id));
  const retained: TerminalSessionSummary[] = [];
  for (const [sessionId, entry] of pending) {
    if (authoritativeIds.has(sessionId)) {
      pending.delete(sessionId);
    } else if (nowMs - entry.createdAtMs > FOREIGN_OPTIMISTIC_SESSION_TTL_MS) {
      pending.delete(sessionId);
    } else {
      retained.push(entry.session);
    }
  }
  if (pending.size === 0) {
    pendingForeignOptimisticSessionsByBinding.delete(binding.key);
  }
  return retained.length > 0 ? [...retained, ...sessions] : sessions;
}

/** `refs/heads/x`, `x`, and `  x  ` are the same branch (matches laneDivergence). */
function normalizeBranchRef(branchRef: string | null | undefined): string {
  const trimmed = typeof branchRef === "string" ? branchRef.trim() : "";
  if (!trimmed) return "";
  return trimmed.replace(/^refs\/heads\//, "");
}

function laneActivityRank(row: CrossMachineLaneRow): number {
  let latest = Date.parse(row.lane.createdAt ?? "");
  for (const session of row.sessions) {
    const at = Date.parse(session.lastActivityAt ?? session.startedAt ?? "");
    if (Number.isFinite(at) && at > (Number.isFinite(latest) ? latest : -Infinity)) latest = at;
  }
  return Number.isFinite(latest) ? latest : 0;
}

/**
 * Builds the union rows: this machine's lanes plus every machine slice held in
 * the store, offline ones included. The builder stays policy-free about
 * reachability on purpose — that is decided in exactly one place
 * (`useCrossMachineLaneUnion`), and keeping the raw shape here lets tests assert
 * store retention separately from what renders. The one policy it does own is
 * `localSessionIds` below, because "one session renders once" has to hold before
 * anything downstream reads a row's sessions.
 */
export function buildCrossMachineLaneRows(input: {
  localLanes: readonly LaneSummary[];
  machines: Readonly<Record<string, CrossMachineMachineLanes>>;
  activeBinding?: OpenProjectBinding | null;
  /**
   * Session ids the active binding's own roster already renders. Machine-level
   * exclusion below cannot catch these: it drops the bound machine's slice, but
   * a single session can still reach both lists — an optimistic launch injected
   * locally while its owning machine also reports it. The sidebar then showed
   * one new chat as two rows, each with its own elapsed clock.
   *
   * Local wins, the same precedence `sessionsById` and `buildThreadIndex` use:
   * a click resolves against the local record, so surviving as the union's copy
   * would render one row and open another. Omit it to get the raw shape.
   */
  localSessionIds?: ReadonlySet<string>;
}): CrossMachineLaneRow[] {
  const rows: CrossMachineLaneRow[] = [];
  const activeBinding = input.activeBinding ?? null;
  const activeMachineId = activeBinding?.kind === "remote"
    ? activeBinding.targetId
    : THIS_MACHINE_ID;
  const activeMachineName = activeBinding?.kind === "remote"
    ? activeBinding.runtimeName
    : THIS_MACHINE_NAME;
  const activeRemoteBinding = activeBinding?.kind === "remote" ? activeBinding : null;
  // The active target's retained slice is omitted from the union below to avoid
  // duplicate rows, but it is still the source of truth for a dropped target.
  // A local binding (and an active target without a retained slice) stays live
  // until the connection snapshot has recorded otherwise.
  const activeMachineOnline = activeRemoteBinding
    ? input.machines[activeRemoteBinding.targetId]?.online ?? true
    : true;
  for (const lane of input.localLanes) {
    rows.push({
      lane,
      machineId: activeMachineId,
      machineName: activeMachineName,
      online: activeMachineOnline,
      isThisMachine: activeMachineId === THIS_MACHINE_ID,
      isActiveBinding: true,
      sessions: [],
      targetId: activeRemoteBinding?.targetId ?? null,
      projectId: activeRemoteBinding?.projectId ?? null,
      binding: activeRemoteBinding,
    });
  }
  // One session renders once. Seeded with the ids the active binding's roster
  // already owns, then carried ACROSS machines so two slices reporting the same
  // session cannot both claim it either — the same shape `buildThreadIndex`
  // uses for the command palette. Deduping here rather than at render time is
  // what makes every consumer agree on what a machine contributes: the render
  // list, the headerless/shape rules, and the quiet-expansion check. A lane
  // left with no sessions is dropped downstream by the rule that already drops
  // a filtered-out one.
  const claimed = new Set(input.localSessionIds ?? []);
  for (const entry of Object.values(input.machines)) {
    // The active binding is already represented by `localLanes`. The sync
    // cache may also contain that remote machine, so drop its stale/duplicate
    // slice instead of rendering the same lane twice.
    if (entry.machineId === activeMachineId) continue;
    // Only lanes this machine actually reports become rows below, so a session
    // naming a lane it does not have renders nothing here. Claiming it anyway
    // would block the machine that DOES have that lane from rendering it, and
    // the session would vanish from the sidebar entirely — worse than the
    // duplicate this dedupe exists to remove.
    const entryLaneIds = new Set(entry.lanes.map((lane) => lane.id));
    const sessionsByLaneId = new Map<string, TerminalSessionSummary[]>();
    for (const session of entry.sessions) {
      const laneId = session.laneId;
      if (!laneId || !entryLaneIds.has(laneId)) continue;
      if (claimed.has(session.id)) continue;
      claimed.add(session.id);
      const list = sessionsByLaneId.get(laneId);
      if (list) list.push(session);
      else sessionsByLaneId.set(laneId, [session]);
    }
    for (const lane of entry.lanes) {
      rows.push({
        lane,
        machineId: entry.machineId,
        machineName: entry.machineName,
        online: entry.online,
        isThisMachine: entry.machineId === THIS_MACHINE_ID,
        isActiveBinding: false,
        sessions: sessionsByLaneId.get(lane.id) ?? [],
        targetId: entry.targetId,
        projectId: entry.projectId,
        binding: entry.binding ?? null,
      });
    }
  }
  return rows;
}

/**
 * Sidebar order for foreign rows: reachable machines first, each group by most
 * recent activity. A dropped machine's lanes are still worth seeing — that is
 * the point of dimming rather than hiding — but they are not what you are about
 * to act on, so they sink below the live ones instead of interleaving with them.
 */
export function orderCrossMachineRows(
  rows: readonly CrossMachineLaneRow[],
): CrossMachineLaneRow[] {
  return [...rows].sort((left, right) => {
    if (left.online !== right.online) return left.online ? -1 : 1;
    return laneActivityRank(right) - laneActivityRank(left);
  });
}

/**
 * Resolves the marker for every lane that is not on this physical Mac. Rows on
 * this machine get no entry at all — "work isn't here" is the only thing the
 * marker communicates, so on a single-machine setup this map is empty and the
 * header is untouched.
 *
 * Note what this does NOT consult: `isActiveBinding`. A lane on the machine the
 * project tab happens to point at is still foreign work if you are sitting at a
 * different Mac, and it gets a marker like any other.
 *
 * Offline machines are included, and their branches still count toward
 * "same branch elsewhere": a branch you cannot see right now is exactly the one
 * you are most likely to strand commits behind.
 */
export function resolveCrossMachineLaneMarkers(
  rows: readonly CrossMachineLaneRow[],
): Map<string, CrossMachineLaneMarker> {
  const foreign = rows.filter((row) => !row.isThisMachine);
  if (foreign.length === 0) return EMPTY_MARKERS;

  // Same-branch-elsewhere: a branch held as a lane on two or more machines. The
  // push-divergence guard reasons about the same condition; carrying it on the
  // marker means a consumer that wants to warn does not have to recompute it.
  const machinesByBranch = new Map<string, Set<string>>();
  for (const row of rows) {
    const branch = normalizeBranchRef(row.lane.branchRef);
    if (!branch) continue;
    const set = machinesByBranch.get(branch);
    if (set) set.add(row.machineId);
    else machinesByBranch.set(branch, new Set([row.machineId]));
  }

  const markers = new Map<string, CrossMachineLaneMarker>();
  for (const row of foreign) {
    const branch = normalizeBranchRef(row.lane.branchRef);
    const sameBranchElsewhere = (machinesByBranch.get(branch)?.size ?? 0) >= 2;
    // Active-binding lanes render through the primary lane list, whose key is
    // the bare lane id. Other machines render through composite union rows.
    const markerKey = row.isActiveBinding
      ? row.lane.id
      : `${row.machineId}:${row.lane.id}`;
    markers.set(markerKey, {
      machineId: row.machineId,
      machineName: row.machineName,
      online: row.online,
      // Always the resting form. Offline is expressed by `online: false`, which
      // dims the glyph and the whole row — a shape change on top of that would
      // be a second signal for one fact.
      mode: "glyph",
      title: row.machineName,
      sameBranchElsewhere,
    });
  }
  return markers;
}

// ── Push-divergence producer ────────────────────────────────────────────────

type BranchStateCacheKey = {
  lanes: readonly LaneSummary[];
  machines: Readonly<Record<string, CrossMachineMachineLanes>>;
  projectBinding: OpenProjectBinding | null;
  laneId: string;
  expiresAtMs: number | null;
  value: MachineBranchState[] | readonly MachineBranchState[];
};

let branchStateCache: BranchStateCacheKey | null = null;

/**
 * Cross-machine branch state for the push-divergence guard.
 *
 * `detectPushDivergence` has been receiving an empty `others` list because
 * nothing in the renderer produced cross-machine branch state. The union is that
 * producer: every union lane on the SAME branch and a DIFFERENT machine becomes
 * one `MachineBranchState`.
 *
 * Grounded in `branchRef` + `status.ahead`/`behind` exactly as
 * `toMachineBranchState` expects — no lane record in ADE carries a head sha, so
 * `headSha` stays null and the guard's ahead-based rule does the deciding.
 *
 * Offline machines are deliberately included: a machine being unreachable does
 * not make its unpushed commits safe to strand — it makes them *less* visible,
 * which is exactly when the warning is worth the most.
 */
export function selectOtherMachineBranchStates(
  state: Pick<AppState, "lanes" | "crossMachineLanesByMachineId" | "projectBinding">,
  laneId: string,
): readonly MachineBranchState[] {
  const trimmedLaneId = laneId?.trim() ?? "";
  if (!trimmedLaneId) return EMPTY_MACHINE_BRANCH_STATES;

  const cached = branchStateCache;
  if (
    cached
    && cached.laneId === trimmedLaneId
    && cached.lanes === state.lanes
    && cached.machines === state.crossMachineLanesByMachineId
    && cached.projectBinding === state.projectBinding
    && (cached.expiresAtMs == null || Date.now() < cached.expiresAtMs)
  ) {
    return cached.value;
  }

  const remember = (
    value: MachineBranchState[] | readonly MachineBranchState[],
    expiresAtMs: number | null = null,
  ): readonly MachineBranchState[] => {
    branchStateCache = {
      lanes: state.lanes,
      machines: state.crossMachineLanesByMachineId,
      projectBinding: state.projectBinding,
      laneId: trimmedLaneId,
      expiresAtMs,
      value,
    };
    return value;
  };

  const activeMachineId = state.projectBinding?.kind === "remote"
    ? state.projectBinding.targetId
    : THIS_MACHINE_ID;
  const activeMachineName = state.projectBinding?.kind === "remote"
    ? state.projectBinding.runtimeName
    : THIS_MACHINE_NAME;

  // Resolve the lane and, with it, the machine that owns it. `state.lanes`
  // belongs to the active tab binding, which may be a remote machine.
  let subjectBranch = "";
  let subjectMachineId = "";
  const localLane = state.lanes.find((lane) => lane.id === trimmedLaneId);
  if (localLane) {
    subjectBranch = normalizeBranchRef(localLane.branchRef);
    subjectMachineId = activeMachineId;
  } else {
    for (const entry of Object.values(state.crossMachineLanesByMachineId)) {
      const match = entry.lanes.find((lane) => lane.id === trimmedLaneId);
      if (!match) continue;
      subjectBranch = normalizeBranchRef(match.branchRef);
      subjectMachineId = entry.machineId;
      break;
    }
  }
  if (!subjectBranch || !subjectMachineId) return remember(EMPTY_MACHINE_BRANCH_STATES);

  const others: MachineBranchState[] = [];
  let expiresAtMs: number | null = null;
  for (const entry of Object.values(state.crossMachineLanesByMachineId)) {
    // `state.lanes` is the authoritative active-binding slice. Ignore any
    // retained union copy of that machine and add the live slice below only
    // when it is genuinely "other" than the subject.
    if (
      entry.machineId === subjectMachineId
      || entry.machineId === activeMachineId
    ) {
      continue;
    }
    if (
      !entry.online
      && (
        entry.lastSyncedAtMs == null
        || Date.now() - entry.lastSyncedAtMs > OFFLINE_DIVERGENCE_MAX_AGE_MS
      )
    ) {
      continue;
    }
    for (const lane of entry.lanes) {
      if (normalizeBranchRef(lane.branchRef) !== subjectBranch) continue;
      if (!entry.online && entry.lastSyncedAtMs != null) {
        const entryExpiresAtMs = entry.lastSyncedAtMs + OFFLINE_DIVERGENCE_MAX_AGE_MS;
        expiresAtMs = expiresAtMs == null
          ? entryExpiresAtMs
          : Math.min(expiresAtMs, entryExpiresAtMs);
      }
      others.push(
        toMachineBranchState({
          machineId: entry.machineId,
          machineName: entry.machineName,
          lane,
        }),
      );
    }
  }
  // A lane outside the active binding compares against the active binding too;
  // `state.lanes` is not necessarily This Mac.
  if (subjectMachineId !== activeMachineId) {
    for (const lane of state.lanes) {
      if (normalizeBranchRef(lane.branchRef) !== subjectBranch) continue;
      others.push(
        toMachineBranchState({
          machineId: activeMachineId,
          machineName: activeMachineName,
          lane,
        }),
      );
    }
  }
  return remember(
    others.length === 0 ? EMPTY_MACHINE_BRANCH_STATES : others,
    expiresAtMs,
  );
}

/** Test seam — the branch-state memo is module state. */
export function resetCrossMachineBranchStateCacheForTest(): void {
  branchStateCache = null;
}

// ── Sync engine ─────────────────────────────────────────────────────────────

export type CrossMachineLaneScope = {
  /** Project state key of the tab whose repo the union describes. */
  scopeKey: string | null;
  /** Repo folder name, used to find the same checkout on other machines. */
  repoDisplayName: string | null;
  /** Verified local origin URL; null means this repo has no usable origin. */
  repoOriginUrl: string | null;
  /** Target id the tab is bound to; null when the tab is on this Mac. */
  boundTargetId: string | null;
  /** Project id on the bound machine, when the tab is bound to a remote one. */
  boundProjectId: string | null;
  /** Verified local checkout of the same repo, while the tab is remote-bound. */
  thisMachineBinding?: Extract<OpenProjectBinding, { kind: "local" }> | null;
};

type SyncRuntime = {
  connections: readonly RemoteRuntimeConnectionStatus[];
  scope: CrossMachineLaneScope;
  refCount: number;
  generation: number;
  /**
   * Bumped only by teardown and scope change — NOT by each refresh, the way
   * `generation` is. An in-flight read is stale as soon as a newer refresh
   * starts, but the first connection snapshot is not: it stays valid until the
   * runtime is actually torn down or retargeted.
   */
  lifecycle: number;
  disposers: Array<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
  refreshTimer: ReturnType<typeof setTimeout> | null;
  refreshInFlight: boolean;
  refreshQueued: boolean;
  /** Open drop record per machine that is currently not connected. */
  dropsByMachineId: Map<string, MachineDrop>;
  /** Re-evaluates reachability when the next drop deadline lapses. */
  graceTimer: ReturnType<typeof setTimeout> | null;
  /** Last `lane.list` read per machine, keyed the same way the store is. */
  laneReadAtMsByMachineId: Map<string, number>;
  /** Lane ids a completed lane read did not explain, so we stop re-asking. */
  unresolvedLaneIdsByMachineId: Map<string, Set<string>>;
};

/**
 * What we know about one machine's current disconnection.
 *
 * A drop is believed only once a reconnect attempt has run to completion and
 * failed — `connecting` seen while dropped, then a non-connected state — because
 * that is the difference between "the link blipped" and "the machine is gone".
 * `lastAttemptedAt` cannot answer this on its own: a failed RPC over an already
 * established connection stamps it too (`markCallFailure`), which is the very
 * event that starts most drops.
 */
type MachineDrop = {
  droppedAtMs: number;
  /** A dial has been observed since the drop. */
  sawAttempt: boolean;
  /** That dial has since finished without reaching `connected`. */
  attemptFailed: boolean;
};

const runtime: SyncRuntime = {
  connections: [],
  scope: {
    scopeKey: null,
    repoDisplayName: null,
    repoOriginUrl: null,
    boundTargetId: null,
    boundProjectId: null,
    thisMachineBinding: null,
  },
  refCount: 0,
  generation: 0,
  lifecycle: 0,
  disposers: [],
  timer: null,
  refreshTimer: null,
  refreshInFlight: false,
  refreshQueued: false,
  dropsByMachineId: new Map(),
  graceTimer: null,
  laneReadAtMsByMachineId: new Map(),
  unresolvedLaneIdsByMachineId: new Map(),
};

/**
 * Nobody is looking at the sidebar, so nothing is worth reading for it. The
 * union's whole cost is remote reads on other people's machines; a hidden window
 * pays it for a list that will be refreshed the moment it comes back.
 */
function isDocumentVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function sameScope(a: CrossMachineLaneScope, b: CrossMachineLaneScope): boolean {
  return (
    a.scopeKey === b.scopeKey
    && a.repoDisplayName === b.repoDisplayName
    && a.repoOriginUrl === b.repoOriginUrl
    && a.boundTargetId === b.boundTargetId
    && a.boundProjectId === b.boundProjectId
    && a.thisMachineBinding?.key === b.thisMachineBinding?.key
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Decodes a foreign `lane.list` payload. Foreign data is untrusted input from
 * another process: anything that isn't lane-shaped is dropped rather than
 * rendered as a half-lane.
 */
export function decodeForeignLanes(result: unknown): LaneSummary[] {
  const list = Array.isArray(result)
    ? result
    : isRecord(result) && Array.isArray(result.lanes)
      ? result.lanes
      : [];
  const lanes: LaneSummary[] = [];
  for (const candidate of list) {
    if (!isRecord(candidate)) continue;
    if (typeof candidate.id !== "string" || !candidate.id.trim()) continue;
    if (typeof candidate.name !== "string") continue;
    if (typeof candidate.branchRef !== "string") continue;
    lanes.push(candidate as unknown as LaneSummary);
  }
  return lanes;
}

/**
 * Same contract as `decodeForeignLanes`, for `pr.listAll`.
 *
 * Validates every field the badge path actually reads, not just the joining
 * ones: a peer on an older build that omits `githubPrNumber` would render
 * "PR #undefined", and one that omits `githubUrl` would render a badge whose
 * click is a silent no-op (the foreign click-through has nowhere else to go).
 * Dropping the row shows no badge, which is honest; a half-decoded one is not.
 */
export function decodeForeignPrs(result: unknown): PrSummary[] {
  const list = Array.isArray(result)
    ? result
    : isRecord(result) && Array.isArray(result.prs)
      ? result.prs
      : [];
  const prs: PrSummary[] = [];
  for (const candidate of list) {
    if (!isRecord(candidate)) continue;
    if (typeof candidate.id !== "string" || !candidate.id.trim()) continue;
    if (typeof candidate.laneId !== "string" || !candidate.laneId.trim()) continue;
    if (typeof candidate.headBranch !== "string") continue;
    if (typeof candidate.githubPrNumber !== "number") continue;
    if (typeof candidate.githubUrl !== "string" || !candidate.githubUrl.trim()) continue;
    if (typeof candidate.state !== "string") continue;
    prs.push(candidate as unknown as PrSummary);
  }
  return prs;
}

/** Same contract as `decodeForeignLanes`, for `session.list`. */
export function decodeForeignSessions(result: unknown): TerminalSessionSummary[] {
  const list = Array.isArray(result)
    ? result
    : isRecord(result) && Array.isArray(result.sessions)
      ? result.sessions
      : [];
  const sessions: TerminalSessionSummary[] = [];
  for (const candidate of list) {
    if (!isRecord(candidate)) continue;
    if (typeof candidate.id !== "string" || !candidate.id.trim()) continue;
    if (typeof candidate.laneId !== "string" || !candidate.laneId.trim()) continue;
    sessions.push(candidate as unknown as TerminalSessionSummary);
  }
  return sessions;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** The origin URL of the repo the tab is showing, when the bound machine knows it. */
function resolveBoundRepoOriginUrl(scope: CrossMachineLaneScope): string | null {
  if (!scope.boundTargetId || !scope.boundProjectId) return null;
  const connection = runtime.connections.find(
    (candidate) => candidate.target.id === scope.boundTargetId,
  );
  const project = connection?.projects?.find(
    (candidate) => candidate.projectId === scope.boundProjectId,
  );
  return project?.gitOriginUrl ?? null;
}

/** Eligibility truth as of the newest snapshot this runtime has seen. */
function isMachineEligibleNow(machineId: string): boolean {
  return resolveEligibleMachines().some((option) => option.id === machineId);
}

/**
 * Whether this tick should re-read a machine's lanes as well as its chats.
 * First read always does; after that the lane list has its own slow cadence.
 */
function shouldReadLanes(machineId: string): boolean {
  const readAtMs = runtime.laneReadAtMsByMachineId.get(machineId);
  return readAtMs == null || Date.now() - readAtMs >= FOREIGN_LANE_REFRESH_MS;
}

/**
 * A chat on a lane we have no row for, that a lane read has not already failed
 * to explain.
 *
 * The second half is load-bearing. `session.list` does not filter on lane
 * status while `lane.list` asks for `includeArchived: false`, so a chat on an
 * archived lane is permanently unresolvable — and without remembering that, it
 * would demand a fresh lane read on every single tick, which is exactly the cost
 * this cadence exists to remove.
 */
function hasUnknownLaneReference(
  machineId: string,
  sessions: readonly TerminalSessionSummary[],
): boolean {
  const known = new Set(
    (rootAppStoreApi.getState().crossMachineLanesByMachineId[machineId]?.lanes ?? [])
      .map((lane) => lane.id),
  );
  const unexplained = runtime.unresolvedLaneIdsByMachineId.get(machineId);
  return sessions.some((session) =>
    session.laneId && !known.has(session.laneId) && !unexplained?.has(session.laneId));
}

/**
 * Applies the lane cadence to one machine's read and records what it settled.
 *
 * Both read paths share this because the invariant they must not drift on is
 * "stamp the cadence only when lanes were actually read" — get that wrong on one
 * side and that machine pays the full `includeStatus` cost on every tick forever.
 */
async function resolveLaneCadence(
  machineId: string,
  prefetched: LaneSummary[] | null,
  sessions: readonly TerminalSessionSummary[],
  generation: number,
  catchUp: () => Promise<LaneSummary[]>,
): Promise<LaneSummary[] | null> {
  const lanes = prefetched
    ?? (hasUnknownLaneReference(machineId, sessions) ? await catchUp() : null);
  if (!lanes) return null;
  // The catch-up read awaits the network, and a scope change in that window has
  // already cleared these maps for the new scope. Re-populating them here would
  // suppress that scope's first lane read for a full cadence.
  if (generation !== runtime.generation) return null;
  runtime.laneReadAtMsByMachineId.set(machineId, Date.now());
  const known = new Set(lanes.map((lane) => lane.id));
  const unexplained = new Set<string>();
  for (const session of sessions) {
    if (session.laneId && !known.has(session.laneId)) unexplained.add(session.laneId);
  }
  if (unexplained.size > 0) runtime.unresolvedLaneIdsByMachineId.set(machineId, unexplained);
  else runtime.unresolvedLaneIdsByMachineId.delete(machineId);
  return lanes;
}

async function readMachine(
  machineId: string,
  machineName: string,
  targetId: string,
  projectId: string,
  binding: Extract<OpenProjectBinding, { kind: "remote" }>,
  generation: number,
): Promise<void> {
  const store = rootAppStoreApi.getState();
  const callAction = window.ade?.remoteRuntime?.callAction;
  if (!callAction) return;
  const readLanes = () =>
    withTimeout(
      callAction(targetId, projectId, {
        domain: "lane",
        action: "list",
        args: { includeArchived: false, includeStatus: true },
      }),
      MACHINE_READ_TIMEOUT_MS,
      `lane.list on ${machineName}`,
    );
  // PRs ride the lane cadence, not the chat cadence. A PR is only ever rendered
  // by joining it to a lane, it changes on the same slow scale a lane does, and
  // the read is a foreign round trip — paying for it every ten seconds would
  // buy a fresher check dot at the cost this cadence exists to avoid.
  // Best-effort: a machine that answers `lane.list` but fails `pr.listAll` (an
  // older build, a transient error) must still contribute its lanes and chats.
  // No bound-machine skip needed: `isEligibleMachineOption` already excludes the
  // tab's machine from every target this function is called with, so the rows
  // read here are always a machine `useLanePrsByLaneId` cannot answer itself.
  const readPrs = async (): Promise<PrSummary[] | null> => {
    try {
      const response = await withTimeout(
        callAction(targetId, projectId, { domain: "pr", action: "listAll", args: {} }),
        MACHINE_READ_TIMEOUT_MS,
        `pr.listAll on ${machineName}`,
      );
      return decodeForeignPrs(response.result);
    } catch {
      return null;
    }
  };
  try {
    const lanesDue = shouldReadLanes(machineId);
    const [laneResult, sessionResult, duePrs] = await Promise.all([
      lanesDue ? readLanes() : null,
      withTimeout(
        callAction(targetId, projectId, {
          domain: "session",
          action: "list",
          args: { limit: FOREIGN_SESSION_LIMIT },
        }),
        MACHINE_READ_TIMEOUT_MS,
        `session.list on ${machineName}`,
      ),
      lanesDue ? readPrs() : null,
    ]);
    // Cancellation: a scope change or a newer snapshot bumped the generation
    // while this read was in flight, so its answer is about a different world.
    if (generation !== runtime.generation) return;
    const sessions = decodeForeignSessions(sessionResult.result);
    // A chat is rendered under its lane, so a chat launched on a lane this
    // machine has never reported would be invisible until the slow lane cadence
    // came round. Seeing one is the signal to pay for the lane read now.
    const lanes = await resolveLaneCadence(
      machineId,
      laneResult ? decodeForeignLanes(laneResult.result) : null,
      sessions,
      generation,
      async () => decodeForeignLanes((await readLanes()).result),
    );
    if (generation !== runtime.generation) return;
    // On a cadence tick the PR read already went out alongside the lane read, so
    // it costs no extra latency. Only the off-cadence catch-up (a chat on a lane
    // we had never seen forces a lane read mid-tick) has to fetch here — without
    // it that lane renders with no PR badge until the next 30s tick, the exact
    // blank this change exists to remove. Deliberately NOT a blanket sequential
    // read: that would hold this machine's lanes and chats out of the store
    // behind an 8s PR timeout, and stall every other machine's cadence with it.
    const prResult = duePrs ?? (lanes && !lanesDue ? await readPrs() : null);
    if (generation !== runtime.generation) return;
    store.mergeCrossMachineLanes({
      machineId,
      machineName,
      targetId,
      projectId,
      binding,
      // Confirm reachable, never resurrect. Reachability is owned by the
      // connection snapshot and its drop deadlines; a read that was in flight
      // across a disconnect must not flip a machine the snapshot path already
      // dimmed back on — nothing would dim it again until the next snapshot
      // happens to fire. Omitting the flag retains that verdict.
      ...(isMachineEligibleNow(machineId) ? { online: true } : {}),
      ...(lanes ? { lanes } : {}),
      // Same retention contract as lanes: a PR read that failed or was not due
      // this tick omits the key, so the machine keeps what it last reported.
      ...(prResult ? { prs: prResult } : {}),
      sessions: reconcileCrossMachineOptimisticSessions(binding, sessions),
      error: null,
    });
  } catch (error) {
    if (generation !== runtime.generation) return;
    // Record the failure WITHOUT lanes/sessions: retention is the point. A
    // machine we briefly couldn't reach keeps everything it last told us.
    store.mergeCrossMachineLanes({
      machineId,
      machineName,
      targetId,
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function readThisMachine(
  binding: Extract<OpenProjectBinding, { kind: "local" }>,
  generation: number,
): Promise<void> {
  const store = rootAppStoreApi.getState();
  const readLanes = () =>
    withTimeout(
      window.ade.lanes.list(
        { includeArchived: false, includeStatus: true },
        binding,
      ),
      MACHINE_READ_TIMEOUT_MS,
      "lane.list on This Mac",
    );
  // See `readMachine`: PRs ride the lane cadence for the same reasons, and the
  // read is best-effort — a machine that fails only this read must still
  // contribute its lanes and chats rather than falling into the error path and
  // blanking the whole slice. No active-binding skip here: this function only
  // runs when the tab is bound to a REMOTE machine (see its one caller), so
  // This Mac is never the machine `useLanePrsByLaneId` already answers.
  const readPrs = async (): Promise<PrSummary[] | null> => {
    try {
      return await withTimeout(
        window.ade.prs.listAll(binding),
        MACHINE_READ_TIMEOUT_MS,
        "pr.listAll on This Mac",
      );
    } catch {
      return null;
    }
  };
  try {
    const lanesDue = shouldReadLanes(THIS_MACHINE_ID);
    const [laneResult, sessions, duePrs] = await Promise.all([
      lanesDue ? readLanes() : null,
      withTimeout(
        window.ade.sessions.list(
          { limit: FOREIGN_SESSION_LIMIT },
          binding,
        ),
        MACHINE_READ_TIMEOUT_MS,
        "session.list on This Mac",
      ),
      lanesDue ? readPrs() : null,
    ]);
    if (generation !== runtime.generation) return;
    const lanes = await resolveLaneCadence(
      THIS_MACHINE_ID,
      laneResult,
      sessions,
      generation,
      readLanes,
    );
    if (generation !== runtime.generation) return;
    // See `readMachine`: parallel on a cadence tick, sequential only for the
    // off-cadence catch-up, so a slow PR read never holds back lanes and chats.
    const prs = duePrs ?? (lanes && !lanesDue ? await readPrs() : null);
    if (generation !== runtime.generation) return;
    store.mergeCrossMachineLanes({
      machineId: THIS_MACHINE_ID,
      machineName: THIS_MACHINE_NAME,
      targetId: null,
      projectId: null,
      binding,
      online: true,
      ...(lanes ? { lanes } : {}),
      ...(prs ? { prs } : {}),
      sessions: reconcileCrossMachineOptimisticSessions(binding, sessions),
      error: null,
    });
  } catch (error) {
    if (generation !== runtime.generation) return;
    store.mergeCrossMachineLanes({
      machineId: THIS_MACHINE_ID,
      machineName: THIS_MACHINE_NAME,
      targetId: null,
      projectId: null,
      binding,
      online: true,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function runRefresh(): Promise<void> {
  const generation = ++runtime.generation;
  const scope = runtime.scope;
  const store = rootAppStoreApi.getState();
  const targets = resolveEligibleMachines();
  store.applyCrossMachineLaneScope(
    scope.scopeKey,
    resolveRefillIntendedMachineIds(targets, true),
  );

  // Bounded fan-out. Reads are independent, so a wedged machine costs one slot
  // for at most `MACHINE_READ_TIMEOUT_MS` and never blocks the others.
  let cursor = 0;
  const workers = new Array(Math.min(MAX_PARALLEL_MACHINE_READS, targets.length))
    .fill(null)
    .map(async () => {
      for (;;) {
        const option = targets[cursor++];
        if (!option) return;
        if (generation !== runtime.generation) return;
        await readMachine(
          option.id,
          option.name,
          option.targetId as string,
          option.project?.projectId as string,
          {
            kind: "remote",
            key: remoteProjectBindingKey(
              option.targetId as string,
              option.project?.projectId as string,
            ),
            targetId: option.targetId as string,
            runtimeName: option.name,
            ...(option.hostname ? { hostname: option.hostname } : {}),
            projectId: option.project?.projectId as string,
            rootPath: option.project?.rootPath as string,
            displayName: option.project?.displayName as string,
          },
          generation,
        );
      }
    });
  await Promise.all([
    ...workers,
    ...(scope.boundTargetId && scope.thisMachineBinding
      ? [readThisMachine(scope.thisMachineBinding, generation)]
      : []),
  ]);
}

function scheduleRefresh(): void {
  if (runtime.refreshTimer) {
    clearTimeout(runtime.refreshTimer);
    runtime.refreshTimer = null;
  }
  // Hidden windows read nothing at all. The visibility listener in `attach`
  // calls straight back here on the way in, so the list is refreshed once,
  // immediately, when it can actually be seen again.
  if (!isDocumentVisible()) return;
  if (runtime.refreshInFlight) {
    runtime.refreshQueued = true;
    return;
  }
  if (runtime.timer) return;
  runtime.timer = setTimeout(() => {
    runtime.timer = null;
    // A refresh outlives its own runtime: reads are bounded but slow, and
    // teardown does not cancel them. Bookkeeping from a run whose runtime has
    // since been torn down would re-arm a poll timer nobody is subscribed to,
    // and leave `refreshInFlight` set for whoever mounts next — which then never
    // schedules anything at all.
    const lifecycle = runtime.lifecycle;
    runtime.refreshInFlight = true;
    void runRefresh()
      .catch(() => {})
      .finally(() => {
        if (lifecycle !== runtime.lifecycle) return;
        runtime.refreshInFlight = false;
        if (runtime.refCount === 0) return;
        if (runtime.refreshQueued) {
          runtime.refreshQueued = false;
          scheduleRefresh();
          return;
        }
        if (!isDocumentVisible()) return;
        runtime.refreshTimer = setTimeout(() => {
          runtime.refreshTimer = null;
          scheduleRefresh();
        }, FOREIGN_MACHINE_REFRESH_MS);
      });
  }, REFRESH_COALESCE_MS);
}

/**
 * The machines that can contribute rows for the current scope: connected AND
 * still hosting this repository, excluding This Mac and the tab's own binding
 * (both of which the primary list already owns).
 *
 * Reachability and the read list share this one definition on purpose. When they
 * were computed separately, a machine that reconnected after the repo had been
 * removed there stayed `online` — connected, so never hidden — while the read
 * list dropped it, so its rows were never refreshed either: permanently visible,
 * permanently stale.
 */
function resolveMachineOptions(): LaneMachineOption[] {
  const scope = runtime.scope;
  return deriveLaneMachineOptions({
    connections: runtime.connections,
    boundTargetId: scope.boundTargetId,
    repoOriginUrl: scope.repoOriginUrl ?? resolveBoundRepoOriginUrl(scope),
    repoDisplayName: scope.repoDisplayName,
  });
}

function isEligibleMachineOption(option: LaneMachineOption): boolean {
  const scope = runtime.scope;
  return (
    option.id !== THIS_MACHINE_ID
    && option.id !== (scope.boundTargetId ?? THIS_MACHINE_ID)
    && Boolean(option.targetId)
    && Boolean(option.project?.projectId)
    && option.repoMatch === "matched"
  );
}

function resolveEligibleMachines(): LaneMachineOption[] {
  const eligible: LaneMachineOption[] = [];
  for (const machine of resolveMachineConnectivity().values()) {
    if (machine.eligible && machine.option) eligible.push(machine.option);
  }
  return eligible;
}

/**
 * Machine membership for one refill, independent of which slices have arrived.
 *
 * Existing intended ids include retained offline machines; `applyReachability`
 * removes them only when its normal forgotten verdict fires. Eligible targets
 * and the local counterpart are added before any read starts, so a slow slice
 * remains distinguishable from a removed machine throughout the refill.
 */
function resolveRefillIntendedMachineIds(
  targets: readonly LaneMachineOption[],
  preserveExisting: boolean,
): string[] {
  const store = rootAppStoreApi.getState();
  const intended = new Set<string>();
  if (preserveExisting) {
    for (const machineId of (
      store.crossMachineLaneIntendedMachineIds
      ?? Object.keys(store.crossMachineLanesByMachineId)
    )) {
      intended.add(machineId);
    }
  }
  for (const target of targets) intended.add(target.id);
  if (runtime.scope.boundTargetId && runtime.scope.thisMachineBinding) {
    intended.add(THIS_MACHINE_ID);
  }
  return Array.from(intended).sort();
}

/**
 * What the newest snapshot says about one machine. A machine that is not in the
 * snapshot at all has no entry here — absence in the map IS that fact, which is
 * why there is no "gone" state to represent.
 */
type MachineConnectivity = {
  state: RemoteRuntimeConnectionState;
  /** Present only for connected machines: the match needs their project list. */
  option: LaneMachineOption | null;
  eligible: boolean;
};

function resolveMachineConnectivity(): Map<string, MachineConnectivity> {
  const byMachineId = new Map<string, MachineConnectivity>();
  for (const connection of runtime.connections) {
    byMachineId.set(connection.target.id, {
      state: connection.state,
      option: null,
      eligible: false,
    });
  }
  // `deriveLaneMachineOptions` only returns connected machines, so anything it
  // names is connected and carries a usable repo verdict.
  for (const option of resolveMachineOptions()) {
    if (option.id === THIS_MACHINE_ID) continue;
    const known = byMachineId.get(option.id);
    if (known) {
      known.option = option;
      known.eligible = isEligibleMachineOption(option);
      continue;
    }
    byMachineId.set(option.id, {
      state: "connected",
      option,
      eligible: isEligibleMachineOption(option),
    });
  }
  return byMachineId;
}

/**
 * Decides, from the latest connection snapshot, which machines Work shows as
 * live, which it dims, and which it forgets.
 *
 * Three verdicts, and the difference between them is what this whole module is
 * about:
 *
 * - LIVE. Connected and still hosting this repository.
 * - DIMMED. Its lanes and chats stay on screen, collapsed and inert, because a
 *   machine being asleep does not make the work on it stop existing — and
 *   yanking a lane group out of the list on every wifi blip is what made
 *   machines look like they vanish. Believing a drop takes at least
 *   `UNREACHABLE_FLOOR_MS`, and at most `UNREACHABLE_CEILING_MS` when no attempt
 *   ever completes. A machine that is CONNECTED but whose repository we cannot
 *   re-prove dims on the same floor: it is not being read, so calling it live is
 *   a lie — but it is not removed, because absence of proof is not proof of
 *   absence and a project list that has not caught up after a reconnect must not
 *   read as "the repo is gone".
 * - FORGOTTEN. Three things earn removal: the machine is gone from the
 *   connection snapshot entirely (unpaired or deleted — nothing will ever
 *   refresh it again); it is connected and positively reports the repository
 *   missing, with an origin to prove it by (the case #941 was about); or it has
 *   been dimmed for `OFFLINE_RETENTION_MS`.
 *
 * The floor and the ceiling are one deadline, not two rules: `UNREACHABLE_FLOOR_MS`
 * is never above `UNREACHABLE_CEILING_MS`, so a machine is simply held until the
 * one that applies.
 */
function applyReachability(): void {
  const store = rootAppStoreApi.getState();
  const nowMs = Date.now();
  const connectivity = resolveMachineConnectivity();
  const reachable: string[] = [];
  const forgotten: string[] = [];
  let soonestDeadlineMs: number | null = null;
  const noteDeadline = (deadlineMs: number) => {
    if (soonestDeadlineMs == null || deadlineMs < soonestDeadlineMs) {
      soonestDeadlineMs = deadlineMs;
    }
  };

  for (const [machineId, machine] of connectivity) {
    if (!machine.eligible) continue;
    runtime.dropsByMachineId.delete(machineId);
    reachable.push(machineId);
  }
  const scopedMachineIds = new Set([
    ...Object.keys(store.crossMachineLanesByMachineId),
    ...(store.crossMachineLaneIntendedMachineIds ?? []),
  ]);
  for (const machineId of scopedMachineIds) {
    const entry = store.crossMachineLanesByMachineId[machineId] ?? null;
    // This Mac is not a connection target and is always reachable; holding a
    // drop record for it would leak a map entry nothing can ever clear.
    if (machineId === THIS_MACHINE_ID) continue;
    const machine = connectivity.get(machineId);
    if (machine?.eligible) continue;

    if (!machine) {
      forgotten.push(machineId);
      continue;
    }
    // Only an origin can prove a repository absent. `repoMatchFor` will say
    // "missing" off a folder-name mismatch alone, and the scope's origin URL is
    // re-resolved from the bound machine — so it can be transiently null while
    // that machine blips. Deleting rows on that evidence is not recoverable.
    if (
      machine.state === "connected"
      && machine.option?.repoMatch === "missing"
      && (runtime.scope.repoOriginUrl ?? resolveBoundRepoOriginUrl(runtime.scope))
    ) {
      forgotten.push(machineId);
      continue;
    }

    const drop = runtime.dropsByMachineId.get(machineId)
      ?? (entry?.online !== false
        ? { droppedAtMs: nowMs, sawAttempt: false, attemptFailed: false }
        // Already dimmed with no drop record: a remount cleared the records
        // while the store slice survived. A fresh record would restart the floor
        // and flash the machine back to live, so the standing verdict is kept
        // and only the retention deadline is re-anchored — to the last
        // successful read, the closest thing to when it stopped answering.
        : { droppedAtMs: entry.lastSyncedAtMs ?? nowMs, sawAttempt: true, attemptFailed: true });
    if (machine.state === "connecting") drop.sawAttempt = true;
    else if (drop.sawAttempt) drop.attemptFailed = true;
    runtime.dropsByMachineId.set(machineId, drop);

    // `idle` means the target is not dialing and will not start on its own, and
    // `connected` means it answers but cannot be read for this repository — in
    // both cases there is no attempt left to wait for.
    const answered = drop.attemptFailed
      || machine.state === "idle"
      || machine.state === "connected";
    const dimAtMs = drop.droppedAtMs
      + (answered ? UNREACHABLE_FLOOR_MS : UNREACHABLE_CEILING_MS);
    // A machine that is already dimmed stays dimmed until it is eligible again,
    // whatever the deadline says — the verdict is the store's, not this tick's.
    if (entry?.online !== false && nowMs < dimAtMs) {
      if (entry) reachable.push(machineId);
      noteDeadline(dimAtMs);
      continue;
    }
    if (nowMs - drop.droppedAtMs >= OFFLINE_RETENTION_MS) {
      forgotten.push(machineId);
      continue;
    }
    noteDeadline(drop.droppedAtMs + OFFLINE_RETENTION_MS);
  }

  if (forgotten.length > 0) {
    for (const machineId of forgotten) {
      runtime.dropsByMachineId.delete(machineId);
      runtime.laneReadAtMsByMachineId.delete(machineId);
      runtime.unresolvedLaneIdsByMachineId.delete(machineId);
    }
    store.dropCrossMachineLanes(forgotten);
  }
  store.setCrossMachineMachinesOnline(reachable);

  if (runtime.graceTimer) {
    clearTimeout(runtime.graceTimer);
    runtime.graceTimer = null;
  }
  // Nothing else re-runs this on its own: a machine held through its floor
  // produces no further snapshot, so without this the row would stay bright
  // indefinitely after a real disconnect.
  if (soonestDeadlineMs != null) {
    runtime.graceTimer = setTimeout(() => {
      runtime.graceTimer = null;
      applyReachability();
    }, Math.max(0, soonestDeadlineMs - nowMs));
  }
}

/** Forgets every per-machine record. Used by teardown and by scope changes. */
function resetMachineTracking(): void {
  if (runtime.graceTimer) {
    clearTimeout(runtime.graceTimer);
    runtime.graceTimer = null;
  }
  runtime.dropsByMachineId.clear();
  runtime.laneReadAtMsByMachineId.clear();
  runtime.unresolvedLaneIdsByMachineId.clear();
}

function applySnapshot(snapshot: RemoteRuntimeConnectionSnapshot): void {
  runtime.connections = Array.isArray(snapshot?.connections) ? snapshot.connections : [];
  applyReachability();
  scheduleRefresh();
}

function attach(): void {
  const remoteRuntime = window.ade?.remoteRuntime;
  if (!remoteRuntime) return;
  const unsubscribeSnapshot = remoteRuntime.onConnectionSnapshotChanged?.(applySnapshot);
  if (unsubscribeSnapshot) runtime.disposers.push(unsubscribeSnapshot);
  // These events cover the active binding. Other machines are covered by the
  // shared bounded refresh below because preload exposes no per-target push
  // subscription.
  const unsubscribeSessions = window.ade?.sessions?.onChanged?.(() => scheduleRefresh());
  if (unsubscribeSessions) runtime.disposers.push(unsubscribeSessions);
  const unsubscribeLanes = window.ade?.lanes?.onLifecycleEvent?.(() => scheduleRefresh());
  if (unsubscribeLanes) runtime.disposers.push(unsubscribeLanes);
  // The refresh loop stops itself while the window is hidden, so coming back is
  // the only thing that can restart it.
  if (typeof document !== "undefined") {
    const onVisibilityChange = () => {
      if (isDocumentVisible()) scheduleRefresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    runtime.disposers.push(() => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    });
  }
  // Lifecycle-guarded, deliberately NOT generation-guarded: if every consumer
  // unmounts before this first read resolves, applying it would write
  // reachability and arm a grace timer for a runtime nobody is subscribed to.
  // `generation` would be the wrong token — the 400ms coalesced refresh bumps it
  // on its own, so a snapshot slower than that would be discarded, leaving
  // `runtime.connections` empty and no foreign machine ever discovered.
  const lifecycle = runtime.lifecycle;
  void remoteRuntime.getConnectionSnapshot?.()
    .then((snapshot) => {
      if (lifecycle !== runtime.lifecycle) return;
      applySnapshot(snapshot);
    })
    .catch(() => {});
  // The preload event pump follows the active binding only. A bounded refresh
  // is therefore required for every other connected machine; without it their
  // lane/session rows remain stale indefinitely.
}

function detach(): void {
  runtime.generation += 1;
  runtime.lifecycle += 1;
  if (runtime.timer) {
    clearTimeout(runtime.timer);
    runtime.timer = null;
  }
  if (runtime.refreshTimer) {
    clearTimeout(runtime.refreshTimer);
    runtime.refreshTimer = null;
  }
  resetMachineTracking();
  runtime.refreshQueued = false;
  runtime.refreshInFlight = false;
  for (const dispose of runtime.disposers.splice(0)) {
    try {
      dispose();
    } catch {
      // A subscription that already tore itself down is not an error here.
    }
  }
}

/**
 * Starts (or joins) the union sync for a repo scope. Ref-counted: many mounted
 * consumers share ONE set of subscriptions and one fetch path.
 */
export function startCrossMachineLaneSync(scope: CrossMachineLaneScope): () => void {
  const scopeChanged = !sameScope(runtime.scope, scope);
  if (scopeChanged) {
    const preserveExistingIntent = runtime.scope.scopeKey === scope.scopeKey;
    // Project-tab transitions can briefly overlap React effect cleanup. Retarget
    // the shared runtime immediately; rejecting the new scope would leave it
    // permanently unsubscribed once the previous effect cleans up.
    runtime.generation += 1;
    // Deliberately NOT a `lifecycle` bump. Connections are machine-global, so a
    // scope change does not invalidate an in-flight first snapshot — and with
    // ref-counted consumers overlapping across a project-tab transition,
    // `refCount` never reaches zero, so no second snapshot read is coming.
    // Discarding it would leave `runtime.connections` empty for good.
    // The new scope does wipe every machine slice, though, so a deadline carried
    // over from the old one could hide a machine with no grace at all the moment
    // it reappears here.
    resetMachineTracking();
    runtime.scope = scope;
    rootAppStoreApi.getState().applyCrossMachineLaneScope(
      scope.scopeKey,
      resolveRefillIntendedMachineIds(resolveEligibleMachines(), preserveExistingIntent),
    );
  }
  runtime.scope = scope;
  runtime.refCount += 1;
  if (runtime.refCount === 1) attach();
  if (scopeChanged || runtime.refCount === 1) scheduleRefresh();
  return () => {
    runtime.refCount = Math.max(0, runtime.refCount - 1);
    if (runtime.refCount === 0) detach();
  };
}

/** Test seam — the sync engine is a module singleton. */
export function resetCrossMachineLaneSyncForTest(): void {
  detach();
  runtime.refCount = 0;
  runtime.connections = [];
  pendingForeignOptimisticSessionsByBinding.clear();
  runtime.scope = {
    scopeKey: null,
    repoDisplayName: null,
    repoOriginUrl: null,
    boundTargetId: null,
    boundProjectId: null,
    thisMachineBinding: null,
  };
  resetCrossMachineBranchStateCacheForTest();
}

// ── React entry point ───────────────────────────────────────────────────────

/**
 * The one subscription for the union. Every other surface reads the union out of
 * the store as derived state; nothing else opens its own feed.
 *
 * The returned object is memoized on the store slices it derives from, so a tick
 * that changes nothing hands back identical references and re-renders nothing.
 */
export function useCrossMachineLaneUnion(
  active = true,
  localSessions?: readonly TerminalSessionSummary[],
): CrossMachineUnion {
  // Stabilized by CONTENT, not by the array's identity. The caller's roster is
  // replaced wholesale by every session poll (~5s while anything is running),
  // so deriving a fresh Set per tick would hand `buildCrossMachineLaneRows` a
  // changed input and rebuild every foreign row, its marker map, and its
  // ordering on a timer — the memo below exists precisely to make an unchanged
  // tick free. Compared rather than serialized into a key because a session id
  // is not guaranteed UUID-shaped (imported and handoff sessions carry ids ADE
  // did not mint), so any separator a join picked would be an assumption about
  // their contents.
  const localSessionIdsRef = useRef<ReadonlySet<string>>(EMPTY_SESSION_IDS);
  const localSessionIds = useMemo(() => {
    if (!localSessions) return undefined;
    const previous = localSessionIdsRef.current;
    // Compared set-to-set rather than array-to-set: a roster that ever repeated
    // an id would never match its own cached set, and the only symptom would be
    // this cache silently never hitting again — the exact churn it exists to
    // prevent, invisible.
    const next: ReadonlySet<string> = new Set(localSessions.map((session) => session.id));
    if (next.size === previous.size && [...next].every((id) => previous.has(id))) {
      return previous;
    }
    localSessionIdsRef.current = next;
    return next;
  }, [localSessions]);
  const localLanes = useAppStore((state) => state.lanes);
  const projectBinding = useAppStore((state) => state.projectBinding);
  const scopeKey = useAppStore((state) => selectActiveProjectStateKey(state));
  const projectRoot = useAppStore((state) => state.project?.rootPath ?? null);
  const projectDisplayName = useAppStore((state) => state.project?.displayName ?? null);
  const machines = useRootAppStore((state) => state.crossMachineLanesByMachineId);
  const [localRepoIdentity, setLocalRepoIdentity] = useState<{
    scopeKey: string | null;
    originUrl: string | null;
    thisMachineBinding: Extract<OpenProjectBinding, { kind: "local" }> | null;
  } | null>(null);

  const repoDisplayName = projectBinding?.displayName ?? projectDisplayName;
  const boundTargetId = projectBinding?.kind === "remote" ? projectBinding.targetId : null;
  const boundProjectId = projectBinding?.kind === "remote" ? projectBinding.projectId : null;
  const repoOriginUrl = localRepoIdentity?.scopeKey === scopeKey
    ? localRepoIdentity.originUrl
    : undefined;
  const thisMachineBinding = localRepoIdentity?.scopeKey === scopeKey
    ? localRepoIdentity.thisMachineBinding
    : null;

  useEffect(() => {
    if (!projectRoot) return;
    let cancelled = false;
    const listRecent = window.ade?.project?.listRecent;
    if (typeof listRecent !== "function") {
      setLocalRepoIdentity({
        scopeKey,
        originUrl: null,
        thisMachineBinding: null,
      });
      return;
    }
    const loadIdentity = async () => {
      const projects = await listRecent();
      if (!boundTargetId || !boundProjectId) {
        const project = projects.find((candidate) => candidate.rootPath === projectRoot);
        return {
          originUrl: project?.gitOriginUrl ?? null,
          thisMachineBinding: null,
        };
      }
      const snapshot = await window.ade.remoteRuntime.getConnectionSnapshot();
      const connection = snapshot.connections.find(
        (candidate) => candidate.target.id === boundTargetId,
      );
      const boundProject = connection?.projects?.find(
        (candidate) => candidate.projectId === boundProjectId,
      );
      return {
        originUrl: boundProject?.gitOriginUrl ?? null,
        thisMachineBinding: resolveThisMachineBindingForOrigin(
          projects,
          boundProject?.gitOriginUrl,
        ),
      };
    };
    void loadIdentity()
      .then((identity) => {
        if (cancelled) return;
        setLocalRepoIdentity({ scopeKey, ...identity });
      })
      .catch(() => {
        if (!cancelled) {
          setLocalRepoIdentity({
            scopeKey,
            originUrl: null,
            thisMachineBinding: null,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [boundProjectId, boundTargetId, projectRoot, scopeKey]);

  useEffect(
    () => {
      if (!active) return undefined;
      if (repoOriginUrl === undefined) {
        rootAppStoreApi.getState().applyCrossMachineLaneScope(scopeKey);
        return undefined;
      }
      return startCrossMachineLaneSync({
        scopeKey,
        repoDisplayName,
        repoOriginUrl,
        boundTargetId,
        boundProjectId,
        thisMachineBinding,
      });
    },
    [active, boundProjectId, boundTargetId, repoDisplayName, repoOriginUrl, scopeKey, thisMachineBinding],
  );

  const rows = useMemo(
    () => buildCrossMachineLaneRows({
      localLanes,
      machines,
      activeBinding: projectBinding,
      localSessionIds,
    }),
    [localLanes, localSessionIds, machines, projectBinding],
  );
  return useMemo(() => {
    // Two different questions, and conflating them is what hid every badge when
    // the tab was bound to another Mac:
    //
    //   - `isActiveBinding` decides where a row RENDERS. The tab's machine owns
    //     the primary lane list; everything else renders as a union row.
    //   - `isThisMachine` decides whether a row is BADGED. That is about the
    //     physical Mac in front of you and nothing else.
    //
    // This used to bail on `foreignRows.length === 0` and drop the marker map
    // with it. Bind the tab to the Studio while sitting at the MacBook and every
    // lane is active-binding, so `foreignRows` is empty — yet every one of those
    // lanes is somewhere else and had just earned a marker. The markers were
    // computed correctly and then thrown away one line later.
    const foreignRows = orderCrossMachineRows(
      rows.filter((row) => !row.isActiveBinding),
    );
    // Single-machine setups take this branch forever: no marker map is built and
    // the lane header renders exactly as it did before this feature existed.
    if (!rows.some((row) => !row.isThisMachine)) {
      return foreignRows.length === 0
        ? EMPTY_CROSS_MACHINE_UNION
        : { foreignRows, markersByLaneId: EMPTY_MARKERS };
    }
    return {
      foreignRows,
      markersByLaneId: resolveCrossMachineLaneMarkers(rows),
    };
  }, [rows]);
}

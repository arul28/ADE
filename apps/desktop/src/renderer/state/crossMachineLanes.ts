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

import { useEffect, useMemo, useState } from "react";
import { remoteProjectBindingKey } from "../../shared/projectIdentity";
import type {
  AgentChatSession,
  LaneSummary,
  OpenProjectBinding,
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
  type LaneMachineRepoMatch,
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
 * The adaptive machine marker.
 *
 * Default is a bare monochrome glyph, and only for work that is not here — the
 * indicator appears exactly when it carries information. The name is promoted
 * into the row when a glyph alone would be ambiguous: the machine is offline,
 * two or more distinct foreign machines are on screen at once, or this lane's
 * branch also exists on another machine.
 *
 * The lane accent already owns the color channel, so the marker is monochrome —
 * a tinted marker would read as a second, competing lane color.
 */
export type CrossMachineLaneMarker = {
  machineId: string;
  machineName: string;
  /** False while the owning machine is unreachable; the row reads as dimmed. */
  online: boolean;
  mode: "glyph" | "name";
  /** Always the machine name — the glyph form still exposes it on hover. */
  title: string;
  /** True when the same branch exists as a lane on another machine. */
  sameBranchElsewhere: boolean;
};

const EMPTY_ROWS: CrossMachineLaneRow[] = [];
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
 * the store, offline ones included. The builder stays policy-free on purpose —
 * reachability is decided in exactly one place (`useCrossMachineLaneUnion`), and
 * keeping the raw shape here lets tests assert store retention separately from
 * what renders.
 */
export function buildCrossMachineLaneRows(input: {
  localLanes: readonly LaneSummary[];
  machines: Readonly<Record<string, CrossMachineMachineLanes>>;
  activeBinding?: OpenProjectBinding | null;
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
  for (const lane of input.localLanes) {
    rows.push({
      lane,
      machineId: activeMachineId,
      machineName: activeMachineName,
      online: true,
      isThisMachine: activeMachineId === THIS_MACHINE_ID,
      isActiveBinding: true,
      sessions: [],
      targetId: activeRemoteBinding?.targetId ?? null,
      projectId: activeRemoteBinding?.projectId ?? null,
      binding: activeRemoteBinding,
    });
  }
  for (const entry of Object.values(input.machines)) {
    // The active binding is already represented by `localLanes`. The sync
    // cache may also contain that remote machine, so drop its stale/duplicate
    // slice instead of rendering the same lane twice.
    if (entry.machineId === activeMachineId) continue;
    const sessionsByLaneId = new Map<string, TerminalSessionSummary[]>();
    for (const session of entry.sessions) {
      const laneId = session.laneId;
      if (!laneId) continue;
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
 * Resolves the adaptive marker for every foreign lane row. Local rows get no
 * entry at all — "work isn't here" is the only thing the marker communicates,
 * so on a single-machine setup this map is empty and the header is untouched.
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

  const distinctForeignMachineIds = new Set(foreign.map((row) => row.machineId));
  const manyForeignMachines = distinctForeignMachineIds.size >= 2;

  // Same-branch-elsewhere: a branch held as a lane on two or more machines. This
  // is the same condition the push-divergence guard reasons about, so the
  // sidebar names the machine rather than leaving the user to guess which one.
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
    const mode: CrossMachineLaneMarker["mode"] =
      !row.online || manyForeignMachines || sameBranchElsewhere ? "name" : "glyph";
    // Active-binding lanes render through the primary lane list, whose key is
    // the bare lane id. Other machines render through composite union rows.
    const markerKey = row.isActiveBinding
      ? row.lane.id
      : `${row.machineId}:${row.lane.id}`;
    markers.set(markerKey, {
      machineId: row.machineId,
      machineName: row.machineName,
      online: row.online,
      mode,
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
function shouldReadLanes(machineId: string, nowMs: number): boolean {
  const readAtMs = runtime.laneReadAtMsByMachineId.get(machineId);
  return readAtMs == null || nowMs - readAtMs >= FOREIGN_LANE_REFRESH_MS;
}

/** Lanes referenced by chats we can see but have no lane row for. */
function hasUnknownLaneReference(
  machineId: string,
  sessions: readonly TerminalSessionSummary[],
): boolean {
  const known = new Set(
    (rootAppStoreApi.getState().crossMachineLanesByMachineId[machineId]?.lanes ?? [])
      .map((lane) => lane.id),
  );
  return sessions.some((session) => session.laneId && !known.has(session.laneId));
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
  try {
    const wantLanes = shouldReadLanes(machineId, Date.now());
    const [laneResult, sessionResult] = await Promise.all([
      wantLanes ? readLanes() : null,
      withTimeout(
        callAction(targetId, projectId, {
          domain: "session",
          action: "list",
          args: { limit: FOREIGN_SESSION_LIMIT },
        }),
        MACHINE_READ_TIMEOUT_MS,
        `session.list on ${machineName}`,
      ),
    ]);
    // Cancellation: a scope change or a newer snapshot bumped the generation
    // while this read was in flight, so its answer is about a different world.
    if (generation !== runtime.generation) return;
    const sessions = decodeForeignSessions(sessionResult.result);
    // A chat is rendered under its lane, so a chat launched on a lane this
    // machine has never reported would be invisible until the slow lane cadence
    // came round. Seeing one is the signal to pay for the lane read now.
    let lanes = laneResult ? decodeForeignLanes(laneResult.result) : null;
    if (!lanes && hasUnknownLaneReference(machineId, sessions)) {
      const catchUp = await readLanes();
      if (generation !== runtime.generation) return;
      lanes = decodeForeignLanes(catchUp.result);
    }
    if (lanes) runtime.laneReadAtMsByMachineId.set(machineId, Date.now());
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
  try {
    const wantLanes = shouldReadLanes(THIS_MACHINE_ID, Date.now());
    const [laneResult, sessions] = await Promise.all([
      wantLanes ? readLanes() : null,
      withTimeout(
        window.ade.sessions.list(
          { limit: FOREIGN_SESSION_LIMIT },
          binding,
        ),
        MACHINE_READ_TIMEOUT_MS,
        "session.list on This Mac",
      ),
    ]);
    if (generation !== runtime.generation) return;
    let lanes = laneResult;
    if (!lanes && hasUnknownLaneReference(THIS_MACHINE_ID, sessions)) {
      lanes = await readLanes();
      if (generation !== runtime.generation) return;
    }
    if (lanes) runtime.laneReadAtMsByMachineId.set(THIS_MACHINE_ID, Date.now());
    store.mergeCrossMachineLanes({
      machineId: THIS_MACHINE_ID,
      machineName: THIS_MACHINE_NAME,
      targetId: null,
      projectId: null,
      binding,
      online: true,
      ...(lanes ? { lanes } : {}),
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
  store.applyCrossMachineLaneScope(scope.scopeKey);

  const targets = resolveEligibleMachines();

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
  return resolveMachineOptions().filter(isEligibleMachineOption);
}

/** What the newest snapshot says about one machine, whether connected or not. */
type MachineConnectivity = {
  /** `null` when the machine is not in the connection snapshot at all. */
  state: RemoteRuntimeConnectionState | null;
  /** `null` unless the machine is connected — the match needs its project list. */
  repoMatch: LaneMachineRepoMatch | null;
  eligible: boolean;
};

function resolveMachineConnectivity(): Map<string, MachineConnectivity> {
  const byMachineId = new Map<string, MachineConnectivity>();
  for (const connection of runtime.connections) {
    byMachineId.set(connection.target.id, {
      state: connection.state,
      repoMatch: null,
      eligible: false,
    });
  }
  // `deriveLaneMachineOptions` only returns connected machines, so anything it
  // names is connected and carries a usable repo verdict.
  for (const option of resolveMachineOptions()) {
    if (option.id === THIS_MACHINE_ID) continue;
    byMachineId.set(option.id, {
      state: "connected",
      repoMatch: option.repoMatch,
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
 * - DIMMED. Not connected, and a reconnect attempt has since run to completion
 *   and failed (or the target is idle, so no attempt is coming). Its lanes and
 *   chats stay on screen, collapsed and inert, because a machine being asleep
 *   does not make the work on it stop existing — and yanking a lane group out of
 *   the list on every wifi blip is what made machines look like they vanish.
 *   Believing a drop takes at least `UNREACHABLE_FLOOR_MS`, and at most
 *   `UNREACHABLE_CEILING_MS` when no attempt ever completes.
 * - FORGOTTEN. Only two things earn removal: the machine is gone from the
 *   connection snapshot entirely (unpaired or deleted — nothing will ever
 *   refresh it again), or it has been dimmed for `OFFLINE_RETENTION_MS`.
 *
 * A machine we ARE connected to but cannot re-prove the repository on is left
 * exactly as it was. Absence of proof is not proof of absence: a project list
 * that has not caught up after a reconnect must not read as "the repo is gone".
 * Only a connected machine that positively reports the repository missing is
 * dropped, which is what keeps "if it can't be refreshed, it isn't shown" true
 * for the case #941 was about.
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
  for (const entry of Object.values(store.crossMachineLanesByMachineId)) {
    const machineId = entry.machineId;
    // This Mac is not a connection target and is always reachable; holding a
    // drop record for it would leak a map entry nothing can ever clear.
    if (machineId === THIS_MACHINE_ID) continue;
    const machine = connectivity.get(machineId);
    if (machine?.eligible) continue;

    if (!machine) {
      forgotten.push(machineId);
      continue;
    }
    if (machine.state === "connected") {
      if (machine.repoMatch === "missing") {
        forgotten.push(machineId);
        continue;
      }
      runtime.dropsByMachineId.delete(machineId);
      if (entry.online) reachable.push(machineId);
      continue;
    }

    const drop = runtime.dropsByMachineId.get(machineId)
      ?? { droppedAtMs: nowMs, sawAttempt: false, attemptFailed: false };
    if (machine.state === "connecting") drop.sawAttempt = true;
    else if (drop.sawAttempt) drop.attemptFailed = true;
    runtime.dropsByMachineId.set(machineId, drop);

    const elapsedMs = nowMs - drop.droppedAtMs;
    // `idle` means the target is not dialing and will not start on its own, so
    // waiting for a failed attempt would wait forever.
    const answered = drop.attemptFailed || machine.state === "idle";
    if (elapsedMs < UNREACHABLE_FLOOR_MS || !(answered || elapsedMs >= UNREACHABLE_CEILING_MS)) {
      reachable.push(machineId);
      noteDeadline(drop.droppedAtMs + (answered ? UNREACHABLE_FLOOR_MS : UNREACHABLE_CEILING_MS));
      continue;
    }
    if (elapsedMs >= OFFLINE_RETENTION_MS) {
      forgotten.push(machineId);
      continue;
    }
    noteDeadline(drop.droppedAtMs + OFFLINE_RETENTION_MS);
  }

  if (forgotten.length > 0) {
    for (const machineId of forgotten) {
      runtime.dropsByMachineId.delete(machineId);
      runtime.laneReadAtMsByMachineId.delete(machineId);
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

/** Forgets every open drop record. Used by teardown and by scope changes. */
function resetReachabilityTracking(): void {
  if (runtime.graceTimer) {
    clearTimeout(runtime.graceTimer);
    runtime.graceTimer = null;
  }
  runtime.dropsByMachineId.clear();
  runtime.laneReadAtMsByMachineId.clear();
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
  resetReachabilityTracking();
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
    resetReachabilityTracking();
    rootAppStoreApi.getState().applyCrossMachineLaneScope(scope.scopeKey);
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
export function useCrossMachineLaneUnion(active = true): CrossMachineUnion {
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
    }),
    [localLanes, machines, projectBinding],
  );
  return useMemo(() => {
    const foreignRows = orderCrossMachineRows(
      rows.filter((row) => !row.isActiveBinding),
    );
    // Single-machine setups take this branch forever: no marker map is built and
    // the lane header renders exactly as it did before this feature existed.
    if (foreignRows.length === 0) return EMPTY_CROSS_MACHINE_UNION;
    return {
      foreignRows,
      markersByLaneId: resolveCrossMachineLaneMarkers(rows),
    };
  }, [rows]);
}

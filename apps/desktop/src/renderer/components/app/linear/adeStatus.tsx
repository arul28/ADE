import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Cloud, Desktop } from "@phosphor-icons/react";
import type {
  LaneSummary,
  NormalizedLinearIssue,
  OpenProjectBinding,
  PrSummary,
  TerminalSessionSummary,
} from "../../../../shared/types";
import { ADE_CLOUD_NAME } from "../../../../shared/adeCloudMachine";
import { laneDisplayName } from "../../../../shared/laneDisplayName";
import { THIS_MACHINE_ID } from "../../../../shared/machineIdentity";
import { SESSION_TONE_DOT_CLASS } from "../../../../shared/sessionStatusPresentation";
import { isTrackedAgentCliToolType } from "../../../../shared/types/sessions";
import {
  rootAppStoreApi,
  selectActiveProjectRoot,
  selectActiveProjectStateKey,
  useAppStore,
  useAppStoreApi,
  useRootAppStore,
  workViewStoreForProject,
  type AppState,
} from "../../../state/appStore";
import { buildCrossMachineLaneRows, type CrossMachineLaneRow } from "../../../state/crossMachineLanes";
import { machineLabelForMachine, useAdeCloudLaneComputers } from "../../../state/adeCloudLaneIndex";
import { rowShowsConnected } from "../../../state/cloudRestingRows";
import { useTabCopyPin } from "../../../state/repositoryScope";
import { listPrsCached } from "../../../lib/prReadCache";
import { lanePrDeepLinkPath } from "../../../lib/lanePrBadge";
import { openLaneInLanesTabPath, openLaneOnMachinePath } from "../../../lib/laneNavigation";
import { isChatToolType } from "../../../lib/sessions";
import { canonicalInputFromSummary, sessionIsMidFlight, sessionNeedsYou } from "../../../lib/terminalAttention";
import { selectLanePrs } from "../../lanes/lanePageModel";
import { HoverCard } from "../../ui/HoverCard";
import { LaneIcon } from "../../ui/vcsIcons";
import { cn } from "../../ui/cn";

/**
 * What ADE knows about a Linear issue: the lanes working on it (on any
 * connected machine), the chats and CLIs running there right now, and ADE's
 * own view of the issue's pull requests (checks, review).
 *
 * Everything here is read from data the renderer already holds: the tab's
 * lanes and session cache, the cross-machine union (other machines' lanes,
 * sessions and PR rows, kept current by the one app-wide union sync), and the
 * tab copy's PR list. Nothing is fetched per row and nothing polls. A store
 * that has not loaded yet just contributes nothing: the row shows what Linear
 * itself says.
 *
 * Fields past the shared contract (`machineId`, `online`, `chats`, `adePath`,
 * ...) are optional additions so the cell and the PR chips can open the right
 * thing on the right machine.
 */
export type LinearIssueAdeStatusLane = {
  laneId: string;
  laneName: string;
  /** The machine's name when the lane is not on this computer ("ADE Cloud" for a cloud lane). */
  machineLabel: string | null;
  /** The address of the lane's copy (its machine's binding key). */
  pinKey: string | null;
  /** The union slot id to open the lane by (`openLaneOnMachinePath`); null = the tab's own copy. */
  machineId?: string | null;
  /** False while the lane's machine is unreachable (a resting cloud computer counts as reachable). */
  online?: boolean;
  /** An ADE Cloud lane: opening it reads the account and never wakes its computer. */
  cloud?: boolean;
  /** This is the project's main checkout. */
  mainCheckout?: boolean;
};

export type LinearIssueAdeStatusChat = {
  sessionId: string;
  laneId: string;
  title: string;
  kind: "chat" | "cli";
  state: "working" | "needs_you";
  machineId: string | null;
  online: boolean;
};

export type LinearIssueAdeStatusPr = {
  number: number;
  url: string;
  state: "open" | "draft" | "merged" | "closed";
  checks: "passing" | "failing" | "pending" | "none";
  review: "approved" | "changes_requested" | "pending" | "none";
  title?: string;
  /** "owner/name". */
  repo?: string | null;
  /** In-app route to the PR in the PRs tab; absent when only GitHub can open it (another machine's PR). */
  adePath?: string | null;
};

export type LinearIssueAdeStatus = {
  lanes: LinearIssueAdeStatusLane[];
  /** Chats/CLIs working right now on those lanes. */
  runningChats: number;
  /** A chat on those lanes waits for the person. */
  needsInput: boolean;
  prs: LinearIssueAdeStatusPr[];
  /** The live chats behind `runningChats`, needs-you first. */
  chats?: LinearIssueAdeStatusChat[];
};

// ── Navigation ───────────────────────────────────────────────────────────────

/**
 * Asks the Linear pane to close: the cell and PR chips navigate the app under
 * it, and the pane is a modal on top. The pane's host listens for this.
 */
export const LINEAR_PANE_CLOSE_REQUEST_EVENT = "ade:linear-pane:close-request";

/**
 * Navigate the app shell from inside the Linear pane. Hash navigation works
 * under both routers (the web client bridges the hash), and keeps this file
 * usable where no router context exists.
 */
export function navigateFromLinearPane(path: string): void {
  window.location.hash = `#${path}`;
  window.dispatchEvent(new Event(LINEAR_PANE_CLOSE_REQUEST_EVENT));
}

export function openExternalUrl(url: string): void {
  const open = window.ade?.app?.openExternal;
  if (!open) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  void open(url).catch(() => {
    try {
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      /* nothing left to try */
    }
  });
}

function lanePath(laneId: string, machineId: string | null | undefined, sessionId?: string | null): string {
  // A lane on another machine opens in this tab's Lanes list, addressed by its
  // machine; the project tab never changes machine to show one lane.
  return machineId ? openLaneOnMachinePath(laneId, machineId, sessionId) : openLaneInLanesTabPath(laneId, sessionId);
}

export function openAdeStatusLane(lane: LinearIssueAdeStatusLane, sessionId?: string | null): void {
  navigateFromLinearPane(lanePath(lane.laneId, lane.machineId, sessionId));
}

export function openAdeStatusChat(chat: LinearIssueAdeStatusChat): void {
  navigateFromLinearPane(lanePath(chat.laneId, chat.machineId, chat.sessionId));
}

// ── PR helpers ───────────────────────────────────────────────────────────────

/** "github.com/Owner/Repo/pull/12/files?x" → "github.com/owner/repo/pull/12". */
export function normalizePrUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = /^(?:https?:\/\/)?(?:www\.)?([^/]+)\/([^/]+)\/([^/]+)\/(pull|merge_requests|-\/merge_requests)\/(\d+)/i.exec(url.trim());
  if (!match) return url.trim().toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
  return `${match[1]}/${match[2]}/${match[3]}/pull/${match[5]}`.toLowerCase();
}

export function prRepoNumberKey(repo: string | null | undefined, number: number | null | undefined): string | null {
  if (!repo || !number) return null;
  return `${repo.toLowerCase()}#${number}`;
}

function prChecks(status: PrSummary["checksStatus"]): LinearIssueAdeStatusPr["checks"] {
  if (status === "passing" || status === "failing" || status === "pending") return status;
  return "none";
}

function prReview(status: PrSummary["reviewStatus"]): LinearIssueAdeStatusPr["review"] {
  if (status === "approved" || status === "changes_requested") return status;
  if (status === "requested") return "pending";
  return "none";
}

function toStatusPr(pr: PrSummary, openInAde: boolean): LinearIssueAdeStatusPr {
  return {
    number: pr.githubPrNumber,
    url: pr.githubUrl,
    state: pr.state,
    checks: prChecks(pr.checksStatus),
    review: prReview(pr.reviewStatus),
    title: pr.title,
    repo: pr.repoOwner && pr.repoName ? `${pr.repoOwner}/${pr.repoName}` : null,
    // The PRs tab reads the tab's machine; another machine's PR id would land
    // on an empty tab, so that one opens on GitHub (`openLanePr`'s rule).
    adePath: openInAde ? lanePrDeepLinkPath(pr) : null,
  };
}

// ── The tab copy's PR rows ───────────────────────────────────────────────────

/**
 * The tab copy's mapped PR rows: one shared, short-cached read (the same
 * entry the chat header and Work tools use) when the Linear pane opens, then
 * kept current by the `prs-updated` push. No GitHub snapshot is read here;
 * a PR ADE has no row for shows Linear's own status. Other machines' rows
 * already ride in the union slices.
 */
function useTabCopyPrRows(): PrSummary[] | null {
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const bindingKey = useAppStore((state) => state.projectBinding?.key ?? null);
  const pin = useTabCopyPin();
  const pinRef = useRef<OpenProjectBinding | null>(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? null;
  const [state, setState] = useState<{ key: string; prs: PrSummary[] } | null>(null);

  useEffect(() => {
    const readPin = pinRef.current;
    const prsApi = window.ade?.prs;
    if (!readPin || !pinKey || typeof prsApi?.listAll !== "function") return undefined;
    let cancelled = false;
    void listPrsCached({ projectRoot, pin: readPin, bindingKey })
      .then((prs) => {
        if (!cancelled) setState({ key: pinKey, prs });
      })
      .catch(() => {});
    let unsubscribe: () => void = () => undefined;
    try {
      if (typeof prsApi.onEvent === "function") {
        unsubscribe = prsApi.onEvent((event) => {
          if (cancelled || event.type !== "prs-updated") return;
          setState({ key: pinKey, prs: event.prs });
        }, readPin);
      }
    } catch {
      // A machine with no live path (ADE Web): the list above still loaded.
    }
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [bindingKey, pinKey, projectRoot]);

  return state && state.key === pinKey ? state.prs : null;
}

// ── The index ────────────────────────────────────────────────────────────────

type LaneLinkScope = "lane" | Set<string>;

type IndexedLane = {
  row: CrossMachineLaneRow;
  ref: LinearIssueAdeStatusLane;
  /** Machine-scoped key: lane ids are unique per machine, not globally. */
  key: string;
};

type AdeLinkFromLinear = { laneId: string; sessionId: string | null };

/** Linear's own ADE links (oauthClient attachments ADE wrote with a lane id), from the normalized issue. */
function adeLinksOf(issue: NormalizedLinearIssue): AdeLinkFromLinear[] {
  const links: AdeLinkFromLinear[] = [];
  for (const entry of issue.adeLinks ?? []) {
    const laneId = entry.laneId?.trim();
    if (!laneId) continue;
    links.push({ laneId, sessionId: entry.sessionId?.trim() || null });
  }
  return links;
}

function isAgentSession(session: TerminalSessionSummary): boolean {
  return isChatToolType(session.toolType) || isTrackedAgentCliToolType(session.toolType);
}

function liveState(session: TerminalSessionSummary): "working" | "needs_you" | null {
  if (session.archivedAt || !isAgentSession(session)) return null;
  const input = canonicalInputFromSummary(session);
  if (sessionNeedsYou(input)) return "needs_you";
  if (sessionIsMidFlight(input)) return "working";
  return null;
}

function addScope(map: Map<string, LaneLinkScope>, laneKey: string, sessionId: string | null): void {
  const current = map.get(laneKey);
  if (current === "lane") return;
  if (!sessionId) {
    map.set(laneKey, "lane");
    return;
  }
  if (current) current.add(sessionId);
  else map.set(laneKey, new Set([sessionId]));
}

type BuiltIndex = {
  lanes: IndexedLane[];
  /** Linear issue id / identifier → lane key → link scope. */
  linksByIssue: Map<string, Map<string, LaneLinkScope>>;
  /** Bare lane id → lane keys (for Linear's own ADE attachments). */
  laneKeysById: Map<string, string[]>;
  lanesByKey: Map<string, IndexedLane>;
  sessionsByLaneKey: Map<string, TerminalSessionSummary[]>;
  prsByLaneKey: Map<string, LinearIssueAdeStatusPr[]>;
  prsByUrl: Map<string, LinearIssueAdeStatusPr>;
  prsByRepoNumber: Map<string, LinearIssueAdeStatusPr>;
};

function buildIndex(input: {
  rows: CrossMachineLaneRow[];
  localSessions: readonly TerminalSessionSummary[] | null;
  tabPrs: readonly PrSummary[] | null;
  foreignPrsByMachineId: Map<string, readonly PrSummary[]>;
  projectBinding: OpenProjectBinding | null;
  labelFor: (row: CrossMachineLaneRow) => string;
}): BuiltIndex {
  const lanes: IndexedLane[] = [];
  const lanesByKey = new Map<string, IndexedLane>();
  const laneKeysById = new Map<string, string[]>();
  const linksByIssue = new Map<string, Map<string, LaneLinkScope>>();
  const link = (issueKey: string | null | undefined, laneKey: string, sessionId: string | null) => {
    const key = issueKey?.trim();
    if (!key) return;
    let map = linksByIssue.get(key);
    if (!map) {
      map = new Map();
      linksByIssue.set(key, map);
    }
    addScope(map, laneKey, sessionId);
  };

  for (const row of input.rows) {
    const lane: LaneSummary = row.lane;
    if (lane.archivedAt) continue;
    const key = `${row.isActiveBinding ? "tab" : row.machineId}:${lane.id}`;
    if (lanesByKey.has(key)) continue;
    const label = row.isThisMachine ? null : input.labelFor(row);
    const indexed: IndexedLane = {
      row,
      key,
      ref: {
        laneId: lane.id,
        laneName: laneDisplayName(lane),
        machineLabel: label,
        pinKey: row.binding?.key ?? (row.isActiveBinding ? input.projectBinding?.key ?? null : null),
        machineId: row.isActiveBinding ? null : row.machineId,
        online: rowShowsConnected(row),
        cloud: label === ADE_CLOUD_NAME,
        mainCheckout: lane.laneType === "primary",
      },
    };
    lanes.push(indexed);
    lanesByKey.set(key, indexed);
    const sameId = laneKeysById.get(lane.id);
    if (sameId) sameId.push(key);
    else laneKeysById.set(lane.id, [key]);

    const primary = lane.linearIssue;
    if (primary) {
      link(primary.id, key, null);
      link(primary.identifier?.toUpperCase(), key, null);
    }
    for (const entry of lane.linearIssueLinks ?? []) {
      if (!entry.issue) continue;
      // A chat attachment ties the issue to that chat, not to every chat on the
      // lane (the main checkout hosts many unrelated chats).
      const sessionId = entry.source === "chat_attach" ? entry.evidence?.chatSessionId ?? null : null;
      const scopedSession = entry.source === "chat_attach" && sessionId ? sessionId : null;
      link(entry.issue.id, key, scopedSession);
      link(entry.issue.identifier?.toUpperCase(), key, scopedSession);
    }
  }

  // Sessions: the tab's own roster first, then each machine's slice. One
  // session counts once even when two sources report it.
  const sessionsByLaneKey = new Map<string, TerminalSessionSummary[]>();
  const seen = new Set<string>();
  const fileSession = (laneKey: string, session: TerminalSessionSummary) => {
    if (seen.has(session.id)) return;
    seen.add(session.id);
    const list = sessionsByLaneKey.get(laneKey);
    if (list) list.push(session);
    else sessionsByLaneKey.set(laneKey, [session]);
  };
  for (const session of input.localSessions ?? []) {
    if (session.laneId) fileSession(`tab:${session.laneId}`, session);
  }
  for (const indexed of lanes) {
    for (const session of indexed.row.sessions) fileSession(indexed.key, session);
  }

  // PRs: the tab copy's rows open in the PRs tab; another machine's open on GitHub.
  const prsByUrl = new Map<string, LinearIssueAdeStatusPr>();
  const prsByRepoNumber = new Map<string, LinearIssueAdeStatusPr>();
  const fileByIdentity = (pr: PrSummary, mapped: LinearIssueAdeStatusPr) => {
    const url = normalizePrUrl(pr.githubUrl);
    if (url && !prsByUrl.has(url)) prsByUrl.set(url, mapped);
    const repoKey = prRepoNumberKey(mapped.repo, pr.githubPrNumber);
    if (repoKey && !prsByRepoNumber.has(repoKey)) prsByRepoNumber.set(repoKey, mapped);
  };
  const mappedCache = new Map<PrSummary, LinearIssueAdeStatusPr>();
  const mapPr = (pr: PrSummary, openInAde: boolean) => {
    let mapped = mappedCache.get(pr);
    if (!mapped) {
      mapped = toStatusPr(pr, openInAde);
      mappedCache.set(pr, mapped);
      fileByIdentity(pr, mapped);
    }
    return mapped;
  };
  const groupByLane = (prs: readonly PrSummary[]) => {
    const byLane = new Map<string, PrSummary[]>();
    for (const pr of prs) {
      if (!pr.laneId) continue;
      const list = byLane.get(pr.laneId);
      if (list) list.push(pr);
      else byLane.set(pr.laneId, [pr]);
    }
    return byLane;
  };
  for (const pr of input.tabPrs ?? []) mapPr(pr, true);
  for (const prs of input.foreignPrsByMachineId.values()) for (const pr of prs) mapPr(pr, false);

  const prsByLaneKey = new Map<string, LinearIssueAdeStatusPr[]>();
  const tabByLane = groupByLane(input.tabPrs ?? []);
  const foreignByLane = new Map<string, Map<string, PrSummary[]>>();
  for (const [machineId, prs] of input.foreignPrsByMachineId) foreignByLane.set(machineId, groupByLane(prs));
  for (const indexed of lanes) {
    const candidates = indexed.row.isActiveBinding
      ? tabByLane.get(indexed.ref.laneId)
      : foreignByLane.get(indexed.row.machineId)?.get(indexed.ref.laneId);
    if (!candidates?.length) continue;
    // The lane's current-branch PRs, the same selector every lane badge uses
    // (a main checkout parked on its base branch has none).
    const selected = selectLanePrs(indexed.row.lane, candidates);
    if (selected.length) prsByLaneKey.set(indexed.key, selected.map((pr) => mapPr(pr, indexed.row.isActiveBinding)));
  }

  return { lanes, linksByIssue, laneKeysById, lanesByKey, sessionsByLaneKey, prsByLaneKey, prsByUrl, prsByRepoNumber };
}

const PR_STATE_RANK: Record<LinearIssueAdeStatusPr["state"], number> = { open: 0, draft: 1, merged: 2, closed: 3 };

function computeStatus(index: BuiltIndex, issue: NormalizedLinearIssue): LinearIssueAdeStatus | null {
  const scopes = new Map<string, LaneLinkScope>();
  const merge = (map: Map<string, LaneLinkScope> | undefined) => {
    if (!map) return;
    for (const [laneKey, scope] of map) {
      if (scope === "lane") addScope(scopes, laneKey, null);
      else for (const sessionId of scope) addScope(scopes, laneKey, sessionId);
    }
  };
  merge(index.linksByIssue.get(issue.id));
  if (issue.identifier) merge(index.linksByIssue.get(issue.identifier.toUpperCase()));
  // Linear's own ADE links (attachments ADE wrote with the lane id).
  for (const entry of adeLinksOf(issue)) {
    for (const laneKey of index.laneKeysById.get(entry.laneId) ?? []) addScope(scopes, laneKey, entry.sessionId);
  }

  const lanes: LinearIssueAdeStatusLane[] = [];
  const chats: LinearIssueAdeStatusChat[] = [];
  const prs: LinearIssueAdeStatusPr[] = [];
  const prSeen = new Set<LinearIssueAdeStatusPr>();
  const addPr = (pr: LinearIssueAdeStatusPr | undefined) => {
    if (!pr || prSeen.has(pr)) return;
    prSeen.add(pr);
    prs.push(pr);
  };

  for (const [laneKey, scope] of scopes) {
    const indexed = index.lanesByKey.get(laneKey);
    if (!indexed) continue;
    lanes.push(indexed.ref);
    for (const session of index.sessionsByLaneKey.get(laneKey) ?? []) {
      if (scope !== "lane" && !scope.has(session.id)) continue;
      const state = liveState(session);
      if (!state) continue;
      chats.push({
        sessionId: session.id,
        laneId: indexed.ref.laneId,
        title: session.title?.trim() || session.goal?.trim() || (isChatToolType(session.toolType) ? "Chat" : "CLI session"),
        kind: isChatToolType(session.toolType) ? "chat" : "cli",
        state,
        machineId: indexed.ref.machineId ?? null,
        online: indexed.ref.online !== false,
      });
    }
    // A chat-scoped link (main checkout) does not claim the lane's PRs.
    if (scope === "lane") for (const pr of index.prsByLaneKey.get(laneKey) ?? []) addPr(pr);
  }
  for (const linearPr of issue.pullRequests ?? []) {
    const url = normalizePrUrl(linearPr.url);
    addPr((url ? index.prsByUrl.get(url) : undefined) ?? index.prsByRepoNumber.get(prRepoNumberKey(linearPr.repo, linearPr.number) ?? ""));
  }

  if (lanes.length === 0 && prs.length === 0) return null;
  // This computer first, then reachable machines; names after.
  lanes.sort((a, b) => {
    const rank = (lane: LinearIssueAdeStatusLane) => (lane.machineLabel == null ? 0 : lane.online === false ? 2 : 1);
    return rank(a) - rank(b) || a.laneName.localeCompare(b.laneName);
  });
  chats.sort((a, b) => (a.state === b.state ? a.title.localeCompare(b.title) : a.state === "needs_you" ? -1 : 1));
  prs.sort((a, b) => PR_STATE_RANK[a.state] - PR_STATE_RANK[b.state] || b.number - a.number);
  return {
    lanes,
    runningChats: chats.length,
    needsInput: chats.some((chat) => chat.state === "needs_you"),
    prs,
    chats,
  };
}

function statusSignature(status: LinearIssueAdeStatus | null): string {
  return status ? JSON.stringify(status) : "";
}

const NO_SESSIONS: TerminalSessionSummary[] | null = null;

/**
 * Read the project's own store. The Linear pane renders from the top bar,
 * above `AppStoreProvider`, where `useAppStore` is the root store: the Work
 * tab's session cache (and the freshest lane list) live in the project's
 * surface store, which the root store only receives on a project switch.
 */
function useProjectSurfaceSlice<T>(projectStateKey: string | null, selector: (state: AppState) => T): T {
  const contextStore = useAppStoreApi();
  const store = contextStore !== rootAppStoreApi ? contextStore : workViewStoreForProject(projectStateKey);
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const read = useCallback(() => selectorRef.current(store.getState()), [store]);
  return useSyncExternalStore(store.subscribe, read, read);
}

/** Memoized index over lanes/sessions/PRs from every connected machine. Returns a stable lookup. */
export function useLinearIssueAdeStatusIndex(): (issue: NormalizedLinearIssue) => LinearIssueAdeStatus | null {
  const projectBinding = useAppStore((state) => state.projectBinding);
  const projectStateKey = useAppStore(selectActiveProjectStateKey);
  const localLanes = useProjectSurfaceSlice(projectStateKey, (state) => state.lanes);
  const localSessions = useProjectSurfaceSlice(projectStateKey, (state) => (
    projectStateKey ? state.sessionsCacheByProject[projectStateKey] ?? NO_SESSIONS : NO_SESSIONS
  ));
  // Root store: the union is written there only (see `machineEntryForBinding`).
  const machines = useRootAppStore((state) => state.crossMachineLanesByMachineId);
  const { computers } = useAdeCloudLaneComputers();
  const tabPrs = useTabCopyPrRows();

  // Results that did not change keep their object across index rebuilds (the
  // union ticks every ~10 s while chats run), so memoized rows stay put.
  const previousResults = useRef(new Map<string, { signature: string; status: LinearIssueAdeStatus | null }>());

  return useMemo(() => {
    const rows = buildCrossMachineLaneRows({
      localLanes: localLanes ?? [],
      machines: machines ?? {},
      activeBinding: projectBinding,
      cloudLaneComputers: computers,
    });
    const activeMachineId = projectBinding?.kind === "remote" ? projectBinding.targetId : THIS_MACHINE_ID;
    const foreignPrsByMachineId = new Map<string, readonly PrSummary[]>();
    for (const entry of Object.values(machines ?? {})) {
      if (entry.machineId === activeMachineId || !entry.prs?.length) continue;
      foreignPrsByMachineId.set(entry.machineId, entry.prs);
    }
    const index = buildIndex({
      rows,
      localSessions,
      tabPrs,
      foreignPrsByMachineId,
      projectBinding,
      labelFor: (row) => machineLabelForMachine({
        hostname: row.binding?.kind === "remote" ? row.binding.hostname ?? null : null,
        machineKey: row.machineId,
        name: row.machineName,
      }, computers),
    });
    const built = new WeakMap<NormalizedLinearIssue, LinearIssueAdeStatus | null>();
    const previous = previousResults.current;
    if (previous.size > 2000) previous.clear();
    return (issue: NormalizedLinearIssue) => {
      if (built.has(issue)) return built.get(issue) ?? null;
      const next = computeStatus(index, issue);
      const signature = statusSignature(next);
      const kept = previous.get(issue.id);
      const status = kept && kept.signature === signature ? kept.status : next;
      if (!kept || kept.status !== status) previous.set(issue.id, { signature, status });
      built.set(issue, status);
      return status;
    };
  }, [computers, localLanes, localSessions, machines, projectBinding, tabPrs]);
}

// ── The cell ─────────────────────────────────────────────────────────────────

/**
 * Enter/Space on a chip inside a row belong to the chip: the row's own key
 * handler would select the row and cancel the chip's click.
 */
export function stopRowActivation(event: React.KeyboardEvent): void {
  if (event.key === "Enter" || event.key === " ") event.stopPropagation();
}

function LiveDot({ state, className }: { state: "working" | "needs_you"; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "block h-[5px] w-[5px] rounded-full",
        state === "needs_you" ? SESSION_TONE_DOT_CLASS.amber : SESSION_TONE_DOT_CLASS.blue,
        state === "working" && "motion-safe:animate-pulse",
        className,
      )}
    />
  );
}

function MachineGlyph({ lane, size = 10 }: { lane: LinearIssueAdeStatusLane; size?: number }) {
  if (lane.machineLabel == null) return null;
  return lane.cloud
    ? <Cloud size={size} weight="bold" aria-hidden className="shrink-0" />
    : <Desktop size={size} weight="bold" aria-hidden className="shrink-0" />;
}

function cellLabel(status: LinearIssueAdeStatus): string {
  const parts: string[] = [];
  parts.push(status.lanes.length === 1 ? `Lane ${status.lanes[0]!.laneName}` : `${status.lanes.length} lanes`);
  const foreign = status.lanes.find((lane) => lane.machineLabel);
  if (foreign && status.lanes.length === 1) parts.push(`on ${foreign.machineLabel}`);
  if (status.needsInput) parts.push("a chat needs you");
  else if (status.runningChats > 0) parts.push(status.runningChats === 1 ? "1 chat working" : `${status.runningChats} chats working`);
  return parts.join(", ");
}

function StatusCard({ status }: { status: LinearIssueAdeStatus }) {
  const chats = status.chats ?? [];
  return (
    <div className="overflow-hidden rounded-lg border border-fg/[0.10] bg-[color:var(--color-popup-bg)] py-1 text-[12px] shadow-[var(--shadow-popup)]">
      {status.lanes.map((lane) => {
        const laneChats = chats.filter((chat) => chat.laneId === lane.laneId && chat.machineId === (lane.machineId ?? null));
        const offline = lane.online === false;
        return (
          <div key={`${lane.machineId ?? "tab"}:${lane.laneId}`} className="px-1">
            <button
              type="button"
              disabled={offline}
              className={cn(
                "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                offline ? "cursor-default opacity-60" : "hover:bg-fg/[0.05]",
              )}
              title={offline ? `${lane.machineLabel ?? "Its computer"} is offline` : "Open lane"}
              onClick={() => openAdeStatusLane(lane)}
            >
              <LaneIcon size={13} className="text-muted-fg/70" />
              <span className="min-w-0 flex-1 truncate text-fg/90">{lane.laneName}</span>
              {lane.machineLabel ? (
                <span className="flex min-w-0 max-w-[45%] shrink-0 items-center gap-1 text-[11px] text-muted-fg/60">
                  <MachineGlyph lane={lane} />
                  <span className="truncate">{lane.machineLabel}</span>
                  {offline ? <span className="shrink-0">offline</span> : null}
                </span>
              ) : null}
            </button>
            {laneChats.map((chat) => (
              <button
                key={chat.sessionId}
                type="button"
                disabled={!chat.online}
                className={cn(
                  "flex w-full min-w-0 items-center gap-2 rounded-md py-1 pl-[30px] pr-2 text-left transition-colors",
                  chat.online ? "hover:bg-fg/[0.05]" : "cursor-default opacity-60",
                )}
                title={chat.kind === "chat" ? "Open chat" : "Open CLI session"}
                onClick={() => openAdeStatusChat(chat)}
              >
                <LiveDot state={chat.state} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate text-fg/80">{chat.title}</span>
                <span className={cn("shrink-0 text-[11px]", chat.state === "needs_you" ? "text-amber-500 dark:text-amber-300" : "text-muted-fg/60")}>
                  {chat.state === "needs_you" ? "Needs you" : "Working"}
                </span>
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The ADE column of a Linear issue row: a lane glyph (with the machine when
 * the lane is not on this computer), a live dot while a chat works (amber when
 * one waits for the person). Click opens the chat that needs you, the one
 * working chat, or the lane; hover lists every lane and chat.
 */
export function LinearIssueAdeStatusCell({ status }: { status: LinearIssueAdeStatus | null }): JSX.Element | null {
  const primaryAction = useCallback(() => {
    if (!status) return;
    const chats = (status.chats ?? []).filter((chat) => chat.online);
    const waiting = chats.find((chat) => chat.state === "needs_you");
    if (waiting) return openAdeStatusChat(waiting);
    if (chats.length === 1) return openAdeStatusChat(chats[0]!);
    const lane = status.lanes.find((candidate) => candidate.online !== false);
    if (lane) openAdeStatusLane(lane);
  }, [status]);

  if (!status || status.lanes.length === 0) return null;
  const foreign = status.lanes.length === 1 ? status.lanes[0]!.machineLabel ? status.lanes[0]! : null : null;
  const allOffline = status.lanes.every((lane) => lane.online === false);
  const dotState = status.needsInput ? "needs_you" : status.runningChats > 0 ? "working" : null;
  const label = cellLabel(status);

  return (
    <HoverCard className="inline-flex shrink-0" label={label} width={320} content={<StatusCard status={status} />}>
      <button
        type="button"
        aria-label={label}
        disabled={allOffline}
        data-linear-ade-status=""
        className={cn(
          "inline-flex h-[22px] max-w-[96px] shrink-0 items-center gap-1 rounded-md px-1 text-muted-fg/65 outline-none transition-colors",
          "hover:bg-fg/[0.06] hover:text-fg focus-visible:bg-fg/[0.06] focus-visible:text-fg",
          allOffline && "opacity-55",
        )}
        onClick={(event) => {
          event.stopPropagation();
          primaryAction();
        }}
        onKeyDown={stopRowActivation}
      >
        <span className="relative grid place-items-center">
          <LaneIcon size={13} />
          {dotState ? (
            <LiveDot
              state={dotState}
              className="absolute -right-[2px] -top-[1px] ring-[1.5px] ring-[color:var(--color-bg)]"
            />
          ) : null}
        </span>
        {status.lanes.length > 1 ? <span className="text-[11px] tabular-nums">{status.lanes.length}</span> : null}
        {foreign ? <MachineGlyph lane={foreign} /> : null}
      </button>
    </HoverCard>
  );
}

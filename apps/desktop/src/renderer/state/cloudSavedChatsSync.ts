/**
 * Puts a window's saved chats (see `cloudSavedChats.ts`) into the Work list: one
 * read of the account's list on a connection change or window focus, at most
 * every 30 s, never a poll. Transcripts are read only when a chat is opened.
 */

import { findMachineProject, remoteProjectBindingKey } from "../../shared/projectIdentity";
import type { CloudSavedChatRow } from "../../shared/cloudSavedChats";
import type { CloudProjectOverview } from "../../../../account-directory/src/cloud/contract";
import type { OpenProjectBinding } from "../../shared/types/core";
import type { LaneSummary } from "../../shared/types/lanes";
import type { RemoteRuntimeConnectionStatus } from "../../shared/types/remoteRuntime";
import type { AgentChatApi } from "../components/chat/agentChatApi";
import { isRuntimeTransportTimeoutError } from "../../shared/runtimeErrors";
import { sessionTurnLive } from "../../shared/sessionStatusPresentation";
import { WOKEN_MACHINE_CONNECT_WAIT_MS } from "../../shared/wokenMachine";
import { rootAppStoreApi } from "./appStore";
import { adeCloudLaneComputerForMachine, adeCloudLaneComputersNow, cloudLaneIndexFresh } from "./adeCloudLaneIndex";
import { sameMachineKey } from "../../shared/machineAddress";
import { readWebAccountMachineKeys } from "./webAccountMachineKeys";
import { projectPinOnMachine } from "../lib/machineConnect";
import { MachineConnectError } from "../../shared/machineAddress";
import { adeCloudEnabled } from "./cloudAccess";
import { cloudBoxForMachine } from "../components/remoteTargets/cloudMachineModel";
import { watchedCloudMachines } from "../components/remoteTargets/useCloudMachines";
import { SAVED_CHATS_MACHINE_PREFIX } from "../../shared/cloudSavedChats";
import { isAdeAvailable } from "../lib/adeAvailability";
import {
  cloudConnectionMachineKey,
  isSavedChatsMachineId,
  replaceCloudConnectionTargets,
  replaceSavedChatLocations,
  savedChatLane,
  savedChatLocation,
  savedChatSession,
  withSavedChatReads,
  SAVED_CHAT_COMPUTER_GONE_MESSAGE,
  type SavedChatLocation,
  type SavedChatReach,
} from "./cloudSavedChats";
import { sendThroughAdeCloudQueue } from "./adeCloudChatQueue";
import { startAdeCloudRestingReads } from "./adeCloudRestingReads";
import { isSavedTerminalSession, savedTerminalSession } from "./cloudSavedTerminals";

/** Computers a reach found off the account (contract C2 `not_in_account`): gone, whatever the lists say. */
const goneMachineKeys = new Set<string>();

const REFRESH_DEBOUNCE_MS = 500;
const MIN_REFRESH_INTERVAL_MS = 30_000;

export type SavedChatsContext = {
  connections: readonly RemoteRuntimeConnectionStatus[];
  /** The tab's repo identity; null means no way to tell which chats belong here. */
  projectKey: string | null;
  /** False once the window hid, or moved to another project: an answer for this read is then dropped. */
  isActive: () => boolean;
};

let timer: ReturnType<typeof setTimeout> | null = null;
let lastReadAtMs = 0;
/** The project that read was for: another project's tab reads at once. */
let lastReadProjectKey: string | null = null;
let inFlight = false;
/** A forced read is waiting in the debounce. */
let forcePending = false;
/** A read asked for while one was running (a project switch); it runs next. */
let queuedContext: SavedChatsContext | null = null;

/** Reads the list soon, unless it was read in the last 30 seconds. `force` skips that wait. */
export function scheduleCloudSavedChatsRefresh(context: () => SavedChatsContext, options?: { force?: boolean }): void {
  if (!window.ade?.cloud?.savedChats) return;
  if (timer) clearTimeout(timer);
  // A plain request that replaces a forced one inside the debounce keeps it forced.
  forcePending ||= options?.force === true;
  timer = setTimeout(() => {
    timer = null;
    const force = forcePending;
    forcePending = false;
    // Inside the debounce, so a window just opened has its access answer by now.
    if (!adeCloudEnabled()) return;
    const next = context();
    if (!force && next.projectKey === lastReadProjectKey && Date.now() - lastReadAtMs < MIN_REFRESH_INTERVAL_MS) return;
    void refreshCloudSavedChats(next);
  }, REFRESH_DEBOUNCE_MS);
}

/**
 * The connection of the computer with this account key. ADE Web names its
 * connections by environment id and leaves `pairedMachine.machineKey` empty;
 * its key map says which account computer each one is.
 */
const connectionFor = (
  connections: readonly RemoteRuntimeConnectionStatus[],
  machineKey: string,
  instanceId: string | null,
): RemoteRuntimeConnectionStatus | null =>
  connections.find((connection) => sameMachineKey(connection.target.pairedMachine?.machineKey, machineKey))
  ?? connections.find((connection) => sameMachineKey(readWebAccountMachineKeys().get(connection.target.id), machineKey))
  ?? (instanceId
    ? connections.find((connection) => connection.target.hostname?.trim().toLowerCase() === instanceId.toLowerCase())
    : undefined)
  ?? null;

/**
 * The project's name for a binding made from saved data: the folder's name,
 * else the repository's name from its origin. Never the computer's name: a
 * row's line names the project (rule A), and the binding's `displayName` is
 * the project's.
 */
function savedProjectName(rootPath: string | null | undefined, origin: string | null | undefined): string {
  const last = (value: string | null | undefined) =>
    (value ?? "").trim().replace(/[\\/]+$/, "").split(/[\\/:]/).pop()?.replace(/\.git$/i, "") ?? "";
  return last(rootPath) || last(origin) || "Project";
}

const savedBinding = (machineId: string, row: CloudSavedChatRow, runtimeName: string): OpenProjectBinding => ({
  kind: "remote",
  key: `${machineId}:${row.projectKey ?? ""}`,
  targetId: machineId,
  runtimeName,
  transport: "paired",
  // The computer's ADE Cloud id: the chat's chip names the lane, not the computer.
  ...(row.instanceId ? { hostname: row.instanceId } : {}),
  projectId: row.projectId ?? row.projectKey ?? row.machineKey,
  rootPath: row.projectRoot ?? "",
  displayName: savedProjectName(row.projectRoot, row.projectKey),
  // The repository address: an account read of this pin (files, History) needs it.
  ...(row.projectKey ? { gitOriginUrl: row.projectKey } : {}),
});

const realBinding = (
  connection: RemoteRuntimeConnectionStatus,
  row: CloudSavedChatRow,
): OpenProjectBinding | null => {
  // By id, then by folder (older rows carry the project's database id, not the
  // id the machine routes by), then the machine's only project. Never a guess
  // among several: the row's own id goes, and the machine answers for it.
  const projects = connection.projects ?? [];
  const project = findMachineProject(projects, { projectId: row.projectId, rootPath: row.projectRoot })
    ?? (projects.length === 1 ? projects[0] : undefined);
  const projectId = project?.projectId ?? row.projectId;
  if (!projectId) return null;
  return {
    kind: "remote",
    key: remoteProjectBindingKey(connection.target.id, projectId),
    targetId: connection.target.id,
    runtimeName: connection.target.name,
    transport: "paired",
    ...(connection.target.hostname ? { hostname: connection.target.hostname } : {}),
    projectId,
    rootPath: project?.rootPath ?? row.projectRoot ?? "",
    displayName: project?.displayName ?? savedProjectName(row.projectRoot, row.projectKey),
  };
};

/** A saved chat row, listed under the machine its lane is on now (`savedOnMachineKey`: where its copy was saved). */
type RoutedSavedChatRow = CloudSavedChatRow & { savedOnMachineKey?: string };

/**
 * Contract C3 for saved chats: a chat whose lane moved to a new computer is
 * listed under that computer, from the old computer's saved copy until the new
 * one saves its own. One row per chat and machine: the newest copy.
 */
function routeSavedChatsToLaneComputers(rows: readonly CloudSavedChatRow[]): RoutedSavedChatRow[] {
  const lanes = adeCloudLaneComputersNow();
  const kept = new Map<string, RoutedSavedChatRow>();
  for (const row of rows) {
    const lane = row.laneId ? lanes.find((computer) => computer.laneId === row.laneId) : undefined;
    // Only a copy from a computer that is no longer any lane's moves.
    const movedTo = lane?.machineKey && !sameMachineKey(lane.machineKey, row.machineKey)
      && !lanes.some((computer) => sameMachineKey(computer.machineKey, row.machineKey))
      ? { machineKey: lane.machineKey, instanceId: lane.instanceId }
      : null;
    const routed: RoutedSavedChatRow = movedTo
      ? { ...row, machineKey: movedTo.machineKey, instanceId: movedTo.instanceId, savedOnMachineKey: row.machineKey }
      : row;
    const key = `${routed.machineKey.toLowerCase()}\u0000${routed.chatId}`;
    const current = kept.get(key);
    if (!current || routed.updatedAt > current.updatedAt) kept.set(key, routed);
  }
  return [...kept.values()];
}

/** Chats the server answers per page (its most), and how many pages one read takes. */
const SAVED_CHATS_PAGE = 500;
const SAVED_CHATS_MAX_PAGES = 10;

/**
 * Every saved chat of the project, page by page (newest activity first), so a
 * project with more than one page of chats lists them all. A page that fails
 * after the first keeps what the earlier pages read; a failed first page is
 * "couldn't read" (null), never an empty list.
 */
async function listAllSavedChats(
  bridge: NonNullable<NonNullable<Window["ade"]["cloud"]>["savedChats"]>,
  context: SavedChatsContext,
): Promise<{ chats: CloudSavedChatRow[]; nextCursor: string | null } | null> {
  const first = await bridge.list({ projectKey: context.projectKey, limit: SAVED_CHATS_PAGE });
  if (!first) return null;
  const chats = [...first.chats];
  let cursor = first.nextCursor;
  for (let page = 1; cursor && page < SAVED_CHATS_MAX_PAGES && context.isActive(); page += 1) {
    const next = await bridge.list({ projectKey: context.projectKey, limit: SAVED_CHATS_PAGE, cursor }).catch((error: unknown) => {
      console.warn("[cloud] a later saved chats page failed; the list keeps the pages read", error instanceof Error ? error.message : String(error));
      return null;
    });
    if (!next) break;
    chats.push(...next.chats);
    cursor = next.nextCursor;
  }
  return { chats, nextCursor: cursor };
}

export async function refreshCloudSavedChats(context: SavedChatsContext): Promise<void> {
  const bridge = window.ade?.cloud?.savedChats;
  if (inFlight) {
    queuedContext = context;
    return;
  }
  startAdeCloudRestingReads();
  if (!bridge || !context.isActive() || !context.projectKey) return;
  inFlight = true;
  lastReadAtMs = Date.now();
  lastReadProjectKey = context.projectKey;
  try {
    // The project's ADE Cloud lanes from the account, read with the chats:
    // a lane with no chat, or with no computer, lists from it (null from an
    // older server or ADE: those lanes then show as before).
    const [list, overview] = await Promise.all([
      listAllSavedChats(bridge, context),
      readProjectOverview(context.projectKey),
    ]);
    if (!list || !context.isActive()) return;
    const store = rootAppStoreApi.getState();
    // Live here: connected, and its rows not dimmed. A connection can stay up
    // after its computer stopped answering (ADE Web's relay holds it), and the
    // list hides a dimmed live slice: its saved copies show instead.
    const liveHere = (connection: RemoteRuntimeConnectionStatus | null) =>
      connection?.state === "connected" && store.crossMachineLanesByMachineId[connection.target.id]?.online !== false;
    const byMachine = new Map<string, RoutedSavedChatRow[]>();
    // Only this project's chats, as the server filters them: a row that names
    // another project never lists in this tab.
    const projectChats = list.chats.filter((row) => !row.projectKey || !context.projectKey || row.projectKey === context.projectKey);
    for (const row of routeSavedChatsToLaneComputers(projectChats)) {
      const rows = byMachine.get(row.machineKey);
      if (rows) rows.push(row);
      else byMachine.set(row.machineKey, [row]);
    }
    const nextLocations: Array<{ pinKey: string; location: SavedChatLocation }> = [];
    const keptSyntheticIds = new Set<string>();
    // Slices that hold a lane computer of this project: they stay for their lane.
    const laneSliceIds = new Set<string>();
    // Slices this read put this project's saved copies on.
    const savedSliceIds = new Set<string>();
    // The account's cloud computers, when a surface keeps that list current.
    // A computer missing from it was deleted, even while this desktop still
    // holds a saved connection to it (a move made on another desktop).
    const cloud = watchedCloudMachines();
    // A list whose computers the server did not give (`computersUnread`) says nothing about them.
    const cloudBoxes = cloud?.state === "ok" && !cloud.computersUnread ? cloud.machines : null;
    const machineFacts = new Map<string, { connection: RemoteRuntimeConnectionStatus | null; gone: boolean; name: string | null }>();
    for (const [machineKey, rows] of byMachine) {
      const connection = connectionFor(context.connections, machineKey, rows[0]!.instanceId);
      const box = cloudBoxes ? cloudBoxForMachine(cloudBoxes, { machineKey, hostname: rows[0]!.instanceId }) : null;
      const laneComputer = adeCloudLaneComputerForMachine({ machineKey, hostname: rows[0]!.instanceId });
      // Gone only when the account says so: the list's own answer for the
      // computer that saved the chats (a row moved to its lane's new computer
      // speaks for the old one, so it doesn't count), the live computer list,
      // or a reach that found it off the account. With no answer from the
      // list (an older server), a lane index read in the last few minutes
      // decides. No connection on THIS desktop is not gone: another desktop
      // made it, and a send reaches it by its key. One row that says the
      // computer exists, or a live entry in the computer list, outweighs a delete.
      const answers = rows.flatMap((row) => (!row.savedOnMachineKey && row.computer ? [row.computer] : []));
      const told = answers.find((answer) => answer.state === "exists") ?? answers[0] ?? null;
      const gone = goneMachineKeys.has(machineKey.toLowerCase())
        || (told?.state === "deleted" && !box)
        || (cloudBoxes != null ? !box : !told && !connection && cloudLaneIndexFresh() && !laneComputer);
      machineFacts.set(machineKey, { connection, gone, name: box?.name ?? laneComputer?.laneName ?? null });
    }
    const cloudTargets = new Map<string, string>();
    for (const [machineKey, facts] of machineFacts) {
      if (facts.connection && !facts.gone) cloudTargets.set(facts.connection.target.id, machineKey);
    }
    // A cloud computer with no saved chat of this project yet (its first chat
    // runs now) is a cloud connection too: its sleep shows, and a send wakes it.
    const knownCloudComputers: Array<{ machineKey: string | null; instanceId: string | null }> = [
      ...(cloudBoxes ?? []),
      ...adeCloudLaneComputersNow(),
    ];
    for (const computer of knownCloudComputers) {
      const machineKey = computer.machineKey;
      if (!machineKey || machineFacts.has(machineKey) || goneMachineKeys.has(machineKey.toLowerCase())) continue;
      const connection = connectionFor(context.connections, machineKey, computer.instanceId);
      if (connection && !cloudTargets.has(connection.target.id)) cloudTargets.set(connection.target.id, machineKey);
    }
    replaceCloudConnectionTargets(cloudTargets);
    // One computer shows each chat. After a move, the new computer saves the
    // same chats (same ids) as the old one. A computer that still exists wins
    // over a deleted one; between two that exist, a connected one, then the
    // newer copy. Object order never decides.
    const ownerByChatId = new Map<string, { machineKey: string; connected: boolean; updatedAt: number }>();
    for (const [machineKey, rows] of byMachine) {
      const facts = machineFacts.get(machineKey)!;
      if (facts.gone) continue;
      const connected = liveHere(facts.connection);
      for (const row of rows) {
        const current = ownerByChatId.get(row.chatId);
        if (
          !current
          || (connected && !current.connected)
          || (connected === current.connected && row.updatedAt > current.updatedAt)
        ) ownerByChatId.set(row.chatId, { machineKey, connected, updatedAt: row.updatedAt });
      }
    }
    // Machines whose own saved chats show (the lane fallback below is for the rest).
    const showsSavedChats = new Set<string>();
    for (const [machineKey, machineRows] of byMachine) {
      const { connection, gone, name } = machineFacts.get(machineKey)!;
      const rows = machineRows.filter((row) => {
        const owner = ownerByChatId.get(row.chatId);
        return owner ? owner.machineKey === machineKey : gone;
      });
      if (rows.length === 0) {
        // Every chat it saved shows from another computer now: drop the saved
        // copies an earlier read put on its connection's slice.
        const stale = connection && !liveHere(connection)
          ? store.crossMachineLanesByMachineId[connection.target.id] ?? null
          : null;
        if (stale?.sessions.some((session) => session.cloudSavedCopy)) {
          store.mergeCrossMachineLanes({
            machineId: stale.machineId,
            machineName: stale.machineName,
            targetId: stale.targetId,
            projectId: stale.projectId,
            binding: stale.binding,
            online: stale.online,
            lanes: stale.lanes,
            sessions: stale.sessions.filter((session) => !session.cloudSavedCopy),
            error: stale.error ?? null,
          });
        }
        continue;
      }
      showsSavedChats.add(machineKey);
      const first = rows[0]!;
      // Live: the live list owns this machine. Nothing saved shows.
      if (liveHere(connection)) continue;
      const machineId = connection?.target.id ?? `${SAVED_CHATS_MACHINE_PREFIX}${machineKey}`;
      const previous = store.crossMachineLanesByMachineId[machineId] ?? null;
      if (!connection) keptSyntheticIds.add(machineId);
      const machineName = connection?.target.name ?? name ?? (gone ? "Deleted computer" : previous?.machineName ?? "ADE Cloud");
      const binding = previous?.binding
        ?? (connection ? realBinding(connection, first) : null)
        ?? savedBinding(machineId, first, machineName);
      const sessions = rows.map(savedChatSession);
      const known = new Set(previous?.lanes.map((lane) => lane.id) ?? []);
      const lanes = [...(previous?.lanes ?? [])];
      for (const row of rows) {
        const lane = savedChatLane(row);
        if (!known.has(lane.id)) {
          known.add(lane.id);
          lanes.push(lane);
        }
      }
      const retained = (previous?.sessions ?? []).filter((session) => !session.cloudSavedCopy && !rows.some((row) => row.chatId === session.id));
      savedSliceIds.add(machineId);
      store.mergeCrossMachineLanes({
        machineId,
        machineName,
        targetId: connection?.target.id ?? null,
        projectId: binding.kind === "remote" ? binding.projectId : null,
        binding,
        online: false,
        computerGone: gone,
        lanes,
        sessions: [...retained, ...sessions],
        error: null,
      });
      for (const row of rows) {
        nextLocations.push({
          pinKey: binding.key,
          location: {
            machineKey,
            readMachineKey: row.savedOnMachineKey ?? row.machineKey,
            chatId: row.chatId,
            machineId,
            computerGone: gone,
            row,
          },
        });
      }
    }
    // A lane computer of this project that is asleep or not connected here,
    // with no saved chat: its lane still belongs in the list, as a normal row.
    // Opening it reaches the computer by its key, which wakes it.
    for (const computer of adeCloudLaneComputersNow()) {
      const machineKey = computer.machineKey;
      // A machine whose every saved chat now shows from another computer
      // still gets its lane row here.
      if (!machineKey || showsSavedChats.has(machineKey) || goneMachineKeys.has(machineKey.toLowerCase())) continue;
      if (!computer.projectOrigin || computer.projectOrigin !== context.projectKey) continue;
      const connection = connectionFor(context.connections, machineKey, computer.instanceId);
      if (liveHere(connection)) continue;
      const machineId = connection?.target.id ?? `${SAVED_CHATS_MACHINE_PREFIX}${machineKey}`;
      const previous = store.crossMachineLanesByMachineId[machineId] ?? null;
      laneSliceIds.add(machineId);
      // A connection's slice from its live reads keeps its own lanes.
      if (previous && previous.lanes.length > 0 && !isSavedChatsMachineId(machineId)) continue;
      if (!connection) keptSyntheticIds.add(machineId);
      const machineName = connection?.target.name ?? computer.laneName;
      const binding: OpenProjectBinding = previous?.binding ?? {
        kind: "remote",
        key: `${machineId}:${computer.projectOrigin}`,
        targetId: machineId,
        runtimeName: machineName,
        transport: "paired",
        hostname: computer.instanceId,
        projectId: computer.projectOrigin,
        rootPath: "",
        displayName: savedProjectName(null, computer.projectOrigin),
        gitOriginUrl: computer.projectOrigin,
      };
      store.mergeCrossMachineLanes({
        machineId,
        machineName,
        targetId: connection?.target.id ?? null,
        projectId: binding.kind === "remote" ? binding.projectId : null,
        binding,
        online: false,
        lanes: [laneComputerLane(computer, previous?.lanes.find((lane) => lane.id === computer.laneId))],
        // This computer shows no saved chat of its own (they moved to another
        // computer, or there were none): saved copies an earlier read left on
        // its slice are stale and would show as duplicates.
        sessions: (previous?.sessions ?? []).filter((session) => !session.cloudSavedCopy),
        error: null,
      });
    }
    // The project's lane computers the account knows that no slice lists yet
    // (no chat, and the lane index has not named them): each lists once, on
    // its computer's slice. A lane kept without a computer lists in its own
    // block (`CloudLanesWithoutComputerList`), never here.
    for (const lane of overview?.lanes ?? []) {
      const machineKey = lane.machineKey;
      if (!machineKey || !lane.computer || goneMachineKeys.has(machineKey.toLowerCase())) continue;
      const connection = connectionFor(context.connections, machineKey, lane.computer.instanceId);
      if (liveHere(connection)) continue;
      const machineId = connection?.target.id ?? `${SAVED_CHATS_MACHINE_PREFIX}${machineKey}`;
      const previous = rootAppStoreApi.getState().crossMachineLanesByMachineId[machineId] ?? null;
      if (previous?.lanes.some((entry) => entry.id === lane.laneId)) {
        if (savedSliceIds.has(machineId) || laneSliceIds.has(machineId)) continue;
      }
      // A connection's slice from its live reads keeps its own lanes.
      if (previous && previous.lanes.length > 0 && connection && !isSavedChatsMachineId(machineId) && !savedSliceIds.has(machineId)) continue;
      if (!connection) keptSyntheticIds.add(machineId);
      laneSliceIds.add(machineId);
      const machineName = connection?.target.name ?? previous?.machineName ?? "ADE Cloud";
      const binding: OpenProjectBinding = previous?.binding ?? {
        kind: "remote",
        key: `${machineId}:${context.projectKey}`,
        targetId: machineId,
        runtimeName: machineName,
        transport: "paired",
        hostname: lane.computer.instanceId,
        projectId: context.projectKey!,
        rootPath: "",
        displayName: savedProjectName(null, context.projectKey!),
        gitOriginUrl: context.projectKey,
      };
      const others = (previous?.lanes ?? []).filter((entry) => entry.id !== lane.laneId);
      const row = laneComputerLane({ laneId: lane.laneId, laneName: lane.laneName ?? lane.laneId }, previous?.lanes.find((entry) => entry.id === lane.laneId));
      store.mergeCrossMachineLanes({
        machineId,
        machineName,
        targetId: connection?.target.id ?? null,
        projectId: binding.kind === "remote" ? binding.projectId : null,
        binding,
        online: false,
        lanes: [...others, { ...row, branchRef: lane.branch ? `refs/heads/${lane.branch}` : row.branchRef }],
        sessions: savedSliceIds.has(machineId) ? previous?.sessions ?? [] : (previous?.sessions ?? []).filter((session) => !session.cloudSavedCopy),
        error: null,
      });
    }
    // Saved CLI and shell copies (the overview's `sessions`; none from an
    // older server): read-only rows on their computer's slice, next to its
    // saved chats. A computer that is live here shows its live terminals.
    const terminalsByMachine = new Map<string, NonNullable<CloudProjectOverview["sessions"]>>();
    for (const row of overview?.sessions ?? []) {
      if (!row.machineKey) continue;
      const rows = terminalsByMachine.get(row.machineKey);
      if (rows) rows.push(row);
      else terminalsByMachine.set(row.machineKey, [row]);
    }
    for (const [machineKey, rows] of terminalsByMachine) {
      if (goneMachineKeys.has(machineKey.toLowerCase()) || machineFacts.get(machineKey)?.gone) continue;
      const connection = connectionFor(context.connections, machineKey, rows[0]!.instanceId);
      if (liveHere(connection)) continue;
      const machineId = connection?.target.id ?? `${SAVED_CHATS_MACHINE_PREFIX}${machineKey}`;
      const previous = rootAppStoreApi.getState().crossMachineLanesByMachineId[machineId] ?? null;
      if (!connection) keptSyntheticIds.add(machineId);
      savedSliceIds.add(machineId);
      const machineName = connection?.target.name ?? previous?.machineName ?? "ADE Cloud";
      const binding: OpenProjectBinding = previous?.binding ?? {
        kind: "remote",
        key: `${machineId}:${context.projectKey}`,
        targetId: machineId,
        runtimeName: machineName,
        transport: "paired",
        ...(rows[0]!.instanceId ? { hostname: rows[0]!.instanceId } : {}),
        projectId: context.projectKey!,
        rootPath: "",
        displayName: savedProjectName(null, context.projectKey!),
        gitOriginUrl: context.projectKey,
      };
      const lanes = [...(previous?.lanes ?? [])];
      const known = new Set(lanes.map((lane) => lane.id));
      for (const row of rows) {
        if (!row.laneId || known.has(row.laneId)) continue;
        known.add(row.laneId);
        lanes.push(laneComputerLane({ laneId: row.laneId, laneName: row.laneName ?? row.laneId }, undefined));
      }
      store.mergeCrossMachineLanes({
        machineId,
        machineName,
        targetId: connection?.target.id ?? null,
        projectId: binding.kind === "remote" ? binding.projectId : null,
        binding,
        online: false,
        ...(previous?.computerGone ? { computerGone: true } : {}),
        lanes,
        sessions: [...(previous?.sessions ?? []).filter((session) => !isSavedTerminalSession(session)), ...rows.map(savedTerminalSession)],
        error: null,
      });
    }
    replaceSavedChatLocations(nextLocations);
    const staleSynthetic = Object.keys(store.crossMachineLanesByMachineId)
      .filter((machineId) => isSavedChatsMachineId(machineId) && !keptSyntheticIds.has(machineId));
    if (staleSynthetic.length) store.dropCrossMachineLanes(staleSynthetic);
    // Saved copies this read did not return belong to another project (a tab
    // switch from atlas to orbit keeps the computer's slice) or were removed:
    // they leave. A slice that held only them, with its computer away, leaves too,
    // unless it holds a lane computer of this project: its lane stays listed.
    const current = rootAppStoreApi.getState().crossMachineLanesByMachineId;
    const emptied: string[] = [];
    for (const [machineId, slice] of Object.entries(current)) {
      if (savedSliceIds.has(machineId) || isSavedChatsMachineId(machineId)) continue;
      if (!slice.sessions.some((session) => session.cloudSavedCopy)) continue;
      const live = slice.sessions.filter((session) => !session.cloudSavedCopy);
      if (live.length === 0 && slice.online === false && !laneSliceIds.has(machineId)) {
        emptied.push(machineId);
        continue;
      }
      store.mergeCrossMachineLanes({
        machineId: slice.machineId,
        machineName: slice.machineName,
        targetId: slice.targetId,
        projectId: slice.projectId,
        binding: slice.binding,
        online: slice.online,
        lanes: slice.lanes,
        sessions: live,
        error: slice.error ?? null,
      });
    }
    if (emptied.length) store.dropCrossMachineLanes(emptied);
  } catch (error) {
    // Keep what the list last showed; the next focus or connection change reads again.
    console.warn("[cloud] saved chats list failed", error instanceof Error ? error.message : String(error));
  } finally {
    inFlight = false;
    const next = queuedContext;
    queuedContext = null;
    if (next) void refreshCloudSavedChats(next);
  }
}

/** The project's ADE Cloud overview from the account, or null (an older server or ADE, or a failed read). */
async function readProjectOverview(projectKey: string | null): Promise<CloudProjectOverview | null> {
  const read = window.ade?.adeCloud?.projectOverview;
  if (!read || !projectKey) return null;
  try {
    return await read({ origin: projectKey });
  } catch (error) {
    console.warn("[cloud] the project overview read failed", error instanceof Error ? error.message : String(error));
    return null;
  }
}

/**
 * The one lane an ADE Cloud lane computer holds, as a row while the computer
 * can't answer. Keeps the row's first-seen time so the list does not reorder.
 */
function laneComputerLane(computer: { laneId: string; laneName: string }, previous: LaneSummary | undefined): LaneSummary {
  return {
    id: computer.laneId,
    name: computer.laneName,
    laneType: "worktree",
    baseRef: "",
    branchRef: "",
    worktreePath: "",
    isEditProtected: false,
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: -1, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    createdAt: previous?.createdAt ?? new Date().toISOString(),
  };
}

const machineOnline = (machineId: string): boolean =>
  rootAppStoreApi.getState().crossMachineLanesByMachineId[machineId]?.online === true;

/** Sends in flight per chat that wake its computer; the mark ends with the last one. */
const wakeHolds = new Map<string, number>();
/** A send that never settles still ends its mark (and its store watch) after this. */
const WAKE_MARK_BACKSTOP_MS = 2 * WOKEN_MACHINE_CONNECT_WAIT_MS;

/** One send's part of a chat's waking mark (`markCloudWakeForSend`). */
export type CloudWakeSendMark = {
  /**
   * The send ended. The first call decides; later calls do nothing. A call
   * that gave up waiting (a transport timeout) after the message left keeps
   * the mark until the turn shows live, or for `WOKEN_MACHINE_CONNECT_WAIT_MS`:
   * the machine usually still delivers it. Anything else (success, a refusal,
   * a message that never left) ends the mark now. A send that never settles
   * ends it at `WAKE_MARK_BACKSTOP_MS`.
   */
  settle: (failure?: unknown, messageLeft?: boolean) => void;
};

type MachineLanes = ReturnType<typeof rootAppStoreApi.getState>["crossMachineLanesByMachineId"];

/** Turn starts of this chat that its own machine shows live (never a saved copy). */
function liveTurnStarts(machines: MachineLanes, sessionId: string): string[] {
  const starts: string[] = [];
  for (const entry of Object.values(machines)) {
    for (const session of entry.sessions) {
      if (session.id === sessionId && sessionTurnLive(session)) starts.push(session.currentTurnStartedAt ?? "");
    }
  }
  return starts;
}

/**
 * Marks the chat as waking its computer when this send wakes one: the chat is
 * a saved copy, and its computer is not connected and still exists. Returns
 * the send's mark, or null when the send wakes nothing. Display only: the
 * send goes out unchanged. A new turn that the woken machine shows live ends
 * the mark at any point; this reads the store's own updates, no poll.
 */
export function markCloudWakeForSend(
  sessionId: string,
  pin: OpenProjectBinding | null | undefined,
): CloudWakeSendMark | null {
  const location = savedChatLocation(pin, sessionId, machineOnline);
  if (!location || location.computerGone) return null;
  const holds = wakeHolds.get(sessionId) ?? 0;
  wakeHolds.set(sessionId, holds + 1);
  if (holds === 0) rootAppStoreApi.getState().setCloudSessionWaking(sessionId, new Date().toISOString());
  let seen = rootAppStoreApi.getState().crossMachineLanesByMachineId;
  // A row kept from before the sleep can still show an old turn; only a new one counts.
  const earlierTurns = new Set(liveTurnStarts(seen, sessionId));
  let settled = false;
  let ended = false;
  let timer: number | null = null;
  const end = () => {
    if (ended) return;
    ended = true;
    unsubscribe();
    window.clearTimeout(backstop);
    if (timer != null) window.clearTimeout(timer);
    const left = (wakeHolds.get(sessionId) ?? 1) - 1;
    if (left > 0) {
      wakeHolds.set(sessionId, left);
      return;
    }
    wakeHolds.delete(sessionId);
    rootAppStoreApi.getState().setCloudSessionWaking(sessionId, null);
  };
  const backstop = window.setTimeout(end, WAKE_MARK_BACKSTOP_MS);
  const unsubscribe = rootAppStoreApi.subscribe((state) => {
    if (state.crossMachineLanesByMachineId === seen) return;
    seen = state.crossMachineLanesByMachineId;
    if (liveTurnStarts(seen, sessionId).some((start) => !earlierTurns.has(start))) end();
  });
  return {
    settle: (failure, messageLeft = true) => {
      if (settled || ended) return;
      settled = true;
      if (failure != null && messageLeft && isRuntimeTransportTimeoutError(failure)) {
        timer = window.setTimeout(end, WOKEN_MACHINE_CONNECT_WAIT_MS);
        return;
      }
      end();
    },
  };
}

/** The chat's waking mark for a wake that is not a saved chat's send; returns its end. */
function beginCloudWakeMark(sessionId: string): () => void {
  const holds = wakeHolds.get(sessionId) ?? 0;
  wakeHolds.set(sessionId, holds + 1);
  if (holds === 0) rootAppStoreApi.getState().setCloudSessionWaking(sessionId, new Date().toISOString());
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const left = (wakeHolds.get(sessionId) ?? 1) - 1;
    if (left > 0) {
      wakeHolds.set(sessionId, left);
      return;
    }
    wakeHolds.delete(sessionId);
    rootAppStoreApi.getState().setCloudSessionWaking(sessionId, null);
  };
}

/**
 * Sends with the chat's waking mark around it: every send to a saved chat
 * (submit, retry, a command) says it is waking the computer the same way.
 */
export async function sendWithCloudWakeMark<T>(
  sessionId: string | null | undefined,
  pin: OpenProjectBinding | null | undefined,
  send: () => Promise<T>,
): Promise<T> {
  const mark = sessionId ? markCloudWakeForSend(sessionId, pin) : null;
  try {
    return await send();
  } catch (error) {
    mark?.settle(error);
    throw error;
  } finally {
    mark?.settle();
  }
}

const wrappedApis = new WeakMap<object, AgentChatApi>();

/**
 * `window.ade.agentChat` for a chat pane: reads a saved copy while the chat's
 * cloud computer isn't connected, and is otherwise the same API.
 */
export function savedChatAwareAgentChatApi(api: AgentChatApi): AgentChatApi {
  if (!api) return api;
  const cached = wrappedApis.get(api);
  if (cached) return cached;
  // A saved chat's computer this window never connected to is reached by its
  // machine key (contract C2), and the window follows the chat there.
  // Only the method is checked: ADE Web implements `machines.connect` (it
  // wakes an asleep ADE Cloud computer through the account) while its
  // `machines` namespace reads as a stand-in, and a window without it gets
  // the fallback proxy's stand-in method, which `isAdeAvailable` rejects.
  const reach: SavedChatReach | null = isAdeAvailable(window.ade?.machines?.connect)
    ? {
        pinFor: async (location) => {
          try {
            const { pin } = await projectPinOnMachine(location.machineKey, {
              projectId: location.row.projectId,
              rootPath: location.row.projectRoot,
              originUrl: location.row.projectKey,
            });
            return pin;
          } catch (error) {
            if (error instanceof MachineConnectError && error.failure.reason === "not_in_account") {
              goneMachineKeys.add(location.machineKey.toLowerCase());
              throw new Error(SAVED_CHAT_COMPUTER_GONE_MESSAGE);
            }
            throw error;
          }
        },
        reached: (location) => {
          // Loaded on use: a static import closes an import cycle (navigation →
          // the app store → the saved chats) that the test runner deadlocks on.
          void import("../lib/otherMachineNavigation")
            .then(({ followSessionToMachine }) => followSessionToMachine(location.chatId, location.machineKey))
            .catch((error: unknown) => console.warn("[cloud] following a saved chat to its computer failed", error));
        },
        queueSend: sendThroughAdeCloudQueue,
        wakeForSend: async (pin, sessionId) => {
          const machineKey = cloudConnectionMachineKey(pin.targetId);
          if (!machineKey) return null;
          // The chat says it is waking the computer, as a send to a saved chat does.
          const mark = beginCloudWakeMark(sessionId);
          try {
            const { pin: woken } = await projectPinOnMachine(machineKey, {
              projectId: pin.projectId,
              rootPath: pin.rootPath,
              originUrl: pin.gitOriginUrl ?? null,
            });
            return woken;
          } finally {
            mark();
          }
        },
      }
    : null;
  const wrapped = withSavedChatReads(api, window.ade?.cloud?.savedChats, machineOnline, reach);
  wrappedApis.set(api, wrapped);
  return wrapped;
}

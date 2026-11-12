/**
 * Puts a window's saved chats (see `cloudSavedChats.ts`) into the Work list: one
 * read of the account's list on a connection change or window focus, at most
 * every 30 s, never a poll. Transcripts are read only when a chat is opened.
 */

import { findMachineProject, remoteProjectBindingKey } from "../../shared/projectIdentity";
import type { CloudSavedChatRow } from "../../shared/cloudSavedChats";
import type { OpenProjectBinding } from "../../shared/types/core";
import type { RemoteRuntimeConnectionStatus } from "../../shared/types/remoteRuntime";
import type { AgentChatApi } from "../components/chat/agentChatApi";
import { isRuntimeTransportTimeoutError } from "../../shared/runtimeErrors";
import { sessionTurnLive } from "../../shared/sessionStatusPresentation";
import { WOKEN_MACHINE_CONNECT_WAIT_MS } from "../../shared/wokenMachine";
import { rootAppStoreApi } from "./appStore";
import { adeCloudLaneComputerForMachine, cloudLaneIndexKnown } from "./adeCloudLaneIndex";
import { MachineConnectError, projectPinOnMachine } from "../lib/machineConnect";
import { followSessionToMachine } from "../lib/otherMachineNavigation";
import { adeCloudEnabled } from "./cloudAccess";
import { cloudBoxForMachine } from "../components/remoteTargets/cloudMachineModel";
import { watchedCloudMachines } from "../components/remoteTargets/useCloudMachines";
import {
  SAVED_CHATS_MACHINE_PREFIX,
  isSavedChatsMachineId,
  replaceSavedChatLocations,
  savedChatLane,
  savedChatLocation,
  savedChatSession,
  withSavedChatReads,
  SAVED_CHAT_COMPUTER_GONE_MESSAGE,
  type SavedChatLocation,
  type SavedChatReach,
} from "./cloudSavedChats";

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
let inFlight = false;
/** A read asked for while one was running (a project switch); it runs next. */
let queuedContext: SavedChatsContext | null = null;

/** Reads the list soon, unless it was read in the last 30 seconds. `force` skips that wait. */
export function scheduleCloudSavedChatsRefresh(context: () => SavedChatsContext, options?: { force?: boolean }): void {
  if (!window.ade?.cloud?.savedChats) return;
  if (timer) clearTimeout(timer);
  const force = options?.force === true;
  timer = setTimeout(() => {
    timer = null;
    // Inside the debounce, so a window just opened has its access answer by now.
    if (!adeCloudEnabled()) return;
    if (!force && Date.now() - lastReadAtMs < MIN_REFRESH_INTERVAL_MS) return;
    void refreshCloudSavedChats(context());
  }, REFRESH_DEBOUNCE_MS);
}

const connectionFor = (
  connections: readonly RemoteRuntimeConnectionStatus[],
  machineKey: string,
  instanceId: string | null,
): RemoteRuntimeConnectionStatus | null =>
  connections.find((connection) => connection.target.pairedMachine?.machineKey === machineKey)
  ?? (instanceId
    ? connections.find((connection) => connection.target.hostname?.trim().toLowerCase() === instanceId.toLowerCase())
    : undefined)
  ?? null;

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
  displayName: runtimeName,
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
    displayName: project?.displayName ?? connection.target.name,
  };
};

export async function refreshCloudSavedChats(context: SavedChatsContext): Promise<void> {
  const bridge = window.ade?.cloud?.savedChats;
  if (inFlight) {
    queuedContext = context;
    return;
  }
  if (!bridge || !context.isActive() || !context.projectKey) return;
  inFlight = true;
  lastReadAtMs = Date.now();
  try {
    const list = await bridge.list({ projectKey: context.projectKey, limit: 500 });
    if (!list || !context.isActive()) return;
    const store = rootAppStoreApi.getState();
    const byMachine = new Map<string, CloudSavedChatRow[]>();
    for (const row of list.chats) {
      const rows = byMachine.get(row.machineKey);
      if (rows) rows.push(row);
      else byMachine.set(row.machineKey, [row]);
    }
    const nextLocations: Array<{ pinKey: string; location: SavedChatLocation }> = [];
    const keptSyntheticIds = new Set<string>();
    // The account's cloud computers, when a surface keeps that list current.
    // A computer missing from it was deleted, even while this desktop still
    // holds a saved connection to it (a move made on another desktop).
    const cloud = watchedCloudMachines();
    const cloudBoxes = cloud?.state === "ok" ? cloud.machines : null;
    const machineFacts = new Map<string, { connection: RemoteRuntimeConnectionStatus | null; gone: boolean; name: string | null }>();
    for (const [machineKey, rows] of byMachine) {
      const connection = connectionFor(context.connections, machineKey, rows[0]!.instanceId);
      // Gone only when the account says so: the computer list doesn't have it,
      // or a reach found it off the account. No connection on THIS desktop is
      // not gone: another desktop made it, and a send reaches it by its key.
      const box = cloudBoxes ? cloudBoxForMachine(cloudBoxes, { machineKey, hostname: rows[0]!.instanceId }) : null;
      const laneComputer = adeCloudLaneComputerForMachine({ machineKey, hostname: rows[0]!.instanceId });
      const gone = goneMachineKeys.has(machineKey.toLowerCase())
        || (cloudBoxes != null ? !box : !connection && cloudLaneIndexKnown() && !laneComputer);
      machineFacts.set(machineKey, { connection, gone, name: box?.name ?? laneComputer?.laneName ?? null });
    }
    // One computer shows each chat. After a move, the new computer saves the
    // same chats (same ids) as the old one. A computer that still exists wins
    // over a deleted one; between two that exist, a connected one, then the
    // newer copy. Object order never decides.
    const ownerByChatId = new Map<string, { machineKey: string; connected: boolean; updatedAt: number }>();
    for (const [machineKey, rows] of byMachine) {
      const facts = machineFacts.get(machineKey)!;
      if (facts.gone) continue;
      const connected = facts.connection?.state === "connected";
      for (const row of rows) {
        const current = ownerByChatId.get(row.chatId);
        if (
          !current
          || (connected && !current.connected)
          || (connected === current.connected && row.updatedAt > current.updatedAt)
        ) ownerByChatId.set(row.chatId, { machineKey, connected, updatedAt: row.updatedAt });
      }
    }
    for (const [machineKey, machineRows] of byMachine) {
      const { connection, gone, name } = machineFacts.get(machineKey)!;
      const rows = machineRows.filter((row) => {
        const owner = ownerByChatId.get(row.chatId);
        return owner ? owner.machineKey === machineKey : gone;
      });
      if (rows.length === 0) {
        // Every chat it saved shows from another computer now: drop the saved
        // copies an earlier read put on its connection's slice.
        const stale = connection && connection.state !== "connected"
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
      const first = rows[0]!;
      // Connected: the live list owns this machine. Nothing saved shows.
      if (connection?.state === "connected") continue;
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
          location: { machineKey, chatId: row.chatId, machineId, computerGone: gone, row },
        });
      }
    }
    replaceSavedChatLocations(nextLocations);
    const staleSynthetic = Object.keys(store.crossMachineLanesByMachineId)
      .filter((machineId) => isSavedChatsMachineId(machineId) && !keptSyntheticIds.has(machineId));
    if (staleSynthetic.length) store.dropCrossMachineLanes(staleSynthetic);
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
  // The web client has no `machines` yet (its fallback proxy answers with a bare function).
  const reach: SavedChatReach | null = typeof (window.ade as Partial<Window["ade"]> | undefined)?.machines?.connect === "function"
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
          followSessionToMachine(location.chatId, location.machineKey);
        },
      }
    : null;
  const wrapped = withSavedChatReads(api, window.ade?.cloud?.savedChats, machineOnline, reach);
  wrappedApis.set(api, wrapped);
  return wrapped;
}

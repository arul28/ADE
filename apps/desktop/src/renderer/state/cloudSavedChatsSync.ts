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
import { rootAppStoreApi } from "./appStore";
import { adeCloudEnabled } from "./cloudAccess";
import {
  SAVED_CHATS_MACHINE_PREFIX,
  isSavedChatsMachineId,
  replaceSavedChatLocations,
  savedChatLane,
  savedChatLocation,
  savedChatSession,
  withSavedChatReads,
  type SavedChatLocation,
} from "./cloudSavedChats";

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
    for (const [machineKey, rows] of byMachine) {
      const first = rows[0]!;
      const connection = connectionFor(context.connections, machineKey, first.instanceId);
      // Connected: the live list owns this machine. Nothing saved shows.
      if (connection?.state === "connected") continue;
      const machineId = connection?.target.id ?? `${SAVED_CHATS_MACHINE_PREFIX}${machineKey}`;
      const previous = store.crossMachineLanesByMachineId[machineId] ?? null;
      if (!connection) keptSyntheticIds.add(machineId);
      const machineName = connection?.target.name ?? previous?.machineName ?? "Deleted computer";
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
        lanes,
        sessions: [...retained, ...sessions],
        error: null,
      });
      for (const row of rows) {
        nextLocations.push({
          pinKey: binding.key,
          location: { machineKey, chatId: row.chatId, machineId, computerGone: !connection, row },
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

/**
 * Marks the chat as waking its computer when this send wakes one: the chat is
 * a saved copy, and its computer is not connected and still exists. Returns
 * the function that ends the mark (a second call does nothing), or null when
 * the send wakes nothing. Display only: the send goes out unchanged.
 */
export function markCloudWakeForSend(
  sessionId: string,
  pin: OpenProjectBinding | null | undefined,
): (() => void) | null {
  const location = savedChatLocation(pin, sessionId, machineOnline);
  if (!location || location.computerGone) return null;
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

const wrappedApis = new WeakMap<object, AgentChatApi>();

/**
 * `window.ade.agentChat` for a chat pane: reads a saved copy while the chat's
 * cloud computer isn't connected, and is otherwise the same API.
 */
export function savedChatAwareAgentChatApi(api: AgentChatApi): AgentChatApi {
  if (!api) return api;
  const cached = wrappedApis.get(api);
  if (cached) return cached;
  const wrapped = withSavedChatReads(api, window.ade?.cloud?.savedChats, machineOnline);
  wrappedApis.set(api, wrapped);
  return wrapped;
}

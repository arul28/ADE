import { create } from "zustand";
import type { LaneShareGuestState } from "../../../../shared/laneShareRights";
import type { LaneShareReceivedEntry } from "../../../../shared/types/laneShare";
import { parseCodedErrorMessage } from "../../../../shared/codedError";
import { LANE_SHARING_UNAVAILABLE } from "../../../../shared/laneShareDirectory";
import { LANE_SHARE_ERROR_TEXT } from "../laneShareModel";
import { logRendererDebugEvent } from "../../../lib/debugLog";
import {
  LaneShareGuestConnection,
  type LaneShareGuestConnectionState,
  type LaneShareGuestSession,
} from "./laneShareGuestConnection";

/**
 * The guest's side of lane sharing in this window: the shares given to this
 * account (one directory read), and one guest connection for each shared lane
 * the user opened. Nothing here touches a project store or database: the
 * connections are kept apart from the owner's own machines.
 *
 * Load cost: the received list is read once when a surface that shows it
 * mounts (the Work shelf, Settings, the shared lane page), and again only on
 * a user action or after 5 minutes. A directory without lane sharing is
 * asked again only on Try again (or the next app start). A connection opens
 * only when the user opens a shared lane or expands it in the Work shelf.
 */

export type LaneShareGuestProblem = { code: string | null; message: string };

type GuestStore = {
  received: LaneShareReceivedEntry[] | null;
  receivedStatus: "idle" | "loading" | "ready" | "error";
  receivedProblem: LaneShareGuestProblem | null;
  pendingInvitesUnavailable: boolean;
  receivedAt: number;
  connections: Record<string, LaneShareGuestConnectionState>;
  sessions: Record<string, LaneShareGuestSession[]>;
  guestStates: Record<string, LaneShareGuestState | null>;
  /** A notice for one share ("Access changed", a dropped send). */
  notices: Record<string, LaneShareGuestProblem | null>;
  /** The shared lane (and session) shown in the Work view area, if any. */
  workSelection: { grantId: string; sessionId: string | null } | null;
};

export const useLaneShareGuestStore = create<GuestStore>(() => ({
  received: null,
  receivedStatus: "idle",
  receivedProblem: null,
  pendingInvitesUnavailable: false,
  receivedAt: 0,
  connections: {},
  sessions: {},
  guestStates: {},
  notices: {},
  workSelection: null,
}));

const RECEIVED_TTL_MS = 5 * 60_000;
/** After a failed read, mounts wait this long (doubling to the TTL) before they ask again. */
const RECEIVED_RETRY_MS = 15_000;
let receivedInFlight: Promise<void> | null = null;
let receivedFailures = 0;
const liveConnections = new Map<string, { connection: LaneShareGuestConnection; dispose: () => void; users: number }>();

/** A plain reason for a failed guest call. */
export function laneShareGuestProblem(error: unknown): LaneShareGuestProblem {
  const parsed = parseCodedErrorMessage(error);
  const code = parsed.code ?? null;
  if (code === "signed_out" || code === "unauthorized") return { code: "signed_out", message: LANE_SHARE_ERROR_TEXT.signed_out! };
  if (code && LANE_SHARE_ERROR_TEXT[code]) return { code, message: LANE_SHARE_ERROR_TEXT[code]! };
  // Guest only. The directory answers the same 404 for no grant and a grant of another
  // account (an invite sent to another email address, too).
  if (code === "not_found") {
    return { code, message: "This share is not for this account. If the invite went to another email address, sign in with that account." };
  }
  if (code === "self_invite") return { code, message: "This is your own share. Open it from Shared by me." };
  return { code, message: parsed.message || "Something went wrong with this shared lane." };
}

function bridge() {
  return window.ade?.laneShareGuest ?? null;
}

/**
 * Reads the shares given to this account. Shared by every caller; `force`
 * skips the 5 minute cache. When the directory has no lane sharing, only
 * `retry` (a Try again) asks it again.
 */
export async function loadLaneShareReceived(options: { force?: boolean; retry?: boolean } = {}): Promise<void> {
  const state = useLaneShareGuestStore.getState();
  if (!options.retry && state.receivedProblem?.code === LANE_SHARING_UNAVAILABLE) return;
  if (!options.force && state.receivedStatus === "ready" && Date.now() - state.receivedAt < RECEIVED_TTL_MS) return;
  // A failed read is cached too: a mount does not ask again until its backoff ends.
  if (!options.force && !options.retry && state.receivedStatus === "error") {
    const backoff = Math.min(RECEIVED_TTL_MS, RECEIVED_RETRY_MS * 2 ** Math.max(0, receivedFailures - 1));
    if (Date.now() - state.receivedAt < backoff) return;
  }
  if (receivedInFlight) return await receivedInFlight;
  const api = bridge();
  if (!api) {
    useLaneShareGuestStore.setState({ receivedStatus: "ready", received: [], receivedAt: Date.now() });
    return;
  }
  useLaneShareGuestStore.setState({ receivedStatus: state.received ? state.receivedStatus : "loading" });
  receivedInFlight = (async () => {
    try {
      const result = await api.listReceived();
      receivedFailures = 0;
      useLaneShareGuestStore.setState({
        received: result.shares,
        pendingInvitesUnavailable: result.pendingInvitesUnavailable,
        receivedStatus: "ready",
        receivedProblem: null,
        receivedAt: Date.now(),
      });
    } catch (error) {
      receivedFailures += 1;
      useLaneShareGuestStore.setState({ receivedStatus: "error", receivedProblem: laneShareGuestProblem(error), receivedAt: Date.now() });
    } finally {
      receivedInFlight = null;
    }
  })();
  return await receivedInFlight;
}

/** Shares that are in use: accepted and not ended. */
export function activeLaneShares(entries: readonly LaneShareReceivedEntry[] | null): LaneShareReceivedEntry[] {
  return (entries ?? []).filter((entry) => entry.state === "active");
}

function setNotice(grantId: string, notice: LaneShareGuestProblem | null): void {
  useLaneShareGuestStore.setState((state) => ({ notices: { ...state.notices, [grantId]: notice } }));
}

export function clearLaneShareGuestNotice(grantId: string): void {
  setNotice(grantId, null);
}

/**
 * Re-reads the guest's own rights, limits and who is present, from the host.
 * The host signals a change (`guestStateChanged`, no data); a slow timer of
 * an open view is the fallback. `withSessions` also re-reads the lane's
 * session list.
 */
export async function refreshLaneShareGuestState(grantId: string, options: { withSessions?: boolean } = {}): Promise<void> {
  const live = liveConnections.get(grantId);
  if (!live || live.connection.state.kind !== "connected") return;
  try {
    const guestState = await live.connection.getGuestState();
    useLaneShareGuestStore.setState((state) => ({ guestStates: { ...state.guestStates, [grantId]: guestState } }));
    if (options.withSessions) await live.connection.refreshSessions();
  } catch (error) {
    // The connection state shows why; the last state stays.
    logRendererDebugEvent("lane_share.guest_state_read_failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

export function laneShareGuestConnection(grantId: string): LaneShareGuestConnection | null {
  return liveConnections.get(grantId)?.connection ?? null;
}

/**
 * Opens (or reuses) the guest connection of one share. Returns a release:
 * the connection closes when its last user releases it.
 */
export function retainLaneShareGuestConnection(entry: Pick<LaneShareReceivedEntry, "grantId" | "laneId">): () => void {
  const api = bridge();
  if (!api || !entry.laneId) return () => undefined;
  let live = liveConnections.get(entry.grantId);
  if (!live) {
    const connection = new LaneShareGuestConnection({ grantId: entry.grantId, laneId: entry.laneId, directory: api });
    const offState = connection.on("state", (connectionState) => {
      useLaneShareGuestStore.setState((state) => ({ connections: { ...state.connections, [entry.grantId]: connectionState } }));
      if (connectionState.kind === "connected") void refreshLaneShareGuestState(entry.grantId);
      if (connectionState.kind === "stopped") {
        // Ended, left or refused: the received list changed on the directory.
        void loadLaneShareReceived({ force: true });
      }
    });
    const offSessions = connection.on("sessions", (list) => {
      useLaneShareGuestStore.setState((state) => ({ sessions: { ...state.sessions, [entry.grantId]: list } }));
    });
    const offAccess = connection.on("accessChanged", () => {
      setNotice(entry.grantId, { code: "lane_share_rights_changed", message: "Access changed. The owner changed what you can do here." });
      void refreshLaneShareGuestState(entry.grantId);
    });
    // Rights can change what the guest sees, so the session list is read again too.
    const offChanged = connection.on("guestStateChanged", () => {
      void refreshLaneShareGuestState(entry.grantId, { withSessions: true });
    });
    live = {
      connection,
      users: 0,
      dispose: () => {
        offState();
        offSessions();
        offAccess();
        offChanged();
        connection.stop();
      },
    };
    liveConnections.set(entry.grantId, live);
  }
  live.users += 1;
  live.connection.start();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = liveConnections.get(entry.grantId);
    if (!current) return;
    current.users -= 1;
    if (current.users > 0) return;
    current.dispose();
    liveConnections.delete(entry.grantId);
    useLaneShareGuestStore.setState((state) => {
      const { [entry.grantId]: _c, ...connections } = state.connections;
      return { connections };
    });
  };
}

export async function acceptLaneShare(grantId: string): Promise<LaneShareReceivedEntry> {
  const api = bridge();
  if (!api) throw new Error("lane_share_unavailable: Lane sharing isn't available here.");
  const { grant } = await api.accept({ grantId });
  await loadLaneShareReceived({ force: true });
  return grant;
}

export async function leaveLaneShare(grantId: string): Promise<void> {
  const api = bridge();
  if (!api) throw new Error("lane_share_unavailable: Lane sharing isn't available here.");
  await api.leave({ grantId });
  const live = liveConnections.get(grantId);
  if (live) {
    live.dispose();
    liveConnections.delete(grantId);
  }
  const selection = useLaneShareGuestStore.getState().workSelection;
  if (selection?.grantId === grantId) useLaneShareGuestStore.setState({ workSelection: null });
  await loadLaneShareReceived({ force: true });
}

export function selectLaneShareInWork(grantId: string, sessionId: string | null): void {
  useLaneShareGuestStore.setState({ workSelection: { grantId, sessionId } });
}

export function clearLaneShareWorkSelection(): void {
  if (useLaneShareGuestStore.getState().workSelection) useLaneShareGuestStore.setState({ workSelection: null });
}

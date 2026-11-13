import { create } from "zustand";
import type { LaneShareGuestState } from "../../../../shared/laneShareRights";
import type { LaneShareReceivedEntry } from "../../../../shared/types/laneShare";
import { parseCodedErrorMessage } from "../../../../shared/codedError";
import { LANE_SHARING_UNAVAILABLE } from "../../../../shared/laneShareDirectory";
import { LANE_SHARE_ERROR_TEXT, LANE_SHARE_PRESET_LABELS, laneShareRightsPreset, sameLaneShareRights } from "../laneShareModel";
import { logRendererDebugEvent } from "../../../lib/debugLog";
import { fetchAccountStatus, subscribeAccountStatus } from "../../../lib/account";
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
 *
 * Everything here belongs to one account. A sign-out or another account
 * clears it all: connections close, and a read still on its way is dropped.
 */

export type LaneShareGuestProblem = { code: string | null; message: string };

type GuestStore = {
  /** The account the received list was read for (undefined: read before the account was known). */
  receivedFor: string | null | undefined;
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

const EMPTY_GUEST_STORE: GuestStore = {
  receivedFor: undefined,
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
};

export const useLaneShareGuestStore = create<GuestStore>(() => ({ ...EMPTY_GUEST_STORE }));

/**
 * The lane's name as the guest should see it: the host's current name once a
 * connection read it (a rename follows), else the label from share time.
 */
export function useLaneShareGuestLaneName(entry: Pick<LaneShareReceivedEntry, "grantId" | "laneLabel">): string | null {
  const live = useLaneShareGuestStore((state) => state.guestStates[entry.grantId]?.lane?.name ?? null);
  return live || entry.laneLabel || null;
}

const RECEIVED_TTL_MS = 5 * 60_000;
/** After a failed read, mounts wait this long (doubling to the TTL) before they ask again. */
const RECEIVED_RETRY_MS = 15_000;
let receivedInFlight: Promise<void> | null = null;
let receivedFailures = 0;
/** `account` undefined: opened before the account was known; the first status adopts it. */
type LiveConnection = { connection: LaneShareGuestConnection; dispose: () => void; users: number; account: string | null | undefined };
const liveConnections = new Map<string, LiveConnection>();

/** The signed-in account's user id; undefined until the first status arrives. */
let boundAccount: string | null | undefined;
/** Moves on each account change: a read started for an earlier account is dropped. */
let accountEpoch = 0;
let accountWatch: (() => void) | null = null;

function accountOf(status: { signedIn: boolean; userId: string | null }): string | null {
  return status.signedIn ? status.userId?.trim() || null : null;
}

/** Closes every guest connection and clears the store: the account changed. */
function clearForAccountChange(): void {
  accountEpoch += 1;
  receivedInFlight = null;
  receivedFailures = 0;
  for (const live of liveConnections.values()) live.dispose();
  liveConnections.clear();
  useLaneShareGuestStore.setState({ ...EMPTY_GUEST_STORE });
}

/** Starts, once, the watch that clears everything on a sign-out or another account. */
function watchAccount(): void {
  if (accountWatch) return;
  const onStatus = (status: { signedIn: boolean; userId: string | null }) => {
    const next = accountOf(status);
    if (boundAccount === undefined) {
      // The first status: what was opened before it is this account's.
      for (const live of liveConnections.values()) live.account ??= next;
      if (useLaneShareGuestStore.getState().receivedFor === undefined) useLaneShareGuestStore.setState({ receivedFor: next });
    } else if (next !== boundAccount) {
      clearForAccountChange();
    }
    boundAccount = next;
  };
  accountWatch = subscribeAccountStatus(onStatus);
  void fetchAccountStatus().then(onStatus).catch(() => undefined);
}

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
/**
 * Grants a host closed as ended. The host closes a guest before it tells the
 * directory, so a list read in that gap still says active; the host's word
 * wins until the directory agrees.
 */
const hostEndedGrants = new Set<string>();

/**
 * `fromDirectory`: a fresh directory read, whose closed state confirms the
 * host and retires its override. A local pass over the shown list (where an
 * earlier override already wrote "ended") confirms nothing.
 */
function withHostEnded(shares: LaneShareReceivedEntry[], fromDirectory: boolean): LaneShareReceivedEntry[] {
  if (hostEndedGrants.size === 0) return shares;
  return shares.map((row) => {
    if (!hostEndedGrants.has(row.grantId)) return row;
    if (row.state !== "active") {
      if (fromDirectory) hostEndedGrants.delete(row.grantId);
      return row;
    }
    return { ...row, state: "ended" };
  });
}

export async function loadLaneShareReceived(options: { force?: boolean; retry?: boolean } = {}): Promise<void> {
  watchAccount();
  const account = boundAccount;
  // No account change can pass during the read (the epoch drops it), so a
  // read started before the first status belongs to the account it brought.
  const readFor = () => (account === undefined ? boundAccount : account);
  const state = useLaneShareGuestStore.getState();
  // A list read for another account is no cache of this one.
  if (state.receivedFor !== account) options = { ...options, force: true };
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
    useLaneShareGuestStore.setState({ receivedFor: readFor(), receivedStatus: "ready", received: [], receivedAt: Date.now() });
    return;
  }
  useLaneShareGuestStore.setState({ receivedStatus: state.received ? state.receivedStatus : "loading" });
  const epoch = accountEpoch;
  const read = (async () => {
    try {
      const result = await api.listReceived();
      if (epoch !== accountEpoch) return;
      receivedFailures = 0;
      useLaneShareGuestStore.setState({
        receivedFor: readFor(),
        received: withHostEnded(result.shares, true),
        pendingInvitesUnavailable: result.pendingInvitesUnavailable,
        receivedStatus: "ready",
        receivedProblem: null,
        receivedAt: Date.now(),
      });
    } catch (error) {
      if (epoch !== accountEpoch) return;
      receivedFailures += 1;
      useLaneShareGuestStore.setState({ receivedFor: readFor(), receivedStatus: "error", receivedProblem: laneShareGuestProblem(error), receivedAt: Date.now() });
    } finally {
      // A read of an earlier account no longer owns the slot (the change cleared it).
      if (epoch === accountEpoch) receivedInFlight = null;
    }
  })();
  receivedInFlight = read;
  return await read;
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
 * What the guest is told after the host let it back in, or null when nothing
 * it can see changed: same rights and same lane state.
 */
function laneShareAccessChangeNotice(
  before: LaneShareGuestState | null,
  after: LaneShareGuestState | null,
  giverLabel: string | null,
): string | null {
  if (!before || !after) return null;
  const owner = giverLabel ?? "The owner";
  if (before.state !== after.state) return after.state === "paused" ? `${owner} paused this lane.` : `${owner} opened this lane again.`;
  if (sameLaneShareRights(before.rights, after.rights)) return null;
  const preset = laneShareRightsPreset(after.rights);
  const level = preset === "custom" ? "custom access" : `${LANE_SHARE_PRESET_LABELS[preset]} access`;
  return `${owner} changed your access. You now have ${level}.`;
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
    if (liveConnections.get(grantId) !== live) return;
    useLaneShareGuestStore.setState((state) => ({ guestStates: { ...state.guestStates, [grantId]: guestState } }));
    if (options.withSessions) await live.connection.refreshSessions();
  } catch (error) {
    // The connection state shows why; the last state stays.
    logRendererDebugEvent("lane_share.guest_state_read_failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

export function laneShareGuestConnection(grantId: string): LaneShareGuestConnection | null {
  const live = liveConnections.get(grantId);
  return live && live.account === boundAccount ? live.connection : null;
}

/**
 * Opens (or reuses) the guest connection of one share. Returns a release:
 * the connection closes when its last user releases it.
 */
export function retainLaneShareGuestConnection(entry: Pick<LaneShareReceivedEntry, "grantId" | "laneId">): () => void {
  const api = bridge();
  if (!api || !entry.laneId) return () => undefined;
  watchAccount();
  const account = boundAccount;
  let live = liveConnections.get(entry.grantId);
  if (live && live.account !== account) {
    live.dispose();
    liveConnections.delete(entry.grantId);
    live = undefined;
  }
  if (!live) {
    const connection = new LaneShareGuestConnection({ grantId: entry.grantId, laneId: entry.laneId, directory: api });
    const offState = connection.on("state", (connectionState) => {
      useLaneShareGuestStore.setState((state) => ({ connections: { ...state.connections, [entry.grantId]: connectionState } }));
      if (connectionState.kind === "connected") void refreshLaneShareGuestState(entry.grantId);
      if (connectionState.kind === "stopped" && connectionState.reason === "ended") {
        hostEndedGrants.add(entry.grantId);
        useLaneShareGuestStore.setState((state) => ({ received: state.received ? withHostEnded(state.received, false) : state.received }));
      }
      if (connectionState.kind === "stopped" && connectionState.reason !== "paused") {
        // Ended, left or refused: the received list changed on the directory.
        // A paused lane is checked again by the connection itself.
        void loadLaneShareReceived({ force: true });
      }
    });
    const offSessions = connection.on("sessions", (list) => {
      useLaneShareGuestStore.setState((state) => ({ sessions: { ...state.sessions, [entry.grantId]: list } }));
    });
    // The host closed and let the guest back in. That happens for more than a
    // rights change (a sync restart, a failed check of its shares), so the
    // notice shows only when the rights or the lane's state really differ.
    const offAccess = connection.on("accessChanged", () => {
      const before = useLaneShareGuestStore.getState().guestStates[entry.grantId] ?? null;
      void refreshLaneShareGuestState(entry.grantId, { withSessions: true }).then(() => {
        const after = useLaneShareGuestStore.getState().guestStates[entry.grantId] ?? null;
        const giver = useLaneShareGuestStore.getState().received?.find((row) => row.grantId === entry.grantId)?.giverLabel ?? null;
        const notice = laneShareAccessChangeNotice(before, after, giver);
        if (notice) setNotice(entry.grantId, { code: "lane_share_rights_changed", message: notice });
      });
    });
    // Rights can change what the guest sees, so the session list is read again too.
    const offChanged = connection.on("guestStateChanged", () => {
      void refreshLaneShareGuestState(entry.grantId, { withSessions: true });
    });
    live = {
      connection,
      users: 0,
      account,
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
  const held = live;
  held.users += 1;
  held.connection.start();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // A connection an account change already closed is not this release's to count.
    const current = liveConnections.get(entry.grantId);
    if (current !== held) return;
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

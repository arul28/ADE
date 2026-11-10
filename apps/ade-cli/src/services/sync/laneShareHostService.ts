import {
  laneSharePresetLabel,
  laneShareRiskLevel,
  parseLaneShareRights,
  type LaneShareRights,
  type LaneShareRiskLevel,
} from "../../../../desktop/src/shared/laneShareRights";
import type { LaneShareRightsStore, LaneShareUsage } from "../../../../desktop/src/main/services/lanes/laneShareRightsStore";
import type {
  LaneShareEvent,
  LaneShareGivenEntry,
  LaneShareReceivedEntry,
  LaneShareReceivedResult,
} from "../../../../desktop/src/shared/types/laneShare";
import {
  LaneShareGrantError,
  resolveLaneShareDirectoryBase,
  sendLaneShareDirectoryRequest,
  type LaneShareDirectoryAccess,
} from "./laneShareGrantService";
import type { LaneShareCloseResult } from "./syncHostService";

/**
 * The owner's side of lane sharing on the machine that holds the lane: make
 * a share with chosen rights, list shares with their usage, change rights,
 * stop a share, and send the invite again.
 *
 * The account directory holds the index of grants (who, which lane, preset,
 * risk, end) and their revocation; this machine holds the rights and the
 * counters (`laneShareRightsStore.ts`). Order on each write:
 *   - create: the directory invite first; if it fails, nothing is stored;
 *   - edit: the local rights first (they apply to the next action at once),
 *     then the directory's preset, risk and end;
 *   - revoke: this machine first, then the directory. The local rights row
 *     goes first, so from that moment the host refuses the guest's hello and
 *     every action; then the connections close and the guest's queued
 *     messages go. The directory revoke comes last. If it fails, the share
 *     stays closed here, the result says so, and the owner's list shows the
 *     grant as "needs rights" until a second revoke reaches the directory.
 *     A share never stays open here because a network call failed.
 */

const GRANT_ID = /^ls_[0-9a-f]{32}$/;
const MAX_EMAIL_CHARS = 320;

export type LaneShareHostErrorCode =
  | "invalid_args"
  | "confirm_high_risk"
  | "not_found"
  | "no_repo_key"
  | "directory_refused"
  | "signed_out"
  | "no_directory"
  | "unavailable";

export class LaneShareHostError extends Error {
  constructor(readonly code: LaneShareHostErrorCode, message: string, readonly directoryCode: string | null = null) {
    super(message);
    this.name = "LaneShareHostError";
  }
}

export type { LaneShareGivenEntry } from "../../../../desktop/src/shared/types/laneShare";

type HostControls = {
  applyLaneShareRights(grantId: string): number;
  closeLaneShareGrant(grantId: string, reason: string): Promise<LaneShareCloseResult>;
  closeLaneShareLane(laneId: string, reason: string): number;
  laneShareConnectedDevices(grantId: string): number;
};

export type LaneShareHostService = ReturnType<typeof createLaneShareHostService>;

function cleanEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim();
  if (!email || email.length > MAX_EMAIL_CHARS || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function cleanGrantId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!GRANT_ID.test(id)) throw new LaneShareHostError("invalid_args", "That lane share id is not valid.");
  return id;
}

/** An end time the directory accepts: null (no end) or a future epoch ms. */
function cleanEndsAt(value: unknown, nowMs: number): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= nowMs) {
    throw new LaneShareHostError("invalid_args", "The end date must be in the future.");
  }
  return value;
}

function directoryError(status: number, body: unknown): LaneShareHostError {
  const error = body && typeof body === "object" ? (body as { error?: { code?: unknown; message?: unknown } }).error : null;
  const code = typeof error?.code === "string" ? error.code.slice(0, 64) : null;
  const message = typeof error?.message === "string" && error.message.trim()
    ? error.message.trim().slice(0, 300)
    : `The account directory answered ${status}.`;
  if (status === 401) return new LaneShareHostError("signed_out", "Sign in to ADE to share lanes.", code);
  if (status === 404) return new LaneShareHostError("not_found", message, code);
  if (status >= 500) return new LaneShareHostError("unavailable", message, code);
  return new LaneShareHostError("directory_refused", message, code);
}

const RISK_LEVELS = new Set<string>(["low", "medium", "high"]);

const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const riskLabel = (value: unknown): LaneShareRiskLevel | null =>
  typeof value === "string" && RISK_LEVELS.has(value) ? value as LaneShareRiskLevel : null;

function isGrantRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object"
    && typeof (value as { id?: unknown }).id === "string" && GRANT_ID.test((value as { id: string }).id);
}

/** A received grant as the "Shared with me" list shows it. Display fields only. */
function receivedEntry(grant: Record<string, unknown>): LaneShareReceivedEntry {
  return {
    grantId: grant.id as string,
    state: str(grant.state) ?? "unknown",
    laneId: str(grant.laneId) ?? "",
    repoKey: str(grant.repoKey),
    projectLabel: str(grant.projectLabel),
    laneLabel: str(grant.laneLabel),
    preset: str(grant.preset),
    risk: riskLabel(grant.risk),
    giverLabel: str(grant.giverLabel),
    receiverEmail: str(grant.receiverEmail),
    endsAt: num(grant.endsAt),
    inviteExpiresAt: num(grant.inviteExpiresAt),
    createdAt: num(grant.createdAt),
    acceptedAt: num(grant.acceptedAt),
  };
}

function grantIdOf(body: unknown): string | null {
  const grant = body && typeof body === "object" ? (body as { grant?: { id?: unknown } }).grant : null;
  return typeof grant?.id === "string" && GRANT_ID.test(grant.id) ? grant.id : null;
}

/** The rights to store, with the risk rule: high risk needs the owner's explicit confirmation. */
function checkedRights(value: unknown, confirmHighRisk: unknown): { rights: LaneShareRights; risk: { level: LaneShareRiskLevel; reasons: string[] } } {
  const rights = parseLaneShareRights(value);
  const risk = laneShareRiskLevel(rights);
  if (risk.level === "high" && confirmHighRisk !== true) {
    throw new LaneShareHostError(
      "confirm_high_risk",
      `These rights are high risk: ${risk.reasons.join("; ")}. Confirm them to continue.`,
    );
  }
  return { rights, risk };
}

export function createLaneShareHostService(options: {
  access: LaneShareDirectoryAccess;
  getMachineKey: () => string;
  store: LaneShareRightsStore;
  /** The running sync host, or null when this machine hosts no sync now. */
  getHost: () => HostControls | null;
  getRepoKey: () => string | null;
  getProjectLabel: () => string | null;
  getLaneLabel: (laneId: string) => string | null;
  /** A fresh grant read, so a new or changed share reaches the host gates now. */
  refreshGrants?: () => Promise<unknown>;
  /** A share of this machine changed; the owner's lists read it again. */
  onEvent?: (event: LaneShareEvent) => void;
  now?: () => number;
  logger?: { info(event: string, fields?: Record<string, unknown>): void; warn(event: string, fields?: Record<string, unknown>): void };
}) {
  const now = options.now ?? Date.now;

  const request = async (method: "GET" | "POST" | "PATCH", path: string, body?: Record<string, unknown>): Promise<unknown> => {
    let answer: { status: number; body: unknown };
    try {
      answer = await sendLaneShareDirectoryRequest(options.access, resolveLaneShareDirectoryBase(options.access), { method, path, body });
    } catch (error) {
      if (error instanceof LaneShareGrantError) {
        const code = error.code === "signed_out" || error.code === "no_directory" ? error.code : "unavailable";
        throw new LaneShareHostError(code, error.message);
      }
      throw new LaneShareHostError("unavailable", "The account directory could not be reached.");
    }
    if (answer.status < 200 || answer.status >= 300) throw directoryError(answer.status, answer.body);
    return answer.body;
  };

  const refresh = (): void => {
    void options.refreshGrants?.().catch(() => {});
  };

  const changed = (grantId: string | null, laneId: string | null): void => {
    try {
      options.onEvent?.({ type: "lane_share_changed", grantId, laneId });
    } catch {
      // A listener failure never fails the write.
    }
  };

  const invite = async (laneId: string, receiverEmail: string, rights: LaneShareRights, risk: LaneShareRiskLevel, endsAt: number | null | undefined) => {
    const repoKey = options.getRepoKey();
    if (!repoKey) throw new LaneShareHostError("no_repo_key", "This project can't be shared: it needs a Git remote.");
    const machineKey = options.getMachineKey().trim();
    if (!machineKey) throw new LaneShareHostError("unavailable", "This computer has no machine key yet.");
    const body = await request("POST", "/lane-shares", {
      receiverEmail,
      repoKey,
      machineKey,
      laneId,
      preset: laneSharePresetLabel(rights),
      risk,
      ...(endsAt !== undefined ? { endsAt } : {}),
      projectLabel: options.getProjectLabel(),
      laneLabel: options.getLaneLabel(laneId),
    });
    const grantId = grantIdOf(body);
    if (!grantId) throw new LaneShareHostError("unavailable", "The account directory answer could not be read.");
    return { grantId, body };
  };

  const usageOf = (grantId: string): LaneShareUsage | null =>
    options.store.get(grantId) ? options.store.usage(grantId) : null;

  /** Every grant the account gave, on any machine, as raw records. */
  const accountGrants = async (): Promise<Record<string, unknown>[]> => {
    const body = await request("GET", "/lane-shares/given");
    const grants = body && typeof body === "object" && Array.isArray((body as { grants?: unknown }).grants)
      ? (body as { grants: unknown[] }).grants
      : [];
    return grants.filter(isGrantRecord);
  };

  /**
   * Whether a directory grant belongs to this runtime: this machine and this
   * project's repo. The rights store is per project, so a grant of another
   * project on this machine is not "needs rights" here. A grant with no repo
   * key (a directory older than repo keys) is read as this project's.
   */
  const isOwnGrant = (grant: Record<string, unknown>, machineKey: string, repoKey: string | null): boolean =>
    grant.machineKey === machineKey && (typeof grant.repoKey !== "string" || grant.repoKey === repoKey);

  /** The directory's given grants of this machine and project, as raw records. */
  const givenGrants = async (): Promise<Record<string, unknown>[]> => {
    const machineKey = options.getMachineKey().trim();
    const repoKey = options.getRepoKey();
    return (await accountGrants()).filter((grant) => isOwnGrant(grant, machineKey, repoKey));
  };

  /** A live (pending or active) grant of this machine, from the directory. */
  const givenGrant = async (grantId: string): Promise<{ laneId: string; receiverEmail: string | null } | null> => {
    const grant = (await givenGrants()).find((value) => value.id === grantId);
    if (!grant || (grant.state !== "pending" && grant.state !== "active")) return null;
    const laneId = typeof grant.laneId === "string" ? grant.laneId : "";
    if (!laneId) return null;
    return { laneId, receiverEmail: typeof grant.receiverEmail === "string" ? grant.receiverEmail : null };
  };

  return {
    /**
     * A new share: the directory invite first (it also emails the guest),
     * then the rights on this machine. A refused invite stores nothing.
     */
    async create(args: { laneId: unknown; receiverEmail: unknown; rights: unknown; endsAt?: unknown; confirmHighRisk?: unknown }) {
      const laneId = typeof args.laneId === "string" ? args.laneId.trim() : "";
      if (!laneId) throw new LaneShareHostError("invalid_args", "Choose a lane to share.");
      if (options.store.laneState(laneId) !== "active") {
        throw new LaneShareHostError("invalid_args", "Only an open lane on this computer can be shared.");
      }
      const receiverEmail = cleanEmail(args.receiverEmail);
      if (!receiverEmail) throw new LaneShareHostError("invalid_args", "That email address isn't valid.");
      const { rights: asked, risk } = checkedRights(args.rights, args.confirmHighRisk);
      const endsAt = cleanEndsAt(args.endsAt, now());
      // The host enforces the end date from its own rights, as an edit keeps it.
      const rights = endsAt !== undefined ? { ...asked, limits: { ...asked.limits, endsAt } } : asked;
      const { grantId, body } = await invite(laneId, receiverEmail, rights, risk.level, endsAt);
      const record = options.store.put({ grantId, laneId, receiverEmail, rights });
      options.logger?.info("lane_share.host_created", { grantId, risk: risk.level });
      refresh();
      changed(grantId, laneId);
      return { grantId, rights: record.rights, risk, directory: body };
    },

    /**
     * This machine's shares of this project: the directory's list, with local
     * rights, usage and connections. `scope: "account"` lists every share the
     * account gave, on any machine; only the rows of this machine and project
     * carry rights, usage and connections (`local: true`).
     */
    async list(args: { scope?: unknown } = {}): Promise<{ shares: LaneShareGivenEntry[] }> {
      const machineKey = options.getMachineKey().trim();
      const repoKey = options.getRepoKey();
      const grants = args.scope === "account"
        ? await accountGrants()
        : (await accountGrants()).filter((grant) => isOwnGrant(grant, machineKey, repoKey));
      const host = options.getHost();
      const shares: LaneShareGivenEntry[] = [];
      for (const grant of grants) {
        const grantId = grant.id as string;
        const state = typeof grant.state === "string" ? grant.state : "unknown";
        const live = state === "pending" || state === "active";
        const laneId = typeof grant.laneId === "string" ? grant.laneId : "";
        const base = {
          grantId,
          laneId,
          receiverEmail: str(grant.receiverEmail),
          state,
          endsAt: num(grant.endsAt),
          createdAt: num(grant.createdAt),
          acceptedAt: num(grant.acceptedAt),
          inviteExpiresAt: num(grant.inviteExpiresAt),
          link: str(grant.link),
          repoKey: str(grant.repoKey),
          projectLabel: str(grant.projectLabel),
          laneLabel: str(grant.laneLabel),
          preset: str(grant.preset),
          directoryRisk: riskLabel(grant.risk),
          machineKey: str(grant.machineKey),
        };
        if (!isOwnGrant(grant, machineKey, repoKey)) {
          shares.push({
            ...base,
            local: false,
            rights: null,
            needsRights: false,
            risk: null,
            usage: null,
            connectedDevices: 0,
            laneState: null,
          });
          continue;
        }
        let record = options.store.get(grantId);
        // A final grant's rights and records go (kept until the grant is final).
        if (record && !live) {
          options.store.delete(grantId);
        }
        // Rights stored for another lane than the directory's grant are not
        // this share's: they go, and the share needs rights again.
        if (record && laneId && record.laneId !== laneId) {
          options.store.deleteRights(grantId);
          record = null;
        }
        shares.push({
          ...base,
          local: true,
          rights: live && record ? record.rights : null,
          needsRights: live && !record,
          risk: live && record ? laneShareRiskLevel(record.rights) : null,
          usage: live ? usageOf(grantId) : null,
          connectedDevices: live ? host?.laneShareConnectedDevices(grantId) ?? 0 : 0,
          laneState: laneId ? options.store.laneState(laneId) : "unknown",
        });
      }
      return { shares };
    },

    /** Shares other accounts gave this account (the "Shared with me" list). Display only. */
    async listReceived(): Promise<LaneShareReceivedResult> {
      const body = await request("GET", "/lane-shares/received");
      const record = body && typeof body === "object" ? body as { grants?: unknown; pendingInvitesUnavailable?: unknown } : {};
      const grants = Array.isArray(record.grants) ? record.grants.filter(isGrantRecord) : [];
      return {
        shares: grants.map(receivedEntry),
        pendingInvitesUnavailable: record.pendingInvitesUnavailable === true,
      };
    },

    /** Leaves a share given to this account, or declines its invite. */
    async leave(args: { grantId: unknown }): Promise<{ grantId: string; state: string }> {
      const grantId = cleanGrantId(args.grantId);
      const body = await request("POST", `/lane-shares/${encodeURIComponent(grantId)}/leave`);
      const grant = body && typeof body === "object" ? (body as { grant?: { state?: unknown } }).grant : null;
      return { grantId, state: str(grant?.state) ?? "left" };
    },

    /**
     * New rights for a share. Local first: the next guest action uses them.
     * Then the directory's preset, risk and end follow; a failed directory
     * write is reported and the local rights stay (the host enforces them).
     * A live grant of this machine that holds no rights here ("needs
     * rights") gets these as its first rights.
     */
    async updateRights(args: { grantId: unknown; rights: unknown; endsAt?: unknown; confirmHighRisk?: unknown }) {
      const grantId = cleanGrantId(args.grantId);
      const { rights: asked, risk } = checkedRights(args.rights, args.confirmHighRisk);
      const endsAt = cleanEndsAt(args.endsAt, now());
      // The end date is kept in the local rights too, before the directory
      // write: the host enforces it, so a failed write cannot leave an old,
      // later end in force here.
      const rights = endsAt !== undefined ? { ...asked, limits: { ...asked.limits, endsAt } } : asked;
      let record = options.store.get(grantId) ? options.store.updateRights(grantId, rights) : null;
      if (!record) {
        // "Needs rights": a live grant of this machine that holds no rights here.
        const grant = await givenGrant(grantId);
        if (!grant) throw new LaneShareHostError("not_found", "This computer has no live lane share with that id.");
        record = options.store.put({ grantId, laneId: grant.laneId, receiverEmail: grant.receiverEmail, rights });
      }
      const appliedConnections = options.getHost()?.applyLaneShareRights(grantId) ?? 0;
      let directorySynced = true;
      let directoryMessage: string | null = null;
      try {
        await request("PATCH", `/lane-shares/${encodeURIComponent(grantId)}`, {
          preset: laneSharePresetLabel(rights),
          risk: risk.level,
          ...(endsAt !== undefined ? { endsAt } : {}),
        });
      } catch (error) {
        directorySynced = false;
        directoryMessage = error instanceof Error ? error.message : String(error);
        options.logger?.warn("lane_share.host_edit_directory_failed", { grantId, code: (error as LaneShareHostError).code ?? null });
      }
      refresh();
      changed(grantId, record.laneId);
      return { grantId, rights: record.rights, risk, appliedConnections, directorySynced, directoryMessage };
    },

    /**
     * Stops a share: the directory revoke first, so no new connection is
     * admitted, then the open connections close at once, the guest's queued
     * messages go, and the local row is deleted. A guest turn that already
     * started keeps running and is reported.
     */
    async revoke(args: { grantId: unknown }) {
      const grantId = cleanGrantId(args.grantId);
      const laneId = options.store.get(grantId)?.laneId ?? null;
      // No await before this line and the close: no hello or action of the
      // guest can pass in between.
      options.store.deleteRights(grantId);
      const closed = await (options.getHost()?.closeLaneShareGrant(grantId, "Lane share ended")
        ?? Promise.resolve<LaneShareCloseResult>({ closedConnections: 0, removedQueuedMessages: 0, runningTurnSessionIds: [] }));
      options.store.delete(grantId);
      let directoryRevoked = true;
      let directoryMessage: string | null = null;
      try {
        await request("POST", `/lane-shares/${encodeURIComponent(grantId)}/revoke`);
      } catch (error) {
        directoryRevoked = false;
        directoryMessage = "The share is closed on this computer, but the account directory did not record the revoke "
          + `(${error instanceof Error ? error.message : String(error)}). Revoke it again to finish.`;
        options.logger?.warn("lane_share.host_revoke_directory_failed", { grantId, code: (error as LaneShareHostError).code ?? null });
      }
      options.logger?.info("lane_share.host_revoked", {
        grantId,
        ...closed,
        runningTurnSessionIds: closed.runningTurnSessionIds.length,
        directoryRevoked,
      });
      refresh();
      changed(grantId, laneId);
      return { grantId, ...closed, directoryRevoked, directoryMessage };
    },

    /** Sends the invite of a pending share again (a new 24 h window, the same rights). */
    async resendInvite(args: { grantId: unknown }) {
      const grantId = cleanGrantId(args.grantId);
      const record = options.store.get(grantId);
      if (!record?.receiverEmail) throw new LaneShareHostError("not_found", "This computer holds no invite for that lane share.");
      const risk = laneShareRiskLevel(record.rights);
      const { grantId: sentId, body } = await invite(record.laneId, record.receiverEmail, record.rights, risk.level, undefined);
      if (sentId !== grantId) {
        // The directory made a new grant (the old one closed): keep the rights under it.
        options.store.put({ grantId: sentId, laneId: record.laneId, receiverEmail: record.receiverEmail, rights: record.rights });
      }
      changed(sentId, record.laneId);
      return { grantId: sentId, directory: body };
    },

    /** Lane archived: every share of it pauses (connections close; a hello is refused until unarchived). */
    pauseLane(laneId: string): number {
      const closed = options.getHost()?.closeLaneShareLane(laneId, "The owner paused this shared lane") ?? 0;
      changed(null, laneId);
      return closed;
    },

    /** Lane deleted: every share of it ends, here first (as in `revoke`), then in the directory. */
    async endLane(laneId: string): Promise<number> {
      const records = options.store.list().filter((record) => record.laneId === laneId);
      for (const record of records) options.store.deleteRights(record.grantId);
      options.getHost()?.closeLaneShareLane(laneId, "Lane share ended");
      let ended = 0;
      for (const record of records) {
        await options.getHost()?.closeLaneShareGrant(record.grantId, "Lane share ended");
        options.store.delete(record.grantId);
        try {
          await request("POST", `/lane-shares/${encodeURIComponent(record.grantId)}/revoke`);
          ended += 1;
        } catch (error) {
          // Closed here already, and the lane is gone; the owner's list shows the grant until a revoke reaches the directory.
          options.logger?.warn("lane_share.host_end_lane_directory_failed", {
            grantId: record.grantId,
            code: (error as LaneShareHostError).code ?? null,
          });
        }
      }
      refresh();
      changed(null, laneId);
      return ended;
    },
  };
}

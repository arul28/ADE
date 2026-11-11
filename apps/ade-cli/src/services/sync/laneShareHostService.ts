import { LaneShareError } from "./laneShareError";
import {
  LANE_SHARE_AGENT_WATCH_ONLY_MESSAGE,
  LANE_SHARE_PERSON_ONLY_MESSAGE,
  laneShareAgentRightsRefusal,
  laneShareCliTypingFor,
  laneShareHighRiskRefusal,
  laneSharePresetLabel,
  laneSharePresetRights,
  laneShareRightsForHost,
  laneShareRiskLevel,
  parseLaneShareRights,
  type LaneShareCaller,
  type LaneShareCliTyping,
  type LaneShareRights,
  type LaneShareRiskLevel,
} from "../../../../desktop/src/shared/laneShareRights";
import type { LaneShareRightsStore, LaneShareUsage } from "../../../../desktop/src/main/services/lanes/laneShareRightsStore";
import type {
  LaneShareEvent,
  LaneShareGivenEntry,
  LaneShareListResult,
  LaneShareReceivedResult,
} from "../../../../desktop/src/shared/types/laneShare";
import { parseLaneShareReceivedResponse } from "../../../../desktop/src/shared/laneShareGuestDirectory";
import {
  directoryNumber as num,
  directoryRisk as riskLabel,
  directoryString as str,
  isLaneShareGrantRecord as isGrantRecord,
  LANE_SHARE_GRANT_ID_PATTERN as GRANT_ID,
  LANE_SHARING_UNAVAILABLE,
  laneShareDirectoryProblem,
} from "../../../../desktop/src/shared/laneShareDirectory";
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
 *
 * Every action takes the caller (`LaneShareCaller`), which only the host's
 * RPC server sets, from its own session (`laneShareCallerOf` in the action
 * registry; never from the call's arguments). A person in the ADE app may do
 * everything. An agent (the `ade` CLI, an agent's shell, an ADE MCP
 * connection) may list, make a Watch share (`laneShareAgentRightsRefusal`,
 * at most `AGENT_SHARES_PER_HOUR` an hour on this machine) and stop a share
 * of this machine. Anything that is not exactly "person" is an agent.
 */

const MAX_EMAIL_CHARS = 320;
/** Shares an agent may make on this machine in one hour, on top of the directory's own limits. */
export const AGENT_SHARES_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;

/** The agent share counter of one brain process: every project's host service takes from the same one. */
export type LaneShareAgentRate = {
  /** Takes a slot or throws `rate_limited`. The returned call gives the slot back (a refused or failed create). */
  take(): () => void;
};

/**
 * When an agent made each share in the last hour, for the whole process.
 * In memory: a restart forgets it, and the directory keeps its own limits.
 */
export function createLaneShareAgentRate(now: () => number = Date.now): LaneShareAgentRate {
  let made: number[] = [];
  return {
    take() {
      const at = now();
      // A clock moved back keeps its slots counted.
      made = made.filter((when) => at - when < HOUR_MS);
      if (made.length >= AGENT_SHARES_PER_HOUR) {
        throw new LaneShareHostError(
          "rate_limited",
          `An agent or the CLI can make at most ${AGENT_SHARES_PER_HOUR} lane shares an hour on this computer. Try again later, or share from the ADE app.`,
        );
      }
      made.push(at);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const index = made.indexOf(at);
        if (index >= 0) made.splice(index, 1);
      };
    },
  };
}

const HIDE_BOTH: LaneShareRights["privacy"] = { hideMachines: true, hideModels: true };

/**
 * The privacy switches of the person's saved default rights
 * (`laneShare.defaultRights`), for an agent's share. None saved hides
 * nothing; a read that throws or a value of the wrong shape hides both.
 */
function savedDefaultPrivacy(read: () => unknown): LaneShareRights["privacy"] {
  try {
    const value = read();
    if (value === undefined || value === null) return { hideMachines: false, hideModels: false };
    const rights = typeof value === "object" ? (value as { rights?: unknown }).rights : undefined;
    if (!rights || typeof rights !== "object") return HIDE_BOTH;
    return parseLaneShareRights(rights).privacy;
  } catch {
    return HIDE_BOTH;
  }
}

export type LaneShareHostErrorCode =
  | "invalid_args"
  | "confirm_high_risk"
  | "not_found"
  | "no_repo_key"
  | "directory_refused"
  | "signed_out"
  | "no_directory"
  | "unavailable"
  | "share_closed"
  | "invite_expired"
  | "rate_limited"
  | "share_back_mismatch"
  | "person_only"
  | "agent_watch_only"
  | typeof LANE_SHARING_UNAVAILABLE;

/** The directory's mapped codes this service keeps; any other refusal is `directory_refused`. */
const HOST_DIRECTORY_CODES = new Set<string>([
  "signed_out",
  "not_found",
  "unavailable",
  "share_closed",
  "invite_expired",
  "rate_limited",
  "share_back_mismatch",
  LANE_SHARING_UNAVAILABLE,
]);

export class LaneShareHostError extends LaneShareError {
  declare readonly code: LaneShareHostErrorCode;
  constructor(code: LaneShareHostErrorCode, message: string, directoryCode: string | null = null) {
    super(code, message, directoryCode);
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

function directoryError(status: number, body: unknown, path: string): LaneShareHostError {
  const problem = laneShareDirectoryProblem(status, body, path);
  const code = HOST_DIRECTORY_CODES.has(problem.code) ? problem.code as LaneShareHostErrorCode : "directory_refused";
  return new LaneShareHostError(code, problem.message, problem.directoryCode);
}

function grantIdOf(body: unknown): string | null {
  const grant = body && typeof body === "object" ? (body as { grant?: { id?: unknown } }).grant : null;
  return typeof grant?.id === "string" && GRANT_ID.test(grant.id) ? grant.id : null;
}

/** Refuses an action only a person in the ADE app may take. Fail closed: anything but "person" is an agent. */
function requirePerson(caller: LaneShareCaller): void {
  if (caller !== "person") throw new LaneShareHostError("person_only", LANE_SHARE_PERSON_ONLY_MESSAGE);
}

/**
 * The rights to store, as this machine enforces them (CLI typing off where
 * it is not available), with the risk rule: high risk needs the owner's
 * explicit confirmation. An agent gets the Watch preset when it names no
 * rights, may not ask for more (refused, never clamped), and may not confirm
 * a high-risk share; its share must come out low risk.
 */
function checkedRights(
  value: unknown,
  confirmHighRisk: unknown,
  cliTyping: LaneShareCliTyping,
  caller: LaneShareCaller,
): { rights: LaneShareRights; risk: { level: LaneShareRiskLevel; reasons: string[] } } {
  if (caller !== "person") {
    if (confirmHighRisk === true) {
      throw new LaneShareHostError("agent_watch_only", `${LANE_SHARE_AGENT_WATCH_ONLY_MESSAGE} An agent cannot confirm a high-risk share.`);
    }
    const asked = value === undefined || value === null ? laneSharePresetRights("watch") : parseLaneShareRights(value);
    const refusal = laneShareAgentRightsRefusal(asked);
    if (refusal) throw new LaneShareHostError("agent_watch_only", refusal);
    const rights = laneShareRightsForHost(asked, cliTyping);
    const risk = laneShareRiskLevel(rights);
    // A second guard: whatever the ceiling lets through must be low risk.
    if (risk.level !== "low") throw new LaneShareHostError("agent_watch_only", LANE_SHARE_AGENT_WATCH_ONLY_MESSAGE);
    return { rights, risk };
  }
  const rights = laneShareRightsForHost(parseLaneShareRights(value), cliTyping);
  const refusal = laneShareHighRiskRefusal(rights, confirmHighRisk);
  if (refusal) throw new LaneShareHostError("confirm_high_risk", refusal);
  return { rights, risk: laneShareRiskLevel(rights) };
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
  /** The agent share counter of this brain process, shared by every project (`createLaneShareAgentRate`). */
  agentRate: LaneShareAgentRate;
  /**
   * The person's saved default rights (the account setting
   * `laneShare.defaultRights`), raw. Throws when they cannot be read.
   */
  readDefaultRights: () => unknown;
  /** This machine's `process.platform`: it decides whether a guest may type into a CLI here. */
  platform?: NodeJS.Platform;
  logger?: { info(event: string, fields?: Record<string, unknown>): void; warn(event: string, fields?: Record<string, unknown>): void };
}) {
  const now = options.now ?? Date.now;
  const cliTyping = laneShareCliTypingFor(options.platform ?? process.platform);
  /** Stored rights as this machine enforces them (a share stored before, or on another build, may still hold CLI typing). */
  const enforced = (rights: LaneShareRights): LaneShareRights => laneShareRightsForHost(rights, cliTyping);

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
    if (answer.status < 200 || answer.status >= 300) throw directoryError(answer.status, answer.body, path);
    return answer.body;
  };

  const refresh = (): void => {
    void options.refreshGrants?.().catch((error: unknown) => {
      // The grant timer reads the list again later.
      options.logger?.warn("lane_share.grant_refresh_failed", { error: error instanceof Error ? error.message : String(error) });
    });
  };

  const changed = (grantId: string | null, laneId: string | null): void => {
    try {
      options.onEvent?.({ type: "lane_share_changed", grantId, laneId });
    } catch {
      // A listener failure never fails the write.
    }
  };

  const invite = async (
    laneId: string,
    receiverEmail: string,
    rights: LaneShareRights,
    risk: LaneShareRiskLevel,
    endsAt: number | null | undefined,
    shareBackOf: string | null = null,
  ) => {
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
      ...(shareBackOf ? { shareBackOf } : {}),
    });
    const grantId = grantIdOf(body);
    if (!grantId) throw new LaneShareHostError("unavailable", "The account directory answer could not be read.");
    if (shareBackOf && (body as { shareBackOf?: unknown }).shareBackOf !== shareBackOf) {
      // A directory that did not check the address against the other person
      // of the grant: the invite goes again at once.
      await request("POST", `/lane-shares/${encodeURIComponent(grantId)}/revoke`).catch((error) => {
        options.logger?.warn("lane_share.share_back_unchecked_revoke_failed", { grantId, code: (error as LaneShareHostError).code ?? null });
      });
      throw new LaneShareHostError("unavailable", "The account directory could not check the share back address. Share the lane by hand.");
    }
    return { grantId, body };
  };

  /**
   * The lane + address pairs a create is working on now. An agent's create
   * waits on the directory between its check and its write, so a second
   * create of the same pair in that gap is refused, not merged.
   */
  const creatingPairs = new Set<string>();
  const AGENT_SHARE_EXISTS_MESSAGE = "This person already has a share of this lane. Change it in the ADE app.";

  /**
   * An agent never changes a share that exists: the directory would reuse its
   * grant and the host would write Watch rights over the person's choices.
   * A row ends with its end date; the list deletes a final grant's row.
   */
  const hasLocalShare = (laneId: string, address: string): boolean =>
    options.store.list().some((record) => record.laneId === laneId
      && record.receiverEmail?.toLowerCase() === address
      && !(typeof record.rights.limits.endsAt === "number" && record.rights.limits.endsAt <= now()));

  /** The one share of `laneId` on this machine that goes to `email`, by its local row. */
  const grantIdForEmail = (laneId: unknown, email: unknown): string => {
    const lane = typeof laneId === "string" ? laneId.trim() : "";
    const address = cleanEmail(email)?.toLowerCase() ?? null;
    if (!lane || !address) throw new LaneShareHostError("invalid_args", "Name the share: a grant id, or a lane and an email address.");
    const matches = options.store.list().filter((record) => record.laneId === lane && record.receiverEmail?.toLowerCase() === address);
    if (matches.length === 0) throw new LaneShareHostError("not_found", "This computer has no share of that lane with that email address.");
    if (matches.length > 1) throw new LaneShareHostError("invalid_args", "More than one share of that lane goes to that address. Pass the grant id.");
    return matches[0]!.grantId;
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
     * then the rights on this machine. A refused invite stores nothing. An
     * agent makes only a Watch share (see `checkedRights`), never a share
     * back of a move, and at most `AGENT_SHARES_PER_HOUR` an hour.
     */
    async create(
      args: { laneId: unknown; receiverEmail: unknown; rights?: unknown; endsAt?: unknown; confirmHighRisk?: unknown; shareBackOf?: unknown },
      caller: LaneShareCaller,
    ) {
      const createdBy = caller === "person" ? "person" : "agent";
      const laneId = typeof args.laneId === "string" ? args.laneId.trim() : "";
      if (!laneId) throw new LaneShareHostError("invalid_args", "Choose a lane to share.");
      if (options.store.laneState(laneId) !== "active") {
        throw new LaneShareHostError("invalid_args", "Only an open lane on this computer can be shared.");
      }
      const receiverEmail = cleanEmail(args.receiverEmail);
      if (!receiverEmail) throw new LaneShareHostError("invalid_args", "That email address isn't valid.");
      if (createdBy === "agent" && args.shareBackOf !== undefined) requirePerson(caller);
      const { rights: checked, risk } = checkedRights(args.rights, args.confirmHighRisk, cliTyping, caller);
      // An agent's share hides at least what the person's defaults hide; its
      // own switches only add hiding. Nothing else of the defaults counts.
      const saved = createdBy === "agent" ? savedDefaultPrivacy(options.readDefaultRights) : null;
      const asked = saved
        ? { ...checked, privacy: { hideMachines: checked.privacy.hideMachines || saved.hideMachines, hideModels: checked.privacy.hideModels || saved.hideModels } }
        : checked;
      const endsAt = cleanEndsAt(args.endsAt, now());
      // The host enforces the end date from its own rights, as an edit keeps it.
      const rights = endsAt !== undefined ? { ...asked, limits: { ...asked.limits, endsAt } } : asked;
      const shareBackOf = args.shareBackOf === undefined ? null : cleanGrantId(args.shareBackOf);
      const address = receiverEmail.toLowerCase();
      const pair = `${laneId}\u0000${address}`;
      if (createdBy === "agent" && (creatingPairs.has(pair) || hasLocalShare(laneId, address))) {
        throw new LaneShareHostError("invalid_args", AGENT_SHARE_EXISTS_MESSAGE);
      }
      // Held from here, before the first await, until the rights are written.
      const ownsPair = !creatingPairs.has(pair);
      creatingPairs.add(pair);
      try {
        const releaseSlot = createdBy === "agent" ? options.agentRate.take() : null;
        let made: Awaited<ReturnType<typeof invite>>;
        try {
          if (createdBy === "agent") {
            const live = (await givenGrants()).some((grant) => (grant.state === "pending" || grant.state === "active")
              && grant.laneId === laneId
              && typeof grant.receiverEmail === "string" && grant.receiverEmail.toLowerCase() === address);
            if (live) throw new LaneShareHostError("invalid_args", AGENT_SHARE_EXISTS_MESSAGE);
          }
          made = await invite(laneId, receiverEmail, rights, risk.level, endsAt, shareBackOf);
        } catch (error) {
          releaseSlot?.();
          throw error;
        }
        const { grantId, body } = made;
        const record = options.store.put({ grantId, laneId, receiverEmail, rights, createdBy });
        options.logger?.info("lane_share.host_created", { grantId, risk: risk.level, createdBy });
        refresh();
        changed(grantId, laneId);
        return { grantId, rights: record.rights, risk, createdBy: record.createdBy, directory: body };
      } finally {
        if (ownsPair) creatingPairs.delete(pair);
      }
    },

    /**
     * This machine's shares of this project: the directory's list, with local
     * rights, usage and connections. `scope: "account"` lists every share the
     * account gave, on any machine; only the rows of this machine and project
     * carry rights, usage and connections (`local: true`).
     */
    async list(args: { scope?: unknown } = {}): Promise<LaneShareListResult & { cliTyping: LaneShareCliTyping }> {
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
            createdBy: null,
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
          rights: live && record ? enforced(record.rights) : null,
          needsRights: live && !record,
          risk: live && record ? laneShareRiskLevel(enforced(record.rights)) : null,
          usage: live ? usageOf(grantId) : null,
          connectedDevices: live ? host?.laneShareConnectedDevices(grantId) ?? 0 : 0,
          laneState: laneId ? options.store.laneState(laneId) : "unknown",
          createdBy: live && record ? record.createdBy : null,
        });
      }
      return { shares, cliTyping };
    },

    /** Shares other accounts gave this account (the "Shared with me" list). Display only. */
    async listReceived(caller: LaneShareCaller): Promise<LaneShareReceivedResult> {
      requirePerson(caller);
      return parseLaneShareReceivedResponse(await request("GET", "/lane-shares/received"));
    },

    /** Leaves a share given to this account, or declines its invite. */
    async leave(args: { grantId: unknown }, caller: LaneShareCaller): Promise<{ grantId: string; state: string }> {
      requirePerson(caller);
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
     * rights") gets these as its first rights. Only a person changes rights;
     * a share an agent made keeps that label when a person raises it.
     */
    async updateRights(args: { grantId: unknown; rights: unknown; endsAt?: unknown; confirmHighRisk?: unknown }, caller: LaneShareCaller) {
      requirePerson(caller);
      const grantId = cleanGrantId(args.grantId);
      const { rights: asked, risk } = checkedRights(args.rights, args.confirmHighRisk, cliTyping, caller);
      const endsAt = cleanEndsAt(args.endsAt, now());
      // The end date is kept in the local rights too, before the directory
      // write: the host enforces it, so a failed write cannot leave an old,
      // later end in force here.
      // No end date in the call: the stored one stays, as it does on the directory.
      const stored = options.store.get(grantId);
      const keptEndsAt = endsAt !== undefined ? endsAt : stored ? stored.rights.limits.endsAt ?? null : asked.limits.endsAt;
      const rights = { ...asked, limits: { ...asked.limits, endsAt: keptEndsAt } };
      let record = stored ? options.store.updateRights(grantId, rights) : null;
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
     *
     * The share is named by its grant id, or by its lane and the guest's
     * email address (a row this machine holds). A person may stop any share
     * of the account (Settings › Sharing stops one on another computer); an
     * agent only a share of this machine and project.
     */
    async revoke(args: { grantId?: unknown; laneId?: unknown; receiverEmail?: unknown }, caller: LaneShareCaller) {
      const grantId = args.grantId === undefined || args.grantId === null || args.grantId === ""
        ? grantIdForEmail(args.laneId, args.receiverEmail)
        : cleanGrantId(args.grantId);
      if (caller !== "person" && !options.store.get(grantId) && !(await givenGrant(grantId))) {
        throw new LaneShareHostError("not_found", "This computer has no live lane share with that id.");
      }
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
    async resendInvite(args: { grantId: unknown }, caller: LaneShareCaller) {
      requirePerson(caller);
      const grantId = cleanGrantId(args.grantId);
      const record = options.store.get(grantId);
      if (!record?.receiverEmail) throw new LaneShareHostError("not_found", "This computer holds no invite for that lane share.");
      const risk = laneShareRiskLevel(enforced(record.rights));
      // The stored end goes with it: the directory writes the invite's end over the old one.
      const { grantId: sentId, body } = await invite(record.laneId, record.receiverEmail, record.rights, risk.level, record.rights.limits.endsAt ?? null);
      if (sentId !== grantId) {
        // The directory made a new grant (the old one closed): keep the rights under it.
        options.store.put({ grantId: sentId, laneId: record.laneId, receiverEmail: record.receiverEmail, rights: record.rights, createdBy: record.createdBy });
      }
      changed(sentId, record.laneId);
      return { grantId: sentId, directory: body };
    },

    /**
     * A lane share move landed on the other person's machine, and that
     * machine shared the new lane back to this account. Accepts that invite
     * only when the directory names the expected giver (the guest of the
     * move's grant) and this project's repository; anything else is left
     * alone, for the person to see in "Shared with me".
     */
    async acceptShareBack(args: { grantId: string; giverUserId: string }): Promise<void> {
      const grantId = cleanGrantId(args.grantId);
      const opened = await request("GET", `/lane-shares/${encodeURIComponent(grantId)}`);
      const role = opened && typeof opened === "object" ? (opened as { role?: unknown }).role : null;
      const grant = opened && typeof opened === "object" ? (opened as { grant?: Record<string, unknown> }).grant : null;
      if (role !== "invitee" || !grant || grant.state !== "pending") return;
      if (grant.giverUserId !== args.giverUserId || grant.repoKey !== options.getRepoKey()) {
        options.logger?.warn("lane_share.share_back_mismatch", { grantId });
        return;
      }
      await request("POST", `/lane-shares/${encodeURIComponent(grantId)}/accept`);
      options.logger?.info("lane_share.share_back_accepted", { grantId });
    },

    /**
     * The other person of a live grant, from the directory with this
     * machine's account (never from a peer): the receiver and the grant's
     * address when this account gave the grant, the giver when it received it.
     */
    async shareBackParty(grantIdArg: string): Promise<{ role: "giver" | "receiver"; userId: string; email: string | null }> {
      const grantId = cleanGrantId(grantIdArg);
      const opened = await request("GET", `/lane-shares/${encodeURIComponent(grantId)}`);
      const role = opened && typeof opened === "object" ? (opened as { role?: unknown }).role : null;
      const grant = opened && typeof opened === "object" ? (opened as { grant?: Record<string, unknown> }).grant : null;
      if (!grant || grant.state !== "active") throw new LaneShareHostError("not_found", "This lane share is not active.");
      if (role === "giver" && typeof grant.receiverUserId === "string" && grant.receiverUserId) {
        return { role: "giver", userId: grant.receiverUserId, email: str(grant.receiverEmail) };
      }
      if (role === "receiver" && typeof grant.giverUserId === "string" && grant.giverUserId) {
        return { role: "receiver", userId: grant.giverUserId, email: null };
      }
      throw new LaneShareHostError("not_found", "This lane share is not active.");
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

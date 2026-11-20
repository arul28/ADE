import { randomUUID } from "node:crypto";
import { CLOUD_MADE_BY_CHAT_METADATA, type CloudMachinesResult } from "../../../shared/adeCloud";
import type { CloudApiClient } from "../../../shared/cloudApiClient";
import { CLOUD_LANE_BRANCH_METADATA, type CloudLaneMachine } from "../../../shared/cloudLaneLaunch";
import {
  CLOUD_KEPT_LANE_FATE,
  cloudComputerFateSentence,
  cloudWorkLaneName,
  type CloudLaneEntry,
  type CloudLaneEntryState,
  type CloudLanesAnswer,
  type CloudLaneWithoutComputer,
  type CloudLaneWorkState,
} from "../../../shared/cloudLaneLife";
import type { CloudSavedChatRow } from "../../../shared/cloudSavedChats";
import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import { buildDeeplink } from "../../../shared/deeplinks";
import { PRIMARY_LANE_DISPLAY_NAME } from "../../../shared/laneDisplayName";
import { sameMachineKey } from "../../../shared/machineAddress";
import { describeCloudMachineSize, cloudCatalogOf } from "../../../shared/adeCloud";
import { getErrorMessage } from "../shared/utils";
import type { CloudLaneBackup } from "../../../../../account-directory/src/cloud/contract";
import type { CloudStatusDeletedLane } from "./cloudAccountStatus";
import type { CloudApproval } from "./cloudAgentActions";
import type { CloudLaneAccount } from "./cloudLaneAccount";
import type { CloudInstance, CloudLogger, CloudProvider } from "./cloudProvider";

/**
 * The `cloud` actions for the account's lanes, saved chats, CLI copies,
 * backups and server jobs (`ade cloud lanes|chats|sessions|backups|jobs|project`).
 *
 * One lane model: a lane is on a computer (awake, asleep, …) or its computer
 * was deleted (`computer_deleted`). The lane and its chats stay; its next
 * message makes a new computer on its branch. Reads wake nothing.
 *
 * Every write is a delete for the approval rules (`approve` in
 * `cloudAgentActions.ts`): a person's own client decided; an agent's watched
 * or full-auto chat shows the person a card (a full-auto chat goes on alone
 * only for a computer that chat made); plan mode, an automation run and an ADE
 * MCP app are told no; a terminal with no chat is told where to do it in ADE.
 *
 * Account level: everything is named by lane id, ADE Cloud id or machine key,
 * never a pin.
 */

export type CloudLaneApprove = (approval: CloudApproval, card: {
  action: "delete";
  title: string;
  /** A function runs only when a card is really posted (see `approve`). */
  body: string | (() => Promise<string>);
  confirm: string;
  madeByThisChat?: boolean;
  personPlace?: string;
  alternative?: { label: string };
}) => Promise<{ choice: "confirm" | "alternative" }>;

export type CloudLaneVerbDeps = {
  account: () => CloudLaneAccount;
  client: () => Promise<CloudProvider>;
  /** The account server's client for routes the provider doesn't call; null when this ADE isn't signed in. */
  api: () => CloudApiClient | null;
  /** The account's computers (throws with the access sentence when ADE Cloud isn't there). */
  readMachines: () => Promise<CloudMachinesResult>;
  /** The full computers the last list read (their metadata), or null. */
  recentInstances: () => CloudInstance[] | null;
  approve: CloudLaneApprove;
  readApproval: (args: Record<string, unknown>) => CloudApproval;
  /** `cloud.lane_launch`: a new computer for a lane (its own spend card). */
  laneLaunch: (args: Record<string, unknown>) => Promise<unknown>;
  /** This runtime's project origin (`github.com/owner/repo` once normalized), or null. */
  projectOriginUrl: () => string | null;
  logger: CloudLogger;
};

/** How many pages of the account's saved chats a lane list reads (200 each). */
const CHAT_PAGES = 5;
const CHAT_PAGE = 200;
/** How many pages (100 each) of CLI and shell copies a lookup by id reads. */
const SESSION_PAGES = 20;
/** A lane unused this long counts as stale (`ade cloud lanes --stale`). */
const STALE_MS = 7 * 24 * 60 * 60_000;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Where the person does it in ADE, when the caller has no chat to ask in. */
const PERSON_PLACE = "Do it in ADE: the lane's row in Work or Lanes, or Settings › ADE Cloud. Or ask for it in an ADE chat, where ADE can ask you.";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const iso = (ms: number | null | undefined): string | null => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const dayOf = (ms: number | null | undefined): string =>
  typeof ms === "number" && Number.isFinite(ms) ? ` on ${new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "";

function laneStateOf(state: string): CloudLaneEntryState {
  switch (state) {
    case "running": return "awake";
    case "asleep":
    case "stopped": return "asleep";
    case "starting": return "starting";
    case "stopping": return "stopping";
    case "deleting": return "deleting";
    default: return "error";
  }
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "2 commits not pushed, 4 files changed", or "changes not committed". */
function workLine(lane: { ahead: number; dirty: boolean; files?: number }): string {
  const parts: string[] = [];
  if (lane.ahead > 0) parts.push(`${plural(lane.ahead, "commit")} not pushed`);
  if (lane.dirty) parts.push(typeof lane.files === "number" && lane.files > 0 ? `${plural(lane.files, "file")} changed` : "changes not committed");
  return parts.join(", ") || "work ADE couldn't read";
}

function laneLink(laneId: string): string {
  return buildDeeplink({ kind: "lane", laneId });
}

export function buildCloudLaneVerbs(deps: CloudLaneVerbDeps) {
  const { logger } = deps;

  /** The account's saved chats, newest first, at most `CHAT_PAGES` pages. */
  const readChats = async (): Promise<{ chats: CloudSavedChatRow[]; complete: boolean }> => {
    const client = await deps.client();
    const chats: CloudSavedChatRow[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < CHAT_PAGES; page += 1) {
      const listed = await client.listSavedChats({ limit: CHAT_PAGE, cursor });
      chats.push(...listed.chats);
      cursor = listed.nextCursor;
      if (!cursor) return { chats, complete: true };
    }
    return { chats, complete: false };
  };

  /** Every lane of the account, one entry each, with the parts ADE couldn't read. */
  const readLanes = async (options: {
    /** A list read already running (`status`'s own): no second one. */
    machines?: Promise<CloudMachinesResult>;
    /** False: leave the backups out (`status` shows none). */
    backups?: boolean;
  } = {}): Promise<CloudLanesAnswer & { chatRows: CloudSavedChatRow[]; keptIds: Set<string>; failed: Set<"kept" | "chats" | "backups"> }> => {
    const unread: string[] = [];
    const failed = new Set<"kept" | "chats" | "backups">();
    // Every read at once. The computers decide: with no ADE Cloud the list
    // throws its sentence, and the other reads are dropped.
    const machinesRead = options.machines ?? deps.readMachines();
    const api = options.backups === false ? null : deps.api();
    const [machines, kept, chatRead, backups] = await Promise.all([
      machinesRead,
      deps.account().lanesWithoutComputer().catch((error: unknown) => {
        unread.push(`ADE couldn't read the lanes whose computer was deleted: ${getErrorMessage(error)}`);
        failed.add("kept");
        return [] as CloudLaneWithoutComputer[];
      }),
      readChats().catch((error: unknown) => {
        unread.push(`ADE couldn't read the saved chats: ${getErrorMessage(error)}`);
        failed.add("chats");
        return { chats: [] as CloudSavedChatRow[], complete: true };
      }),
      api
        ? api.laneBackups().catch((error: unknown) => {
            unread.push(`ADE couldn't read the lane backups: ${getErrorMessage(error)}`);
            failed.add("backups");
            return [] as CloudLaneBackup[];
          })
        : Promise.resolve([] as CloudLaneBackup[]),
    ]);
    if (!chatRead.complete) unread.push(`Only your newest ${CHAT_PAGES * CHAT_PAGE} saved chats were read, so chat counts may be low.`);
    const metadataOf = new Map((deps.recentInstances() ?? []).map((instance) => [instance.id, instance.metadata]));
    const catalog = cloudCatalogOf(machines.account);
    const deletesAt = new Map((machines.account?.dueForDeletion ?? []).map((entry) => [entry.instanceId, iso(entry.deletesAt)]));
    const newestBackup = new Map<string, CloudLaneBackup>();
    for (const backup of backups) {
      const seen = newestBackup.get(backup.laneId);
      if (!seen || backup.savedAt > seen.savedAt) newestBackup.set(backup.laneId, backup);
    }
    const chatsOf = new Map<string, CloudSavedChatRow[]>();
    for (const chat of chatRead.chats) {
      if (!chat.laneId) continue;
      chatsOf.set(chat.laneId, [...(chatsOf.get(chat.laneId) ?? []), chat]);
    }
    // A chat copied to a new computer (a move, a fork) is saved under both keys: count it once.
    const chatCount = (laneId: string): number => new Set((chatsOf.get(laneId) ?? []).map((chat) => chat.chatId)).size;
    const entries = new Map<string, CloudLaneEntry>();
    const keysOf = (laneId: string, extra: Array<string | null | undefined>): string[] => {
      const keys = [...extra, ...(chatsOf.get(laneId) ?? []).map((chat) => chat.machineKey), newestBackup.get(laneId)?.machineKey];
      return Array.from(new Set(keys.filter((key): key is string => typeof key === "string" && key.length > 0)));
    };
    const backupOf = (laneId: string): CloudLaneEntry["backup"] => {
      const backup = newestBackup.get(laneId);
      return backup ? { commits: backup.commits, files: backup.files, savedAt: iso(backup.savedAt)!, bytes: backup.patchBytes } : null;
    };
    for (const box of machines.machines as CloudLaneMachine[]) {
      if (!box.lane) continue;
      const branch = metadataOf.get(box.instanceId)?.[CLOUD_LANE_BRANCH_METADATA]?.trim() || newestBackup.get(box.lane.laneId)?.branchRef || null;
      entries.set(box.lane.laneId, {
        laneId: box.lane.laneId,
        name: box.lane.laneName,
        branch,
        projectOrigin: box.lane.projectOrigin,
        state: laneStateOf(box.state),
        computer: {
          instanceId: box.instanceId,
          machineKey: box.machineKey,
          name: box.name,
          sizeLabel: describeCloudMachineSize(box, catalog),
          hoursRate: box.hoursRate,
          lastUsedAt: iso(box.lastActiveAtMs),
          deletesAt: deletesAt.get(box.instanceId) ?? null,
          diskGb: box.resources?.diskGb ?? null,
        },
        deleted: null,
        chats: chatCount(box.lane.laneId),
        backup: backupOf(box.lane.laneId),
        machineKeys: keysOf(box.lane.laneId, [box.machineKey]),
        link: laneLink(box.lane.laneId),
      });
    }
    for (const lane of kept) {
      if (entries.has(lane.laneId)) continue;
      const fate = CLOUD_KEPT_LANE_FATE[lane.reason] ?? "other";
      entries.set(lane.laneId, {
        laneId: lane.laneId,
        name: lane.laneName,
        branch: lane.branchRef ? lane.branchRef.replace(/^origin\//, "") : null,
        projectOrigin: lane.projectOrigin,
        state: "computer_deleted",
        computer: null,
        deleted: { at: iso(lane.since), fate, sentence: cloudComputerFateSentence(fate, dayOf(lane.since)) },
        chats: chatCount(lane.laneId),
        backup: backupOf(lane.laneId),
        machineKeys: keysOf(lane.laneId, [lane.formerMachineKey]),
        link: laneLink(lane.laneId),
      });
    }
    // Lanes whose computer was deleted with no kept record: only their saved chats are left.
    // A computer's main checkout ("Primary") is no lane of its own: its chats stay in `ade cloud chats`.
    for (const [laneId, chats] of chatsOf) {
      if (entries.has(laneId) || chats.every((chat) => (chat.laneName ?? "").trim().toLowerCase() === "primary")) continue;
      const gone = chats.find((chat) => chat.computer?.state === "deleted");
      if (!gone || gone.computer?.state !== "deleted" || chats.some((chat) => chat.computer?.state === "exists")) continue;
      entries.set(laneId, {
        laneId,
        name: gone.laneName ?? gone.title ?? "Lane",
        branch: newestBackup.get(laneId)?.branchRef ?? null,
        projectOrigin: gone.projectKey ?? null,
        state: "computer_deleted",
        computer: null,
        deleted: { at: iso(gone.computer.deletedAt), fate: gone.computer.reason, sentence: cloudComputerFateSentence(gone.computer.reason, dayOf(gone.computer.deletedAt)) },
        chats: chatCount(laneId),
        backup: backupOf(laneId),
        machineKeys: keysOf(laneId, []),
        link: laneLink(laneId),
      });
    }
    return { lanes: Array.from(entries.values()), unread, chatRows: chatRead.chats, keptIds: new Set(kept.map((lane) => lane.laneId)), failed };
  };

  /** One lane by its id, name, branch or a lane link; a name two lanes share is refused with their ids. */
  const resolveLane = async (selector: string | null): Promise<{ lane: CloudLaneEntry; chatRows: CloudSavedChatRow[]; keptIds: Set<string> }> => {
    if (!selector) throw new Error("Name the lane: its name, id, branch or link (ade cloud lanes).");
    const read = await readLanes();
    const id = UUID.exec(selector)?.[0]?.toLowerCase() ?? null;
    const wanted = selector.toLowerCase().replace(/^origin\//, "");
    const matches = id
      ? read.lanes.filter((lane) => lane.laneId.toLowerCase() === id)
      : read.lanes.filter((lane) => lane.name.toLowerCase() === wanted || (lane.branch ?? "").toLowerCase() === wanted);
    if (!matches.length) throw new Error(`No ADE Cloud lane is called "${selector}". ade cloud lanes lists them.`);
    if (matches.length > 1) {
      throw new Error(`"${selector}" names ${matches.length} lanes: ${matches.map((lane) => `${lane.name} (${lane.laneId}, ${lane.state.replace("_", " ")})`).join(", ")}. Pass the id.`);
    }
    return { lane: matches[0]!, chatRows: read.chatRows, keptIds: read.keptIds };
  };

  const chatsLine = (count: number, keepChats: boolean): string =>
    keepChats ? "Its saved chats stay, to read later." : count > 0 ? `Its ${plural(count, "saved chat")} go too.` : "";

  /** What a delete would lose, from the work check (no wake for an asleep computer saved at rest). */
  const workBody = (work: CloudLaneWorkState): string => {
    if (work.unpushed === null) return `ADE couldn't check its work (${(work.message ?? "no answer").replace(/\.$/, "")}). Anything not on GitHub is lost if you delete it.`;
    if (!work.unpushed) return "All its work is on GitHub.";
    return `Not on GitHub, lost if you delete:\n${work.unpushedLanes.map((lane) => `• ${cloudWorkLaneName(lane) || lane.branchRef}: ${workLine(lane)}`).join("\n")}`;
  };

  /** A chat by id; its machine key is found from the account's saved chats when not given. */
  const findChat = async (chatId: string, machineKey: string | null): Promise<CloudSavedChatRow> => {
    const { chats } = await readChats();
    const found = chats.find((chat) => chat.chatId === chatId && (!machineKey || sameMachineKey(chat.machineKey, machineKey)));
    if (!found) throw new Error(`ADE Cloud has no saved chat ${chatId} among your newest ${CHAT_PAGES * CHAT_PAGE}. Pass --machine-key, or see ade cloud chats.`);
    return found;
  };

  /** A lane's branch from the Git summary a computer of it saved at rest, when nothing else names it. */
  const savedBranchOf = async (lane: CloudLaneEntry): Promise<string | null> => {
    const api = deps.api();
    if (!api) return null;
    for (const machineKey of lane.machineKeys) {
      const branch = (await api.gitSummary(machineKey, lane.laneId).catch((error: unknown) => {
        logger.warn?.("cloud.lane_git_summary_read_failed", { error: getErrorMessage(error) });
        return null;
      }))?.branch?.trim();
      if (branch) return branch;
    }
    return null;
  };

  /** Which computer saved a CLI or shell copy, from at most `SESSION_PAGES` pages of the account's copies. */
  const sessionMachineKey = async (api: CloudApiClient, sessionId: string): Promise<string | null> => {
    let cursor: string | null = null;
    for (let page = 0; page < SESSION_PAGES; page += 1) {
      const listed = await api.savedSessions({ cursor });
      const found = listed?.sessions.find((session) => session.sessionId === sessionId);
      if (found) return found.machineKey;
      cursor = listed?.nextCursor ?? null;
      if (!cursor) return null;
    }
    return null;
  };

  const requireApi = (): CloudApiClient => {
    const api = deps.api();
    if (!api) throw new Error("This ADE isn't signed in to your ADE account.");
    return api;
  };

  /**
   * `status`'s lanes whose computer was deleted, from the list read it already
   * runs (no second one); null when they can't be read.
   */
  const lanesComputerDeleted = async (machines: Promise<CloudMachinesResult>): Promise<CloudStatusDeletedLane[] | null> => {
    try {
      const { lanes, failed, unread } = await readLanes({ machines, backups: false });
      // Either source unread: the list would be short, so status says it couldn't read it.
      if (failed.has("kept") || failed.has("chats")) {
        logger.warn?.("cloud.status_deleted_lanes_unread", { unread });
        return null;
      }
      return lanes
        .filter((lane) => lane.state === "computer_deleted")
        .map((lane) => ({
          laneId: lane.laneId,
          name: lane.name,
          branch: lane.branch,
          projectOrigin: lane.projectOrigin,
          deletedAt: lane.deleted?.at ?? null,
          why: lane.deleted?.sentence ?? "",
        }));
    } catch (error) {
      logger.warn?.("cloud.status_deleted_lanes_failed", { error: getErrorMessage(error) });
      return null;
    }
  };

  const actions = {
    /** Every lane of the account (`ade cloud lanes`): on a computer, or its computer deleted. */
    async lanes(rawArgs?: unknown): Promise<CloudLanesAnswer> {
      const args = record(rawArgs);
      const { lanes, unread } = await readLanes();
      const project = text(args, "project");
      const projectKey = project ? normalizeGitRemoteIdentity(project) ?? project.toLowerCase() : null;
      // Awake lanes first, then the rest, then lanes whose computer was deleted; by name in each. `--stale` sorts by disk below.
      const rank = (lane: CloudLaneEntry) => (lane.state === "awake" ? 0 : lane.state === "computer_deleted" ? 2 : 1);
      let picked = [...lanes].sort((left, right) => rank(left) - rank(right) || left.name.localeCompare(right.name));
      if (projectKey) picked = picked.filter((lane) => normalizeGitRemoteIdentity(lane.projectOrigin) === projectKey);
      if (args.deleted === true) picked = picked.filter((lane) => lane.state === "computer_deleted");
      if (args.stale === true) {
        const cutoff = Date.now() - STALE_MS;
        picked = picked
          .filter((lane) => lane.computer && (lane.computer.deletesAt != null || (lane.computer.lastUsedAt != null && Date.parse(lane.computer.lastUsedAt) < cutoff)))
          .sort((left, right) => (right.computer?.diskGb ?? 0) - (left.computer?.diskGb ?? 0));
      }
      const filtered = projectKey != null || args.deleted === true || args.stale === true;
      return { lanes: picked, unread, ...(filtered ? { filtered: true } : {}) };
    },

    /** One lane, with its saved chats (`ade cloud lanes show <lane>`). */
    async lane_show(rawArgs?: unknown) {
      const { lane, chatRows } = await resolveLane(text(record(rawArgs), "lane"));
      const seen = new Set<string>();
      const chats = chatRows
        // Newest first, so a chat saved under two keys shows its newest copy.
        .filter((chat) => chat.laneId === lane.laneId && !seen.has(chat.chatId) && Boolean(seen.add(chat.chatId)))
        .map((chat) => ({ chatId: chat.chatId, machineKey: chat.machineKey, title: chat.title, provider: chat.provider, model: chat.model, updatedAt: iso(chat.updatedAt) }));
      return { lane: { ...lane, branch: lane.branch ?? await savedBranchOf(lane) }, chats };
    },

    /**
     * Deletes a lane. On a computer: the work check, then the card ([Delete
     * lane] [Keep for later] [Cancel]); the computer goes with the lane and,
     * unless `keepChats`, its saved chats. Computer deleted: the lane's record,
     * its saved work and its saved chats go.
     */
    async lane_delete(rawArgs?: unknown) {
      const args = record(rawArgs);
      const approval = deps.readApproval(args);
      const keepChats = args.keepChats === true;
      const { lane, keptIds } = await resolveLane(text(args, "lane"));
      const account = deps.account();
      if (!lane.computer) {
        // The lane's chats are all that is left of it: deleting the lane deletes them (the server does it with its record).
        if (keepChats) throw new Error(`${lane.name} has no computer, so its saved chats are the lane: deleting it deletes them. Read them first (ade cloud lanes show ${lane.laneId}), or keep the lane.`);
        const saved = lane.backup ? ` and the work ADE saved for it (${workLine({ ahead: lane.backup.commits, dirty: lane.backup.files > 0, files: lane.backup.files })})` : "";
        await deps.approve(approval, {
          action: "delete",
          title: `Delete lane "${lane.name}"`,
          body: `${lane.chats > 0 ? `Its ${plural(lane.chats, "saved chat")}` : "Its saved chats"}${saved} go for good.${lane.branch ? ` Its branch ${lane.branch} stays on GitHub.` : ""}`,
          confirm: "Delete lane",
          personPlace: PERSON_PLACE,
        });
        const kept = keptIds.has(lane.laneId);
        const result = await account.deleteLaneOfDeletedComputer({ laneId: lane.laneId, machineKeys: lane.machineKeys, kept });
        // A kept record takes its backups with it on the server; with no record, ADE deletes them here.
        const api = deps.api();
        let backupsLeft = false;
        if (!kept && lane.backup && api) {
          const backups = await api.laneBackups(lane.laneId, null).catch((error: unknown) => {
            logger.warn?.("cloud.deleted_lane_backups_read_failed", { error: getErrorMessage(error) });
            backupsLeft = true;
            return [] as CloudLaneBackup[];
          });
          for (const backup of backups) {
            await api.forgetLaneBackup(backup.machineKey, backup.laneId).catch((error: unknown) => {
              logger.warn?.("cloud.deleted_lane_backup_forget_failed", { error: getErrorMessage(error) });
              backupsLeft = true;
            });
          }
        }
        const partial = result.chatsLeft || backupsLeft;
        return {
          outcome: partial ? "partial" : "deleted",
          message: partial
            ? `Deleted ${lane.name}, but not all of its chats or saved work. Run it again in a moment.`
            : `Deleted ${lane.name}${result.chatsDeleted ? ` and its ${plural(result.chatsDeleted, "chat")}` : ""}.`,
          ...result,
          backupsLeft,
        };
      }
      const instanceId = lane.computer.instanceId;
      const instance = await account.readInstance(instanceId);
      if (!instance) throw new Error(`${lane.name}'s computer is already gone. ade cloud lanes shows it again in a moment.`);
      const chatSessionId = approval.by === "agent" ? approval.chatSessionId : null;
      // The work check runs only for the card a person sees: it may wake an
      // asleep computer that saved nothing, which uses hours.
      let work: CloudLaneWorkState | null = null;
      const answer = await deps.approve(approval, {
        action: "delete",
        title: `Delete lane "${lane.name}"`,
        body: async () => {
          work = await account.workState({ instanceId, instance });
          return [
            chatsLine(lane.chats, keepChats),
            workBody(work),
            "Keep for later: ADE pushes its work to GitHub, removes its computer, and keeps the lane and its chats. Your next message makes a new computer on the same branch.",
          ].filter(Boolean).join("\n");
        },
        confirm: "Delete lane",
        alternative: { label: "Keep for later" },
        madeByThisChat: chatSessionId != null && instance.metadata[CLOUD_MADE_BY_CHAT_METADATA] === chatSessionId,
        personPlace: PERSON_PLACE,
      });
      if (answer.choice === "alternative") {
        const freed = await account.freeLane({ instanceId });
        return { outcome: freed.ok ? "kept_for_later" : "failed", message: freed.message, lane: freed.lane };
      }
      // The person saw the work check on the card, or decided in their own
      // client, or ADE answered alone (a computer this chat made): the delete
      // doesn't check again, which would only wake the computer.
      const deleted = await account.deleteLane({ instanceId, skipCheck: true, keepChats });
      const checked = work as CloudLaneWorkState | null;
      logger.info?.("cloud.lane_delete_verb", { ok: deleted.ok, by: approval.by, keepChats, checked: checked != null });
      return {
        outcome: deleted.ok ? "deleted" : "failed",
        message: deleted.ok && !keepChats && deleted.chatsKept ? `${deleted.message} Some of its saved chats are left; ade cloud lanes shows them.` : deleted.message,
        unpushedLanes: checked?.unpushedLanes ?? [],
        chatsKept: deleted.chatsKept,
      };
    },

    /** Keeps the lane and its chats, pushes its work and removes its computer (`ade cloud lanes free`). */
    async lane_free(rawArgs?: unknown) {
      const args = record(rawArgs);
      const approval = deps.readApproval(args);
      const { lane } = await resolveLane(text(args, "lane"));
      if (!lane.computer) throw new Error(`${lane.name} has no computer to free. Its next message makes a new one.`);
      const chatSessionId = approval.by === "agent" ? approval.chatSessionId : null;
      const metadata = (await deps.account().readInstance(lane.computer.instanceId))?.metadata ?? {};
      await deps.approve(approval, {
        action: "delete",
        title: `Keep "${lane.name}" for later`,
        body: "ADE pushes its work to GitHub, removes its computer, and keeps the lane and its chats. Your next message makes a new computer on the same branch.",
        confirm: "Keep for later",
        madeByThisChat: chatSessionId != null && metadata[CLOUD_MADE_BY_CHAT_METADATA] === chatSessionId,
        personPlace: PERSON_PLACE,
      });
      const freed = await deps.account().freeLane({ instanceId: lane.computer.instanceId });
      return { outcome: freed.ok ? "kept_for_later" : "failed", message: freed.message, lane: freed.lane };
    },

    /** A new computer for a lane whose computer was deleted, on its branch (`ade cloud lanes start`). */
    async lane_start(rawArgs?: unknown) {
      const args = record(rawArgs);
      const { lane } = await resolveLane(text(args, "lane"));
      if (lane.computer) throw new Error(`${lane.name} is on a computer already (${lane.state}). Send it a message, or ade cloud wake ${lane.computer.name ?? lane.computer.instanceId}.`);
      const branch = lane.branch ?? await savedBranchOf(lane);
      if (!branch) throw new Error(`ADE never learned ${lane.name}'s branch. Start a new lane on ADE Cloud instead.`);
      const here = normalizeGitRemoteIdentity(deps.projectOriginUrl());
      if (lane.projectOrigin && here !== normalizeGitRemoteIdentity(lane.projectOrigin)) throw new Error(`${lane.name} is a lane of ${lane.projectOrigin}. Run this in a folder of that project.`);
      const size = text(args, "size");
      return await deps.laneLaunch({
        approval: args.approval,
        launch: {
          kind: "lane",
          mode: "background",
          launchId: randomUUID(),
          laneId: lane.laneId,
          laneName: lane.name,
          title: lane.name,
          prompt: "",
          laneConfig: { mode: "existing", branchRef: `origin/${branch.replace(/^origin\//, "")}` },
          ...(size ? { cloud: { sizeId: size.toLowerCase() } } : {}),
        },
      });
    },

    /** Stops the idle cleanup's delete of a lane's computer: no wake, no hours (`ade cloud lanes keep`). */
    async lane_keep(rawArgs?: unknown) {
      const { lane } = await resolveLane(text(record(rawArgs), "lane"));
      if (!lane.computer) throw new Error(`${lane.name}'s computer was already deleted. Its next message makes a new one.`);
      await deps.account().keepComputer({ instanceId: lane.computer.instanceId });
      return { kept: true, message: `ADE keeps ${lane.name}'s computer. The idle clock starts again.` };
    },

    /** The lane's Git summary as its computer saved it at rest: no wake (`ade cloud lanes git`). */
    async lane_git(rawArgs?: unknown) {
      const { lane } = await resolveLane(text(record(rawArgs), "lane"));
      const api = requireApi();
      for (const machineKey of lane.machineKeys) {
        const summary = await api.gitSummary(machineKey, lane.laneId).catch((error: unknown) => {
          logger.warn?.("cloud.lane_git_summary_read_failed", { error: getErrorMessage(error) });
          return null;
        });
        if (summary) return { lane: { laneId: lane.laneId, name: lane.name }, summary };
      }
      return { lane: { laneId: lane.laneId, name: lane.name }, summary: null };
    },

    /** Deletes one saved chat from ADE Cloud (`ade cloud chats delete`). */
    async saved_chat_delete(rawArgs?: unknown) {
      const args = record(rawArgs);
      const chatId = text(args, "chatId");
      if (!chatId) throw new Error("Pass the chat id (ade cloud chats).");
      const chat = await findChat(chatId, text(args, "machineKey"));
      if (chat.computer?.state === "exists") throw new Error("This chat's computer still runs it. Delete the chat there, or delete the lane (ade cloud lanes delete).");
      await deps.approve(deps.readApproval(args), {
        action: "delete",
        title: `Delete the saved chat "${chat.title ?? chat.chatId}"`,
        body: "ADE deletes ADE Cloud's copy of this chat for good. Work the chat pushed stays on GitHub.",
        confirm: "Delete chat",
        personPlace: PERSON_PLACE,
      });
      await (await deps.client()).deleteSavedChat({ machineKey: chat.machineKey, chatId: chat.chatId });
      return { deleted: true, chatId: chat.chatId };
    },

    /** The account's saved CLI and shell copies (`ade cloud sessions`). */
    async sessions_list(rawArgs?: unknown) {
      const args = record(rawArgs);
      const project = text(args, "project");
      const listed = await requireApi().savedSessions({ machineKey: text(args, "machineKey"), projectKey: project ? normalizeGitRemoteIdentity(project) ?? project : null, cursor: text(args, "cursor") });
      return listed ?? { sessions: [], nextCursor: null };
    },

    /** One CLI or shell copy (the last lines a shell kept); found by id when the machine key is left out. */
    async session_read(rawArgs?: unknown) {
      const args = record(rawArgs);
      const sessionId = text(args, "sessionId");
      if (!sessionId) throw new Error("Pass the session id (ade cloud sessions).");
      const api = requireApi();
      const machineKey = text(args, "machineKey") ?? await sessionMachineKey(api, sessionId);
      const copy = machineKey ? await api.savedSession(machineKey, sessionId) : null;
      if (!copy) throw new Error(`ADE Cloud has no saved copy of session ${sessionId}${machineKey ? "" : " among your newest copies; pass --machine-key"}. ade cloud sessions lists them.`);
      return copy;
    },

    async session_delete(rawArgs?: unknown) {
      const args = record(rawArgs);
      const sessionId = text(args, "sessionId");
      if (!sessionId) throw new Error("Pass the session id (ade cloud sessions).");
      const api = requireApi();
      const machineKey = text(args, "machineKey") ?? await sessionMachineKey(api, sessionId);
      if (!machineKey) throw new Error(`ADE Cloud has no saved copy of session ${sessionId} among your newest copies. Pass --machine-key, or see ade cloud sessions.`);
      await deps.approve(deps.readApproval(args), {
        action: "delete",
        title: "Delete a saved terminal copy",
        body: "ADE deletes ADE Cloud's copy of this CLI or shell session for good.",
        confirm: "Delete copy",
        personPlace: PERSON_PLACE,
      });
      return await api.deleteSavedSession(machineKey, sessionId);
    },

    /** The account's lane backups: each lane's work not on GitHub, saved at rest (`ade cloud backups`). */
    async backups_list(rawArgs?: unknown) {
      const laneId = text(record(rawArgs), "laneId");
      return { backups: await requireApi().laneBackups(laneId, null) };
    },

    /** Deletes a lane's saved work for good (`ade cloud backups forget <lane id>`). The server refuses it while the lane's computer still has the work. */
    async backup_forget(rawArgs?: unknown) {
      const args = record(rawArgs);
      const laneId = UUID.exec(text(args, "laneId") ?? "")?.[0]?.toLowerCase() ?? null;
      if (!laneId) throw new Error("Pass the lane id (ade cloud backups).");
      const api = requireApi();
      const machineKey = text(args, "machineKey");
      const backups = (await api.laneBackups(laneId, null)).filter((backup) => !machineKey || sameMachineKey(backup.machineKey, machineKey));
      if (!backups.length) throw new Error("ADE Cloud has no saved work for that lane.");
      const commits = Math.max(...backups.map((backup) => backup.commits));
      const files = Math.max(...backups.map((backup) => backup.files));
      await deps.approve(deps.readApproval(args), {
        action: "delete",
        title: `Delete the saved work of "${(backups[0]!.laneName ?? "").trim().toLowerCase() === "primary" ? PRIMARY_LANE_DISPLAY_NAME : backups[0]!.laneName ?? laneId}"`,
        body: `ADE deletes the work it saved for this lane (${workLine({ ahead: commits, dirty: files > 0, files })}). It isn't on GitHub, so it is gone for good.`,
        confirm: "Delete saved work",
        personPlace: PERSON_PLACE,
      });
      let deleted = 0;
      for (const backup of backups) deleted += (await api.forgetLaneBackup(backup.machineKey, backup.laneId)).deleted;
      return { deleted };
    },

    /** What ADE's server runs now: lane launches, moves and copies (`ade cloud jobs`). */
    async jobs_list() {
      const api = requireApi();
      const unread: string[] = [];
      const [launches, moves, copies] = await Promise.all([
        api.activeLaunches().then((list) => list.launches, (error: unknown) => { unread.push(`launches: ${getErrorMessage(error)}`); return []; }),
        api.moves().then((list) => list ?? [], (error: unknown) => { unread.push(`moves: ${getErrorMessage(error)}`); return []; }),
        api.copies().then((list) => list ?? [], (error: unknown) => { unread.push(`copies: ${getErrorMessage(error)}`); return []; }),
      ]);
      return { launches, moves, copies, unread };
    },

    /** Cancels a server job by its id: a launch deletes the computer made for it; a move or copy deletes the new computer. */
    async job_cancel(rawArgs?: unknown) {
      const args = record(rawArgs);
      const jobId = text(args, "jobId");
      if (!jobId) throw new Error("Pass the job id (ade cloud jobs).");
      const api = requireApi();
      const jobs = await actions.jobs_list();
      const launch = jobs.launches.find((entry) => entry.launchId === jobId);
      const move = jobs.moves.find((entry) => entry.moveId === jobId);
      const copy = jobs.copies.find((entry) => entry.copyId === jobId);
      if (!launch && !move && !copy) throw new Error(`ADE Cloud runs no job ${jobId} now. ade cloud jobs lists them.`);
      const what = launch ? `the launch of "${launch.laneName ?? "a lane"}"` : move ? `the move of "${move.sourceName}"` : `the copy of "${copy!.sourceName}"`;
      await deps.approve(deps.readApproval(args), {
        action: "delete",
        title: `Cancel ${what}`,
        body: launch ? "ADE stops it and deletes the computer made for it." : "ADE stops it and deletes the new computer. The old one stays as it is.",
        confirm: "Cancel it",
        personPlace: PERSON_PLACE,
      });
      if (launch) return await api.cancelLaunch(jobId);
      if (move) return await api.cancelMove(jobId);
      return await api.cancelCopy(jobId);
    },

    /** One project's whole ADE Cloud view with no computer awake (`ade cloud project`). */
    async project_overview(rawArgs?: unknown) {
      const raw = text(record(rawArgs), "origin") ?? deps.projectOriginUrl();
      const origin = raw ? normalizeGitRemoteIdentity(raw) ?? raw : null;
      if (!origin) throw new Error("Name the project: --origin github.com/<owner>/<repo>, or run this in a folder of it.");
      const overview = await requireApi().projectOverview(origin);
      if (!overview) throw new Error("ADE's server is too old to show a project's overview.");
      return overview;
    },
  };
  return { actions, lanesComputerDeleted };
}

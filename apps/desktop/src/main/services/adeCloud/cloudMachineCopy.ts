/**
 * Copy and move for cloud machines.
 *
 * - **Copy** (`copyCloudMachine`): the provider's fork makes a second box with
 *   the same disk (repos, lanes, installed dependencies, build caches). It
 *   boots fresh and, through the copied-home guard, signed out as a new
 *   machine; ADE signs it in like a new one. That is "a fresh machine per
 *   lane, copied from a warm one": the copy is ready to work without cloning
 *   or installing anything again.
 * - **Move** (`moveCloudMachine`): the provider can't change a box's type, and a
 *   fork keeps it. So moving a box to a VM (or back) makes a new machine of
 *   the other type, streams the old one's home folder into it (every repo,
 *   lane worktree with its uncommitted work, project chat and provider
 *   sign-in, and the agents' own conversations from ADE's provider homes so
 *   each chat resumes its agent's session; never ADE's own identity or
 *   Docker's data), registers the projects there, gives it the old name, and
 *   deletes the old box.
 *
 * Moving a lane between this Mac and a cloud machine is the cross-machine
 * handoff (`ade chat move`), which already carries a lane's commits and
 * uncommitted work to any machine on the account.
 *
 * ADE's server runs both when it can (`copyOnServer`, `moveOnServer`), so
 * they go on with no app open and need no computer of the person's own; an
 * older server, or one whose computers can't run them yet, gets them run from
 * here, where signing the new machine in uses the approval window.
 */

import { randomUUID } from "node:crypto";
import {
  cloudInstanceType,
  cloudKindLabel,
  cloudShape,
  cloudShapeById,
  cloudShapeFor,
  isCloudMachineKind,
  type CloudCreateMachineResult,
  type CloudCreateProgress,
  type CloudMachineKind,
  type CloudShapeId,
} from "../../../shared/adeCloud";
import { cloudMadeByMetadata, type CloudAgentMaker } from "../../../shared/adeCloud";
import { CLOUD_LANE_METADATA_KEYS } from "../../../shared/cloudLaneLaunch";
import { getErrorMessage } from "../shared/utils";
import { CloudProviderError, type CloudProvider, type CloudInstance, type CloudLogger } from "./cloudProvider";
import {
  CloudCreateCancelled,
  bringCloudBoxIntoAde,
  createCloudMachine,
  normalizeCloudMachineName,
  type CloudMachineCreatorDeps,
} from "./cloudMachineCreator";
import { CLOUD_FORMER_MACHINE_KEYS_METADATA, CLOUD_MACHINE_KEY_METADATA, formerMachineKeysAfterMove } from "./cloudMachines";
import { deleteCloudInstanceConfirmed } from "./cloudPendingCreates";
import { wakeThroughTransition } from "./cloudInstanceOps";
import { cloudHoldCommand, cloudReleaseHoldCommand } from "./cloudSleep";
import {
  MOVE_EXIT_COMMAND,
  MOVE_HOLD_MS,
  MOVE_LOG_TAIL_COMMAND,
  MOVE_SERVE_PORT,
  MOVE_TRANSFER_TIMEOUT_MS,
  MOVE_UNPAUSE_COMMAND,
  PROJECTS_LIST_COMMAND,
  copiedComputerMetadata,
  moveArchiveUrl,
  pauseAndServeHomeCommand,
  readProjectRoots,
  receiveHomeCommand,
  registerProjectsCommand,
} from "../../../../../account-directory/src/cloud/computerCommands";
import type { CloudCopyRecord, CloudCopyRequest, CloudMoveRecord } from "../../../../../account-directory/src/cloud/contract";

export type CloudCopyDeps = CloudMachineCreatorDeps & {
  removeAccountMachine: (machineKey: string) => Promise<unknown>;
  /**
   * A move deleted its source: forget this desktop's saved connection to it,
   * as Delete computer does. Set only where those connections live (the
   * desktop's main process); a brain has none.
   */
  forgetMachineConnections?: (machine: { machineKey: string | null; instanceId: string }) => void;
};

/** A fork of a big disk answers 202 and finishes on its own; a warm VM took 167 s. */
const FORK_READY_TIMEOUT_MS = 15 * 60_000;
const POLL_MS = 3_000;
/** The copy's hold on sleep (`cloudHoldCommand`); it expires on its own if ADE quits mid-way. */
const COPY_HOLD_MS = 20 * 60_000;

/** The lane facts a computer carries (`CLOUD_LANE_METADATA_KEYS`), for the computer that replaces it. */
function laneMetadataOf(source: CloudInstance): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of CLOUD_LANE_METADATA_KEYS) {
    const value = source.metadata[key];
    if (typeof value === "string" && value) out[key] = value;
  }
  return out;
}

async function waitForRunning(client: CloudProvider, instanceId: string, signal: AbortSignal | undefined, sleep: (ms: number) => Promise<void>): Promise<CloudInstance> {
  const deadline = Date.now() + FORK_READY_TIMEOUT_MS;
  for (;;) {
    if (signal?.aborted) throw new CloudCreateCancelled();
    const instance = await client.getInstance(instanceId).catch(() => null);
    if (instance?.status === "running") return instance;
    if (instance?.status === "failed") throw new Error(`ADE Cloud couldn't make the copy${instance.statusReason?.message ? `: ${instance.statusReason.message}` : "."}`);
    if (Date.now() > deadline) throw new Error("ADE Cloud didn't finish making the copy in time.");
    await sleep(POLL_MS);
  }
}

export type CloudCopyArgs = {
  instanceId: string;
  name?: string | null;
  shape?: CloudShapeId | null;
  requestId?: string;
  madeByChat?: string | null;
  madeByAgent?: CloudAgentMaker | null;
};

export type CloudCopyResult = CloudCreateMachineResult & { copiedFrom: string; forkMs: number };

/**
 * Copies a cloud machine into a new one with the same files, signed in as
 * a new machine of the account. A copy that never signs in is deleted.
 *
 * ADE's server runs it when it can (`copyOnServer`), so it goes on with this
 * app closed; an older server, or one whose computers can't read their
 * sign-in file yet, gets the copy run from here as before.
 */
export async function copyCloudMachine(
  deps: CloudCopyDeps,
  args: CloudCopyArgs,
  onProgress: (progress: CloudCreateProgress) => void,
  options: { signal?: AbortSignal } = {},
): Promise<CloudCopyResult> {
  const requestId = args.requestId ?? randomUUID();
  const client = await deps.client();
  const served = await copyOnServer(deps, client, { ...args, requestId }, onProgress, options);
  if (served) return served;
  return await copyHere(deps, client, { ...args, requestId }, onProgress, options);
}

/** The server's answers that mean "run the copy from here": copies off, or a computer on an older ADE (an older server answers 404). */
const COPY_HERE_CODES = new Set(["server_copy_unavailable", "copy_needs_update"]);
/** An agent maker, as the server names a copy's origin. */
const COPY_ORIGIN: Record<CloudAgentMaker, NonNullable<CloudCopyRequest["origin"]>> = { chat: "agent", automation: "automation", mcp: "mcp" };

/**
 * The server's copy (`POST /cloud/instances/:id/copy`), followed to its end
 * with the same progress stages as a copy run here. Null when this server
 * can't run one, so the caller runs it here.
 */
async function copyOnServer(
  deps: CloudCopyDeps,
  client: CloudProvider,
  args: CloudCopyArgs & { requestId: string },
  onProgress: (progress: CloudCreateProgress) => void,
  options: { signal?: AbortSignal },
): Promise<CloudCopyResult | null> {
  if (!client.startCopy || !client.readCopy) return null;
  const logger: CloudLogger = deps.logger ?? {};
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const shape = args.shape ? cloudShape(args.shape) : null;
  if (args.shape && !shape) throw new Error("Pick a size.");
  const name = args.name?.trim() ? normalizeCloudMachineName(args.name.trim()) : null;
  const start = async (copyId: string): Promise<CloudCopyRecord | null> => {
    try {
      return await client.startCopy!(args.instanceId, {
        copyId,
        ...(name ? { name } : {}),
        ...(shape ? { resources: { cpu: shape.cpu, memoryGb: shape.memoryGb } } : {}),
        // An agent's copy keeps its maker, so the agent limits hold as for one made here.
        origin: args.madeByAgent ? COPY_ORIGIN[args.madeByAgent] : "person",
        ...(args.madeByChat ? { madeByChat: args.madeByChat } : {}),
      });
    } catch (error) {
      if (error instanceof CloudProviderError && (error.status === 404 || COPY_HERE_CODES.has(error.code ?? ""))) {
        logger.info?.("cloud.machine_copy_here", { reason: error.code });
        return null;
      }
      throw error;
    }
  };
  // The copy's id is the request's, so the same request (a restart, a Retry) follows the same copy.
  const first = await start(UUID.test(args.requestId) ? args.requestId : randomUUID());
  if (!first) return null;
  let record: CloudCopyRecord = first;
  // A Retry of a copy that ended without one: a new one.
  if (record.state === "failed" || record.state === "cancelled") {
    const again = await start(randomUUID());
    if (!again) return null;
    record = again;
  }
  const copyId = record.copyId;
  const progress = (stage: CloudCreateProgress["stage"], message: string, instanceId?: string | null, approvalUrl?: string | null) =>
    onProgress({ requestId: args.requestId, stage, message, ...(instanceId ? { instanceId } : {}), ...(approvalUrl ? { approvalUrl } : {}) });
  const startedAt = Date.now();
  let forkMs = 0;
  let lastLine = "";
  let handedUrl: string | null = null;
  let failures = 0;
  for (;;) {
    if (options.signal?.aborted && record.cancellable && client.cancelCopy) {
      // Before the copy signs in the server deletes it (now, or at its step's end); after, it is a whole computer.
      const current = record;
      record = await client.cancelCopy(copyId).catch((error: unknown): CloudCopyRecord => {
        logger.warn?.("cloud.machine_copy_cancel_failed", { copyId, error: getErrorMessage(error) });
        return { ...current, cancellable: false };
      });
    }
    const line = record.message;
    if (record.state === "copying") {
      if (line !== lastLine) progress("creating", line, record.targetInstanceId);
    } else if (record.state === "joining") {
      if (!forkMs) forkMs = Date.now() - startedAt;
      if (line !== lastLine) progress("signing_in", line, record.targetInstanceId);
    } else if (record.state === "needs_approval") {
      if (line !== lastLine) progress("approve_elsewhere", line, record.targetInstanceId, record.approvalUrl);
      // With no window here (a brain on its own), the link goes to the person, once per link.
      if (record.approvalUrl && record.approvalUrl !== handedUrl && !deps.approveInWindow && deps.handOffApproval) {
        handedUrl = record.approvalUrl;
        let userCode = "";
        try {
          userCode = new URL(record.approvalUrl).searchParams.get("user_code") ?? "";
        } catch {
          // A link with no code still opens the approval page.
        }
        deps.handOffApproval({ url: record.approvalUrl, userCode, name: record.name });
      }
    }
    lastLine = line;
    if (record.state === "done") break;
    if (record.state === "failed") throw new Error(record.error ?? record.message);
    if (record.state === "cancelled") throw new CloudCreateCancelled(record.message || "The copy was cancelled.");
    await sleep(SERVER_MOVE_POLL_MS);
    try {
      record = await client.readCopy(copyId);
      failures = 0;
    } catch (error) {
      failures += 1;
      if (error instanceof CloudProviderError && error.status === 404) throw new Error("ADE Cloud lost track of the copy. Check your computers list.");
      if (failures >= SERVER_MOVE_READ_FAILURES) {
        throw new Error(`ADE can't reach ADE Cloud to follow the copy. It goes on there; check your computers list. (${getErrorMessage(error)})`);
      }
    }
  }
  const targetId = record.targetInstanceId!;
  logger.info?.("cloud.machine_copied", { sourceId: args.instanceId, instanceId: targetId, onServer: true });
  return {
    instanceId: targetId,
    machineKey: record.targetMachineKey ?? null,
    name: record.name,
    joined: record.targetMachineKey != null,
    // The server named the machine row and the computer before it said done.
    renamed: true,
    copiedFrom: args.instanceId,
    forkMs: forkMs || Date.now() - startedAt,
  };
}

/** The copy run from this app, as before the server ran it. */
async function copyHere(
  deps: CloudCopyDeps,
  client: CloudProvider,
  args: CloudCopyArgs & { requestId: string },
  onProgress: (progress: CloudCreateProgress) => void,
  options: { signal?: AbortSignal },
): Promise<CloudCopyResult> {
  const { requestId } = args;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const logger: CloudLogger = deps.logger ?? {};
  const progress = (stage: CloudCreateProgress["stage"], message: string, instanceId?: string, approvalUrl?: string) =>
    onProgress({ requestId, stage, message, ...(instanceId ? { instanceId } : {}), ...(approvalUrl ? { approvalUrl } : {}) });
  const directory = deps.directoryBaseUrl();
  if (!directory) throw new Error("ADE's account service isn't configured on this computer, so it can't sign the copy in.");
  if (!(await deps.getAccountToken())) throw new Error("Sign in to ADE on this computer first. The copy joins your account.");
  const source = await client.getInstance(args.instanceId);
  if (!["running", "sleeping", "stopped"].includes(source.status)) {
    throw new Error(`The computer is ${source.status}; ADE Cloud copies a computer that is running, asleep or stopped.`);
  }
  const shape = args.shape ? cloudShape(args.shape) : null;
  if (args.shape && !shape) throw new Error("Pick a size.");
  const name = normalizeCloudMachineName(args.name?.trim() || `${source.name ?? source.id} copy`);
  try {
    deps.pendingCreates?.begin(requestId, Date.now());
  } catch (error) {
    logger.warn?.("cloud.machine_copy_not_recorded", { error: getErrorMessage(error) });
    throw new Error("ADE couldn't save a note of the copy it's about to make, so it didn't make one. Check that ADE can write to its folder, then try again.");
  }
  progress("creating", `Copying ${source.name ?? source.id} on ADE Cloud…`);
  // A running source must not fall asleep mid-copy.
  if (source.status === "running") {
    await client.exec(source.id, cloudHoldCommand("copy", COPY_HOLD_MS), { timeoutMs: 30_000 })
      .catch((error: unknown) => logger.warn?.("cloud.machine_copy_hold_failed", { error: getErrorMessage(error) }));
  }
  const forkStarted = Date.now();
  /** The fork, running; a fork that never ran is deleted. */
  const forkAndWait = async (): Promise<CloudInstance> => {
    let fork: CloudInstance;
    try {
      fork = await client.forkInstance(source.id, {
        name,
        ...(shape ? { resources: { cpu: shape.cpu, memory: shape.memoryGb } } : {}),
        metadata: copiedComputerMetadata(source.metadata, {
          ade_copied_from: source.id,
          ...cloudMadeByMetadata(args),
          ade_request_id: requestId,
        }),
      }, options.signal);
    } catch (error) {
      // Nothing to find but by the request id, which the next app start reconciles.
      if (options.signal?.aborted) throw new CloudCreateCancelled();
      throw error;
    }
    deps.pendingCreates?.attach(requestId, fork.id);
    logger.info?.("cloud.machine_copy_started", { sourceId: source.id, instanceId: fork.id });
    try {
      if (fork.status !== "running") {
        progress("creating", "ADE Cloud is copying the disk. A big one takes a few minutes…", fork.id);
        fork = await waitForRunning(client, fork.id, options.signal, sleep);
      }
    } catch (error) {
      const gone = await deleteCloudInstanceConfirmed(client, fork.id, { logger, sleep });
      if (gone) deps.pendingCreates?.finish(requestId);
      throw error;
    }
    return fork;
  };
  let fork: CloudInstance;
  try {
    fork = await forkAndWait();
  } finally {
    // The source's hold ends with the fork, worked or not; its time-out only
    // covers an ADE that quit mid-copy.
    if (source.status === "running") {
      await client.exec(source.id, cloudReleaseHoldCommand("copy"), { timeoutMs: 30_000 })
        .catch((error: unknown) => logger.warn?.("cloud.machine_copy_release_failed", { error: getErrorMessage(error) }));
    }
  }
  const forkMs = Date.now() - forkStarted;
  logger.info?.("cloud.machine_copied", { sourceId: source.id, instanceId: fork.id, forkMs });
  // The source's sign-in files came with the disk; the copy signs in fresh.
  await client.exec(fork.id, `rm -f "$ADE_HOME/logs/cloud-sign-in.log" "$ADE_HOME/logs/cloud-sign-in.pid"; ${cloudReleaseHoldCommand("copy")}`, { timeoutMs: 60_000 })
    .catch((error: unknown) => logger.warn?.("cloud.machine_copy_cleanup_failed", { instanceId: fork.id, error: getErrorMessage(error) }));
  // The copy came up signed out (the copied-home guard): sign it in like a new box.
  const result = await bringCloudBoxIntoAde(deps, { client, instance: fork, name, requestId, signal: options.signal, progress, directory });
  return { ...result, copiedFrom: source.id, forkMs };
}

export type CloudMoveResult = CloudCreateMachineResult & {
  movedFrom: string;
  /** The projects registered on the new machine. */
  projects: string[];
  transferMs: number;
  /** False when the old box couldn't be deleted (it is asleep and kept; delete it from its card). */
  sourceDeleted: boolean;
};

export type CloudMoveArgs = {
  instanceId: string;
  machineKey?: string | null;
  to: CloudMachineKind;
  shape?: CloudShapeId | null;
  requestId?: string;
  madeByChat?: string | null;
  madeByAgent?: CloudAgentMaker | null;
  /** An unattended agent's yes (the agent limits, no person's tap): the server moves only for a person, so it runs here. */
  selfApprove?: boolean;
};

export type CloudMoveOptions = {
  signal?: AbortSignal;
  /** The copy is done and the new machine is whole: called before the old one is deleted, so a caller can save it first. */
  onCopied?: (target: { instanceId: string; machineKey: string | null; name: string }) => void;
  /** False: the caller already stopped the turns and saved the chats, so the move doesn't again. */
  save?: boolean;
  /** Called once ADE's server took the move: it goes on there with no app open. */
  onServer?: () => void;
};

/**
 * Moves a machine to the other type (box ↔ VM), keeping its work: a new
 * machine, the old one's home folder streamed into it, the old one deleted.
 * A failure before the copy landed deletes the new machine and leaves the old
 * one as it was.
 *
 * ADE's server runs it when it can (`moveOnServer`), so it goes on with this
 * app closed; an older server, or one whose computers can't run it yet, gets
 * the move run from here as before.
 */
export async function moveCloudMachine(
  deps: CloudCopyDeps,
  args: CloudMoveArgs,
  onProgress: (progress: CloudCreateProgress) => void,
  options: CloudMoveOptions = {},
): Promise<CloudMoveResult> {
  if (!isCloudMachineKind(args.to)) throw new Error("Move it to a standard or a full computer.");
  const requestId = args.requestId ?? randomUUID();
  const client = await deps.client();
  if (!args.selfApprove) {
    const served = await moveOnServer(deps, client, { ...args, requestId }, onProgress, options);
    if (served) return served;
  }
  return await moveHere(deps, client, { ...args, requestId }, onProgress, options);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** How often a server move is read while this app follows it. */
const SERVER_MOVE_POLL_MS = 3_000;
/** Reads that fail in a row before this app stops following (the move goes on there). */
const SERVER_MOVE_READ_FAILURES = 40;

/**
 * The server's move (`POST /cloud/instances/:id/move`), followed to its end
 * with the same progress lines as a move run here. Null when this server
 * can't run one (an older one answers 404; `server_move_unavailable` until
 * its computers can), so the caller runs it here.
 */
async function moveOnServer(
  deps: CloudCopyDeps,
  client: CloudProvider,
  args: CloudMoveArgs & { requestId: string },
  onProgress: (progress: CloudCreateProgress) => void,
  options: CloudMoveOptions,
): Promise<CloudMoveResult | null> {
  if (!client.startMove || !client.readMove) return null;
  const logger: CloudLogger = deps.logger ?? {};
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const shape = args.shape ? cloudShape(args.shape) : null;
  const label = cloudKindLabel(args.to);
  const start = async (moveId: string): Promise<CloudMoveRecord | null> => {
    try {
      return await client.startMove!(args.instanceId, {
        moveId,
        to: args.to === "vm" ? "full" : "standard",
        ...(shape ? { resources: { cpu: shape.cpu, memoryGb: shape.memoryGb } } : {}),
        // An agent's ask reaches here only after the person said yes on its card.
        origin: "person",
        timing: "now",
        ...(options.save === false ? { save: false } : {}),
      });
    } catch (error) {
      if (error instanceof CloudProviderError && (error.status === 404 || error.code === "server_move_unavailable")) {
        logger.info?.("cloud.machine_move_here", { reason: error.code });
        return null;
      }
      throw error;
    }
  };
  // The move's id is the request's, so the same request (a restart, a Retry) follows the same move.
  const first = await start(UUID.test(args.requestId) ? args.requestId : randomUUID());
  if (!first) return null;
  let record: CloudMoveRecord = first;
  // A Retry of a move that ended without moving: a new one.
  if (record.state === "failed" || record.state === "cancelled") {
    const again = await start(randomUUID());
    if (!again) return null;
    record = again;
  }
  options.onServer?.();
  const moveId = record.moveId;
  const progress = (stage: CloudCreateProgress["stage"], message: string, instanceId?: string | null, approvalUrl?: string | null) =>
    onProgress({ requestId: args.requestId, stage, message, ...(instanceId ? { instanceId } : {}), ...(approvalUrl ? { approvalUrl } : {}) });
  let copying = false;
  let copied = false;
  let lastLine = "";
  let failures = 0;
  const copiedTarget = (from: CloudMoveRecord) => ({
    instanceId: from.targetInstanceId!,
    machineKey: from.targetMachineKey ?? null,
    name: from.sourceName,
  });
  for (;;) {
    if (options.signal?.aborted && record.cancellable && client.cancelMove) {
      // Before the copy the server undoes it (now, or at its step's end); after, it goes on there to the end.
      const current = record;
      record = await client.cancelMove(moveId).catch((error: unknown): CloudMoveRecord => {
        logger.warn?.("cloud.machine_move_cancel_failed", { moveId, error: getErrorMessage(error) });
        return { ...current, cancellable: false };
      });
    }
    const line = record.message;
    if (record.state === "making") {
      if (line !== lastLine) progress("creating", line);
    } else if (record.state === "joining") {
      if (line !== lastLine) progress("signing_in", line, record.targetInstanceId);
    } else if (record.state === "needs_approval") {
      if (line !== lastLine) progress("approve_elsewhere", line, record.targetInstanceId, record.approvalUrl);
    } else if (record.state === "copying") {
      // The first copy line names the target, as a move run here does: a caller marks the new computer made.
      if (!copying) progress("joining", `Copying ${record.sourceName}'s files to the new ${label}…`, record.targetInstanceId);
      else if (line !== lastLine) progress("joining", line, record.targetInstanceId);
      copying = true;
    } else if ((record.state === "finishing" || record.state === "done") && !copied && record.targetInstanceId) {
      copied = true;
      options.onCopied?.(copiedTarget(record));
    }
    lastLine = line;
    if (record.state === "done") break;
    if (record.state === "failed") throw new Error(record.error ?? record.message);
    if (record.state === "cancelled") throw new CloudCreateCancelled(record.message || "The move was cancelled.");
    await sleep(SERVER_MOVE_POLL_MS);
    try {
      record = await client.readMove(moveId);
      failures = 0;
    } catch (error) {
      failures += 1;
      if (error instanceof CloudProviderError && error.status === 404) throw new Error("ADE Cloud lost track of the move. Check the computer's card.");
      if (failures >= SERVER_MOVE_READ_FAILURES) {
        throw new Error(`ADE can't reach ADE Cloud to follow the move. It goes on there; check the computer's card. (${getErrorMessage(error)})`);
      }
    }
  }
  const sourceDeleted = record.sourceDeleted === true;
  const sourceKey = args.machineKey ?? record.sourceMachineKey ?? null;
  if (sourceDeleted) {
    // Left behind, the old connection kept its chats pinned to a computer
    // that no longer exists, and every send there failed.
    try {
      deps.forgetMachineConnections?.({ machineKey: sourceKey, instanceId: args.instanceId });
    } catch (error) {
      logger.warn?.("cloud.machine_move_connection_left", { error: getErrorMessage(error) });
    }
  }
  const targetId = record.targetInstanceId!;
  // Kept, the old computer keeps its name; the new one has the name the move gave it.
  const name = sourceDeleted
    ? record.sourceName
    : await client.getInstance(targetId).then((instance) => instance.name ?? record.sourceName, () => record.sourceName);
  logger.info?.("cloud.machine_moved", { sourceId: args.instanceId, instanceId: targetId, to: args.to, sourceDeleted, onServer: true });
  return {
    instanceId: targetId,
    machineKey: record.targetMachineKey ?? null,
    name,
    joined: record.targetMachineKey != null,
    renamed: sourceDeleted,
    movedFrom: args.instanceId,
    projects: record.projects ?? [],
    transferMs: 0,
    sourceDeleted,
  };
}

/** The move run from this app, as before the server ran it. */
async function moveHere(
  deps: CloudCopyDeps,
  client: CloudProvider,
  args: CloudMoveArgs & { requestId: string },
  onProgress: (progress: CloudCreateProgress) => void,
  options: CloudMoveOptions,
): Promise<CloudMoveResult> {
  const { requestId } = args;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const logger: CloudLogger = deps.logger ?? {};
  const progress = (stage: CloudCreateProgress["stage"], message: string, instanceId?: string, approvalUrl?: string) =>
    onProgress({ requestId, stage, message, ...(instanceId ? { instanceId } : {}), ...(approvalUrl ? { approvalUrl } : {}) });
  const source = await client.getInstance(args.instanceId);
  const targetType = cloudInstanceType(args.to);
  if ((source.type ?? "default") === targetType) {
    throw new Error(`It's already a ${cloudKindLabel(args.to)}. Use Resize to change its size.`);
  }
  const sourceResources = source.resources ? { cpu: source.resources.cpu, memoryGb: source.resources.memory } : null;
  const shape = (args.shape ? cloudShape(args.shape) : null) ?? cloudShapeFor(sourceResources) ?? cloudShapeById("2x4");
  const sourceName = source.name ?? source.id;
  // The old box must be awake to hand its files over.
  if (source.status !== "running") {
    progress("creating", `Waking ${sourceName}…`);
    await wakeThroughTransition(client, source.id);
  }
  const listed = await client.exec(source.id, PROJECTS_LIST_COMMAND, { timeoutMs: 60_000 });
  const projectRoots = readProjectRoots(listed.stdout);

  // 1. The new machine, signed in, named for now as the move's target.
  const target = await createCloudMachine(deps, requestId, {
    kind: args.to,
    shape: shape.id,
    name: normalizeCloudMachineName(`${sourceName} (${cloudKindLabel(args.to)})`),
  }, onProgress, {
    signal: options.signal,
    moveFromInstanceId: source.id,
    metadata: {
      // The lane moves with its computer: pickers, the dashboard and a later
      // delete read the lane from here with no wake.
      ...laneMetadataOf(source),
      ade_moved_from: source.id,
      [CLOUD_FORMER_MACHINE_KEYS_METADATA]: formerMachineKeysAfterMove(source.metadata, args.machineKey ?? source.metadata[CLOUD_MACHINE_KEY_METADATA] ?? null),
      ...cloudMadeByMetadata(args),
    },
  });

  let transferMs = 0;
  try {
    // 2. Quiet the old machine's ADE so its databases are copied whole: the
    //    entrypoint holds the brain while `brain.paused` exists.
    progress("joining", `Copying ${sourceName}'s files to the new ${cloudKindLabel(args.to)}…`, target.instanceId);
    const paused = await client.exec(source.id, pauseAndServeHomeCommand(MOVE_SERVE_PORT), { timeoutMs: 60_000 });
    if (!/started/.test(paused.stdout)) throw new Error("The old machine didn't start handing its files over.");
    const signed = await client.signedUrl(source.id, { port: MOVE_SERVE_PORT, ttlSeconds: 3_600 });
    const started = Date.now();
    // The new machine's brain, idle during the copy, must not sleep it.
    await client.exec(target.instanceId, `${cloudHoldCommand("move", MOVE_HOLD_MS)}\n${receiveHomeCommand(moveArchiveUrl(signed.url))}`, { timeoutMs: 60_000 });
    let exit: number | null = null;
    while (exit == null) {
      if (Date.now() - started > MOVE_TRANSFER_TIMEOUT_MS) throw new Error("Copying the files took too long.");
      await sleep(POLL_MS);
      const read = await client.exec(target.instanceId, MOVE_EXIT_COMMAND, { timeoutMs: 30_000 }).catch(() => null);
      const raw = read?.stdout.trim();
      if (raw) exit = Number(raw);
    }
    if (exit !== 0) {
      const why = await client.exec(target.instanceId, MOVE_LOG_TAIL_COMMAND, { timeoutMs: 30_000 }).catch(() => null);
      throw new Error(`copying the files failed (exit ${exit})${why?.stdout.trim() ? `: ${why.stdout.trim().slice(-300)}` : "."}`);
    }
    transferMs = Date.now() - started;
    logger.info?.("cloud.machine_move_copied", { sourceId: source.id, instanceId: target.instanceId, transferMs });
    // 3. Its projects, registered with the new machine's ADE.
    if (projectRoots.length) await client.exec(target.instanceId, registerProjectsCommand(projectRoots), { timeoutMs: 120_000 });
    // The move's work on the new machine is done: it may sleep when idle
    // again. The 45-minute time-out only covers an ADE that quit mid-move; a
    // failed move deletes the new machine, hold and all.
    await client.exec(target.instanceId, cloudReleaseHoldCommand("move"), { timeoutMs: 30_000 })
      .catch((release: unknown) => logger.warn?.("cloud.machine_move_release_failed", { instanceId: target.instanceId, error: getErrorMessage(release) }));
  } catch (error) {
    // The old machine is untouched but for the pause: let its ADE start again,
    // and take the half-made new one away.
    logger.warn?.("cloud.machine_move_failed", { sourceId: source.id, instanceId: target.instanceId, error: getErrorMessage(error) });
    await client.exec(source.id, MOVE_UNPAUSE_COMMAND, { timeoutMs: 30_000 })
      // The entrypoint clears a pause two hours old, so a box this misses comes back on its own.
      .catch((unpause: unknown) => logger.warn?.("cloud.machine_move_unpause_failed", { sourceId: source.id, error: getErrorMessage(unpause) }));
    await deleteCloudInstanceConfirmed(client, target.instanceId, { logger, sleep });
    if (target.machineKey) {
      await deps.removeAccountMachine(target.machineKey)
        .catch((removal: unknown) => logger.warn?.("cloud.machine_move_row_left", { error: getErrorMessage(removal) }));
    }
    throw new Error(`ADE couldn't move ${sourceName}: ${getErrorMessage(error)} ${sourceName} is as it was, and the new machine was deleted.`);
  }

  options.onCopied?.({ instanceId: target.instanceId, machineKey: target.machineKey ?? null, name: target.name });

  // 4. The old box goes; the new one takes its name.
  let sourceDeleted = false;
  try {
    await client.deleteInstance(source.id, { reason: "moved" });
    sourceDeleted = await deleteCloudInstanceConfirmed(client, source.id, { logger, sleep });
  } catch (error) {
    if (error instanceof CloudProviderError && error.status === 404) sourceDeleted = true;
    else logger.warn?.("cloud.machine_move_source_left", { sourceId: source.id, error: getErrorMessage(error) });
  }
  if (!sourceDeleted) {
    // The old box stays: let its ADE start again.
    await client.exec(source.id, MOVE_UNPAUSE_COMMAND, { timeoutMs: 30_000 })
      .catch((error: unknown) => logger.warn?.("cloud.machine_move_unpause_failed", { sourceId: source.id, error: getErrorMessage(error) }));
  }
  const sourceKey = args.machineKey ?? source.metadata[CLOUD_MACHINE_KEY_METADATA] ?? null;
  if (sourceDeleted && sourceKey) {
    await deps.removeAccountMachine(sourceKey)
      .catch((removal: unknown) => logger.warn?.("cloud.machine_move_row_left", { error: getErrorMessage(removal) }));
  }
  if (sourceDeleted) {
    // Left behind, the old connection kept its chats pinned to a computer
    // that no longer exists, and every send there failed.
    try {
      deps.forgetMachineConnections?.({ machineKey: sourceKey, instanceId: source.id });
    } catch (error) {
      logger.warn?.("cloud.machine_move_connection_left", { error: getErrorMessage(error) });
    }
  }
  let renamed = target.renamed;
  if (target.machineKey && sourceDeleted) {
    renamed = await deps.renameMachine(target.machineKey, sourceName).then(() => true, () => false);
    await client.setInstanceName(target.instanceId, sourceName).catch((error: unknown) =>
      logger.warn?.("cloud.machine_move_rename_failed", { instanceId: target.instanceId, error: getErrorMessage(error) }));
  }
  logger.info?.("cloud.machine_moved", { sourceId: source.id, instanceId: target.instanceId, to: args.to, transferMs, sourceDeleted });
  return {
    ...target,
    name: renamed && sourceDeleted ? sourceName : target.name,
    renamed,
    movedFrom: source.id,
    projects: projectRoots,
    transferMs,
    sourceDeleted,
  };
}

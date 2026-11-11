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
 *   sign-in; never
 *   ADE's own identity or Docker's data), registers the projects there, gives
 *   it the old name, and deletes the old box.
 *
 * Moving a lane between this Mac and a cloud machine is the cross-machine
 * handoff (`ade chat move`), which already carries a lane's commits and
 * uncommitted work to any machine on the account.
 *
 * Both run in the desktop: signing the new machine in uses the approval window.
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
import { CLOUD_MADE_BY_CHAT_METADATA } from "../../../shared/adeCloud";
import { CLOUD_READY_METADATA } from "../../../shared/cloudReady";
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
import { CLOUD_MACHINE_KEY_METADATA } from "./cloudMachines";
import { deleteCloudInstanceConfirmed } from "./cloudPendingCreates";
import { wakeThroughTransition } from "./cloudReadyClaim";
import { cloudHoldCommand, cloudReleaseHoldCommand } from "./cloudSleep";

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
/** Moving a home folder: a 730 MB lane copied in 33 s; this bounds a very large one. */
const MOVE_TRANSFER_TIMEOUT_MS = 40 * 60_000;
/** The port the old machine serves its home folder on, once, behind a short-lived signed URL. */
const MOVE_SERVE_PORT = 7338;
/** Holds on sleep (`cloudHoldCommand`); each expires on its own if ADE quits mid-way. */
const COPY_HOLD_MS = 20 * 60_000;
const MOVE_HOLD_MS = 45 * 60_000;

/** Metadata a copy must not carry: it is a new machine, not the source's ready machine or row. */
const NOT_COPIED_METADATA = new Set<string>([
  CLOUD_MACHINE_KEY_METADATA,
  CLOUD_MADE_BY_CHAT_METADATA,
  "ade_request_id",
  ...Object.values(CLOUD_READY_METADATA),
]);

function copyMetadata(source: CloudInstance, requestId: string, extra: Record<string, string>): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(source.metadata)) {
    if (!NOT_COPIED_METADATA.has(key)) metadata[key] = value;
  }
  return { ...metadata, ...extra, created_by: "ade", ade_request_id: requestId };
}

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

/**
 * Copies a cloud machine into a new one with the same files, signed in as
 * a new machine of the account. A copy that never signs in is deleted.
 */
export async function copyCloudMachine(
  deps: CloudCopyDeps,
  args: { instanceId: string; name?: string | null; shape?: CloudShapeId | null; requestId?: string; madeByChat?: string | null },
  onProgress: (progress: CloudCreateProgress) => void,
  options: { signal?: AbortSignal } = {},
): Promise<CloudCreateMachineResult & { copiedFrom: string; forkMs: number }> {
  const requestId = args.requestId ?? randomUUID();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const logger: CloudLogger = deps.logger ?? {};
  const progress = (stage: CloudCreateProgress["stage"], message: string, instanceId?: string, approvalUrl?: string) =>
    onProgress({ requestId, stage, message, ...(instanceId ? { instanceId } : {}), ...(approvalUrl ? { approvalUrl } : {}) });
  const client = await deps.client();
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
        metadata: copyMetadata(source, requestId, {
          ade_copied_from: source.id,
          ...(args.madeByChat ? { [CLOUD_MADE_BY_CHAT_METADATA]: args.madeByChat } : {}),
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

/** Serves the home folder once, gzipped, to whoever has the signed URL; then exits. */
function serveHomeCommand(port: number): string {
  const script = `
import http.server, subprocess, threading
EXCLUDE = ["./.ade", "./.docker-data", "./.cache/ms-playwright", "*/.ade/secrets/sync-site-id", "*/.ade/sock"]
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.split("?")[0] != "/home.tar.gz":
            self.send_response(404); self.end_headers(); return
        self.send_response(200)
        self.send_header("content-type", "application/gzip")
        self.end_headers()
        args = ["tar", "-C", "/home/node", "-czf", "-"] + ["--exclude=" + e for e in EXCLUDE] + ["."]
        proc = subprocess.Popen(args, stdout=subprocess.PIPE)
        for chunk in iter(lambda: proc.stdout.read(1 << 20), b""):
            self.wfile.write(chunk)
        proc.wait()
        threading.Thread(target=self.server.shutdown, daemon=True).start()
    def log_message(self, *args):
        pass
http.server.ThreadingHTTPServer(("0.0.0.0", ${port}), Handler).serve_forever()
`;
  const encoded = Buffer.from(script, "utf8").toString("base64");
  // Only the server goes to the background, every stream redirected: a
  // backgrounded list that still held the exec call's output kept the call
  // open for as long as the server ran.
  return [
    `printf %s '${encoded}' | base64 -d > /tmp/ade-move-serve.py`,
    "nohup timeout 3600 python3 /tmp/ade-move-serve.py > /tmp/ade-move-serve.log 2>&1 < /dev/null &",
    "sleep 1",
    "echo started",
  ].join("\n");
}

/**
 * Pulls the old machine's home folder into this one, in the background (a big
 * home outlasts one exec call); the exit code lands in a file. The signed URL
 * goes through a file so no shell ever re-quotes it.
 */
function receiveHomeCommand(url: string): string {
  const encoded = Buffer.from(url, "utf8").toString("base64");
  return [
    "rm -f /tmp/ade-move.exit /tmp/ade-move.log",
    `printf %s '${encoded}' | base64 -d > /tmp/ade-move.url`,
    `nohup sh -c 'curl -fsS --retry 3 "$(cat /tmp/ade-move.url)" | tar -xzf - -C /home/node; echo $? > /tmp/ade-move.exit; rm -f /tmp/ade-move.url' > /tmp/ade-move.log 2>&1 < /dev/null &`,
    "echo started",
  ].join("\n");
}

export type CloudMoveResult = CloudCreateMachineResult & {
  movedFrom: string;
  /** The projects registered on the new machine. */
  projects: string[];
  transferMs: number;
  /** False when the old box couldn't be deleted (it is asleep and kept; delete it from its card). */
  sourceDeleted: boolean;
};

/**
 * Moves a machine to the other type (box ↔ VM), keeping its work: a new
 * machine, the old one's home folder streamed into it, the old one deleted.
 * A failure before the copy landed deletes the new machine and leaves the old
 * one as it was.
 */
export async function moveCloudMachine(
  deps: CloudCopyDeps,
  args: { instanceId: string; machineKey?: string | null; to: CloudMachineKind; shape?: CloudShapeId | null; requestId?: string; madeByChat?: string | null },
  onProgress: (progress: CloudCreateProgress) => void,
  options: { signal?: AbortSignal } = {},
): Promise<CloudMoveResult> {
  if (!isCloudMachineKind(args.to)) throw new Error("Move it to a standard or a full computer.");
  const requestId = args.requestId ?? randomUUID();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const logger: CloudLogger = deps.logger ?? {};
  const progress = (stage: CloudCreateProgress["stage"], message: string, instanceId?: string, approvalUrl?: string) =>
    onProgress({ requestId, stage, message, ...(instanceId ? { instanceId } : {}), ...(approvalUrl ? { approvalUrl } : {}) });
  const client = await deps.client();
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
  const listed = await client.exec(source.id, "cd \"$HOME\" && ade projects list --json 2>/dev/null", { timeoutMs: 60_000 });
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
      ...(args.madeByChat ? { [CLOUD_MADE_BY_CHAT_METADATA]: args.madeByChat } : {}),
    },
  });

  let transferMs = 0;
  try {
    // 2. Quiet the old machine's ADE so its databases are copied whole: the
    //    entrypoint holds the brain while `brain.paused` exists.
    progress("joining", `Copying ${sourceName}'s files to the new ${cloudKindLabel(args.to)}…`, target.instanceId);
    const paused = await client.exec(source.id, [
      'touch "$ADE_HOME/brain.paused"',
      'pkill -f "serve --socket $ADE_HOME/sock/ade.sock" || true',
      "sleep 2",
      serveHomeCommand(MOVE_SERVE_PORT),
    ].join("\n"), { timeoutMs: 60_000 });
    if (!/started/.test(paused.stdout)) throw new Error("The old machine didn't start handing its files over.");
    const signed = await client.signedUrl(source.id, { port: MOVE_SERVE_PORT, ttlSeconds: 3_600 });
    const url = `${signed.url.split("?")[0]?.replace(/\/$/, "")}/home.tar.gz?${signed.url.split("?")[1] ?? ""}`;
    const started = Date.now();
    // The new machine's brain, idle during the copy, must not sleep it.
    await client.exec(target.instanceId, `${cloudHoldCommand("move", MOVE_HOLD_MS)}\n${receiveHomeCommand(url)}`, { timeoutMs: 60_000 });
    let exit: number | null = null;
    while (exit == null) {
      if (Date.now() - started > MOVE_TRANSFER_TIMEOUT_MS) throw new Error("Copying the files took too long.");
      await sleep(POLL_MS);
      const read = await client.exec(target.instanceId, "cat /tmp/ade-move.exit 2>/dev/null", { timeoutMs: 30_000 }).catch(() => null);
      const raw = read?.stdout.trim();
      if (raw) exit = Number(raw);
    }
    if (exit !== 0) {
      const why = await client.exec(target.instanceId, "tail -n 3 /tmp/ade-move.log", { timeoutMs: 30_000 }).catch(() => null);
      throw new Error(`copying the files failed (exit ${exit})${why?.stdout.trim() ? `: ${why.stdout.trim().slice(-300)}` : "."}`);
    }
    transferMs = Date.now() - started;
    logger.info?.("cloud.machine_move_copied", { sourceId: source.id, instanceId: target.instanceId, transferMs });
    // 3. Its projects, registered with the new machine's ADE.
    if (projectRoots.length) {
      // Each project's database still names the old machine as its sync host;
      // the marker hands that role to this machine on first open (the same
      // one the copied-home guard leaves; deviceRegistryService.ts).
      const add = projectRoots.map((raw) => {
        const root = raw.replace(/'/g, "");
        return `mkdir -p '${root}/.ade/secrets' && printf moved > '${root}/.ade/secrets/sync-host-copied'; ade projects add '${root}' >/dev/null 2>&1 || echo "failed ${root}"`;
      }).join("; ");
      await client.exec(target.instanceId, add, { timeoutMs: 120_000 });
    }
    // The move's work on the new machine is done: it may sleep when idle
    // again. The 45-minute time-out only covers an ADE that quit mid-move; a
    // failed move deletes the new machine, hold and all.
    await client.exec(target.instanceId, cloudReleaseHoldCommand("move"), { timeoutMs: 30_000 })
      .catch((release: unknown) => logger.warn?.("cloud.machine_move_release_failed", { instanceId: target.instanceId, error: getErrorMessage(release) }));
  } catch (error) {
    // The old machine is untouched but for the pause: let its ADE start again,
    // and take the half-made new one away.
    logger.warn?.("cloud.machine_move_failed", { sourceId: source.id, instanceId: target.instanceId, error: getErrorMessage(error) });
    // The brackets keep pkill from matching this command's own shell.
    await client.exec(source.id, 'pkill -f "python3 /tmp/ade-move-serve[.]py"; rm -f "$ADE_HOME/brain.paused"', { timeoutMs: 30_000 })
      // The entrypoint clears a pause two hours old, so a box this misses comes back on its own.
      .catch((unpause: unknown) => logger.warn?.("cloud.machine_move_unpause_failed", { sourceId: source.id, error: getErrorMessage(unpause) }));
    await deleteCloudInstanceConfirmed(client, target.instanceId, { logger, sleep });
    if (target.machineKey) {
      await deps.removeAccountMachine(target.machineKey)
        .catch((removal: unknown) => logger.warn?.("cloud.machine_move_row_left", { error: getErrorMessage(removal) }));
    }
    throw new Error(`ADE couldn't move ${sourceName}: ${getErrorMessage(error)} ${sourceName} is as it was, and the new machine was deleted.`);
  }

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
    await client.exec(source.id, 'pkill -f "python3 /tmp/ade-move-serve[.]py"; rm -f "$ADE_HOME/brain.paused"', { timeoutMs: 30_000 })
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

function readProjectRoots(stdout: string): string[] {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    const list = Array.isArray(parsed) ? parsed : (parsed as { projects?: unknown })?.projects;
    if (!Array.isArray(list)) return [];
    return list
      .map((entry) => (entry && typeof entry === "object" ? (entry as { rootPath?: unknown }).rootPath : null))
      .filter((root): root is string => typeof root === "string" && root.startsWith("/home/node/"));
  } catch {
    return [];
  }
}

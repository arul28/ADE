import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ANDROID_CODE_SYNC_ACTIONS, ANDROID_LANE_FREE_ACTIONS } from "../../desktop/src/shared/types/androidEmulator";
import {
  REMOTE_WORK_FILE_CHUNK_BYTES,
  REMOTE_WORK_FILE_MAX_BYTES,
  REMOTE_WORK_MAX_PATCH_BYTES,
  remoteWorkFileTooLargeMessage,
  type RemoteWorkFileOp,
} from "../../desktop/src/shared/types/remoteWork";
import { CliUsageError, asString, isRecord, type JsonObject } from "./cli";
import { fileSha256 } from "./services/tools/download";

/* ──────────────────────────────────────────────────────────────────────────
   THIS CHAT'S WORK COPY ON ANOTHER MACHINE — `ade shell start --machine`,
   and `ade apple … --machine` and `ade android … --machine` with no `--lane`.

   The other machine keeps a git worktree for this chat
   (desktop/src/main/services/remoteWork/remoteWorkCopyService.ts). Each call
   carries what it needs to match this checkout: the commit (which must be on
   origin), the remote branch that holds it, and, for a sync, every
   uncommitted change as one binary patch.
   ────────────────────────────────────────────────────────────────────────── */

/** How a `--machine` call readies the work copy: `--no-sync` → "none", `--discard`, or null for a sync. */
export type MachineWorkCopySync = "none" | "discard" | null;

/** What `cliMachineTargeting` reads for a call that runs in the work copy. */
export type MachineWorkCopy = { sync: MachineWorkCopySync; argv?: string[] | null };

/**
 * Apple actions about the machine, not a lane: they never need a work copy.
 * The lane-free reads match the brain's (`APPLE_LANE_FREE_ACTIONS` in adeRpcServer.ts).
 */
const APPLE_MACHINE_ACTIONS: ReadonlySet<string> = new Set([
  "getStatus", "runtimeList", "listDevices", "listLaunchTargets", "deviceList", "getStreamStatus",
]);

/**
 * A shell or terminal call bound for another machine. A chat id from here
 * means nothing there (the other machine knows this chat by the identity the
 * bridge carries), so it is dropped. A new shell that runs in the work copy
 * (`sync` set by `cliMachineTargeting`, no `--lane`) loses the lane the plan
 * defaulted to and carries the work source instead.
 */
export function withRemoteShellArgs(params: JsonObject, cwd: string, workCopy: MachineWorkCopy | null): JsonObject {
  const toolArgs = isRecord(params.arguments) ? params.arguments : {};
  const { chatSessionId: _chatSessionId, ...args } = isRecord(toolArgs.args) ? toolArgs.args : {};
  let nextArgs: JsonObject = args;
  if (workCopy && toolArgs.domain === "pty" && toolArgs.action === "create") {
    const { laneId: _defaultLane, ...rest } = args;
    nextArgs = {
      ...rest,
      remoteWork: {
        ...(workCopy.sync === "none" ? readLocalHead(cwd) : readLocalWorkSource(cwd)),
        ...(workCopy.sync ? { sync: workCopy.sync } : {}),
        ...(workCopy.argv?.length ? { argv: workCopy.argv } : {}),
        // A command there ends its shell, so the next command can sync.
        ...(asString(args.startupCommand) ? { exitWhenDone: true } : {}),
      },
    };
  }
  return { ...params, arguments: { ...toolArgs, args: nextArgs } };
}

/**
 * `ade apple … --machine` with no `--lane`: the simulator there works for
 * this chat's work copy. A build syncs it to this checkout; any other verb
 * uses it as it is (and makes it at this commit when it does not exist yet).
 */
export function withRemoteAppleArgs(params: JsonObject, cwd: string, workCopy: MachineWorkCopy | null): JsonObject {
  const toolArgs = isRecord(params.arguments) ? params.arguments : {};
  if (!isRecord(toolArgs.args) || asString(toolArgs.args.laneId)) return params;
  const action = asString(toolArgs.action) ?? "";
  if (APPLE_MACHINE_ACTIONS.has(action)) return params;
  const sync = workCopy?.sync ?? null;
  const { chatSessionId: _chatSessionId, ...args } = toolArgs.args;
  // Only a build verb (launch, install, test) gets `workCopy` from cliMachineTargeting.
  const builds = workCopy != null && sync !== "none";
  return {
    ...params,
    arguments: {
      ...toolArgs,
      args: {
        ...args,
        remoteWork: builds
          ? { ...readLocalWorkSource(cwd), ...(sync ? { sync } : {}) }
          : { ...readLocalHead(cwd), sync: "none" },
      },
    },
  };
}

/**
 * Android reads about the machine. They never make a work copy: the other
 * machine reports this chat's emulator only when the copy already exists.
 */
const ANDROID_MACHINE_ACTIONS: ReadonlySet<string> = new Set(ANDROID_LANE_FREE_ACTIONS);
const ANDROID_CODE_SYNC: ReadonlySet<string> = new Set(ANDROID_CODE_SYNC_ACTIONS);

/**
 * `ade android … --machine` with no `--lane`: the emulator there works for
 * this chat's work copy. An install or launch that builds (`--gradle`) or
 * reads an APK (`--apk`, a path inside this checkout) syncs the copy to this
 * checkout first, as an Apple build does; every other verb uses the copy as it
 * is, and makes it at this commit when it does not exist yet. A status or
 * device list sends no commit and makes no copy. The chat id is the other
 * machine's to set, from the caller's identity.
 */
export function withRemoteAndroidArgs(params: JsonObject, cwd: string): JsonObject {
  const toolArgs = isRecord(params.arguments) ? params.arguments : {};
  if (!isRecord(toolArgs.args) || asString(toolArgs.args.laneId)) return params;
  const action = asString(toolArgs.action) ?? "";
  const { chatSessionId: _chatSessionId, ...args } = toolArgs.args;
  const builds = ANDROID_CODE_SYNC.has(action) && (asString(args.apkPath) != null || args.gradle != null);
  const apkPath = builds ? asString(args.apkPath) : null;
  return {
    ...params,
    arguments: {
      ...toolArgs,
      args: {
        ...args,
        ...(apkPath ? { apkPath: remoteApkPath(apkPath, cwd) } : {}),
        remoteWork: ANDROID_MACHINE_ACTIONS.has(action)
          ? { sync: "none" }
          : builds
            ? readLocalWorkSource(cwd)
            : { ...readLocalHead(cwd), sync: "none" },
      },
    },
  };
}

/**
 * `--apk` with `--machine`: the path inside this checkout, relative to its
 * top, which the other machine resolves inside the chat's work copy. The APK
 * travels in the uncommitted-changes patch, so one git ignores (most build
 * output) is refused here with the way that works.
 */
function remoteApkPath(apkPath: string, cwd: string): string {
  const { top } = localCheckout(cwd);
  // git names the top by its real path (macOS `/tmp` is `/private/tmp`).
  const typed = path.resolve(cwd, apkPath);
  if (!fs.existsSync(typed)) throw new CliUsageError(`--apk ${apkPath}: no such file here.`);
  const relative = path.relative(fs.realpathSync.native(top), fs.realpathSync.native(typed));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new CliUsageError(`--apk ${apkPath} is outside this checkout (${top}), so it cannot go to the other machine.`);
  }
  const ignored = spawnSync("git", ["check-ignore", "-q", "--", relative], { cwd: top, windowsHide: true });
  if (ignored.status === 0) {
    throw new CliUsageError(
      `--apk ${apkPath} is ignored by git, so it does not travel to the other machine. Pass --gradle to build the app there.`,
    );
  }
  return relative.split(path.sep).join("/");
}

function patchTooLargeError(): CliUsageError {
  return new CliUsageError(
    `The uncommitted changes are over ${REMOTE_WORK_MAX_PATCH_BYTES / (1024 * 1024)} MiB. Commit and push them, then run the command again.`,
  );
}

function gitHere(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Buffer {
  const result = spawnSync("git", args, {
    cwd,
    maxBuffer: REMOTE_WORK_MAX_PATCH_BYTES * 2,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...(env ?? {}) },
    windowsHide: true,
  });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS") {
    throw patchTooLargeError();
  }
  if (result.error || result.status !== 0) {
    const detail = (result.stderr?.toString("utf8") || result.error?.message || "").trim().split("\n").slice(-2).join(" ");
    throw new CliUsageError(`git ${args[0]} failed in ${cwd}${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

const gitText = (cwd: string, args: string[]): string => gitHere(cwd, args).toString("utf8").trim();

function localCheckout(cwd: string): { top: string; head: string; branch: string | null } {
  const top = gitText(cwd, ["rev-parse", "--show-toplevel"]);
  const branch = gitText(top, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return { top, head: gitText(top, ["rev-parse", "HEAD"]), branch: branch === "HEAD" ? null : branch };
}

/** The commit and branch of this checkout: enough to make a missing copy there. No index read, no diff. */
export function readLocalHead(cwd: string): JsonObject {
  const { head, branch } = localCheckout(cwd);
  return { head, fetchRef: branch, branch };
}

/**
 * What the other machine needs to reproduce this checkout: the commit (which
 * must be on origin), the remote branch that holds it, and every uncommitted
 * change as one binary patch, untracked files included, as bytes (base64).
 * The checkout's own index is never touched: the patch is staged in a copy of
 * it, and the diff ignores the user's diff settings so it always applies.
 */
function readLocalWorkSource(cwd: string): JsonObject {
  const { top, head, branch } = localCheckout(cwd);
  const remoteRefs = gitText(top, ["branch", "-r", "--contains", "HEAD", "--format=%(refname:short)"])
    .split("\n").map((line) => line.trim()).filter((line) => line.startsWith("origin/") && line !== "origin/HEAD");
  if (!remoteRefs.length) {
    throw new CliUsageError(
      `Commit ${head.slice(0, 12)} is not on origin yet, so the other machine cannot check it out. `
      + "Push it first (git push); uncommitted changes travel by themselves.",
    );
  }
  const fetchRef = (remoteRefs.find((ref) => ref === `origin/${branch}`) ?? remoteRefs[0]!).slice("origin/".length);
  const indexPath = gitText(top, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  const tempIndex = path.join(os.tmpdir(), `ade-work-patch-${randomUUID()}`);
  let patch: Buffer;
  try {
    try {
      fs.copyFileSync(indexPath, tempIndex);
    } catch {
      // No index yet; git builds one.
    }
    const env = { GIT_INDEX_FILE: tempIndex };
    gitHere(top, ["add", "-A"], env);
    patch = gitHere(top, [
      "diff", "--cached", "--binary", "--no-ext-diff", "--no-color", "--no-textconv",
      "--src-prefix=a/", "--dst-prefix=b/", "HEAD",
    ], env);
  } finally {
    fs.rmSync(tempIndex, { force: true });
  }
  if (patch.length > REMOTE_WORK_MAX_PATCH_BYTES) {
    throw patchTooLargeError();
  }
  return { head, fetchRef, branch, ...(patch.length ? { patchBase64: patch.toString("base64") } : {}) };
}

/* ──────────────────────────────────────────────────────────────────────────
   `ade files push|pull --machine <name>`: one file into or out of this chat's
   work copy there, in chunks over the machine link (the host side is
   desktop/src/main/services/remoteWork/remoteWorkFiles.ts). Both ends check
   the sha256, and a file lands under its name only once it is whole.
   ────────────────────────────────────────────────────────────────────────── */

/** One `work_copy_file` step on the other machine, its tool result unwrapped. */
export type WorkCopyFileCall = (args: JsonObject & { op: RemoteWorkFileOp }) => Promise<unknown>;

export type WorkCopyFileResult = {
  direction: "push" | "pull";
  localPath: string;
  remotePath: string;
  bytes: number;
  sha256: string;
};

const fileTooLarge = (file: string, bytes: number): CliUsageError => new CliUsageError(remoteWorkFileTooLargeMessage(bytes, file));

function answerRecord(value: unknown, step: string): JsonObject {
  if (!isRecord(value)) throw new Error(`The other machine gave no answer to ${step}.`);
  return value;
}

/** A remote path that ends in a separator names a folder there: the file keeps its name. */
function remoteTargetPath(remotePath: string, localPath: string): string {
  return /[\\/]$/.test(remotePath) ? `${remotePath}${path.basename(localPath)}` : remotePath;
}

export async function pushFileToWorkCopy(
  call: WorkCopyFileCall,
  input: { localPath: string; remotePath: string; checkout: string },
): Promise<WorkCopyFileResult> {
  const localPath = path.resolve(input.localPath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(localPath);
  } catch {
    throw new CliUsageError(`${localPath} does not exist here.`);
  }
  if (!stat.isFile()) throw new CliUsageError(`${localPath} is not a file. ade files push copies one file; pack a folder first (tar or zip).`);
  if (stat.size > REMOTE_WORK_FILE_MAX_BYTES) throw fileTooLarge(localPath, stat.size);
  const sha256 = await fileSha256(localPath);
  const begun = answerRecord(await call({
    op: "push_begin",
    path: remoteTargetPath(input.remotePath, localPath),
    size: stat.size,
    sha256,
    // Enough to make the copy there when this chat has none yet.
    remoteWork: readLocalHead(input.checkout),
  }), "push_begin");
  const transferId = asString(begun.transferId);
  if (!transferId) throw new Error("The other machine did not open the push.");
  const chunkBytes = Math.min(
    REMOTE_WORK_FILE_CHUNK_BYTES,
    typeof begun.chunkBytes === "number" && begun.chunkBytes > 0 ? begun.chunkBytes : REMOTE_WORK_FILE_CHUNK_BYTES,
  );
  const fd = fs.openSync(localPath, "r");
  try {
    const buffer = Buffer.alloc(chunkBytes);
    let offset = 0;
    while (offset < stat.size) {
      const length = fs.readSync(fd, buffer, 0, Math.min(chunkBytes, stat.size - offset), offset);
      if (length <= 0) throw new CliUsageError(`${localPath} got shorter while it was sent; run the push again.`);
      await call({ op: "push_chunk", transferId, offset, dataBase64: buffer.subarray(0, length).toString("base64") });
      offset += length;
    }
    const committed = answerRecord(await call({ op: "push_commit", transferId }), "push_commit");
    // The other end checked the bytes against `sha256`; a file that changed
    // here while it was read fails there with both hashes named.
    return {
      direction: "push",
      localPath,
      remotePath: asString(committed.path) ?? input.remotePath,
      bytes: typeof committed.bytes === "number" ? committed.bytes : stat.size,
      sha256: asString(committed.sha256) ?? sha256,
    };
  } catch (error) {
    // Best effort: the other machine also drops a push idle for 10 minutes.
    await call({ op: "push_abort", transferId }).catch(() => undefined);
    throw error;
  } finally {
    fs.closeSync(fd);
  }
}

export async function pullFileFromWorkCopy(
  call: WorkCopyFileCall,
  input: { remotePath: string; localPath: string },
): Promise<WorkCopyFileResult> {
  const stat = answerRecord(await call({ op: "pull_stat", path: input.remotePath }), "pull_stat");
  const size = typeof stat.size === "number" ? stat.size : -1;
  const sha256 = asString(stat.sha256) ?? "";
  const remotePath = asString(stat.path) ?? input.remotePath;
  if (size < 0 || !sha256) throw new Error("The other machine did not say how big the file is.");
  if (size > REMOTE_WORK_FILE_MAX_BYTES) throw fileTooLarge(remotePath, size);
  let localPath = path.resolve(input.localPath);
  const remoteName = path.basename(remotePath.replace(/\\/g, "/"));
  if (/[\\/]$/.test(input.localPath) || (fs.existsSync(localPath) && fs.statSync(localPath).isDirectory())) {
    localPath = path.join(localPath, remoteName);
  }
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  // Next to the target, so the rename at the end stays on one disk.
  const tempPath = path.join(path.dirname(localPath), `.${path.basename(localPath)}.ade-pull-${randomUUID()}.part`);
  const fd = fs.openSync(tempPath, "wx");
  let closed = false;
  try {
    const hash = createHash("sha256");
    let offset = 0;
    while (offset < size) {
      const chunk = answerRecord(await call({ op: "pull_chunk", path: input.remotePath, offset }), "pull_chunk");
      if (chunk.size !== size) throw new CliUsageError(`${remotePath} changed there while it was copied; run the pull again.`);
      if (chunk.offset !== offset || typeof chunk.dataBase64 !== "string") throw new Error(`The other machine did not return ${remotePath} at byte ${offset}.`);
      const bytes = Buffer.from(chunk.dataBase64, "base64");
      if (!bytes.length || offset + bytes.length > size) throw new Error(`The other machine returned ${remotePath} with the wrong length.`);
      fs.writeSync(fd, bytes, 0, bytes.length, offset);
      hash.update(bytes);
      offset += bytes.length;
    }
    fs.closeSync(fd);
    closed = true;
    const got = hash.digest("hex");
    if (got !== sha256) {
      throw new CliUsageError(`${remotePath} arrived with sha256 ${got}, not ${sha256} (it changed there while it was copied?); nothing was written. Run the pull again.`);
    }
    fs.renameSync(tempPath, localPath);
    return { direction: "pull", localPath, remotePath, bytes: size, sha256 };
  } catch (error) {
    if (!closed) fs.closeSync(fd);
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

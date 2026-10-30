import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REMOTE_WORK_MAX_PATCH_BYTES } from "../../desktop/src/shared/types/remoteWork";
import { CliUsageError, asString, isRecord, type JsonObject } from "./cli";

/* ──────────────────────────────────────────────────────────────────────────
   THIS CHAT'S WORK COPY ON ANOTHER MACHINE — `ade shell start --machine`,
   and `ade apple … --machine` with no `--lane`.

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
function readLocalHead(cwd: string): JsonObject {
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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserWindow, dialog, ipcMain } from "electron";
import type { CloudLaneBackup } from "../../../../../account-directory/src/cloud/contract";
import type { CloudApiClient } from "../../../shared/cloudApiClient";
import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import { AdeExpectedError } from "../../../shared/expectedError";
import { ensureBundleBase } from "../chat/handoffGitBundle";
import { IPC } from "../../../shared/ipc";
import { runGit } from "../git/git";
import { isTrustedAdeRendererSenderOrWarn } from "../ipc/trustedRendererSender";
import { readGitOriginUrl } from "../projects/recentProjectSummary";

/**
 * "Get this lane's work" on the desktop (`laneBackups.ts`): the account's
 * lane backups, read with no wake and no hours. Account level, by the
 * backup's machine key and lane id: no pin.
 *
 * - `cloudLaneBackups` lists them.
 * - `cloudLaneBackupSavePatch` saves the patch where the person picks.
 * - `cloudLaneBackupForget` deletes one for good (the server refuses while a
 *   computer still holds its machine key).
 * - `cloudLaneBackupToBranch` puts the work on a NEW branch in a clone of
 *   the repository on THIS computer (the snapshot of the uncommitted work is
 *   its last commit). It never moves a branch that exists, never touches a
 *   working tree, and never pushes; the renderer then makes a lane of it.
 */

const SHA = /^[0-9a-f]{40,64}$/;
const ID = /^[A-Za-z0-9._:-]{1,160}$/;

function idArg(value: unknown, what: string): string {
  if (typeof value !== "string" || !ID.test(value.trim())) throw new AdeExpectedError(`ADE doesn't know that ${what}.`, "user");
  return value.trim();
}

async function readBackup(api: CloudApiClient, machineKey: string, laneId: string): Promise<CloudLaneBackup> {
  const backup = await api.laneBackup(machineKey, laneId);
  if (!backup) throw new AdeExpectedError("ADE Cloud has no saved work for that lane any more.", "user");
  return backup;
}

async function readAll(api: CloudApiClient, backup: CloudLaneBackup, kind: "bundle" | "patch"): Promise<Buffer> {
  const parts = kind === "bundle" ? backup.bundleParts : backup.patchParts;
  const chunks: Buffer[] = [];
  for (let part = 1; part <= parts; part += 1) chunks.push(Buffer.from(await api.readLaneBackupPart(backup.machineKey, backup.laneId, kind, part)));
  const bytes = Buffer.concat(chunks);
  if (bytes.byteLength !== (kind === "bundle" ? backup.bundleBytes : backup.patchBytes)) throw new Error("This lane's saved work arrived damaged. Try again.");
  return bytes;
}

/** `ade-saved/<branch or lane>-<date>`, made unique in the repository. */
async function freeBranchName(cwd: string, backup: CloudLaneBackup): Promise<string> {
  const stem = (backup.branchRef ?? backup.laneName ?? "lane").replace(/[^A-Za-z0-9._/-]+/g, "-").replace(/^[-/.]+|[-/.]+$/g, "").slice(0, 80) || "lane";
  const day = new Date(backup.savedAt).toISOString().slice(0, 10);
  for (let index = 0; index < 50; index += 1) {
    const name = `ade-saved/${stem}-${day}${index ? `-${index + 1}` : ""}`;
    const taken = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], { cwd, timeoutMs: 10_000 });
    if (taken.exitCode !== 0) return name;
  }
  throw new Error("ADE couldn't find a free branch name for the saved work.");
}

export async function laneBackupToBranch(api: CloudApiClient, args: { machineKey: string; laneId: string; projectRoot: string }): Promise<{ branch: string }> {
  const backup = await readBackup(api, args.machineKey, args.laneId);
  const head = backup.snapshotSha ?? backup.headSha;
  if (!SHA.test(head)) throw new Error("This lane's saved work names an invalid commit.");
  const root = args.projectRoot;
  if (!root || !path.isAbsolute(root) || !fs.existsSync(path.join(root, ".git"))) {
    throw new AdeExpectedError("Open a clone of this lane's repository on this computer, then get its work there.", "user");
  }
  const here = normalizeGitRemoteIdentity(readGitOriginUrl(root));
  if (backup.projectKey && here !== backup.projectKey) {
    throw new AdeExpectedError(`This project isn't ${backup.projectKey}. Open a clone of it on this computer, then get the lane's work there.`, "user");
  }
  const bundle = await readAll(api, backup, "bundle");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-saved-work-"));
  try {
    const bundlePath = path.join(tempDir, "lane.bundle");
    fs.writeFileSync(bundlePath, bundle);
    // A hook-free git (an empty hooks folder, on every OS) for every call that takes in the saved work.
    const noHooks = path.join(tempDir, "no-hooks");
    fs.mkdirSync(noHooks);
    const hardening = ["-c", `core.hooksPath=${noHooks}`, "-c", "submodule.recurse=false", "-c", "fetch.recurseSubmodules=false"];
    // The work builds on commits GitHub has; fetch them when they are missing here.
    if (!(await ensureBundleBase({ cwd: root, bundlePath, content: bundle, gitPrefix: hardening }))) {
      throw new AdeExpectedError("This clone lacks the commits the saved work builds on, even after a fetch from GitHub.", "user");
    }
    const listed = await runGit(["bundle", "list-heads", bundlePath], { cwd: root, timeoutMs: 30_000 });
    const heads = listed.stdout.split(/\r?\n/).map((line) => line.trim().split(/\s+/)).filter((parts) => parts.length === 2);
    if (heads.length !== 1 || heads[0]![0] !== head) throw new Error("This lane's saved work doesn't match its record.");
    const branch = await freeBranchName(root, backup);
    // Into a new branch only: nothing that exists moves, no working tree changes.
    const fetched = await runGit([...hardening, "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", bundlePath, `${heads[0]![1]}:refs/heads/${branch}`], { cwd: root, timeoutMs: 120_000 });
    if (fetched.exitCode !== 0) throw new Error(fetched.stderr.trim() || "ADE couldn't put the saved work on a branch.");
    return { branch };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

type Logger = { info: (event: string, meta?: Record<string, unknown>) => void; warn: (event: string, meta?: Record<string, unknown>) => void };

export function registerCloudLaneBackupIpc(args: { accountApi: () => CloudApiClient; logger: Logger }): void {
  const { logger } = args;
  ipcMain.handle(IPC.cloudLaneBackups, async (event, arg?: { laneId?: unknown }): Promise<CloudLaneBackup[]> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudLaneBackups)) return [];
    const laneId = arg?.laneId == null ? null : idArg(arg.laneId, "lane");
    return await args.accountApi().laneBackups(laneId);
  });
  ipcMain.handle(IPC.cloudLaneBackupSavePatch, async (event, arg?: { machineKey?: unknown; laneId?: unknown }): Promise<{ savedTo: string | null }> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudLaneBackupSavePatch)) return { savedTo: null };
    const api = args.accountApi();
    const backup = await readBackup(api, idArg(arg?.machineKey, "computer"), idArg(arg?.laneId, "lane"));
    if (!backup.patchParts) throw new AdeExpectedError("This lane's saved work has no patch to download.", "user");
    const window = BrowserWindow.fromWebContents(event.sender);
    const name = `${(backup.laneName ?? backup.branchRef ?? "lane").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60)}-saved-work.patch`;
    const options = { title: "Save the lane's work", defaultPath: name, filters: [{ name: "Patch", extensions: ["patch"] }] };
    const picked = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (picked.canceled || !picked.filePath) return { savedTo: null };
    fs.writeFileSync(picked.filePath, await readAll(api, backup, "patch"));
    logger.info("cloud.lane_backup_patch_saved", { bytes: backup.patchBytes });
    return { savedTo: picked.filePath };
  });
  ipcMain.handle(IPC.cloudLaneBackupToBranch, async (event, arg?: { machineKey?: unknown; laneId?: unknown; projectRoot?: unknown }): Promise<{ branch: string }> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudLaneBackupToBranch)) throw new Error("ADE can't do that from here.");
    const projectRoot = typeof arg?.projectRoot === "string" ? arg.projectRoot : "";
    const made = await laneBackupToBranch(args.accountApi(), { machineKey: idArg(arg?.machineKey, "computer"), laneId: idArg(arg?.laneId, "lane"), projectRoot });
    logger.info("cloud.lane_backup_to_branch", {});
    return made;
  });
  ipcMain.handle(IPC.cloudLaneBackupForget, async (event, arg?: { machineKey?: unknown; laneId?: unknown }): Promise<{ deleted: number }> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudLaneBackupForget)) throw new Error("ADE can't do that from here.");
    const deleted = await args.accountApi().forgetLaneBackup(idArg(arg?.machineKey, "computer"), idArg(arg?.laneId, "lane"));
    logger.info("cloud.lane_backup_forgot", {});
    return deleted;
  });
  // A kept lane moved to a machine runs in that project's brain (`cloud.restoreKeptLane`,
  // reached through the destination's pin). A call lands here only with no project runtime,
  // and the move needs the lane's project open there.
  const needsProject = (channel: string) => async (event: Electron.IpcMainInvokeEvent): Promise<never> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, channel)) throw new Error("ADE can't do that from here.");
    throw new AdeExpectedError("Open the lane's project on this computer, then move the lane there.", "user");
  };
  ipcMain.handle(IPC.cloudPreviewKeptLaneRestore, needsProject(IPC.cloudPreviewKeptLaneRestore));
  ipcMain.handle(IPC.cloudRestoreKeptLane, needsProject(IPC.cloudRestoreKeptLane));
  ipcMain.handle(IPC.cloudGetKeptLaneRestore, needsProject(IPC.cloudGetKeptLaneRestore));
}

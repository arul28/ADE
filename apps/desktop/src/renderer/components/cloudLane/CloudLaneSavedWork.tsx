import { useEffect, useState, useSyncExternalStore } from "react";
import { ClockCounterClockwise, DownloadSimple, GitBranch, Trash } from "@phosphor-icons/react";
import type { CloudLaneBackup } from "../../../../../account-directory/src/cloud/contract";
import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import { fetchAccountStatus, subscribeAccountStatus } from "../../lib/account";
import { ipcErrorMessage } from "../../lib/format";
import { useAppStore } from "../../state/appStore";
import { showToast } from "../app/toast/toastStore";
import { MachineActionsMenu } from "../remoteTargets/MachineActionsMenu";
import { cn } from "../ui/cn";
import { confirmDialog } from "../ui/dialog";
import "./cloudLane.css";

/**
 * "Get this lane's work": the lane's work that wasn't on GitHub when its
 * computer last rested, saved by ADE Cloud (`laneBackups.ts`). It reads with
 * no wake and no hours, so it works at 0 hours and after a cleanup.
 *
 * - Download patch: everywhere (the desktop saves it, the web downloads it).
 * - Open in a new lane here: the desktop only, in a clone of the same
 *   repository on this computer. The work lands on a new branch
 *   (`ade-saved/...`), the uncommitted part as its last commit, in a new
 *   lane; nothing is pushed and no other branch moves.
 *
 * `CloudLaneSavedWork` shows one lane's (a lane without a computer, a
 * computer that can't wake). `CloudSavedLaneWorkCard` (Settings › ADE Cloud)
 * shows the saved work no lane row on that page shows, such as a deleted
 * project's, with Delete in its ⋯ menu. Every line and the card share one
 * read of the account's list (`useLaneBackups`), never a poll. Nothing shows
 * when there is no saved work.
 */

/** The account's saved lane work, read once for every line on screen, for the account that read it. */
type BackupsSnapshot = { list: readonly CloudLaneBackup[]; at: number; userId: string | null } | null;
/** A read this recent serves a line that mounts now; a newer mount after it reads again. */
const BACKUPS_FRESH_MS = 30_000;
let backupsSnapshot: BackupsSnapshot = null;
let backupsReading: Promise<void> | null = null;
/** Goes up when the signed-in account changes: a read from before is dropped. */
let backupsGeneration = 0;
let accountWatched = false;
const backupsListeners = new Set<() => void>();

function setBackups(next: BackupsSnapshot): void {
  backupsSnapshot = next;
  for (const listener of backupsListeners) listener();
}

/** Another account (or none) signed in: the old account's lanes and branches go at once. */
function noteAccount(userId: string | null): void {
  if (!backupsSnapshot && !backupsReading) return;
  if (backupsSnapshot && backupsSnapshot.userId === userId) return;
  backupsGeneration += 1;
  backupsReading = null;
  setBackups(null);
  if (userId && backupsListeners.size) readBackupsIfStale();
}

function readBackupsIfStale(): void {
  const read = window.ade?.cloud?.laneBackups;
  if (!read || backupsReading || (backupsSnapshot && Date.now() - backupsSnapshot.at < BACKUPS_FRESH_MS)) return;
  const generation = backupsGeneration;
  const reading: Promise<void> = fetchAccountStatus().then(async (status) => {
    const userId = status.userId ?? null;
    if (generation !== backupsGeneration) return;
    if (backupsSnapshot && backupsSnapshot.userId !== userId) setBackups(null);
    const list = await read(null).catch(() => null);
    if (generation !== backupsGeneration) return;
    // Not readable now: show nothing new; the next mount tries again.
    if (list) setBackups({ list, at: Date.now(), userId });
    else if (backupsSnapshot) setBackups({ ...backupsSnapshot, at: 0 });
  }).finally(() => {
    if (backupsReading === reading) backupsReading = null;
  });
  backupsReading = reading;
}

function subscribeBackups(listener: () => void): () => void {
  if (!accountWatched) {
    accountWatched = true;
    subscribeAccountStatus((status) => noteAccount(status.userId ?? null));
  }
  backupsListeners.add(listener);
  return () => {
    backupsListeners.delete(listener);
  };
}
const backupsNow = () => backupsSnapshot;

/** The account's saved lane work (the newest per lane), shared by every caller; reads when it is older than 30 s. */
function useLaneBackups(): readonly CloudLaneBackup[] {
  const snapshot = useSyncExternalStore(subscribeBackups, backupsNow, backupsNow);
  useEffect(readBackupsIfStale, []);
  return snapshot?.list ?? [];
}

function dropBackup(backup: CloudLaneBackup): void {
  if (!backupsSnapshot) return;
  setBackups({ ...backupsSnapshot, list: backupsSnapshot.list.filter((entry) => !(entry.machineKey === backup.machineKey && entry.laneId === backup.laneId)) });
}

export function savedWorkSentence(backup: CloudLaneBackup): string {
  const parts: string[] = [];
  if (backup.commits > 0) parts.push(`${backup.commits} ${backup.commits === 1 ? "commit" : "commits"}`);
  if (backup.snapshotSha) parts.push(backup.files > 0 ? `${backup.files} uncommitted ${backup.files === 1 ? "file" : "files"}` : "uncommitted changes");
  return parts.join(" and ") || "its changes";
}

function savedWhen(backup: CloudLaneBackup): string {
  return new Date(backup.savedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

type SavedWorkBusy = "patch" | "lane" | "delete" | null;

/** The actions on one saved work, shared by the lane row and the account card. */
function useSavedWorkActions(backup: CloudLaneBackup, name: string) {
  const [busy, setBusy] = useState<SavedWorkBusy>(null);
  const binding = useAppStore((state) => state.projectBinding);
  const cloud = window.ade?.cloud;
  // Only a clone of the same repository on this computer can take the work as a lane.
  const here = binding?.kind === "local" ? normalizeGitRemoteIdentity(binding.gitOriginUrl ?? null) : null;
  const canOpenHere = Boolean(cloud?.laneBackupToBranch && binding?.kind === "local" && (!backup.projectKey || here === backup.projectKey));
  const canDownload = Boolean(cloud?.saveLaneBackupPatch && backup.patchParts > 0);

  const run = async (what: Exclude<SavedWorkBusy, null>, work: () => Promise<void>, failTitle: string) => {
    setBusy(what);
    try {
      await work();
    } catch (error) {
      showToast({ tone: "error", title: failTitle, message: ipcErrorMessage(error) || "Try again in a moment." });
    } finally {
      setBusy(null);
    }
  };

  const download = () => run("patch", async () => {
    const saved = await cloud!.saveLaneBackupPatch!(backup.machineKey, backup.laneId);
    if (saved.savedTo) showToast({ tone: "success", title: `Saved ${name}'s work`, message: "Apply it in a clone of the repository with git apply." });
  }, `Couldn't download ${name}'s work`);

  const openHere = () => run("lane", async () => {
    if (binding?.kind !== "local") return;
    const { branch } = await cloud!.laneBackupToBranch!(backup.machineKey, backup.laneId, binding.rootPath);
    await window.ade.lanes.importBranch({ branchRef: branch, name: `${name} (saved work)`, publishUpstream: false }, binding);
    showToast({ tone: "success", title: `Opened ${name}'s work in a new lane`, message: `It is on the branch ${branch}, on this computer only. Its uncommitted changes are its last commit.` });
  }, `Couldn't open ${name}'s work here`);

  const forget = async (): Promise<void> => {
    if (!cloud?.forgetLaneBackup) return;
    const ok = await confirmDialog({
      title: `Delete ${name}'s saved work?`,
      message: "ADE Cloud deletes its only copy of this lane's work that isn't on GitHub. Download the patch first if you might need it.",
      confirmLabel: "Delete saved work",
      destructive: true,
    });
    if (!ok) return;
    await run("delete", async () => {
      await cloud.forgetLaneBackup!(backup.machineKey, backup.laneId);
      dropBackup(backup);
      showToast({ tone: "success", title: `Deleted ${name}'s saved work` });
    }, `Couldn't delete ${name}'s saved work`);
  };

  return { busy, canOpenHere, canDownload, canForget: Boolean(cloud?.forgetLaneBackup), download, openHere, forget };
}

function SavedWorkButtons({ actions }: { actions: ReturnType<typeof useSavedWorkActions> }) {
  return (
    <>
      {actions.canDownload ? (
        <button type="button" className="kit-btn kit-btn-ghost" data-size="xs" disabled={actions.busy != null} onClick={() => void actions.download()}>
          <DownloadSimple size={11} />
          {actions.busy === "patch" ? "Downloading…" : "Download patch"}
        </button>
      ) : null}
      {actions.canOpenHere ? (
        <button type="button" className="kit-btn kit-btn-ghost" data-size="xs" disabled={actions.busy != null} onClick={() => void actions.openHere()}>
          <GitBranch size={11} />
          {actions.busy === "lane" ? "Opening…" : "Open in a new lane here"}
        </button>
      ) : null}
    </>
  );
}

/** The newest backup of each lane, newest first. */
function newestPerLane(list: readonly CloudLaneBackup[]): CloudLaneBackup[] {
  const byLane = new Map<string, CloudLaneBackup>();
  for (const entry of list) {
    const held = byLane.get(entry.laneId);
    if (!held || entry.savedAt > held.savedAt) byLane.set(entry.laneId, entry);
  }
  return [...byLane.values()].sort((a, b) => b.savedAt - a.savedAt);
}

export function CloudLaneSavedWork({ laneId, laneName, className }: { laneId: string; laneName?: string | null; className?: string }) {
  const backup = newestPerLane(useLaneBackups().filter((entry) => entry.laneId === laneId))[0] ?? null;
  if (!backup) return null;
  return <LaneSavedWorkLine backup={backup} name={laneName ?? backup.laneName ?? "this lane"} className={className} />;
}

function LaneSavedWorkLine({ backup, name, className }: { backup: CloudLaneBackup; name: string; className?: string }) {
  const actions = useSavedWorkActions(backup, name);
  return (
    <div className={cn("adecl-saved-work", className)} data-cloud-lane-saved-work={backup.laneId}>
      <span className="adecl-muted">ADE Cloud saved this lane's work that isn't on GitHub ({savedWorkSentence(backup)}) on {savedWhen(backup)}.</span>
      <div className="adecl-nocomp-actions">
        <SavedWorkButtons actions={actions} />
      </div>
    </div>
  );
}

/**
 * Settings › ADE Cloud: saved lane work that no lane row on the page shows
 * (`shownLaneIds`), such as the lanes of a project whose computers were
 * deleted. Hidden when there is none.
 */
export function CloudSavedLaneWorkCard({ shownLaneIds }: { shownLaneIds: ReadonlySet<string> }) {
  const rows = newestPerLane(useLaneBackups()).filter((backup) => !shownLaneIds.has(backup.laneId));
  if (rows.length === 0) return null;
  return (
    <section className="kit-card adecd-card" aria-label="Saved lane work" data-cloud-saved-lane-work>
      <header className="kit-card-head">
        <ClockCounterClockwise size={14} />
        Saved lane work
        <span className="kit-card-head-count">{rows.length}</span>
        <span className="adecd-head-note">Work that wasn't on GitHub when ADE deleted its computer</span>
      </header>
      <div className="kit-card-body" data-flush="true">
        {rows.map((backup) => (
          <SavedWorkRow key={`${backup.machineKey}/${backup.laneId}`} backup={backup} />
        ))}
      </div>
    </section>
  );
}

function SavedWorkRow({ backup }: { backup: CloudLaneBackup }) {
  const name = backup.laneName ?? backup.branchRef ?? "Lane";
  const actions = useSavedWorkActions(backup, name);
  return (
    <div className="adecl-saved-row" data-cloud-lane-saved-work={backup.laneId}>
      <div className="adecl-saved-row-text">
        <span className="adecl-saved-row-name">{name}</span>
        <span className="adecl-muted">
          {[backup.projectKey, backup.branchRef && backup.branchRef !== name ? backup.branchRef : null].filter(Boolean).join(" · ")}
          {backup.projectKey || (backup.branchRef && backup.branchRef !== name) ? " · " : ""}
          {savedWorkSentence(backup)}, saved {savedWhen(backup)}
        </span>
      </div>
      <div className="adecl-nocomp-actions">
        <SavedWorkButtons actions={actions} />
        {actions.canForget ? (
          <MachineActionsMenu
            label={`More for ${name}'s saved work`}
            actions={[{
              key: "delete",
              label: "Delete saved work",
              icon: <Trash size={14} />,
              danger: true,
              disabled: actions.busy != null,
              onSelect: () => void actions.forget(),
            }]}
          />
        ) : null}
      </div>
    </div>
  );
}

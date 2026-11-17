import { useEffect, useState } from "react";
import { DownloadSimple, GitBranch } from "@phosphor-icons/react";
import type { CloudLaneBackup } from "../../../../../account-directory/src/cloud/contract";
import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import { ipcErrorMessage } from "../../lib/format";
import { useAppStore } from "../../state/appStore";
import { showToast } from "../app/toast/toastStore";
import { cn } from "../ui/cn";
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
 * One read when it shows, never a poll. Nothing shows when there is no
 * saved work.
 */

function savedWorkSentence(backup: CloudLaneBackup): string {
  const parts: string[] = [];
  if (backup.commits > 0) parts.push(`${backup.commits} ${backup.commits === 1 ? "commit" : "commits"}`);
  if (backup.snapshotSha) parts.push(backup.files > 0 ? `${backup.files} uncommitted ${backup.files === 1 ? "file" : "files"}` : "uncommitted changes");
  const when = new Date(backup.savedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return `ADE Cloud saved this lane's work that isn't on GitHub (${parts.join(" and ") || "its changes"}) on ${when}.`;
}

export function CloudLaneSavedWork({ laneId, laneName, className }: { laneId: string; laneName?: string | null; className?: string }) {
  const [backup, setBackup] = useState<CloudLaneBackup | null>(null);
  const [busy, setBusy] = useState<"patch" | "lane" | null>(null);
  const binding = useAppStore((state) => state.projectBinding);
  const cloud = window.ade?.cloud;

  useEffect(() => {
    let live = true;
    const read = cloud?.laneBackups;
    if (!read) return;
    void read(laneId).then(
      (list) => {
        if (live) setBackup([...list].filter((entry) => entry.laneId === laneId).sort((a, b) => b.savedAt - a.savedAt)[0] ?? null);
      },
      () => {
        if (live) setBackup(null);
      },
    );
    return () => {
      live = false;
    };
  }, [cloud, laneId]);

  if (!backup) return null;
  const name = laneName ?? backup.laneName ?? "this lane";
  // Only a clone of the same repository on this computer can take the work as a lane.
  const here = binding?.kind === "local" ? normalizeGitRemoteIdentity(binding.gitOriginUrl ?? null) : null;
  const canOpenHere = Boolean(cloud?.laneBackupToBranch && binding?.kind === "local" && (!backup.projectKey || here === backup.projectKey));

  const download = async () => {
    if (!cloud?.saveLaneBackupPatch) return;
    setBusy("patch");
    try {
      const saved = await cloud.saveLaneBackupPatch(backup.machineKey, backup.laneId);
      if (saved.savedTo) showToast({ tone: "success", title: `Saved ${name}'s work`, message: "Apply it in a clone of the repository with git apply." });
    } catch (error) {
      showToast({ tone: "error", title: `Couldn't download ${name}'s work`, message: ipcErrorMessage(error) || "Try again in a moment." });
    } finally {
      setBusy(null);
    }
  };

  const openHere = async () => {
    if (!cloud?.laneBackupToBranch || binding?.kind !== "local") return;
    setBusy("lane");
    try {
      const { branch } = await cloud.laneBackupToBranch(backup.machineKey, backup.laneId, binding.rootPath);
      await window.ade.lanes.importBranch({ branchRef: branch, name: `${name} (saved work)`, publishUpstream: false }, binding);
      showToast({ tone: "success", title: `Opened ${name}'s work in a new lane`, message: `It is on the branch ${branch}, on this computer only. Its uncommitted changes are its last commit.` });
    } catch (error) {
      showToast({ tone: "error", title: `Couldn't open ${name}'s work here`, message: ipcErrorMessage(error) || "Try again in a moment." });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={cn("adecl-saved-work", className)} data-cloud-lane-saved-work={laneId}>
      <span className="adecl-muted">{savedWorkSentence(backup)}</span>
      <div className="adecl-nocomp-actions">
        {cloud?.saveLaneBackupPatch && backup.patchParts > 0 ? (
          <button type="button" className="kit-btn kit-btn-ghost" data-size="xs" disabled={busy != null} onClick={() => void download()}>
            <DownloadSimple size={11} />
            {busy === "patch" ? "Downloading…" : "Download patch"}
          </button>
        ) : null}
        {canOpenHere ? (
          <button type="button" className="kit-btn kit-btn-ghost" data-size="xs" disabled={busy != null} onClick={() => void openHere()}>
            <GitBranch size={11} />
            {busy === "lane" ? "Opening…" : "Open in a new lane here"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

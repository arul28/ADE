// Shared helpers for Cursor Cloud renderer components.

import { stripElectronErrorWrapper } from "../../shared/codedError";
import { repoMatchKey } from "../../shared/cursorCloudRepoMatch";
import type { GitUpstreamSyncStatus } from "../../shared/types/git";

export { repoMatchKey };

/** Superset tone map for cloud-agent status pills across cloud surfaces. */
export function cursorCloudStatusToneClass(status: string | undefined | null): string {
  const s = (status ?? "").toLowerCase();
  if (s === "running") return "border-violet-300/30 bg-violet-500/10 text-violet-100/85";
  if (s === "creating") return "border-sky-300/25 bg-sky-500/10 text-sky-100/80";
  if (s === "finished" || s === "completed") return "border-emerald-400/22 bg-emerald-500/8 text-emerald-100/80";
  if (s === "error" || s === "failed" || s === "expired") return "border-red-400/22 bg-red-500/8 text-red-200/85";
  if (s === "cancelled") return "border-white/[0.10] bg-white/[0.03] text-fg/45";
  if (s === "archived") return "border-white/[0.08] bg-transparent text-fg/40";
  return "border-white/[0.08] bg-white/[0.025] text-fg/55";
}

export function formatCursorCloudAge(value: number | string | null | undefined): string | null {
  const ts = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Date.parse(value)
      : NaN;
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const delta = Date.now() - ts;
  if (delta < 0) return null;
  if (delta < 45_000) return "just now";
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** `https://github.com/owner/repo` → `owner/repo` for compact row display. */
export function cursorCloudRepoLabel(url: string): string {
  const key = repoMatchKey(url);
  if (!key) return url;
  const parts = key.split("/");
  return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : key;
}

/**
 * Strip Electron's `Error invoking remote method '…':` wrapper so Cursor Cloud
 * failures show the underlying message (API key missing, repo access, etc.).
 */
export function cursorCloudErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return stripElectronErrorWrapper(raw) || "Cursor Cloud request failed.";
}

/** Shown instead of a raw git push error when the lane's branch and origin have diverged. */
export const CURSOR_CLOUD_BRANCH_DIVERGED_MESSAGE =
  "This lane's branch is behind origin and also has local commits origin does not have. "
  + "Pull or rebase in the lane, then send again.";

/**
 * Turn a failed pre-launch push into one plain sentence. The cloud agent clones
 * origin, so the branch has to be there; git's own stderr ("! [rejected] … hint:
 * …") is not something a user should have to parse in a composer banner.
 */
export function describeCursorCloudPushFailure(error: unknown, branch?: string | null): string {
  const raw = cursorCloudErrorMessage(error);
  const subject = branch?.trim() ? `Branch ${branch.trim()}` : "This lane's branch";
  if (/non-fast-forward|\[rejected\]|fetch first|behind its remote/i.test(raw)) {
    return `${subject} is behind origin, so ADE could not push it. Pull or rebase in the lane, then send again.`;
  }
  if (/permission denied|authentication failed|could not read from remote|\b403\b/i.test(raw)) {
    return `ADE could not push ${subject.toLowerCase()} to origin: GitHub refused the push. Check your access, then send again.`;
  }
  const firstLine = raw.split(/\r?\n/u).map((line) => line.trim()).find((line) => line.length > 0) ?? raw;
  return `ADE could not push ${subject.toLowerCase()} to origin: ${firstLine}`;
}

export type CursorCloudLaunchGit = {
  getSyncStatus?: (args: { laneId: string }) => Promise<GitUpstreamSyncStatus | null | undefined>;
  push: (args: { laneId: string }) => Promise<unknown>;
};

type CursorCloudOriginArgs = {
  laneId: string;
  branchHint?: string | null;
  git: CursorCloudLaunchGit;
};

async function pushLaneOriginOrThrow(args: CursorCloudOriginArgs, branchHint?: string | null): Promise<void> {
  try {
    await args.git.push({ laneId: args.laneId });
  } catch (pushError) {
    throw new Error(describeCursorCloudPushFailure(pushError, branchHint ?? args.branchHint));
  }
}

/** Auto-create always pushes: the branch was just minted locally. */
export async function pushAutoCreatedLaneOriginForCursorCloud(args: CursorCloudOriginArgs): Promise<void> {
  await pushLaneOriginOrThrow(args, args.branchHint);
}

/**
 * Prepare an existing lane's origin ref before a cloud agent clones it.
 *
 * Behind-only skips the push (origin is newer, and that is what the cloud
 * clones). Diverged blocks. Local-ahead or no-upstream pushes. A failed push
 * always aborts — origin listing the branch is not proof it has these commits.
 */
export async function ensureExistingLaneOriginReadyForCursorCloud(args: CursorCloudOriginArgs): Promise<void> {
  let sync: GitUpstreamSyncStatus | null = null;
  try {
    sync = (await args.git.getSyncStatus?.({ laneId: args.laneId })) ?? null;
  } catch {
    sync = null;
  }
  if (sync?.hasUpstream && (sync.diverged || (sync.ahead > 0 && sync.behind > 0))) {
    throw new Error(CURSOR_CLOUD_BRANCH_DIVERGED_MESSAGE);
  }
  const needsPush = !sync?.hasUpstream || sync.ahead > 0;
  if (!needsPush) return;
  await pushLaneOriginOrThrow(args, sync?.upstreamRef ?? args.branchHint);
}

export type CursorCloudExistingPr = {
  prUrl: string;
  prNumber: number | null;
  title: string | null;
};

/**
 * `prUrl` and `autoCreatePR` are create-time only. If the branch already has a
 * PR, attach to it — do not also ask Cursor to open another.
 */
export function resolveCursorCloudPrCreateFields(input: {
  existingPrUrl?: string | null;
  autoCreatePR?: boolean;
}): { autoCreatePR: boolean; prUrl?: string } {
  const prUrl = input.existingPrUrl?.trim() || "";
  if (prUrl) return { autoCreatePR: false, prUrl };
  return { autoCreatePR: input.autoCreatePR === true };
}

/** Public Cursor Cloud agent URL. The in-app `#/cloud` route is not shipped. */
export function cursorCloudAgentWebUrl(agentId: string | null | undefined): string | null {
  const id = agentId?.trim();
  if (!id) return null;
  return `https://cursor.com/agents?id=${encodeURIComponent(id)}`;
}

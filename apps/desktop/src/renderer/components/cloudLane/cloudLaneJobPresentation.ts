/**
 * How every surface words a cloud lane's size change or move (the chat's
 * card and bar, the corner panel, the dashboard row, the chat header's
 * status). Pure: no React, no store.
 */

import {
  CLOUD_LANE_JOB_STAGE_LABELS,
  cloudLaneJobGrowsDiskOnly,
  type CloudLaneJobSnapshot,
} from "../../../shared/cloudLaneLife";
import { cloudCatalogOf, type CloudAccountState } from "../../../shared/adeCloud";
import { cloudTier } from "../../../shared/cloudTiers";
import type { NoticeTone } from "../ui/notice/noticeTones";

/** "a Large", "an X-Large": the article a size's name reads with. */
function withArticle(label: string): string {
  return /^(?:[aeiou]|x-)/i.test(label) ? `an ${label}` : `a ${label}`;
}

/** A size's name in the account's catalog ("Large"), else its id; null for none. */
export function cloudSizeLabel(account: CloudAccountState | null, id: string | null): string | null {
  if (!id) return null;
  return cloudTier(cloudCatalogOf(account), id)?.label ?? id;
}

/**
 * How every surface words and colours a job, by phase, in one place: the chat
 * card, the corner panel and the dashboard's row all read from here.
 * - `title`: the job in one line. A finished move says plainly that the chat
 *   follows the lane to its new computer (same chat, same lane).
 * - `stepLine`: the step running now (or why it failed), "Copy lane · Copying files…".
 * - `tone`: the corner panel's tone for the row.
 * - `note`: the card's sentence under the steps.
 * - `row`: what the dashboard row's State cell says; null when it says the computer's own state.
 */
export type CloudLaneJobPresentation = {
  title: string;
  stepLine: string | null;
  tone: NoticeTone;
  note: string | null;
  row: { state: "starting" | "failed" | "awake"; label: string } | null;
};

export function cloudLaneJobPresentation(job: CloudLaneJobSnapshot, account: CloudAccountState | null): CloudLaneJobPresentation {
  const to = cloudSizeLabel(account, job.toSizeId) ?? "the new size";
  const move = job.kind === "move";
  // The same size with a bigger disk: a disk grow (the Android pane's Grow the disk).
  if (cloudLaneJobGrowsDiskOnly(job)) {
    const disk = `${job.laneName}'s disk`;
    switch (job.phase) {
      case "waiting":
        return { title: `${disk} grows to ${job.diskGb} GB when the agent is idle`, stepLine: liveStepLine(job), tone: "accent", note: "ADE waits for the agent to finish its turn. Your files and chats stay.", row: { state: "starting", label: "Grows when idle" } };
      case "running":
        return { title: `Growing ${disk} to ${job.diskGb} GB`, stepLine: liveStepLine(job), tone: "accent", note: "The computer restarts for a moment. Your files and chats stay. You can close this window.", row: { state: "starting", label: "Growing disk" } };
      case "online":
        return { title: `${disk} grew to ${job.diskGb} GB`, stepLine: null, tone: "success", note: "ADE connected to the computer again.", row: { state: "awake", label: "Disk grown" } };
      case "failed":
        return { title: "The disk grow stopped", stepLine: job.error ?? job.stages.find((stage) => stage.status === "failed")?.error ?? null, tone: "error", note: null, row: { state: "failed", label: "Disk grow stopped" } };
      case "cancelled":
        return { title: `Kept ${disk} as it is`, stepLine: null, tone: "neutral", note: null, row: null };
    }
  }
  switch (job.phase) {
    case "waiting":
      return {
        title: `${job.laneName} changes to ${to} when the agent is idle`,
        stepLine: liveStepLine(job),
        tone: "accent",
        note: "ADE waits for the agent to finish its turn. Your files and chats stay.",
        row: { state: "starting", label: "Changes when idle" },
      };
    case "running":
      return {
        title: move ? `Moving ${job.laneName} to ${withArticle(to)} computer` : `Changing ${job.laneName} to ${to}`,
        stepLine: liveStepLine(job),
        tone: "accent",
        // A message sent meanwhile waits on ADE Cloud until the change is done (`AgentChatPane` submit).
        note: move
          ? "Your files and chats stay. A message you send now waits on ADE Cloud, and the agent gets it on the new computer. You can close this window."
          : "Your files and chats stay. A message you send waits until the computer is back. You can close this window.",
        row: { state: "starting", label: move ? "Moving" : "Changing size" },
      };
    case "online":
      return {
        title: move ? `Moved to ${withArticle(to)} computer · your chat follows` : `${job.laneName} is online at ${to}`,
        stepLine: move ? `${job.laneName} is online. The old computer is gone.` : null,
        tone: "success",
        note: move
          ? "Same lane, same chats, on the new computer. ADE points this chat, its tools and Android there."
          : "ADE connected to the computer again.",
        row: { state: "awake", label: move ? "Moved" : "Resized" },
      };
    case "failed":
      return {
        title: move ? `The move to ${to} stopped` : `The change to ${to} stopped`,
        stepLine: job.error ?? job.stages.find((stage) => stage.status === "failed")?.error ?? null,
        tone: "error",
        note: null,
        row: { state: "failed", label: move ? "Move stopped" : "Size change stopped" },
      };
    case "cancelled":
      return {
        title: `Kept ${job.laneName} at ${cloudSizeLabel(account, job.fromSizeId) ?? "its size"}`,
        stepLine: null,
        tone: "neutral",
        note: null,
        row: null,
      };
  }
}

/** The job in one line, the same in the chat, on the dashboard and in the corner panel. */
export function cloudLaneJobTitle(job: CloudLaneJobSnapshot, account: CloudAccountState | null): string {
  return cloudLaneJobPresentation(job, account).title;
}

/** A waiting or running job's step now, as one line. */
function liveStepLine(job: CloudLaneJobSnapshot): string | null {
  const running = job.stages.filter((entry) => entry.status === "running");
  // Two at once (a move saves while it makes the new computer): both names, and the later one's detail.
  const stage = running.at(-1) ?? job.stages.find((entry) => entry.status === "pending") ?? null;
  if (!stage) return null;
  const label = running.length > 1 ? running.map((entry) => CLOUD_LANE_JOB_STAGE_LABELS[entry.id]).join(" and ") : CLOUD_LANE_JOB_STAGE_LABELS[stage.id];
  return stage.detail?.trim() ? `${label} · ${stage.detail.trim()}` : label;
}

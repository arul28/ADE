/**
 * The chat cards of a disk grow the ADE Cloud computer makes itself (an
 * agent's `ade cloud resize --free`, the Android emulator's first start).
 * The grow restarts the computer, so one card (one `cardId`) is posted
 * before the restart and updated in place once the computer is back. Plain
 * `ade_card` payloads: every client draws them with its generic card, and
 * one that can't shows `fallbackText`.
 */

import type { AdeCardPayload, AdeCardRow } from "./adeCard";
import { formatCloudCents } from "./adeCloud";
import type { CloudDiskGrowExtra, CloudDiskLaneUse, CloudDiskLimitReason } from "./cloudDiskGrowRules";

const CLOUD_DISK_GROW_CARD_VARIANT = "cloud_disk_grow";
const CLOUD_DISK_LIMIT_CARD_VARIANT = "cloud_disk_limit";

/**
 * `growing`: asked, restart coming. `grew`: back on the bigger disk. `same`:
 * back on the same disk. `failed`: the ask didn't start a grow (`detail` says why).
 */
type CloudDiskGrowCardPhase = "growing" | "grew" | "same" | "failed";

export function buildCloudDiskGrowCard(input: {
  cardId: string;
  fromGb: number | null;
  toGb: number;
  reason: string | null;
  phase: CloudDiskGrowCardPhase;
  /** Free space once back, in GB (one decimal). */
  freeGb?: number | null;
  /** The paid extra disk the grow uses. */
  extra?: CloudDiskGrowExtra | null;
  /** `failed`: why it didn't grow. */
  detail?: string | null;
}): AdeCardPayload {
  const sizes = input.fromGb != null ? `${input.fromGb} GB → ${input.toGb} GB` : `To ${input.toGb} GB`;
  const extra = input.extra ? `${input.extra.pastGb} GB of paid extra disk, about ${formatCloudCents(input.extra.monthCents)} a month` : null;
  const ask: AdeCardRow = { key: "ask", icon: "pass", text: `Asked ADE Cloud for a ${input.toGb} GB disk`, detail: input.reason };
  if (input.phase === "growing") {
    return {
      cardId: input.cardId,
      variant: CLOUD_DISK_GROW_CARD_VARIANT,
      state: "live",
      title: "Growing this computer's disk",
      subtitle: extra ? `${sizes} · ${extra}` : `${sizes} · up to this size's disk maximum`,
      rows: [
        ask,
        { key: "restart", icon: "running", text: "Restart the computer and start ADE again" },
        { key: "continue", icon: "queued", text: "Continue this chat" },
      ],
      fallbackText: `ADE is growing this computer's disk (${sizes}${extra ? `, ${extra}` : ""}). The computer restarts for a moment, then ADE continues this chat.`,
    };
  }
  if (input.phase === "grew") {
    const free = input.freeGb != null ? `${input.freeGb} GB free` : null;
    return {
      cardId: input.cardId,
      variant: CLOUD_DISK_GROW_CARD_VARIANT,
      state: "terminal",
      title: `Disk grew to ${input.toGb} GB`,
      subtitle: [sizes, free].filter(Boolean).join(" · "),
      rows: [
        ask,
        { key: "restart", icon: "pass", text: "Restarted the computer and started ADE again" },
        { key: "continue", icon: "pass", text: "Continued this chat" },
      ],
      fallbackText: `This computer's disk grew (${sizes})${free ? `; ${free}` : ""}. ADE started again and continued this chat.`,
    };
  }
  if (input.phase === "failed") {
    const why = input.detail ?? "ADE couldn't grow it right now.";
    return {
      cardId: input.cardId,
      variant: CLOUD_DISK_GROW_CARD_VARIANT,
      state: "terminal",
      title: "The disk didn't grow",
      subtitle: why,
      rows: [{ ...ask, icon: "fail" }],
      fallbackText: `ADE didn't grow this computer's disk to ${input.toGb} GB. ${why}`,
    };
  }
  return {
    cardId: input.cardId,
    variant: CLOUD_DISK_GROW_CARD_VARIANT,
    state: "terminal",
    title: "The disk didn't grow",
    subtitle: `Asked for ${input.toGb} GB; the computer came back with the same disk`,
    rows: [
      { ...ask, icon: "fail" },
      { key: "restart", icon: "pass", text: "Restarted the computer and started ADE again" },
    ],
    fallbackText: `ADE asked to grow this computer's disk to ${input.toGb} GB, and the computer came back with the same disk. ADE tries again when something needs the room.`,
  };
}

const LIMIT_TITLES: Partial<Record<CloudDiskLimitReason, string>> = {
  tier_limit: "This computer's disk can't grow more",
  unavailable: "ADE couldn't grow this computer's disk",
  // The agent limits, not the account, held an unattended agent's grow back.
  agent_limit: "Agents can't add more disk alone",
};

/**
 * A grow that can't happen: the account is at its storage limit (the
 * computers that hold the disk, biggest first, so the person can pick one to
 * delete), or the size can't hold a bigger disk. `sentence` names no
 * computers: the card lists them itself.
 */
export function buildCloudDiskLimitCard(input: {
  cardId: string;
  toGb: number;
  reason: CloudDiskLimitReason;
  sentence: string;
  lanes: readonly CloudDiskLaneUse[];
}): AdeCardPayload {
  const lanes = [...input.lanes].sort((a, b) => b.diskGb - a.diskGb).slice(0, 8);
  const usedGb = input.lanes.reduce((sum, lane) => sum + lane.diskGb, 0);
  const title = LIMIT_TITLES[input.reason] ?? "Your ADE Cloud storage is full";
  return {
    cardId: input.cardId,
    variant: CLOUD_DISK_LIMIT_CARD_VARIANT,
    state: "terminal",
    title,
    subtitle: input.sentence,
    ...(lanes.length ? { metrics: [{ label: "Used by your computers", value: `${usedGb} GB` }] } : {}),
    // A refusal reads as one (amber), never as a passed card; the computers
    // carry the same tone so the card lists them.
    rows: [
      { key: "ask", icon: "fail", text: `Asked ADE Cloud for a ${input.toGb} GB disk` },
      ...lanes.map((lane, index): AdeCardRow => ({ key: `lane_${index}`, icon: "info", tone: "warning", text: lane.laneName, detail: `${lane.diskGb} GB` })),
    ],
    fallbackText: `${title}: ${input.sentence}${lanes.length ? ` Disk by computer: ${lanes.map((lane) => `${lane.laneName} ${lane.diskGb} GB`).join(", ")}.` : ""}`,
  };
}

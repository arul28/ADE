/**
 * The chat cards of a disk grow the ADE Cloud computer makes itself (an
 * agent's `ade cloud resize --free`, the Android emulator's first start).
 * The grow restarts the computer, so one card (one `cardId`) is posted
 * before the restart and updated in place once the computer is back. Plain
 * `ade_card` payloads: every client draws them with its generic card, and
 * one that can't shows `fallbackText`.
 */

import type { AdeCardPayload, AdeCardRow } from "./adeCard";
import type { CloudDiskRefusalReason } from "./adeCloud";
import { BRAND } from "./brand";

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
  /** `failed`: why it didn't grow. */
  detail?: string | null;
}): AdeCardPayload {
  const sizes = input.fromGb != null ? `${input.fromGb} GB → ${input.toGb} GB` : `To ${input.toGb} GB`;
  const ask: AdeCardRow = { key: "ask", icon: "pass", text: `Asked ${BRAND.CLOUD_NAME} for a ${input.toGb} GB disk`, detail: input.reason };
  if (input.phase === "growing") {
    return {
      cardId: input.cardId,
      variant: CLOUD_DISK_GROW_CARD_VARIANT,
      state: "live",
      title: "Growing this computer's disk",
      subtitle: `${sizes} · up to this size's disk maximum`,
      rows: [
        ask,
        { key: "restart", icon: "running", text: `Restart the computer and start ${BRAND.NAME} again` },
        { key: "continue", icon: "queued", text: "Continue this chat" },
      ],
      fallbackText: `${BRAND.NAME} is growing this computer's disk (${sizes}). The computer restarts for a moment, then ${BRAND.NAME} continues this chat.`,
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
        { key: "restart", icon: "pass", text: `Restarted the computer and started ${BRAND.NAME} again` },
        { key: "continue", icon: "pass", text: "Continued this chat" },
      ],
      fallbackText: `This computer's disk grew (${sizes})${free ? `; ${free}` : ""}. ${BRAND.NAME} started again and continued this chat.`,
    };
  }
  if (input.phase === "failed") {
    const why = input.detail ?? `${BRAND.NAME} couldn't grow it right now.`;
    return {
      cardId: input.cardId,
      variant: CLOUD_DISK_GROW_CARD_VARIANT,
      state: "terminal",
      title: "The disk didn't grow",
      subtitle: why,
      rows: [{ ...ask, icon: "fail" }],
      fallbackText: `${BRAND.NAME} didn't grow this computer's disk to ${input.toGb} GB. ${why}`,
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
      { key: "restart", icon: "pass", text: `Restarted the computer and started ${BRAND.NAME} again` },
    ],
    fallbackText: `${BRAND.NAME} asked to grow this computer's disk to ${input.toGb} GB, and the computer came back with the same disk. ${BRAND.NAME} tries again when something needs the room.`,
  };
}

/**
 * A grow that can't happen: the size can't hold a bigger disk
 * (`tier_limit`), or ADE Cloud can't grow it now. `sentence` says why and the
 * way out.
 */
export function buildCloudDiskLimitCard(input: {
  cardId: string;
  toGb: number;
  reason: CloudDiskRefusalReason;
  sentence: string;
}): AdeCardPayload {
  const title = input.reason === "tier_limit" ? "This computer's disk can't grow more" : `${BRAND.NAME} couldn't grow this computer's disk`;
  return {
    cardId: input.cardId,
    variant: CLOUD_DISK_LIMIT_CARD_VARIANT,
    state: "terminal",
    title,
    subtitle: input.sentence,
    // A refusal reads as one (amber), never as a passed card.
    rows: [{ key: "ask", icon: "fail", text: `Asked ${BRAND.CLOUD_NAME} for a ${input.toGb} GB disk` }],
    fallbackText: `${title}: ${input.sentence}`,
  };
}

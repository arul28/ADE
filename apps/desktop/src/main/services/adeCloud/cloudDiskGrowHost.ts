/**
 * The disk grower of the ADE Cloud computer this brain runs on, for what asks
 * for room from inside a project runtime: an agent's `cloud.grow_disk`
 * (`ade cloud resize --free`) and the Android emulator's first start. The
 * brain (`ade-cli` `cli.ts`) registers its grower (`cloudDiskGrow.ts`) at
 * start; nothing is registered on any other computer.
 *
 * A grow restarts the computer. The ask waits for that restart, so the turn
 * that asked is still running when the computer goes down: ADE continues it
 * after the restart, and the continue says the disk grew (restart cause
 * `disk_grow`). The chat named in the ask gets a card before the restart,
 * updated in place once the computer is back (`cloudDiskGrowCard.ts`), and
 * a card that says why when it can't grow.
 */

import type { CloudDiskRefusalReason } from "../../../shared/adeCloud";

/** A chat to tell before and after the restart: its id and its project's root on this computer. */
export type CloudDiskGrowChat = { chatSessionId: string; projectRoot: string | null };

export type CloudDiskGrowAsk = {
  /** How much must be free once it grew, in bytes. */
  needFreeBytes?: number | null;
  /** Or the disk's new size, in GB. */
  toGb?: number | null;
  /** Why, in a few words: said in the chat's notice. */
  reason: string;
  /** Who asks: an agent (`cloud.grow_disk`) or the Android emulator's first start. */
  origin: "agent" | "android";
  chat?: CloudDiskGrowChat | null;
  signal?: AbortSignal;
};

export type CloudDiskGrowAnswer =
  /** Already enough room: nothing grew. */
  | { state: "fits"; diskGb: number; freeGb: number; message: string }
  /** Grew without a restart (rare): the room is there now. */
  | { state: "grown"; fromGb: number; toGb: number; message: string }
  /** Asked for, and the restart hasn't come within the wait. */
  | { state: "growing"; fromGb: number; toGb: number; message: string }
  /** It can't grow: the size's maximum (`tier_limit`), or ADE Cloud can't grow it now. `message` says why and the way out. */
  | { state: "limit"; fromGb: number; toGb: number; reason: CloudDiskRefusalReason; message: string }
  /** Something the restart would cut runs here (a command, a lane's setup, a copy). */
  | { state: "busy"; message: string }
  /** No way to ask now (ADE Cloud not reachable, a grow already running). */
  | { state: "unavailable"; message: string };

export type CloudDiskGrowHost = {
  growToFit(ask: CloudDiskGrowAsk): Promise<CloudDiskGrowAnswer>;
};

let activeHost: CloudDiskGrowHost | null = null;

/** The brain registers its grower once (`cli.ts`); a later call replaces it. */
export function setCloudDiskGrowHost(host: CloudDiskGrowHost | null): void {
  activeHost = host;
}

/** This computer's grower, on an ADE Cloud computer whose brain made one; null anywhere else. */
export function cloudDiskGrowHost(): CloudDiskGrowHost | null {
  return activeHost;
}

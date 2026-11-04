/**
 * Who is still watching a lane's Android stream, counted in the renderer.
 *
 * `androidEmulator.stopStream` is lane-scoped, so the lease is per lane. The
 * table is Android's own (see `device/streamLease.ts`): an Android lease in
 * the Apple table would hold an Apple stop open.
 */

import type { OpenProjectBinding } from "../../../shared/types";
import { laneOnMachineKey } from "../../lib/chatMachineRouting";
import { createStreamLeaseTable } from "../device/streamLease";

export const androidStreamLeases = createStreamLeaseTable<null>();

/** One key per lane on one machine: the stop is lane-scoped. */
export function androidStreamLeaseKey(args: {
  pin: OpenProjectBinding | null | undefined;
  bound: OpenProjectBinding | null | undefined;
  laneId: string;
}): string {
  return laneOnMachineKey(args.pin, args.bound, args.laneId);
}

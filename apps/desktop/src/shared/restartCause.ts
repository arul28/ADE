import type { UpdateRequestedBy } from "./types/remoteRuntime";

/**
 * Why the previous ADE background service ended, as the next one reads it
 * once at its start from facts on disk (`brainRestartCause.ts`). The continue
 * prompts and the reopened-CLI line name it (`chatAutoResume.ts`).
 *
 * - `update`: a planned stop for an update; `version` is the version ADE runs now.
 * - `computer_restarted`: the computer booted after the previous service's
 *   last sign of life. `planned`: the service saw the shutdown coming.
 * - `service_restarted_by_watchdog`: ADE's watchdog ended a frozen service.
 * - `service_restarted`: someone restarted the service on purpose (the
 *   restart button, `ade brain restart`, a signal).
 * - `unknown`: the service ended and left no record of why.
 */
export type RestartCauseKind = RestartCause["kind"];

/** Memory facts from the minutes before the previous service ended. */
export type RestartMemoryFacts = {
  totalMb: number | null;
  swapUsedMb: number | null;
  swapTotalMb: number | null;
  /** What the iOS simulators used, when the resource-pressure record measured it. */
  simulatorMb: number | null;
};

type RestartCauseBase = {
  /** When the previous service ended, as near as the facts tell (epoch ms). */
  endedAtMs: number | null;
};

export type RestartCause =
  | (RestartCauseBase & {
    kind: "update";
    /** The version ADE runs now, when the build changed. */
    version: string | null;
    /** Who asked for it, when a remote client did. */
    requestedBy: UpdateRequestedBy | null;
  })
  | (RestartCauseBase & {
    kind: "computer_restarted";
    /** The service stopped in an orderly way before the restart. */
    planned: boolean;
    memory?: RestartMemoryFacts | null;
  })
  | (RestartCauseBase & {
    kind: "service_restarted_by_watchdog";
    /** What froze the service. */
    freezeCause: "self" | "memory" | "drive" | null;
    memory?: RestartMemoryFacts | null;
  })
  | (RestartCauseBase & { kind: "service_restarted" })
  | (RestartCauseBase & {
    kind: "unknown";
    /** Memory was short in the minutes before the service ended. */
    memory?: RestartMemoryFacts | null;
  });

/** The memory facts of a cause, for the kinds that carry them. */
export function restartCauseMemory(cause: RestartCause | null | undefined): RestartMemoryFacts | null {
  if (!cause || cause.kind === "update" || cause.kind === "service_restarted") return null;
  return cause.memory ?? null;
}

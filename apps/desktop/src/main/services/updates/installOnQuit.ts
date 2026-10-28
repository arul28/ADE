import type { LocalRuntimeStatus, UpdateImpact } from "../../../shared/types";

/**
 * Whether quitting ADE may install the update that is waiting.
 *
 * With automatic install on, a quit installs a downloaded update. An install
 * is never the app alone: it moves the background service to the new build
 * too (the existing `quitAndInstall` path stops the service, and the launch
 * that lands the install restarts it on the new version and checks it). A
 * plain quit leaves the background brain running, with its agents, so an
 * install on quit would stop work the person expected to keep going.
 *
 * So a quit installs only when that costs nothing:
 * - the service brain is running and nothing is running on it (no chat mid
 *   turn, no CLI session, no terminal), or
 * - there is no service brain to stop: ADE is running the brain itself
 *   (`app_fallback`), and the quit stops it either way.
 * Otherwise the update waits, the quit is an ordinary quit, and automatic
 * install picks it up on a later launch under its own rules. "Could not
 * check" is treated as "something is running": never as idle.
 */

export type InstallOnQuitDecision =
  | { action: "install"; version: string }
  | {
      action: "defer";
      version: string;
      reason: "agents_running" | "work_unknown";
    };

export function decideInstallOnQuit(args: {
  version: string;
  runtimeMode: LocalRuntimeStatus["runtimeMode"];
  /** What a restart would stop. Null when it was not read. */
  impact: UpdateImpact | null;
}): InstallOnQuitDecision {
  const { version } = args;
  if (args.runtimeMode === "app_fallback") return { action: "install", version };
  // An isolated brain is this app's own, beside a service brain it does not
  // talk to; the impact read answers for the wrong brain.
  if (args.runtimeMode !== "primary") return { action: "defer", version, reason: "work_unknown" };
  const impact = args.impact;
  if (!impact?.checked) return { action: "defer", version, reason: "work_unknown" };
  const busy = impact.chats.length > 0
    || impact.cliSessions > 0
    || impact.terminals > 0
    || impact.busyWithoutDetail === true;
  return busy ? { action: "defer", version, reason: "agents_running" } : { action: "install", version };
}

/**
 * An ADE Cloud computer tells ADE's server about its own work, so a lane's
 * status menu can say "Sleeps in ~2 min if idle" or "1 agent running" with
 * no wake and no exec (`POST /cloud/instances/:id/activity`,
 * `computerStatus.ts` on the server).
 *
 * It rides the keep-awake's own checks (once a minute while the brain runs):
 * no timer and no idle clock of its own. The keep-awake hands over its idle
 * facts after each check (`onIdleFacts` in `cloudKeepAwake.ts`), so
 * `sleepsAt` is the check that will ask for the sleep, unless work comes
 * first. The busy read (`readCloudBusy` in `cli.ts`) hands over the agents.
 * A report goes out only when what it says changes (working or idle, since
 * when, how many agents), and once again after a wake, since the server drops
 * a report older than the stretch awake. One report is in flight at a time;
 * a failed one is sent again with a later check: the next one at first, then
 * spaced out (up to every 8th check) while it keeps failing, as against an
 * older server with no activity route. A failing streak logs once, and again
 * only when its error changes.
 */

import type { CloudComputerActivityReport } from "../../../../account-directory/src/cloud/contract";
import {
  AGENT_CLI_PROCESS_NAMES,
  CLOUD_UNTOUCHED_IDLE_MS,
  type CloudBusyFacts,
  type CloudIdleFacts,
} from "../power/cloudKeepAwake";

/**
 * Agents working now: chat turns that aren't waiting on the person, and agent
 * CLIs (ADE's own, or one started in a shell) whose screen still moves. An
 * hour with no output and no touch is idle, as in the keep-awake.
 */
export function cloudRunningAgents(facts: Pick<CloudBusyFacts, "chats" | "terminals">, now: number): number {
  const chats = facts.chats.filter((chat) => !chat.waitingOnPerson && now - chat.lastActivityAt < CLOUD_UNTOUCHED_IDLE_MS).length;
  const clis = facts.terminals.filter((terminal) => {
    const agent = terminal.kind === "agent_cli" || (terminal.foreground != null && AGENT_CLI_PROCESS_NAMES.has(terminal.foreground));
    return agent && terminal.state === "running" && now - Math.max(terminal.lastOutputAt, terminal.lastInputAt) < CLOUD_UNTOUCHED_IDLE_MS;
  }).length;
  return chats + clis;
}

export type CloudActivityReporter = {
  /** One busy read's facts: the agents working now. Sends nothing; the next check's idle facts carry it. Never throws. */
  noteAgents(facts: Pick<CloudBusyFacts, "chats" | "terminals">): void;
  /** The keep-awake's idle facts after a check: sends a report when it changed. Never throws. */
  noteIdle(idle: CloudIdleFacts): void;
};

export function createCloudActivityReporter(deps: {
  instanceId: string;
  send: (instanceId: string, report: CloudComputerActivityReport) => Promise<unknown>;
  logger?: { warn(event: string, data?: unknown): void };
  now?: () => number;
}): CloudActivityReporter {
  const now = deps.now ?? Date.now;
  let runningAgents = 0;
  let sentKey: string | null = null;
  let inFlight = false;
  let queued: { report: CloudComputerActivityReport; key: string } | null = null;
  // The failing streak: how many in a row, the checks to let pass before the
  // next try, and the error last logged (null once one lands).
  let failures = 0;
  let skipChecks = 0;
  let loggedError: string | null = null;

  // The stretch awake is in the key: after a wake the server needs a report from this stretch, even if nothing else changed.
  const keyOf = (report: CloudComputerActivityReport, awakeSince: number) => `${awakeSince}|${report.busy}|${report.runningAgents}|${report.idleSince ?? ""}`;

  const flush = (report: CloudComputerActivityReport, key: string): void => {
    if (inFlight) {
      queued = { report, key };
      return;
    }
    inFlight = true;
    let landed = false;
    void deps.send(deps.instanceId, report).then(
      () => {
        landed = true;
        sentKey = key;
        failures = 0;
        skipChecks = 0;
        loggedError = null;
      },
      (error: unknown) => {
        // Sent again with a later check: `sentKey` still names the last one that landed.
        failures += 1;
        skipChecks = Math.min(2 ** (failures - 1) - 1, 7);
        const message = error instanceof Error ? error.message : String(error);
        if (message !== loggedError) {
          loggedError = message;
          deps.logger?.warn("cloud.activity_report_failed", { error: message, failures });
        }
      },
    ).finally(() => {
      inFlight = false;
      const next = queued;
      queued = null;
      // After a failure the queued report waits for a later check, which
      // builds a fresh one and keeps to the backoff (`skipChecks`).
      if (landed && next && next.key !== sentKey) flush(next.report, next.key);
    });
  };

  return {
    noteAgents(facts) {
      try {
        runningAgents = cloudRunningAgents(facts, now());
      } catch (error) {
        deps.logger?.warn("cloud.activity_report_failed", { error: error instanceof Error ? error.message : String(error) });
      }
    },
    noteIdle(idle) {
      try {
        const report: CloudComputerActivityReport = {
          busy: idle.busy,
          idleSince: idle.busy ? null : idle.idleSince,
          sleepsAt: idle.busy ? null : idle.sleepsAt,
          runningAgents,
          reportedAt: now(),
        };
        const key = keyOf(report, idle.awakeSince);
        if (key === sentKey) return;
        if (skipChecks > 0 && !inFlight) {
          skipChecks -= 1;
          return;
        }
        flush(report, key);
      } catch (error) {
        deps.logger?.warn("cloud.activity_report_failed", { error: error instanceof Error ? error.message : String(error) });
      }
    },
  };
}

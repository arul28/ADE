/**
 * An ADE Cloud computer tells ADE's server about its own work, so a lane's
 * status menu can say "Sleeps in ~2 min if idle" or "1 agent running" with
 * no wake and no exec (`POST /cloud/instances/:id/activity`,
 * `computerStatus.ts` on the server).
 *
 * It rides the keep-awake's own busy read (`readCloudBusy` in `cli.ts`, once
 * a minute while the brain runs): no timer of its own. A report goes out only
 * when what it says changes (working or idle, since when, how many agents),
 * and once again after a wake, since the server drops a report older than the
 * stretch awake. One report is in flight at a time; a failed one is sent
 * again with the next read.
 *
 * The idle clock mirrors the keep-awake's (`cloudKeepAwake.ts`): work ends
 * between two reads, so idle counts from the last read that saw work (or a
 * person's use, `noteUse`), and a wake restarts it. The keep-awake asks for
 * the sleep `CLOUD_IDLE_SLEEP_AFTER_MS` after that, so `sleepsAt` is a close
 * estimate, not a promise: a timer due soon or a late use can hold it back.
 */

import type { CloudComputerActivityReport } from "../../../../account-directory/src/cloud/contract";
import {
  CLOUD_IDLE_SLEEP_AFTER_MS,
  CLOUD_KEEP_AWAKE_INTERVAL_MS,
  CLOUD_KEEP_AWAKE_SCHEDULE_WINDOW_MS,
  CLOUD_UNTOUCHED_IDLE_MS,
  type CloudBusyFacts,
} from "../power/cloudKeepAwake";

/** A gap this many read intervals long between two reads means the computer slept (the keep-awake's rule). */
const SLEEP_GAP_INTERVALS = 2.5;

/** Names an agent CLI runs under when started by hand in a shell (the keep-awake's list). */
const AGENT_CLI_PROCESS_NAMES = new Set(["claude", "codex", "cursor-agent", "agent", "droid", "opencode", "muse"]);

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
  /** One busy read: `busy` as the keep-awake reads it, the facts it read, and the next timer. Never throws. */
  note(read: { busy: boolean; facts: Pick<CloudBusyFacts, "chats" | "terminals">; nextWakeAt?: number | null }): void;
  /** Someone used the computer through another machine (the keep-awake's `noteUse`): idle restarts from now. */
  noteUse(): void;
};

export function createCloudActivityReporter(deps: {
  instanceId: string;
  send: (instanceId: string, report: CloudComputerActivityReport) => Promise<unknown>;
  logger?: { warn(event: string, data?: unknown): void };
  now?: () => number;
}): CloudActivityReporter {
  const now = deps.now ?? Date.now;
  let lastBusyAt: number | null = null;
  let lastReadAt: number | null = null;
  let wasBusy = false;
  let sentKey: string | null = null;
  let inFlight = false;
  let queued: CloudComputerActivityReport | null = null;

  const keyOf = (report: CloudComputerActivityReport) => `${report.busy}|${report.runningAgents}|${report.idleSince ?? ""}`;

  const flush = (report: CloudComputerActivityReport): void => {
    if (inFlight) {
      queued = report;
      return;
    }
    inFlight = true;
    const key = keyOf(report);
    void deps.send(deps.instanceId, report).then(
      () => {
        sentKey = key;
      },
      (error: unknown) => {
        // Sent again with the next read: `sentKey` still names the last one that landed.
        deps.logger?.warn("cloud.activity_report_failed", { error: error instanceof Error ? error.message : String(error) });
      },
    ).finally(() => {
      inFlight = false;
      const next = queued;
      queued = null;
      if (next && keyOf(next) !== sentKey) flush(next);
    });
  };

  return {
    note(read) {
      try {
        const at = now();
        // Woken (or the reads stopped a long while): the idle clock restarts, and the
        // server needs a report from this stretch awake even if nothing changed.
        const woke = lastReadAt != null && at - lastReadAt > CLOUD_KEEP_AWAKE_INTERVAL_MS * SLEEP_GAP_INTERVALS;
        lastReadAt = at;
        if (woke) {
          lastBusyAt = at;
          sentKey = null;
        }
        // A timer due soon keeps the computer awake, as in the keep-awake.
        const timerSoon = read.nextWakeAt != null && read.nextWakeAt - at < CLOUD_KEEP_AWAKE_SCHEDULE_WINDOW_MS;
        const busy = read.busy || timerSoon;
        if (busy || wasBusy || lastBusyAt == null) lastBusyAt = at;
        wasBusy = busy;
        const idleSince = busy ? null : lastBusyAt;
        const report: CloudComputerActivityReport = {
          busy,
          idleSince,
          sleepsAt: idleSince == null ? null : idleSince + CLOUD_IDLE_SLEEP_AFTER_MS,
          runningAgents: cloudRunningAgents(read.facts, at),
          reportedAt: at,
        };
        if (keyOf(report) === sentKey) return;
        flush(report);
      } catch (error) {
        deps.logger?.warn("cloud.activity_report_failed", { error: error instanceof Error ? error.message : String(error) });
      }
    },
    noteUse() {
      lastBusyAt = now();
    },
  };
}

import type { CloudAutomationRun, CloudAutomationSpec, CloudAutomationSummary } from "../../../../../account-directory/src/cloud/contract";
import type { CloudApiClient } from "../../../shared/cloudApiClient";
import { CloudApiError } from "../../../shared/cloudApiClient";
import { ADE_CLOUD_HOME_DEVICE_ID, AUTOMATION_HOME_HANDOVER_MS, isAdeCloudHome } from "../../../shared/automationHome";
import type { AutomationCloudHomeState, ConfigAutomationRule } from "../../../shared/types";
import type { Logger } from "../logging/logger";
import { automationRuleAccountId } from "./automationRuleAccountStore";

/**
 * Keeps ADE Cloud's server copy of the rules whose home is ADE Cloud (C9).
 *
 * The server watches a cloud-homed rule's trigger; it learns the rule from a
 * brain. After every account sync (and so right after the save that moved a
 * rule there), each brain of the account compares the rules it can see with
 * what it last sent and:
 *
 * - registers a cloud-homed rule whose version it hasn't sent
 *   (`PUT /cloud/automations/:ruleId`; the server writes nothing when it
 *   already has that version, so a rule change is one write however many
 *   brains see it), and points the rule's webhook at the server;
 * - unregisters a rule whose home just left ADE Cloud for a computer, and
 *   points its webhook back at the machines, so the new home is the only
 *   one that runs it once its handover wait is over;
 * - unregisters a rule it sent that is gone (deleted).
 *
 * Nothing is read on a timer: only a sync (or a delete here) starts a pass.
 * A failure is logged and tried again on the next sync.
 */

export type CloudHomeEntry = { rule: ConfigAutomationRule; version: string; onCloud: boolean };

export type AutomationCloudRegistrarDeps = {
  /** The rules homed on ADE Cloud, and those that just left it (`AutomationRuleAccountSync.cloudHomes`). */
  listCloudHomes: () => CloudHomeEntry[];
  /** The rule compiled for the server (`automationService.cloudHomeSpec`). */
  compile: (ruleId: string) => { spec: CloudAutomationSpec } | { problem: string };
  /** The account directory's typed client with this brain's token, or null while signed out. */
  api: () => CloudApiClient | null;
  /** Points a custom webhook at ADE Cloud (`forward`) or back at the machines (null): the relay's `POST /hooks/forward`. */
  setHookForward: (hookId: string, forward: { url: string; secret: string } | null) => Promise<void>;
  /** This project's origin URL, for reading its rules' runs. */
  origin: () => string | null;
  /** A read brought news: the editor lists rules again. */
  onStateChanged: () => void;
  logger: Pick<Logger, "info" | "warn">;
  now?: () => number;
};

/** The server is read for runs at most this often, and only while someone lists rules. */
const RUNS_READ_EVERY_MS = 60_000;

function stateOf(summary: CloudAutomationSummary | undefined): AutomationCloudHomeState {
  if (!summary) return { registered: false, enabled: false, pausedReason: null, nextFireAt: null, runs: [] };
  const iso = (value: number | null) => (value == null ? null : new Date(value).toISOString());
  return {
    registered: true,
    enabled: summary.enabled,
    pausedReason: summary.pausedReason,
    nextFireAt: iso(summary.nextFireAt),
    runs: summary.runs.map((run) => ({
      runId: run.runId,
      trigger: run.trigger.summary ?? run.trigger.kind,
      state: run.state,
      reason: run.reason,
      laneId: run.laneId,
      computer: run.computer,
      startedAt: iso(run.startedAt),
      endedAt: iso(run.endedAt),
      createdAt: new Date(run.createdAt).toISOString(),
    })),
  };
}

const webhookIdOf = (rule: ConfigAutomationRule): string | null =>
  (rule.triggers ?? (rule.trigger ? [rule.trigger] : [])).find((trigger) => trigger.type === "webhook")?.webhook?.hookId ?? null;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function createAutomationCloudRegistrar(deps: AutomationCloudRegistrarDeps) {
  /** What this process last sent the server for each rule: `<version>|<on or off>`. */
  const sent = new Map<string, { key: string; hookId: string | null }>();
  /** Rules this process already took off the server, by `<id>|<version>`. */
  const released = new Set<string>();
  let running = false;
  let again = false;
  const now = deps.now ?? Date.now;
  /** The server's rules of this project, by account id, from the last read. */
  let states: Map<string, AutomationCloudHomeState> | null = null;
  let statesReadAt = 0;
  let reading = false;

  const readStates = async (): Promise<void> => {
    const api = deps.api();
    const origin = deps.origin();
    if (!api || !origin || reading) return;
    reading = true;
    statesReadAt = now();
    try {
      const summaries = await api.listAutomations(origin);
      const byId = new Map(summaries.map((summary) => [summary.ruleId, summary]));
      const next = new Map<string, AutomationCloudHomeState>();
      for (const entry of deps.listCloudHomes()) {
        if (!entry.onCloud) continue;
        const accountId = automationRuleAccountId(entry.rule.id);
        next.set(accountId, stateOf(byId.get(accountId)));
      }
      const changed = JSON.stringify([...next]) !== JSON.stringify([...(states ?? new Map())]);
      states = next;
      if (changed) deps.onStateChanged();
    } catch (error) {
      deps.logger.warn("automations.cloud_home_runs_read_failed", { error: message(error) });
    } finally {
      reading = false;
    }
  };

  const unregister = async (api: CloudApiClient, accountId: string, hookId: string | null): Promise<void> => {
    await api.unregisterAutomation(accountId);
    if (hookId) await deps.setHookForward(hookId, null);
  };

  const pass = async (): Promise<void> => {
    const api = deps.api();
    if (!api) return;
    const entries = deps.listCloudHomes();
    const seen = new Set<string>();
    for (const entry of entries) {
      const accountId = automationRuleAccountId(entry.rule.id);
      seen.add(accountId);
      const hookId = webhookIdOf(entry.rule);
      try {
        if (!entry.onCloud) {
          const releaseKey = `${accountId}|${entry.version}`;
          if (released.has(releaseKey)) continue;
          await unregister(api, accountId, hookId);
          released.add(releaseKey);
          sent.delete(accountId);
          deps.logger.info("automations.cloud_home_released", { automationId: entry.rule.id });
          continue;
        }
        const enabled = entry.rule.enabled !== false;
        const key = `${entry.version}|${enabled ? "on" : "off"}`;
        if (sent.get(accountId)?.key === key) continue;
        const compiled = deps.compile(entry.rule.id);
        if ("problem" in compiled) {
          // The server must not keep running a rule this ADE can't compile any more.
          deps.logger.warn("automations.cloud_home_not_compiled", { automationId: entry.rule.id, problem: compiled.problem });
          await unregister(api, accountId, hookId);
          sent.set(accountId, { key, hookId: null });
          continue;
        }
        const home = entry.rule.home;
        const movedFromComputer = home && isAdeCloudHome(home) && home.previousDeviceId && home.previousDeviceId !== ADE_CLOUD_HOME_DEVICE_ID;
        const startsAt = movedFromComputer ? Date.parse(home!.chosenAt) + AUTOMATION_HOME_HANDOVER_MS : null;
        const result = await api.registerAutomation(accountId, {
          ruleVersion: entry.version,
          enabled,
          startsAt: Number.isFinite(startsAt) ? startsAt : null,
          spec: compiled.spec,
        });
        const before = sent.get(accountId);
        if (result.forward && hookId === result.forward.hookId) {
          await deps.setHookForward(result.forward.hookId, { url: result.forward.url, secret: result.forward.secret });
        }
        // A webhook the rule no longer has goes back to the machines.
        if (before?.hookId && before.hookId !== hookId) await deps.setHookForward(before.hookId, null);
        sent.set(accountId, { key, hookId });
        if (result.changed) {
          deps.logger.info("automations.cloud_home_registered", { automationId: entry.rule.id, current: result.current });
          // The next listing reads the server's new state.
          statesReadAt = 0;
        }
      } catch (error) {
        // Not on this account's plan: hidden, nothing more to send until it is.
        if (error instanceof CloudApiError && error.status === 404 && entry.onCloud) {
          deps.logger.warn("automations.cloud_home_unavailable", { automationId: entry.rule.id });
          continue;
        }
        deps.logger.warn("automations.cloud_home_sync_failed", { automationId: entry.rule.id, error: message(error) });
      }
    }
    // Sent before and gone now: deleted (here or on another computer).
    for (const [accountId, record] of [...sent.entries()]) {
      if (seen.has(accountId)) continue;
      try {
        await unregister(api, accountId, record.hookId);
        sent.delete(accountId);
      } catch (error) {
        deps.logger.warn("automations.cloud_home_unregister_failed", { error: message(error) });
      }
    }
  };

  return {
    /** One pass, after an account sync. A pass asked for while one runs runs once more after it. */
    async reconcile(): Promise<void> {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          await pass();
        } while (again);
      } catch (error) {
        deps.logger.warn("automations.cloud_home_pass_failed", { error: message(error) });
      } finally {
        running = false;
      }
    },

    /**
     * What the server says about a cloud-homed rule, from the last read. A
     * read older than a minute starts a new one in the background (only while
     * someone lists rules), and `onStateChanged` says when it brought news.
     */
    stateFor(ruleId: string): AutomationCloudHomeState | null {
      if (now() - statesReadAt >= RUNS_READ_EVERY_MS) void readStates();
      return states?.get(automationRuleAccountId(ruleId)) ?? null;
    },

    /** Run now for a cloud-homed rule: ADE's server starts it on its own cloud computer. */
    async runNow(ruleId: string): Promise<CloudAutomationRun> {
      const api = deps.api();
      if (!api) throw new Error("Sign in to your ADE account to run this on ADE Cloud.");
      const run = await api.runAutomation(automationRuleAccountId(ruleId));
      statesReadAt = 0;
      deps.onStateChanged();
      return run;
    },

    /** A rule deleted here: its server copy goes now, whatever this process sent before. */
    async forget(rule: Pick<ConfigAutomationRule, "id" | "home" | "triggers" | "trigger">): Promise<void> {
      if (!isAdeCloudHome(rule.home)) return;
      const api = deps.api();
      if (!api) return;
      const accountId = automationRuleAccountId(rule.id);
      try {
        await unregister(api, accountId, webhookIdOf(rule as ConfigAutomationRule));
        sent.delete(accountId);
      } catch (error) {
        deps.logger.warn("automations.cloud_home_unregister_failed", { automationId: rule.id, error: message(error) });
      }
    },
  };
}

export type AutomationCloudRegistrar = ReturnType<typeof createAutomationCloudRegistrar>;

import type { CloudAutomationRun, CloudAutomationRunState, CloudAutomationSpec, CloudAutomationSummary } from "../../../../../account-directory/src/cloud/contract";
import type { CloudApiClient } from "../../../shared/cloudApiClient";
import { CloudApiError } from "../../../shared/cloudApiClient";
import { ADE_CLOUD_HOME_DEVICE_ID, AUTOMATION_HOME_HANDOVER_MS, isAdeCloudHome } from "../../../shared/automationHome";
import type { AutomationCloudHomeState, AutomationRule, AutomationRun, AutomationRunStatus, ConfigAutomationRule } from "../../../shared/types";
import type { Logger } from "../logging/logger";
import { automationRuleAccountId, automationRuleCloudId } from "./automationRuleAccountStore";
import { webhookIdOf, type CloudHomesView } from "./automationRuleAccountSync";

/**
 * Keeps ADE Cloud's server copy of the rules whose home is ADE Cloud (C9).
 *
 * The server watches a cloud-homed rule's trigger; it learns the rule from a
 * brain. After every account sync (and so right after the save that moved a
 * rule there), each brain of the account compares the rules it can see with
 * what it last sent and:
 *
 * - registers a cloud-homed rule whose version it hasn't sent
 *   (`PUT /cloud/automations/:ruleId`, an id that carries the repository,
 *   so two repositories' rules of one id are two rows; the server writes nothing when it
 *   already has that version, so a rule change is one write however many
 *   brains see it), and points the rule's webhook at the server;
 * - takes a rule off the server only on positive evidence from the account:
 *   its home is now a computer, or some computer deleted it. It does so when
 *   this process sent it, when the home just left ADE Cloud, or when the
 *   server still lists it (so a release that failed earlier, or a brain that
 *   restarted, still ends the server copy). The release names the version it
 *   saw, so the server never drops a newer save. An account it can't read, a
 *   rule a newer ADE wrote, or one this ADE can't compile takes nothing off.
 *
 * Nothing is read on a timer: only a sync (or a delete here) starts a pass,
 * and the server's list is read at most once a minute. A failure is logged
 * and tried again on the next sync.
 */

export type AutomationCloudRegistrarDeps = {
  /** What the server copy must follow (`AutomationRuleAccountSync.cloudHomes`); null when the account can't be read. */
  listCloudHomes: () => CloudHomesView | null;
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

/** The server is read for its rules and runs at most this often. */
const SERVER_READ_EVERY_MS = 60_000;

/** A server run's state as a run of this ADE. */
export const CLOUD_RUN_STATUS: Record<CloudAutomationRunState, AutomationRunStatus> = {
  queued: "queued",
  starting: "running",
  running: "running",
  finishing: "running",
  done: "succeeded",
  failed: "failed",
  skipped: "cancelled",
};

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

/** A Run now the server answered, as a run of this ADE. */
function automationRunOf(rule: Pick<AutomationRule, "id" | "execution">, run: CloudAutomationRun): AutomationRun {
  return {
    id: run.runId,
    automationId: rule.id,
    chatSessionId: null,
    triggerType: "manual",
    startedAt: new Date(run.startedAt ?? run.createdAt).toISOString(),
    endedAt: run.endedAt != null ? new Date(run.endedAt).toISOString() : null,
    status: CLOUD_RUN_STATUS[run.state],
    executionKind: rule.execution?.kind ?? "agent-session",
    actionsCompleted: 0,
    actionsTotal: 0,
    errorMessage: run.reason,
    spendUsd: 0,
    confidence: null,
    triggerMetadata: { runsOn: "ade-cloud" },
    summary: "Started on ADE Cloud.",
    billingCode: null,
  };
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function createAutomationCloudRegistrar(deps: AutomationCloudRegistrarDeps) {
  /** What this process last sent the server for each rule (by server id): `<version>|<on or off>`. */
  const sent = new Map<string, { key: string; hookId: string | null }>();
  /** Rules this process already took off the server, by `<id>|<version>`. */
  const released = new Set<string>();
  /** Compile problems already logged, by `<id>|<key>`, so a pass logs each once. */
  const unsent = new Set<string>();
  let running = false;
  let again = false;
  /** Set by `dispose`: no pass starts after it. */
  let disposed = false;
  /** The pass running now, for `dispose` to wait on. */
  let current: Promise<void> | null = null;
  const now = deps.now ?? Date.now;
  /** The server's rules of this project, by server id, from the last read. */
  let states: Map<string, AutomationCloudHomeState> | null = null;
  /** The rule ids the server listed for this project at the last read, or null before one answered. */
  let serverIds: Set<string> | null = null;
  let serverReadAt = 0;
  let reading: Promise<void> | null = null;

  /** A rule's id on the server, which carries this repository (`automationRuleCloudId`); null without a remote. */
  const serverIdOf = (accountId: string): string | null => automationRuleCloudId(accountId, deps.origin());

  const readServer = (): Promise<void> => {
    if (reading) return reading;
    const api = deps.api();
    const origin = deps.origin();
    if (!api || !origin) return Promise.resolve();
    serverReadAt = now();
    reading = (async () => {
      try {
        const summaries = await api.listAutomations(origin);
        serverIds = new Set(summaries.map((summary) => summary.ruleId));
        const byId = new Map(summaries.map((summary) => [summary.ruleId, summary]));
        const next = new Map<string, AutomationCloudHomeState>();
        for (const entry of deps.listCloudHomes()?.onCloud ?? []) {
          const serverId = serverIdOf(automationRuleAccountId(entry.rule.id));
          if (serverId) next.set(serverId, stateOf(byId.get(serverId)));
        }
        const changed = JSON.stringify([...next]) !== JSON.stringify([...(states ?? new Map())]);
        states = next;
        if (changed) deps.onStateChanged();
      } catch (error) {
        deps.logger.warn("automations.cloud_home_runs_read_failed", { error: message(error) });
      } finally {
        reading = null;
      }
    })();
    return reading;
  };

  /** Takes a rule off the server (no newer than `through`, when given) and, unless a newer save kept it, points its webhook back at the machines. */
  const unregister = async (api: CloudApiClient, accountId: string, hookId: string | null, through?: string): Promise<void> => {
    const result = await api.unregisterAutomation(accountId, through ? { through } : undefined);
    if (result.kept) {
      deps.logger.info("automations.cloud_home_release_newer_kept", { accountId });
      return;
    }
    if (hookId) await deps.setHookForward(hookId, null);
  };

  const pass = async (): Promise<void> => {
    const api = deps.api();
    if (!api) return;
    const view = deps.listCloudHomes();
    // No confident read of the account: nothing is sent, and nothing taken off the server.
    if (!view) return;
    if (now() - serverReadAt >= SERVER_READ_EVERY_MS) await readServer();
    for (const entry of view.onCloud) {
      const accountId = serverIdOf(automationRuleAccountId(entry.rule.id));
      // No repository to name it by: `compile` refuses it too.
      if (!accountId) continue;
      const hookId = webhookIdOf(entry.rule);
      const enabled = entry.rule.enabled !== false;
      const key = `${entry.version}|${enabled ? "on" : "off"}`;
      if (sent.get(accountId)?.key === key) continue;
      try {
        const compiled = deps.compile(entry.rule.id);
        if ("problem" in compiled) {
          // This ADE can't build it (an unknown model, no remote): another brain may. The server copy stays.
          if (!unsent.has(`${accountId}|${key}`)) {
            unsent.add(`${accountId}|${key}`);
            deps.logger.warn("automations.cloud_home_not_compiled", { automationId: entry.rule.id, problem: compiled.problem });
          }
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
          serverReadAt = 0;
        }
      } catch (error) {
        // Not on this account's plan: hidden, nothing more to send until it is.
        if (error instanceof CloudApiError && error.status === 404) {
          deps.logger.warn("automations.cloud_home_unavailable", { automationId: entry.rule.id });
          continue;
        }
        deps.logger.warn("automations.cloud_home_sync_failed", { automationId: entry.rule.id, error: message(error) });
      }
    }
    // Homed on a computer now, or deleted: the server copy goes, once per version seen.
    for (const [ruleAccountId, release] of view.released) {
      const accountId = serverIdOf(ruleAccountId);
      if (!accountId) continue;
      const record = sent.get(accountId);
      if (!record && !release.leftCloud && !serverIds?.has(accountId)) continue;
      const releaseKey = `${accountId}|${release.version}`;
      if (released.has(releaseKey)) continue;
      try {
        await unregister(api, accountId, release.hookId ?? record?.hookId ?? null, release.version);
        released.add(releaseKey);
        sent.delete(accountId);
        serverIds?.delete(accountId);
        deps.logger.info("automations.cloud_home_released", { accountId });
      } catch (error) {
        deps.logger.warn("automations.cloud_home_unregister_failed", { accountId, error: message(error) });
      }
    }
  };

  return {
    /** One pass, after an account sync. A pass asked for while one runs runs once more after it. */
    async reconcile(): Promise<void> {
      if (disposed) return;
      if (running) {
        again = true;
        return;
      }
      running = true;
      current = (async () => {
        try {
          do {
            again = false;
            await pass();
          } while (again && !disposed);
        } catch (error) {
          deps.logger.warn("automations.cloud_home_pass_failed", { error: message(error) });
        } finally {
          running = false;
          current = null;
        }
      })();
      await current;
    },

    /** The runtime is closing: no pass starts again, and the one running is waited on. */
    async dispose(): Promise<void> {
      disposed = true;
      await current;
    },

    /**
     * Every cloud-homed rule is sent again on the next pass, so the server
     * reads the account's vault facts (agent limits, GitHub sign-in) again
     * for rules that didn't change. The server writes nothing else when the
     * rule is the same.
     */
    async resendAll(): Promise<void> {
      sent.forEach((record, accountId) => sent.set(accountId, { ...record, key: "" }));
      await this.reconcile();
    },

    /**
     * What the server says about a cloud-homed rule, from the last read. A
     * read older than a minute starts a new one in the background (only while
     * someone lists rules), and `onStateChanged` says when it brought news.
     */
    stateFor(ruleId: string): AutomationCloudHomeState | null {
      if (now() - serverReadAt >= SERVER_READ_EVERY_MS) void readServer();
      const serverId = serverIdOf(automationRuleAccountId(ruleId));
      return serverId ? states?.get(serverId) ?? null : null;
    },

    /** Run now for a cloud-homed rule: ADE's server starts it on its own cloud computer. */
    async runNow(rule: Pick<AutomationRule, "id" | "execution">): Promise<AutomationRun> {
      const api = deps.api();
      if (!api) throw new Error("Sign in to your ADE account to run this on ADE Cloud.");
      const serverId = serverIdOf(automationRuleAccountId(rule.id));
      if (!serverId) throw new Error("This project has no GitHub remote, so it can't run on ADE Cloud.");
      const run = await api.runAutomation(serverId);
      serverReadAt = 0;
      deps.onStateChanged();
      return automationRunOf(rule, run);
    },

    /** A rule deleted here: its server copy goes now, whatever this process sent before. */
    async forget(rule: Pick<ConfigAutomationRule, "id" | "home" | "triggers" | "trigger">): Promise<void> {
      if (!isAdeCloudHome(rule.home)) return;
      const api = deps.api();
      if (!api) return;
      const accountId = serverIdOf(automationRuleAccountId(rule.id));
      if (!accountId) return;
      try {
        await unregister(api, accountId, webhookIdOf(rule));
        sent.delete(accountId);
      } catch (error) {
        deps.logger.warn("automations.cloud_home_unregister_failed", { automationId: rule.id, error: message(error) });
      }
    },
  };
}

export type AutomationCloudRegistrar = ReturnType<typeof createAutomationCloudRegistrar>;

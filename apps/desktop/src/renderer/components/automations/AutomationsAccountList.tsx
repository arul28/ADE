import { useCallback, useEffect, useMemo, useState } from "react";
import { Cloud, Desktop, Lightning } from "@phosphor-icons/react";
import type { CloudAutomationRun, CloudAutomationSummary } from "../../../../../account-directory/src/cloud/contract";
import type { AccountSettingRow, AutomationRuleHome, ConfigAutomationRule } from "../../../shared/types";
import { accountRepoScopeKey } from "../../../shared/accountSettingsScope";
import { ADE_CLOUD_NAME } from "../../../shared/adeCloudMachine";
import { savedAgoLabel, useAdeCloudAccountRead } from "../../lib/adeCloudAccountRead";
import { AccountReadFailed } from "../adeCloud/AccountReadFailed";
import { cn } from "../ui/cn";
import { cardCls } from "./designTokens";
import { cronSentence } from "./cronDescribe";
import { eventLabel } from "./triggerCatalog";

/**
 * Automations with no computer of the person's own online: the tab is bound
 * to ADE Cloud. The list comes from the account: every rule that follows the
 * account (the `automations.rule.*` account settings of this repository) and,
 * for rules whose home is ADE Cloud, the server's copy with its last runs
 * (`GET /cloud/automations`). Read-only: a rule is saved and edited by an
 * ADE that runs rules (a computer), so this view says so instead of an editor.
 */

const RULE_PREFIX = "automations.rule.";
const HOME_PREFIX = "automations.home.";

type SettingsRead =
  | { status: "loading" }
  | { status: "ready"; rows: AccountSettingRow[] }
  | { status: "unavailable" }
  | { status: "failed"; message: string };

/** The repository's account settings rows, read once per open (and on Retry). */
function useRepositorySettings(scope: string | null, attempt: number): SettingsRead {
  const [read, setRead] = useState<SettingsRead>({ status: "loading" });
  useEffect(() => {
    const list = window.ade?.accountSettings?.list;
    if (!scope || typeof list !== "function") {
      setRead({ status: "unavailable" });
      return;
    }
    let cancelled = false;
    setRead({ status: "loading" });
    list({ scope }).then(
      (answer) => {
        if (cancelled) return;
        if (answer.ok) setRead({ status: "ready", rows: answer.value });
        else setRead({ status: "unavailable" });
      },
      (error: unknown) => {
        if (!cancelled) setRead({ status: "failed", message: error instanceof Error ? error.message : "ADE couldn't read your account settings." });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [scope, attempt]);
  return read;
}

type AccountRuleRow = {
  key: string;
  name: string;
  enabled: boolean;
  trigger: string;
  home: { cloud: boolean; name: string | null };
  cloud: CloudAutomationSummary | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function triggerText(rule: ConfigAutomationRule): string {
  const trigger = rule.triggers?.[0] ?? rule.trigger;
  if (!trigger?.type) return "a trigger";
  if (trigger.type === "schedule") return trigger.cron ? cronSentence(trigger.cron) : "on a schedule";
  return eventLabel(trigger.type);
}

function rowsOf(settings: AccountSettingRow[], cloud: CloudAutomationSummary[]): AccountRuleRow[] {
  const homes = new Map<string, AutomationRuleHome>();
  for (const row of settings) {
    if (!row.key.startsWith(HOME_PREFIX)) continue;
    const home = record(row.value);
    if (home && typeof home.deviceId === "string") homes.set(row.key.slice(HOME_PREFIX.length), home as unknown as AutomationRuleHome);
  }
  // A cloud rule's server id is not its rule id; a unique name ties the two.
  const cloudByName = new Map<string, CloudAutomationSummary | null>();
  for (const summary of cloud) cloudByName.set(summary.name, cloudByName.has(summary.name) ? null : summary);
  const used = new Set<CloudAutomationSummary>();
  const rows: AccountRuleRow[] = [];
  for (const row of settings) {
    if (!row.key.startsWith(RULE_PREFIX)) continue;
    const rule = record(row.value) as ConfigAutomationRule | null;
    if (!rule) continue;
    const id = row.key.slice(RULE_PREFIX.length);
    const home = homes.get(id) ?? rule.home ?? null;
    const name = rule.name?.trim() || "Untitled automation";
    const onCloud = home?.kind === "cloud";
    const summary = onCloud ? cloudByName.get(name) ?? null : null;
    if (summary) used.add(summary);
    rows.push({
      key: id,
      name,
      enabled: summary ? summary.enabled : rule.enabled !== false,
      trigger: triggerText(rule),
      home: { cloud: onCloud, name: onCloud ? ADE_CLOUD_NAME : home?.name?.trim() || null },
      cloud: summary,
    });
  }
  // A cloud rule whose account row did not come back (an older computer saved it) still shows.
  for (const summary of cloud) {
    if (used.has(summary)) continue;
    rows.push({ key: `cloud:${summary.ruleId}`, name: summary.name, enabled: summary.enabled, trigger: "its trigger", home: { cloud: true, name: ADE_CLOUD_NAME }, cloud: summary });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

const RUN_WORD: Record<CloudAutomationRun["state"], string> = {
  queued: "Waiting",
  starting: "Starting",
  running: "Running",
  finishing: "Finishing",
  done: "Finished",
  failed: "Failed",
  skipped: "Skipped",
};

function runTone(state: CloudAutomationRun["state"]): string {
  if (state === "failed") return "text-red-300";
  if (state === "done") return "text-emerald-300";
  if (state === "skipped") return "text-fg/45";
  return "text-sky-300";
}

export function AutomationsAccountList({ origin, active }: { origin: string | null; active: boolean }): JSX.Element {
  const scope = accountRepoScopeKey(origin);
  const [attempt, setAttempt] = useState(0);
  const settings = useRepositorySettings(active ? scope : null, attempt);
  const { state: cloud, retry: retryCloud } = useAdeCloudAccountRead(
    active && origin ? { call: "automations" as const, origin } : null,
  );
  const retry = useCallback(() => {
    setAttempt((value) => value + 1);
    retryCloud();
  }, [retryCloud]);

  const loading = settings.status === "loading" || cloud.status === "loading" || cloud.status === "idle";
  const cloudRows = cloud.status === "ready" ? cloud.data : [];
  const settingsRows = settings.status === "ready" ? settings.rows : [];
  const rows = useMemo(() => rowsOf(settingsRows, cloudRows), [cloudRows, settingsRows]);
  // Nothing could be read at all: say so, never an empty list.
  const nothingRead = (settings.status === "failed" || settings.status === "unavailable")
    && (cloud.status === "failed" || cloud.status === "unsupported");
  const partialFailure = !nothingRead && (settings.status === "failed" || cloud.status === "failed");

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto px-6 py-5" data-testid="automations-account-list">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4">
        <div>
          <h2 className="text-[15px] font-semibold text-fg">Automations</h2>
          <p className="mt-1 text-[12px] leading-relaxed text-muted-fg/75">
            Rules that follow your account, as your account has them. Rules that run on {ADE_CLOUD_NAME} keep running with
            no computer on. To add or edit a rule, open this project on one of your computers.
          </p>
        </div>

        {nothingRead ? (
          <AccountReadFailed
            id="automations-account"
            what="this repository's automations"
            code={cloud.status === "failed" ? cloud.code : "unavailable"}
            message={cloud.status === "failed"
              ? cloud.message
              : settings.status === "failed" ? settings.message : "Your ADE account didn't answer. Try again."}
            onRetry={retry}
          />
        ) : null}
        {partialFailure ? (
          <AccountReadFailed
            id="automations-account-part"
            what={cloud.status === "failed" ? "the runs on ADE Cloud" : "every rule"}
            code={cloud.status === "failed" ? cloud.code : "unavailable"}
            message={cloud.status === "failed" ? cloud.message : settings.status === "failed" ? settings.message : ""}
            onRetry={retry}
          />
        ) : null}

        {loading && rows.length === 0 && !nothingRead ? (
          <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading automations">
            {[0, 1, 2].map((index) => <div key={index} className="h-[58px] animate-pulse rounded-lg bg-fg/[0.04]" />)}
          </div>
        ) : null}

        {!loading && !nothingRead && rows.length === 0 && !partialFailure ? (
          <div className="rounded-lg border border-border/40 px-4 py-6 text-center">
            <Lightning size={22} className="mx-auto text-muted-fg/55" />
            <div className="mt-2 text-[13px] font-semibold text-fg">No automations in this repository yet</div>
            <div className="mt-1 text-[11.5px] text-muted-fg/70">Open the project on one of your computers to make one.</div>
          </div>
        ) : null}

        {rows.length ? (
          <ul className="flex flex-col gap-2">
            {rows.map((row) => <AccountRuleItem key={row.key} row={row} />)}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function AccountRuleItem({ row }: { row: AccountRuleRow }): JSX.Element {
  const HomeIcon = row.home.cloud ? Cloud : Desktop;
  const nextFire = row.cloud?.nextFireAt ? new Date(row.cloud.nextFireAt) : null;
  const runs = row.cloud?.runs.slice(0, 3) ?? [];
  return (
    <li className={cn(cardCls, "flex flex-col gap-1.5 px-3.5 py-3")} data-testid="automations-account-rule">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-fg">{row.name}</span>
        <span className={cn("shrink-0 text-[11px]", row.enabled ? "text-emerald-300/90" : "text-muted-fg/60")}>
          {row.cloud?.pausedReason === "storm" ? "Paused after too many runs" : row.enabled ? "On" : "Off"}
        </span>
      </div>
      <div className="text-[11.5px] leading-relaxed text-muted-fg/80">
        <span className="text-muted-fg/60">When </span>{row.trigger}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-fg/70">
        <span className="inline-flex items-center gap-1">
          <HomeIcon size={12} />
          {row.home.name ? `Runs on ${row.home.name}` : "Runs on one of your computers"}
          {!row.home.cloud ? " (not on now)" : ""}
        </span>
        {nextFire && row.enabled ? (
          <span>Next run {nextFire.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
        ) : null}
      </div>
      {runs.length ? (
        <ul className="mt-1 flex flex-col gap-0.5 border-t border-border/30 pt-1.5">
          {runs.map((run) => (
            <li key={run.runId} className="flex min-w-0 items-center gap-2 text-[11px]">
              <span className={cn("shrink-0 font-medium", runTone(run.state))}>{RUN_WORD[run.state]}</span>
              <span className="min-w-0 flex-1 truncate text-muted-fg/70">{run.reason ?? run.trigger.summary ?? ""}</span>
              <span className="shrink-0 text-muted-fg/55">{savedAgoLabel(run.startedAt ?? run.createdAt, "Started")}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

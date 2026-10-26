import React from "react";
import { CaretDown } from "@phosphor-icons/react";
import {
  DEFAULT_CLEAN_BUILD_OUTPUT_AFTER_DAYS,
  type LaneBuildOutputSummary,
  type MaintenanceRunReport,
} from "../../../../shared/types/storage";
import type { LaneCleanupConfig } from "../../../../shared/types";
import { ModernRow, ModernRows, ModernSection, SettingsNumber } from "../primitives";
import { showToast } from "../../app/toast/toastStore";
import { relativeWhen } from "../../../lib/format";
import {
  cleanupPartsLine,
  cleanupRunParts,
  formatBytes,
  formatMeasuredBytes,
  formatRunClock,
  journalEntries,
  maintenanceActionLines,
} from "../storage/storageView";
import { CleanupRunChart, type RunColumn } from "./healthCharts";
import type { HealthData } from "./useHealthData";

const TRIGGER_LABEL: Record<MaintenanceRunReport["trigger"], string> = {
  manual: "You ran it",
  daily: "Daily",
  post_boot: "After ADE started",
  post_migration: "After an update",
};

function runKey(run: MaintenanceRunReport, index: number): string {
  return `${run.startedAt}:${index}`;
}

/** Runs listed before "Show N more"; the chart above already shows them all. */
const INITIAL_RUNS = 5;

function CleanupHistory({ runs, loading }: { runs: MaintenanceRunReport[]; loading: boolean }) {
  const [showAll, setShowAll] = React.useState(false);
  const columns = React.useMemo<RunColumn[]>(() => [...runs].slice(0, 14).reverse().map((run, index) => {
    const parts = cleanupRunParts(run);
    return {
      key: runKey(run, index),
      label: formatRunClock(run.finishedAt || run.startedAt),
      ...parts,
      failed: run.actions.some((action) => Boolean(action.error)),
    };
  }), [runs]);
  const total = runs.reduce((sum, run) => sum + cleanupRunParts(run).total, 0);

  return (
    <ModernSection
      group="Cleanups"
      anchor="storage-cleanups"
      title="Cleanups"
      hint={loading
        ? "Loading cleanup history…"
        : runs.length > 0
        ? `${runs.length === 1 ? "1 cleanup" : `${runs.length} cleanups`} freed ${formatBytes(total)}. The last ran ${relativeWhen(runs[0]!.finishedAt || runs[0]!.startedAt)}.`
        : "ADE tidies its own data every day. Files you clean up from Storage show here too."}
    >
      {runs.length > 0 ? (
        <>
          <div className="ade-health-chart-panel">
            <CleanupRunChart runs={columns} />
          </div>
          <ul className="ade-modern-rows ade-health-runlist">
            {(showAll ? runs : runs.slice(0, INITIAL_RUNS)).map((run, index) => {
              const parts = cleanupRunParts(run);
              const breakdown = cleanupPartsLine(parts);
              const failures = maintenanceActionLines(run).filter((line) => line.failed);
              return (
                <li key={runKey(run, index)} className="ade-health-run">
                  <div className="ade-health-run-main">
                    <span className="ade-health-run-when">{formatRunClock(run.finishedAt || run.startedAt)}</span>
                    <span className="ade-modern-muted">{TRIGGER_LABEL[run.trigger]}</span>
                    <span className="ade-health-run-total kit-num">
                      {parts.total > 0 ? formatBytes(parts.total) : "Nothing to free"}
                    </span>
                  </div>
                  {breakdown || failures.length > 0 ? (
                    <div className="ade-health-run-sub">
                      {breakdown ? <span className="kit-num">{breakdown}</span> : null}
                      {failures.map((line, lineIndex) => (
                        <span key={`${line.ledgerId}-${lineIndex}`} style={{ color: "var(--kit-warn)" }}>
                          {line.label} couldn&apos;t finish
                        </span>
                      ))}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {!showAll && runs.length > INITIAL_RUNS ? (
            <button type="button" className="ade-health-disclosure" onClick={() => setShowAll(true)}>
              <CaretDown size={11} weight="bold" className="ade-health-caret" />
              Show {runs.length - INITIAL_RUNS} more
            </button>
          ) : null}
        </>
      ) : null}
    </ModernSection>
  );
}

type PolicyKey = keyof Pick<LaneCleanupConfig, "maxActiveLanes" | "autoArchiveAfterHours" | "cleanupIntervalHours" | "reclaimArchivedAfterHours">;

/**
 * The archive-idle-lanes rules. Each field shows the value in force. A rule
 * set on this machine has a Reset; one that isn't comes from the project's
 * shared settings, which the section says once instead of tagging every row
 * "Inherited". Zero means off, and reads "Off".
 */
function ArchivePolicy({
  value,
  effectiveValue,
  lastScanAt,
  busy,
  onChange,
}: {
  value: LaneCleanupConfig;
  effectiveValue: LaneCleanupConfig;
  lastScanAt: string | null;
  busy: boolean;
  onChange: (value: LaneCleanupConfig) => void;
}) {
  const shown = (key: PolicyKey) => value[key] ?? effectiveValue[key] ?? 0;
  const checksOn = shown("cleanupIntervalHours") > 0;
  const archivesSomething = shown("maxActiveLanes") > 0 || shown("autoArchiveAfterHours") > 0;
  const status = !checksOn
    ? "Off. ADE never archives a lane on its own."
    : !archivesSomething
      ? `Checks every ${shown("cleanupIntervalHours")} hours, but no rule archives anything yet.`
      : `On. ADE checks every ${shown("cleanupIntervalHours")} hours${lastScanAt ? `; last check ${relativeWhen(lastScanAt)}` : ""}.`;
  const anyLocal = (["maxActiveLanes", "autoArchiveAfterHours", "cleanupIntervalHours", "reclaimArchivedAfterHours"] as const)
    .some((key) => value[key] != null);

  const field = (key: PolicyKey, label: string, help: string, offLabel: string, suffix: string) => {
    const local = value[key];
    return (
      <ModernRow
        key={key}
        title={label}
        hint={help}
        control={(
          <>
            {local != null ? (
              <button
                type="button"
                className="ade-modern-btn"
                data-variant="link"
                style={{ fontSize: 11.5 }}
                onClick={() => onChange({ ...value, [key]: undefined })}
              >
                Reset
              </button>
            ) : null}
            <SettingsNumber
              ariaLabel={label}
              value={shown(key)}
              min={0}
              suffix={suffix}
              sentinelLabel={offLabel}
              sentinelValue={0}
              onChange={(next) => onChange({ ...value, [key]: Math.max(0, Math.floor(next)) })}
            />
          </>
        )}
      />
    );
  };

  return (
    <ModernSection
      group="Cleanups"
      anchor="lane-storage-rules"
      title="Archive idle lanes"
      hint={status}
      actions={busy ? <span className="ade-modern-muted">Saving…</span> : undefined}
    >
      <ModernRows>
        {field("cleanupIntervalHours", "Check every", "How often ADE looks for idle lanes. Off turns the rules below off.", "Off", "hours")}
        {field("autoArchiveAfterHours", "Archive after inactivity", "Hours without activity before a lane may be archived.", "Off", "hours")}
        {field("maxActiveLanes", "Keep at most", "Archive the longest-idle lanes above this many.", "No limit", "lanes")}
        {field("reclaimArchivedAfterHours", "Offer to remove archived folders after", "Archived lane folders show in Storage for you to remove. ADE never removes them itself.", "Off", "hours")}
      </ModernRows>
      <p className="ade-modern-muted">
        Only clean, merged, idle lanes with nothing running are archived, never the primary lane. Their branch, chats and files stay.
        {anyLocal ? " Rules without Reset use the project's shared value." : " Values come from the project's shared settings until you change one."}
      </p>
    </ModernSection>
  );
}

/**
 * The idle-lane build output rule, and what it removed: each lane's latest
 * cleanup, newest first, with the folders that went and any that could not.
 * On by default; the value comes from local.yaml, then the project's shared
 * settings, then the default, like the archive rules.
 */
function BuildOutputPolicy({
  value,
  effectiveValue,
  summary,
  busy,
  onChange,
}: {
  value: LaneCleanupConfig;
  effectiveValue: LaneCleanupConfig;
  summary: LaneBuildOutputSummary | null;
  busy: boolean;
  onChange: (value: LaneCleanupConfig) => void;
}) {
  const local = value.cleanBuildOutputAfterDays;
  const days = local ?? effectiveValue.cleanBuildOutputAfterDays ?? DEFAULT_CLEAN_BUILD_OUTPUT_AFTER_DAYS;
  const lanes = summary?.lanes ?? [];
  const freed = summary && (summary.totalFreedBytes > 0 || summary.totalPartial)
    ? `Freed ${formatMeasuredBytes(summary.totalFreedBytes, summary.totalPartial)}${summary.since ? ` since ${new Date(summary.since).toLocaleDateString()}` : ""}`
    : "Nothing removed yet";
  const status = days <= 0
    ? "Off. ADE keeps build output in idle lanes."
    : `On. ${freed}${summary?.lastCheckAt ? `; last check ${relativeWhen(summary.lastCheckAt)}` : ""}.`;
  const label = "Remove after";
  return (
    <ModernSection
      group="Cleanups"
      anchor="lane-build-output"
      title="Clean build output from idle lanes"
      hint={status}
      actions={busy ? <span className="ade-modern-muted">Saving…</span> : undefined}
    >
      <ModernRows>
        <ModernRow
          title={label}
          hint="Days a lane sits idle first. A reinstall or build brings the folders back."
          control={(
            <>
              {local != null ? (
                <button
                  type="button"
                  className="ade-modern-btn"
                  data-variant="link"
                  style={{ fontSize: 11.5 }}
                  onClick={() => onChange({ ...value, cleanBuildOutputAfterDays: undefined })}
                >
                  Reset
                </button>
              ) : null}
              <SettingsNumber
                ariaLabel={label}
                value={days}
                min={0}
                suffix="days"
                sentinelLabel="Off"
                sentinelValue={0}
                onChange={(next) => onChange({ ...value, cleanBuildOutputAfterDays: Math.max(0, Math.floor(next)) })}
              />
            </>
          )}
        />
      </ModernRows>
      {lanes.length > 0 ? (
        <ul className="ade-modern-rows ade-health-runlist">
          {lanes.map((lane) => (
            <li key={`${lane.laneId}:${lane.removedAt}`} className="ade-health-run">
              <div className="ade-health-run-main">
                <span className="ade-health-run-when">{lane.laneName}</span>
                <span className="ade-modern-muted">{relativeWhen(lane.removedAt)}</span>
                <span className="ade-health-run-total kit-num">
                  {lane.bytes > 0 || lane.partial ? formatMeasuredBytes(lane.bytes, lane.partial) : "Nothing freed"}
                </span>
              </div>
              <div className="ade-health-run-sub">
                {lane.folders.length > 0 ? <span>{lane.folders.join(", ")}</span> : null}
                {lane.failures.map((failure) => (
                  <span key={failure.folder} style={{ color: "var(--kit-warn)" }}>
                    {failure.folder} stayed: {failure.reason}
                  </span>
                ))}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="ade-modern-muted">
        Only folders git ignores and tracks nothing in, like node_modules, dist, .next and Cargo target. Lanes with a chat, terminal or program running are skipped.
      </p>
    </ModernSection>
  );
}

/**
 * The cleanup history (`show="history"`, under Space) or the lane cleanup
 * rules (`show="rules"`, under Rules).
 */
export function HealthCleanups({ data, show }: { data: HealthData; show: "history" | "rules" }) {
  const runs = React.useMemo(() => journalEntries(data.storage.snapshot?.extras, 30), [data.storage.snapshot]);
  const [busy, setBusy] = React.useState(false);
  const pending = React.useRef<{ timer: ReturnType<typeof setTimeout>; value: LaneCleanupConfig } | null>(null);
  const { savePolicy, setPolicy, loadStorage } = data;

  const save = React.useCallback(async (next: LaneCleanupConfig) => {
    setBusy(true);
    try {
      await savePolicy(next);
      void loadStorage({ force: true, silent: true });
    } catch (err) {
      showToast({ tone: "error", title: "Couldn't save the archive rules", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }, [loadStorage, savePolicy]);

  // Rules save as you edit, debounced so typing "120" doesn't write 1, 12,
  // then 120. Leaving the tab saves a pending edit instead of dropping it.
  const commit = React.useCallback((next: LaneCleanupConfig) => {
    setPolicy(next);
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = {
      value: next,
      timer: setTimeout(() => {
        pending.current = null;
        void save(next);
      }, 600),
    };
  }, [save, setPolicy]);

  React.useEffect(() => () => {
    const queued = pending.current;
    if (!queued) return;
    clearTimeout(queued.timer);
    pending.current = null;
    void savePolicy(queued.value).catch(() => undefined);
  }, [savePolicy]);

  return show === "history" ? (
    <CleanupHistory runs={runs} loading={data.storage.loading && !data.storage.snapshot} />
  ) : (
    <>
      <ArchivePolicy
        value={data.storage.policy}
        effectiveValue={data.storage.effectivePolicy}
        lastScanAt={data.storage.snapshot?.lifecycle?.lastScanAt ?? null}
        busy={busy}
        onChange={commit}
      />
      <BuildOutputPolicy
        value={data.storage.policy}
        effectiveValue={data.storage.effectivePolicy}
        summary={data.storage.snapshot?.lifecycle?.buildOutput ?? null}
        busy={busy}
        onChange={commit}
      />
    </>
  );
}

import React from "react";
import { CaretDown } from "@phosphor-icons/react";
import {
  DEFAULT_CLEAN_BUILD_OUTPUT_AFTER_DAYS,
  type LaneBuildOutputSummary,
  type MaintenanceRunReport,
  type StorageLifecycleRunReport,
} from "../../../../shared/types/storage";
import type { LaneCleanupConfig, LaneFreeUpSpaceMode } from "../../../../shared/types";
import { resolveLaneCleanupPolicy } from "../../../../shared/laneCleanup";
import { ModernRow, ModernRows, ModernSection, SettingsNumber, SettingsSegmented, SettingsToggle } from "../primitives";
import { showToast } from "../../app/toast/toastStore";
import { relativeWhen } from "../../../lib/format";
import {
  cleanupPartsLine,
  cleanupRunParts,
  formatRunClock,
  journalEntries,
  maintenanceActionLines,
} from "../storage/storageView";
import { CleanupRunChart, type RunColumn } from "./healthCharts";
import { useStorageBytes } from "../storage/useStorageBytes";
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
  const { bytes: storageBytes, platform } = useStorageBytes();
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
        ? `${runs.length === 1 ? "1 cleanup" : `${runs.length} cleanups`} freed ${storageBytes(total)}. The last ran ${relativeWhen(runs[0]!.finishedAt || runs[0]!.startedAt)}.`
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
              const breakdown = cleanupPartsLine(parts, platform);
              const failures = maintenanceActionLines(run).filter((line) => line.failed);
              return (
                <li key={runKey(run, index)} className="ade-health-run">
                  <div className="ade-health-run-main">
                    <span className="ade-health-run-when">{formatRunClock(run.finishedAt || run.startedAt)}</span>
                    <span className="ade-modern-muted">{TRIGGER_LABEL[run.trigger]}</span>
                    <span className="ade-health-run-total kit-num">
                      {parts.total > 0 ? storageBytes(parts.total) : "Nothing to free"}
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

/** Lanes listed under "Last run" before "Show N more". */
const INITIAL_RUN_LANES = 6;

/**
 * What the archive rules' last check did: one plain sentence per lane it
 * looked at (archived, kept and why, or what went wrong). This list is the
 * one place those results show; a check never raises a toast for a lane it
 * kept or could not archive.
 */
function LifecycleLastRun({ run }: { run: StorageLifecycleRunReport }) {
  const [showAll, setShowAll] = React.useState(false);
  const count = (outcome: StorageLifecycleRunReport["lanes"][number]["outcome"]) =>
    run.lanes.filter((lane) => lane.outcome === outcome).length;
  const lanesWord = (n: number) => (n === 1 ? "1 lane" : `${n} lanes`);
  const archived = count("archived");
  const freed = count("freed");
  const deleted = count("deleted");
  const failed = count("failed");
  const when = run.finishedAt ?? run.startedAt;
  const parts = [
    archived > 0 ? `archived ${lanesWord(archived)}` : freed + deleted > 0 ? null : "archived nothing",
    freed > 0 ? `freed up space from ${lanesWord(freed)}` : null,
    deleted > 0 ? `deleted ${lanesWord(deleted)}` : null,
    failed > 0 ? `${lanesWord(failed)} couldn't be checked or cleaned up` : null,
    run.recentlyUsedCount > 0 ? `${run.recentlyUsedCount === 1 ? "1 lane was" : `${run.recentlyUsedCount} lanes were`} used recently` : null,
  ].filter(Boolean);
  const lanes = showAll ? run.lanes : run.lanes.slice(0, INITIAL_RUN_LANES);
  return (
    <div>
      <p className="ade-modern-muted">
        Last run {relativeWhen(when)}: {parts.join("; ")}.
        {run.error ? <span style={{ color: "var(--kit-warn)" }}> {run.error}</span> : null}
      </p>
      {lanes.length > 0 ? (
        <ul className="ade-modern-rows ade-health-runlist">
          {lanes.map((lane) => (
            <li key={lane.laneId} className="ade-health-run">
              <div className="ade-health-run-main">
                <span className="ade-health-run-when">{lane.laneName}</span>
                <span
                  className={lane.outcome === "failed" ? undefined : "ade-modern-muted"}
                  style={lane.outcome === "failed" ? { color: "var(--kit-warn)" } : undefined}
                >
                  {lane.detail}
                </span>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {!showAll && run.lanes.length > INITIAL_RUN_LANES ? (
        <button type="button" className="ade-health-disclosure" onClick={() => setShowAll(true)}>
          <CaretDown size={11} weight="bold" className="ade-health-caret" />
          Show {run.lanes.length - INITIAL_RUN_LANES} more
        </button>
      ) : null}
    </div>
  );
}

type DayKey = keyof Pick<LaneCleanupConfig, "archiveIdleAfterDays" | "freeUpSpaceAfterDays" | "deleteArchivedAfterDays">;

/** "Reset" beside a rule set on this machine; a rule without it uses the project's shared value. */
function ResetButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="ade-modern-btn"
      data-variant="link"
      style={{ fontSize: 11.5 }}
      onClick={onClick}
    >
      Reset
    </button>
  );
}

/**
 * The lane cleanup rules this machine sets, over the project's shared ones
 * and the defaults. `value` is local.yaml; `effectiveValue` what is in force.
 */
function policyFields(value: LaneCleanupConfig, effectiveValue: LaneCleanupConfig, onChange: (value: LaneCleanupConfig) => void) {
  const shown = resolveLaneCleanupPolicy({ ...effectiveValue, ...stripUnset(value) });
  const dayField = (key: DayKey, label: string, hint: React.ReactNode, extra?: React.ReactNode, resetAlso: Array<keyof LaneCleanupConfig> = []) => (
    <ModernRow
      key={key}
      title={label}
      hint={hint}
      control={(
        <>
          {value[key] != null || resetAlso.some((other) => value[other] != null) ? (
            <ResetButton
              onClick={() => onChange({ ...value, [key]: undefined, ...Object.fromEntries(resetAlso.map((other) => [other, undefined])) })}
            />
          ) : null}
          {extra}
          <SettingsNumber
            ariaLabel={label}
            value={shown[key]}
            min={0}
            suffix="days"
            sentinelLabel="Off"
            sentinelValue={0}
            onChange={(next) => onChange({ ...value, [key]: Math.max(0, Math.floor(next)) })}
          />
        </>
      )}
    />
  );
  return { shown, dayField };
}

function stripUnset(value: LaneCleanupConfig): LaneCleanupConfig {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry != null)) as LaneCleanupConfig;
}

function sharedNote(value: LaneCleanupConfig, keys: Array<keyof LaneCleanupConfig>): string {
  return keys.some((key) => value[key] != null)
    ? "Rules without Reset use the project's shared value."
    : "Values come from the project's shared settings until you change one.";
}

/**
 * Archive lanes automatically: one rule, in days. The check runs about every
 * hour while any lane rule is on; "Last run" says what it did, lane by lane.
 */
function ArchivePolicy({
  value,
  effectiveValue,
  lastScanAt,
  lastRun,
  busy,
  onChange,
}: {
  value: LaneCleanupConfig;
  effectiveValue: LaneCleanupConfig;
  lastScanAt: string | null;
  lastRun: StorageLifecycleRunReport | null;
  busy: boolean;
  onChange: (value: LaneCleanupConfig) => void;
}) {
  const { shown, dayField } = policyFields(value, effectiveValue, onChange);
  const status = shown.archiveIdleAfterDays <= 0
    ? "Off. ADE never archives a lane on its own."
    : `On. ADE checks about every hour${lastScanAt ? `; last check ${relativeWhen(lastScanAt)}` : ""}.`;
  return (
    <ModernSection
      group="Cleanups"
      anchor="lane-storage-rules"
      title="Archive lanes automatically"
      hint={status}
      actions={busy ? <span className="ade-modern-muted">Saving…</span> : undefined}
    >
      <ModernRows>
        {dayField(
          "archiveIdleAfterDays",
          "Archive idle lanes after",
          "Days without activity. Only lanes with nothing unsaved whose work is merged are archived, never the primary lane.",
        )}
      </ModernRows>
      {lastRun ? <LifecycleLastRun run={lastRun} /> : null}
      <p className="ade-modern-muted">
        Archiving hides a lane and deletes nothing: its branch, chats and files stay, and Restore brings it back.
        {" "}{sharedNote(value, ["archiveIdleAfterDays"])}
      </p>
    </ModernSection>
  );
}

const FREE_UP_MODES = [
  { value: "ask", label: "Ask me" },
  { value: "auto", label: "Automatically" },
] as const satisfies ReadonlyArray<{ value: LaneFreeUpSpaceMode; label: string }>;

/**
 * What cleanup does to a lane once it is archived: free up its space (the
 * folder goes, the branch and chats stay), and delete it. Both count days
 * from when the lane was archived.
 */
function ArchivedLanesPolicy({
  value,
  effectiveValue,
  freeUpDueCount,
  busy,
  onChange,
}: {
  value: LaneCleanupConfig;
  effectiveValue: LaneCleanupConfig;
  freeUpDueCount: number;
  busy: boolean;
  onChange: (value: LaneCleanupConfig) => void;
}) {
  const { shown, dayField } = policyFields(value, effectiveValue, onChange);
  const freeUpOn = shown.freeUpSpaceAfterDays > 0;
  const deleteOn = shown.deleteArchivedAfterDays > 0;
  const freeUpPart = !freeUpOn
    ? "ADE keeps archived lane folders"
    : shown.freeUpSpaceMode === "auto"
      ? `ADE frees up their space after ${shown.freeUpSpaceAfterDays} days`
      : `ADE asks to free up their space after ${shown.freeUpSpaceAfterDays} days`;
  const deletePart = deleteOn ? `deletes them after ${shown.deleteArchivedAfterDays} days` : "never deletes them";
  const due = freeUpDueCount > 0
    ? ` ${freeUpDueCount === 1 ? "1 lane is" : `${freeUpDueCount} lanes are`} due to free up; see Archive.`
    : "";
  return (
    <ModernSection
      group="Cleanups"
      anchor="archived-lanes"
      title="Archived lanes"
      hint={`${freeUpPart}, and ${deletePart}.${due}`}
      actions={busy ? <span className="ade-modern-muted">Saving…</span> : undefined}
    >
      <ModernRows>
        {dayField(
          "freeUpSpaceAfterDays",
          "Free up space after",
          shown.freeUpSpaceMode === "auto"
            ? "Days after archiving. ADE removes the lane's folder; its branch and chats stay, and Restore recreates the folder. Never with uncommitted or unpushed work; files in use are kept and tried again."
            : "Days after archiving. Nothing is removed: the archive reminder and Settings → Archive point at the lane, and Free up space there removes its folder. Its branch and chats stay.",
          <SettingsSegmented
            ariaLabel="Free up space"
            value={shown.freeUpSpaceMode}
            options={FREE_UP_MODES}
            disabled={!freeUpOn}
            onChange={(next) => onChange({ ...value, freeUpSpaceMode: next })}
          />,
          ["freeUpSpaceMode"],
        )}
        {dayField(
          "deleteArchivedAfterDays",
          "Delete after",
          "Days after archiving. Never a lane with uncommitted or unpushed work, an open PR or anything running. Its chats go to Recently deleted.",
        )}
        <ModernRow
          title="Also delete its local branch"
          hint="Only with Delete after. Every commit is on a remote by then. The remote branch is never deleted."
          control={(
            <>
              {value.deleteLocalBranchOnAutoDelete != null ? (
                <ResetButton onClick={() => onChange({ ...value, deleteLocalBranchOnAutoDelete: undefined })} />
              ) : null}
              <SettingsToggle
                label="Also delete its local branch"
                checked={shown.deleteLocalBranchOnAutoDelete}
                disabled={!deleteOn}
                onChange={(next) => onChange({ ...value, deleteLocalBranchOnAutoDelete: next })}
              />
            </>
          )}
        />
      </ModernRows>
      <p className="ade-modern-muted">
        Never the primary lane. {sharedNote(value, ["freeUpSpaceAfterDays", "freeUpSpaceMode", "deleteArchivedAfterDays", "deleteLocalBranchOnAutoDelete"])}
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
  const { measured: storageMeasured } = useStorageBytes();
  const local = value.cleanBuildOutputAfterDays;
  const days = local ?? effectiveValue.cleanBuildOutputAfterDays ?? DEFAULT_CLEAN_BUILD_OUTPUT_AFTER_DAYS;
  const lanes = summary?.lanes ?? [];
  const freed = summary && (summary.totalFreedBytes > 0 || summary.totalPartial)
    ? `Freed ${storageMeasured(summary.totalFreedBytes, summary.totalPartial)}${summary.since ? ` since ${new Date(summary.since).toLocaleDateString()}` : ""}`
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
                  {lane.bytes > 0 || lane.partial ? storageMeasured(lane.bytes, lane.partial) : "Nothing freed"}
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
        lastRun={data.storage.snapshot?.lifecycle?.lastRun ?? null}
        busy={busy}
        onChange={commit}
      />
      <ArchivedLanesPolicy
        value={data.storage.policy}
        effectiveValue={data.storage.effectivePolicy}
        freeUpDueCount={data.storage.snapshot?.lifecycle?.freeUpDueCount ?? 0}
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

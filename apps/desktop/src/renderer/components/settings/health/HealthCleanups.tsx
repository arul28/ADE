import React from "react";
import { ArrowElbowDownRight, CaretDown, Warning } from "@phosphor-icons/react";
import {
  type LaneBuildOutputSummary,
  type MaintenanceRunReport,
  type StorageLifecycleRunReport,
} from "../../../../shared/types/storage";
import type { LaneCleanupConfig, LaneFreeUpSpaceMode } from "../../../../shared/types";
import { resolveLaneCleanupPolicy } from "../../../../shared/laneCleanup";
import { ModernRow, ModernSection, SettingsSelect, SettingsToggle } from "../primitives";
import { showToast } from "../../app/toast/toastStore";
import { Banner } from "../../ui/notice";
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
import { captureLaneSetupAnalytics } from "../../../lib/laneSetupAnalytics";
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
              const failures = maintenanceActionLines(run, platform).filter((line) => line.failed);
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

/** Lanes listed under "Lane check" before "Show N more". */
const INITIAL_RUN_LANES = 6;

/**
 * What the lane rules' last check did: one plain sentence per lane it looked
 * at (archived, kept and why, or what went wrong). This list is the one place
 * those results show; a check never raises a toast for a lane it kept or
 * could not archive.
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
    <div className="ade-cleanup-activity-block">
      <div className="ade-cleanup-activity-head">
        <span className="ade-cleanup-activity-title">Lane check</span>
        <span className="ade-modern-muted">{relativeWhen(when)}: {parts.join("; ")}.</span>
      </div>
      {run.error ? (
        <Banner
          layout="inline"
          model={{
            id: "lane-lifecycle-run-error",
            tone: "error",
            title: "The last check couldn't finish",
            detail: run.error,
          }}
        />
      ) : null}
      {lanes.length > 0 ? (
        <ul className="ade-modern-rows ade-health-runlist">
          {lanes.map((lane) => (
            <li key={lane.laneId} className="ade-health-run">
              <div className="ade-health-run-main">
                <span className="ade-health-run-when">{lane.laneName}</span>
                <span className={lane.outcome === "failed" ? "ade-modern-warn" : "ade-modern-muted"}>
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

/** What the build output rule removed: each lane's latest cleanup, newest first. */
function BuildOutputActivity({ summary }: { summary: LaneBuildOutputSummary }) {
  const { measured: storageMeasured } = useStorageBytes();
  const freed = summary.totalFreedBytes > 0 || summary.totalPartial
    ? `Freed ${storageMeasured(summary.totalFreedBytes, summary.totalPartial)}${summary.since ? ` since ${new Date(summary.since).toLocaleDateString()}` : ""}.`
    : "Nothing removed yet.";
  return (
    <div className="ade-cleanup-activity-block">
      <div className="ade-cleanup-activity-head">
        <span className="ade-cleanup-activity-title">Build output</span>
        <span className="ade-modern-muted">{freed}</span>
      </div>
      {summary.lanes.length > 0 ? (
        <ul className="ade-modern-rows ade-health-runlist">
          {summary.lanes.map((lane) => (
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
    </div>
  );
}

/**
 * Run history, kept out of the rules: what the last lane check did and what
 * build output went. Folded by default.
 */
function RecentActivity({ lastRun, buildOutput }: { lastRun: StorageLifecycleRunReport | null; buildOutput: LaneBuildOutputSummary | null }) {
  const [open, setOpen] = React.useState(false);
  const hasBuildOutput = Boolean(buildOutput && (buildOutput.lanes.length > 0 || buildOutput.totalFreedBytes > 0));
  if (!lastRun && !hasBuildOutput) return null;
  return (
    <details className="ade-cleanup-activity" onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        <CaretDown size={11} weight="bold" className="ade-health-caret" data-open={open ? "" : undefined} />
        Recent activity
      </summary>
      {open ? (
        <div className="ade-cleanup-activity-body">
          {lastRun ? <LifecycleLastRun run={lastRun} /> : null}
          {buildOutput && hasBuildOutput ? <BuildOutputActivity summary={buildOutput} /> : null}
        </div>
      ) : null}
    </details>
  );
}

type DayKey = keyof Pick<
  LaneCleanupConfig,
  "archiveIdleAfterDays" | "freeUpSpaceAfterDays" | "deleteArchivedAfterDays" | "cleanBuildOutputAfterDays"
>;

/** The day counts every rule offers; any other saved count shows as its own option. */
const DAY_PRESETS = [1, 3, 7, 14, 30, 60, 90] as const;
const MAX_DAYS = 3650;
const CUSTOM_DAYS = "custom";

function daysLabel(days: number): string {
  if (days <= 0) return "Never";
  return days === 1 ? "After 1 day" : `After ${days} days`;
}

/** A typed day count, clamped to whole days in 0..3650; null when it is not a number. */
function parseDays(text: string): number | null {
  const raw = text.trim();
  if (raw === "") return null;
  const next = Number(raw);
  if (!Number.isFinite(next)) return null;
  return Math.min(MAX_DAYS, Math.max(0, Math.floor(next)));
}

/**
 * A rule's day count: Never, a preset, or Custom… for any other count. The
 * custom box saves on blur or Enter, never mid-typing: on the way from 30 to
 * 60, "Delete after 3 days" must not reach the brain. Escape drops it.
 */
function DaysSelect({
  label,
  value,
  disabled = false,
  onChange,
}: {
  label: string;
  value: number;
  disabled?: boolean;
  onChange: (days: number) => void;
}) {
  // The text in the custom box while it is open. The ref is what a blur
  // reads, so an Escape that closed the box is never committed by the blur
  // that follows it.
  const [draft, setDraftState] = React.useState<string | null>(null);
  const draftRef = React.useRef<string | null>(null);
  const setDraft = (next: string | null) => {
    draftRef.current = next;
    setDraftState(next);
  };
  const options = React.useMemo(() => {
    const days: number[] = [0, ...DAY_PRESETS];
    if (value > 0 && !days.includes(value)) days.push(value);
    days.sort((a, b) => a - b);
    return [
      ...days.map((entry) => ({ value: String(entry), label: daysLabel(entry) })),
      { value: CUSTOM_DAYS, label: "Custom…" },
    ];
  }, [value]);
  const commit = () => {
    const typed = draftRef.current;
    if (typed == null) return;
    const next = parseDays(typed);
    setDraft(null);
    if (next != null && next !== value) onChange(next);
  };
  return (
    <span className="ade-cleanup-days">
      <SettingsSelect
        ariaLabel={label}
        value={draft != null ? CUSTOM_DAYS : String(value)}
        options={options}
        disabled={disabled}
        style={{ minWidth: 132 }}
        onChange={(next) => {
          if (next === CUSTOM_DAYS) {
            setDraft(value > 0 ? String(value) : "");
            return;
          }
          setDraft(null);
          const days = Number(next);
          if (days !== value) onChange(days);
        }}
      />
      {draft != null ? (
        <span className="ade-cleanup-custom">
          <input
            type="number"
            inputMode="numeric"
            aria-label={`${label}, custom days`}
            className="ade-cleanup-custom-input"
            min={0}
            max={MAX_DAYS}
            step={1}
            value={draft}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") commit();
              else if (event.key === "Escape") setDraft(null);
            }}
          />
          days
        </span>
      ) : null}
    </span>
  );
}

/**
 * A rule's control. When this machine sets the rule over the project's
 * shared value (local.yaml), a quiet "This machine · Reset" sits under it;
 * Reset hands the rule back to the shared value.
 */
function RuleControl({ overridden, onReset, children }: { overridden: boolean; onReset: () => void; children: React.ReactNode }) {
  return (
    <span className="ade-cleanup-ctrl">
      <span className="ade-cleanup-ctrl-main">{children}</span>
      {overridden ? (
        <span className="ade-cleanup-override">
          This machine ·{" "}
          <button type="button" className="ade-modern-btn" data-variant="link" onClick={onReset}>
            Reset
          </button>
        </span>
      ) : null}
    </span>
  );
}

/**
 * The automatic rules a save turned on or off, as coarse lane facts (never a
 * day count): archive idle lanes, free up space on its own, delete archived
 * lanes. `before` is what was in force when the page loaded.
 */
function captureRuleSwitches(before: LaneCleanupConfig | null | undefined, next: LaneCleanupConfig): void {
  const was = resolveLaneCleanupPolicy(before);
  const now = resolveLaneCleanupPolicy({ ...(before ?? {}), ...stripUnset(next) });
  const switched = (on: boolean, wasOn: boolean, action: "auto_archive_changed" | "auto_free_up_changed" | "auto_delete_changed") => {
    if (on !== wasOn) captureLaneSetupAnalytics({ action, outcome: on ? "enabled" : "disabled" });
  };
  switched(now.archiveIdleAfterDays > 0, was.archiveIdleAfterDays > 0, "auto_archive_changed");
  switched(
    now.freeUpSpaceMode === "auto" && now.freeUpSpaceAfterDays > 0,
    was.freeUpSpaceMode === "auto" && was.freeUpSpaceAfterDays > 0,
    "auto_free_up_changed",
  );
  switched(now.deleteArchivedAfterDays > 0, was.deleteArchivedAfterDays > 0, "auto_delete_changed");
}

function stripUnset(value: LaneCleanupConfig): LaneCleanupConfig {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry != null)) as LaneCleanupConfig;
}

const FREE_UP_MODES = [
  { value: "ask", label: "Ask me" },
  { value: "auto", label: "Automatically" },
] as const satisfies ReadonlyArray<{ value: LaneFreeUpSpaceMode; label: string }>;

/** The newest of two ISO times, either of which may be missing. */
function latest(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/**
 * The lane cleanup rules, read top to bottom as a lane's life: archive it
 * when idle, free up its space, delete it; then build output and chats.
 *
 * `value` is this machine's local.yaml; `effectiveValue` what was in force
 * when the page loaded (local over the project's shared settings over the
 * defaults). A rule set in local.yaml says "This machine · Reset".
 */
function CleanupRules({
  value,
  effectiveValue,
  lastScanAt,
  lastRun,
  buildOutput,
  freeUpDueCount,
  busy,
  onChange,
  onOpenArchive,
  chats,
}: {
  value: LaneCleanupConfig;
  effectiveValue: LaneCleanupConfig;
  lastScanAt: string | null;
  lastRun: StorageLifecycleRunReport | null;
  buildOutput: LaneBuildOutputSummary | null;
  freeUpDueCount: number;
  busy: boolean;
  onChange: (value: LaneCleanupConfig) => void;
  onOpenArchive?: () => void;
  chats?: React.ReactNode;
}) {
  const shown = resolveLaneCleanupPolicy({ ...effectiveValue, ...stripUnset(value) });
  const reset = (...keys: Array<keyof LaneCleanupConfig>) =>
    onChange({ ...value, ...Object.fromEntries(keys.map((key) => [key, undefined])) });
  const overridden = (...keys: Array<keyof LaneCleanupConfig>) => keys.some((key) => value[key] != null);
  const setDays = (key: DayKey) => (days: number) => onChange({ ...value, [key]: days });

  const freeUpOn = shown.freeUpSpaceAfterDays > 0;
  const deleteOn = shown.deleteArchivedAfterDays > 0;
  const allOff = shown.archiveIdleAfterDays <= 0 && !freeUpOn && !deleteOn && shown.cleanBuildOutputAfterDays <= 0;
  const lastCheck = latest(lastScanAt, buildOutput?.lastCheckAt);
  const status = busy
    ? "Saving…"
    : allOff
      ? "Off — ADE never cleans up on its own."
      : lastCheck ? `Last check ${relativeWhen(lastCheck)}` : "Not checked yet";

  // Drawn under Delete only while Delete is on, so a row that is off never
  // grows an empty gap.
  const deleteClash = deleteOn && freeUpOn && shown.deleteArchivedAfterDays <= shown.freeUpSpaceAfterDays;
  const deleteExtras = deleteOn ? (
    <>
      {deleteClash ? (
        <p className="ade-cleanup-note">
          <Warning size={12} weight="fill" />
          Deletes before ADE would free up space, so Free up never runs.
        </p>
      ) : null}
      <div className="ade-cleanup-subrow">
        <ArrowElbowDownRight size={13} className="ade-cleanup-subrow-icon" />
        <div className="ade-cleanup-subrow-text">
          <span className="ade-cleanup-subrow-title">Also delete the local branch</span>
          <span className="ade-cleanup-subrow-hint">Every commit is on a remote by then. The remote branch stays.</span>
        </div>
        <RuleControl overridden={overridden("deleteLocalBranchOnAutoDelete")} onReset={() => reset("deleteLocalBranchOnAutoDelete")}>
          <SettingsToggle
            label="Also delete the local branch"
            checked={shown.deleteLocalBranchOnAutoDelete}
            onChange={(next) => onChange({ ...value, deleteLocalBranchOnAutoDelete: next })}
          />
        </RuleControl>
      </div>
    </>
  ) : null;

  return (
    <ModernSection
      group="Cleanups"
      title="Automatic cleanup"
      hint="ADE only cleans up lanes whose work is safe: never the primary lane, never a lane with uncommitted or unpushed work, an open PR, or anything running."
      actions={<span className="ade-cleanup-status" aria-live="polite">{status}</span>}
    >
      <div className="ade-cleanup-group" id="lane-storage-rules" data-settings-anchor="lane-storage-rules">
        <h3 className="ade-cleanup-group-title">Lanes</h3>
        <div className="ade-cleanup-rows">
          <ModernRow
            title="Archive idle lanes"
            hint="Merged lanes with nothing unsaved. Archiving only hides them; Restore brings them back."
            control={(
              <RuleControl overridden={overridden("archiveIdleAfterDays")} onReset={() => reset("archiveIdleAfterDays")}>
                <DaysSelect label="Archive idle lanes" value={shown.archiveIdleAfterDays} onChange={setDays("archiveIdleAfterDays")} />
              </RuleControl>
            )}
          />
          <div className="ade-cleanup-rowset" id="archived-lanes" data-settings-anchor="archived-lanes">
            <ModernRow
              title="Free up space of archived lanes"
              hint={(
                <>
                  {!freeUpOn
                    ? "Archived lanes keep their folders."
                    : `${shown.freeUpSpaceMode === "auto" ? "Removes the folder." : "Asks before removing the folder."} The branch and chats stay; Restore rebuilds it.`}
                  {freeUpDueCount > 0 ? (
                    <span className="ade-cleanup-due">
                      {freeUpDueCount === 1 ? "1 lane is" : `${freeUpDueCount} lanes are`} due to free up.{" "}
                      {onOpenArchive ? (
                        <button type="button" className="ade-modern-btn" data-variant="link" onClick={onOpenArchive}>
                          See Archive
                        </button>
                      ) : null}
                    </span>
                  ) : null}
                </>
              )}
              control={(
                <RuleControl
                  overridden={overridden("freeUpSpaceAfterDays", "freeUpSpaceMode")}
                  onReset={() => reset("freeUpSpaceAfterDays", "freeUpSpaceMode")}
                >
                  <SettingsSelect
                    ariaLabel="Free up space: ask or automatically"
                    value={shown.freeUpSpaceMode}
                    options={FREE_UP_MODES}
                    disabled={!freeUpOn}
                    style={{ minWidth: 0, opacity: freeUpOn ? 1 : 0.45 }}
                    onChange={(next) => onChange({ ...value, freeUpSpaceMode: next })}
                  />
                  <DaysSelect label="Free up space of archived lanes" value={shown.freeUpSpaceAfterDays} onChange={setDays("freeUpSpaceAfterDays")} />
                </RuleControl>
              )}
            />
            <ModernRow
              title="Delete archived lanes"
              hint="Chats go to Recently deleted."
              control={(
                <RuleControl overridden={overridden("deleteArchivedAfterDays")} onReset={() => reset("deleteArchivedAfterDays")}>
                  <DaysSelect label="Delete archived lanes" value={shown.deleteArchivedAfterDays} onChange={setDays("deleteArchivedAfterDays")} />
                </RuleControl>
              )}
            >
              {deleteExtras}
            </ModernRow>
          </div>
        </div>
      </div>

      <div className="ade-cleanup-group" id="lane-build-output" data-settings-anchor="lane-build-output">
        <h3 className="ade-cleanup-group-title">Build output</h3>
        <div className="ade-cleanup-rows">
          <ModernRow
            title="Remove build output from idle lanes"
            hint="node_modules, dist, .next, target… only folders git ignores. A reinstall brings them back."
            control={(
              <RuleControl overridden={overridden("cleanBuildOutputAfterDays")} onReset={() => reset("cleanBuildOutputAfterDays")}>
                <DaysSelect label="Remove build output from idle lanes" value={shown.cleanBuildOutputAfterDays} onChange={setDays("cleanBuildOutputAfterDays")} />
              </RuleControl>
            )}
          />
        </div>
      </div>

      {chats}

      <RecentActivity lastRun={lastRun} buildOutput={buildOutput} />
    </ModernSection>
  );
}

/** Rows drawn while the rules load, so no rule ever flashes "Never" before its real value. */
function CleanupRulesSkeleton({ chats }: { chats?: React.ReactNode }) {
  return (
    <ModernSection group="Cleanups" title="Automatic cleanup" hint="Loading the cleanup rules…">
      <div className="ade-lanes-skeleton" aria-busy="true">
        {[0, 1, 2, 3].map((index) => <span key={index} className="ade-st-shimmer" />)}
      </div>
      {chats}
    </ModernSection>
  );
}

/**
 * The cleanup history (`show="history"`, under Space) or the lane cleanup
 * rules (`show="rules"`, under Rules). `chats` is the chat row drawn inside
 * the rules section; `onOpenArchive` opens the Archive view.
 */
export function HealthCleanups({
  data,
  show,
  chats,
  onOpenArchive,
}: {
  data: HealthData;
  show: "history" | "rules";
  chats?: React.ReactNode;
  onOpenArchive?: () => void;
}) {
  const runs = React.useMemo(() => journalEntries(data.storage.snapshot?.extras, 30), [data.storage.snapshot]);
  const [busy, setBusy] = React.useState(false);
  const pending = React.useRef<{ timer: ReturnType<typeof setTimeout>; value: LaneCleanupConfig } | null>(null);
  const { savePolicy, setPolicy, loadStorage } = data;

  const effectivePolicy = data.storage.effectivePolicy;
  const save = React.useCallback(async (next: LaneCleanupConfig) => {
    setBusy(true);
    try {
      await savePolicy(next);
      captureRuleSwitches(effectivePolicy, next);
      void loadStorage({ force: true, silent: true });
    } catch (err) {
      showToast({ tone: "error", title: "Couldn't save the cleanup rules", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }, [effectivePolicy, loadStorage, savePolicy]);

  // Rules save shortly after each change (a custom day count changes on blur
  // or Enter, not per keystroke), debounced so quick changes write once.
  // Leaving the tab saves a pending change instead of dropping it; a custom
  // count still being typed in was never committed, so it is not saved.
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
    void savePolicy(queued.value).catch((error: unknown) => console.warn("lane_cleanup_rules.unmount_save_failed", error));
  }, [savePolicy]);

  if (show === "history") {
    return <CleanupHistory runs={runs} loading={data.storage.loading && !data.storage.snapshot} />;
  }

  const snapshot = data.storage.snapshot;
  // The rules come with the snapshot: until it is read, any value shown would be a guess.
  if (!snapshot) {
    if (data.storage.error && !data.storage.loading) {
      return (
        <ModernSection group="Cleanups" title="Automatic cleanup">
          <Banner
            layout="inline"
            model={{
              id: "lane-cleanup-rules-error",
              tone: "error",
              title: "ADE couldn't read the cleanup rules",
              detail: data.storage.error,
              actions: [{ label: "Try again", onClick: () => void loadStorage() }],
            }}
          />
          {chats}
        </ModernSection>
      );
    }
    return <CleanupRulesSkeleton chats={chats} />;
  }

  return (
    <CleanupRules
      value={data.storage.policy}
      effectiveValue={data.storage.effectivePolicy}
      lastScanAt={snapshot.lifecycle?.lastScanAt ?? null}
      lastRun={snapshot.lifecycle?.lastRun ?? null}
      buildOutput={snapshot.lifecycle?.buildOutput ?? null}
      freeUpDueCount={snapshot.lifecycle?.freeUpDueCount ?? 0}
      busy={busy}
      onChange={commit}
      onOpenArchive={onOpenArchive}
      chats={chats}
    />
  );
}

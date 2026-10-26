import React from "react";
import { useLocation } from "react-router-dom";
import {
  Archive,
  ArrowClockwise,
  Broom,
  CaretDown,
  FileZip,
  FolderDashed,
  HardDrives,
  ShieldCheck,
} from "@phosphor-icons/react";
import type {
  DbBreakdownEntry,
  MaintenanceRunReport,
  ProviderHistoryEntry,
  StorageCategoryId,
  StorageCategorySnapshot,
  StorageCleanupTarget,
  StorageItem,
  StorageSnapshotExtras,
} from "../../../../shared/types/storage";
import type { OpenProjectBinding } from "../../../../shared/types";
import { ModernSection } from "../primitives";
import { useSettingsMachineScope } from "../SettingsMachineScope";
import { showToast, type ToastTone } from "../../app/toast/toastStore";
import { relativeWhen } from "../../../lib/format";
import { SmartTooltip } from "../../ui/SmartTooltip";
import { UsageSparkline } from "../../usage/UsageSparks";
import { AppleRecordingsWarning } from "../AppleRecordingsWarning";
import { StorageCleanupDialog, type SafeCleanupPlanConfig } from "../storage/StorageCleanupDialog";
import { useLaneReclaim } from "../lanes/useLaneReclaim";
import {
  CATEGORY_META,
  DB_COMPACTION_PENDING_HINT,
  baseName,
  buildCleanupTarget,
  buildSafeCleanupPlan,
  categorySeries,
  cleanableEntries,
  dbBreakdownRows,
  dbSizeSamples,
  dbSizeTrend,
  formatBytes,
  formatMeasuredBytes,
  freeSpaceLevel,
  groupLaneItems,
  groupRowsByLabel,
  maintenanceOutcome,
} from "../storage/storageView";
import { FreeSpaceMeter, StackedBreakdown } from "./healthCharts";
import type { HealthData } from "./useHealthData";
import { isAdeAvailable } from "../../../lib/adeAvailability";
import { decodeSettingsHash } from "../settingsHash";

/** One storage result at a time: a new outcome replaces the last in place. */
const STORAGE_TOAST_ID = "settings-storage-result";

type CleanupRequest = { title: string; intro: string; targets: StorageCleanupTarget[] };

const EMPTY_TARGETS: StorageCleanupTarget[] = [];

function getRunMaintenanceNow(): ((pin?: OpenProjectBinding | null) => Promise<MaintenanceRunReport>) | undefined {
  const fn = window.ade?.storage?.runMaintenanceNow;
  return isAdeAvailable(fn) ? fn : undefined;
}

function getCompressNow(): ((pin?: OpenProjectBinding | null) => Promise<{ filesCompressed: number; savedBytes: number }>) | undefined {
  const fn = window.ade?.storage?.compressNow;
  return isAdeAvailable(fn) ? fn : undefined;
}

/** Anchors drawn inside the collapsed Details section; a link to one opens it. */
export const HEALTH_DETAIL_ANCHORS: ReadonlySet<string> = new Set([
  "storage-chat-history",
  "storage-deleted-chats",
  "storage-provider-history",
]);

export function HealthSpace({ data }: { data: HealthData }) {
  // Every call below acts on the machine this Settings page shows.
  const { pin } = useSettingsMachineScope();
  const { snapshot, pressureState, laneIdByKey, archivedAtByKey, loading, refreshing, error } = data.storage;
  const [cleanup, setCleanup] = React.useState<CleanupRequest | null>(null);
  const [safeOpen, setSafeOpen] = React.useState(false);
  const [compressing, setCompressing] = React.useState(false);
  const location = useLocation();
  const hashAnchor = location.hash ? decodeSettingsHash(location.hash) : null;
  const linksIntoDetails = hashAnchor != null && HEALTH_DETAIL_ANCHORS.has(hashAnchor);
  const [detailsOpen, setDetailsOpen] = React.useState(linksIntoDetails);
  React.useEffect(() => {
    if (linksIntoDetails) setDetailsOpen(true);
  }, [linksIntoDetails, hashAnchor]);

  const runMaintenanceBridge = React.useMemo(() => getRunMaintenanceNow(), []);
  const runMaintenanceNow = React.useMemo<(() => Promise<MaintenanceRunReport>) | undefined>(
    () => (runMaintenanceBridge ? () => runMaintenanceBridge(pin) : undefined),
    [pin, runMaintenanceBridge],
  );
  const compressNow = React.useMemo(() => getCompressNow(), []);
  const { loadStorage, loadDiagnostics } = data;

  const notify = React.useCallback((message: string, tone: ToastTone = "success") => {
    showToast({ id: STORAGE_TOAST_ID, title: message, tone, durationMs: 4500 });
  }, []);

  const refreshAfterChange = React.useCallback(() => {
    void loadStorage({ force: true, silent: true });
    void loadDiagnostics();
  }, [loadDiagnostics, loadStorage]);

  const plan = React.useMemo(
    () => (snapshot ? buildSafeCleanupPlan(snapshot, laneIdByKey, { maintenance: Boolean(runMaintenanceNow) }) : null),
    [snapshot, laneIdByKey, runMaintenanceNow],
  );

  const safeConfig = React.useMemo<SafeCleanupPlanConfig | null>(() => {
    if (!plan) return null;
    return {
      alsoRuns: plan.alsoRuns,
      keeps: plan.keeps,
      confirmLabel: "Clean up safely",
      ...(runMaintenanceNow
        ? {
            runMaintenance: runMaintenanceNow,
            onMaintenanceDone: (report: MaintenanceRunReport) => {
              const outcome = maintenanceOutcome(report);
              if (outcome.failed) notify(outcome.message, "warning");
            },
          }
        : {}),
    };
  }, [notify, plan, runMaintenanceNow]);

  const canCleanUp = Boolean(plan && (plan.fsTargets.length > 0 || runMaintenanceNow));

  const runCompress = React.useCallback(async () => {
    if (!compressNow) return;
    setCompressing(true);
    try {
      const result = await compressNow(pin);
      notify(result.filesCompressed > 0
        ? `Compressed ${result.filesCompressed} ${result.filesCompressed === 1 ? "file" : "files"}, saved ${formatBytes(result.savedBytes)}`
        : "Nothing was ready to compress");
      refreshAfterChange();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not compress history", "error");
    } finally {
      setCompressing(false);
    }
  }, [compressNow, notify, pin, refreshAfterChange]);

  const reclaim = useLaneReclaim(pin, refreshAfterChange);

  const restoreLane = React.useCallback(async (laneId: string) => {
    try {
      const result = await window.ade.lanes.unarchive({ laneId }, pin);
      notify(
        result.setupWarning
          ? `Lane restored. Setup needs attention: ${result.setupWarning}`
          : result.worktreeRecreated ? "Lane restored and its worktree was recreated." : "Lane restored.",
        result.setupWarning ? "warning" : "success",
      );
      refreshAfterChange();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not restore this lane", "error");
    }
  }, [notify, pin, refreshAfterChange]);

  const byId = React.useMemo(() => {
    const map = new Map<StorageCategoryId, StorageCategorySnapshot>();
    for (const category of snapshot?.categories ?? []) map.set(category.id, category);
    return map;
  }, [snapshot]);

  const series = React.useMemo(() => categorySeries(snapshot?.categories ?? []), [snapshot]);
  const lanes = byId.get("lanes_worktrees");
  const dbSamples = React.useMemo(() => dbSizeSamples(snapshot?.extras), [snapshot]);
  const dbTrend = dbSizeTrend(dbSamples);
  const database = byId.get("database");
  const level = snapshot ? freeSpaceLevel(snapshot.volume.freeBytes, snapshot.volume.totalBytes) : undefined;
  const cleanLabel = plan && plan.estimatedBytes > 0
    ? `Clean up safely · ${plan.partial ? "≥ " : ""}${formatBytes(plan.estimatedBytes)}`
    : "Clean up safely";

  return (
    <div className="ade-modern-sections">
      <ModernSection
        group="Disk"
        anchor="storage"
        title="Storage"
        hint={snapshot
          ? `ADE keeps ${formatMeasuredBytes(snapshot.totalAdeBytes, snapshot.truncated)} for this project and its own temporary files. Measured ${relativeWhen(snapshot.generatedAt)}.`
          : "What ADE keeps for this project, and what you can clear."}
        actions={snapshot ? (
          <>
            <button
              type="button"
              onClick={() => void loadStorage({ force: true })}
              disabled={refreshing}
              className="ade-modern-btn"
              data-variant="ghost"
            >
              <ArrowClockwise size={13} className={refreshing ? "animate-spin" : undefined} />
              {refreshing ? "Checking" : "Check again"}
            </button>
            {canCleanUp ? (
              <button
                type="button"
                onClick={() => {
                  setSafeOpen(true);
                  // The preview measures now; re-measure the page too, so this
                  // button's size catches up with the one the preview shows.
                  void loadStorage({ force: true, silent: true });
                }}
                className="ade-modern-btn"
                data-tone="primary"
              >
                <Broom size={13} />
                {cleanLabel}
              </button>
            ) : null}
          </>
        ) : undefined}
      >
        {loading && !snapshot ? (
          <div className="ade-modern-stats" aria-busy="true">
            {["Free on disk", "ADE data", "Database"].map((label) => (
              <div key={label} className="ade-modern-stat">
                <span className="kit-eyebrow">{label}</span>
                <span className="ade-st-shimmer" />
              </div>
            ))}
          </div>
        ) : error && !snapshot ? (
          <div className="ade-modern-note" data-tone="crit">
            <HardDrives size={14} />
            <div className="ade-modern-note-body">
              <strong style={{ fontWeight: 600, color: "var(--color-fg)" }}>ADE couldn&apos;t measure storage right now.</strong>
              <span>{error}</span>
            </div>
            <button type="button" onClick={() => void loadStorage({ force: true })} className="ade-modern-btn" data-size="sm">
              <ArrowClockwise size={12} /> Try again
            </button>
          </div>
        ) : snapshot ? (
          <>
            <div className="ade-modern-stats">
              <div className="ade-modern-stat">
                <span className="kit-eyebrow">Free on disk</span>
                <span className="ade-modern-stat-value">
                  <span
                    className="kit-stat kit-num"
                    style={level ? { color: level === "crit" ? "var(--kit-crit)" : "var(--kit-warn)" } : undefined}
                  >
                    {formatBytes(snapshot.volume.freeBytes)}
                  </span>
                </span>
                <FreeSpaceMeter freeBytes={snapshot.volume.freeBytes} totalBytes={snapshot.volume.totalBytes} level={level} />
                <span className="ade-modern-stat-sub">
                  {snapshot.volume.totalBytes > 0
                    ? `${Math.round((snapshot.volume.freeBytes / snapshot.volume.totalBytes) * 100)}% of ${formatBytes(snapshot.volume.totalBytes)} free`
                    : "Disk size unknown"}
                  {pressureState === "critical" || pressureState === "exhausted" ? " · ADE is pausing heavy work" : ""}
                </span>
              </div>
              <div className="ade-modern-stat">
                <span className="kit-eyebrow">ADE data</span>
                <span className="ade-modern-stat-value">
                  <span className="kit-stat kit-num">{formatMeasuredBytes(snapshot.totalAdeBytes, snapshot.truncated)}</span>
                </span>
                <span className="ade-modern-stat-sub" title="This project's lanes, chats, proof, caches and database, plus ADE's temporary files on this machine">Lanes, chats, proof, caches and database.</span>
              </div>
              <div className="ade-modern-stat">
                <span className="kit-eyebrow">Database</span>
                <span className="ade-modern-stat-value">
                  <span className="kit-stat kit-num">{database ? formatMeasuredBytes(database.bytes, database.partial) : "—"}</span>
                  {dbTrend && dbTrend !== "flat" ? (
                    <span className="kit-tag" data-tone={dbTrend === "up" ? "warn" : "ok"}>
                      {dbTrend === "up" ? "growing" : "shrinking"}
                    </span>
                  ) : null}
                </span>
                {dbSamples.length >= 2 ? (
                  <span className="usage-stat-trend">
                    <UsageSparkline
                      values={dbSamples.map((sample) => sample.bytes)}
                      label={`Database size after each cleanup, from ${formatBytes(dbSamples[0]!.bytes)} to ${formatBytes(dbSamples[dbSamples.length - 1]!.bytes)}`}
                    />
                  </span>
                ) : (
                  <span className="ade-modern-stat-sub">With its write-ahead log. A trend shows after two cleanups.</span>
                )}
              </div>
            </div>

            <StackedBreakdown series={series} ariaLabel="What ADE keeps, by category" />

            {snapshot.truncated ? (
              <p className="ade-modern-muted">
                Some folders were too big to measure in one pass. Sizes marked ≥ are at least that much.
              </p>
            ) : null}
          </>
        ) : null}
      </ModernSection>

      {snapshot && plan && (plan.rows.length > 0 || plan.alsoRuns.length > 0) ? (
        <ModernSection
          group="Disk"
          title="What Clean up safely does"
          hint="ADE checks every path again before it removes anything, and shows you the list first."
        >
          <div className="ade-modern-rows ade-health-plan">
            {plan.rows.length > 0 ? plan.rows.map((row) => (
              <div key={row.label} className="ade-health-plan-row">
                <span>
                  {row.label}
                  {row.count > 1 ? <span className="ade-health-plan-count kit-num"> · {row.count}</span> : null}
                </span>
                <span className="kit-num">{formatBytes(row.bytes)}</span>
              </div>
            )) : (
              <div className="ade-health-plan-row"><span className="ade-modern-muted">No files need removing right now.</span></div>
            )}
            {/* The total sits right under the rows it adds up. */}
            {plan.rows.length > 0 ? (
              <div className="ade-health-plan-row" data-total="true">
                <span>Files to remove</span>
                <span className="kit-num">{plan.partial ? "≥ " : ""}{formatBytes(plan.estimatedBytes)}</span>
              </div>
            ) : null}
            {plan.alsoRuns.map((line) => (
              <div key={line} className="ade-health-plan-row" data-note="true"><span>{line}</span></div>
            ))}
          </div>
        </ModernSection>
      ) : null}

      {snapshot ? (
        <section className="ade-health-details">
          <button
            type="button"
            className="ade-health-disclosure"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((value) => !value)}
          >
            <CaretDown size={12} weight="bold" className="ade-health-caret" data-open={detailsOpen || undefined} />
            Storage details
          </button>
          {detailsOpen ? (
            <div className="ade-modern-sections" style={{ gap: 28 }}>
              {lanes ? (
                <LaneDetails
                  category={lanes}
                  laneIdByKey={laneIdByKey}
                  archivedAtByKey={archivedAtByKey}
                  onRequestCleanup={setCleanup}
                  onReclaim={(laneId) => void reclaim.open(laneId)}
                  onRestore={(laneId) => void restoreLane(laneId)}
                />
              ) : null}
              <LeftoverDetails
                categories={snapshot.categories}
                laneIdByKey={laneIdByKey}
                onRequestCleanup={setCleanup}
              />
              <HistoryDetails
                category={byId.get("chats_history")}
                compressing={compressing}
                onCompress={compressNow ? () => void runCompress() : null}
                laneIdByKey={laneIdByKey}
                onRequestCleanup={setCleanup}
              />
              <ProviderHistoryDetails
                entries={snapshot.extras?.providerHistory ?? []}
                copies={snapshot.extras?.deletedLaneProviderCopies ?? null}
                onRequestCleanup={setCleanup}
              />
              <DatabaseDetails category={database} snapshot={snapshot} />
              {/* Reads through unpinned simulator/file calls, so only for the tab's machine. */}
              {pin ? null : <AppleRecordingsWarning projectRoot={snapshot.projectRoot} />}
            </div>
          ) : null}
        </section>
      ) : null}

      <StorageCleanupDialog
        open={cleanup != null}
        title={cleanup?.title ?? ""}
        intro={cleanup?.intro}
        targets={cleanup?.targets ?? EMPTY_TARGETS}
        onClose={() => setCleanup(null)}
        onCleaned={refreshAfterChange}
      />

      {safeConfig && plan ? (
        <StorageCleanupDialog
          open={safeOpen}
          title="Clean up safely"
          intro="ADE removes files it can rebuild or no longer needs, then tidies its own data."
          targets={plan.fsTargets}
          plan={safeConfig}
          onClose={() => setSafeOpen(false)}
          onCleaned={refreshAfterChange}
        />
      ) : null}

      {reclaim.dialog}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------

function DetailBlock({ id, title, hint, children }: { id?: string; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="ade-health-detail-block" id={id}>
      <div className="ade-health-detail-head">
        <span className="ade-health-detail-title">{title}</span>
        {hint ? <span className="ade-modern-muted">{hint}</span> : null}
      </div>
      <div className="ade-st-items">{children}</div>
    </div>
  );
}

function ItemRow({
  id,
  label,
  path,
  size,
  detail,
  muted,
  action,
}: {
  id?: string;
  label: React.ReactNode;
  path?: string;
  size: string;
  detail?: React.ReactNode;
  muted?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div className="ade-st-item" id={id} data-muted={muted || undefined}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <span className="ade-st-item-label">{label}</span>
          <span className="ade-st-item-size kit-num">{size}</span>
        </div>
        {detail ? <div className="ade-st-item-detail">{detail}</div> : null}
        {path ? <div className="ade-st-item-path" title={path}>{path}</div> : null}
      </div>
      {action ? <div style={{ flexShrink: 0 }}>{action}</div> : null}
    </div>
  );
}

function ActionButton({ label, icon, onClick }: { label: string; icon: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="ade-modern-btn" data-size="sm">
      {icon}
      {label}
    </button>
  );
}

/** "Build output removed 3d ago (1.2 GB): node_modules. Reinstall to rebuild." while those folders are still gone. */
function buildOutputNote(item: StorageItem): string | null {
  const removed = item.buildOutputRemoved;
  if (!removed || removed.folders.length === 0) return null;
  const size = removed.bytes > 0 || removed.partial ? ` (${formatMeasuredBytes(removed.bytes, removed.partial)})` : "";
  return `Build output removed ${relativeWhen(removed.at)}${size}: ${removed.folders.join(", ")}. Reinstall or build to bring it back.`;
}

function withBuildOutputNote(line: string | undefined, item: StorageItem): string | undefined {
  const note = buildOutputNote(item);
  if (!note) return line;
  return line ? `${line}. ${note}` : note;
}

function LaneDetails({
  category,
  laneIdByKey,
  archivedAtByKey,
  onRequestCleanup,
  onReclaim,
  onRestore,
}: {
  category: StorageCategorySnapshot;
  laneIdByKey: Map<string, string>;
  archivedAtByKey: Map<string, string | null>;
  onRequestCleanup: (request: CleanupRequest) => void;
  onReclaim: (laneId: string) => void;
  onRestore: (laneId: string) => void;
}) {
  const { active, archived, orphaned } = groupLaneItems(category.items);
  const hidden = Math.max(0, (category.itemCount ?? category.items.length) - category.items.length);
  return (
    <DetailBlock title="Lanes" hint="Active lanes are always kept. Archived and left-over folders can go.">
      {archived.map((item) => {
        const laneId = item.laneId ?? laneIdByKey.get(baseName(item.path));
        const reclaimed = item.bytes === 0 && !item.partial && item.reclaimState !== "failed";
        const archivedAt = archivedAtByKey.get(baseName(item.path));
        return (
          <ItemRow
            key={item.id}
            label={<>{item.label} <span className="kit-tag">Archived</span></>}
            path={item.path}
            size={reclaimed ? "Folder removed" : formatMeasuredBytes(item.bytes, item.partial)}
            detail={reclaimed
              ? "The lane, branch and chats are kept. Restoring it recreates the folder."
              : withBuildOutputNote(archivedAt ? `Archived ${relativeWhen(archivedAt)}` : item.detail, item)}
            action={laneId ? (
              reclaimed
                ? <ActionButton label="Restore lane" icon={<ArrowClockwise size={13} />} onClick={() => onRestore(laneId)} />
                : <ActionButton label="Archive & reclaim…" icon={<Archive size={13} />} onClick={() => onReclaim(laneId)} />
            ) : undefined}
          />
        );
      })}
      {orphaned.map((item) => {
        const target = buildCleanupTarget("lanes_worktrees", item, laneIdByKey);
        return (
          <ItemRow
            key={item.id}
            label={<>{item.label} <span className="kit-tag" data-tone="warn">Left over</span></>}
            path={item.path}
            size={formatMeasuredBytes(item.bytes, item.partial)}
            detail="Left over from a deleted lane. ADE checks it for uncommitted work before removing it."
            action={target && (item.bytes > 0 || item.partial) ? (
              <ActionButton
                label="Remove files…"
                icon={<FolderDashed size={13} />}
                onClick={() => onRequestCleanup({
                  title: "Remove leftover lane files",
                  intro: "These files were left behind by a lane that no longer exists. ADE checks the path again, and keeps the folder if it holds uncommitted changes or commits no branch has.",
                  targets: [target],
                })}
              />
            ) : undefined}
          />
        );
      })}
      {active.map((item) => (
        <ItemRow
          key={item.id}
          label={item.label}
          path={item.path}
          size={formatMeasuredBytes(item.bytes, item.partial)}
          detail={buildOutputNote(item) ?? "In use, kept"}
          muted
        />
      ))}
      {hidden > 0 ? <div className="ade-modern-muted">And {hidden} smaller {hidden === 1 ? "folder" : "folders"}, counted in the total.</div> : null}
      {category.items.length === 0 ? <div className="ade-modern-muted">No lane folders.</div> : null}
    </DetailBlock>
  );
}

function LeftoverDetails({
  categories,
  laneIdByKey,
  onRequestCleanup,
}: {
  categories: StorageCategorySnapshot[];
  laneIdByKey: Map<string, string>;
  onRequestCleanup: (request: CleanupRequest) => void;
}) {
  const find = (id: StorageCategoryId) => categories.find((category) => category.id === id);
  const build = find("build_release");
  const caches = find("caches");
  const proof = find("proof_attachments");
  const backups = find("recovery_backups");

  // Build and release staging: one row per kind, with a count and a total.
  const buildCleanable = build ? cleanableEntries("build_release", build, laneIdByKey) : [];
  const buildRows = groupRowsByLabel((build?.items ?? []).map((item) => ({ label: item.label, bytes: item.bytes })));
  const cacheCleanable = caches ? cleanableEntries("caches", caches, laneIdByKey) : [];
  const cacheRows = (caches?.items ?? []).filter((item) => item.bytes > 0 || item.partial);
  const proofCleanable = proof ? cleanableEntries("proof_attachments", proof, laneIdByKey).filter((entry) => entry.item.bytes > 0) : [];
  const backupItems = (backups?.items ?? []).filter((item) => item.bytes > 0);

  const sum = (entries: Array<{ item: StorageItem }>) => entries.reduce((total, entry) => total + entry.item.bytes, 0);

  return (
    <>
      {buildRows.length > 0 ? (
        <DetailBlock title={CATEGORY_META.build_release.name} hint={CATEGORY_META.build_release.description}>
          {buildRows.map((row) => (
            <ItemRow
              key={row.label}
              label={row.count > 1 ? `${row.label} (${row.count})` : row.label}
              size={formatBytes(row.bytes)}
            />
          ))}
          {sum(buildCleanable) > 0 ? (
            <div>
              <ActionButton
                label={`Remove old staging · ${formatBytes(sum(buildCleanable))}…`}
                icon={<Broom size={13} />}
                onClick={() => onRequestCleanup({
                  title: "Remove old build and release staging",
                  intro: "Leftover staging from building and releasing, older than a week. It is recreated when needed.",
                  targets: buildCleanable.map((entry) => entry.target),
                })}
              />
            </div>
          ) : null}
        </DetailBlock>
      ) : null}

      {cacheRows.length > 0 ? (
        <DetailBlock title={CATEGORY_META.caches.name} hint={CATEGORY_META.caches.description}>
          {cacheRows.map((item) => (
            <ItemRow
              key={item.id}
              label={item.label}
              size={formatMeasuredBytes(item.bytes, item.partial)}
              detail={item.detail}
              muted={item.safety === "protected"}
            />
          ))}
          {sum(cacheCleanable) > 0 ? (
            <div>
              <ActionButton
                label={`Clear caches · ${formatBytes(sum(cacheCleanable))}…`}
                icon={<Broom size={13} />}
                onClick={() => onRequestCleanup({
                  title: "Clear caches",
                  intro: "These are rebuildable files ADE recreates when it needs them. Removing them is safe.",
                  targets: cacheCleanable.map((entry) => entry.target),
                })}
              />
            </div>
          ) : null}
        </DetailBlock>
      ) : null}

      {proof && proof.bytes > 0 ? (
        <DetailBlock title={CATEGORY_META.proof_attachments.name} hint={CATEGORY_META.proof_attachments.description}>
          {proofCleanable.length > 0 ? proofCleanable.map((entry) => (
            <ItemRow
              key={entry.item.id}
              label={entry.item.label}
              size={formatMeasuredBytes(entry.item.bytes, entry.item.partial)}
              detail={entry.item.lastModifiedAt ? `Last added ${relativeWhen(entry.item.lastModifiedAt)}` : entry.item.detail}
              action={(
                <ActionButton
                  label="Remove…"
                  icon={<Archive size={13} />}
                  onClick={() => onRequestCleanup({
                    title: `Remove ${entry.item.label}`,
                    intro: "These are the screenshots, recordings, and files agents attached as proof. Removing them deletes the files and the entries in every chat's proof drawer. Nothing else is affected.",
                    targets: [entry.target],
                  })}
                />
              )}
            />
          )) : (
            <div className="ade-modern-muted">
              Proof storage is in use but cannot be removed from here. Open the proof drawer in a chat to delete individual items.
            </div>
          )}
        </DetailBlock>
      ) : null}

      {backupItems.length > 0 ? (
        <DetailBlock title={CATEGORY_META.recovery_backups.name} hint={CATEGORY_META.recovery_backups.description}>
          {backupItems.map((item) => (
            <ItemRow
              key={item.id}
              label={item.label}
              size={formatBytes(item.bytes)}
              detail={item.lastModifiedAt ? `Saved ${relativeWhen(item.lastModifiedAt)}` : undefined}
              action={(
                <ActionButton
                  label="Remove…"
                  icon={<Archive size={13} />}
                  onClick={() => onRequestCleanup({
                    title: "Remove recovery backup",
                    intro: "ADE saved this snapshot before a risky change. Remove it once you're confident you no longer need to roll back.",
                    targets: [{ kind: "recovery_backup", path: item.path }],
                  })}
                />
              )}
            />
          ))}
        </DetailBlock>
      ) : null}
    </>
  );
}

function HistoryDetails({
  category,
  compressing,
  onCompress,
  laneIdByKey,
  onRequestCleanup,
}: {
  category: StorageCategorySnapshot | undefined;
  compressing: boolean;
  onCompress: (() => void) | null;
  laneIdByKey: Map<string, string>;
  onRequestCleanup: (request: CleanupRequest) => void;
}) {
  if (!category || (category.bytes <= 0 && !category.partial)) return null;
  const compressible = category.compressibleBytes ?? 0;
  const removable = new Map(
    cleanableEntries("chats_history", category, laneIdByKey).map((entry) => [entry.item.id, entry.target] as const),
  );
  return (
    <DetailBlock
      id="storage-chat-history"
      title={CATEGORY_META.chats_history.name}
      hint="Kept so you can reopen past chats and terminals. Old and finished chats are compressed automatically."
    >
      {category.items.filter((item) => item.bytes > 0 || item.partial).map((item) => {
        const target = removable.get(item.id);
        return (
          <ItemRow
            key={item.id}
            id={target ? "storage-deleted-chats" : undefined}
            label={item.label}
            size={formatMeasuredBytes(item.bytes, item.partial)}
            detail={target ? item.detail : undefined}
            path={target ? item.path : undefined}
            action={target ? (
              <ActionButton
                label="Remove…"
                icon={<Archive size={13} />}
                onClick={() => onRequestCleanup({
                  title: "Remove chats from deleted lanes",
                  intro: `These chats belonged to lanes that were deleted. ADE no longer tracks or shows them, but their transcripts are still on this machine in ${item.path}, and you can open those .jsonl files yourself if you want them. Removing deletes them for good, together with any Claude and Codex session files ADE started for them. Chats in existing or archived lanes are not affected.`,
                  targets: [target],
                })}
              />
            ) : undefined}
          />
        );
      })}
      {removable.size === 0 ? (
        <ItemRow
          id="storage-deleted-chats"
          label="Chats from deleted lanes"
          size="None"
          muted
          detail="When you delete a lane, its chats stay on disk but ADE stops showing them. They are listed here so you can remove them."
        />
      ) : null}
      {compressible > 0 && onCompress ? (
        <ItemRow
          label="Older than two weeks"
          size={formatBytes(compressible)}
          detail={`${formatBytes(compressible)} of old history can be compressed. Nothing is lost; the saving shows after it runs.`}
          action={(
            <button type="button" onClick={onCompress} disabled={compressing} className="ade-modern-btn" data-size="sm">
              <FileZip size={13} className={compressing ? "animate-spin" : undefined} />
              {compressing ? "Compressing…" : "Compress now"}
            </button>
          )}
        />
      ) : null}
    </DetailBlock>
  );
}

/**
 * Each agent CLI's own copy of its conversations, in its own folder. ADE
 * reports these; the only ones it offers to remove are the Claude and Codex
 * sessions it started for chats from deleted lanes.
 */
type DeletedLaneProviderCopies = NonNullable<StorageSnapshotExtras["deletedLaneProviderCopies"]>;

function ProviderHistoryDetails({
  entries,
  copies,
  onRequestCleanup,
}: {
  entries: ProviderHistoryEntry[];
  copies: DeletedLaneProviderCopies | null;
  onRequestCleanup: (request: CleanupRequest) => void;
}) {
  if (entries.length === 0 && !copies) return null;
  return (
    <DetailBlock
      id="storage-provider-history"
      title="Provider history on this machine"
      hint="Every agent CLI keeps its own copy of its sessions in its own folder, for all projects. These belong to the provider, not to ADE."
    >
      {entries.map((entry) => (
        <ItemRow
          key={entry.provider}
          label={entry.label}
          size={formatMeasuredBytes(entry.bytes, entry.partial)}
          detail={entry.note}
          path={entry.paths.join(" · ")}
        />
      ))}
      {copies ? (
        <ItemRow
          label="Copies of chats from deleted lanes"
          size={formatBytes(copies.bytes)}
          detail={`Claude and Codex session files ADE started for ${copies.chatCount} ${copies.chatCount === 1 ? "chat" : "chats"} it no longer has. Sessions you imported from your own CLI are never included.`}
          action={(
            <ActionButton
              label="Remove…"
              icon={<Archive size={13} />}
              onClick={() => onRequestCleanup({
                title: "Remove provider copies of deleted chats",
                intro: "These are the Claude and Codex session files ADE created for chats whose lane was deleted. ADE no longer has those chats, so it cannot resume them. Removing them deletes only those files from the providers' folders; your own CLI sessions and every chat ADE still has stay.",
                targets: [{ kind: "deleted_lane_provider_sessions", path: copies.chatSessionsDir }],
              })}
            />
          )}
        />
      ) : null}
    </DetailBlock>
  );
}

function DatabaseDetails({
  category,
  snapshot,
}: {
  category: StorageCategorySnapshot | undefined;
  snapshot: { extras?: { dbBreakdown?: DbBreakdownEntry[] } };
}) {
  const rows = dbBreakdownRows(snapshot.extras?.dbBreakdown);
  if (!category) return null;
  return (
    <DetailBlock
      title={`${CATEGORY_META.database.name} · ${formatMeasuredBytes(category.bytes, category.partial)}`}
      hint="The database file with its write-ahead log. Table sizes are the space each table's pages take."
    >
      {rows.length === 0 ? (
        <div className="ade-st-item-detail" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <ShieldCheck size={14} style={{ color: "var(--kit-ok)" }} />
          This is your project&apos;s live data. ADE protects it automatically.
        </div>
      ) : rows.map((row) => (
        <div key={row.table} className="ade-st-item">
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span className="ade-st-item-label">{row.label}</span>
              {row.isProtected ? (
                <span className="kit-tag" data-tone="ok">
                  <ShieldCheck size={11} weight="fill" style={{ marginRight: 4 }} />Protected
                </span>
              ) : null}
              {row.trimmedByCleanup ? <span className="kit-tag">Trimmed by Clean up safely</span> : null}
              {row.isPending ? (
                <SmartTooltip forceEnabled side="top" content={{ label: "Waiting to compact", description: DB_COMPACTION_PENDING_HINT }}>
                  <span className="kit-tag">Waiting to compact</span>
                </SmartTooltip>
              ) : null}
            </div>
            <div className="ade-st-item-detail">{row.hint}</div>
          </div>
          <span className="ade-st-item-size kit-num">{row.size}</span>
        </div>
      ))}
    </DetailBlock>
  );
}

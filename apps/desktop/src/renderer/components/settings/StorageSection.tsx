import React from "react";
import {
  Archive,
  ArrowClockwise,
  Broom,
  CaretDown,
  CaretRight,
  FileZip,
  FolderDashed,
  HardDrives,
  ShieldCheck,
  X,
} from "@phosphor-icons/react";
import {
  isUrgentDiskPressure,
  type DiskPressureSnapshot,
  type MaintenanceRunReport,
  type RuntimeHealthSnapshot,
  type StorageCategoryId,
  type StorageCategorySnapshot,
  type StorageCleanupResult,
  type StorageCleanupTarget,
  type StorageItem,
  type StorageSnapshot,
  type StorageSnapshotExtras,
} from "../../../shared/types/storage";
import type {
  AppResourceUsageSnapshot,
  LaneCleanupConfig,
  LaneReclaimRisk,
  OpenProjectBinding,
} from "../../../shared/types";
import { useSettingsMachineScope } from "./SettingsMachineScope";
import { ModernRow, ModernRows, ModernSection, SettingsNumber } from "./primitives";
import "./machineSettings.css";
import { showToast, type ToastTone } from "../app/toast/toastStore";
import { relativeWhen } from "../../lib/format";
import { getAppResourceUsageCoalesced } from "../../lib/resourcePressure";
import {
  COLORS,
  SANS_FONT,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";
import { SmartTooltip } from "../ui/SmartTooltip";
import {
  StorageCleanupDialog,
  StorageDialogFrame,
  type SafeCleanupPlanConfig,
} from "./storage/StorageCleanupDialog";
import { DiagnosticsStrip, TrendArrow } from "./storage/StorageDiagnostics";
import { MaintenanceJournal } from "./storage/StorageMaintenanceJournal";
import { AppleRecordingsWarning } from "./AppleRecordingsWarning";
import { Banner } from "../ui/notice";
import {
  CATEGORY_META,
  CATEGORY_ORDER,
  DB_COMPACTION_PENDING_HINT,
  SAFETY_META,
  baseName,
  buildCleanupTarget,
  buildSafeCleanupPlan,
  categoryPolicyChip,
  cleanableEntries,
  dbBreakdownRows,
  dbSizeSamples,
  dbSizeTrend,
  formatApproxBytes,
  formatBytes,
  groupLaneItems,
  maintenanceOutcome,
  safeReclaimableBytes,
  type Trend,
} from "./storage/storageView";

/** One storage result at a time: a new outcome replaces the last in place. */
const STORAGE_TOAST_ID = "settings-storage-result";

type CompressNow = (pin?: OpenProjectBinding | null) => Promise<{ filesCompressed: number; savedBytes: number }>;
type RunMaintenanceNow = (pin?: OpenProjectBinding | null) => Promise<MaintenanceRunReport>;
type GetRuntimeHealth = () => Promise<RuntimeHealthSnapshot>;

function getCompressNow(): CompressNow | undefined {
  const fn = window.ade?.storage?.compressNow;
  return typeof fn === "function" ? fn : undefined;
}

// Feature-detect so the renderer degrades gracefully against an older daemon
// that doesn't yet expose these; both are declared on window.ade in global.d.ts.
function getRunMaintenanceNow(): RunMaintenanceNow | undefined {
  const fn = window.ade?.storage?.runMaintenanceNow;
  return typeof fn === "function" ? fn : undefined;
}

function getRuntimeHealthFn(): GetRuntimeHealth | undefined {
  const fn = window.ade?.app?.getRuntimeHealth;
  return typeof fn === "function" ? fn : undefined;
}

type CleanupRequest = { title: string; intro: string; targets: StorageCleanupTarget[] };

function formatAgeHours(ageHours: number | null | undefined): string {
  if (ageHours == null) return "Unknown";
  if (ageHours < 1) return "Less than 1 hour";
  if (ageHours < 48) {
    const hours = Math.floor(ageHours);
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  const days = Math.floor(ageHours / 24);
  if (days < 60) return `${days} days`;
  if (days < 730) {
    const months = Math.floor(days / 30);
    return `${months} ${months === 1 ? "month" : "months"}`;
  }
  const years = Math.floor(days / 365);
  return `${years} ${years === 1 ? "year" : "years"}`;
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

const SAFETY_TONE: Record<StorageItem["safety"], "ok" | "warn" | undefined> = {
  safe_to_remove: "ok",
  compressible: undefined,
  review_first: "warn",
  protected: undefined,
};

function SafetyBadge({ safety }: { safety: StorageItem["safety"] }) {
  return <span className="kit-tag" data-tone={SAFETY_TONE[safety]}>{SAFETY_META[safety].label}</span>;
}

function PolicyChip({ label }: { label: string }) {
  return <span className="kit-tag">{label}</span>;
}

/** What each category takes, as one stacked bar and a legend. */
function BreakdownBar({ categories }: { categories: StorageCategorySnapshot[] }) {
  const present = categories.filter((category) => category.bytes > 0);
  const legend = [...present].sort((a, b) => b.bytes - a.bytes);
  if (present.length === 0) {
    // The "ADE data" figure above already says so.
    return null;
  }
  return (
    <div className="ade-st-breakdown">
      <div className="ade-st-bar" role="img" aria-label="What ADE stores, by category">
        {legend.map((category) => (
          <span
            key={category.id}
            title={`${CATEGORY_META[category.id].name} · ${formatBytes(category.bytes)}`}
            style={{ flexGrow: category.bytes, background: CATEGORY_META[category.id].hue }}
          />
        ))}
      </div>
      <div className="ade-st-legend">
        {legend.map((category) => (
          <span key={category.id} className="kit-legend">
            <i style={{ background: CATEGORY_META[category.id].hue }} />
            {CATEGORY_META[category.id].name}
            <b>{formatBytes(category.bytes)}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

function pressureLevel(state: DiskPressureSnapshot["state"] | undefined): "warn" | "crit" | undefined {
  if (state && isUrgentDiskPressure(state)) return "crit";
  if (state === "warning") return "warn";
  return undefined;
}

/**
 * The disk-usage figures: what ADE keeps, what is free, what can go, and when
 * it was measured — then the category breakdown.
 */
function DiskOverview({
  snapshot,
  pressureState,
  reclaimableBytes,
}: {
  snapshot: StorageSnapshot;
  pressureState: DiskPressureSnapshot["state"] | undefined;
  reclaimableBytes: number;
}) {
  const { freeBytes, totalBytes } = snapshot.volume;
  const used = Math.max(0, totalBytes - freeBytes);
  const usedPct = totalBytes > 0 ? Math.min(100, (used / totalBytes) * 100) : 0;
  const adeShare = used > 0 ? Math.min(100, (Math.min(snapshot.totalAdeBytes, used) / used) * 100) : 0;
  const level = pressureLevel(pressureState);
  return (
    <>
      <div className="ade-modern-stats">
        <div className="ade-modern-stat">
          <span className="kit-eyebrow">ADE data</span>
          <span className="ade-modern-stat-value">
            <span className="kit-stat kit-num">{formatBytes(snapshot.totalAdeBytes)}</span>
          </span>
          <div className="kit-meter" aria-hidden><span style={{ width: `${snapshot.totalAdeBytes > 0 ? Math.max(adeShare, 1) : 0}%` }} /></div>
          <span className="ade-modern-stat-sub">
            {snapshot.totalAdeBytes <= 0
              ? "Nothing stored for this project yet"
              : `${adeShare < 1 ? "Under 1%" : `${Math.round(adeShare)}%`} of what's used on this disk`}
          </span>
        </div>
        <div className="ade-modern-stat">
          <span className="kit-eyebrow">Free on disk</span>
          <span className="ade-modern-stat-value">
            <span className="kit-stat kit-num" style={level ? { color: level === "crit" ? "var(--kit-crit)" : "var(--kit-warn)" } : undefined}>
              {formatBytes(freeBytes)}
            </span>
          </span>
          <div className="kit-meter" data-level={level} aria-hidden><span style={{ width: `${usedPct}%` }} /></div>
          <span className="ade-modern-stat-sub">{Math.round(usedPct)}% of {formatBytes(totalBytes)} used</span>
        </div>
        <div className="ade-modern-stat">
          <span className="kit-eyebrow">Safe to reclaim</span>
          <span className="ade-modern-stat-value">
            <span className="kit-stat kit-num">{reclaimableBytes > 0 ? formatApproxBytes(reclaimableBytes) : "0 B"}</span>
          </span>
          <span className="ade-modern-stat-sub">Files ADE can rebuild or no longer needs</span>
        </div>
        <div className="ade-modern-stat">
          <span className="kit-eyebrow">Scanned</span>
          <span className="ade-modern-stat-value">
            <span className="kit-stat" style={{ fontSize: 17 }}>{relativeWhen(snapshot.generatedAt)}</span>
          </span>
          {snapshot.lifecycle ? (
            <span className="ade-modern-stat-sub">
              Safety scan {snapshot.lifecycle.lastScanAt ? relativeWhen(snapshot.lifecycle.lastScanAt) : "not run yet"}
              {" · "}next {snapshot.lifecycle.nextScanAt ? relativeWhen(snapshot.lifecycle.nextScanAt) : "disabled"}
            </span>
          ) : null}
        </div>
      </div>
      <BreakdownBar categories={snapshot.categories} />
      {snapshot.truncated ? (
        <p className="ade-modern-muted">
          Some items were skipped to keep this scan fast, so sizes may be slightly under-counted.
        </p>
      ) : null}
    </>
  );
}

function CardShell({
  categoryId,
  category,
  policyChip,
  headerExtra,
  span,
  children,
}: {
  categoryId: StorageCategoryId;
  category: StorageCategorySnapshot;
  policyChip?: string;
  headerExtra?: React.ReactNode;
  span?: boolean;
  children?: React.ReactNode;
}) {
  const meta = CATEGORY_META[categoryId];
  return (
    <section className="ade-st-cat" style={span ? { gridColumn: "1 / -1" } : undefined}>
      <div className="ade-st-cat-head">
        <span className="ade-st-swatch" style={{ background: meta.hue }} aria-hidden />
        <h3>{meta.name}</h3>
        <span style={{ flex: 1 }} />
        {headerExtra}
        <span className="ade-st-cat-size kit-num">{formatBytes(category.bytes)}</span>
      </div>
      <p className="ade-modern-muted">{meta.description}</p>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <SafetyBadge safety={category.safety} />
        {policyChip ? <PolicyChip label={policyChip} /> : null}
      </div>
      {children}
    </section>
  );
}

function ActionButton({
  label,
  icon,
  onClick,
  disabled,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="ade-modern-btn" data-size="sm">
      {icon}
      {label}
    </button>
  );
}

function ItemRow({
  label,
  path,
  size,
  detail,
  muted,
  action,
}: {
  label: string;
  path?: string;
  size: string;
  detail?: React.ReactNode;
  muted?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div className="ade-st-item" data-muted={muted || undefined}>
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

function GroupLabel({ children }: { children: React.ReactNode }) {
  return <div className="kit-eyebrow" style={{ marginTop: 4 }}>{children}</div>;
}

function laneDetail(item: StorageItem, archivedAt: string | null | undefined): string {
  if (item.laneStatus === "archived") {
    return archivedAt ? `Archived ${relativeWhen(archivedAt)}` : item.detail ?? "Archived lane";
  }
  return item.detail ?? "Left over from a deleted lane";
}

function LanesCard({
  category,
  policyChip,
  laneIdByKey,
  archivedAtByKey,
  onRequestCleanup,
  onReclaim,
  onRestore,
}: {
  category: StorageCategorySnapshot;
  policyChip?: string;
  laneIdByKey: Map<string, string>;
  archivedAtByKey: Map<string, string | null>;
  onRequestCleanup: (request: CleanupRequest) => void;
  onReclaim: (laneId: string) => void;
  onRestore: (laneId: string) => void;
}) {
  const { active, archived, orphaned } = groupLaneItems(category.items);
  const hasActionable = archived.length > 0 || orphaned.length > 0;
  const [expanded, setExpanded] = React.useState(hasActionable);

  const removeRow = (item: StorageItem): React.ReactNode => {
    if (item.laneStatus === "archived") {
      const laneId = item.laneId ?? laneIdByKey.get(baseName(item.path));
      if (!laneId) return null;
      if (item.bytes === 0) {
        return <ActionButton label="Restore lane" icon={<ArrowClockwise size={13} />} onClick={() => onRestore(laneId)} />;
      }
      return <ActionButton label="Archive & reclaim…" icon={<Archive size={13} />} onClick={() => onReclaim(laneId)} />;
    }
    const target = buildCleanupTarget("lanes_worktrees", item, laneIdByKey);
    if (!target) return null;
    return (
      <ActionButton
        label="Remove files…"
        icon={<FolderDashed size={13} />}
        onClick={() =>
          onRequestCleanup({
            title: "Remove leftover lane files",
            intro: "These files were left behind by a lane that no longer exists. ADE will verify the managed path again before removal.",
            targets: [target],
          })
        }
      />
    );
  };

  const summaryParts: string[] = [];
  if (archived.length > 0) summaryParts.push(`${archived.length} archived`);
  if (orphaned.length > 0) summaryParts.push(`${orphaned.length} left over`);
  if (active.length > 0) summaryParts.push(`${active.length} active`);

  return (
    <CardShell categoryId="lanes_worktrees" category={category} policyChip={policyChip} span>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="ade-st-toggle"
        aria-expanded={expanded}
      >
        {expanded ? <CaretDown size={13} /> : <CaretRight size={13} />}
        {summaryParts.length > 0 ? summaryParts.join(" · ") : "No lanes stored"}
      </button>

      {expanded ? (
        <div className="ade-st-items">
          {archived.length > 0 ? (
            <>
              <GroupLabel>Archived lanes</GroupLabel>
              {archived.map((item) => (
                <ItemRow
                  key={item.id}
                  label={item.label}
                  path={item.path}
                  size={formatBytes(item.bytes)}
                  detail={laneDetail(item, archivedAtByKey.get(baseName(item.path)))}
                  action={removeRow(item)}
                />
              ))}
            </>
          ) : null}

          {orphaned.length > 0 ? (
            <>
              <GroupLabel>Left over from deleted lanes</GroupLabel>
              {orphaned.map((item) => (
                <ItemRow
                  key={item.id}
                  label={item.label}
                  path={item.path}
                  size={formatBytes(item.bytes)}
                  detail={laneDetail(item, null)}
                  action={removeRow(item)}
                />
              ))}
            </>
          ) : null}

          {active.length > 0 ? (
            <>
              <GroupLabel>Active lanes</GroupLabel>
              {active.map((item) => (
                <ItemRow key={item.id} label={item.label} path={item.path} size={formatBytes(item.bytes)} detail="In use — kept safe" muted />
              ))}
            </>
          ) : null}
        </div>
      ) : null}
    </CardShell>
  );
}

// ---------------------------------------------------------------------------
// Project database card
// ---------------------------------------------------------------------------

function DatabaseCard({
  category,
  policyChip,
  extras,
  trend,
  runMaintenance,
  maintenanceBusy,
}: {
  category: StorageCategorySnapshot;
  policyChip?: string;
  extras: StorageSnapshotExtras | undefined;
  trend: Trend | null;
  runMaintenance: (() => void) | null;
  maintenanceBusy: boolean;
}) {
  const rows = dbBreakdownRows(extras?.dbBreakdown);

  if (rows.length === 0) {
    // No breakdown available (older daemon) — keep the protected framing.
    return (
      <CardShell categoryId="database" category={category} policyChip={policyChip}>
        <div className="ade-st-item-detail" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <ShieldCheck size={14} style={{ color: "var(--kit-ok)" }} />
          This is your project&apos;s live data. ADE protects it automatically.
        </div>
      </CardShell>
    );
  }

  return (
    <CardShell
      categoryId="database"
      category={category}
      policyChip={policyChip}
      headerExtra={trend ? <TrendArrow trend={trend} /> : undefined}
      span
    >
      <div className="ade-st-items">
        {rows.map((row) => (
          <div key={row.table} className="ade-st-item">
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span className="ade-st-item-label">{row.label}</span>
                {row.isProtected ? (
                  <span className="kit-tag" data-tone="ok">
                    <ShieldCheck size={11} weight="fill" style={{ marginRight: 4 }} />Protected
                  </span>
                ) : null}
                {row.isPending ? (
                  <SmartTooltip
                    forceEnabled
                    side="top"
                    content={{ label: "Waiting to compact", description: DB_COMPACTION_PENDING_HINT }}
                  >
                    <span className="kit-tag">Waiting to compact</span>
                  </SmartTooltip>
                ) : null}
              </div>
              <div className="ade-st-item-detail">{row.hint}</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
              <span className="ade-st-item-size kit-num">{row.size}</span>
              {row.actionLabel && runMaintenance ? (
                <button
                  type="button"
                  onClick={runMaintenance}
                  disabled={maintenanceBusy}
                  className="ade-modern-btn"
                  data-size="sm"
                  data-variant="ghost"
                >
                  {row.actionLabel}
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </CardShell>
  );
}

function StoragePolicyPanel({
  value,
  effectiveValue,
  busy,
  onChange,
}: {
  value: LaneCleanupConfig;
  effectiveValue: LaneCleanupConfig;
  busy: boolean;
  /** Persists immediately (debounced) — there is no Save button. */
  onChange: (value: LaneCleanupConfig) => void;
}) {
  /**
   * These rules are three-state: unset (inherit from shared config), 0 (a
   * sentinel meaning "no limit" / "never"), or a real count. The old UI
   * rendered unset as an *empty box* with the inherited value only in the
   * placeholder, so "inherited 24" and "you typed nothing" looked identical
   * and you could never read the value actually in force. Now the field always
   * shows the number in effect, and says where it came from.
   */
  const field = (
    key: keyof Pick<LaneCleanupConfig, "maxActiveLanes" | "autoArchiveAfterHours" | "cleanupIntervalHours" | "reclaimArchivedAfterHours">,
    label: string,
    help: string,
    sentinelLabel: string,
    suffix: string,
  ) => {
    const local = value[key];
    const inherited = effectiveValue[key];
    const shown = local ?? inherited ?? 0;
    const isInherited = local == null;
    return (
      <ModernRow
        key={key}
        title={label}
        hint={help}
        control={(
          <>
            {isInherited ? (
              <span className="kit-tag">Inherited</span>
            ) : (
              <button
                type="button"
                className="ade-modern-btn"
                data-variant="link"
                style={{ fontSize: 11.5 }}
                onClick={() => onChange({ ...value, [key]: undefined })}
              >
                Reset to inherited
              </button>
            )}
            <SettingsNumber
              ariaLabel={label}
              value={shown}
              min={0}
              suffix={suffix}
              sentinelLabel={sentinelLabel}
              sentinelValue={0}
              onChange={(next) => onChange({ ...value, [key]: Math.max(0, Math.floor(next)) })}
            />
          </>
        )}
      />
    );
  };

  // The rules are an editable policy: one section owning the
  // `lane-storage-rules` anchor. The four fields stay rows of one panel,
  // because four anchors the manifest does not know would be hidden by
  // settings search.
  return (
    <ModernSection
      group="Lane storage"
      anchor="lane-storage-rules"
      title="Archive idle lanes"
      hint="ADE can archive lanes when they are safely idle. It never removes lane folders in the background."
      actions={busy ? <span className="ade-modern-muted">Saving…</span> : undefined}
    >
      <ModernRows>
        {field("maxActiveLanes", "Maximum active lanes", "Only clean, merged, idle lanes can be archived.", "No limit", "lanes")}
        {field("autoArchiveAfterHours", "Archive after inactivity", "Hours without lane activity before ADE may archive it.", "Never", "hours")}
        {field("cleanupIntervalHours", "Check every", "Hours between safety scans. A scan only archives eligible lanes and updates the review list.", "Disabled", "hours")}
        {field("reclaimArchivedAfterHours", "Review archived files after", "Hours before archived lane folders are marked ready for review. ADE still waits for confirmation.", "Never", "hours")}
      </ModernRows>
      <details className="ade-st-details">
        <summary>What counts as safe?</summary>
        <p className="ade-modern-muted">
          The lane must be ADE-managed, clean, merged, not protected, not part of a PR group, and have no running chat, terminal, or watcher.
          Attached folders and the primary lane are always left alone.
        </p>
      </details>
    </ModernSection>
  );
}

function ReclaimConfirmDialog({
  risk,
  busy,
  value,
  discardDirtyConfirmed,
  onChange,
  onDiscardDirtyChange,
  onClose,
  onConfirm,
}: {
  risk: LaneReclaimRisk;
  busy: boolean;
  value: string;
  discardDirtyConfirmed: boolean;
  onChange: (value: string) => void;
  onDiscardDirtyChange: (checked: boolean) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const warnings = risk.blockedReasons;
  const blocked = warnings.some((reason) => reason.disposition === "blocked");
  const dirtyNotConfirmed = risk.dirty && !discardDirtyConfirmed;
  return (
    <StorageDialogFrame
      title={`Archive & reclaim ${risk.laneName}`}
      canClose={!busy}
      onClose={onClose}
      panelStyleOverride={{
        width: "min(560px, 100%)",
        padding: 20,
        boxShadow: "0 28px 90px rgba(0,0,0,0.55)",
        overflow: "visible",
      }}
    >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <div>
            <h3 style={{ margin: 0, fontFamily: SANS_FONT, fontSize: 15, color: COLORS.textPrimary }}>Archive & reclaim “{risk.laneName}”</h3>
            <p style={{ margin: "7px 0 0", fontFamily: SANS_FONT, fontSize: 11.5, lineHeight: 1.55, color: COLORS.textMuted }}>
              Keeps the lane, branch, chats, and metadata. Removes its local worktree and generated lane data.
              Restoring the lane recreates the worktree.
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" style={{ ...outlineButton({ height: 30 }), width: 30, padding: 0 }}>
            <X size={14} />
          </button>
        </div>
        <div style={{ marginTop: 14, padding: 12, borderRadius: 9, border: `1px solid ${COLORS.borderMuted}`, background: COLORS.recessedBg }}>
          <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textPrimary }}>
            Estimated space: <strong>{formatBytes(risk.reclaimableBytes)}</strong>
          </div>
          <div style={{ marginTop: 4, fontFamily: SANS_FONT, fontSize: 10.5, color: COLORS.textMuted }}>
            Worktree {formatBytes(risk.worktreeBytes)} · generated data {formatBytes(risk.generatedBytes)}
          </div>
        </div>
        {warnings.length > 0 ? (
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 7 }}>
            {warnings.map((warning) => (
              <Banner
                key={warning.code}
                layout="inline"
                model={{ id: `lane-reclaim-warning:${warning.code}`, tone: "warning", title: warning.message }}
              />
            ))}
          </div>
        ) : null}
        {risk.dirty ? (
          <label style={{ display: "flex", alignItems: "flex-start", gap: 9, marginTop: 14, color: COLORS.warning, fontFamily: SANS_FONT, fontSize: 11, lineHeight: 1.45 }}>
            <input
              type="checkbox"
              checked={discardDirtyConfirmed}
              disabled={busy}
              onChange={(event) => onDiscardDirtyChange(event.target.checked)}
              style={{ marginTop: 2 }}
            />
            <span>Discard uncommitted changes in this lane. These file changes cannot be restored.</span>
          </label>
        ) : null}
        <label style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 14 }}>
          <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textSecondary }}>
            Type <strong>RECLAIM</strong> to confirm
          </span>
          <input
            autoFocus
            value={value}
            onChange={(event) => onChange(event.target.value)}
            style={{ height: 36, borderRadius: 8, border: `1px solid ${COLORS.outlineBorder}`, background: COLORS.recessedBg, color: COLORS.textPrimary, padding: "0 10px", fontFamily: SANS_FONT }}
          />
        </label>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button type="button" onClick={onClose} disabled={busy} style={outlineButton()}>Cancel</button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy || blocked || dirtyNotConfirmed || value !== "RECLAIM"}
            style={{ ...primaryButton(), opacity: busy || blocked || dirtyNotConfirmed || value !== "RECLAIM" ? 0.55 : 1 }}
          >
            {busy
              ? "Reclaiming…"
              : blocked
                ? "Cannot reclaim this folder"
                : dirtyNotConfirmed
                  ? "Confirm discarded changes"
                  : `Reclaim ${formatBytes(risk.reclaimableBytes)}`}
          </button>
        </div>
    </StorageDialogFrame>
  );
}

function StorageReviewPanel({
  snapshot,
  laneIdByKey,
  onCleanup,
  onReclaim,
  onRestore,
}: {
  snapshot: StorageSnapshot;
  laneIdByKey: Map<string, string>;
  onCleanup: (request: CleanupRequest) => void;
  onReclaim: (laneId: string) => void;
  onRestore: (laneId: string) => void;
}) {
  const rows = snapshot.categories.flatMap((category) =>
    category.items
      .filter((item) =>
        (category.id === "lanes_worktrees" && item.laneStatus !== "active")
        || category.id === "build_release",
      )
      .map((item) => ({ categoryId: category.id, item })),
  );
  return (
    <ModernSection
      group="Review files"
      title="Review files before cleanup"
      hint="Sizes are estimates. ADE checks every path again after you confirm and reports anything it could not remove."
    >
      {rows.length === 0 ? (
        <div className="ade-modern-note">
          <ShieldCheck size={14} />
          <span>Nothing needs review right now.</span>
        </div>
      ) : (
        <div className="ade-st-table-wrap">
          <table className="ade-st-table">
            <thead>
              <tr>
                {["Item", "Type", "Owner", "Age", "Can reclaim", "Why blocked", ""].map((label) => (
                  <th key={label}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ categoryId, item }) => {
                const laneId = item.laneId ?? laneIdByKey.get(baseName(item.path));
                const target = buildCleanupTarget(categoryId, item, laneIdByKey);
                const reclaimFailed = item.reclaimState === "failed";
                const reclaimed = item.laneStatus === "archived" && item.bytes === 0 && !reclaimFailed;
                return (
                  <tr key={`${categoryId}:${item.id}`}>
                    <td>
                      <span className="ade-st-item-label">{item.label}</span>
                      <div className="ade-st-item-path" title={item.path} style={{ maxWidth: 260 }}>{item.path}</div>
                    </td>
                    <td>{item.laneStatus === "archived" ? "Archived lane" : item.laneStatus === "orphaned" ? "Leftover worktree" : "Build output"}</td>
                    <td>{item.ownership ?? "ADE-managed"}</td>
                    <td>{formatAgeHours(item.ageHours)}</td>
                    <td className="kit-num">{formatBytes(item.reclaimableBytes ?? item.bytes)}</td>
                    <td style={{ maxWidth: 250 }}>{item.blockedReasons?.join(" ") || "Ready for review"}</td>
                    <td style={{ textAlign: "right" }}>
                      {reclaimed && laneId ? (
                        <ActionButton label="Restore lane" icon={<ArrowClockwise size={13} />} onClick={() => onRestore(laneId)} />
                      ) : item.laneStatus === "archived" && laneId ? (
                        <ActionButton label="Archive & reclaim…" icon={<Archive size={13} />} onClick={() => onReclaim(laneId)} />
                      ) : target ? (
                        <ActionButton
                          label={`Review ${formatBytes(item.reclaimableBytes ?? item.bytes)}…`}
                          icon={<Broom size={13} />}
                          onClick={() => onCleanup({
                            title: item.laneStatus === "orphaned" ? "Remove leftover worktree" : "Remove generated files",
                            intro: item.laneStatus === "orphaned"
                              ? "This ADE-managed worktree is not owned by a lane. ADE will verify it again before removal."
                              : "This is generated or temporary data. ADE will verify that it is not active before removal.",
                            targets: [target],
                          })}
                        />
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </ModernSection>
  );
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

export function StorageSection() {
  // Which machine's disk this is. Runtime actions carry `pin`; the plain-IPC
  // reads (disk pressure, app resource usage, runtime health) only ever reach
  // This computer, so they are skipped for any other machine.
  const { pin, isThisMachine } = useSettingsMachineScope();
  const [snapshot, setSnapshot] = React.useState<StorageSnapshot | null>(null);
  const [pressureState, setPressureState] = React.useState<DiskPressureSnapshot["state"] | undefined>();
  const [laneIdByKey, setLaneIdByKey] = React.useState<Map<string, string>>(new Map());
  const [archivedAtByKey, setArchivedAtByKey] = React.useState<Map<string, string | null>>(new Map());
  const [usage, setUsage] = React.useState<AppResourceUsageSnapshot | null>(null);
  const [usageReady, setUsageReady] = React.useState(false);
  const [runtimeHealth, setRuntimeHealth] = React.useState<RuntimeHealthSnapshot | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [cleanup, setCleanup] = React.useState<CleanupRequest | null>(null);
  const [safeOpen, setSafeOpen] = React.useState(false);
  const [compressing, setCompressing] = React.useState(false);
  const [maintenanceBusy, setMaintenanceBusy] = React.useState(false);
  const [policy, setPolicy] = React.useState<LaneCleanupConfig>({});
  const [effectivePolicy, setEffectivePolicy] = React.useState<LaneCleanupConfig>({});
  const [policyBusy, setPolicyBusy] = React.useState(false);
  const [reclaimRisk, setReclaimRisk] = React.useState<LaneReclaimRisk | null>(null);
  const [reclaimConfirm, setReclaimConfirm] = React.useState("");
  const [discardDirtyConfirmed, setDiscardDirtyConfirmed] = React.useState(false);
  const [reclaimBusy, setReclaimBusy] = React.useState(false);
  const policySaveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const compressNow = React.useMemo(() => getCompressNow(), []);
  const runMaintenanceNowBridge = React.useMemo(() => getRunMaintenanceNow(), []);
  const runMaintenanceNow = React.useMemo<(() => Promise<MaintenanceRunReport>) | undefined>(
    () => (runMaintenanceNowBridge ? () => runMaintenanceNowBridge(pin) : undefined),
    [pin, runMaintenanceNowBridge],
  );
  const runtimeHealthFn = React.useMemo(() => (isThisMachine ? getRuntimeHealthFn() : undefined), [isThisMachine]);

  const notify = React.useCallback((message: string, tone: ToastTone = "success") => {
    showToast({ id: STORAGE_TOAST_ID, title: message, tone, durationMs: 4500 });
  }, []);
  const notifyMaintenance = React.useCallback((outcome: { message: string; failed: boolean }) => {
    notify(outcome.message, outcome.failed ? "warning" : "success");
  }, [notify]);

  const load = React.useCallback(async (opts: { force?: boolean; silent?: boolean } = {}) => {
    if (opts.silent || opts.force) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const [snap, pressure, lanes, config] = await Promise.all([
        window.ade.storage.getSnapshot({ forceRefresh: opts.force }, pin),
        isThisMachine ? window.ade.storage.getPressure().catch(() => null) : Promise.resolve(null),
        window.ade.lanes?.list?.({ includeArchived: true }, pin).catch(() => []) ?? Promise.resolve([]),
        window.ade.projectConfig.get(pin),
      ]);
      const ids = new Map<string, string>();
      const archivedAt = new Map<string, string | null>();
      for (const lane of lanes) {
        const key = baseName(lane.worktreePath);
        ids.set(key, lane.id);
        archivedAt.set(key, lane.archivedAt ?? null);
      }
      setSnapshot(snap);
      setPressureState(pressure?.state);
      setLaneIdByKey(ids);
      setArchivedAtByKey(archivedAt);
      setPolicy({
        ...(config.local.laneCleanup ?? {}),
        autoDeleteArchivedAfterHours: undefined,
        deleteRemoteBranchOnCleanup: undefined,
      });
      setEffectivePolicy(config.effective.laneCleanup ?? {});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [isThisMachine, pin]);

  const loadDiagnostics = React.useCallback(async () => {
    const [nextUsage, nextHealth] = await Promise.all([
      isThisMachine ? getAppResourceUsageCoalesced() : Promise.resolve(null),
      runtimeHealthFn ? runtimeHealthFn().catch(() => null) : Promise.resolve(null),
    ]);
    setUsage(nextUsage);
    setUsageReady(true);
    setRuntimeHealth(nextHealth);
  }, [isThisMachine, runtimeHealthFn]);

  React.useEffect(() => {
    void load();
    void loadDiagnostics();
    return () => {
      // Flush a pending rule edit rather than dropping it on unmount.
      if (policySaveTimer.current) clearTimeout(policySaveTimer.current);
    };
  }, [load, loadDiagnostics]);

  const runCompress = React.useCallback(async () => {
    if (!compressNow) return;
    setCompressing(true);
    try {
      const result = await compressNow(pin);
      notify(`Compressed ${result.filesCompressed} ${result.filesCompressed === 1 ? "file" : "files"}, freed ${formatBytes(result.savedBytes)}`);
      void load({ force: true, silent: true });
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not compress history", "error");
    } finally {
      setCompressing(false);
    }
  }, [compressNow, load, notify, pin]);

  const runMaintenanceInline = React.useCallback(async () => {
    if (!runMaintenanceNow || maintenanceBusy) return;
    setMaintenanceBusy(true);
    try {
      const report = await runMaintenanceNow();
      notifyMaintenance(maintenanceOutcome(report));
      void load({ force: true, silent: true });
      void loadDiagnostics();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not run cleanup", "error");
    } finally {
      setMaintenanceBusy(false);
    }
  }, [runMaintenanceNow, maintenanceBusy, notify, notifyMaintenance, load, loadDiagnostics]);

  const savePolicy = React.useCallback(async (next: LaneCleanupConfig) => {
    setPolicyBusy(true);
    try {
      const current = await window.ade.projectConfig.get(pin);
      await window.ade.projectConfig.save({
        shared: current.shared,
        local: { ...current.local, laneCleanup: next },
      }, pin);
      void load({ force: true, silent: true });
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not save storage rules", "error");
    } finally {
      setPolicyBusy(false);
    }
  }, [load, notify, pin]);

  /**
   * Storage rules save as you edit — there is no Save button anywhere in
   * settings. The debounce is so typing "120" doesn't write 1, then 12, then
   * 120; the field stays responsive because local state updates immediately.
   */
  const commitPolicy = React.useCallback((next: LaneCleanupConfig) => {
    setPolicy(next);
    if (policySaveTimer.current) clearTimeout(policySaveTimer.current);
    policySaveTimer.current = setTimeout(() => {
      policySaveTimer.current = null;
      void savePolicy(next);
    }, 600);
  }, [savePolicy]);

  const openReclaim = React.useCallback(async (laneId: string) => {
    try {
      const risk = await window.ade.lanes.getReclaimRisk({ laneId }, pin);
      setReclaimConfirm("");
      setDiscardDirtyConfirmed(false);
      setReclaimRisk(risk);
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not review this lane", "error");
    }
  }, [notify, pin]);

  const confirmReclaim = React.useCallback(async () => {
    if (!reclaimRisk || reclaimConfirm !== "RECLAIM" || (reclaimRisk.dirty && !discardDirtyConfirmed)) return;
    setReclaimBusy(true);
    try {
      const result = await window.ade.lanes.archiveAndReclaim({
        laneId: reclaimRisk.laneId,
        confirmation: "RECLAIM",
        ...(reclaimRisk.dirty && discardDirtyConfirmed ? { forceDirty: true } : {}),
      }, pin);
      notify(`Reclaimed about ${formatBytes(result.reclaimedBytes)}. The lane, branch, and chats were kept.`);
      setReclaimRisk(null);
      setReclaimConfirm("");
      setDiscardDirtyConfirmed(false);
      void load({ force: true, silent: true });
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not reclaim this lane", "error");
    } finally {
      setReclaimBusy(false);
    }
  }, [discardDirtyConfirmed, load, reclaimConfirm, reclaimRisk, notify, pin]);

  const restoreLane = React.useCallback(async (laneId: string) => {
    try {
      // The lane lives on the machine this page shows; its id only means
      // something there.
      const result = await window.ade.lanes.unarchive({ laneId }, pin);
      notify(
        result.setupWarning
          ? `Lane restored. Setup needs attention: ${result.setupWarning}`
          : result.worktreeRecreated ? "Lane restored and its worktree was recreated." : "Lane restored.",
        result.setupWarning ? "warning" : "success",
      );
      void load({ force: true, silent: true });
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not restore this lane", "error");
    }
  }, [load, notify, pin]);

  const onCleaned = React.useCallback((_result: StorageCleanupResult) => {
    void load({ force: true, silent: true });
    void loadDiagnostics();
  }, [load, loadDiagnostics]);

  const byId = React.useMemo(() => {
    const map = new Map<StorageCategoryId, StorageCategorySnapshot>();
    for (const category of snapshot?.categories ?? []) map.set(category.id, category);
    return map;
  }, [snapshot]);

  const extras = snapshot?.extras;
  const reclaimable = safeReclaimableBytes(extras);
  const dbTrend = React.useMemo(() => dbSizeTrend(dbSizeSamples(extras)), [extras]);

  // Assemble the safe-cleanup dialog configuration lazily when opened.
  const safeConfig = React.useMemo<{ targets: StorageCleanupTarget[]; plan: SafeCleanupPlanConfig } | null>(() => {
    if (!snapshot) return null;
    const plan = buildSafeCleanupPlan(snapshot, laneIdByKey);
    if (runMaintenanceNow) {
      return {
        targets: plan.fsTargets,
        plan: {
          groups: plan.groups,
          whatHappens: plan.whatHappens,
          estimatedBytes: plan.estimatedBytes,
          confirmLabel: "Clean up safely",
          runMaintenance: runMaintenanceNow,
          onMaintenanceDone: (report) => {
            notifyMaintenance(maintenanceOutcome(report));
          },
        },
      };
    }
    // Legacy fallback: only filesystem-safe targets are actionable here.
    return {
      targets: plan.fsTargets,
      plan: {
        groups: plan.fsGroup ? [plan.fsGroup] : [],
        whatHappens: [
          "Remove temporary and rebuildable files ADE recreates on demand.",
          "Your chats, projects, active lanes, and backups are never touched.",
        ],
        estimatedBytes: plan.fsBytes,
        confirmLabel: "Clean up safely",
      },
    };
  }, [snapshot, laneIdByKey, runMaintenanceNow, notifyMaintenance]);

  const reclaimableBytes = runMaintenanceNow ? (safeConfig?.plan.estimatedBytes ?? 0) : reclaimable;
  const hint = snapshot
    ? `ADE is using ${formatBytes(snapshot.totalAdeBytes)} · ${formatBytes(snapshot.volume.freeBytes)} free on this disk.`
    : "What ADE keeps on this computer for this project, and what you can safely clear.";

  return (
    // The `storage` anchor lives on the disk-usage section, so a `#storage`
    // deeplink lands on the figures. It is rendered in every state (loading,
    // error, loaded) so the anchor is there for a deeplink that arrives
    // before the scan finishes.
    <div className="ade-modern-sections">
      <ModernSection
        group="Disk usage"
        anchor="storage"
        title="Disk usage"
        hint={hint}
        actions={snapshot ? (
          <>
            <button
              type="button"
              onClick={() => void load({ force: true })}
              disabled={refreshing}
              className="ade-modern-btn"
              data-variant="ghost"
            >
              <ArrowClockwise size={13} className={refreshing ? "animate-spin" : undefined} />
              {refreshing ? "Rescanning" : "Rescan"}
            </button>
            {safeConfig && reclaimableBytes > 0 ? (
              <button type="button" onClick={() => setSafeOpen(true)} className="ade-modern-btn" data-tone="primary">
                <Broom size={13} />
                Clean up safely · {formatApproxBytes(reclaimableBytes)}
              </button>
            ) : null}
          </>
        ) : undefined}
      >
        {loading && !snapshot ? (
          <StorageSkeleton />
        ) : error && !snapshot ? (
          <div className="ade-modern-note" data-tone="crit">
            <HardDrives size={14} />
            <div className="ade-modern-note-body">
              <strong style={{ fontWeight: 600, color: "var(--color-fg)" }}>ADE couldn&apos;t measure storage right now.</strong>
              <span>{error}</span>
            </div>
            <button type="button" onClick={() => void load({ force: true })} className="ade-modern-btn" data-size="sm">
              <ArrowClockwise size={12} /> Try again
            </button>
          </div>
        ) : snapshot ? (
          <DiskOverview snapshot={snapshot} pressureState={pressureState} reclaimableBytes={reclaimableBytes} />
        ) : null}
      </ModernSection>

      {snapshot ? (
        <>
          {snapshot.categories.some((category) => byId.has(category.id) && CATEGORY_ORDER.includes(category.id)) ? (
          <ModernSection
            group="What ADE keeps"
            title="What ADE keeps"
            hint="ADE never removes lane folders, build output, or leftovers in the background. Files stay until you review and confirm cleanup."
          >
            <div className="ade-st-grid">
              {CATEGORY_ORDER.map((categoryId) => {
                const category = byId.get(categoryId);
                if (!category) return null;
                const policyChip = categoryPolicyChip(extras, categoryId);
                if (categoryId === "lanes_worktrees") {
                  return (
                    <LanesCard
                      key={categoryId}
                      category={category}
                      policyChip={policyChip}
                      laneIdByKey={laneIdByKey}
                      archivedAtByKey={archivedAtByKey}
                      onRequestCleanup={setCleanup}
                      onReclaim={(laneId) => void openReclaim(laneId)}
                      onRestore={(laneId) => void restoreLane(laneId)}
                    />
                  );
                }
                if (categoryId === "database") {
                  return (
                    <DatabaseCard
                      key={categoryId}
                      category={category}
                      policyChip={policyChip}
                      extras={extras}
                      trend={dbTrend}
                      runMaintenance={runMaintenanceNow ? () => void runMaintenanceInline() : null}
                      maintenanceBusy={maintenanceBusy}
                    />
                  );
                }
                return (
                  <CategoryCardBody
                    key={categoryId}
                    categoryId={categoryId}
                    category={category}
                    policyChip={policyChip}
                    laneIdByKey={laneIdByKey}
                    compressNow={compressNow}
                    compressing={compressing}
                    onCompress={() => void runCompress()}
                    onRequestCleanup={setCleanup}
                  />
                );
              })}
            </div>
          </ModernSection>
          ) : null}

          <StorageReviewPanel
            snapshot={snapshot}
            laneIdByKey={laneIdByKey}
            onCleanup={setCleanup}
            onReclaim={(laneId) => void openReclaim(laneId)}
            onRestore={(laneId) => void restoreLane(laneId)}
          />

          <StoragePolicyPanel
            value={policy}
            effectiveValue={effectivePolicy}
            busy={policyBusy}
            onChange={commitPolicy}
          />

          <DiagnosticsStrip
            extras={extras}
            usage={usage}
            usageReady={usageReady}
            runtimeHealth={runtimeHealth}
            runtimeHealthAvailable={Boolean(runtimeHealthFn)}
          >
            {/* Reads through unpinned simulator/file calls, so only for the tab's machine. */}
            {pin ? null : <AppleRecordingsWarning projectRoot={snapshot.projectRoot} />}
            <MaintenanceJournal extras={extras} />
          </DiagnosticsStrip>
        </>
      ) : null}

      <StorageCleanupDialog
        open={cleanup != null}
        title={cleanup?.title ?? ""}
        intro={cleanup?.intro}
        targets={cleanup?.targets ?? EMPTY_TARGETS}
        onClose={() => setCleanup(null)}
        onCleaned={onCleaned}
      />

      {safeConfig ? (
        <StorageCleanupDialog
          open={safeOpen}
          title="Clean up safely"
          intro="ADE will reclaim space it can rebuild or no longer needs. Your chats, projects, and active lanes stay untouched, and the newest recovery backup is always kept."
          targets={safeConfig.targets}
          plan={safeConfig.plan}
          onClose={() => setSafeOpen(false)}
          onCleaned={onCleaned}
        />
      ) : null}

      {reclaimRisk ? (
        <ReclaimConfirmDialog
          risk={reclaimRisk}
          busy={reclaimBusy}
          value={reclaimConfirm}
          discardDirtyConfirmed={discardDirtyConfirmed}
          onChange={setReclaimConfirm}
          onDiscardDirtyChange={setDiscardDirtyConfirmed}
          onClose={() => {
            if (!reclaimBusy) {
              setReclaimRisk(null);
              setDiscardDirtyConfirmed(false);
            }
          }}
          onConfirm={() => void confirmReclaim()}
        />
      ) : null}
    </div>
  );
}

const EMPTY_TARGETS: StorageCleanupTarget[] = [];

function CategoryCardBody({
  categoryId,
  category,
  policyChip,
  laneIdByKey,
  compressNow,
  compressing,
  onCompress,
  onRequestCleanup,
}: {
  categoryId: StorageCategoryId;
  category: StorageCategorySnapshot;
  policyChip?: string;
  laneIdByKey: Map<string, string>;
  compressNow: CompressNow | undefined;
  compressing: boolean;
  onCompress: () => void;
  onRequestCleanup: (request: CleanupRequest) => void;
}) {
  if (categoryId === "chats_history") {
    const compressible = category.compressibleBytes ?? 0;
    return (
      <CardShell categoryId={categoryId} category={category} policyChip={policyChip}>
        {compressible > 0 && compressNow ? (
          <div className="ade-st-items">
            <div className="ade-st-item-detail">
              About {formatBytes(compressible)} of older history can be compressed without losing anything.
            </div>
            <div>
              <button
                type="button"
                onClick={onCompress}
                disabled={compressing}
                className="ade-modern-btn"
                data-size="sm"
              >
                <FileZip size={13} className={compressing ? "animate-spin" : undefined} />
                {compressing ? "Compressing…" : "Compress old history"}
              </button>
            </div>
          </div>
        ) : (
          <div className="ade-st-item-detail">Kept so you can reopen past chats and terminals.</div>
        )}
      </CardShell>
    );
  }

  if (categoryId === "caches") {
    const cleanable = cleanableEntries(categoryId, category, laneIdByKey);
    const protectedItems = category.items.filter((item) => item.safety === "protected");
    return (
      <CardShell categoryId={categoryId} category={category} policyChip={policyChip}>
        {cleanable.length > 0 ? (
          <ActionButton
            label={`Clean up ${formatBytes(cleanable.reduce((sum, entry) => sum + entry.item.bytes, 0))}…`}
            icon={<Broom size={13} />}
            onClick={() =>
              onRequestCleanup({
                title: "Clean up caches",
                intro: "These are rebuildable files ADE recreates when it needs them. Removing them is safe.",
                targets: cleanable.map((entry) => entry.target),
              })
            }
          />
        ) : null}
        {protectedItems.map((item) => (
          <ItemRow key={item.id} label={item.label} size={formatBytes(item.bytes)} detail={item.detail} muted />
        ))}
        {cleanable.length === 0 && protectedItems.length === 0 ? <EmptyLine /> : null}
      </CardShell>
    );
  }

  if (categoryId === "build_release") {
    const cleanable = cleanableEntries(categoryId, category, laneIdByKey);
    const top = [...category.items].sort((a, b) => b.bytes - a.bytes).slice(0, 3);
    return (
      <CardShell categoryId={categoryId} category={category} policyChip={policyChip}>
        {top.map((item) => (
          <ItemRow
            key={item.id}
            label={item.label}
            size={formatBytes(item.bytes)}
            detail={item.lastModifiedAt ? `Last used ${relativeWhen(item.lastModifiedAt)}` : item.detail}
            muted={item.safety !== "safe_to_remove"}
          />
        ))}
        {cleanable.length > 0 ? (
          <div>
            <ActionButton
              label={`Clean up ${formatBytes(cleanable.reduce((sum, entry) => sum + entry.item.bytes, 0))}…`}
              icon={<Broom size={13} />}
              onClick={() =>
                onRequestCleanup({
                  title: "Clean up build files",
                  intro: "These are leftover staging files from building and releasing. They rebuild automatically when needed.",
                  targets: cleanable.map((entry) => entry.target),
                })
              }
            />
          </div>
        ) : null}
        {category.items.length === 0 ? <EmptyLine /> : null}
      </CardShell>
    );
  }

  if (categoryId === "proof_attachments") {
    const cleanable = cleanableEntries(categoryId, category, laneIdByKey);
    return (
      <CardShell categoryId={categoryId} category={category} policyChip={policyChip}>
        {category.bytes > 0 ? (
          <div className="ade-st-items">
            {cleanable.map((entry) => (
              <ItemRow
                key={entry.item.id}
                label={entry.item.label}
                size={formatBytes(entry.item.bytes)}
                detail={entry.item.lastModifiedAt ? `Last added ${relativeWhen(entry.item.lastModifiedAt)}` : entry.item.detail}
                action={
                  <ActionButton
                    label="Remove…"
                    icon={<Archive size={13} />}
                    onClick={() =>
                      onRequestCleanup({
                        title: `Remove ${entry.item.label}`,
                        intro:
                          "These are the screenshots, recordings, and files agents attached as proof. Removing them deletes the files and the entries in every chat's proof drawer. Nothing else is affected.",
                        targets: [entry.target],
                      })
                    }
                  />
                }
              />
            ))}
            {cleanable.length === 0 ? (
              <div className="ade-st-item-detail">
                Proof storage is in use but cannot be removed from here. Open the proof drawer in a chat to delete individual items.
              </div>
            ) : null}
          </div>
        ) : (
          <EmptyLine label="Nothing captured yet." />
        )}
      </CardShell>
    );
  }

  if (categoryId === "recovery_backups") {
    return (
      <CardShell categoryId={categoryId} category={category} policyChip={policyChip}>
        {category.items.length > 0 ? (
          <div className="ade-st-items">
            {category.items.map((item) => (
              <ItemRow
                key={item.id}
                label={item.label}
                size={formatBytes(item.bytes)}
                detail={item.lastModifiedAt ? `Saved ${relativeWhen(item.lastModifiedAt)}` : undefined}
                action={
                  <ActionButton
                    label="Remove…"
                    icon={<Archive size={13} />}
                    onClick={() =>
                      onRequestCleanup({
                        title: "Remove recovery backup",
                        intro: "ADE saved this snapshot before a risky change. Remove it once you're confident you no longer need to roll back.",
                        targets: [{ kind: "recovery_backup", path: item.path }],
                      })
                    }
                  />
                }
              />
            ))}
          </div>
        ) : (
          <EmptyLine label="No backups saved." />
        )}
      </CardShell>
    );
  }

  // Fallback (should not reach here — database handled above).
  return (
    <CardShell categoryId={categoryId} category={category} policyChip={policyChip}>
      <EmptyLine />
    </CardShell>
  );
}

function EmptyLine({ label = "Nothing stored yet." }: { label?: string }) {
  return <div className="ade-st-item-detail">{label}</div>;
}

function StorageSkeleton() {
  return (
    <div className="ade-modern-stats" aria-busy="true">
      {["ADE data", "Free on disk", "Safe to reclaim", "Scanned"].map((label, index) => (
        <div key={label} className="ade-modern-stat">
          <span className="kit-eyebrow">{label}</span>
          <span className="ade-st-shimmer" />
          {index === 0 ? (
            <span className="ade-modern-stat-sub" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <HardDrives size={12} className="animate-pulse" /> Measuring what ADE is storing…
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

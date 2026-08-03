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
  WarningCircle,
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
} from "../../../shared/types";
import { ScopeChip, SettingsNumber } from "./primitives";
import { relativeWhen } from "../../lib/format";
import { appResourcePressureLevel, getAppResourceUsageCoalesced } from "../../lib/resourcePressure";
import {
  COLORS,
  SANS_FONT,
  LABEL_STYLE,
  inlineBadge,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";
import { SettingsSectionShell } from "./settingsSectionUi";
import { SmartTooltip } from "../ui/SmartTooltip";
import {
  StorageCleanupDialog,
  StorageDialogFrame,
  type SafeCleanupPlanConfig,
} from "./storage/StorageCleanupDialog";
import { PANEL_STYLE, STORAGE_BRAND } from "./storage/storageUiConstants";
import { DiagnosticsStrip, TrendArrow } from "./storage/StorageDiagnostics";
import { MaintenanceJournal } from "./storage/StorageMaintenanceJournal";
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

type CompressNow = () => Promise<{ filesCompressed: number; savedBytes: number }>;
type RunMaintenanceNow = () => Promise<MaintenanceRunReport>;
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

function SafetyBadge({ safety }: { safety: StorageItem["safety"] }) {
  const meta = SAFETY_META[safety];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 8px",
        borderRadius: 6,
        fontFamily: SANS_FONT,
        fontSize: 10.5,
        fontWeight: 600,
        color: meta.color,
        background: `color-mix(in srgb, ${meta.color} 14%, transparent)`,
        border: `1px solid color-mix(in srgb, ${meta.color} 26%, transparent)`,
        whiteSpace: "nowrap",
      }}
    >
      {meta.label}
    </span>
  );
}

function PolicyChip({ label }: { label: string }) {
  return (
    <span
      style={inlineBadge(COLORS.textSecondary, {
        fontSize: 10.5,
        padding: "2px 8px",
        background: "color-mix(in srgb, var(--color-fg) 6%, transparent)",
        border: `1px solid ${COLORS.borderMuted}`,
        color: COLORS.textSecondary,
      })}
    >
      {label}
    </span>
  );
}

function BreakdownBar({ categories }: { categories: StorageCategorySnapshot[] }) {
  const present = categories.filter((category) => category.bytes > 0);
  const legend = [...present].sort((a, b) => b.bytes - a.bytes);
  if (present.length === 0) {
    return (
      <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted }}>
        ADE is not storing anything for this project yet.
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div
        style={{
          display: "flex",
          height: 14,
          borderRadius: 7,
          overflow: "hidden",
          background: "color-mix(in srgb, var(--color-fg) 7%, transparent)",
        }}
      >
        {legend.map((category) => (
          <div
            key={category.id}
            title={`${CATEGORY_META[category.id].name} · ${formatBytes(category.bytes)}`}
            style={{
              flexGrow: category.bytes,
              flexBasis: 0,
              minWidth: 5,
              background: CATEGORY_META[category.id].hue,
            }}
          />
        ))}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px" }}>
        {legend.map((category) => (
          <div key={category.id} style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span
              style={{
                width: 9,
                height: 9,
                borderRadius: 3,
                background: CATEGORY_META[category.id].hue,
                flexShrink: 0,
              }}
            />
            <span style={{ fontFamily: SANS_FONT, fontSize: 11.5, color: COLORS.textSecondary }}>
              {CATEGORY_META[category.id].name}
            </span>
            <span style={{ fontFamily: SANS_FONT, fontSize: 11.5, color: COLORS.textMuted, fontVariantNumeric: "tabular-nums" }}>
              {formatBytes(category.bytes)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function pressureTone(state: DiskPressureSnapshot["state"] | undefined): string {
  if (state && isUrgentDiskPressure(state)) return COLORS.danger;
  if (state === "warning") return COLORS.warning;
  return COLORS.textMuted;
}

function DiskGauge({
  snapshot,
  pressureState,
}: {
  snapshot: StorageSnapshot;
  pressureState: DiskPressureSnapshot["state"] | undefined;
}) {
  const { freeBytes, totalBytes } = snapshot.volume;
  const used = Math.max(0, totalBytes - freeBytes);
  const adeUsed = Math.min(snapshot.totalAdeBytes, used);
  const otherUsed = Math.max(0, used - adeUsed);
  const toneColor = pressureTone(pressureState);
  const freeTone = pressureState && pressureState !== "normal" ? toneColor : COLORS.textSecondary;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontFamily: SANS_FONT, fontSize: 15, fontWeight: 600, color: COLORS.textPrimary }}>
        ADE is using {formatBytes(snapshot.totalAdeBytes)}
        <span style={{ color: freeTone, fontWeight: 500 }}> · {formatBytes(freeBytes)} free on this disk</span>
      </div>
      <div
        style={{
          display: "flex",
          height: 8,
          borderRadius: 5,
          overflow: "hidden",
          background: "color-mix(in srgb, var(--color-fg) 6%, transparent)",
        }}
      >
        {adeUsed > 0 ? <div style={{ flexGrow: adeUsed, flexBasis: 0, minWidth: 3, background: COLORS.accent }} /> : null}
        {otherUsed > 0 ? (
          <div style={{ flexGrow: otherUsed, flexBasis: 0, background: "color-mix(in srgb, var(--color-fg) 24%, transparent)" }} />
        ) : null}
        {freeBytes > 0 ? <div style={{ flexGrow: freeBytes, flexBasis: 0 }} /> : null}
      </div>
    </div>
  );
}

function Hero({
  snapshot,
  pressureState,
  refreshing,
  reclaimableBytes,
  onRescan,
  onCleanSafely,
}: {
  snapshot: StorageSnapshot;
  pressureState: DiskPressureSnapshot["state"] | undefined;
  refreshing: boolean;
  reclaimableBytes: number;
  onRescan: () => void;
  onCleanSafely: (() => void) | null;
}) {
  return (
    <section style={{ ...PANEL_STYLE, padding: 20, display: "flex", flexDirection: "column", gap: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
        <DiskGauge snapshot={snapshot} pressureState={pressureState} />
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
            {onCleanSafely && reclaimableBytes > 0 ? (
              <button type="button" onClick={onCleanSafely} style={primaryButton({ height: 32 })}>
                <Broom size={14} />
                Clean up safely · {formatApproxBytes(reclaimableBytes)}
              </button>
            ) : null}
            <button
              type="button"
              onClick={onRescan}
              disabled={refreshing}
              style={{ ...outlineButton({ height: 32 }), opacity: refreshing ? 0.7 : 1 }}
            >
              <ArrowClockwise size={14} className={refreshing ? "animate-spin" : undefined} />
              {refreshing ? "Rescanning" : "Rescan"}
            </button>
          </div>
          <div style={{ fontFamily: SANS_FONT, fontSize: 10.5, color: COLORS.textMuted }}>
            Scanned {relativeWhen(snapshot.generatedAt)}
          </div>
          {snapshot.lifecycle ? (
            <div style={{ fontFamily: SANS_FONT, fontSize: 10.5, color: COLORS.textDim, textAlign: "right", lineHeight: 1.45 }}>
              Safety scan: {snapshot.lifecycle.lastScanAt ? relativeWhen(snapshot.lifecycle.lastScanAt) : "not run yet"}
              <br />
              Next: {snapshot.lifecycle.nextScanAt ? relativeWhen(snapshot.lifecycle.nextScanAt) : "disabled"}
            </div>
          ) : null}
        </div>
      </div>
      <BreakdownBar categories={snapshot.categories} />
      {snapshot.truncated ? (
        <div style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted }}>
          Some items were skipped to keep this scan fast, so sizes may be slightly under-counted.
        </div>
      ) : null}
    </section>
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
    <section style={{ ...PANEL_STYLE, gridColumn: span ? "1 / -1" : undefined, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
          <span style={{ width: 10, height: 10, borderRadius: 3, background: meta.hue, flexShrink: 0 }} />
          <h3 style={{ margin: 0, fontFamily: SANS_FONT, fontSize: 13.5, fontWeight: 650, color: COLORS.textPrimary }}>
            {meta.name}
          </h3>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          {headerExtra}
          <span style={{ fontFamily: SANS_FONT, fontSize: 13, fontWeight: 600, color: COLORS.textSecondary, fontVariantNumeric: "tabular-nums" }}>
            {formatBytes(category.bytes)}
          </span>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <p style={{ margin: 0, fontFamily: SANS_FONT, fontSize: 11.5, lineHeight: 1.45, color: COLORS.textMuted }}>
          {meta.description}
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {policyChip ? <PolicyChip label={policyChip} /> : null}
          <SafetyBadge safety={category.safety} />
        </div>
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
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{ ...outlineButton({ height: 30, fontSize: 11.5 }), opacity: disabled ? 0.6 : 1, cursor: disabled ? "not-allowed" : "pointer" }}
    >
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
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "8px 10px",
        borderRadius: 9,
        border: `1px solid ${COLORS.borderMuted}`,
        background: "color-mix(in srgb, var(--color-fg) 2.5%, transparent)",
        opacity: muted ? 0.72 : 1,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontFamily: SANS_FONT, fontSize: 12, fontWeight: 600, color: COLORS.textPrimary }}>{label}</span>
          <span style={{ fontFamily: SANS_FONT, fontSize: 11.5, color: COLORS.textMuted, fontVariantNumeric: "tabular-nums" }}>{size}</span>
        </div>
        {detail ? (
          <div style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted, marginTop: 2 }}>{detail}</div>
        ) : null}
        {path ? (
          <div
            style={{ fontFamily: SANS_FONT, fontSize: 10, color: COLORS.textDim, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            title={path}
          >
            {path}
          </div>
        ) : null}
      </div>
      {action ? <div style={{ flexShrink: 0 }}>{action}</div> : null}
    </div>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ ...LABEL_STYLE, textTransform: "uppercase", letterSpacing: 0.8, fontSize: 10, marginTop: 4 }}>
      {children}
    </div>
  );
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
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
          fontFamily: SANS_FONT,
          fontSize: 11.5,
          color: COLORS.textSecondary,
        }}
        aria-expanded={expanded}
      >
        {expanded ? <CaretDown size={13} /> : <CaretRight size={13} />}
        {summaryParts.length > 0 ? summaryParts.join(" · ") : "No lanes stored"}
      </button>

      {expanded ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
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
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: SANS_FONT, fontSize: 11.5, color: COLORS.textMuted }}>
          <ShieldCheck size={15} style={{ color: COLORS.success }} />
          This is your project's live data. ADE protects it automatically.
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
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rows.map((row) => (
          <div
            key={row.table}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              padding: "9px 11px",
              borderRadius: 9,
              border: `1px solid ${COLORS.borderMuted}`,
              background: "color-mix(in srgb, var(--color-fg) 2.5%, transparent)",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontFamily: SANS_FONT, fontSize: 12, fontWeight: 600, color: COLORS.textPrimary }}>{row.label}</span>
                {row.isProtected ? (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: SANS_FONT, fontSize: 10.5, color: COLORS.success }}>
                    <ShieldCheck size={12} weight="fill" /> Protected
                  </span>
                ) : null}
                {row.isPending ? (
                  <SmartTooltip
                    forceEnabled
                    side="top"
                    content={{ label: "Waiting to compact", description: DB_COMPACTION_PENDING_HINT }}
                  >
                    <span style={inlineBadge(COLORS.info, { fontSize: 10, padding: "1px 7px" })}>Waiting to compact</span>
                  </SmartTooltip>
                ) : null}
              </div>
              <div style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted, marginTop: 2 }}>{row.hint}</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
              <span style={{ fontFamily: SANS_FONT, fontSize: 12, fontWeight: 600, color: COLORS.textSecondary, fontVariantNumeric: "tabular-nums" }}>
                {row.size}
              </span>
              {row.actionLabel && runMaintenance ? (
                <button
                  type="button"
                  onClick={runMaintenance}
                  disabled={maintenanceBusy}
                  style={{
                    fontFamily: SANS_FONT,
                    fontSize: 11,
                    fontWeight: 600,
                    color: COLORS.accent,
                    background: "transparent",
                    border: "none",
                    padding: "2px 4px",
                    cursor: maintenanceBusy ? "not-allowed" : "pointer",
                    opacity: maintenanceBusy ? 0.6 : 1,
                    whiteSpace: "nowrap",
                  }}
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
      <div key={key} style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
        <span style={{ fontFamily: SANS_FONT, fontSize: 11.5, fontWeight: 650, color: COLORS.textPrimary }}>
          {label}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <SettingsNumber
            ariaLabel={label}
            value={shown}
            min={0}
            suffix={suffix}
            sentinelLabel={sentinelLabel}
            sentinelValue={0}
            onChange={(next) => onChange({ ...value, [key]: Math.max(0, Math.floor(next)) })}
          />
          {isInherited ? (
            <span style={{ fontFamily: SANS_FONT, fontSize: 10.5, color: COLORS.textDim }}>Inherited</span>
          ) : (
            <button
              type="button"
              onClick={() => onChange({ ...value, [key]: undefined })}
              style={{
                fontFamily: SANS_FONT,
                fontSize: 10.5,
                color: COLORS.textDim,
                background: "none",
                border: "none",
                padding: 0,
                cursor: "pointer",
                textDecoration: "underline",
              }}
            >
              Reset to inherited
            </button>
          )}
        </div>
        <span style={{ fontFamily: SANS_FONT, fontSize: 10.5, lineHeight: 1.45, color: COLORS.textMuted }}>{help}</span>
      </div>
    );
  };

  return (
    <section
      id="lane-storage-rules"
      data-settings-anchor="lane-storage-rules"
      style={{ ...PANEL_STYLE, display: "flex", flexDirection: "column", gap: 14 }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <h3 style={{ margin: 0, fontFamily: SANS_FONT, fontSize: 14, color: COLORS.textPrimary }}>
              Lane storage rules
            </h3>
            <ScopeChip scope="team" />
          </div>
          <p style={{ margin: "5px 0 0", fontFamily: SANS_FONT, fontSize: 11.5, lineHeight: 1.5, color: COLORS.textMuted }}>
            ADE can archive lanes when they are safely idle. It never removes lane folders in the background.
          </p>
        </div>
        {busy ? (
          <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textDim, whiteSpace: "nowrap" }}>
            Saving…
          </span>
        ) : null}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 14 }}>
        {field("maxActiveLanes", "Maximum active lanes", "Only clean, merged, idle lanes can be archived.", "No limit", "lanes")}
        {field("autoArchiveAfterHours", "Archive after inactivity", "Hours without lane activity before ADE may archive it.", "Never", "hours")}
        {field("cleanupIntervalHours", "Check every", "Hours between safety scans. A scan only archives eligible lanes and updates the review list.", "Disabled", "hours")}
        {field("reclaimArchivedAfterHours", "Review archived files after", "Hours before archived lane folders are marked ready for review. ADE still waits for confirmation.", "Never", "hours")}
      </div>
      <details style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted }}>
        <summary style={{ cursor: "pointer", color: COLORS.textSecondary }}>What counts as safe?</summary>
        <div style={{ marginTop: 8, lineHeight: 1.55 }}>
          The lane must be ADE-managed, clean, merged, not protected, not part of a PR group, and have no running chat, terminal, or watcher.
          Attached folders and the primary lane are always left alone.
        </div>
      </details>
    </section>
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
              <div key={warning.code} style={{ display: "flex", gap: 8, padding: "8px 10px", borderRadius: 8, border: `1px solid ${COLORS.warning}35`, color: COLORS.warning, fontFamily: SANS_FONT, fontSize: 11, lineHeight: 1.45 }}>
                <WarningCircle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                {warning.message}
              </div>
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
          <button type="button" onClick={onClose} disabled={busy} style={outlineButton({ height: 32 })}>Cancel</button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy || blocked || dirtyNotConfirmed || value !== "RECLAIM"}
            style={{ ...primaryButton({ height: 32 }), opacity: busy || blocked || dirtyNotConfirmed || value !== "RECLAIM" ? 0.55 : 1 }}
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
    <section style={{ ...PANEL_STYLE, display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <h3 style={{ margin: 0, fontFamily: SANS_FONT, fontSize: 14, color: COLORS.textPrimary }}>Review files before cleanup</h3>
        <p style={{ margin: "5px 0 0", fontFamily: SANS_FONT, fontSize: 11.5, lineHeight: 1.5, color: COLORS.textMuted }}>
          Sizes are estimates. ADE checks every path again after you confirm and reports anything it could not remove.
        </p>
      </div>
      {rows.length === 0 ? (
        <div style={{ fontFamily: SANS_FONT, fontSize: 11.5, color: COLORS.textMuted }}>Nothing needs review right now.</div>
      ) : (
        <div style={{ overflowX: "auto", border: `1px solid ${COLORS.borderMuted}`, borderRadius: 10 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 760, fontFamily: SANS_FONT }}>
            <thead>
              <tr style={{ background: COLORS.recessedBg, color: COLORS.textMuted, fontSize: 10.5, textAlign: "left" }}>
                {["Item", "Type", "Owner", "Age", "Can reclaim", "Why blocked", ""].map((label) => (
                  <th key={label} style={{ padding: "9px 10px", fontWeight: 650 }}>{label}</th>
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
                  <tr key={`${categoryId}:${item.id}`} style={{ borderTop: `1px solid ${COLORS.borderMuted}`, color: COLORS.textSecondary, fontSize: 11 }}>
                    <td style={{ padding: "10px", color: COLORS.textPrimary, fontWeight: 600 }}>
                      {item.label}
                      <div title={item.path} style={{ marginTop: 2, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: COLORS.textDim, fontSize: 9.5 }}>{item.path}</div>
                    </td>
                    <td style={{ padding: "10px" }}>{item.laneStatus === "archived" ? "Archived lane" : item.laneStatus === "orphaned" ? "Leftover worktree" : "Build output"}</td>
                    <td style={{ padding: "10px" }}>{item.ownership ?? "ADE-managed"}</td>
                    <td style={{ padding: "10px" }}>{formatAgeHours(item.ageHours)}</td>
                    <td style={{ padding: "10px", fontVariantNumeric: "tabular-nums" }}>{formatBytes(item.reclaimableBytes ?? item.bytes)}</td>
                    <td style={{ padding: "10px", maxWidth: 250 }}>{item.blockedReasons?.join(" ") || "Ready for review"}</td>
                    <td style={{ padding: "10px", textAlign: "right" }}>
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
    </section>
  );
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

export function StorageSection() {
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
  const [toast, setToast] = React.useState<string | null>(null);
  const toastTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const policySaveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const compressNow = React.useMemo(() => getCompressNow(), []);
  const runMaintenanceNow = React.useMemo(() => getRunMaintenanceNow(), []);
  const runtimeHealthFn = React.useMemo(() => getRuntimeHealthFn(), []);

  const showToast = React.useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4500);
  }, []);

  const load = React.useCallback(async (opts: { force?: boolean; silent?: boolean } = {}) => {
    if (opts.silent || opts.force) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const [snap, pressure, lanes, config] = await Promise.all([
        window.ade.storage.getSnapshot({ forceRefresh: opts.force }),
        window.ade.storage.getPressure().catch(() => null),
        window.ade.lanes?.list?.({ includeArchived: true }).catch(() => []) ?? Promise.resolve([]),
        window.ade.projectConfig.get(),
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
  }, []);

  const loadDiagnostics = React.useCallback(async () => {
    const [nextUsage, nextHealth] = await Promise.all([
      getAppResourceUsageCoalesced(),
      runtimeHealthFn ? runtimeHealthFn().catch(() => null) : Promise.resolve(null),
    ]);
    setUsage(nextUsage);
    setUsageReady(true);
    setRuntimeHealth(nextHealth);
  }, [runtimeHealthFn]);

  React.useEffect(() => {
    void load();
    void loadDiagnostics();
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
      // Flush a pending rule edit rather than dropping it on unmount.
      if (policySaveTimer.current) clearTimeout(policySaveTimer.current);
    };
  }, [load, loadDiagnostics]);

  const runCompress = React.useCallback(async () => {
    if (!compressNow) return;
    setCompressing(true);
    try {
      const result = await compressNow();
      showToast(`Compressed ${result.filesCompressed} ${result.filesCompressed === 1 ? "file" : "files"}, freed ${formatBytes(result.savedBytes)}`);
      void load({ force: true, silent: true });
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not compress history");
    } finally {
      setCompressing(false);
    }
  }, [compressNow, load, showToast]);

  const runMaintenanceInline = React.useCallback(async () => {
    if (!runMaintenanceNow || maintenanceBusy) return;
    setMaintenanceBusy(true);
    try {
      const report = await runMaintenanceNow();
      showToast(maintenanceOutcome(report).message);
      void load({ force: true, silent: true });
      void loadDiagnostics();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not run cleanup");
    } finally {
      setMaintenanceBusy(false);
    }
  }, [runMaintenanceNow, maintenanceBusy, showToast, load, loadDiagnostics]);

  const savePolicy = React.useCallback(async (next: LaneCleanupConfig) => {
    setPolicyBusy(true);
    try {
      const current = await window.ade.projectConfig.get();
      await window.ade.projectConfig.save({
        shared: current.shared,
        local: { ...current.local, laneCleanup: next },
      });
      void load({ force: true, silent: true });
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not save storage rules");
    } finally {
      setPolicyBusy(false);
    }
  }, [load, showToast]);

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
      const risk = await window.ade.lanes.getReclaimRisk({ laneId });
      setReclaimConfirm("");
      setDiscardDirtyConfirmed(false);
      setReclaimRisk(risk);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not review this lane");
    }
  }, [showToast]);

  const confirmReclaim = React.useCallback(async () => {
    if (!reclaimRisk || reclaimConfirm !== "RECLAIM" || (reclaimRisk.dirty && !discardDirtyConfirmed)) return;
    setReclaimBusy(true);
    try {
      const result = await window.ade.lanes.archiveAndReclaim({
        laneId: reclaimRisk.laneId,
        confirmation: "RECLAIM",
        ...(reclaimRisk.dirty && discardDirtyConfirmed ? { forceDirty: true } : {}),
      });
      showToast(`Reclaimed about ${formatBytes(result.reclaimedBytes)}. The lane, branch, and chats were kept.`);
      setReclaimRisk(null);
      setReclaimConfirm("");
      setDiscardDirtyConfirmed(false);
      void load({ force: true, silent: true });
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not reclaim this lane");
    } finally {
      setReclaimBusy(false);
    }
  }, [discardDirtyConfirmed, load, reclaimConfirm, reclaimRisk, showToast]);

  const restoreLane = React.useCallback(async (laneId: string) => {
    try {
      const result = await window.ade.lanes.unarchive({ laneId });
      showToast(result.setupWarning
        ? `Lane restored. Setup needs attention: ${result.setupWarning}`
        : result.worktreeRecreated ? "Lane restored and its worktree was recreated." : "Lane restored.");
      void load({ force: true, silent: true });
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not restore this lane");
    }
  }, [load, showToast]);

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
            showToast(maintenanceOutcome(report).message);
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
  }, [snapshot, laneIdByKey, runMaintenanceNow, showToast]);

  const description = "What ADE keeps on this computer for this project, and what you can safely clear.";

  return (
    <SettingsSectionShell id="storage" title="Storage" description={description} icon={HardDrives} brandColor={STORAGE_BRAND}>
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        {loading && !snapshot ? (
          <StorageSkeleton />
        ) : error && !snapshot ? (
          <section style={{ ...PANEL_STYLE, display: "flex", flexDirection: "column", gap: 12, alignItems: "flex-start" }}>
            <div style={{ fontFamily: SANS_FONT, fontSize: 13, color: COLORS.textPrimary }}>ADE couldn't measure storage right now.</div>
            <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted }}>{error}</div>
            <button type="button" onClick={() => void load({ force: true })} style={outlineButton({ height: 32 })}>
              <ArrowClockwise size={14} /> Try again
            </button>
          </section>
        ) : snapshot ? (
          <>
            <Hero
              snapshot={snapshot}
              pressureState={pressureState}
              refreshing={refreshing}
              reclaimableBytes={runMaintenanceNow ? (safeConfig?.plan.estimatedBytes ?? 0) : reclaimable}
              onRescan={() => void load({ force: true })}
              onCleanSafely={safeConfig ? () => setSafeOpen(true) : null}
            />

            <StoragePolicyPanel
              value={policy}
              effectiveValue={effectivePolicy}
              busy={policyBusy}
              onChange={commitPolicy}
            />

            <StorageReviewPanel
              snapshot={snapshot}
              laneIdByKey={laneIdByKey}
              onCleanup={setCleanup}
              onReclaim={(laneId) => void openReclaim(laneId)}
              onRestore={(laneId) => void restoreLane(laneId)}
            />

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14 }}>
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

            <DiagnosticsStrip
              extras={extras}
              usage={usage}
              usageReady={usageReady}
              runtimeHealth={runtimeHealth}
              runtimeHealthAvailable={Boolean(runtimeHealthFn)}
            />

            <MaintenanceJournal extras={extras} />

            <div style={{ fontFamily: SANS_FONT, fontSize: 11, lineHeight: 1.55, color: COLORS.textMuted }}>
              ADE never removes lane folders, build output, or leftovers in the background. It can archive a safe idle lane, but files stay until you review and confirm cleanup.
            </div>
          </>
        ) : null}

        {toast ? (
          <div
            style={{
              position: "fixed",
              bottom: 24,
              right: 24,
              zIndex: 9998,
              padding: "10px 14px",
              borderRadius: 10,
              background: COLORS.cardBgSolid,
              border: `1px solid ${COLORS.outlineBorder}`,
              boxShadow: "0 18px 48px -24px rgba(0,0,0,0.8)",
              fontFamily: SANS_FONT,
              fontSize: 12,
              color: COLORS.textPrimary,
              maxWidth: 360,
            }}
            role="status"
          >
            {toast}
          </div>
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
    </SettingsSectionShell>
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
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontFamily: SANS_FONT, fontSize: 11.5, color: COLORS.textSecondary }}>
              About {formatBytes(compressible)} of older history can be compressed without losing anything.
            </div>
            <div>
              <button
                type="button"
                onClick={onCompress}
                disabled={compressing}
                style={{ ...outlineButton({ height: 30, fontSize: 11.5 }), opacity: compressing ? 0.7 : 1 }}
              >
                <FileZip size={13} className={compressing ? "animate-spin" : undefined} />
                {compressing ? "Compressing…" : "Compress old history"}
              </button>
            </div>
          </div>
        ) : (
          <div style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted }}>
            Kept so you can reopen past chats and terminals.
          </div>
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
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
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
              <div style={{ fontFamily: SANS_FONT, fontSize: 11.5, color: COLORS.textMuted, lineHeight: 1.45 }}>
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
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
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
  return <div style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted }}>{label}</div>;
}

function StorageSkeleton() {
  const shimmer: React.CSSProperties = {
    ...PANEL_STYLE,
    height: 96,
    background: "color-mix(in srgb, var(--color-fg) 4%, transparent)",
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ ...PANEL_STYLE, height: 132, display: "flex", alignItems: "center", gap: 10, color: COLORS.textMuted }}>
        <HardDrives size={18} className="animate-pulse" />
        <span style={{ fontFamily: SANS_FONT, fontSize: 12 }}>Measuring what ADE is storing…</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14 }}>
        <div style={shimmer} />
        <div style={shimmer} />
        <div style={shimmer} />
        <div style={shimmer} />
      </div>
    </div>
  );
}

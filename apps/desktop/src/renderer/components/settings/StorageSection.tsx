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
} from "@phosphor-icons/react";
import type { DiskPressureSnapshot } from "../../../main/services/storage/diskPressure";
import type {
  StorageCategoryId,
  StorageCategorySnapshot,
  StorageCleanupResult,
  StorageCleanupTarget,
  StorageItem,
  StorageSnapshot,
} from "../../../shared/types/storage";
import { relativeWhen } from "../../lib/format";
import { COLORS, SANS_FONT, LABEL_STYLE, outlineButton } from "../lanes/laneDesignTokens";
import { StorageCleanupDialog } from "./storage/StorageCleanupDialog";
import {
  CATEGORY_META,
  CATEGORY_ORDER,
  SAFETY_META,
  baseName,
  cleanableEntries,
  formatBytes,
  groupLaneItems,
} from "./storage/storageView";

const PANEL_STYLE: React.CSSProperties = {
  background: "color-mix(in srgb, var(--color-card) 90%, var(--color-bg) 10%)",
  border: "1px solid color-mix(in srgb, var(--color-border) 78%, transparent)",
  borderRadius: 12,
  padding: 16,
};

type CompressNow = () => Promise<{ filesCompressed: number; savedBytes: number }>;

function getCompressNow(): CompressNow | undefined {
  const fn = (window.ade?.storage as { compressNow?: CompressNow } | undefined)?.compressNow;
  return typeof fn === "function" ? fn : undefined;
}

type CleanupRequest = { title: string; intro: string; targets: StorageCleanupTarget[] };

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
  if (state === "exhausted" || state === "critical") return COLORS.danger;
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
  onRescan,
}: {
  snapshot: StorageSnapshot;
  pressureState: DiskPressureSnapshot["state"] | undefined;
  refreshing: boolean;
  onRescan: () => void;
}) {
  return (
    <section style={{ ...PANEL_STYLE, padding: 20, display: "flex", flexDirection: "column", gap: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
        <DiskGauge snapshot={snapshot} pressureState={pressureState} />
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
          <button
            type="button"
            onClick={onRescan}
            disabled={refreshing}
            style={{ ...outlineButton({ height: 32 }), opacity: refreshing ? 0.7 : 1 }}
          >
            <ArrowClockwise size={14} className={refreshing ? "animate-spin" : undefined} />
            {refreshing ? "Rescanning" : "Rescan"}
          </button>
          <div style={{ fontFamily: SANS_FONT, fontSize: 10.5, color: COLORS.textMuted }}>
            Scanned {relativeWhen(snapshot.generatedAt)}
          </div>
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
  span,
  children,
}: {
  categoryId: StorageCategoryId;
  category: StorageCategorySnapshot;
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
        <span style={{ fontFamily: SANS_FONT, fontSize: 13, fontWeight: 600, color: COLORS.textSecondary, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
          {formatBytes(category.bytes)}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <p style={{ margin: 0, fontFamily: SANS_FONT, fontSize: 11.5, lineHeight: 1.45, color: COLORS.textMuted }}>
          {meta.description}
        </p>
        <SafetyBadge safety={category.safety} />
      </div>
      {children}
    </section>
  );
}

function ActionButton({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} style={outlineButton({ height: 30, fontSize: 11.5 })}>
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
  detail?: string;
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
  laneIdByKey,
  archivedAtByKey,
  onRequestCleanup,
}: {
  category: StorageCategorySnapshot;
  laneIdByKey: Map<string, string>;
  archivedAtByKey: Map<string, string | null>;
  onRequestCleanup: (request: CleanupRequest) => void;
}) {
  const { active, archived, orphaned } = groupLaneItems(category.items);
  const hasActionable = archived.length > 0 || orphaned.length > 0;
  const [expanded, setExpanded] = React.useState(hasActionable);

  const removeRow = (item: StorageItem): React.ReactNode => {
    const target = laneCleanupTarget(item, laneIdByKey);
    if (!target) return null;
    return (
      <ActionButton
        label="Remove files…"
        icon={<FolderDashed size={13} />}
        onClick={() =>
          onRequestCleanup({
            title: item.laneStatus === "archived" ? "Remove archived lane files" : "Remove leftover lane files",
            intro:
              item.laneStatus === "archived"
                ? "These files belong to a lane you archived. Removing them frees space and does not delete the lane's branch or history."
                : "These files were left behind by a lane that no longer exists. They are safe to remove.",
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
    <CardShell categoryId="lanes_worktrees" category={category} span>
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

function laneCleanupTarget(item: StorageItem, laneIdByKey: Map<string, string>): StorageCleanupTarget | null {
  if (item.laneStatus === "orphaned") return { kind: "orphaned_worktree", path: item.path };
  if (item.laneStatus === "archived") {
    const laneId = laneIdByKey.get(baseName(item.path));
    return laneId ? { kind: "archived_lane_worktree", laneId, path: item.path } : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

export function StorageSection() {
  const [snapshot, setSnapshot] = React.useState<StorageSnapshot | null>(null);
  const [pressureState, setPressureState] = React.useState<DiskPressureSnapshot["state"] | undefined>();
  const [laneIdByKey, setLaneIdByKey] = React.useState<Map<string, string>>(new Map());
  const [archivedAtByKey, setArchivedAtByKey] = React.useState<Map<string, string | null>>(new Map());
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [cleanup, setCleanup] = React.useState<CleanupRequest | null>(null);
  const [compressing, setCompressing] = React.useState(false);
  const [toast, setToast] = React.useState<string | null>(null);
  const toastTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const compressNow = React.useMemo(() => getCompressNow(), []);

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
      const [snap, pressure, lanes] = await Promise.all([
        window.ade.storage.getSnapshot({ forceRefresh: opts.force }),
        window.ade.storage.getPressure().catch(() => null),
        window.ade.lanes?.list?.({ includeArchived: true }).catch(() => []) ?? Promise.resolve([]),
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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, [load]);

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

  const onCleaned = React.useCallback((_result: StorageCleanupResult) => {
    void load({ force: true, silent: true });
  }, [load]);

  const byId = React.useMemo(() => {
    const map = new Map<StorageCategoryId, StorageCategorySnapshot>();
    for (const category of snapshot?.categories ?? []) map.set(category.id, category);
    return map;
  }, [snapshot]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <header>
        <div style={{ ...LABEL_STYLE, textTransform: "uppercase", letterSpacing: 1.3, marginBottom: 8 }}>Settings</div>
        <h1 style={{ margin: 0, fontFamily: SANS_FONT, fontSize: 26, lineHeight: 1.1, color: COLORS.textPrimary }}>Storage</h1>
        <div style={{ marginTop: 8, fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted }}>
          What ADE keeps on this Mac for this project, and what you can safely clear.
        </div>
      </header>

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
            onRescan={() => void load({ force: true })}
          />

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14 }}>
            {CATEGORY_ORDER.map((categoryId) => {
              const category = byId.get(categoryId);
              if (!category) return null;
              if (categoryId === "lanes_worktrees") {
                return (
                  <LanesCard
                    key={categoryId}
                    category={category}
                    laneIdByKey={laneIdByKey}
                    archivedAtByKey={archivedAtByKey}
                    onRequestCleanup={setCleanup}
                  />
                );
              }
              return (
                <CategoryCardBody
                  key={categoryId}
                  categoryId={categoryId}
                  category={category}
                  laneIdByKey={laneIdByKey}
                  compressNow={compressNow}
                  compressing={compressing}
                  onCompress={() => void runCompress()}
                  onRequestCleanup={setCleanup}
                />
              );
            })}
          </div>

          <div style={{ fontFamily: SANS_FONT, fontSize: 11, lineHeight: 1.55, color: COLORS.textMuted }}>
            ADE never automatically deletes your chats, project files, active lanes, or backups.
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
    </div>
  );
}

const EMPTY_TARGETS: StorageCleanupTarget[] = [];

function CategoryCardBody({
  categoryId,
  category,
  laneIdByKey,
  compressNow,
  compressing,
  onCompress,
  onRequestCleanup,
}: {
  categoryId: StorageCategoryId;
  category: StorageCategorySnapshot;
  laneIdByKey: Map<string, string>;
  compressNow: CompressNow | undefined;
  compressing: boolean;
  onCompress: () => void;
  onRequestCleanup: (request: CleanupRequest) => void;
}) {
  if (categoryId === "chats_history") {
    const compressible = category.compressibleBytes ?? 0;
    return (
      <CardShell categoryId={categoryId} category={category}>
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
      <CardShell categoryId={categoryId} category={category}>
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
      <CardShell categoryId={categoryId} category={category}>
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
    return (
      <CardShell categoryId={categoryId} category={category}>
        <div style={{ fontFamily: SANS_FONT, fontSize: 11.5, color: COLORS.textMuted, lineHeight: 1.45 }}>
          {category.bytes > 0
            ? "Review and remove individual items from the proof drawer, where you can see each screenshot and recording."
            : "Nothing captured yet."}
        </div>
      </CardShell>
    );
  }

  if (categoryId === "recovery_backups") {
    return (
      <CardShell categoryId={categoryId} category={category}>
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

  // database
  return (
    <CardShell categoryId={categoryId} category={category}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: SANS_FONT, fontSize: 11.5, color: COLORS.textMuted }}>
        <ShieldCheck size={15} style={{ color: COLORS.success }} />
        This is your project's live data. ADE protects it automatically.
      </div>
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

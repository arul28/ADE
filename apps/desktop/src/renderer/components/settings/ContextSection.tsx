import React from "react";
import type {
  ContextInventorySnapshot,
  PackSummary,
  PackVersionSummary,
  PackEvent
} from "../../../shared/types";
import { EmptyState } from "../ui/EmptyState";
import { cn } from "../ui/cn";
import { GenerateDocsModal } from "../context/GenerateDocsModal";
import { useAppStore } from "../../state/appStore";
import { COLORS, MONO_FONT, SANS_FONT, LABEL_STYLE, cardStyle, outlineButton, primaryButton } from "../lanes/laneDesignTokens";
import { ArrowsClockwise, FileText, FolderSimple, Crosshair, GitMerge, ClipboardText, Rocket, Clock, BookOpenText, Lightning, CheckCircle, Warning } from "@phosphor-icons/react";
import { relativeTime, shortId, parsePackBody, type PackSection } from "../context/contextShared";

// --- Keyframes for pulsing glow ---
const glowKeyframes = `
@keyframes generateGlow {
  0%, 100% { box-shadow: 0 0 8px var(--glow-color), 0 0 16px var(--glow-color); }
  50% { box-shadow: 0 0 16px var(--glow-color), 0 0 32px var(--glow-color); }
}
`;

// --- Section Renderers ---

function renderTable(lines: string[]) {
  const tableLines = lines.filter((l) => l.trim().startsWith("|"));
  if (tableLines.length < 2) return null;
  const parseRow = (line: string) => line.split("|").map((c) => c.trim()).filter(Boolean);
  const headers = parseRow(tableLines[0]);
  const isSep = (l: string) => /^\|[\s-:|]+\|$/.test(l.trim());
  const dataLines = tableLines.filter((l) => !isSep(l)).slice(1);

  return (
    <div style={{ overflowX: "auto", border: `1px solid ${COLORS.border}`, borderRadius: 0 }}>
      <table style={{ width: "100%", fontSize: 11, fontFamily: MONO_FONT, borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ background: COLORS.recessedBg }}>
            {headers.map((h, i) => (
              <th key={i} style={{
                padding: "6px 10px",
                textAlign: "left",
                fontWeight: 600,
                color: COLORS.textMuted,
                borderBottom: `1px solid ${COLORS.border}`,
                ...LABEL_STYLE,
                fontSize: 10,
              }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dataLines.map((line, i) => {
            const cells = parseRow(line);
            return (
              <tr key={i} style={{ borderBottom: `1px solid ${COLORS.border}40` }}>
                {cells.map((cell, j) => (
                  <td key={j} style={{ padding: "6px 10px", color: COLORS.textSecondary, fontFamily: MONO_FONT, fontSize: 11 }}>{cell}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SectionBlock({ section }: { section: PackSection }) {
  const trimmedLines = section.lines.filter((l) => l.trim());
  if (!trimmedLines.length && !section.heading) return null;

  const hasTable = trimmedLines.some((l) => l.includes("|") && trimmedLines.some((ll) => ll.includes("---")));
  const hasList = trimmedLines.some((l) => /^\s*[-*]\s/.test(l));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {section.heading ? (
        <h3 style={{
          fontFamily: SANS_FONT,
          fontWeight: 700,
          color: COLORS.textPrimary,
          fontSize: section.level <= 2 ? 13 : 11,
          margin: 0,
          ...(section.level > 2 ? { color: COLORS.textSecondary } : {}),
        }}>
          {section.heading}
        </h3>
      ) : null}
      {hasTable ? renderTable(trimmedLines) : hasList ? (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 2 }}>
          {trimmedLines.map((line, i) => {
            const m = line.match(/^\s*[-*]\s+(.*)/);
            return m ? (
              <li key={i} style={{ display: "flex", gap: 6, fontSize: 12, fontFamily: MONO_FONT, color: COLORS.textSecondary }}>
                <span style={{ color: COLORS.accent, opacity: 0.5, flexShrink: 0 }}>-</span>
                <span>{m[1]}</span>
              </li>
            ) : (
              <li key={i} style={{ paddingLeft: 14, fontSize: 12, fontFamily: MONO_FONT, color: COLORS.textSecondary }}>{line}</li>
            );
          })}
        </ul>
      ) : trimmedLines.length ? (
        <div style={{ fontSize: 12, fontFamily: MONO_FONT, color: COLORS.textSecondary, whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{section.content.trim()}</div>
      ) : null}
    </div>
  );
}

function HeaderCard({ header }: { header: Record<string, unknown> }) {
  const display = Object.entries(header).filter(([k]) => !["schema", "contractVersion"].includes(k));
  if (!display.length) return null;
  return (
    <div style={{
      ...cardStyle({ padding: 12 }),
      borderRadius: 0,
    }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 16px" }}>
        {display.slice(0, 14).map(([key, value]) => (
          <div key={key} style={{ display: "flex", gap: 6, overflow: "hidden", fontSize: 11, fontFamily: MONO_FONT }}>
            <span style={{ fontWeight: 600, color: COLORS.textMuted, flexShrink: 0 }}>{key}:</span>
            <span style={{ color: COLORS.textSecondary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {typeof value === "object" && value !== null ? JSON.stringify(value) : String(value ?? "-")}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PackContentView({ pack }: { pack: PackSummary | null }) {
  if (!pack) return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "48px 0", fontSize: 12, fontFamily: MONO_FONT, color: COLORS.textMuted }}>Loading...</div>;
  if (!pack.exists || !pack.body.trim().length) {
    return <EmptyState title="No pack data" description="This pack hasn't been generated yet. Click Refresh to create it." />;
  }

  const { header, sections } = parsePackBody(pack.body);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {header ? <HeaderCard header={header} /> : null}
      {sections.map((section, i) => (
        <SectionBlock key={i} section={section} />
      ))}
    </div>
  );
}

// --- Pack Type Tabs ---

type PackTab = "project" | "lanes" | "missions" | "conflicts" | "features" | "plans";

const TABS: { id: PackTab; num: string; label: string; icon: React.ElementType }[] = [
  { id: "project", num: "01", label: "PROJECT", icon: FolderSimple },
  { id: "lanes", num: "02", label: "LANES", icon: FileText },
  { id: "missions", num: "03", label: "MISSIONS", icon: Rocket },
  { id: "conflicts", num: "04", label: "CONFLICTS", icon: GitMerge },
  { id: "features", num: "05", label: "FEATURES", icon: Crosshair },
  { id: "plans", num: "06", label: "PLANS", icon: ClipboardText }
];

// --- Selector pill for lane/mission sub-tabs ---

function SelectorPill({
  items,
  selectedId,
  onSelect,
}: {
  items: { id: string; label: string }[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {items.map((item) => {
        const active = item.id === selectedId;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(item.id)}
            style={{
              padding: "4px 10px",
              fontSize: 11,
              fontWeight: 700,
              fontFamily: MONO_FONT,
              textTransform: "uppercase",
              letterSpacing: "1px",
              borderRadius: 0,
              border: active ? `1px solid ${COLORS.accent}30` : `1px solid ${COLORS.border}`,
              background: active ? `${COLORS.accent}18` : "transparent",
              color: active ? COLORS.accent : COLORS.textMuted,
              cursor: "pointer",
              transition: "all 150ms ease",
            }}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

// --- Individual Pack Panels ---

function ProjectPanel() {
  const [pack, setPack] = React.useState<PackSummary | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      setPack(await window.ade.packs.getProjectPack());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const refresh = async () => {
    setBusy(true);
    setErr(null);
    try {
      setPack(await window.ade.packs.refreshProjectPack());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  React.useEffect(() => { void load(); }, [load]);

  return (
    <PackPanel
      title="Project Pack"
      subtitle="Project-wide context snapshot"
      pack={pack}
      busy={busy}
      error={err}
      onRefresh={refresh}
      updatedAt={pack?.deterministicUpdatedAt}
    />
  );
}

function LanesPanel() {
  const lanes = useAppStore((s) => s.lanes);
  const [selectedLaneId, setSelectedLaneId] = React.useState<string | null>(null);
  const [pack, setPack] = React.useState<PackSummary | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (lanes.length && !selectedLaneId) {
      setSelectedLaneId(lanes[0].id);
    }
  }, [lanes, selectedLaneId]);

  React.useEffect(() => {
    if (!selectedLaneId) return;
    setPack(null);
    setErr(null);
    window.ade.packs.getLanePack(selectedLaneId)
      .then(setPack)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [selectedLaneId]);

  const refresh = async () => {
    if (!selectedLaneId) return;
    setBusy(true);
    setErr(null);
    try {
      setPack(await window.ade.packs.refreshLanePack(selectedLaneId));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <SelectorPill
        items={lanes.map((l) => ({ id: l.id, label: l.name }))}
        selectedId={selectedLaneId}
        onSelect={setSelectedLaneId}
      />

      {selectedLaneId ? (
        <PackPanel
          title={`Lane Pack \u00B7 ${lanes.find((l) => l.id === selectedLaneId)?.name ?? selectedLaneId}`}
          subtitle="Full lane context: sessions, changes, tests, errors"
          pack={pack}
          busy={busy}
          error={err}
          onRefresh={refresh}
          updatedAt={pack?.deterministicUpdatedAt}
        />
      ) : (
        <EmptyState title="No lanes" description="Create a lane to see its context pack." />
      )}
    </div>
  );
}

function MissionsPanel() {
  const [missions, setMissions] = React.useState<Array<{ id: string; title: string }>>([]);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [pack, setPack] = React.useState<PackSummary | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    window.ade.missions.list({ limit: 20 })
      .then((list) => {
        const items = list.map((m) => ({ id: m.id, title: m.title }));
        setMissions(items);
        if (items.length && !selectedId) setSelectedId(items[0].id);
      })
      .catch(() => {});
  }, []);

  React.useEffect(() => {
    if (!selectedId) return;
    setPack(null);
    setErr(null);
    window.ade.packs.getMissionPack({ missionId: selectedId })
      .then(setPack)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [selectedId]);

  const refresh = async () => {
    if (!selectedId) return;
    setBusy(true);
    setErr(null);
    try {
      setPack(await window.ade.packs.refreshMissionPack({ missionId: selectedId, reason: "manual_refresh" }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!missions.length) {
    return <EmptyState title="No missions" description="Create a mission to see its context pack." />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <SelectorPill
        items={missions.map((m) => ({ id: m.id, label: m.title || shortId(m.id) }))}
        selectedId={selectedId}
        onSelect={setSelectedId}
      />
      <PackPanel
        title={`Mission Pack \u00B7 ${missions.find((m) => m.id === selectedId)?.title ?? ""}`}
        subtitle="Mission steps, handoffs, orchestrator runs"
        pack={pack}
        busy={busy}
        error={err}
        onRefresh={refresh}
        updatedAt={pack?.deterministicUpdatedAt}
      />
    </div>
  );
}

function ConflictsPanel() {
  const lanes = useAppStore((s) => s.lanes);
  const [selectedLaneId, setSelectedLaneId] = React.useState<string | null>(null);
  const [pack, setPack] = React.useState<PackSummary | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (lanes.length && !selectedLaneId) setSelectedLaneId(lanes[0]?.id ?? null);
  }, [lanes, selectedLaneId]);

  React.useEffect(() => {
    if (!selectedLaneId) return;
    setPack(null);
    setErr(null);
    window.ade.packs.getConflictPack({ laneId: selectedLaneId })
      .then(setPack)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [selectedLaneId]);

  const refresh = async () => {
    if (!selectedLaneId) return;
    setBusy(true);
    setErr(null);
    try {
      setPack(await window.ade.packs.refreshConflictPack({ laneId: selectedLaneId }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <SelectorPill
        items={lanes.map((l) => ({ id: l.id, label: l.name }))}
        selectedId={selectedLaneId}
        onSelect={setSelectedLaneId}
      />
      {selectedLaneId ? (
        <PackPanel
          title={`Conflict Pack \u00B7 ${lanes.find((l) => l.id === selectedLaneId)?.name ?? ""}`}
          subtitle="Overlapping files, merge-tree conflicts, lane excerpts"
          pack={pack}
          busy={busy}
          error={err}
          onRefresh={refresh}
          updatedAt={pack?.deterministicUpdatedAt}
        />
      ) : (
        <EmptyState title="No lanes" description="Conflict packs require at least one lane." />
      )}
    </div>
  );
}

function FeaturesPanel() {
  const [featureKey, setFeatureKey] = React.useState("");
  const [pack, setPack] = React.useState<PackSummary | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [searched, setSearched] = React.useState(false);

  const load = async () => {
    if (!featureKey.trim()) return;
    setSearched(true);
    setPack(null);
    setErr(null);
    try {
      setPack(await window.ade.packs.getFeaturePack(featureKey.trim()));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const refresh = async () => {
    if (!featureKey.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      setPack(await window.ade.packs.refreshFeaturePack(featureKey.trim()));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          type="text"
          value={featureKey}
          onChange={(e) => setFeatureKey(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void load(); }}
          placeholder="ENTER FEATURE KEY..."
          style={{
            flex: 1,
            padding: "6px 12px",
            fontSize: 12,
            fontFamily: MONO_FONT,
            color: COLORS.textPrimary,
            background: COLORS.recessedBg,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 0,
            outline: "none",
            letterSpacing: "0.5px",
          }}
        />
        <button
          type="button"
          onClick={() => void load()}
          disabled={!featureKey.trim()}
          style={{
            ...outlineButton(),
            opacity: !featureKey.trim() ? 0.4 : 1,
            cursor: !featureKey.trim() ? "not-allowed" : "pointer",
          }}
        >
          LOAD
        </button>
      </div>
      {searched && pack ? (
        <PackPanel
          title={`Feature Pack \u00B7 ${featureKey}`}
          subtitle="Aggregated context across all feature lanes"
          pack={pack}
          busy={busy}
          error={err}
          onRefresh={refresh}
          updatedAt={pack?.deterministicUpdatedAt}
        />
      ) : searched && !pack && !err ? (
        <EmptyState title="No feature pack" description="No pack found for this feature key." />
      ) : err ? (
        <div style={{ background: `${COLORS.danger}18`, border: `1px solid ${COLORS.danger}30`, padding: 12, fontSize: 12, fontFamily: MONO_FONT, color: COLORS.danger, borderRadius: 0 }}>{err}</div>
      ) : (
        <EmptyState title="Feature Packs" description="Enter a feature key to view its aggregated context pack." />
      )}
    </div>
  );
}

function PlansPanel() {
  const lanes = useAppStore((s) => s.lanes);
  const [selectedLaneId, setSelectedLaneId] = React.useState<string | null>(null);
  const [pack, setPack] = React.useState<PackSummary | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (lanes.length && !selectedLaneId) setSelectedLaneId(lanes[0]?.id ?? null);
  }, [lanes, selectedLaneId]);

  React.useEffect(() => {
    if (!selectedLaneId) return;
    setPack(null);
    setErr(null);
    window.ade.packs.getPlanPack(selectedLaneId)
      .then(setPack)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [selectedLaneId]);

  const refresh = async () => {
    if (!selectedLaneId) return;
    setBusy(true);
    setErr(null);
    try {
      setPack(await window.ade.packs.refreshPlanPack(selectedLaneId));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <SelectorPill
        items={lanes.map((l) => ({ id: l.id, label: l.name }))}
        selectedId={selectedLaneId}
        onSelect={setSelectedLaneId}
      />
      {selectedLaneId ? (
        <PackPanel
          title={`Plan Pack \u00B7 ${lanes.find((l) => l.id === selectedLaneId)?.name ?? ""}`}
          subtitle="Mission plan, step breakdown, dependencies"
          pack={pack}
          busy={busy}
          error={err}
          onRefresh={refresh}
          updatedAt={pack?.deterministicUpdatedAt}
        />
      ) : (
        <EmptyState title="No lanes" description="Plan packs are associated with lanes." />
      )}
    </div>
  );
}

// --- Reusable Pack Panel ---

function PackPanel({
  title,
  subtitle,
  pack,
  busy,
  error,
  onRefresh,
  updatedAt
}: {
  title: string;
  subtitle: string;
  pack: PackSummary | null;
  busy: boolean;
  error: string | null;
  onRefresh: () => void;
  updatedAt?: string | null;
}) {
  const [showVersions, setShowVersions] = React.useState(false);
  const [showEvents, setShowEvents] = React.useState(false);
  const [versions, setVersions] = React.useState<PackVersionSummary[]>([]);
  const [events, setEvents] = React.useState<PackEvent[]>([]);

  const loadVersions = async () => {
    if (!pack?.packKey) return;
    try {
      const v = await window.ade.packs.listVersions({ packKey: pack.packKey, limit: 10 });
      setVersions(v);
      setShowVersions(true);
    } catch { /* ignore */ }
  };

  const loadEvents = async () => {
    if (!pack?.packKey) return;
    try {
      const e = await window.ade.packs.listEvents({ packKey: pack.packKey, limit: 15 });
      setEvents(e);
      setShowEvents(true);
    } catch { /* ignore */ }
  };

  return (
    <div style={{
      background: COLORS.cardBg,
      border: `1px solid ${COLORS.border}`,
      borderRadius: 0,
      overflow: "hidden",
    }}>
      {/* Panel header */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "12px 16px",
        borderBottom: `1px solid ${COLORS.border}`,
      }}>
        <div>
          <h2 style={{
            margin: 0,
            fontSize: 14,
            fontWeight: 700,
            fontFamily: SANS_FONT,
            color: COLORS.textPrimary,
          }}>{title}</h2>
          <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, marginTop: 2 }}>
            {subtitle}
            {updatedAt ? <span style={{ marginLeft: 8, color: COLORS.textDim }}>{"\u00B7"} Updated {relativeTime(updatedAt)}</span> : null}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {pack?.packKey ? (
            <>
              <button
                type="button"
                onClick={() => void loadVersions()}
                style={outlineButton({ height: 28, padding: "0 8px", fontSize: 10 })}
              >
                <Clock size={12} weight="regular" />
                HISTORY
              </button>
              <button
                type="button"
                onClick={() => void loadEvents()}
                style={outlineButton({ height: 28, padding: "0 8px", fontSize: 10 })}
              >
                EVENTS
              </button>
            </>
          ) : null}
          <button
            type="button"
            onClick={onRefresh}
            disabled={busy}
            style={{
              ...outlineButton({ height: 28, width: 28, padding: 0 }),
              opacity: busy ? 0.5 : 1,
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            <ArrowsClockwise size={14} weight="regular" className={cn(busy && "animate-spin")} />
          </button>
        </div>
      </div>

      {/* Error */}
      {error ? (
        <div style={{
          margin: "12px 16px 0",
          padding: 8,
          background: `${COLORS.danger}18`,
          border: `1px solid ${COLORS.danger}30`,
          borderRadius: 0,
          fontSize: 12,
          fontFamily: MONO_FONT,
          color: COLORS.danger,
        }}>{error}</div>
      ) : null}

      {/* Pack content */}
      <div style={{ padding: "12px 16px", maxHeight: 500, overflowY: "auto" }}>
        <PackContentView pack={pack} />
      </div>

      {/* Version history panel */}
      {showVersions ? (
        <div style={{ borderTop: `1px solid ${COLORS.border}`, padding: "12px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <h3 style={{ margin: 0, ...LABEL_STYLE, color: COLORS.textPrimary }}>VERSION HISTORY</h3>
            <button type="button" onClick={() => setShowVersions(false)} style={{ background: "none", border: "none", fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, cursor: "pointer", textTransform: "uppercase" as const, letterSpacing: "1px" }}>CLOSE</button>
          </div>
          {!versions.length ? (
            <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted }}>No versions recorded yet.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {versions.map((v) => (
                <div key={v.id} style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  background: COLORS.recessedBg,
                  padding: "6px 10px",
                  borderRadius: 0,
                  fontSize: 11,
                  fontFamily: MONO_FONT,
                  borderLeft: `2px solid ${COLORS.accent}40`,
                }}>
                  <span style={{ fontWeight: 700, color: COLORS.accent }}>v{v.versionNumber}</span>
                  <span style={{ color: COLORS.textMuted }}>{shortId(v.contentHash, 12)}</span>
                  <span style={{ marginLeft: "auto", color: COLORS.textDim }}>{relativeTime(v.createdAt)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {/* Events panel */}
      {showEvents ? (
        <div style={{ borderTop: `1px solid ${COLORS.border}`, padding: "12px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <h3 style={{ margin: 0, ...LABEL_STYLE, color: COLORS.textPrimary }}>RECENT EVENTS</h3>
            <button type="button" onClick={() => setShowEvents(false)} style={{ background: "none", border: "none", fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, cursor: "pointer", textTransform: "uppercase" as const, letterSpacing: "1px" }}>CLOSE</button>
          </div>
          {!events.length ? (
            <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted }}>No events recorded yet.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {events.map((ev) => (
                <div key={ev.id} style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  background: COLORS.recessedBg,
                  padding: "6px 10px",
                  borderRadius: 0,
                  fontSize: 11,
                  fontFamily: MONO_FONT,
                  borderLeft: `2px solid ${COLORS.border}`,
                }}>
                  <span style={{ fontWeight: 600, color: COLORS.textPrimary }}>{ev.eventType}</span>
                  <span style={{ marginLeft: "auto", color: COLORS.textDim }}>{relativeTime(ev.createdAt)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {/* Pack file path */}
      {pack?.path ? (
        <div style={{ borderTop: `1px solid ${COLORS.border}40`, padding: "6px 16px" }}>
          <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pack.path}</div>
        </div>
      ) : null}
    </div>
  );
}

// --- Inventory Summary ---

function InventorySummary({ inventory }: { inventory: ContextInventorySnapshot | null }) {
  if (!inventory) return null;

  const stats = [
    { label: "PACKS", value: inventory.packs.total },
    { label: "CHECKPOINTS", value: inventory.checkpoints.total },
    { label: "SESSIONS", value: inventory.sessionTracking.trackedSessions },
    { label: "MISSIONS", value: inventory.missions.total }
  ];

  return (
    <div style={{ display: "flex", gap: 8 }}>
      {stats.map((s) => (
        <div key={s.label} style={{
          background: COLORS.cardBg,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 0,
          padding: "6px 12px",
          textAlign: "center",
          minWidth: 64,
        }}>
          <div style={{
            fontSize: 20,
            fontWeight: 700,
            fontFamily: SANS_FONT,
            color: COLORS.accent,
            lineHeight: 1,
          }}>{s.value}</div>
          <div style={{
            ...LABEL_STYLE,
            marginTop: 2,
          }}>{s.label}</div>
        </div>
      ))}
    </div>
  );
}

// --- Generate Docs Button ---

function GenerateDocsButton({
  inventory,
  onClick,
}: {
  inventory: ContextInventorySnapshot | null;
  onClick: () => void;
}) {
  const isMissing = inventory !== null && inventory.packs.total === 0;

  const btnColor = isMissing ? COLORS.danger : COLORS.warning;

  return (
    <>
      <style>{glowKeyframes}</style>
      <button
        type="button"
        onClick={onClick}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          height: 36,
          padding: "0 18px",
          fontSize: 12,
          fontWeight: 700,
          fontFamily: MONO_FONT,
          textTransform: "uppercase",
          letterSpacing: "1px",
          color: COLORS.pageBg,
          background: btnColor,
          border: `1px solid ${btnColor}`,
          borderRadius: 0,
          cursor: "pointer",
          animation: "generateGlow 2s ease-in-out infinite",
          ["--glow-color" as string]: `${btnColor}60`,
          transition: "background 200ms ease, border-color 200ms ease",
        }}
      >
        <Lightning size={16} weight="fill" />
        GENERATE DOCS
      </button>
    </>
  );
}

// --- Onboarding Status Section ---

function OnboardingStatusSection() {
  const [status, setStatus] = React.useState<{ completedAt?: string | null } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [running, setRunning] = React.useState(false);

  React.useEffect(() => {
    window.ade.onboarding.getStatus().then((s) => setStatus(s)).catch(() => {});
  }, []);

  const isComplete = !!status?.completedAt;

  const handleRunOnboarding = async () => {
    if (isComplete) return; // Only run once
    setRunning(true);
    try {
      // Navigate to onboarding page
      window.location.hash = "#/onboarding";
    } catch {
      // ignore
    } finally {
      setRunning(false);
    }
  };

  const handleMarkComplete = async () => {
    setBusy(true);
    try {
      await window.ade.onboarding.complete();
      setStatus({ completedAt: new Date().toISOString() });
    } catch {
      // ignore
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      background: COLORS.cardBg,
      border: `1px solid ${isComplete ? COLORS.success + "40" : COLORS.warning + "40"}`,
      borderLeft: `3px solid ${isComplete ? COLORS.success : COLORS.warning}`,
      padding: "14px 16px",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 16,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {isComplete ? (
          <CheckCircle size={20} weight="fill" style={{ color: COLORS.success, flexShrink: 0 }} />
        ) : (
          <Warning size={20} weight="fill" style={{ color: COLORS.warning, flexShrink: 0 }} />
        )}
        <div>
          <div style={{
            fontSize: 12,
            fontWeight: 700,
            fontFamily: MONO_FONT,
            color: COLORS.textPrimary,
            textTransform: "uppercase",
            letterSpacing: "0.5px",
          }}>
            ONBOARDING {isComplete ? "COMPLETE" : "INCOMPLETE"}
          </div>
          <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, marginTop: 2 }}>
            {isComplete
              ? `Completed ${status?.completedAt ? new Date(status.completedAt).toLocaleDateString() : ""}`
              : "Run the setup wizard to detect defaults, configure AI, and import branches."
            }
          </div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
        {!isComplete && (
          <>
            <button
              type="button"
              onClick={handleRunOnboarding}
              disabled={running}
              style={{
                ...primaryButton({ height: 30, padding: "0 14px", fontSize: 11 }),
              }}
            >
              RUN WIZARD
            </button>
            <button
              type="button"
              onClick={handleMarkComplete}
              disabled={busy}
              style={{
                ...outlineButton({ height: 30, padding: "0 14px", fontSize: 11 }),
                opacity: busy ? 0.5 : 1,
              }}
            >
              {busy ? "SKIPPING..." : "SKIP"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// --- Context Section ---

export function ContextSection() {
  const [activeTab, setActiveTab] = React.useState<PackTab>("project");
  const [inventory, setInventory] = React.useState<ContextInventorySnapshot | null>(null);
  const [generateOpen, setGenerateOpen] = React.useState(false);

  React.useEffect(() => {
    window.ade.context.getInventory().then(setInventory).catch(() => {});
  }, []);

  React.useEffect(() => {
    const unsub = window.ade.packs.onEvent(() => {
      window.ade.context.getInventory().then(setInventory).catch(() => {});
    });
    return unsub;
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Onboarding Status */}
      <OnboardingStatusSection />

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 36,
            height: 36,
            background: `${COLORS.accent}18`,
            border: `1px solid ${COLORS.accent}30`,
            borderRadius: 0,
          }}>
            <BookOpenText size={20} weight="regular" style={{ color: COLORS.accent }} />
          </div>
          <div>
            <h2 style={{
              margin: 0,
              fontSize: 18,
              fontWeight: 700,
              fontFamily: SANS_FONT,
              color: COLORS.textPrimary,
            }}>CONTEXT PACKS</h2>
            <div style={{
              fontSize: 11,
              fontFamily: MONO_FONT,
              color: COLORS.textMuted,
              marginTop: 2,
            }}>
              Deterministic context snapshots for AI agents and developers
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <InventorySummary inventory={inventory} />
          <GenerateDocsButton inventory={inventory} onClick={() => setGenerateOpen(true)} />
        </div>
      </div>

      {/* Divider */}
      <div style={{ height: 1, background: COLORS.border }} />

      {/* Tab Navigation - Numbered industrial tabs */}
      <div style={{ display: "flex", alignItems: "stretch", gap: 0 }}>
        {TABS.map((tab) => {
          const active = activeTab === tab.id;
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "8px 16px",
                fontSize: 11,
                fontWeight: 700,
                fontFamily: MONO_FONT,
                textTransform: "uppercase",
                letterSpacing: "1px",
                background: active ? `${COLORS.accent}18` : "transparent",
                color: active ? COLORS.textPrimary : COLORS.textMuted,
                border: "none",
                borderLeft: active ? `3px solid ${COLORS.accent}` : "3px solid transparent",
                borderRadius: 0,
                cursor: "pointer",
                transition: "all 150ms ease",
                whiteSpace: "nowrap",
              }}
            >
              <Icon size={12} weight="regular" style={{ opacity: active ? 1 : 0.5 }} />
              <span style={{ color: active ? COLORS.accent : COLORS.textDim, marginRight: 4 }}>{tab.num}</span>
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Divider under tabs */}
      <div style={{ height: 1, background: COLORS.border, marginTop: -12 }} />

      {/* Tab Content */}
      <div style={{ paddingBottom: 16 }}>
        {activeTab === "project" && <ProjectPanel />}
        {activeTab === "lanes" && <LanesPanel />}
        {activeTab === "missions" && <MissionsPanel />}
        {activeTab === "conflicts" && <ConflictsPanel />}
        {activeTab === "features" && <FeaturesPanel />}
        {activeTab === "plans" && <PlansPanel />}
      </div>

      <GenerateDocsModal
        open={generateOpen}
        onOpenChange={setGenerateOpen}
        onCompleted={() => {
          window.ade.context.getInventory().then(setInventory).catch(() => {});
        }}
      />
    </div>
  );
}

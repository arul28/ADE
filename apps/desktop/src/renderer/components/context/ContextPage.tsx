import React from "react";
import type {
  ContextInventorySnapshot,
  PackSummary,
  PackVersionSummary,
  PackEvent
} from "../../../shared/types";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { cn } from "../ui/cn";
import { GenerateDocsModal } from "./GenerateDocsModal";
import { useAppStore } from "../../state/appStore";
import { RefreshCw, ChevronRight, FileText, FolderGit2, Target, GitMerge, ClipboardList, Rocket, Clock, BookOpenText } from "lucide-react";

// ─── Helpers ────────────────────────────────────────────────────────

function relativeTime(ts: string | null | undefined): string {
  if (!ts) return "never";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 60_000) return "just now";
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  return `${Math.floor(diffMs / 86_400_000)}d ago`;
}

function shortId(value: string | null | undefined, size = 10): string {
  const raw = (value ?? "").trim();
  if (!raw) return "-";
  return raw.length > size ? raw.slice(0, size) : raw;
}

// ─── Pack Body Parser ───────────────────────────────────────────────

const INTERNAL_PACK_MARKER_RE = /^\s*<!--\s*ADE_[A-Z0-9_:-]+\s*-->\s*$/gm;
const JSON_FENCE_RE = /^```json\s*\n([\s\S]*?)\n```/m;

type PackSection = {
  heading: string;
  level: number;
  content: string;
  lines: string[];
};

function parsePackBody(rawBody: string): { header: Record<string, unknown> | null; sections: PackSection[] } {
  let body = rawBody.replace(INTERNAL_PACK_MARKER_RE, "").replace(/\n{3,}/g, "\n\n").trimEnd();

  // Extract JSON header
  let header: Record<string, unknown> | null = null;
  const jsonMatch = body.match(JSON_FENCE_RE);
  if (jsonMatch?.[1]) {
    try { header = JSON.parse(jsonMatch[1]); } catch { /* ignore */ }
    body = body.replace(JSON_FENCE_RE, "").trimStart();
  }

  // Parse markdown sections
  const lines = body.split("\n");
  const sections: PackSection[] = [];
  let current: PackSection | null = null;

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (headingMatch) {
      if (current) sections.push(current);
      current = { heading: headingMatch[2].trim(), level: headingMatch[1].length, content: "", lines: [] };
    } else if (current) {
      current.lines.push(line);
      current.content += line + "\n";
    } else if (line.trim()) {
      current = { heading: "", level: 0, content: line + "\n", lines: [line] };
    }
  }
  if (current) sections.push(current);

  return { header, sections };
}

// ─── Section Renderers ──────────────────────────────────────────────

function renderTable(lines: string[]) {
  const tableLines = lines.filter((l) => l.trim().startsWith("|"));
  if (tableLines.length < 2) return null;
  const parseRow = (line: string) => line.split("|").map((c) => c.trim()).filter(Boolean);
  const headers = parseRow(tableLines[0]);
  const isSep = (l: string) => /^\|[\s-:|]+\|$/.test(l.trim());
  const dataLines = tableLines.filter((l) => !isSep(l)).slice(1);

  return (
    <div className="overflow-x-auto rounded-lg border border-border/30">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="bg-muted/30">
            {headers.map((h, i) => (
              <th key={i} className="px-2.5 py-1.5 text-left font-semibold text-muted-fg border-b border-border/30">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dataLines.map((line, i) => {
            const cells = parseRow(line);
            return (
              <tr key={i} className="border-b border-border/15 hover:bg-muted/15 transition-colors">
                {cells.map((cell, j) => (
                  <td key={j} className="px-2.5 py-1.5 text-fg/80">{cell}</td>
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
    <div className="space-y-1.5">
      {section.heading ? (
        <h3 className={cn(
          "font-semibold text-fg",
          section.level <= 2 ? "text-sm" : "text-xs text-fg/90"
        )}>
          {section.heading}
        </h3>
      ) : null}
      {hasTable ? renderTable(trimmedLines) : hasList ? (
        <ul className="space-y-0.5 text-xs text-fg/80">
          {trimmedLines.map((line, i) => {
            const m = line.match(/^\s*[-*]\s+(.*)/);
            return m ? (
              <li key={i} className="flex gap-1.5">
                <span className="text-accent/50 shrink-0">-</span>
                <span>{m[1]}</span>
              </li>
            ) : (
              <li key={i} className="pl-3.5">{line}</li>
            );
          })}
        </ul>
      ) : trimmedLines.length ? (
        <div className="text-xs text-fg/80 whitespace-pre-wrap leading-relaxed">{section.content.trim()}</div>
      ) : null}
    </div>
  );
}

function HeaderCard({ header }: { header: Record<string, unknown> }) {
  const display = Object.entries(header).filter(([k]) => !["schema", "contractVersion"].includes(k));
  if (!display.length) return null;
  return (
    <div className="rounded-lg border border-border/30 bg-card/40 p-3">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
        {display.slice(0, 14).map(([key, value]) => (
          <div key={key} className="flex gap-1.5 overflow-hidden">
            <span className="font-medium text-muted-fg shrink-0">{key}:</span>
            <span className="text-fg/80 truncate">
              {typeof value === "object" && value !== null ? JSON.stringify(value) : String(value ?? "-")}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PackContentView({ pack }: { pack: PackSummary | null }) {
  if (!pack) return <div className="flex items-center justify-center py-12 text-xs text-muted-fg">Loading…</div>;
  if (!pack.exists || !pack.body.trim().length) {
    return <EmptyState title="No pack data" description="This pack hasn't been generated yet. Click Refresh to create it." />;
  }

  const { header, sections } = parsePackBody(pack.body);

  return (
    <div className="space-y-4">
      {header ? <HeaderCard header={header} /> : null}
      {sections.map((section, i) => (
        <SectionBlock key={i} section={section} />
      ))}
    </div>
  );
}

// ─── Pack Type Tabs ─────────────────────────────────────────────────

type PackTab = "project" | "lanes" | "missions" | "conflicts" | "features" | "plans";

const TABS: { id: PackTab; label: string; icon: React.ElementType }[] = [
  { id: "project", label: "Project", icon: FolderGit2 },
  { id: "lanes", label: "Lanes", icon: FileText },
  { id: "missions", label: "Missions", icon: Rocket },
  { id: "conflicts", label: "Conflicts", icon: GitMerge },
  { id: "features", label: "Features", icon: Target },
  { id: "plans", label: "Plans", icon: ClipboardList }
];

// ─── Individual Pack Panels ─────────────────────────────────────────

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
    <div className="space-y-3">
      {/* Lane selector */}
      <div className="flex flex-wrap gap-1.5">
        {lanes.map((lane) => (
          <button
            key={lane.id}
            type="button"
            onClick={() => setSelectedLaneId(lane.id)}
            className={cn(
              "rounded-lg px-2.5 py-1 text-xs font-medium transition-colors",
              selectedLaneId === lane.id
                ? "bg-accent/15 text-accent ring-1 ring-accent/20"
                : "bg-card/40 text-muted-fg hover:bg-card/60 hover:text-fg"
            )}
          >
            {lane.name}
          </button>
        ))}
      </div>

      {selectedLaneId ? (
        <PackPanel
          title={`Lane Pack · ${lanes.find((l) => l.id === selectedLaneId)?.name ?? selectedLaneId}`}
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
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {missions.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => setSelectedId(m.id)}
            className={cn(
              "rounded-lg px-2.5 py-1 text-xs font-medium transition-colors",
              selectedId === m.id
                ? "bg-accent/15 text-accent ring-1 ring-accent/20"
                : "bg-card/40 text-muted-fg hover:bg-card/60 hover:text-fg"
            )}
          >
            {m.title || shortId(m.id)}
          </button>
        ))}
      </div>
      <PackPanel
        title={`Mission Pack · ${missions.find((m) => m.id === selectedId)?.title ?? ""}`}
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
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {lanes.map((lane) => (
          <button
            key={lane.id}
            type="button"
            onClick={() => setSelectedLaneId(lane.id)}
            className={cn(
              "rounded-lg px-2.5 py-1 text-xs font-medium transition-colors",
              selectedLaneId === lane.id
                ? "bg-accent/15 text-accent ring-1 ring-accent/20"
                : "bg-card/40 text-muted-fg hover:bg-card/60 hover:text-fg"
            )}
          >
            {lane.name}
          </button>
        ))}
      </div>
      {selectedLaneId ? (
        <PackPanel
          title={`Conflict Pack · ${lanes.find((l) => l.id === selectedLaneId)?.name ?? ""}`}
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
    <div className="space-y-3">
      <div className="flex gap-2">
        <input
          type="text"
          value={featureKey}
          onChange={(e) => setFeatureKey(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void load(); }}
          placeholder="Enter feature key..."
          className="flex-1 rounded-lg border border-border/40 bg-card/30 px-3 py-1.5 text-xs text-fg placeholder:text-muted-fg/50 focus:border-accent/50 focus:outline-none"
        />
        <Button size="sm" variant="outline" onClick={() => void load()} disabled={!featureKey.trim()}>
          Load
        </Button>
      </div>
      {searched && pack ? (
        <PackPanel
          title={`Feature Pack · ${featureKey}`}
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
        <div className="rounded-lg bg-red-500/10 p-3 text-xs text-red-300">{err}</div>
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
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {lanes.map((lane) => (
          <button
            key={lane.id}
            type="button"
            onClick={() => setSelectedLaneId(lane.id)}
            className={cn(
              "rounded-lg px-2.5 py-1 text-xs font-medium transition-colors",
              selectedLaneId === lane.id
                ? "bg-accent/15 text-accent ring-1 ring-accent/20"
                : "bg-card/40 text-muted-fg hover:bg-card/60 hover:text-fg"
            )}
          >
            {lane.name}
          </button>
        ))}
      </div>
      {selectedLaneId ? (
        <PackPanel
          title={`Plan Pack · ${lanes.find((l) => l.id === selectedLaneId)?.name ?? ""}`}
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

// ─── Reusable Pack Panel ────────────────────────────────────────────

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
    <div className="rounded border border-border/40 bg-panel/50 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border/30">
        <div>
          <h2 className="text-sm font-semibold text-fg">{title}</h2>
          <div className="text-[11px] text-muted-fg">
            {subtitle}
            {updatedAt ? <span className="ml-2">· Updated {relativeTime(updatedAt)}</span> : null}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {pack?.packKey ? (
            <>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={() => void loadVersions()}>
                <Clock className="h-3 w-3" /> History
              </Button>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={() => void loadEvents()}>
                Events
              </Button>
            </>
          ) : null}
          <Button variant="ghost" size="sm" className="h-7 px-2" onClick={onRefresh} disabled={busy}>
            <RefreshCw className={cn("h-3.5 w-3.5", busy && "animate-spin")} />
          </Button>
        </div>
      </div>

      {/* Error */}
      {error ? <div className="mx-4 mt-3 rounded-lg bg-red-500/10 p-2 text-xs text-red-300">{error}</div> : null}

      {/* Content */}
      <div className="px-4 py-3 max-h-[500px] overflow-auto">
        <PackContentView pack={pack} />
      </div>

      {/* Version History Drawer */}
      {showVersions ? (
        <div className="border-t border-border/30 px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold text-fg">Version History</h3>
            <button type="button" className="text-[11px] text-muted-fg hover:text-fg" onClick={() => setShowVersions(false)}>Close</button>
          </div>
          {!versions.length ? (
            <div className="text-[11px] text-muted-fg">No versions recorded yet.</div>
          ) : (
            <div className="space-y-1.5">
              {versions.map((v) => (
                <div key={v.id} className="flex items-center gap-3 rounded-lg bg-card/30 px-2.5 py-1.5 text-[11px]">
                  <span className="font-medium text-accent">v{v.versionNumber}</span>
                  <span className="text-muted-fg">{shortId(v.contentHash, 12)}</span>
                  <span className="ml-auto text-muted-fg">{relativeTime(v.createdAt)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {/* Events Drawer */}
      {showEvents ? (
        <div className="border-t border-border/30 px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold text-fg">Recent Events</h3>
            <button type="button" className="text-[11px] text-muted-fg hover:text-fg" onClick={() => setShowEvents(false)}>Close</button>
          </div>
          {!events.length ? (
            <div className="text-[11px] text-muted-fg">No events recorded yet.</div>
          ) : (
            <div className="space-y-1.5">
              {events.map((ev) => (
                <div key={ev.id} className="flex items-center gap-3 rounded-lg bg-card/30 px-2.5 py-1.5 text-[11px]">
                  <span className="font-medium text-fg">{ev.eventType}</span>
                  <span className="ml-auto text-muted-fg">{relativeTime(ev.createdAt)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {/* Pack file path */}
      {pack?.path ? (
        <div className="border-t border-border/20 px-4 py-1.5">
          <div className="truncate text-[10px] text-muted-fg/60">{pack.path}</div>
        </div>
      ) : null}
    </div>
  );
}

// ─── Inventory Summary ──────────────────────────────────────────────

function InventorySummary({ inventory }: { inventory: ContextInventorySnapshot | null }) {
  if (!inventory) return null;

  const stats = [
    { label: "Packs", value: inventory.packs.total },
    { label: "Checkpoints", value: inventory.checkpoints.total },
    { label: "Sessions", value: inventory.sessionTracking.trackedSessions },
    { label: "Missions", value: inventory.missions.total }
  ];

  return (
    <div className="flex gap-4">
      {stats.map((s) => (
        <div key={s.label} className="text-center">
          <div className="text-lg font-bold text-fg">{s.value}</div>
          <div className="text-[10px] text-muted-fg">{s.label}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Main Context Page ──────────────────────────────────────────────

export function ContextPage() {
  const [activeTab, setActiveTab] = React.useState<PackTab>("project");
  const [inventory, setInventory] = React.useState<ContextInventorySnapshot | null>(null);
  const [generateOpen, setGenerateOpen] = React.useState(false);

  React.useEffect(() => {
    window.ade.context.getInventory().then(setInventory).catch(() => {});
  }, []);

  // Refresh inventory on pack events
  React.useEffect(() => {
    const unsub = window.ade.packs.onEvent(() => {
      window.ade.context.getInventory().then(setInventory).catch(() => {});
    });
    return unsub;
  }, []);

  return (
    <div className="h-full overflow-auto px-6 py-5">
      {/* Page Header */}
      <div className="mb-5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-9 h-9 rounded bg-accent/10">
            <BookOpenText className="h-5 w-5 text-accent" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-fg">Context Packs</h1>
            <div className="text-xs text-muted-fg">
              Deterministic context snapshots for AI agents and developers
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <InventorySummary inventory={inventory} />
          <Button size="sm" variant="outline" onClick={() => setGenerateOpen(true)}>
            Generate Docs
          </Button>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="mb-4 flex items-center gap-1 rounded border border-border/30 bg-card/30 p-1 w-fit">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all",
              activeTab === tab.id
                ? "bg-accent/15 text-accent shadow-sm ring-1 ring-accent/20"
                : "text-muted-fg hover:bg-muted/40 hover:text-fg"
            )}
          >
            <tab.icon className="h-3.5 w-3.5" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="pb-8">
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

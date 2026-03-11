import React, { useCallback, useEffect, useState } from "react";
import {
  MagnifyingGlass,
  Broom,
  Stack,
  Brain,
  Database as DatabaseIcon,
  Robot,
  Target,
  Funnel,
} from "@phosphor-icons/react";
import { MemoryEntryCard } from "./shared/MemoryEntryCard";
import { Button } from "../ui/Button";
import { PaneHeader } from "../ui/PaneHeader";
import { cn } from "../ui/cn";
import { inputCls, labelCls, selectCls, cardCls } from "./shared/designTokens";

type MemoryScope = "project" | "agent" | "mission";
type MemoryTier = 1 | 2 | 3;

type MemoryEntry = {
  id: string;
  scope: string;
  tier: number;
  pinned: boolean;
  category: string;
  content: string;
  importance: "low" | "medium" | "high";
  status: "candidate" | "promoted" | "archived";
  confidence: number;
  createdAt: string;
  lastAccessedAt: string;
  accessCount: number;
};

type ScopeHealth = {
  scope: string;
  current: number;
  max: number;
  counts: { tier1: number; tier2: number; tier3: number; archived: number };
};

function normalizeEntry(raw: Record<string, unknown>): MemoryEntry {
  return {
    id: String(raw.id ?? ""),
    scope: String(raw.scope ?? "project"),
    tier: Number(raw.tier ?? 2),
    pinned: raw.pinned === true || raw.pinned === 1,
    category: String(raw.category ?? "fact"),
    content: String(raw.content ?? ""),
    importance: (raw.importance as MemoryEntry["importance"]) ?? "medium",
    status: (raw.status as MemoryEntry["status"]) ?? "promoted",
    confidence: Number(raw.confidence ?? 0),
    createdAt: String(raw.createdAt ?? raw.created_at ?? ""),
    lastAccessedAt: String(raw.lastAccessedAt ?? raw.last_accessed_at ?? ""),
    accessCount: Number(raw.accessCount ?? raw.access_count ?? 0),
  };
}

const SCOPES: { id: MemoryScope | "all"; label: string; icon: React.ElementType }[] = [
  { id: "all", label: "All", icon: DatabaseIcon },
  { id: "project", label: "Project", icon: Stack },
  { id: "agent", label: "CTO / Workers", icon: Robot },
  { id: "mission", label: "Mission", icon: Target },
];

export function CtoMemoryBrowser() {
  const [scope, setScope] = useState<MemoryScope | "all">("all");
  const [search, setSearch] = useState("");
  const [tierFilter, setTierFilter] = useState<MemoryTier | null>(null);
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [healthStats, setHealthStats] = useState<ScopeHealth[]>([]);
  const [sweeping, setSweeping] = useState(false);
  const [consolidating, setConsolidating] = useState(false);

  const selectedEntry = entries.find((e) => e.id === selectedId) ?? null;

  const loadEntries = useCallback(async () => {
    if (!window.ade?.memory) return;
    setLoading(true);
    try {
      if (search.trim()) {
        const results = await window.ade.memory.search({
          query: search,
          scope: scope === "all" ? undefined : scope,
          limit: 100,
          mode: "hybrid" as never,
        });
        setEntries((results as unknown as Record<string, unknown>[]).map(normalizeEntry));
      } else {
        const results = await window.ade.memory.list({
          scope: scope === "all" ? undefined : scope,
          tier: tierFilter ?? undefined,
          limit: 100,
        });
        setEntries((results as unknown as Record<string, unknown>[]).map(normalizeEntry));
      }
    } catch { /* non-fatal */ }
    finally { setLoading(false); }
  }, [scope, search, tierFilter]);

  const loadHealth = useCallback(async () => {
    if (!window.ade?.memory) return;
    try {
      const stats = await window.ade.memory.healthStats();
      setHealthStats((stats as { scopes?: ScopeHealth[] })?.scopes ?? []);
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => { void loadEntries(); }, [loadEntries]);
  useEffect(() => { void loadHealth(); }, [loadHealth]);

  const handleRunSweep = useCallback(async () => {
    if (!window.ade?.memory) return;
    setSweeping(true);
    try { await window.ade.memory.runSweep({}); await loadHealth(); }
    catch { /* non-fatal */ }
    finally { setSweeping(false); }
  }, [loadHealth]);

  const handleRunConsolidation = useCallback(async () => {
    if (!window.ade?.memory) return;
    setConsolidating(true);
    try { await window.ade.memory.runConsolidation({}); await loadHealth(); await loadEntries(); }
    catch { /* non-fatal */ }
    finally { setConsolidating(false); }
  }, [loadHealth, loadEntries]);

  const handlePromote = useCallback(async (id: string) => {
    if (!window.ade?.memory) return;
    try { await window.ade.memory.promote({ id }); await loadEntries(); }
    catch { /* non-fatal */ }
  }, [loadEntries]);

  const handleArchive = useCallback(async (id: string) => {
    if (!window.ade?.memory) return;
    try { await window.ade.memory.archive({ id }); await loadEntries(); }
    catch { /* non-fatal */ }
  }, [loadEntries]);

  return (
    <div className="flex h-full min-h-0">
      {/* Left rail: scope selector + health */}
      <div
        className="shrink-0 flex flex-col border-r border-border/20 overflow-y-auto"
        style={{ width: 200, background: "var(--color-surface-recessed)" }}
      >
        <div className="p-3">
          <div className={cn(labelCls, "mb-2")}>Scope</div>
          {SCOPES.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => { setScope(id); setSelectedId(null); }}
              className={cn(
                "w-full flex items-center gap-2 px-2.5 py-1.5 text-left transition-all border-l-2 mb-0.5",
                scope === id
                  ? "border-l-accent bg-accent/8 text-fg"
                  : "border-l-transparent text-muted-fg hover:text-fg hover:bg-muted/20",
              )}
            >
              <Icon size={12} weight={scope === id ? "bold" : "regular"} />
              <span className="font-mono text-[10px]">{label}</span>
            </button>
          ))}
        </div>

        {/* Health cards */}
        <div className="p-3 space-y-2">
          <div className={cn(labelCls, "mb-1")}>Health</div>
          {healthStats.map((h) => (
            <div key={h.scope} className="bg-card/40 border border-border/10 p-2">
              <div className="flex items-center justify-between mb-1">
                <span className="font-mono text-[9px] text-fg/70 capitalize">{h.scope}</span>
                <span className="font-mono text-[8px] text-muted-fg/40">{h.current}/{h.max}</span>
              </div>
              <div className="w-full h-1 bg-border/20 overflow-hidden mb-1">
                <div
                  className="h-full bg-accent/60"
                  style={{ width: `${Math.min(100, (h.current / h.max) * 100)}%` }}
                />
              </div>
              <div className="flex gap-2">
                {[
                  { label: "T1", count: h.counts.tier1, cls: "text-success" },
                  { label: "T2", count: h.counts.tier2, cls: "text-info" },
                  { label: "T3", count: h.counts.tier3, cls: "text-warning" },
                ].map(({ label, count, cls }) => (
                  <span key={label} className={cn("font-mono text-[8px]", cls)}>
                    {label}:{count}
                  </span>
                ))}
              </div>
            </div>
          ))}

          {/* Quick actions */}
          <div className="flex flex-col gap-1 mt-2">
            <Button variant="ghost" size="sm" onClick={handleRunSweep} disabled={sweeping} className="!justify-start">
              <Broom size={10} />
              {sweeping ? "Sweeping..." : "Run Sweep"}
            </Button>
            <Button variant="ghost" size="sm" onClick={handleRunConsolidation} disabled={consolidating} className="!justify-start">
              <Stack size={10} />
              {consolidating ? "Consolidating..." : "Consolidate"}
            </Button>
          </div>
        </div>
      </div>

      {/* Center: entry list */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Search bar */}
        <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border/20">
          <MagnifyingGlass size={12} className="text-muted-fg/40 shrink-0" />
          <input
            className="flex-1 bg-transparent text-xs font-mono text-fg placeholder:text-muted-fg/30 focus:outline-none"
            placeholder="Search memories..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            className="bg-transparent font-mono text-[9px] text-muted-fg/50 border-none focus:outline-none"
            value={tierFilter ?? ""}
            onChange={(e) => setTierFilter(e.target.value ? Number(e.target.value) as MemoryTier : null)}
          >
            <option value="">All tiers</option>
            <option value="1">Tier 1</option>
            <option value="2">Tier 2</option>
            <option value="3">Tier 3</option>
          </select>
        </div>

        {/* Entry list */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {loading ? (
            <div className="text-[10px] text-muted-fg/50 py-4 text-center">Loading...</div>
          ) : entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8">
              <Brain size={24} weight="thin" className="text-muted-fg/20 mb-2" />
              <div className="font-mono text-[10px] text-muted-fg/50">No memories found.</div>
            </div>
          ) : entries.map((entry) => (
            <MemoryEntryCard
              key={entry.id}
              entry={entry}
              selected={selectedId === entry.id}
              onClick={() => setSelectedId(selectedId === entry.id ? null : entry.id)}
              onPromote={() => void handlePromote(entry.id)}
              onArchive={() => void handleArchive(entry.id)}
            />
          ))}
        </div>
      </div>

      {/* Right panel: entry detail */}
      {selectedEntry && (
        <div className="shrink-0 border-l border-border/20 overflow-y-auto" style={{ width: 260 }}>
          <div className="p-3 space-y-3">
            <div className={cn(labelCls, "mb-1")}>Detail</div>

            {/* Full content */}
            <pre className="font-mono text-[10px] text-fg/80 leading-relaxed whitespace-pre-wrap break-words bg-surface-recessed border border-border/10 p-3 max-h-48 overflow-y-auto">
              {selectedEntry.content}
            </pre>

            {/* Metadata */}
            <div className="space-y-1.5">
              {[
                { label: "Scope", value: selectedEntry.scope },
                { label: "Category", value: selectedEntry.category },
                { label: "Tier", value: String(selectedEntry.tier) },
                { label: "Importance", value: selectedEntry.importance },
                { label: "Status", value: selectedEntry.status },
                { label: "Confidence", value: `${(selectedEntry.confidence * 100).toFixed(0)}%` },
                { label: "Access Count", value: String(selectedEntry.accessCount) },
                { label: "Created", value: selectedEntry.createdAt ? new Date(selectedEntry.createdAt).toLocaleString() : "-" },
                { label: "Last Accessed", value: selectedEntry.lastAccessedAt ? new Date(selectedEntry.lastAccessedAt).toLocaleString() : "-" },
                { label: "Pinned", value: selectedEntry.pinned ? "Yes" : "No" },
              ].map(({ label, value }) => (
                <div key={label} className="flex items-center justify-between">
                  <span className="font-mono text-[9px] text-muted-fg/40">{label}</span>
                  <span className="font-mono text-[9px] text-fg/70">{value}</span>
                </div>
              ))}
            </div>

            {/* Actions */}
            <div className="flex gap-1">
              {selectedEntry.status === "candidate" && (
                <Button variant="outline" size="sm" onClick={() => void handlePromote(selectedEntry.id)}>
                  Promote
                </Button>
              )}
              {selectedEntry.status !== "archived" && (
                <Button variant="ghost" size="sm" onClick={() => void handleArchive(selectedEntry.id)}>
                  Archive
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  MagnifyingGlass,
  Broom,
  Stack,
  Brain,
  Database as DatabaseIcon,
  Robot,
  Target,
  ArrowsClockwise,
  GitBranch,
  Lightning,
} from "@phosphor-icons/react";
import type {
  KnowledgeSyncStatus,
  MemoryEntryDto,
  ProcedureDetail,
  ProcedureListItem,
  SkillIndexEntry,
} from "../../../shared/types";
import { MemoryEntryCard } from "./shared/MemoryEntryCard";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { labelCls, cardCls, recessedPanelCls } from "./shared/designTokens";
import { formatDate, shortSha, extractError } from "../../lib/format";

type MemoryScope = "project" | "agent" | "mission";
type MemoryTier = 1 | 2 | 3;
type BrowserTabId = "browser" | "procedures" | "skills" | "sync";

type ScopeHealth = {
  scope: string;
  current: number;
  max: number;
  counts: { tier1: number; tier2: number; tier3: number; archived: number };
};

const EMPTY_SYNC_STATUS: KnowledgeSyncStatus = {
  syncing: false,
  lastSeenHeadSha: null,
  currentHeadSha: null,
  diverged: false,
  lastDigestAt: null,
  lastDigestMemoryId: null,
  lastError: null,
};

const MEMORY_TABS: Array<{ id: BrowserTabId; label: string; icon: React.ElementType }> = [
  { id: "browser", label: "Memory Browser", icon: DatabaseIcon },
  { id: "procedures", label: "Procedures", icon: Brain },
  { id: "skills", label: "Skills", icon: Robot },
  { id: "sync", label: "Knowledge Sync", icon: GitBranch },
];

function normalizeEntry(raw: Record<string, unknown>): MemoryEntryDto {
  return {
    id: String(raw.id ?? ""),
    scope: (String(raw.scope ?? "project") as MemoryEntryDto["scope"]),
    scopeOwnerId: raw.scopeOwnerId == null ? null : String(raw.scopeOwnerId),
    tier: Number(raw.tier ?? 2),
    pinned: raw.pinned === true || raw.pinned === 1,
    category: String(raw.category ?? "fact") as MemoryEntryDto["category"],
    content: String(raw.content ?? ""),
    importance: (raw.importance as MemoryEntryDto["importance"]) ?? "medium",
    status: (raw.status as MemoryEntryDto["status"]) ?? "promoted",
    confidence: Number(raw.confidence ?? 0),
    createdAt: String(raw.createdAt ?? raw.created_at ?? ""),
    updatedAt: String(raw.updatedAt ?? raw.updated_at ?? ""),
    lastAccessedAt: String(raw.lastAccessedAt ?? raw.last_accessed_at ?? ""),
    accessCount: Number(raw.accessCount ?? raw.access_count ?? 0),
    observationCount: Number(raw.observationCount ?? raw.observation_count ?? 0),
    embedded: raw.embedded === true || raw.embedded === 1,
    sourceRunId: raw.sourceRunId == null ? null : String(raw.sourceRunId),
    sourceType: raw.sourceType == null ? null : String(raw.sourceType),
    sourceId: raw.sourceId == null ? null : String(raw.sourceId),
    fileScopePattern: raw.fileScopePattern == null
      ? (raw.file_scope_pattern == null ? null : String(raw.file_scope_pattern))
      : String(raw.fileScopePattern),
  };
}

const SCOPES: { id: MemoryScope | "all"; label: string; icon: React.ElementType }[] = [
  { id: "all", label: "All", icon: DatabaseIcon },
  { id: "project", label: "Project", icon: Stack },
  { id: "agent", label: "CTO / Workers", icon: Robot },
  { id: "mission", label: "Mission", icon: Target },
];

export function CtoMemoryBrowser() {
  const memoryApi = window.ade?.memory;
  const [scope, setScope] = useState<MemoryScope | "all">("all");
  const [search, setSearch] = useState("");
  const [tierFilter, setTierFilter] = useState<MemoryTier | null>(null);
  const [entries, setEntries] = useState<MemoryEntryDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [healthStats, setHealthStats] = useState<ScopeHealth[]>([]);
  const [sweeping, setSweeping] = useState(false);
  const [consolidating, setConsolidating] = useState(false);
  const [activeTab, setActiveTab] = useState<BrowserTabId>("browser");
  const [procedures, setProcedures] = useState<ProcedureListItem[]>([]);
  const [selectedProcedureId, setSelectedProcedureId] = useState<string | null>(null);
  const [selectedProcedureDetail, setSelectedProcedureDetail] = useState<ProcedureDetail | null>(null);
  const [procedureDetailLoading, setProcedureDetailLoading] = useState(false);
  const [skills, setSkills] = useState<SkillIndexEntry[]>([]);
  const [knowledgeSyncStatus, setKnowledgeSyncStatus] = useState<KnowledgeSyncStatus>(EMPTY_SYNC_STATUS);
  const [syncRunning, setSyncRunning] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const selectedEntry = entries.find((e) => e.id === selectedId) ?? null;
  const selectedProcedure = procedures.find((item) => item.memory.id === selectedProcedureId) ?? null;
  const sortedProcedures = useMemo(
    () => [...procedures].sort((left, right) =>
      right.procedural.confidence - left.procedural.confidence
      || (right.procedural.successCount + right.procedural.failureCount) - (left.procedural.successCount + left.procedural.failureCount)
      || left.procedural.trigger.localeCompare(right.procedural.trigger)
    ),
    [procedures],
  );
  const sortedSkills = useMemo(
    () => [...skills].sort((left, right) =>
      (right.lastModifiedAt ?? "").localeCompare(left.lastModifiedAt ?? "")
      || left.path.localeCompare(right.path)
    ),
    [skills],
  );

  const loadEntries = useCallback(async () => {
    if (!memoryApi) return;
    setLoading(true);
    try {
      if (search.trim()) {
        const results = await memoryApi.search({
          query: search,
          scope: scope === "all" ? undefined : scope,
          limit: 100,
          mode: "hybrid" as never,
        });
        setEntries((results as unknown as Record<string, unknown>[]).map(normalizeEntry));
      } else {
        const results = await memoryApi.list({
          scope: scope === "all" ? undefined : scope,
          tier: tierFilter ?? undefined,
          limit: 100,
        });
        setEntries(results.map((result) => normalizeEntry(result as unknown as Record<string, unknown>)));
      }
    } catch { /* non-fatal */ }
    finally { setLoading(false); }
  }, [memoryApi, scope, search, tierFilter]);

  const loadKnowledge = useCallback(async (opts?: { keepSelectionId?: string | null }) => {
    if (!memoryApi) return;
    try {
      const [nextProcedures, nextSkills, nextSyncStatus] = await Promise.all([
        memoryApi.listProcedures?.({ status: "all", scope: "project" }) ?? Promise.resolve([]),
        memoryApi.listIndexedSkills?.() ?? Promise.resolve([]),
        memoryApi.getKnowledgeSyncStatus?.() ?? Promise.resolve(EMPTY_SYNC_STATUS),
      ]);
      setProcedures(nextProcedures);
      setSkills(nextSkills);
      setKnowledgeSyncStatus(nextSyncStatus);

      const nextSelectedId = opts?.keepSelectionId ?? null;
      if (!nextSelectedId || !nextProcedures.some((item) => item.memory.id === nextSelectedId)) {
        setSelectedProcedureId(nextProcedures[0]?.memory.id ?? null);
        if (!opts?.keepSelectionId) setSelectedProcedureDetail(null);
      }
    } catch {
      // Non-fatal; the browser tab should still work.
    }
  }, [memoryApi]);

  const loadHealth = useCallback(async () => {
    if (!memoryApi) return;
    try {
      const stats = await memoryApi.getHealthStats();
      setHealthStats((stats as { scopes?: ScopeHealth[] })?.scopes ?? []);
    } catch { /* non-fatal */ }
  }, [memoryApi]);

  useEffect(() => { void loadEntries(); }, [loadEntries]);
  useEffect(() => { void loadHealth(); }, [loadHealth]);
  useEffect(() => { void loadKnowledge(); }, [loadKnowledge]);

  useEffect(() => {
    if (activeTab !== "procedures" || !selectedProcedureId || !memoryApi?.getProcedureDetail) return;
    let cancelled = false;
    setProcedureDetailLoading(true);
    void memoryApi.getProcedureDetail({ id: selectedProcedureId })
      .then((detail) => {
        if (!cancelled) setSelectedProcedureDetail(detail);
      })
      .catch(() => {
        if (!cancelled) setSelectedProcedureDetail(null);
      })
      .finally(() => {
        if (!cancelled) setProcedureDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, memoryApi, selectedProcedureId]);

  const handleRunSweep = useCallback(async () => {
    if (!memoryApi) return;
    setSweeping(true);
    try { await memoryApi.runSweep(); await loadHealth(); }
    catch { /* non-fatal */ }
    finally { setSweeping(false); }
  }, [loadHealth, memoryApi]);

  const handleRunConsolidation = useCallback(async () => {
    if (!memoryApi) return;
    setConsolidating(true);
    try { await memoryApi.runConsolidation(); await loadHealth(); await loadEntries(); }
    catch { /* non-fatal */ }
    finally { setConsolidating(false); }
  }, [loadHealth, loadEntries, memoryApi]);

  const handlePromote = useCallback(async (id: string) => {
    if (!memoryApi) return;
    setActionError(null);
    try {
      await memoryApi.promote({ id });
      await Promise.all([
        loadEntries(),
        loadKnowledge({ keepSelectionId: selectedProcedureId }),
      ]);
    } catch (error) {
      setActionError(extractError(error));
    }
  }, [loadEntries, loadKnowledge, memoryApi, selectedProcedureId]);

  const handleArchive = useCallback(async (id: string) => {
    if (!memoryApi) return;
    setActionError(null);
    try {
      await memoryApi.archive({ id });
      await Promise.all([
        loadEntries(),
        loadKnowledge({ keepSelectionId: selectedProcedureId }),
      ]);
    } catch (error) {
      setActionError(extractError(error));
    }
  }, [loadEntries, loadKnowledge, memoryApi, selectedProcedureId]);

  const handleExportProcedureSkill = useCallback(async (id: string) => {
    if (!memoryApi?.exportProcedureSkill) return;
    setActionError(null);
    try {
      await memoryApi.exportProcedureSkill({ id });
      await loadKnowledge({ keepSelectionId: selectedProcedureId });
    } catch (error) {
      setActionError(extractError(error));
    }
  }, [loadKnowledge, memoryApi, selectedProcedureId]);

  const handleReindexSkills = useCallback(async (paths?: string[]) => {
    if (!memoryApi?.reindexSkills) return;
    setActionError(null);
    try {
      await memoryApi.reindexSkills(paths && paths.length > 0 ? { paths } : {});
      await loadKnowledge({ keepSelectionId: selectedProcedureId });
    } catch (error) {
      setActionError(extractError(error));
    }
  }, [loadKnowledge, memoryApi, selectedProcedureId]);

  const handleSyncKnowledge = useCallback(async () => {
    if (!memoryApi?.syncKnowledge || syncRunning) return;
    setSyncRunning(true);
    setActionError(null);
    try {
      await memoryApi.syncKnowledge();
      await loadKnowledge({ keepSelectionId: selectedProcedureId });
    } catch (error) {
      setActionError(extractError(error));
    } finally {
      setSyncRunning(false);
    }
  }, [loadKnowledge, memoryApi, selectedProcedureId, syncRunning]);

  function renderRawBrowser() {
    return (
      <div className="flex h-full min-h-0">
        <div
          className={cn("shrink-0 flex flex-col border-r border-border/20 overflow-y-auto", recessedPanelCls)}
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

          <div className="p-3 space-y-2">
            <div className={cn(labelCls, "mb-1")}>Health</div>
            {healthStats.map((h) => (
              <div key={h.scope} className={cn(cardCls, "p-2")}>
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

        <div className="flex-1 flex flex-col min-w-0 min-h-0">
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

        {selectedEntry && (
          <div className="shrink-0 overflow-y-auto border-l border-border/20 bg-surface/80" style={{ width: 280 }}>
            <div className="p-3 space-y-3">
              <div className={cn(labelCls, "mb-1")}>Detail</div>
              <pre className="font-mono text-[10px] text-fg/80 leading-relaxed whitespace-pre-wrap break-words bg-surface-recessed border border-border/10 p-3 max-h-48 overflow-y-auto">
                {selectedEntry.content}
              </pre>
              <div className="space-y-1.5" data-testid="cto-memory-detail-metadata">
                {[
                  { label: "Scope", value: selectedEntry.scope },
                  { label: "Category", value: selectedEntry.category },
                  { label: "Tier", value: String(selectedEntry.tier) },
                  { label: "Importance", value: selectedEntry.importance },
                  { label: "Status", value: selectedEntry.status },
                  { label: "Confidence", value: `${(selectedEntry.confidence * 100).toFixed(0)}%` },
                  { label: "Observations", value: String(selectedEntry.observationCount) },
                  { label: "Source Type", value: selectedEntry.sourceType ?? "-" },
                  { label: "Source ID", value: selectedEntry.sourceId ?? "-" },
                  { label: "Source Run", value: selectedEntry.sourceRunId ?? "-" },
                  { label: "File Scope", value: selectedEntry.fileScopePattern ?? "-" },
                  { label: "Access Count", value: String(selectedEntry.accessCount) },
                  { label: "Created", value: selectedEntry.createdAt ? new Date(selectedEntry.createdAt).toLocaleString() : "-" },
                  { label: "Last Accessed", value: selectedEntry.lastAccessedAt ? new Date(selectedEntry.lastAccessedAt).toLocaleString() : "-" },
                  { label: "Pinned", value: selectedEntry.pinned ? "Yes" : "No" },
                ].map(({ label, value }) => (
                  <div key={label} className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[9px] text-muted-fg/40">{label}</span>
                    <span className="font-mono text-[9px] text-fg/70 text-right break-all">{value}</span>
                  </div>
                ))}
              </div>
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

  function renderProcedures() {
    return (
      <div className="grid h-full min-h-0 grid-cols-[minmax(0,1.2fr)_minmax(260px,0.8fr)]">
        <div className="min-h-0 overflow-y-auto border-r border-border/20 p-3 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className={cn(labelCls)}>Learned Procedures</div>
              <div className="font-mono text-[10px] text-muted-fg/50 mt-1">
                Review intervention, PR, and recurring-failure patterns promoted into repeatable workflows.
              </div>
            </div>
            <div className="font-mono text-[10px] text-muted-fg/50">
              {sortedProcedures.length} procedure{sortedProcedures.length === 1 ? "" : "s"}
            </div>
          </div>
          {sortedProcedures.length === 0 ? (
            <div className={cn(cardCls, "p-4 font-mono text-[10px] text-muted-fg/60")}>
              No procedures yet.
            </div>
          ) : sortedProcedures.map((item) => {
            const applications = item.procedural.successCount + item.procedural.failureCount;
            const selected = selectedProcedureId === item.memory.id;
            return (
              <div
                key={item.memory.id}
                className={cn(cardCls, "p-3 space-y-3 border", selected ? "border-accent/30" : "border-border/20")}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-mono text-[11px] text-fg break-words">{item.procedural.trigger}</div>
                    <div className="font-mono text-[10px] text-muted-fg/60 mt-1">
                      confidence {Math.round(item.procedural.confidence * 100)}% · {applications} application{applications === 1 ? "" : "s"} · {item.memory.status}
                    </div>
                  </div>
                  <div className="flex flex-wrap justify-end gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setSelectedProcedureId(item.memory.id)}>
                      Details
                    </Button>
                    {item.memory.status === "candidate" ? (
                      <Button variant="ghost" size="sm" onClick={() => void handlePromote(item.memory.id)}>
                        Promote
                      </Button>
                    ) : null}
                    <Button variant="ghost" size="sm" onClick={() => void handleExportProcedureSkill(item.memory.id)}>
                      Export
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => void handleArchive(item.memory.id)}>
                      Archive
                    </Button>
                  </div>
                </div>
                <div className="text-[11px] text-fg/80 whitespace-pre-wrap leading-relaxed">
                  {item.procedural.procedure}
                </div>
                <div className="font-mono text-[10px] text-muted-fg/60">
                  success {item.procedural.successCount} · failure {item.procedural.failureCount} · sources {item.procedural.sourceEpisodeIds.length}
                  {item.exportedSkillPath ? ` · exported ${item.exportedSkillPath}` : ""}
                </div>
              </div>
            );
          })}
        </div>

        <div className="min-h-0 overflow-y-auto p-3 space-y-3">
          <div className={cn(labelCls)}>Procedure Detail</div>
          {procedureDetailLoading ? (
            <div className={cn(cardCls, "p-4 font-mono text-[10px] text-muted-fg/60")}>Loading procedure detail...</div>
          ) : selectedProcedureDetail ? (
            <>
              <div className={cn(cardCls, "p-4 space-y-3")}>
                <div>
                  <div className="font-mono text-[11px] text-fg">{selectedProcedureDetail.procedural.trigger}</div>
                  <div className="font-mono text-[10px] text-muted-fg/60 mt-1">
                    confidence {Math.round(selectedProcedureDetail.procedural.confidence * 100)}% · last used {formatDate(selectedProcedureDetail.procedural.lastUsed)}
                  </div>
                </div>
                <div className="text-[11px] text-fg/80 whitespace-pre-wrap leading-relaxed">
                  {selectedProcedureDetail.procedural.procedure}
                </div>
                <div className="font-mono text-[10px] text-muted-fg/60">
                  memory source {selectedProcedureDetail.memory.sourceType ?? "-"} · {selectedProcedureDetail.memory.sourceId ?? "-"}
                </div>
              </div>

              <div className={cn(cardCls, "p-4 space-y-2")} data-testid="cto-procedure-source-episodes">
                <div className={cn(labelCls)}>Source Episodes</div>
                {selectedProcedureDetail.sourceEpisodes.length === 0 ? (
                  <div className="font-mono text-[10px] text-muted-fg/60">No source episodes linked yet.</div>
                ) : selectedProcedureDetail.sourceEpisodes.map((episode) => (
                  <div key={episode.id} className="border border-border/20 bg-surface-recessed px-3 py-2">
                    <div className="font-mono text-[9px] text-muted-fg/50">
                      {formatDate(episode.createdAt)} · {episode.sourceType ?? "memory"} · {episode.sourceId ?? episode.id}
                    </div>
                    <div className="text-[10px] text-fg/80 whitespace-pre-wrap leading-relaxed mt-1">
                      {episode.content}
                    </div>
                  </div>
                ))}
              </div>

              <div className={cn(cardCls, "p-4 space-y-2")} data-testid="cto-procedure-confidence-history">
                <div className={cn(labelCls)}>Confidence History</div>
                {selectedProcedureDetail.confidenceHistory.length === 0 ? (
                  <div className="font-mono text-[10px] text-muted-fg/60">No confidence history recorded yet.</div>
                ) : selectedProcedureDetail.confidenceHistory.map((entry) => (
                  <div key={entry.id} className="border border-border/20 bg-surface-recessed px-3 py-2">
                    <div className="font-mono text-[10px] text-fg">
                      {entry.outcome} · {Math.round(entry.confidence * 100)}%
                    </div>
                    <div className="font-mono text-[9px] text-muted-fg/50 mt-1">
                      {formatDate(entry.recordedAt)}
                      {entry.reason ? ` · ${entry.reason}` : ""}
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className={cn(cardCls, "p-4 font-mono text-[10px] text-muted-fg/60")}>
              {selectedProcedure ? "Select a procedure to inspect it." : "No procedure selected."}
            </div>
          )}
        </div>
      </div>
    );
  }

  function renderSkills() {
    return (
      <div className="h-full min-h-0 overflow-y-auto p-3 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className={cn(labelCls)}>Indexed Skills</div>
            <div className="font-mono text-[10px] text-muted-fg/50 mt-1">
              Review project skills exported from procedures and user-authored skill files currently indexed into memory.
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void handleReindexSkills()}>
            <ArrowsClockwise size={10} />
            Reindex All
          </Button>
        </div>

        {sortedSkills.length === 0 ? (
          <div className={cn(cardCls, "p-4 font-mono text-[10px] text-muted-fg/60")}>
            No indexed skills found.
          </div>
        ) : sortedSkills.map((item) => (
          <div key={item.id} className={cn(cardCls, "p-4 space-y-3")}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-mono text-[11px] text-fg break-all">{item.path}</div>
                <div className="font-mono text-[10px] text-muted-fg/60 mt-1">
                  {item.kind} · {item.source} · {item.archivedAt ? "archived" : "active"}
                </div>
              </div>
              <div className="flex flex-wrap justify-end gap-1">
                <Button variant="ghost" size="sm" onClick={() => void window.ade?.app?.revealPath?.(item.path)}>
                  Reveal
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void handleReindexSkills([item.path])}>
                  Reindex
                </Button>
              </div>
            </div>
            <div className="font-mono text-[10px] text-muted-fg/60">
              modified {formatDate(item.lastModifiedAt)} · hash {item.contentHash.slice(0, 8)}
            </div>
          </div>
        ))}
      </div>
    );
  }

  function renderKnowledgeSync() {
    return (
      <div className="h-full min-h-0 overflow-y-auto p-3 space-y-3">
        <div className={cn(cardCls, "p-4 space-y-3")} data-testid="cto-knowledge-sync">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className={cn(labelCls)}>Knowledge Freshness</div>
              <div className="font-mono text-[10px] text-muted-fg/50 mt-1">
                Keep project knowledge aligned with the latest repository HEAD before relying on memory-backed guidance.
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={() => void handleSyncKnowledge()} disabled={syncRunning || knowledgeSyncStatus.syncing}>
              <Lightning size={10} />
              {syncRunning || knowledgeSyncStatus.syncing ? "Syncing..." : "Sync Knowledge"}
            </Button>
          </div>

          <div className="grid gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10px] text-muted-fg/60">Status</span>
              <span className="font-mono text-[10px] text-fg">
                {knowledgeSyncStatus.syncing ? "Syncing" : knowledgeSyncStatus.diverged ? "Behind HEAD" : "Current"}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10px] text-muted-fg/60">Current HEAD</span>
              <span className="font-mono text-[10px] text-fg">{shortSha(knowledgeSyncStatus.currentHeadSha)}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10px] text-muted-fg/60">Last Digested</span>
              <span className="font-mono text-[10px] text-fg">{shortSha(knowledgeSyncStatus.lastSeenHeadSha)}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[10px] text-muted-fg/60">Updated</span>
              <span className="font-mono text-[10px] text-fg">{formatDate(knowledgeSyncStatus.lastDigestAt)}</span>
            </div>
            {knowledgeSyncStatus.lastDigestMemoryId ? (
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[10px] text-muted-fg/60">Digest Memory</span>
                <span className="font-mono text-[10px] text-fg break-all">{knowledgeSyncStatus.lastDigestMemoryId}</span>
              </div>
            ) : null}
          </div>

          {knowledgeSyncStatus.lastError ? (
            <div className="border border-error/30 bg-error/10 px-3 py-2 font-mono text-[10px] text-error">
              {knowledgeSyncStatus.lastError}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border/20 px-3 py-2">
        <div className="flex flex-wrap gap-2">
          {MEMORY_TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setActiveTab(id)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-sm border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] transition-colors",
                activeTab === id
                  ? "border-accent/40 bg-accent/10 text-fg"
                  : "border-border/20 text-muted-fg hover:text-fg hover:border-border/40",
              )}
            >
              <Icon size={11} />
              {label}
            </button>
          ))}
        </div>
        {actionError ? (
          <div className="mt-2 border border-error/30 bg-error/10 px-3 py-2 font-mono text-[10px] text-error">
            {actionError}
          </div>
        ) : null}
      </div>

      <div className="flex-1 min-h-0">
        {activeTab === "browser" ? renderRawBrowser() : null}
        {activeTab === "procedures" ? renderProcedures() : null}
        {activeTab === "skills" ? renderSkills() : null}
        {activeTab === "sync" ? renderKnowledgeSync() : null}
      </div>
    </div>
  );
}

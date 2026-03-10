import React from "react";
import type { ContextStatus, MemoryHealthStats, MemorySearchMode } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { GenerateDocsModal } from "../context/GenerateDocsModal";
import { EmptyState } from "../ui/EmptyState";
import {
  COLORS,
  MONO_FONT,
  LABEL_STYLE,
  cardStyle,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";

type MemoryScope = "agent" | "project" | "mission";
type MemoryStatus = "candidate" | "promoted" | "archived";
type MemoryImportance = "low" | "medium" | "high";

type MemoryEntry = {
  id: string;
  scope: MemoryScope;
  tier: number;
  pinned: boolean;
  category: string;
  content: string;
  importance: MemoryImportance;
  createdAt: string;
  lastAccessedAt: string;
  accessCount: number;
  status: MemoryStatus;
  confidence: number;
  embedded: boolean;
};

type MemoryInspectorPanelProps = {
  laneId?: string | null;
  compact?: boolean;
  showDocsSection?: boolean;
};

type ScopeFilter = "all" | MemoryScope;

function createEmptyMemoryHealthStats(): MemoryHealthStats {
  return {
    scopes: [
      { scope: "project", current: 0, max: 2000, counts: { tier1: 0, tier2: 0, tier3: 0, archived: 0 } },
      { scope: "agent", current: 0, max: 500, counts: { tier1: 0, tier2: 0, tier3: 0, archived: 0 } },
      { scope: "mission", current: 0, max: 200, counts: { tier1: 0, tier2: 0, tier3: 0, archived: 0 } },
    ],
    lastSweep: null,
    lastConsolidation: null,
    embeddings: {
      entriesEmbedded: 0,
      entriesTotal: 0,
      queueDepth: 0,
      processing: false,
      lastBatchProcessedAt: null,
      cacheEntries: 0,
      cacheHits: 0,
      cacheMisses: 0,
      cacheHitRate: 0,
      model: {
        modelId: "Xenova/all-MiniLM-L6-v2",
        state: "idle",
        progress: null,
        loaded: null,
        total: null,
        file: null,
        error: null,
      },
    },
  };
}

const sectionLabelStyle: React.CSSProperties = {
  ...LABEL_STYLE,
  fontSize: 11,
  marginBottom: 10,
};

function normalizeMemoryScope(value: unknown): MemoryScope {
  const raw = String(value ?? "").trim();
  if (raw === "project" || raw === "mission" || raw === "agent") return raw;
  if (raw === "user") return "agent";
  if (raw === "lane") return "mission";
  return "project";
}

function normalizeMemoryStatus(value: unknown): MemoryStatus {
  const raw = String(value ?? "").trim();
  if (raw === "candidate" || raw === "promoted" || raw === "archived") return raw;
  return "promoted";
}

function normalizeMemoryImportance(value: unknown): MemoryImportance {
  const raw = String(value ?? "").trim();
  if (raw === "low" || raw === "medium" || raw === "high") return raw;
  return "medium";
}

function toMemoryEntry(value: unknown): MemoryEntry | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = String(row.id ?? "").trim();
  const content = String(row.content ?? "").trim();
  if (!id || !content) return null;
  return {
    id,
    scope: normalizeMemoryScope(row.scope),
    tier: Number(row.tier ?? 2),
    pinned: row.pinned === true || row.pinned === 1,
    category: String(row.category ?? "fact").trim() || "fact",
    content,
    importance: normalizeMemoryImportance(row.importance),
    createdAt: String(row.createdAt ?? row.created_at ?? ""),
    lastAccessedAt: String(row.lastAccessedAt ?? row.last_accessed_at ?? ""),
    accessCount: Number(row.accessCount ?? row.access_count ?? 0),
    status: normalizeMemoryStatus(row.status),
    confidence: Number(row.confidence ?? 0),
    embedded: row.embedded === true || row.embedded === 1 || row.embedded === "1",
  };
}

function toMemoryEntries(raw: unknown): MemoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const list: MemoryEntry[] = [];
  for (const item of raw) {
    const entry = toMemoryEntry(item);
    if (entry) list.push(entry);
  }
  return list;
}

function relativeTime(value: string | null | undefined): string {
  if (!value) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 60_000) return "just now";
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  return `${Math.floor(diffMs / 86_400_000)}d ago`;
}

function scopeBadgeColor(scope: MemoryScope): string {
  switch (scope) {
    case "project":
      return COLORS.accent;
    case "mission":
      return COLORS.info;
    case "agent":
      return COLORS.warning;
    default:
      return COLORS.textMuted;
  }
}

function statusBadgeColor(status: MemoryStatus): string {
  switch (status) {
    case "promoted":
      return COLORS.success;
    case "candidate":
      return COLORS.warning;
    default:
      return COLORS.textDim;
  }
}

function importanceBadgeColor(importance: MemoryImportance): string {
  if (importance === "high") return COLORS.danger;
  if (importance === "medium") return COLORS.warning;
  return COLORS.textMuted;
}

function SmallBadge({ label, color }: { label: string; color: string }) {
  return (
    <span
      style={{
        fontSize: 10,
        fontFamily: MONO_FONT,
        fontWeight: 700,
        letterSpacing: "1px",
        textTransform: "uppercase",
        color,
        background: `${color}16`,
        border: `1px solid ${color}33`,
        padding: "2px 6px",
      }}
    >
      {label}
    </span>
  );
}

function memoryMatchesFilters(entry: MemoryEntry, scopeFilter: ScopeFilter, categoryFilter: string): boolean {
  if (scopeFilter !== "all" && entry.scope !== scopeFilter) return false;
  if (categoryFilter !== "all" && entry.category !== categoryFilter) return false;
  return true;
}

function areEmbeddingsReady(stats: MemoryHealthStats): boolean {
  return stats.embeddings.model.state === "ready";
}

function searchModeButtonStyle(active: boolean): React.CSSProperties {
  return active
    ? primaryButton({ height: 28, padding: "0 10px", fontSize: 10 })
    : outlineButton({ height: 28, padding: "0 10px", fontSize: 10 });
}

export function MemoryInspectorPanel({
  laneId = null,
  compact = false,
  showDocsSection = false,
}: MemoryInspectorPanelProps) {
  const memoryApi = window.ade.memory;
  const lanes = useAppStore((s) => s.lanes);
  const laneName = React.useMemo(() => lanes.find((lane) => lane.id === laneId)?.name ?? null, [lanes, laneId]);

  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [searching, setSearching] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [budgetEntries, setBudgetEntries] = React.useState<MemoryEntry[]>([]);
  const [candidates, setCandidates] = React.useState<MemoryEntry[]>([]);
  const [searchInput, setSearchInput] = React.useState("");
  const [searchResults, setSearchResults] = React.useState<MemoryEntry[]>([]);
  const [scopeFilter, setScopeFilter] = React.useState<ScopeFilter>("all");
  const [categoryFilter, setCategoryFilter] = React.useState<string>("all");
  const [healthStats, setHealthStats] = React.useState<MemoryHealthStats>(createEmptyMemoryHealthStats());
  const [searchMode, setSearchMode] = React.useState<MemorySearchMode>("lexical");
  const [hasChosenSearchMode, setHasChosenSearchMode] = React.useState(false);

  const [docsStatus, setDocsStatus] = React.useState<ContextStatus | null>(null);
  const [docsModalOpen, setDocsModalOpen] = React.useState(false);
  const [docsLoading, setDocsLoading] = React.useState(false);

  const categories = React.useMemo(() => {
    const all = [...budgetEntries, ...candidates, ...searchResults].map((entry) => entry.category.trim()).filter(Boolean);
    return Array.from(new Set(all)).sort((a, b) => a.localeCompare(b));
  }, [budgetEntries, candidates, searchResults]);

  const reloadMemory = React.useCallback(async () => {
    if (!memoryApi) {
      setBudgetEntries([]);
      setCandidates([]);
      setHealthStats(createEmptyMemoryHealthStats());
      setLoading(false);
      return;
    }
    try {
      const [budgetRaw, candidatesRaw, nextHealthStats] = await Promise.all([
        memoryApi.getBudget({ level: "deep" }),
        memoryApi.getCandidates({ limit: 25 }),
        memoryApi.getHealthStats?.() ?? Promise.resolve(createEmptyMemoryHealthStats()),
      ]);
      setBudgetEntries(toMemoryEntries(budgetRaw));
      setCandidates(toMemoryEntries(candidatesRaw));
      setHealthStats(nextHealthStats);
      if (!hasChosenSearchMode) {
        setSearchMode(areEmbeddingsReady(nextHealthStats) ? "hybrid" : "lexical");
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [hasChosenSearchMode, memoryApi]);

  const reloadDocs = React.useCallback(async () => {
    if (!showDocsSection) return;
    setDocsLoading(true);
    try {
      const status = await window.ade.context.getStatus();
      setDocsStatus(status);
    } catch {
      setDocsStatus(null);
    } finally {
      setDocsLoading(false);
    }
  }, [showDocsSection]);

  React.useEffect(() => {
    setLoading(true);
    setError(null);
    void reloadMemory();
  }, [reloadMemory]);

  React.useEffect(() => {
    if (!showDocsSection) return;
    void reloadDocs();
  }, [showDocsSection, reloadDocs]);

  const runSearch = React.useCallback(async () => {
    const query = searchInput.trim();
    if (!query || !memoryApi) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    try {
      const raw = await memoryApi.search({ query, limit: compact ? 12 : 40, mode: searchMode });
      setSearchResults(toMemoryEntries(raw));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  }, [compact, memoryApi, searchInput, searchMode]);

  const refreshAll = React.useCallback(() => {
    setRefreshing(true);
    void reloadMemory();
    if (showDocsSection) void reloadDocs();
  }, [reloadDocs, reloadMemory, showDocsSection]);

  const handlePromote = React.useCallback(async (id: string) => {
    if (!memoryApi) return;
    try {
      await memoryApi.promote({ id });
      void reloadMemory();
      if (searchInput.trim()) void runSearch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [memoryApi, reloadMemory, runSearch, searchInput]);

  const handleArchive = React.useCallback(async (id: string) => {
    if (!memoryApi) return;
    try {
      await memoryApi.archive({ id });
      setBudgetEntries((prev) => prev.filter((entry) => entry.id !== id));
      setCandidates((prev) => prev.filter((entry) => entry.id !== id));
      setSearchResults((prev) => prev.filter((entry) => entry.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [memoryApi]);

  const handlePin = React.useCallback(async (id: string) => {
    if (!memoryApi) return;
    try {
      await memoryApi.pin({ id });
      void reloadMemory();
      if (searchInput.trim()) void runSearch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [memoryApi, reloadMemory, runSearch, searchInput]);

  const activeEntries = (searchInput.trim().length > 0 ? searchResults : budgetEntries).filter((entry) =>
    memoryMatchesFilters(entry, scopeFilter, categoryFilter)
  );
  const candidateEntries = candidates.filter((entry) => memoryMatchesFilters(entry, scopeFilter, categoryFilter));
  const embeddingsReady = areEmbeddingsReady(healthStats);
  const showEmbeddedColumn = !compact;

  if (!memoryApi && !showDocsSection) {
    return <EmptyState title="Memory unavailable" description="Memory service is not enabled in this build." />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: compact ? 12 : 20, minHeight: 0 }}>
      <section>
        <div style={sectionLabelStyle}>{compact ? "LANE MEMORY" : "MEMORY INSPECTOR"}</div>
        <div
          style={{
            ...cardStyle({ padding: compact ? 12 : 16 }),
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textSecondary }}>
              {compact
                ? `Memory surface available while inspecting ${laneName ?? "selected lane"}`
                : "Unified memory surface (promoted + candidate entries)"}
            </div>
            <button type="button" style={outlineButton({ height: 28, padding: "0 10px", fontSize: 10 })} onClick={refreshAll}>
              {refreshing ? "Refreshing..." : "Refresh"}
            </button>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void runSearch();
                }
              }}
              placeholder={compact ? "Search memory..." : "Search project memory..."}
              style={{
                minWidth: compact ? 200 : 280,
                flex: 1,
                height: 32,
                border: `1px solid ${COLORS.outlineBorder}`,
                background: COLORS.recessedBg,
                color: COLORS.textPrimary,
                fontSize: 12,
                fontFamily: MONO_FONT,
                padding: "0 10px",
                outline: "none",
              }}
            />
            <button
              type="button"
              style={primaryButton({ height: 32, padding: "0 10px", fontSize: 10 })}
              disabled={searching || !searchInput.trim()}
              onClick={() => void runSearch()}
            >
              {searching ? "Searching..." : "Search"}
            </button>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                aria-pressed={searchMode === "lexical"}
                style={searchModeButtonStyle(searchMode === "lexical")}
                onClick={() => {
                  setHasChosenSearchMode(true);
                  setSearchMode("lexical");
                }}
              >
                Lexical only
              </button>
              <button
                type="button"
                aria-pressed={searchMode === "hybrid"}
                style={searchModeButtonStyle(searchMode === "hybrid")}
                onClick={() => {
                  setHasChosenSearchMode(true);
                  setSearchMode("hybrid");
                }}
              >
                Hybrid (recommended)
              </button>
            </div>
            <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: embeddingsReady ? COLORS.success : COLORS.textMuted }}>
              {embeddingsReady ? "Embeddings ready" : "Embeddings unavailable — lexical is the safe default"}
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <select
              value={scopeFilter}
              onChange={(event) => setScopeFilter(event.target.value as ScopeFilter)}
              style={{
                height: 28,
                border: `1px solid ${COLORS.outlineBorder}`,
                background: COLORS.recessedBg,
                color: COLORS.textPrimary,
                fontSize: 11,
                fontFamily: MONO_FONT,
                padding: "0 8px",
                minWidth: 120,
              }}
            >
              <option value="all">scope: all</option>
              <option value="project">scope: project</option>
              <option value="mission">scope: mission</option>
              <option value="agent">scope: agent</option>
            </select>
            <select
              value={categoryFilter}
              onChange={(event) => setCategoryFilter(event.target.value)}
              style={{
                height: 28,
                border: `1px solid ${COLORS.outlineBorder}`,
                background: COLORS.recessedBg,
                color: COLORS.textPrimary,
                fontSize: 11,
                fontFamily: MONO_FONT,
                padding: "0 8px",
                minWidth: 150,
              }}
            >
              <option value="all">category: all</option>
              {categories.map((category) => (
                <option key={category} value={category}>
                  category: {category}
                </option>
              ))}
            </select>
          </div>

          {loading ? (
            <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textMuted }}>Loading memory...</div>
          ) : activeEntries.length ? (
            compact ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 320, overflowY: "auto", paddingRight: 2 }}>
                {activeEntries.map((entry) => (
                  <div key={entry.id} style={{ border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg, padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <SmallBadge label={entry.scope} color={scopeBadgeColor(entry.scope)} />
                        <SmallBadge label={entry.status} color={statusBadgeColor(entry.status)} />
                        <SmallBadge label={entry.importance} color={importanceBadgeColor(entry.importance)} />
                        {entry.pinned ? <SmallBadge label="pinned" color={COLORS.success} /> : null}
                      </div>
                      <div style={{ display: "flex", gap: 6 }}>
                        {!entry.pinned ? (
                          <button
                            type="button"
                            style={primaryButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                            onClick={() => void handlePin(entry.id)}
                          >
                            Pin
                          </button>
                        ) : null}
                        <button
                          type="button"
                          style={outlineButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                          onClick={() => void handleArchive(entry.id)}
                        >
                          Archive
                        </button>
                      </div>
                    </div>
                    <div style={{ fontFamily: MONO_FONT, fontSize: 12, color: COLORS.textPrimary, whiteSpace: "pre-wrap", lineHeight: 1.45 }}>{entry.content}</div>
                    <div style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textMuted }}>
                      category: {entry.category} • tier: {entry.tier} • confidence: {entry.confidence.toFixed(2)} • accessed: {entry.accessCount} • updated {relativeTime(entry.lastAccessedAt || entry.createdAt)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ maxHeight: 420, overflowY: "auto", border: `1px solid ${COLORS.border}` }}>
                <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
                  <thead>
                    <tr style={{ background: COLORS.recessedBg }}>
                      <th scope="col" style={{ textAlign: "left", padding: "8px 10px", ...LABEL_STYLE, fontSize: 9 }}>Content</th>
                      <th scope="col" style={{ textAlign: "left", padding: "8px 10px", ...LABEL_STYLE, fontSize: 9 }}>Scope</th>
                      <th scope="col" style={{ textAlign: "left", padding: "8px 10px", ...LABEL_STYLE, fontSize: 9 }}>Status</th>
                      {showEmbeddedColumn ? <th scope="col" style={{ textAlign: "left", padding: "8px 10px", ...LABEL_STYLE, fontSize: 9 }}>Embedded</th> : null}
                      <th scope="col" style={{ textAlign: "left", padding: "8px 10px", ...LABEL_STYLE, fontSize: 9 }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeEntries.map((entry) => (
                      <tr key={entry.id} style={{ borderTop: `1px solid ${COLORS.border}`, background: COLORS.pageBg, verticalAlign: "top" }}>
                        <td style={{ padding: "10px", fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textPrimary }}>
                          <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.45 }}>{entry.content}</div>
                          <div style={{ marginTop: 6, fontSize: 10, color: COLORS.textMuted }}>
                            category: {entry.category} • tier: {entry.tier} • confidence: {entry.confidence.toFixed(2)} • updated {relativeTime(entry.lastAccessedAt || entry.createdAt)}
                          </div>
                        </td>
                        <td style={{ padding: "10px" }}><SmallBadge label={entry.scope} color={scopeBadgeColor(entry.scope)} /></td>
                        <td style={{ padding: "10px" }}>
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            <SmallBadge label={entry.status} color={statusBadgeColor(entry.status)} />
                            <SmallBadge label={entry.importance} color={importanceBadgeColor(entry.importance)} />
                            {entry.pinned ? <SmallBadge label="pinned" color={COLORS.success} /> : null}
                          </div>
                        </td>
                        {showEmbeddedColumn ? (
                          <td style={{ padding: "10px", fontFamily: MONO_FONT, fontSize: 14, color: entry.embedded ? COLORS.success : COLORS.textMuted }}>
                            {entry.embedded ? "✓" : "—"}
                          </td>
                        ) : null}
                        <td style={{ padding: "10px" }}>
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            {!entry.pinned ? (
                              <button
                                type="button"
                                style={primaryButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                                onClick={() => void handlePin(entry.id)}
                              >
                                Pin
                              </button>
                            ) : null}
                            <button
                              type="button"
                              style={outlineButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                              onClick={() => void handleArchive(entry.id)}
                            >
                              Archive
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : (
            <EmptyState
              title={searchInput.trim() ? "No memory matches" : "No promoted memory"}
              description={searchInput.trim() ? "Try a broader query or clear filters." : "Promoted entries will appear here once memory is captured."}
            />
          )}
        </div>
      </section>

      <section>
        <div style={sectionLabelStyle}>CANDIDATE QUEUE</div>
        <div style={{ ...cardStyle({ padding: compact ? 12 : 16 }), display: "flex", flexDirection: "column", gap: 8 }}>
          {candidateEntries.length ? (
            candidateEntries.map((entry) => (
              <div key={entry.id} style={{ border: `1px solid ${COLORS.border}`, padding: 10, background: COLORS.recessedBg, display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <SmallBadge label={entry.scope} color={scopeBadgeColor(entry.scope)} />
                    <SmallBadge label={entry.category} color={COLORS.textSecondary} />
                    <SmallBadge label={`conf ${entry.confidence.toFixed(2)}`} color={COLORS.warning} />
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button type="button" style={primaryButton({ height: 24, padding: "0 8px", fontSize: 10 })} onClick={() => void handlePromote(entry.id)}>
                      Promote
                    </button>
                    <button type="button" style={outlineButton({ height: 24, padding: "0 8px", fontSize: 10 })} onClick={() => void handleArchive(entry.id)}>
                      Archive
                    </button>
                  </div>
                </div>
                <div style={{ fontFamily: MONO_FONT, fontSize: 12, color: COLORS.textSecondary, whiteSpace: "pre-wrap", lineHeight: 1.4 }}>{entry.content}</div>
                <div style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim }}>created {relativeTime(entry.createdAt)}</div>
              </div>
            ))
          ) : (
            <EmptyState title="No candidates" description="Candidate memories promoted by workers will appear here for review." />
          )}
        </div>
      </section>

      {showDocsSection ? (
        <section>
          <div style={sectionLabelStyle}>CONTEXT DOCS</div>
          <div style={{ ...cardStyle({ padding: compact ? 12 : 16 }), display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textSecondary }}>
                Canonical docs remain the stable source for bootstrap and memory ingestion.
              </div>
              <button type="button" style={primaryButton({ height: 28, padding: "0 10px", fontSize: 10 })} onClick={() => setDocsModalOpen(true)}>
                Generate Docs
              </button>
            </div>
            {docsLoading ? (
              <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textMuted }}>Loading docs status...</div>
            ) : docsStatus?.docs?.length ? (
              docsStatus.docs.map((doc) => (
                <div key={doc.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg, padding: 10 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
                    <div style={{ fontFamily: MONO_FONT, fontSize: 12, color: COLORS.textPrimary }}>{doc.label}</div>
                    <div style={{ fontFamily: MONO_FONT, fontSize: 10, color: doc.exists ? COLORS.success : COLORS.warning }}>
                      {doc.exists ? `present • updated ${relativeTime(doc.updatedAt)}` : "missing"}
                    </div>
                    <div style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {doc.preferredPath}
                    </div>
                  </div>
                  <button
                    type="button"
                    style={outlineButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                    onClick={() => {
                      void window.ade.context.openDoc({ docId: doc.id }).catch(() => { });
                    }}
                  >
                    Open
                  </button>
                </div>
              ))
            ) : (
              <EmptyState title="Docs unavailable" description="Unable to read context doc status." />
            )}
          </div>
          <GenerateDocsModal
            open={docsModalOpen}
            onOpenChange={setDocsModalOpen}
            onCompleted={() => {
              void reloadDocs();
            }}
          />
        </section>
      ) : null}

      {error ? (
        <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.warning, border: `1px solid ${COLORS.warning}44`, background: `${COLORS.warning}16`, padding: 10 }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}

export function MemoryInspector() {
  return <MemoryInspectorPanel showDocsSection />;
}

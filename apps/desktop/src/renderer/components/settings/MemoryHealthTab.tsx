import React from "react";
import type {
  AiConfig,
  KnowledgeSyncStatus,
  MemoryHealthStats,
  MemorySearchMode,
  ProcedureDetail,
  ProcedureListItem,
  SkillIndexEntry,
} from "../../../shared/types";
import { deriveConfiguredModelOptions, includeSelectedModelOption } from "../../lib/modelOptions";
import { getModelById, resolveModelAlias } from "../../../shared/modelRegistry";
import { EmptyState } from "../ui/EmptyState";
import { MemoryInspectorPanel } from "./MemoryInspector";
import {
  COLORS,
  MONO_FONT,
  LABEL_STYLE,
  cardStyle,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";

/* ── Constants ── */

const DEFAULT_CONSOLIDATION_MODEL = "anthropic/claude-haiku-4-5";
const EMBEDDING_POLL_MS = 1500;
const CONTENT_TRUNCATE_LENGTH = 200;

const SECTION_LABEL_STYLE: React.CSSProperties = {
  ...LABEL_STYLE,
  fontSize: 11,
  marginBottom: 10,
};

const SELECT_STYLE: React.CSSProperties = {
  width: "100%",
  height: 32,
  padding: "0 8px",
  fontSize: 12,
  fontFamily: MONO_FONT,
  color: COLORS.textPrimary,
  background: COLORS.recessedBg,
  border: `1px solid ${COLORS.outlineBorder}`,
  borderRadius: 0,
  outline: "none",
  appearance: "none",
  WebkitAppearance: "none",
};

/* ── Memory entry types (from MemoryInspector) ── */

type MemoryScope = "agent" | "project" | "mission";
type MemoryStatus = "candidate" | "promoted" | "archived";
type MemoryImportance = "low" | "medium" | "high";
type ProcedureSort = "confidence" | "applications" | "sources" | "recent";
type SkillSort = "modified" | "path" | "source";

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

type ScopeFilter = "all" | MemoryScope;
type MemoryConsoleTab = "overview" | "browser" | "procedures" | "skills";

/* ── Empty default stats ── */

function createEmptyHealthStats(): MemoryHealthStats {
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

function createEmptyKnowledgeSyncStatus(): KnowledgeSyncStatus {
  return {
    syncing: false,
    lastSeenHeadSha: null,
    currentHeadSha: null,
    diverged: false,
    lastDigestAt: null,
    lastDigestMemoryId: null,
    lastError: null,
  };
}

/* ── Formatting helpers ── */

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "Never";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortSha(value: string | null | undefined): string {
  const text = String(value ?? "").trim();
  return text.length > 8 ? text.slice(0, 8) : text || "unknown";
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

function normalizeModelSetting(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw.length) return "";
  return getModelById(raw)?.id ?? resolveModelAlias(raw)?.id ?? raw;
}

function scopeLabel(scope: MemoryHealthStats["scopes"][number]["scope"]): string {
  if (scope === "project") return "Project";
  if (scope === "agent") return "Agent";
  return "Mission";
}

function clampPercent(current: number, max: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((current / max) * 100)));
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0%";
  if (value >= 1) return "100%";
  return `${Math.round(value * 100)}%`;
}

function getEmbeddingProgress(stats: MemoryHealthStats): number {
  return clampPercent(stats.embeddings.entriesEmbedded, Math.max(stats.embeddings.entriesTotal, 1));
}

function getModelDownloadProgress(stats: MemoryHealthStats): number {
  const { progress, loaded, total } = stats.embeddings.model;
  if (typeof progress === "number" && Number.isFinite(progress)) {
    return Math.max(0, Math.min(100, Math.round(progress)));
  }
  if (typeof loaded === "number" && typeof total === "number" && total > 0) {
    return clampPercent(loaded, total);
  }
  return 0;
}

function getModelLabel(stats: MemoryHealthStats): string {
  const modelId = stats.embeddings.model.modelId.split("/").pop() ?? stats.embeddings.model.modelId;
  if (stats.embeddings.model.state === "ready") return `${modelId} loaded`;
  if (stats.embeddings.model.state === "loading") return "Downloading...";
  return "Not downloaded";
}

function shouldPollEmbeddings(stats: MemoryHealthStats): boolean {
  if (stats.embeddings.model.state === "loading") return true;
  if (stats.embeddings.processing) return true;
  return stats.embeddings.entriesTotal > 0 && stats.embeddings.entriesEmbedded < stats.embeddings.entriesTotal;
}

function sweepSummary(stats: MemoryHealthStats): string {
  if (!stats.lastSweep) return "No sweeps yet";
  const lastSweep = stats.lastSweep;
  return [
    `Decayed ${formatNumber(lastSweep.entriesDecayed)}`,
    `Demoted ${formatNumber(lastSweep.entriesDemoted)}`,
    `Promoted ${formatNumber(lastSweep.entriesPromoted)}`,
    `Archived ${formatNumber(lastSweep.entriesArchived)}`,
    `Orphaned ${formatNumber(lastSweep.entriesOrphaned)}`,
  ].join(" \u00B7 ");
}

function consolidationSummary(stats: MemoryHealthStats): string {
  if (!stats.lastConsolidation) return "No consolidations yet";
  const lastConsolidation = stats.lastConsolidation;
  return [
    `Clusters ${formatNumber(lastConsolidation.clustersFound)}`,
    `Merged ${formatNumber(lastConsolidation.entriesMerged)}`,
    `Created ${formatNumber(lastConsolidation.entriesCreated)}`,
  ].join(" \u00B7 ");
}

function areEmbeddingsReady(stats: MemoryHealthStats): boolean {
  return stats.embeddings.model.state === "ready";
}

/* ── Memory entry normalizers ── */

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

/* ── Small UI components ── */

function InfoTip({ text }: { text: string }) {
  const [hovered, setHovered] = React.useState(false);
  return (
    <span
      title={text}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 14,
        height: 14,
        fontSize: 9,
        fontWeight: 700,
        fontFamily: MONO_FONT,
        color: hovered ? COLORS.accent : COLORS.textMuted,
        border: `1px solid ${hovered ? COLORS.accent : COLORS.border}`,
        borderRadius: "50%",
        cursor: "help",
        marginLeft: 4,
        flexShrink: 0,
        transition: "color 120ms ease, border-color 120ms ease",
      }}
    >
      ?
    </span>
  );
}

function CountStat({ label, value, tip }: { label: string; value: number; tip?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ ...LABEL_STYLE, fontSize: 9, display: "flex", alignItems: "center" }}>
        {label}
        {tip ? <InfoTip text={tip} /> : null}
      </span>
      <span style={{ fontSize: 16, fontFamily: MONO_FONT, color: COLORS.textPrimary }}>{formatNumber(value)}</span>
    </div>
  );
}

function scopeBadgeColor(scope: MemoryScope): string {
  switch (scope) {
    case "project": return COLORS.accent;
    case "mission": return COLORS.info;
    case "agent": return COLORS.warning;
    default: return COLORS.textMuted;
  }
}

function statusBadgeColor(status: MemoryStatus): string {
  switch (status) {
    case "promoted": return COLORS.success;
    case "candidate": return COLORS.warning;
    default: return COLORS.textDim;
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

function tabButtonStyle(active: boolean): React.CSSProperties {
  return active
    ? primaryButton({ height: 30, padding: "0 12px", fontSize: 10 })
    : outlineButton({ height: 30, padding: "0 12px", fontSize: 10 });
}

/* ── Tooltip text constants ── */

const TIPS = {
  tier1: "Tier 1 = pinned memories. Permanent, always included in context.",
  tier2: "Tier 2 = active memories. Recently used or high-value entries.",
  tier3: "Tier 3 = aging/cold memories. Infrequently accessed, candidates for archival.",
  archived: "Archived memories are hidden from search and context. They can be restored.",
  hardLimit: "Maximum number of active memories allowed. When full, the oldest Tier 3 entries are archived automatically during sweeps.",
  entriesEmbedded: "Memories indexed for smart search. Embeddings let search understand meaning, not just keywords.",
  embeddingModel: "A small local ML model that converts text into vectors for semantic search. Downloads once (~30 MB), runs entirely on your machine.",
  sweep: "Clean up old, low-value memories by decaying scores and archiving cold entries. Runs automatically once per day.",
  consolidation: "Merge similar or duplicate memories into single, cleaner entries using AI. Runs automatically once per week.",
  consolidationModel: "The AI model used to analyze and merge duplicate memories during consolidation.",
  cacheStats: "In-memory cache for embedding vectors. Avoids re-computing embeddings for recently seen content.",
  searchMode: "Lexical search matches exact keywords. Hybrid combines keyword matching with semantic similarity for better results.",
} as const;

/* ── Main component ── */

export function MemoryHealthTab() {
  const memoryApi = window.ade.memory;

  /* ── Health dashboard state ── */
  const [stats, setStats] = React.useState<MemoryHealthStats>(createEmptyHealthStats());
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [sweepRunning, setSweepRunning] = React.useState(false);
  const [consolidationRunning, setConsolidationRunning] = React.useState(false);
  const [modelSaving, setModelSaving] = React.useState(false);
  const [modelValue, setModelValue] = React.useState(DEFAULT_CONSOLIDATION_MODEL);
  const [modelOptions, setModelOptions] = React.useState<Array<{ id: string; label: string }>>([]);

  /* ── Memory browser state ── */
  const [budgetEntries, setBudgetEntries] = React.useState<MemoryEntry[]>([]);
  const [candidates, setCandidates] = React.useState<MemoryEntry[]>([]);
  const [searchInput, setSearchInput] = React.useState("");
  const [searchResults, setSearchResults] = React.useState<MemoryEntry[]>([]);
  const [searching, setSearching] = React.useState(false);
  const [scopeFilter, setScopeFilter] = React.useState<ScopeFilter>("all");
  const [categoryFilter, setCategoryFilter] = React.useState<string>("all");
  const [searchMode, setSearchMode] = React.useState<MemorySearchMode>("lexical");
  const [hasChosenSearchMode, setHasChosenSearchMode] = React.useState(false);

  /* ── UI state ── */
  const [activeTab, setActiveTab] = React.useState<MemoryConsoleTab>("overview");
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const [expandedEntryIds, setExpandedEntryIds] = React.useState<Set<string>>(new Set());
  const [procedures, setProcedures] = React.useState<ProcedureListItem[]>([]);
  const [selectedProcedureId, setSelectedProcedureId] = React.useState<string | null>(null);
  const [selectedProcedureDetail, setSelectedProcedureDetail] = React.useState<ProcedureDetail | null>(null);
  const [procedureDetailLoading, setProcedureDetailLoading] = React.useState(false);
  const [procedureSort, setProcedureSort] = React.useState<ProcedureSort>("confidence");
  const [skills, setSkills] = React.useState<SkillIndexEntry[]>([]);
  const [skillSort, setSkillSort] = React.useState<SkillSort>("modified");
  const [knowledgeSyncStatus, setKnowledgeSyncStatus] = React.useState<KnowledgeSyncStatus>(createEmptyKnowledgeSyncStatus());
  const [syncRunning, setSyncRunning] = React.useState(false);

  const categories = React.useMemo(() => {
    const all = [...budgetEntries, ...candidates, ...searchResults].map((e) => e.category.trim()).filter(Boolean);
    return Array.from(new Set(all)).sort((a, b) => a.localeCompare(b));
  }, [budgetEntries, candidates, searchResults]);

  const sortedProcedures = React.useMemo(() => {
    const next = [...procedures];
    next.sort((left, right) => {
      if (procedureSort === "applications") {
        const leftCount = left.procedural.successCount + left.procedural.failureCount;
        const rightCount = right.procedural.successCount + right.procedural.failureCount;
        return rightCount - leftCount;
      }
      if (procedureSort === "sources") {
        return right.procedural.sourceEpisodeIds.length - left.procedural.sourceEpisodeIds.length;
      }
      if (procedureSort === "recent") {
        return Date.parse(right.memory.updatedAt || right.memory.createdAt) - Date.parse(left.memory.updatedAt || left.memory.createdAt);
      }
      return right.procedural.confidence - left.procedural.confidence;
    });
    return next;
  }, [procedureSort, procedures]);

  const sortedSkills = React.useMemo(() => {
    const next = [...skills];
    next.sort((left, right) => {
      if (skillSort === "path") return left.path.localeCompare(right.path);
      if (skillSort === "source") return left.source.localeCompare(right.source) || left.kind.localeCompare(right.kind);
      return Date.parse(right.lastModifiedAt ?? right.updatedAt) - Date.parse(left.lastModifiedAt ?? left.updatedAt);
    });
    return next;
  }, [skillSort, skills]);

  /* ── Data loading ── */

  const loadDashboard = React.useCallback(async (opts?: { quiet?: boolean }) => {
    if (!memoryApi?.getHealthStats) {
      setLoadError("Memory is not available in this build.");
      setLoading(false);
      return;
    }

    if (!opts?.quiet) setLoading(true);

    try {
      const [nextStats, budgetRaw, candidatesRaw, aiStatus, snapshot, nextProcedures, nextSkills, nextKnowledgeSyncStatus] = await Promise.all([
        memoryApi.getHealthStats(),
        memoryApi.getBudget({ level: "deep" }),
        memoryApi.getCandidates({ limit: 25 }),
        window.ade.ai.getStatus(),
        window.ade.projectConfig.get(),
        memoryApi.listProcedures?.({ status: "all", scope: "project" }) ?? Promise.resolve([]),
        memoryApi.listIndexedSkills?.() ?? Promise.resolve([]),
        memoryApi.getKnowledgeSyncStatus?.() ?? Promise.resolve(createEmptyKnowledgeSyncStatus()),
      ]);

      const effectiveAiRaw = snapshot.effective?.ai;
      const effectiveAiConfig = effectiveAiRaw && typeof effectiveAiRaw === "object" ? (effectiveAiRaw as AiConfig) : null;
      const nextModelValue = normalizeModelSetting(effectiveAiConfig?.featureModelOverrides?.memory_consolidation)
        || DEFAULT_CONSOLIDATION_MODEL;
      let configuredModelOptions: Array<{ id: string; label: string }> = [{ id: nextModelValue, label: nextModelValue }];
      try {
        configuredModelOptions = includeSelectedModelOption(
          deriveConfiguredModelOptions(aiStatus),
          nextModelValue,
        ).map((entry) => ({ id: entry.id, label: entry.label }));
      } catch {
        configuredModelOptions = [{ id: nextModelValue, label: nextModelValue }];
      }

      setStats(nextStats);
      setBudgetEntries(toMemoryEntries(budgetRaw));
      setCandidates(toMemoryEntries(candidatesRaw));
      setProcedures(nextProcedures);
      if (selectedProcedureId && !nextProcedures.some((item) => item.memory.id === selectedProcedureId)) {
        setSelectedProcedureId(null);
        setSelectedProcedureDetail(null);
      }
      setSkills(nextSkills);
      setKnowledgeSyncStatus(nextKnowledgeSyncStatus);
      setModelOptions(configuredModelOptions);
      setModelValue(nextModelValue);
      setLoadError(null);

      if (!hasChosenSearchMode) {
        setSearchMode(areEmbeddingsReady(nextStats) ? "hybrid" : "lexical");
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [hasChosenSearchMode, memoryApi, selectedProcedureId]);

  React.useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  /* ── Embedding polling ── */

  React.useEffect(() => {
    if (!memoryApi?.getHealthStats || loadError || !shouldPollEmbeddings(stats)) return undefined;
    const timer = window.setTimeout(() => {
      void loadDashboard({ quiet: true });
    }, EMBEDDING_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [loadDashboard, loadError, memoryApi, stats]);

  /* ── Sweep / consolidation event listeners ── */

  React.useEffect(() => {
    if (!memoryApi) return undefined;

    const disposeSweep = memoryApi.onSweepStatus((event) => {
      if (event.type === "memory-sweep-started") {
        setSweepRunning(true);
        setActionError(null);
        return;
      }
      if (event.type === "memory-sweep-completed") {
        setSweepRunning(false);
        void loadDashboard();
        return;
      }
      setSweepRunning(false);
      setActionError(event.error);
      void loadDashboard();
    });

    const disposeConsolidation = memoryApi.onConsolidationStatus((event) => {
      if (event.type === "memory-consolidation-started") {
        setConsolidationRunning(true);
        setActionError(null);
        return;
      }
      if (event.type === "memory-consolidation-completed") {
        setConsolidationRunning(false);
        void loadDashboard();
        return;
      }
      setConsolidationRunning(false);
      setActionError(event.error);
      void loadDashboard();
    });

    return () => {
      disposeSweep();
      disposeConsolidation();
    };
  }, [loadDashboard, memoryApi]);

  /* ── Action handlers ── */

  const handleRunSweep = React.useCallback(async () => {
    if (!memoryApi?.runSweep || sweepRunning) return;
    setSweepRunning(true);
    setActionError(null);
    try {
      await memoryApi.runSweep();
      await loadDashboard();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setSweepRunning(false);
    }
  }, [loadDashboard, memoryApi, sweepRunning]);

  const handleRunConsolidation = React.useCallback(async () => {
    if (!memoryApi?.runConsolidation || consolidationRunning) return;
    setConsolidationRunning(true);
    setActionError(null);
    try {
      await memoryApi.runConsolidation();
      await loadDashboard();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setConsolidationRunning(false);
    }
  }, [consolidationRunning, loadDashboard, memoryApi]);

  const handleModelChange = React.useCallback(async (nextValue: string) => {
    const previousValue = modelValue;
    setModelValue(nextValue);
    setModelSaving(true);
    setActionError(null);
    try {
      await window.ade.ai.updateConfig({
        featureModelOverrides: { memory_consolidation: nextValue } as AiConfig["featureModelOverrides"],
      });
    } catch (error) {
      setModelValue(previousValue);
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setModelSaving(false);
    }
  }, [modelValue]);

  const handleDownloadModel = React.useCallback(async () => {
    if (!memoryApi?.downloadEmbeddingModel || stats.embeddings.model.state === "loading") return;
    setActionError(null);
    try {
      const nextStats = await memoryApi.downloadEmbeddingModel();
      setStats(nextStats);
      setLoadError(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [memoryApi, stats.embeddings.model.state]);

  const handleSyncKnowledge = React.useCallback(async () => {
    if (!memoryApi?.syncKnowledge || syncRunning) return;
    setSyncRunning(true);
    setActionError(null);
    try {
      await memoryApi.syncKnowledge();
      await loadDashboard({ quiet: true });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setSyncRunning(false);
    }
  }, [loadDashboard, memoryApi, syncRunning]);

  const handleExportProcedureSkill = React.useCallback(async (id: string) => {
    if (!memoryApi?.exportProcedureSkill) return;
    setActionError(null);
    try {
      await memoryApi.exportProcedureSkill({ id });
      await loadDashboard({ quiet: true });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [loadDashboard, memoryApi]);

  const handleReindexSkills = React.useCallback(async (paths?: string[]) => {
    if (!memoryApi?.reindexSkills) return;
    setActionError(null);
    try {
      await memoryApi.reindexSkills(paths && paths.length > 0 ? { paths } : {});
      await loadDashboard({ quiet: true });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [loadDashboard, memoryApi]);

  const handleOpenProcedure = React.useCallback(async (id: string) => {
    if (!memoryApi?.getProcedureDetail) return;
    setSelectedProcedureId(id);
    setProcedureDetailLoading(true);
    try {
      const detail = await memoryApi.getProcedureDetail({ id });
      setSelectedProcedureDetail(detail);
      setActionError(null);
    } catch (error) {
      setSelectedProcedureDetail(null);
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setProcedureDetailLoading(false);
    }
  }, [memoryApi]);

  React.useEffect(() => {
    if (activeTab !== "procedures") return;
    if (selectedProcedureId || sortedProcedures.length === 0) return;
    void handleOpenProcedure(sortedProcedures[0].memory.id);
  }, [activeTab, handleOpenProcedure, selectedProcedureId, sortedProcedures]);

  const runSearch = React.useCallback(async () => {
    const query = searchInput.trim();
    if (!query || !memoryApi) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    try {
      const raw = await memoryApi.search({ query, limit: 40, mode: searchMode });
      setSearchResults(toMemoryEntries(raw));
      setActionError(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  }, [memoryApi, searchInput, searchMode]);

  const handlePin = React.useCallback(async (id: string) => {
    if (!memoryApi) return;
    try {
      await memoryApi.pin({ id });
      void loadDashboard({ quiet: true });
      if (searchInput.trim()) void runSearch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }, [loadDashboard, memoryApi, runSearch, searchInput]);

  const handleArchive = React.useCallback(async (id: string) => {
    if (!memoryApi) return;
    try {
      await memoryApi.archive({ id });
      setBudgetEntries((prev) => prev.filter((e) => e.id !== id));
      setCandidates((prev) => prev.filter((e) => e.id !== id));
      setSearchResults((prev) => prev.filter((e) => e.id !== id));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }, [memoryApi]);

  const handlePromote = React.useCallback(async (id: string) => {
    if (!memoryApi) return;
    try {
      await memoryApi.promote({ id });
      void loadDashboard({ quiet: true });
      if (searchInput.trim()) void runSearch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }, [loadDashboard, memoryApi, runSearch, searchInput]);

  const toggleExpanded = React.useCallback((id: string) => {
    setExpandedEntryIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /* ── Derived values ── */

  const embeddingProgress = getEmbeddingProgress(stats);
  const modelDownloadProgress = getModelDownloadProgress(stats);
  const modelLabel = getModelLabel(stats);
  const showDownloadButton = stats.embeddings.model.state !== "loading" && stats.embeddings.model.state !== "ready";
  const embeddingsReady = areEmbeddingsReady(stats);

  const activeEntries = (searchInput.trim().length > 0 ? searchResults : budgetEntries).filter((entry) =>
    memoryMatchesFilters(entry, scopeFilter, categoryFilter),
  );
  const candidateEntries = candidates.filter((entry) => memoryMatchesFilters(entry, scopeFilter, categoryFilter));

  /* ── Render helper: truncatable content ── */

  function renderContent(entry: MemoryEntry) {
    const isLong = entry.content.length > CONTENT_TRUNCATE_LENGTH;
    const isExpanded = expandedEntryIds.has(entry.id);
    const displayContent = isLong && !isExpanded
      ? entry.content.slice(0, CONTENT_TRUNCATE_LENGTH) + "\u2026"
      : entry.content;

    return (
      <div>
        <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textPrimary, whiteSpace: "pre-wrap", lineHeight: 1.45 }}>
          {displayContent}
        </div>
        {isLong ? (
          <button
            type="button"
            onClick={() => toggleExpanded(entry.id)}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              marginTop: 4,
              fontSize: 10,
              fontFamily: MONO_FONT,
              color: COLORS.accent,
              cursor: "pointer",
              textDecoration: "underline",
            }}
          >
            {isExpanded ? "Show less" : "Show more"}
          </button>
        ) : null}
      </div>
    );
  }

  /* ── Render helper: memory entry card ── */

  function renderEntryCard(entry: MemoryEntry, actions: React.ReactNode) {
    const accentColor = scopeBadgeColor(entry.scope);
    return (
      <div
        key={entry.id}
        style={{
          border: `1px solid ${COLORS.border}`,
          borderLeft: `3px solid ${accentColor}`,
          background: COLORS.recessedBg,
          padding: "10px 10px 10px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          transition: "border-color 120ms ease",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <SmallBadge label={entry.scope} color={scopeBadgeColor(entry.scope)} />
            <SmallBadge label={entry.importance} color={importanceBadgeColor(entry.importance)} />
            {entry.pinned ? <SmallBadge label="pinned" color={COLORS.success} /> : null}
            {entry.embedded ? <SmallBadge label="indexed" color={COLORS.info} /> : null}
          </div>
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            {actions}
          </div>
        </div>
        {renderContent(entry)}
        <div style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textMuted }}>
          {entry.category} \u00B7 tier {entry.tier} \u00B7 accessed {entry.accessCount}x \u00B7 {relativeTime(entry.lastAccessedAt || entry.createdAt)}
        </div>
      </div>
    );
  }

  function renderProcedureList() {
    if (procedures.length === 0) {
      return (
        <EmptyState
          title="No procedures yet"
          description="Episode-backed procedures and imported skills will show up here once ADE learns repeatable workflows."
        />
      );
    }
    return (
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.2fr) minmax(280px, 0.8fr)", gap: 12, alignItems: "start" }}>
        <div style={{ display: "grid", gap: 10 }}>
          <div style={cardStyle({ padding: 12, display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" })}>
            <div style={{ fontSize: 10, color: COLORS.textMuted, fontFamily: MONO_FONT }}>
              {sortedProcedures.length} procedure{sortedProcedures.length === 1 ? "" : "s"}
            </div>
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 10, color: COLORS.textMuted, fontFamily: MONO_FONT }}>
              sort
              <select value={procedureSort} onChange={(event) => setProcedureSort(event.target.value as ProcedureSort)} style={{ ...SELECT_STYLE, width: 150, height: 28, fontSize: 10 }}>
                <option value="confidence">confidence</option>
                <option value="applications">applications</option>
                <option value="sources">source episodes</option>
                <option value="recent">recently updated</option>
              </select>
            </label>
          </div>
          {sortedProcedures.map((item) => {
            const applications = item.procedural.successCount + item.procedural.failureCount;
            const selected = selectedProcedureId === item.memory.id;
            return (
              <div key={item.memory.id} style={cardStyle({ padding: 14, display: "flex", flexDirection: "column", gap: 8, border: `1px solid ${selected ? COLORS.accent : COLORS.border}` })}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
                  <div>
                    <div style={{ fontSize: 13, color: COLORS.textPrimary, fontFamily: MONO_FONT }}>{item.procedural.trigger}</div>
                    <div style={{ fontSize: 10, color: COLORS.textMuted, fontFamily: MONO_FONT, marginTop: 4 }}>
                      confidence {Math.round(item.procedural.confidence * 100)}% · {applications} application{applications === 1 ? "" : "s"} · {item.memory.status}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    <button type="button" style={outlineButton({ height: 28, padding: "0 10px", fontSize: 10 })} onClick={() => void handleOpenProcedure(item.memory.id)}>
                      DETAILS
                    </button>
                    {item.memory.status === "candidate" ? (
                      <button type="button" style={outlineButton({ height: 28, padding: "0 10px", fontSize: 10 })} onClick={() => void handlePromote(item.memory.id)}>
                        PROMOTE
                      </button>
                    ) : null}
                    <button type="button" style={outlineButton({ height: 28, padding: "0 10px", fontSize: 10 })} onClick={() => void handleExportProcedureSkill(item.memory.id)}>
                      EXPORT
                    </button>
                    <button type="button" style={outlineButton({ height: 28, padding: "0 10px", fontSize: 10 })} onClick={() => void handleArchive(item.memory.id)}>
                      ARCHIVE
                    </button>
                  </div>
                </div>
                <div style={{ fontSize: 11, color: COLORS.textSecondary, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
                  {item.procedural.procedure}
                </div>
                <div style={{ fontSize: 10, color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                  success {item.procedural.successCount} · failure {item.procedural.failureCount} · sources {item.procedural.sourceEpisodeIds.length}
                  {item.exportedSkillPath ? ` · exported ${item.exportedSkillPath}` : ""}
                </div>
              </div>
            );
          })}
        </div>

        <div style={cardStyle({ padding: 14, display: "flex", flexDirection: "column", gap: 10, position: "sticky", top: 0 })}>
          <div style={SECTION_LABEL_STYLE}>PROCEDURE DETAIL</div>
          {procedureDetailLoading ? (
            <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted }}>Loading procedure detail...</div>
          ) : selectedProcedureDetail ? (
            <>
              <div>
                <div style={{ fontSize: 12, color: COLORS.textPrimary, fontFamily: MONO_FONT }}>{selectedProcedureDetail.procedural.trigger}</div>
                <div style={{ fontSize: 10, color: COLORS.textMuted, fontFamily: MONO_FONT, marginTop: 4 }}>
                  confidence {Math.round(selectedProcedureDetail.procedural.confidence * 100)}% · last used {formatTimestamp(selectedProcedureDetail.procedural.lastUsed)}
                </div>
              </div>
              <div style={{ fontSize: 11, color: COLORS.textSecondary, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
                {selectedProcedureDetail.procedural.procedure}
              </div>
              <div>
                <div style={SECTION_LABEL_STYLE}>SOURCE EPISODES</div>
                {selectedProcedureDetail.sourceEpisodes.length > 0 ? (
                  <div style={{ display: "grid", gap: 8 }}>
                    {selectedProcedureDetail.sourceEpisodes.map((episode) => (
                      <div key={episode.id} style={{ border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg, padding: 10 }}>
                        <div style={{ fontSize: 10, color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                          {formatTimestamp(episode.createdAt)} · {episode.sourceId ?? episode.id}
                        </div>
                        <div style={{ fontSize: 11, color: COLORS.textSecondary, whiteSpace: "pre-wrap", lineHeight: 1.45, marginTop: 4 }}>
                          {episode.content}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: 11, color: COLORS.textMuted }}>No source episodes linked yet.</div>
                )}
              </div>
              <div>
                <div style={SECTION_LABEL_STYLE}>CONFIDENCE HISTORY</div>
                {selectedProcedureDetail.confidenceHistory.length > 0 ? (
                  <div style={{ display: "grid", gap: 6 }}>
                    {selectedProcedureDetail.confidenceHistory.map((entry) => (
                      <div key={entry.id} style={{ border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg, padding: 8 }}>
                        <div style={{ fontSize: 10, color: COLORS.textPrimary, fontFamily: MONO_FONT }}>
                          {entry.outcome} · {Math.round(entry.confidence * 100)}%
                        </div>
                        <div style={{ fontSize: 10, color: COLORS.textMuted, fontFamily: MONO_FONT, marginTop: 2 }}>
                          {formatTimestamp(entry.recordedAt)}
                          {entry.reason ? ` · ${entry.reason}` : ""}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: 11, color: COLORS.textMuted }}>No confidence history recorded yet.</div>
                )}
              </div>
            </>
          ) : (
            <div style={{ fontSize: 11, color: COLORS.textMuted }}>
              Select a procedure to inspect its learned steps, source episodes, and confidence history.
            </div>
          )}
        </div>
      </div>
    );
  }

  function renderSkillList() {
    if (skills.length === 0) {
      return (
        <EmptyState
          title="No indexed skills"
          description="User-authored skill files and exported procedures will appear here after the registry scans the project."
        />
      );
    }
    return (
      <div style={{ display: "grid", gap: 10 }}>
        <div style={cardStyle({ padding: 12, display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" })}>
          <div style={{ fontSize: 10, color: COLORS.textMuted, fontFamily: MONO_FONT }}>
            {sortedSkills.length} indexed skill{sortedSkills.length === 1 ? "" : "s"}
          </div>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 10, color: COLORS.textMuted, fontFamily: MONO_FONT }}>
            sort
            <select value={skillSort} onChange={(event) => setSkillSort(event.target.value as SkillSort)} style={{ ...SELECT_STYLE, width: 150, height: 28, fontSize: 10 }}>
              <option value="modified">recently modified</option>
              <option value="path">path</option>
              <option value="source">source</option>
            </select>
          </label>
        </div>
        {sortedSkills.map((item) => (
          <div key={item.id} style={cardStyle({ padding: 14, display: "flex", flexDirection: "column", gap: 8 })}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
              <div>
                <div style={{ fontSize: 13, color: COLORS.textPrimary, fontFamily: MONO_FONT }}>{item.path}</div>
                <div style={{ fontSize: 10, color: COLORS.textMuted, fontFamily: MONO_FONT, marginTop: 4 }}>
                  {item.kind} · {item.source} · {item.archivedAt ? "archived" : "active"}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button type="button" style={outlineButton({ height: 28, padding: "0 10px", fontSize: 10 })} onClick={() => void window.ade.app.revealPath(item.path)}>
                  REVEAL
                </button>
                <button type="button" style={outlineButton({ height: 28, padding: "0 10px", fontSize: 10 })} onClick={() => void handleReindexSkills([item.path])}>
                  REINDEX
                </button>
              </div>
            </div>
            <div style={{ fontSize: 10, color: COLORS.textMuted, fontFamily: MONO_FONT }}>
              modified {formatTimestamp(item.lastModifiedAt)} · hash {item.contentHash.slice(0, 8)}
            </div>
          </div>
        ))}
      </div>
    );
  }

  /* ── Main render ── */

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 980 }}>
      {/* Header */}
      <div style={{ borderLeft: `3px solid ${COLORS.accent}`, paddingLeft: 12 }}>
        <h2 style={{ margin: 0, fontSize: 20, color: COLORS.textPrimary, fontFamily: MONO_FONT, fontWeight: 700, letterSpacing: "-0.02em" }}>Memory</h2>
        <p style={{ marginTop: 6, marginBottom: 0, fontSize: 12, color: COLORS.textMuted, fontFamily: MONO_FONT, lineHeight: 1.5 }}>
          ADE remembers facts, preferences, and patterns across sessions. Browse, search, and manage your project's memory below.
        </p>
      </div>

      <section style={cardStyle({ padding: 16, display: "flex", flexDirection: "column", gap: 14 })}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={SECTION_LABEL_STYLE}>KNOWLEDGE SYNC</div>
            <div style={{ fontSize: 12, fontFamily: MONO_FONT, color: COLORS.textPrimary }}>
              {knowledgeSyncStatus.syncing
                ? "Digesting recent human work..."
                : knowledgeSyncStatus.diverged
                  ? "Project knowledge is behind HEAD"
                  : "Project knowledge is up to date"}
            </div>
            <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.6 }}>
              {`HEAD ${shortSha(knowledgeSyncStatus.currentHeadSha)} · last digested ${shortSha(knowledgeSyncStatus.lastSeenHeadSha)} · updated ${formatTimestamp(knowledgeSyncStatus.lastDigestAt)}`}
            </div>
            {knowledgeSyncStatus.lastError ? (
              <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.warning }}>
                {knowledgeSyncStatus.lastError}
              </div>
            ) : null}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              style={tabButtonStyle(activeTab === "overview")}
              onClick={() => setActiveTab("overview")}
            >
              Overview
            </button>
            <button
              type="button"
              style={tabButtonStyle(activeTab === "browser")}
              onClick={() => setActiveTab("browser")}
            >
              Browser
            </button>
            <button
              type="button"
              style={tabButtonStyle(activeTab === "procedures")}
              onClick={() => setActiveTab("procedures")}
            >
              Procedures
            </button>
            <button
              type="button"
              style={tabButtonStyle(activeTab === "skills")}
              onClick={() => setActiveTab("skills")}
            >
              Skills
            </button>
            <button
              type="button"
              style={outlineButton({ height: 30, padding: "0 12px", fontSize: 10 })}
              onClick={() => void handleSyncKnowledge()}
              disabled={syncRunning || knowledgeSyncStatus.syncing}
            >
              {syncRunning || knowledgeSyncStatus.syncing ? "Syncing..." : "Sync Knowledge"}
            </button>
          </div>
        </div>
      </section>

      {/* Error banners */}
      {loadError ? (
        <div role="alert" style={{ padding: "8px 12px", fontSize: 11, fontFamily: MONO_FONT, color: COLORS.warning, background: `${COLORS.warning}12`, border: `1px solid ${COLORS.warning}30` }}>
          {loadError}
        </div>
      ) : null}

      {actionError ? (
        <div role="alert" style={{ padding: "8px 12px", fontSize: 11, fontFamily: MONO_FONT, color: COLORS.danger, background: `${COLORS.danger}12`, border: `1px solid ${COLORS.danger}30` }}>
          {actionError}
        </div>
      ) : null}

      {loading ? (
        <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted }}>Loading memory...</div>
      ) : null}

      {activeTab === "browser" ? (
        <MemoryInspectorPanel showDocsSection={false} />
      ) : null}

      {activeTab === "procedures" ? renderProcedureList() : null}

      {activeTab === "skills" ? renderSkillList() : null}

      {activeTab === "overview" ? (
        <>
      {/* ── Health summary ── */}
      <section style={cardStyle({ padding: 16, display: "flex", flexDirection: "column", gap: 14 })}>
        <div style={SECTION_LABEL_STYLE}>
          STORAGE USAGE
          <InfoTip text={TIPS.hardLimit} />
        </div>
        {stats.scopes.map((scope) => {
          const label = scopeLabel(scope.scope);
          const percent = clampPercent(scope.current, scope.max);
          return (
            <div key={scope.scope} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textSecondary }}>
                <span>
                  {`${label}: ${formatNumber(scope.current)} / ${formatNumber(scope.max)}`}
                  <InfoTip text={`${label} memory pool. ${scope.current >= scope.max ? "Pool is full \u2014 new memories will replace the oldest Tier 3 entries." : `${formatNumber(scope.max - scope.current)} slots remaining.`}`} />
                </span>
                <span>{percent}%</span>
              </div>
              <div
                role="progressbar"
                aria-label={`${label} storage usage`}
                aria-valuemin={0}
                aria-valuemax={scope.max}
                aria-valuenow={scope.current}
                style={{ height: 10, background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, overflow: "hidden" }}
              >
                <div style={{ width: `${percent}%`, height: "100%", background: percent >= 80 ? COLORS.warning : COLORS.accent, transition: "width 180ms ease" }} />
              </div>
              <div style={{ display: "flex", gap: 12, fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>
                <span title={TIPS.tier1}>T1: {formatNumber(scope.counts.tier1)}</span>
                <span title={TIPS.tier2}>T2: {formatNumber(scope.counts.tier2)}</span>
                <span title={TIPS.tier3}>T3: {formatNumber(scope.counts.tier3)}</span>
                <span title={TIPS.archived}>Archived: {formatNumber(scope.counts.archived)}</span>
              </div>
            </div>
          );
        })}
      </section>

      {/* ── Embeddings / Smart Search ── */}
      <section style={cardStyle({ padding: 16, display: "flex", flexDirection: "column", gap: 12 })}>
        <div style={SECTION_LABEL_STYLE}>
          SMART SEARCH
          <InfoTip text={TIPS.entriesEmbedded} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
          {/* Embedding progress */}
          <div style={{ border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg, padding: 12, display: "grid", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
              <div style={{ fontSize: 12, fontFamily: MONO_FONT, color: COLORS.textPrimary, fontWeight: 700 }}>
                {`${formatNumber(stats.embeddings.entriesEmbedded)} / ${formatNumber(stats.embeddings.entriesTotal)} indexed`}
                <InfoTip text="Memories that have been converted to vectors for semantic search. Once indexed, memories are searchable by meaning." />
              </div>
              <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textSecondary }}>{embeddingProgress}%</div>
            </div>
            <div
              role="progressbar"
              aria-label="Embedding backfill progress"
              aria-valuemin={0}
              aria-valuemax={Math.max(stats.embeddings.entriesTotal, 1)}
              aria-valuenow={stats.embeddings.entriesEmbedded}
              style={{ height: 10, background: COLORS.pageBg, border: `1px solid ${COLORS.border}`, overflow: "hidden" }}
            >
              <div style={{ width: `${embeddingProgress}%`, height: "100%", background: COLORS.success, transition: "width 180ms ease" }} />
            </div>
            <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>
              {stats.embeddings.processing ? `Indexing in progress \u00B7 ${formatNumber(stats.embeddings.queueDepth)} queued` : "Indexing idle"}
            </div>
          </div>

          {/* Model status */}
          <div style={{ border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg, padding: 12, display: "grid", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 12, fontFamily: MONO_FONT, color: COLORS.textPrimary, fontWeight: 700 }}>
                  {modelLabel}
                  <InfoTip text={TIPS.embeddingModel} />
                </div>
                <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, marginTop: 4 }}>
                  {stats.embeddings.model.file ?? stats.embeddings.model.modelId}
                </div>
              </div>
              {showDownloadButton ? (
                <button
                  type="button"
                  onClick={() => void handleDownloadModel()}
                  title="Download the embedding model (~30 MB) to enable smart search. Runs locally on your machine."
                  style={primaryButton({ height: 30, padding: "0 12px", fontSize: 10 })}
                >
                  Download Model
                </button>
              ) : null}
            </div>

            {stats.embeddings.model.state === "loading" ? (
              <>
                <div
                  role="progressbar"
                  aria-label="Embedding model download progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={modelDownloadProgress}
                  style={{ height: 10, background: COLORS.pageBg, border: `1px solid ${COLORS.border}`, overflow: "hidden" }}
                >
                  <div style={{ width: `${modelDownloadProgress}%`, height: "100%", background: COLORS.info, transition: "width 180ms ease" }} />
                </div>
                <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textSecondary }}>
                  {`${modelDownloadProgress}%${stats.embeddings.model.loaded != null && stats.embeddings.model.total != null ? ` \u00B7 ${formatNumber(stats.embeddings.model.loaded)} / ${formatNumber(stats.embeddings.model.total)}` : ""}`}
                </div>
              </>
            ) : stats.embeddings.model.error ? (
              <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.warning }}>{stats.embeddings.model.error}</div>
            ) : null}
          </div>
        </div>
      </section>

      {/* ── Memory browser ── */}
      <section style={cardStyle({ padding: 16, display: "flex", flexDirection: "column", gap: 10 })}>
        <div style={SECTION_LABEL_STYLE}>MEMORY BROWSER</div>

        {/* Search bar */}
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
            placeholder="Search memories..."
            style={{
              minWidth: 280,
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
          <button
            type="button"
            style={outlineButton({ height: 32, padding: "0 10px", fontSize: 10 })}
            onClick={() => void loadDashboard()}
          >
            Refresh
          </button>
        </div>

        {/* Filters */}
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
          <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: embeddingsReady ? COLORS.success : COLORS.textMuted, display: "flex", alignItems: "center" }}>
            {embeddingsReady ? "Smart search active" : "Smart search unavailable \u2014 download model above to enable"}
          </div>
        </div>

        {/* Entry list */}
        {!loading && activeEntries.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 420, overflowY: "auto", paddingRight: 2 }}>
            {activeEntries.map((entry) =>
              renderEntryCard(
                entry,
                <>
                  {!entry.pinned ? (
                    <button
                      type="button"
                      title="Pin this memory so it's always included in context"
                      style={primaryButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                      onClick={() => void handlePin(entry.id)}
                    >
                      Pin
                    </button>
                  ) : null}
                  <button
                    type="button"
                    title="Archive this memory (hide from search and context)"
                    style={outlineButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                    onClick={() => void handleArchive(entry.id)}
                  >
                    Archive
                  </button>
                </>,
              ),
            )}
          </div>
        ) : !loading ? (
          <EmptyState
            title={searchInput.trim() ? "No matches" : "No memories yet"}
            description={searchInput.trim() ? "Try a broader query or clear filters." : "Memories will appear here as ADE learns about your project."}
          />
        ) : null}
      </section>

      {/* ── Candidate queue ── */}
      {candidateEntries.length > 0 ? (
        <section style={cardStyle({ padding: 16, display: "flex", flexDirection: "column", gap: 8 })}>
          <div style={SECTION_LABEL_STYLE}>
            CANDIDATE QUEUE
            <InfoTip text="Newly captured memories waiting for review. Promote to keep, or archive to discard." />
          </div>
          {candidateEntries.map((entry) =>
            renderEntryCard(
              entry,
              <>
                <button
                  type="button"
                  title="Promote this candidate to active memory"
                  style={primaryButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                  onClick={() => void handlePromote(entry.id)}
                >
                  Promote
                </button>
                <button
                  type="button"
                  title="Archive this memory (hide from search and context)"
                  style={outlineButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                  onClick={() => void handleArchive(entry.id)}
                >
                  Archive
                </button>
              </>,
            ),
          )}
        </section>
      ) : null}

      {/* ── Advanced section (collapsed by default) ── */}
      <section style={cardStyle({ padding: 0, overflow: "hidden" })}>
        <button
          type="button"
          onClick={() => setAdvancedOpen((prev) => !prev)}
          style={{
            display: "flex",
            width: "100%",
            alignItems: "center",
            gap: 8,
            padding: "12px 16px",
            background: "none",
            border: "none",
            cursor: "pointer",
            fontFamily: MONO_FONT,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "1px",
            textTransform: "uppercase",
            color: COLORS.textSecondary,
          }}
        >
          <span style={{ fontSize: 10, transition: "transform 150ms ease", transform: advancedOpen ? "rotate(90deg)" : "rotate(0)" }}>{"\u25B6"}</span>
          Advanced
        </button>

        {advancedOpen ? (
          <div style={{ padding: "0 16px 16px", display: "flex", flexDirection: "column", gap: 16 }}>
            {/* Search mode toggle */}
            <div>
              <div style={{ ...SECTION_LABEL_STYLE, marginBottom: 8 }}>
                SEARCH MODE
                <InfoTip text={TIPS.searchMode} />
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  aria-pressed={searchMode === "lexical"}
                  style={searchMode === "lexical"
                    ? primaryButton({ height: 28, padding: "0 10px", fontSize: 10 })
                    : outlineButton({ height: 28, padding: "0 10px", fontSize: 10 })}
                  onClick={() => { setHasChosenSearchMode(true); setSearchMode("lexical"); }}
                >
                  Lexical (keyword)
                </button>
                <button
                  type="button"
                  aria-pressed={searchMode === "hybrid"}
                  style={searchMode === "hybrid"
                    ? primaryButton({ height: 28, padding: "0 10px", fontSize: 10 })
                    : outlineButton({ height: 28, padding: "0 10px", fontSize: 10 })}
                  onClick={() => { setHasChosenSearchMode(true); setSearchMode("hybrid"); }}
                >
                  Hybrid (recommended)
                </button>
              </div>
            </div>

            {/* Maintenance */}
            <div>
              <div style={SECTION_LABEL_STYLE}>MAINTENANCE</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12, marginBottom: 12 }}>
                <div style={{ border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg, padding: 12, display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textPrimary, fontWeight: 700 }}>
                    Last Sweep
                    <InfoTip text={TIPS.sweep} />
                  </div>
                  <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textSecondary }}>
                    {stats.lastSweep ? formatTimestamp(stats.lastSweep.completedAt) : "Never"}
                  </div>
                  <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.6 }}>
                    {sweepSummary(stats)}
                  </div>
                </div>
                <div style={{ border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg, padding: 12, display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textPrimary, fontWeight: 700 }}>
                    Last Consolidation
                    <InfoTip text={TIPS.consolidation} />
                  </div>
                  <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textSecondary }}>
                    {stats.lastConsolidation ? formatTimestamp(stats.lastConsolidation.completedAt) : "Never"}
                  </div>
                  <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.6 }}>
                    {consolidationSummary(stats)}
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={() => void handleRunSweep()}
                  disabled={sweepRunning}
                  title={TIPS.sweep}
                  style={{ ...primaryButton(), opacity: sweepRunning ? 0.7 : 1, cursor: sweepRunning ? "not-allowed" : "pointer" }}
                >
                  {sweepRunning ? "Running Sweep..." : "Run Sweep Now"}
                </button>
                <button
                  type="button"
                  onClick={() => void handleRunConsolidation()}
                  disabled={consolidationRunning}
                  title={TIPS.consolidation}
                  style={{ ...outlineButton(), opacity: consolidationRunning ? 0.7 : 1, cursor: consolidationRunning ? "not-allowed" : "pointer" }}
                >
                  {consolidationRunning ? "Running Consolidation..." : "Run Consolidation Now"}
                </button>
              </div>
            </div>

            {/* Consolidation model */}
            <div>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={LABEL_STYLE}>
                  Consolidation model
                  <InfoTip text={TIPS.consolidationModel} />
                </span>
                <select
                  aria-label="Consolidation model"
                  value={modelValue}
                  onChange={(event) => void handleModelChange(event.target.value)}
                  disabled={modelSaving}
                  style={{ ...SELECT_STYLE, opacity: modelSaving ? 0.65 : 1 }}
                >
                  {(modelOptions.length > 0 ? modelOptions : [{ id: DEFAULT_CONSOLIDATION_MODEL, label: DEFAULT_CONSOLIDATION_MODEL }]).map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {/* Cache stats */}
            <div>
              <div style={SECTION_LABEL_STYLE}>
                EMBEDDING CACHE
                <InfoTip text={TIPS.cacheStats} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
                <div style={{ border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg, padding: 12, display: "grid", gap: 4 }}>
                  <span style={{ ...LABEL_STYLE, fontSize: 9 }}>Cache size</span>
                  <span style={{ fontSize: 16, fontFamily: MONO_FONT, color: COLORS.textPrimary }}>{formatNumber(stats.embeddings.cacheEntries)}</span>
                </div>
                <div style={{ border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg, padding: 12, display: "grid", gap: 4 }}>
                  <span style={{ ...LABEL_STYLE, fontSize: 9 }}>Hit rate</span>
                  <span style={{ fontSize: 16, fontFamily: MONO_FONT, color: COLORS.textPrimary }}>{formatPercent(stats.embeddings.cacheHitRate)}</span>
                </div>
                <div style={{ border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg, padding: 12, display: "grid", gap: 4 }}>
                  <span style={{ ...LABEL_STYLE, fontSize: 9 }}>Cache hits</span>
                  <span style={{ fontSize: 16, fontFamily: MONO_FONT, color: COLORS.textPrimary }}>{formatNumber(stats.embeddings.cacheHits)}</span>
                </div>
                <div style={{ border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg, padding: 12, display: "grid", gap: 4 }}>
                  <span style={{ ...LABEL_STYLE, fontSize: 9 }}>Cache misses</span>
                  <span style={{ fontSize: 16, fontFamily: MONO_FONT, color: COLORS.textPrimary }}>{formatNumber(stats.embeddings.cacheMisses)}</span>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </section>
        </>
      ) : null}
    </div>
  );
}

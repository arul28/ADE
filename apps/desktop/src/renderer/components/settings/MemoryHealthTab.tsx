import React from "react";
import { Link } from "react-router-dom";
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
import {
  COLORS,
  MONO_FONT,
  SANS_FONT,
  LABEL_STYLE,
  cardStyle,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";

/* ═══════════════════════════════════════════════════════════════════════════
   Constants
   ═══════════════════════════════════════════════════════════════════════════ */

const DEFAULT_CONSOLIDATION_MODEL = "anthropic/claude-haiku-4-5";
const EMBEDDING_POLL_MS = 10_000;
const CONTENT_TRUNCATE_LENGTH = 200;

const SECTION_LABEL: React.CSSProperties = {
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

/* ── User-friendly tooltip text ── */

const TIPS = {
  pinned: "Always included when AI agents work on your project. These are your most important memories.",
  active: "Recently relevant knowledge that AI retrieves when useful for the current task.",
  fading: "Older memories that haven't been used in a while. Gets cleaned up automatically over time.",
  archived: "Hidden from AI agents. Can be restored if needed.",
  poolLimit: "Maximum memories allowed in this pool. When full, the oldest fading entries are cleaned up automatically.",
  smartSearch: "Understands meaning, not just keywords. Requires a small model download (~30 MB) that runs entirely on your machine.",
  smartSearchModel: "A small local AI model that converts text into searchable vectors. Downloads once, runs on your machine \u2014 nothing leaves your computer.",
  cleanup: "Automatically ages out old, unused memories and frees up space. Runs daily in the background.",
  mergeDuplicates: "Uses AI to find and combine similar memories into cleaner, single entries. Runs weekly in the background.",
  mergeModel: "The AI model used to analyze and merge duplicate memories.",
  changeTracking: "Tracks your git commits and saves summaries so AI agents stay up to date with recent changes you've made.",
  searchKeyword: "Matches exact words in your memories. Always available.",
  searchSmart: "Combines keyword matching with meaning-based search for better results. Requires Smart Search model.",
  cache: "In-memory cache for search vectors. Avoids re-computing for recently searched content.",
  pending: "Newly captured memories waiting for your review. Approve to keep, or archive to discard.",
} as const;

/* ═══════════════════════════════════════════════════════════════════════════
   Types
   ═══════════════════════════════════════════════════════════════════════════ */

type MemoryScope = "agent" | "project" | "mission";
type MemoryStatus = "candidate" | "promoted" | "archived";
type MemoryImportance = "low" | "medium" | "high";
type ProcedureSort = "confidence" | "applications" | "sources" | "recent";
type ConsoleTab = "overview" | "browse";

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
  sourceType: string | null;
  sourceId: string | null;
};

type ScopeFilter = "all" | MemoryScope;
type StatusFilter = "all" | "active" | "pending" | "archived";

/* ═══════════════════════════════════════════════════════════════════════════
   Helpers: formatting
   ═══════════════════════════════════════════════════════════════════════════ */

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
      model: { modelId: "Xenova/all-MiniLM-L6-v2", state: "idle", progress: null, loaded: null, total: null, file: null, error: null },
    },
  };
}

function createEmptyKnowledgeSyncStatus(): KnowledgeSyncStatus {
  return { syncing: false, lastSeenHeadSha: null, currentHeadSha: null, diverged: false, lastDigestAt: null, lastDigestMemoryId: null, lastError: null };
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function fmtNum(value: number): string { return value.toLocaleString("en-US"); }

function fmtTimestamp(value: string | null | undefined): string {
  if (!value) return "Never";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function fmtRelative(value: string | null | undefined): string {
  if (!value) return "never";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const ms = Date.now() - d.getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function shortSha(value: string | null | undefined): string {
  const t = String(value ?? "").trim();
  return t.length > 8 ? t.slice(0, 8) : t || "unknown";
}

function pct(current: number, max: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((current / max) * 100)));
}

function fmtPct(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0%";
  if (value >= 1) return "100%";
  return `${Math.round(value * 100)}%`;
}

/* ── User-friendly label maps ── */

function scopeLabel(scope: string): string {
  switch (scope) {
    case "project": return "Shared";
    case "agent": return "Agent";
    default: return "Mission";
  }
}

function scopeDescription(scope: string): string {
  switch (scope) {
    case "project": return "Available to all AI agents working on this project";
    case "agent": return "Knowledge specific to individual AI agents (like the CTO)";
    default: return "Temporary knowledge from a specific mission run";
  }
}

function tierLabel(tier: number): string {
  switch (tier) {
    case 1: return "Pinned";
    case 2: return "Active";
    default: return "Fading";
  }
}

function statusLabel(status: MemoryStatus): string {
  switch (status) {
    case "candidate": return "Pending";
    case "promoted": return "Active";
    default: return "Archived";
  }
}

function categoryLabel(cat: string): string {
  const map: Record<string, string> = {
    fact: "Fact",
    preference: "Preference",
    pattern: "Pattern",
    decision: "Decision",
    gotcha: "Pitfall",
    convention: "Convention",
    episode: "Episode",
    procedure: "Procedure",
    digest: "Summary",
    handoff: "Handoff",
  };
  return map[cat] ?? cat;
}

/* ── Color helpers ── */

function scopeColor(scope: MemoryScope): string {
  if (scope === "project") return COLORS.accent;
  if (scope === "agent") return COLORS.warning;
  return COLORS.info;
}

function statusColor(status: MemoryStatus): string {
  if (status === "promoted") return COLORS.success;
  if (status === "candidate") return COLORS.warning;
  return COLORS.textDim;
}

function importanceColor(importance: MemoryImportance): string {
  if (importance === "high") return COLORS.danger;
  if (importance === "medium") return COLORS.warning;
  return COLORS.textMuted;
}

/* ── Normalization ── */

function normalizeScope(v: unknown): MemoryScope {
  const r = String(v ?? "").trim();
  if (r === "project" || r === "mission" || r === "agent") return r;
  if (r === "user") return "agent";
  if (r === "lane") return "mission";
  return "project";
}

function normalizeStatus(v: unknown): MemoryStatus {
  const r = String(v ?? "").trim();
  if (r === "candidate" || r === "promoted" || r === "archived") return r;
  return "promoted";
}

function normalizeImportance(v: unknown): MemoryImportance {
  const r = String(v ?? "").trim();
  if (r === "low" || r === "medium" || r === "high") return r;
  return "medium";
}

function normalizeModelSetting(v: unknown): string {
  const r = typeof v === "string" ? v.trim() : "";
  if (!r) return "";
  return getModelById(r)?.id ?? resolveModelAlias(r)?.id ?? r;
}

function toEntry(v: unknown): MemoryEntry | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const id = String(r.id ?? "").trim();
  const content = String(r.content ?? "").trim();
  if (!id || !content) return null;
  return {
    id,
    scope: normalizeScope(r.scope),
    tier: Number(r.tier ?? 2),
    pinned: r.pinned === true || r.pinned === 1,
    category: String(r.category ?? "fact").trim() || "fact",
    content,
    importance: normalizeImportance(r.importance),
    createdAt: String(r.createdAt ?? r.created_at ?? ""),
    lastAccessedAt: String(r.lastAccessedAt ?? r.last_accessed_at ?? ""),
    accessCount: Number(r.accessCount ?? r.access_count ?? 0),
    status: normalizeStatus(r.status),
    confidence: Number(r.confidence ?? 0),
    embedded: r.embedded === true || r.embedded === 1 || r.embedded === "1",
    sourceType: asNullableString(r.sourceType) ?? asNullableString(r.source_type),
    sourceId: asNullableString(r.sourceId) ?? asNullableString(r.source_id),
  };
}

function toEntries(raw: unknown): MemoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: MemoryEntry[] = [];
  for (const item of raw) {
    const e = toEntry(item);
    if (e) out.push(e);
  }
  return out;
}

function excludeIndexedSkillMemories(entries: readonly MemoryEntry[], indexedSkillMemoryIds: ReadonlySet<string>): MemoryEntry[] {
  if (indexedSkillMemoryIds.size === 0) return [...entries];
  return entries.filter((entry) => !indexedSkillMemoryIds.has(entry.id));
}

function matchesFilters(e: MemoryEntry, scope: ScopeFilter, cat: string, status: StatusFilter): boolean {
  if (scope !== "all" && e.scope !== scope) return false;
  if (cat !== "all" && e.category !== cat) return false;
  if (status === "active" && e.status !== "promoted") return false;
  if (status === "pending" && e.status !== "candidate") return false;
  if (status === "archived" && e.status !== "archived") return false;
  return true;
}

function embeddingsReady(stats: MemoryHealthStats): boolean {
  return stats.embeddings.model.state === "ready";
}

function shouldPollEmbeddings(stats: MemoryHealthStats): boolean {
  // Only poll during active model download or active batch processing
  if (stats.embeddings.model.state === "loading") return true;
  if (stats.embeddings.processing && stats.embeddings.queueDepth > 0) return true;
  return false;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Small UI components
   ═══════════════════════════════════════════════════════════════════════════ */

function Tip({ text }: { text: string }) {
  const [show, setShow] = React.useState(false);
  const timerRef = React.useRef<number | null>(null);
  const onEnter = () => { timerRef.current = window.setTimeout(() => setShow(true), 150); };
  const onLeave = () => { if (timerRef.current) window.clearTimeout(timerRef.current); setShow(false); };
  React.useEffect(() => () => { if (timerRef.current) window.clearTimeout(timerRef.current); }, []);
  return (
    <span
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{ position: "relative", display: "inline-flex", alignItems: "center", justifyContent: "center", width: 14, height: 14, fontSize: 9, fontWeight: 700, fontFamily: MONO_FONT, color: show ? COLORS.accent : COLORS.textMuted, border: `1px solid ${show ? COLORS.accent : COLORS.border}`, borderRadius: "50%", cursor: "help", marginLeft: 4, flexShrink: 0, transition: "color 120ms ease, border-color 120ms ease" }}
    >
      ?
      {show ? (
        <span style={{ position: "absolute", bottom: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)", width: 260, padding: "8px 10px", fontSize: 11, fontWeight: 400, fontFamily: SANS_FONT, lineHeight: 1.5, color: COLORS.textPrimary, background: "#1E1B2E", border: `1px solid ${COLORS.outlineBorder}`, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.5)", zIndex: 100, pointerEvents: "none", textTransform: "none", letterSpacing: "0" }}>
          {text}
        </span>
      ) : null}
    </span>
  );
}

/** Inline helper text — replaces reliance on tooltips for key concepts */
function HelpText({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.5, margin: "0 0 8px 0" }}>
      {children}
    </p>
  );
}

function Badge({ label, color }: { label: string; color: string }) {
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

function ProgressBar({ value, max, color, label }: { value: number; max: number; color: string; label: string }) {
  const p = pct(value, max);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      style={{ height: 10, background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, overflow: "hidden" }}
    >
      <div style={{ width: `${p}%`, height: "100%", background: color, transition: "width 180ms ease" }} />
    </div>
  );
}

function tabStyle(active: boolean): React.CSSProperties {
  return active
    ? primaryButton({ height: 30, padding: "0 14px", fontSize: 10, borderRadius: 6 })
    : outlineButton({ height: 30, padding: "0 14px", fontSize: 10, borderRadius: 6 });
}

/* ═══════════════════════════════════════════════════════════════════════════
   Educational: How Memory Works
   ═══════════════════════════════════════════════════════════════════════════ */

function HowMemoryWorks({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const bullet: React.CSSProperties = {
    fontSize: 12,
    fontFamily: SANS_FONT,
    color: COLORS.textSecondary,
    lineHeight: 1.65,
    paddingLeft: 14,
    position: "relative",
  };
  const dot = (color: string): React.CSSProperties => ({
    position: "absolute",
    left: 0,
    top: 7,
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: color,
  });
  const heading: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 700,
    fontFamily: MONO_FONT,
    color: COLORS.textPrimary,
    textTransform: "uppercase",
    letterSpacing: "0.5px",
    marginBottom: 8,
  };

  return (
    <section style={cardStyle({ padding: 0, overflow: "hidden" })}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          display: "flex",
          width: "100%",
          alignItems: "center",
          gap: 8,
          padding: "14px 16px",
          background: "none",
          border: "none",
          cursor: "pointer",
          fontFamily: SANS_FONT,
          fontSize: 13,
          fontWeight: 600,
          color: COLORS.textSecondary,
        }}
      >
        <span style={{ fontSize: 10, transition: "transform 150ms ease", transform: open ? "rotate(90deg)" : "rotate(0)" }}>{"\u25B6"}</span>
        How memory works
      </button>

      {open ? (
        <div style={{ padding: "0 16px 18px", display: "flex", flexDirection: "column", gap: 18 }}>
          <p style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textSecondary, lineHeight: 1.65, margin: 0 }}>
            ADE automatically remembers important things about your project as you work. When AI agents run missions, chat with you,
            or encounter issues, they save useful knowledge &mdash; like project conventions, key decisions, and lessons learned.
            You never have to manage this manually, but you can review and curate it here.
          </p>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16 }}>
            {/* Priority levels */}
            <div>
              <div style={heading}>Priority levels</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={bullet}>
                  <span style={dot(COLORS.success)} />
                  <strong style={{ color: COLORS.textPrimary }}>Pinned</strong> &mdash; Critical knowledge always available to AI. Core conventions and important decisions.
                </div>
                <div style={bullet}>
                  <span style={dot(COLORS.accent)} />
                  <strong style={{ color: COLORS.textPrimary }}>Active</strong> &mdash; Recently relevant knowledge. AI retrieves this when useful for the current task.
                </div>
                <div style={bullet}>
                  <span style={dot(COLORS.textDim)} />
                  <strong style={{ color: COLORS.textPrimary }}>Fading</strong> &mdash; Older knowledge losing relevance. Gets cleaned up automatically over time.
                </div>
              </div>
            </div>

            {/* Knowledge pools */}
            <div>
              <div style={heading}>Knowledge pools</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={bullet}>
                  <span style={dot(COLORS.accent)} />
                  <strong style={{ color: COLORS.textPrimary }}>Shared</strong> &mdash; Project-wide knowledge available to all AI agents.
                </div>
                <div style={bullet}>
                  <span style={dot(COLORS.warning)} />
                  <strong style={{ color: COLORS.textPrimary }}>Agent</strong> &mdash; Knowledge specific to individual AI agents (like the CTO).
                </div>
                <div style={bullet}>
                  <span style={dot(COLORS.info)} />
                  <strong style={{ color: COLORS.textPrimary }}>Mission</strong> &mdash; Temporary knowledge from a mission. Useful findings get promoted to Shared on success.
                </div>
              </div>
            </div>
          </div>

          <div style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, padding: "10px 14px", borderRadius: 8 }}>
            <p style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.6, margin: 0 }}>
              <strong style={{ color: COLORS.textSecondary }}>Automatic maintenance:</strong> Memory is self-maintaining.
              Old, unused memories fade away naturally (30-day half-life). Similar memories get merged together periodically.
              You don't need to manage it &mdash; but you can pin important items, archive noise, or run cleanup manually below.
            </p>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   Main component
   ═══════════════════════════════════════════════════════════════════════════ */

export function MemoryHealthTab() {
  const memoryApi = window.ade.memory;

  /* ── Dashboard state ── */
  const [stats, setStats] = React.useState<MemoryHealthStats>(createEmptyHealthStats());
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [sweepRunning, setSweepRunning] = React.useState(false);
  const [consolidationRunning, setConsolidationRunning] = React.useState(false);
  const [modelSaving, setModelSaving] = React.useState(false);
  const [modelValue, setModelValue] = React.useState(DEFAULT_CONSOLIDATION_MODEL);
  const [modelOptions, setModelOptions] = React.useState<Array<{ id: string; label: string }>>([]);

  /* ── Browser state ── */
  const [budgetEntries, setBudgetEntries] = React.useState<MemoryEntry[]>([]);
  const [candidates, setCandidates] = React.useState<MemoryEntry[]>([]);
  const [searchInput, setSearchInput] = React.useState("");
  const [searchResults, setSearchResults] = React.useState<MemoryEntry[]>([]);
  const [searching, setSearching] = React.useState(false);
  const [scopeFilter, setScopeFilter] = React.useState<ScopeFilter>("all");
  const [categoryFilter, setCategoryFilter] = React.useState<string>("all");
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("all");
  const [searchMode, setSearchMode] = React.useState<MemorySearchMode>("lexical");
  const [hasChosenSearchMode, setHasChosenSearchMode] = React.useState(false);
  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(new Set());

  /* ── UI state ── */
  const [activeTab, setActiveTab] = React.useState<ConsoleTab>("overview");
  const [howItWorksOpen, setHowItWorksOpen] = React.useState(false);
  const [maintenanceOpen, setMaintenanceOpen] = React.useState(false);
  const [procedures, setProcedures] = React.useState<ProcedureListItem[]>([]);
  const [indexedSkills, setIndexedSkills] = React.useState<SkillIndexEntry[]>([]);
  const [selectedProcedureId, setSelectedProcedureId] = React.useState<string | null>(null);
  const [selectedProcedureDetail, setSelectedProcedureDetail] = React.useState<ProcedureDetail | null>(null);
  const [procedureDetailLoading, setProcedureDetailLoading] = React.useState(false);
  const [procedureSort, setProcedureSort] = React.useState<ProcedureSort>("confidence");
  const [knowledgeSyncStatus, setKnowledgeSyncStatus] = React.useState<KnowledgeSyncStatus>(createEmptyKnowledgeSyncStatus());
  const [syncRunning, setSyncRunning] = React.useState(false);

  /* ── Derived ── */

  const indexedSkillMemoryIds = React.useMemo(() => {
    const ids = new Set<string>();
    for (const entry of indexedSkills) {
      if (typeof entry.memoryId === "string" && entry.memoryId.trim().length > 0) ids.add(entry.memoryId);
    }
    return ids;
  }, [indexedSkills]);

  const activeIndexedSkillEntries = React.useMemo(
    () => indexedSkills.filter((entry) => entry.memoryId && !entry.archivedAt),
    [indexedSkills],
  );

  const visibleBudgetEntries = React.useMemo(
    () => excludeIndexedSkillMemories(budgetEntries, indexedSkillMemoryIds),
    [budgetEntries, indexedSkillMemoryIds],
  );
  const visibleCandidateEntries = React.useMemo(
    () => excludeIndexedSkillMemories(candidates, indexedSkillMemoryIds),
    [candidates, indexedSkillMemoryIds],
  );
  const visibleSearchResults = React.useMemo(
    () => excludeIndexedSkillMemories(searchResults, indexedSkillMemoryIds),
    [searchResults, indexedSkillMemoryIds],
  );

  const categories = React.useMemo(() => {
    const all = [...visibleBudgetEntries, ...visibleCandidateEntries, ...visibleSearchResults].map((e) => e.category.trim()).filter(Boolean);
    return Array.from(new Set(all)).sort((a, b) => a.localeCompare(b));
  }, [visibleBudgetEntries, visibleCandidateEntries, visibleSearchResults]);

  const sortedProcedures = React.useMemo(() => {
    const next = [...procedures];
    next.sort((a, b) => {
      if (procedureSort === "applications") return (b.procedural.successCount + b.procedural.failureCount) - (a.procedural.successCount + a.procedural.failureCount);
      if (procedureSort === "sources") return b.procedural.sourceEpisodeIds.length - a.procedural.sourceEpisodeIds.length;
      if (procedureSort === "recent") return Date.parse(b.memory.updatedAt || b.memory.createdAt) - Date.parse(a.memory.updatedAt || a.memory.createdAt);
      return b.procedural.confidence - a.procedural.confidence;
    });
    return next;
  }, [procedureSort, procedures]);

  const allEntries = searchInput.trim().length > 0 ? visibleSearchResults : [...visibleBudgetEntries, ...visibleCandidateEntries];
  const filteredEntries = allEntries.filter((e) => matchesFilters(e, scopeFilter, categoryFilter, statusFilter));
  const activeEntries = filteredEntries.filter((e) => e.status !== "candidate");
  const candidateEntries = searchInput.trim().length > 0 ? [] : visibleCandidateEntries.filter((e) => matchesFilters(e, scopeFilter, categoryFilter, "pending"));

  const embReady = embeddingsReady(stats);
  const embProgress = pct(stats.embeddings.entriesEmbedded, Math.max(stats.embeddings.entriesTotal, 1));
  const modelDownloadPct = (() => {
    const { progress, loaded, total } = stats.embeddings.model;
    if (typeof progress === "number" && Number.isFinite(progress)) return Math.max(0, Math.min(100, Math.round(progress)));
    if (typeof loaded === "number" && typeof total === "number" && total > 0) return pct(loaded, total);
    return 0;
  })();
  const showDownload = stats.embeddings.model.state !== "loading" && stats.embeddings.model.state !== "ready";

  /* ═══════════════════════════════════════════════════════════════════════
     Data loading
     ═══════════════════════════════════════════════════════════════════════ */

  const loadDashboard = React.useCallback(async (opts?: { quiet?: boolean }) => {
    if (!memoryApi?.getHealthStats) {
      setLoadError("Memory is not available in this build.");
      setLoading(false);
      return;
    }
    if (!opts?.quiet) setLoading(true);

    try {
      const [nextStats, budgetRaw, candidatesRaw, aiStatus, snapshot, nextProcedures, nextIndexedSkills, nextSync] = await Promise.all([
        memoryApi.getHealthStats(),
        memoryApi.getBudget({ level: "deep" }),
        memoryApi.getCandidates({ limit: 25 }),
        window.ade.ai.getStatus(),
        window.ade.projectConfig.get(),
        memoryApi.listProcedures?.({ status: "all", scope: "project" }) ?? Promise.resolve([]),
        memoryApi.listIndexedSkills?.() ?? Promise.resolve([]),
        memoryApi.getKnowledgeSyncStatus?.() ?? Promise.resolve(createEmptyKnowledgeSyncStatus()),
      ]);

      const aiCfg = (() => {
        const raw = snapshot.effective?.ai;
        return raw && typeof raw === "object" ? (raw as AiConfig) : null;
      })();
      const nextModelVal = normalizeModelSetting(aiCfg?.featureModelOverrides?.memory_consolidation) || DEFAULT_CONSOLIDATION_MODEL;
      let opts2: Array<{ id: string; label: string }> = [{ id: nextModelVal, label: nextModelVal }];
      try { opts2 = includeSelectedModelOption(deriveConfiguredModelOptions(aiStatus), nextModelVal).map((o) => ({ id: o.id, label: o.label })); } catch { /* keep fallback */ }

      setStats(nextStats);
      setBudgetEntries(toEntries(budgetRaw));
      setCandidates(toEntries(candidatesRaw));
      setProcedures(nextProcedures);
      setIndexedSkills(nextIndexedSkills);
      if (selectedProcedureId && !nextProcedures.some((p) => p.memory.id === selectedProcedureId)) {
        setSelectedProcedureId(null);
        setSelectedProcedureDetail(null);
      }
      setKnowledgeSyncStatus(nextSync);
      setModelOptions(opts2);
      setModelValue(nextModelVal);
      setLoadError(null);
      if (!hasChosenSearchMode) setSearchMode(embeddingsReady(nextStats) ? "hybrid" : "lexical");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [hasChosenSearchMode, memoryApi, selectedProcedureId]);

  React.useEffect(() => { void loadDashboard(); }, [loadDashboard]);

  /* ── Embedding polling ── */
  React.useEffect(() => {
    if (!memoryApi?.getHealthStats || loadError || !shouldPollEmbeddings(stats)) return undefined;
    const timer = window.setTimeout(() => { void loadDashboard({ quiet: true }); }, EMBEDDING_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [loadDashboard, loadError, memoryApi, stats]);

  /* ── Sweep / consolidation events ── */
  React.useEffect(() => {
    if (!memoryApi) return undefined;
    const d1 = memoryApi.onSweepStatus((ev) => {
      if (ev.type === "memory-sweep-started") { setSweepRunning(true); setActionError(null); return; }
      setSweepRunning(false);
      if (ev.type !== "memory-sweep-completed") setActionError(ev.error);
      void loadDashboard();
    });
    const d2 = memoryApi.onConsolidationStatus((ev) => {
      if (ev.type === "memory-consolidation-started") { setConsolidationRunning(true); setActionError(null); return; }
      setConsolidationRunning(false);
      if (ev.type !== "memory-consolidation-completed") setActionError(ev.error);
      void loadDashboard();
    });
    return () => { d1(); d2(); };
  }, [loadDashboard, memoryApi]);

  /* ═══════════════════════════════════════════════════════════════════════
     Action handlers
     ═══════════════════════════════════════════════════════════════════════ */

  const runSearch = React.useCallback(async () => {
    const q = searchInput.trim();
    if (!q || !memoryApi) { setSearchResults([]); return; }
    setSearching(true);
    try {
      const raw = await memoryApi.search({ query: q, limit: 40, mode: searchMode });
      setSearchResults(toEntries(raw));
      setActionError(null);
    } catch (err) { setActionError(err instanceof Error ? err.message : String(err)); }
    finally { setSearching(false); }
  }, [memoryApi, searchInput, searchMode]);

  const handlePin = React.useCallback(async (id: string) => {
    if (!memoryApi) return;
    try { await memoryApi.pin({ id }); void loadDashboard({ quiet: true }); if (searchInput.trim()) void runSearch(); }
    catch (err) { setActionError(err instanceof Error ? err.message : String(err)); }
  }, [loadDashboard, memoryApi, runSearch, searchInput]);

  const handleArchive = React.useCallback(async (id: string) => {
    if (!memoryApi) return;
    try {
      await memoryApi.archive({ id });
      setBudgetEntries((p) => p.filter((e) => e.id !== id));
      setCandidates((p) => p.filter((e) => e.id !== id));
      setSearchResults((p) => p.filter((e) => e.id !== id));
    } catch (err) { setActionError(err instanceof Error ? err.message : String(err)); }
  }, [memoryApi]);

  const handlePromote = React.useCallback(async (id: string) => {
    if (!memoryApi) return;
    try { await memoryApi.promote({ id }); void loadDashboard({ quiet: true }); if (searchInput.trim()) void runSearch(); }
    catch (err) { setActionError(err instanceof Error ? err.message : String(err)); }
  }, [loadDashboard, memoryApi, runSearch, searchInput]);

  const handleSweep = React.useCallback(async () => {
    if (!memoryApi?.runSweep || sweepRunning) return;
    setSweepRunning(true); setActionError(null);
    try { await memoryApi.runSweep(); await loadDashboard(); }
    catch (err) { setActionError(err instanceof Error ? err.message : String(err)); }
    finally { setSweepRunning(false); }
  }, [loadDashboard, memoryApi, sweepRunning]);

  const handleConsolidate = React.useCallback(async () => {
    if (!memoryApi?.runConsolidation || consolidationRunning) return;
    setConsolidationRunning(true); setActionError(null);
    try { await memoryApi.runConsolidation(); await loadDashboard(); }
    catch (err) { setActionError(err instanceof Error ? err.message : String(err)); }
    finally { setConsolidationRunning(false); }
  }, [consolidationRunning, loadDashboard, memoryApi]);

  const handleModelChange = React.useCallback(async (next: string) => {
    const prev = modelValue;
    setModelValue(next); setModelSaving(true); setActionError(null);
    try { await window.ade.ai.updateConfig({ featureModelOverrides: { memory_consolidation: next } as AiConfig["featureModelOverrides"] }); }
    catch (err) { setModelValue(prev); setActionError(err instanceof Error ? err.message : String(err)); }
    finally { setModelSaving(false); }
  }, [modelValue]);

  const handleDownloadModel = React.useCallback(async () => {
    if (!memoryApi?.downloadEmbeddingModel || stats.embeddings.model.state === "loading") return;
    setActionError(null);
    try { const s = await memoryApi.downloadEmbeddingModel(); setStats(s); setLoadError(null); }
    catch (err) { setActionError(err instanceof Error ? err.message : String(err)); }
  }, [memoryApi, stats.embeddings.model.state]);

  const handleSyncKnowledge = React.useCallback(async () => {
    if (!memoryApi?.syncKnowledge || syncRunning) return;
    setSyncRunning(true); setActionError(null);
    try { await memoryApi.syncKnowledge(); await loadDashboard({ quiet: true }); }
    catch (err) { setActionError(err instanceof Error ? err.message : String(err)); }
    finally { setSyncRunning(false); }
  }, [loadDashboard, memoryApi, syncRunning]);

  const handleOpenProcedure = React.useCallback(async (id: string) => {
    if (!memoryApi?.getProcedureDetail) return;
    setSelectedProcedureId(id); setProcedureDetailLoading(true);
    try { const d = await memoryApi.getProcedureDetail({ id }); setSelectedProcedureDetail(d); setActionError(null); }
    catch (err) { setSelectedProcedureDetail(null); setActionError(err instanceof Error ? err.message : String(err)); }
    finally { setProcedureDetailLoading(false); }
  }, [memoryApi]);

  // Procedure detail auto-open is deferred until the user clicks a procedure in Browse.

  const toggleExpanded = React.useCallback((id: string) => {
    setExpandedIds((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }, []);

  /* ═══════════════════════════════════════════════════════════════════════
     Render helpers
     ═══════════════════════════════════════════════════════════════════════ */

  function tryParseEpisode(content: string): { taskDescription: string; approachTaken: string; outcome?: string; patternsDiscovered?: string[]; gotchas?: string[]; decisionsMade?: string[] } | null {
    // New format: human-readable text with JSON in HTML comment
    const commentMatch = content.match(/<!--episode:([\s\S]*?)-->/);
    if (commentMatch) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(commentMatch[1]), (c) => c.charCodeAt(0))));
        if (parsed && typeof parsed === "object" && typeof parsed.taskDescription === "string" && typeof parsed.approachTaken === "string") {
          return parsed;
        }
      } catch { /* fall through */ }
    }
    // Legacy format: raw JSON content
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === "object" && typeof parsed.taskDescription === "string" && typeof parsed.approachTaken === "string") {
        return parsed;
      }
    } catch { /* not JSON */ }
    return null;
  }

  /** Strip hidden episode comment from content for display */
  function stripEpisodeComment(content: string): string {
    return content.replace(/\n?<!--episode:[\s\S]*?-->/, "").trim();
  }

  function renderContent(entry: MemoryEntry) {
    // Try to render episode memories as structured cards
    if (entry.category === "episode") {
      const ep = tryParseEpisode(entry.content);
      if (ep) {
        const items: Array<{ label: string; value: string }> = [];
        if (ep.taskDescription) items.push({ label: "Task", value: ep.taskDescription });
        if (ep.approachTaken) items.push({ label: "Approach", value: ep.approachTaken });
        if (ep.outcome) items.push({ label: "Outcome", value: ep.outcome });
        const patterns = (ep.patternsDiscovered ?? []).filter(Boolean);
        if (patterns.length > 0) items.push({ label: "Patterns", value: patterns.join(", ") });
        const gotchas = (ep.gotchas ?? []).filter(Boolean);
        if (gotchas.length > 0) items.push({ label: "Pitfalls", value: gotchas.join(", ") });
        const decisions = (ep.decisionsMade ?? []).filter(Boolean);
        if (decisions.length > 0) items.push({ label: "Decisions", value: decisions.join(", ") });
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {items.map((item) => (
              <div key={item.label} style={{ fontSize: 11, fontFamily: SANS_FONT, lineHeight: 1.5, color: COLORS.textSecondary }}>
                <span style={{ fontWeight: 600, color: COLORS.textPrimary, marginRight: 6 }}>{item.label}:</span>
                {item.value}
              </div>
            ))}
          </div>
        );
      }
    }

    // Default: render as text, strip hidden episode comments
    const displayContent = stripEpisodeComment(entry.content);
    const isLong = displayContent.length > CONTENT_TRUNCATE_LENGTH;
    const isExpanded = expandedIds.has(entry.id);
    const text = isLong && !isExpanded ? displayContent.slice(0, CONTENT_TRUNCATE_LENGTH) + "\u2026" : displayContent;
    return (
      <div>
        <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textPrimary, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{text}</div>
        {isLong ? (
          <button
            type="button"
            onClick={() => toggleExpanded(entry.id)}
            style={{ background: "none", border: "none", padding: 0, marginTop: 4, fontSize: 10, fontFamily: MONO_FONT, color: COLORS.accent, cursor: "pointer", textDecoration: "underline" }}
          >
            {isExpanded ? "Show less" : "Show more"}
          </button>
        ) : null}
      </div>
    );
  }

  function renderEntryCard(entry: MemoryEntry, actions: React.ReactNode) {
    return (
      <div
        key={entry.id}
        style={{
          border: `1px solid ${COLORS.border}`,
          borderLeft: `3px solid ${scopeColor(entry.scope)}`,
          background: COLORS.recessedBg,
          padding: "10px 10px 10px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <Badge label={scopeLabel(entry.scope)} color={scopeColor(entry.scope)} />
            <Badge label={categoryLabel(entry.category)} color={COLORS.textSecondary} />
            <Badge label={tierLabel(entry.tier)} color={entry.tier === 1 ? COLORS.success : entry.tier === 2 ? COLORS.accent : COLORS.textDim} />
            {entry.pinned ? <Badge label="pinned" color={COLORS.success} /> : null}
          </div>
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>{actions}</div>
        </div>
        {renderContent(entry)}
        <div style={{ fontFamily: SANS_FONT, fontSize: 10, color: COLORS.textMuted, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <span>{statusLabel(entry.status)}</span>
          <span>{entry.importance} importance</span>
          <span>{Math.round(entry.confidence * 100)}% confidence</span>
          <span>accessed {entry.accessCount}x</span>
          <span>{fmtRelative(entry.lastAccessedAt || entry.createdAt)}</span>
        </div>
      </div>
    );
  }

  function entryActions(entry: MemoryEntry) {
    return (
      <>
        {entry.status === "candidate" ? (
          <button
            type="button"
            title="Approve this memory and make it active"
            style={primaryButton({ height: 24, padding: "0 8px", fontSize: 10 })}
            onClick={() => void handlePromote(entry.id)}
          >
            Approve
          </button>
        ) : !entry.pinned ? (
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
          title="Archive this memory (hide from AI agents)"
          style={outlineButton({ height: 24, padding: "0 8px", fontSize: 10 })}
          onClick={() => void handleArchive(entry.id)}
        >
          Archive
        </button>
      </>
    );
  }

  /* ═══════════════════════════════════════════════════════════════════════
     Tab: Overview
     ═══════════════════════════════════════════════════════════════════════ */

  function renderOverview() {
    const lastSweep = stats.lastSweep;
    const lastConsolidation = stats.lastConsolidation;
    return (
      <>
        {/* Storage — each bar is a "pool" of memories */}
        <section style={cardStyle({ padding: 16, display: "flex", flexDirection: "column", gap: 14 })}>
          <div style={SECTION_LABEL}>STORAGE</div>
          <HelpText>
            Memory is divided into three pools. Each pool has a capacity limit. When a pool is full, the oldest low-priority entries are
            cleaned up automatically. You don't need to manage this.
          </HelpText>
          {stats.scopes.map((s) => {
            const label = scopeLabel(s.scope);
            const desc = scopeDescription(s.scope);
            const p = pct(s.current, s.max);
            return (
              <div key={s.scope} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textSecondary }}>
                  <span>
                    <strong style={{ color: COLORS.textPrimary }}>{label}</strong> &mdash; {desc}
                  </span>
                  <span>{fmtNum(s.current)} / {fmtNum(s.max)}</span>
                </div>
                <ProgressBar value={s.current} max={s.max} color={p >= 80 ? COLORS.warning : COLORS.accent} label={`${label} storage`} />
                <div style={{ display: "flex", gap: 12, fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>
                  <span>Pinned: {fmtNum(s.counts.tier1)}</span>
                  <span>Active: {fmtNum(s.counts.tier2)}</span>
                  <span>Fading: {fmtNum(s.counts.tier3)}</span>
                  <span>Archived: {fmtNum(s.counts.archived)}</span>
                </div>
              </div>
            );
          })}
        </section>

        {/* Smart Search — optional model download */}
        <section style={cardStyle({ padding: 16, display: "flex", flexDirection: "column", gap: 12 })}>
          <div style={SECTION_LABEL}>SMART SEARCH</div>
          <HelpText>
            Smart search lets you find memories by <em>meaning</em>, not just exact keywords. It requires a small AI model (~30 MB) that
            downloads once and runs entirely on your machine. <strong>Memory works fine without it</strong> &mdash; you just get keyword search instead.
          </HelpText>
          <div style={{ border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg, padding: 12, display: "grid", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 12, fontFamily: MONO_FONT, color: COLORS.textPrimary, fontWeight: 700 }}>
                  {embReady ? "Smart search is active" : stats.embeddings.model.state === "loading" ? "Downloading model..." : "Smart search not enabled"}
                </div>
                <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, marginTop: 4 }}>
                  {embReady
                    ? `${fmtNum(stats.embeddings.entriesEmbedded)} of ${fmtNum(stats.embeddings.entriesTotal)} memories indexed`
                    : "Download the model to enable meaning-based search"}
                </div>
              </div>
              {showDownload ? (
                <button type="button" onClick={() => void handleDownloadModel()} style={primaryButton({ height: 30, padding: "0 12px", fontSize: 10 })}>
                  Download Model
                </button>
              ) : null}
            </div>
            {stats.embeddings.model.state === "loading" ? (
              <>
                <ProgressBar value={modelDownloadPct} max={100} color={COLORS.info} label="Model download" />
                <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textSecondary }}>{modelDownloadPct}%</div>
              </>
            ) : stats.embeddings.model.error ? (
              <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.warning }}>{stats.embeddings.model.error}</div>
            ) : null}
          </div>
        </section>

        {/* Change tracking */}
        <section style={cardStyle({ padding: 16, display: "flex", flexDirection: "column", gap: 8 })}>
          <div style={SECTION_LABEL}>CHANGE TRACKING</div>
          <HelpText>
            ADE watches your git commits and saves summaries so AI agents stay up to date with recent changes you've made to the codebase.
          </HelpText>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
            <div>
              <div style={{ fontSize: 12, fontFamily: MONO_FONT, color: knowledgeSyncStatus.diverged ? COLORS.warning : COLORS.success }}>
                {knowledgeSyncStatus.syncing ? "Analyzing recent changes..." : knowledgeSyncStatus.diverged ? "Behind \u2014 new commits since last sync" : "Up to date"}
              </div>
              <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, marginTop: 4 }}>
                HEAD: {shortSha(knowledgeSyncStatus.currentHeadSha)} \u00B7 Last synced: {shortSha(knowledgeSyncStatus.lastSeenHeadSha)}
              </div>
            </div>
            <button type="button" style={outlineButton({ height: 30, padding: "0 12px", fontSize: 10 })} onClick={() => void handleSyncKnowledge()} disabled={syncRunning || knowledgeSyncStatus.syncing}>
              {syncRunning || knowledgeSyncStatus.syncing ? "Syncing..." : "Sync Now"}
            </button>
          </div>
        </section>

        {/* Quick stats */}
        <section style={cardStyle({ padding: 16, display: "flex", flexDirection: "column", gap: 10 })}>
          <div style={SECTION_LABEL}>AT A GLANCE</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
            {[
              { label: "Total memories", value: stats.scopes.reduce((s, x) => s + x.current, 0) },
              { label: "Pinned", value: stats.scopes.reduce((s, x) => s + x.counts.tier1, 0) },
              { label: "Pending review", value: candidates.length },
              { label: "Smart search", value: embReady ? "Active" : "Off" },
            ].map((item) => (
              <div key={item.label} style={{ border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg, padding: 12, display: "grid", gap: 4 }}>
                <span style={{ ...LABEL_STYLE, fontSize: 9 }}>{item.label}</span>
                <span style={{ fontSize: 16, fontFamily: MONO_FONT, color: COLORS.textPrimary }}>{typeof item.value === "number" ? fmtNum(item.value) : item.value}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Maintenance — collapsed by default */}
        <section style={cardStyle({ padding: 0, overflow: "hidden" })}>
          <button
            type="button"
            onClick={() => setMaintenanceOpen((p) => !p)}
            style={{ display: "flex", width: "100%", alignItems: "center", gap: 8, padding: "14px 16px", background: "none", border: "none", cursor: "pointer", fontFamily: SANS_FONT, fontSize: 13, fontWeight: 600, color: COLORS.textSecondary }}
          >
            <span style={{ fontSize: 10, transition: "transform 150ms ease", transform: maintenanceOpen ? "rotate(90deg)" : "rotate(0)" }}>{"\u25B6"}</span>
            Maintenance (runs automatically &mdash; most users never need this)
          </button>
          {maintenanceOpen ? (
            <div style={{ padding: "0 16px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
              <HelpText>
                ADE automatically cleans up old memories daily and merges duplicates weekly. These buttons let you trigger it manually if you want.
              </HelpText>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 12 }}>
                {/* Cleanup */}
                <div style={{ border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg, padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ fontSize: 12, fontFamily: MONO_FONT, color: COLORS.textPrimary, fontWeight: 700 }}>Clean up old memories</div>
                  <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
                    Ages out unused memories, demotes fading entries, and archives low-value items.
                  </div>
                  <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>
                    Last run: {lastSweep ? fmtTimestamp(lastSweep.completedAt) : "Never"}
                    {lastSweep ? ` \u00B7 Archived ${fmtNum(lastSweep.entriesArchived)}, aged ${fmtNum(lastSweep.entriesDecayed)}` : ""}
                  </div>
                  <button type="button" onClick={() => void handleSweep()} disabled={sweepRunning} style={{ ...primaryButton({ fontSize: 10 }), alignSelf: "flex-start", opacity: sweepRunning ? 0.7 : 1 }}>
                    {sweepRunning ? "Running..." : "Run Now"}
                  </button>
                </div>
                {/* Merge duplicates */}
                <div style={{ border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg, padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ fontSize: 12, fontFamily: MONO_FONT, color: COLORS.textPrimary, fontWeight: 700 }}>Merge similar memories</div>
                  <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
                    Uses AI to find and combine overlapping memories into cleaner, single entries.
                  </div>
                  <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>
                    Last run: {lastConsolidation ? fmtTimestamp(lastConsolidation.completedAt) : "Never"}
                    {lastConsolidation ? ` \u00B7 Merged ${fmtNum(lastConsolidation.entriesMerged)}, created ${fmtNum(lastConsolidation.entriesCreated)}` : ""}
                  </div>
                  <button type="button" onClick={() => void handleConsolidate()} disabled={consolidationRunning} style={{ ...outlineButton({ fontSize: 10 }), alignSelf: "flex-start", opacity: consolidationRunning ? 0.7 : 1 }}>
                    {consolidationRunning ? "Running..." : "Run Now"}
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </section>
      </>
    );
  }

  /* ═══════════════════════════════════════════════════════════════════════
     Tab: Browse
     ═══════════════════════════════════════════════════════════════════════ */

  function renderBrowse() {
    return (
      <>
        {/* Search */}
        <section style={cardStyle({ padding: 16, display: "flex", flexDirection: "column", gap: 10 })}>
          <HelpText>
            These are the learned memory entries ADE keeps about your project. AI agents write memories when they discover conventions, make
            decisions, encounter pitfalls, or notice patterns. Imported skill files and legacy command files stay indexed for retrieval, but
            they are managed separately from this browser.
          </HelpText>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void runSearch(); } }}
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
            <button type="button" style={primaryButton({ height: 32, padding: "0 10px", fontSize: 10 })} disabled={searching || !searchInput.trim()} onClick={() => void runSearch()}>
              {searching ? "Searching..." : "Search"}
            </button>
            <button type="button" style={outlineButton({ height: 32, padding: "0 10px", fontSize: 10 })} onClick={() => void loadDashboard()}>
              Refresh
            </button>
          </div>

          {/* Filters */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <select value={scopeFilter} onChange={(e) => setScopeFilter(e.target.value as ScopeFilter)} style={{ height: 28, border: `1px solid ${COLORS.outlineBorder}`, background: COLORS.recessedBg, color: COLORS.textPrimary, fontSize: 11, fontFamily: MONO_FONT, padding: "0 8px", minWidth: 140 }}>
              <option value="all">All pools</option>
              <option value="project">Shared (project-wide)</option>
              <option value="agent">Agent-specific</option>
              <option value="mission">Mission-specific</option>
            </select>
            <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} title="Filter by type" style={{ height: 28, border: `1px solid ${COLORS.outlineBorder}`, background: COLORS.recessedBg, color: COLORS.textPrimary, fontSize: 11, fontFamily: MONO_FONT, padding: "0 8px", minWidth: 130 }}>
              <option value="all">All types</option>
              {categories.map((c) => <option key={c} value={c}>{categoryLabel(c)}</option>)}
            </select>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)} title="Filter by status" style={{ height: 28, border: `1px solid ${COLORS.outlineBorder}`, background: COLORS.recessedBg, color: COLORS.textPrimary, fontSize: 11, fontFamily: MONO_FONT, padding: "0 8px", minWidth: 130 }}>
              <option value="all">All statuses</option>
              <option value="active">Active</option>
              <option value="pending">Pending review</option>
              <option value="archived">Archived</option>
            </select>

            {/* Search mode */}
            <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
              <button
                type="button"
                aria-pressed={searchMode === "lexical"}
                title={TIPS.searchKeyword}
                style={searchMode === "lexical" ? primaryButton({ height: 26, padding: "0 8px", fontSize: 9 }) : outlineButton({ height: 26, padding: "0 8px", fontSize: 9 })}
                onClick={() => { setHasChosenSearchMode(true); setSearchMode("lexical"); }}
              >
                Keyword
              </button>
              <button
                type="button"
                aria-pressed={searchMode === "hybrid"}
                title={TIPS.searchSmart}
                style={searchMode === "hybrid" ? primaryButton({ height: 26, padding: "0 8px", fontSize: 9 }) : outlineButton({ height: 26, padding: "0 8px", fontSize: 9 })}
                onClick={() => { setHasChosenSearchMode(true); setSearchMode("hybrid"); }}
              >
                Smart{embReady ? "" : " (unavailable)"}
              </button>
            </div>
          </div>
        </section>

        {activeIndexedSkillEntries.length > 0 ? (
          <section style={cardStyle({ padding: 16, display: "flex", flexDirection: "column", gap: 8 })}>
            <div style={SECTION_LABEL}>INDEXED SKILL FILES</div>
            <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textSecondary, lineHeight: 1.5 }}>
              ADE is indexing {fmtNum(activeIndexedSkillEntries.length)} reusable skill
              {activeIndexedSkillEntries.length === 1 ? " file" : " files"} for retrieval, ranking, and procedure dedupe.
              They are intentionally hidden from the generic memory browser and managed in{" "}
              <Link to="/settings?tab=workspace" style={{ color: COLORS.accent, textDecoration: "underline" }}>
                Workspace &gt; Skill Files
              </Link>.
            </div>
          </section>
        ) : null}

        {/* Memory entries */}
        {!loading && activeEntries.length > 0 ? (
          <section style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 480, overflowY: "auto", paddingRight: 2 }}>
            <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, padding: "0 2px" }}>
              {activeEntries.length} {activeEntries.length === 1 ? "memory" : "memories"}
            </div>
            {activeEntries.map((e) => renderEntryCard(e, entryActions(e)))}
          </section>
        ) : !loading ? (
          <EmptyState
            title={searchInput.trim() ? "No learned memory matches" : "No learned memories yet"}
            description={searchInput.trim() ? "Try a broader query or adjust filters." : "Learned memories will appear here as ADE discovers durable project knowledge."}
          />
        ) : null}

        {/* Pending review */}
        {candidateEntries.length > 0 ? (
          <section style={cardStyle({ padding: 16, display: "flex", flexDirection: "column", gap: 8 })}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={SECTION_LABEL}>
                PENDING REVIEW
                <Tip text={TIPS.pending} />
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  type="button"
                  style={primaryButton({ height: 24, padding: "0 10px", fontSize: 10 })}
                  onClick={() => { for (const e of candidateEntries) void handlePromote(e.id); }}
                >
                  Approve All
                </button>
                <button
                  type="button"
                  style={outlineButton({ height: 24, padding: "0 10px", fontSize: 10 })}
                  onClick={() => { for (const e of candidateEntries) void handleArchive(e.id); }}
                >
                  Archive All
                </button>
              </div>
            </div>
            <p style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, margin: 0, lineHeight: 1.5 }}>
              Captured automatically. Approve to keep, or archive to discard.
            </p>
            {candidateEntries.map((e) => renderEntryCard(e, entryActions(e)))}
          </section>
        ) : null}
      </>
    );
  }

  /* ═══════════════════════════════════════════════════════════════════════
     Main render
     ═══════════════════════════════════════════════════════════════════════ */

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 980 }}>
      {/* Header */}
      <div style={{ borderLeft: `3px solid ${COLORS.accent}`, paddingLeft: 12 }}>
        <h2 style={{ margin: 0, fontSize: 20, color: COLORS.textPrimary, fontFamily: MONO_FONT, fontWeight: 700, letterSpacing: "-0.02em" }}>
          Memory
        </h2>
        <p style={{ marginTop: 6, marginBottom: 0, fontSize: 12, color: COLORS.textMuted, fontFamily: SANS_FONT, lineHeight: 1.5 }}>
          ADE remembers facts, conventions, patterns, and lessons learned across sessions. Everything is automatic &mdash; browse and curate here when you want to.
        </p>
      </div>

      {/* How Memory Works */}
      <HowMemoryWorks open={howItWorksOpen} onToggle={() => setHowItWorksOpen((p) => !p)} />

      {/* Tab bar */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {([
          { id: "overview" as ConsoleTab, label: "Overview" },
          { id: "browse" as ConsoleTab, label: "Browse All" },
        ]).map((t) => (
          <button key={t.id} type="button" style={tabStyle(activeTab === t.id)} onClick={() => setActiveTab(t.id)}>
            {t.label}
            {t.id === "browse" && candidates.length > 0 ? (
              <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, color: COLORS.warning, background: `${COLORS.warning}20`, padding: "1px 5px", borderRadius: 4 }}>
                {candidates.length}
              </span>
            ) : null}
          </button>
        ))}
      </div>

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

      {/* Tab content */}
      {!loading ? (
        <>
          {activeTab === "overview" && renderOverview()}
          {activeTab === "browse" && renderBrowse()}
        </>
      ) : null}
    </div>
  );
}

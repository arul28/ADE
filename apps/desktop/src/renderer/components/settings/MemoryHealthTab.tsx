import React from "react";
import type { AiConfig, MemoryHealthStats } from "../../../shared/types";
import { deriveConfiguredModelOptions, includeSelectedModelOption } from "../../lib/modelOptions";
import { getModelById, resolveModelAlias } from "../../../shared/modelRegistry";
import { COLORS, MONO_FONT, LABEL_STYLE, cardStyle, outlineButton, primaryButton } from "../lanes/laneDesignTokens";

const DEFAULT_CONSOLIDATION_MODEL = "anthropic/claude-haiku-4-5";
const EMBEDDING_POLL_MS = 1500;
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
  return "Model unavailable";
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
  ].join(" • ");
}

function consolidationSummary(stats: MemoryHealthStats): string {
  if (!stats.lastConsolidation) return "No consolidations yet";
  const lastConsolidation = stats.lastConsolidation;
  return [
    `Clusters ${formatNumber(lastConsolidation.clustersFound)}`,
    `Merged ${formatNumber(lastConsolidation.entriesMerged)}`,
    `Created ${formatNumber(lastConsolidation.entriesCreated)}`,
  ].join(" • ");
}

function CountStat({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ ...LABEL_STYLE, fontSize: 9 }}>{label}</span>
      <span style={{ fontSize: 16, fontFamily: MONO_FONT, color: COLORS.textPrimary }}>{formatNumber(value)}</span>
    </div>
  );
}

export function MemoryHealthTab() {
  const memoryApi = window.ade.memory;
  const [stats, setStats] = React.useState<MemoryHealthStats>(createEmptyHealthStats());
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [sweepRunning, setSweepRunning] = React.useState(false);
  const [consolidationRunning, setConsolidationRunning] = React.useState(false);
  const [modelSaving, setModelSaving] = React.useState(false);
  const [modelValue, setModelValue] = React.useState(DEFAULT_CONSOLIDATION_MODEL);
  const [modelOptions, setModelOptions] = React.useState<Array<{ id: string; label: string }>>([]);

  const loadDashboard = React.useCallback(async (opts?: { quiet?: boolean }) => {
    if (!memoryApi?.getHealthStats) {
      setLoadError("Memory health is not available in this build.");
      setLoading(false);
      return;
    }

    if (!opts?.quiet) {
      setLoading(true);
    }

    try {
      const [nextStats, aiStatus, snapshot] = await Promise.all([
        memoryApi.getHealthStats(),
        window.ade.ai.getStatus(),
        window.ade.projectConfig.get(),
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
      setModelOptions(configuredModelOptions);
      setModelValue(nextModelValue);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [memoryApi]);

  React.useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  React.useEffect(() => {
    if (!memoryApi?.getHealthStats || loadError || !shouldPollEmbeddings(stats)) return undefined;
    const timer = window.setTimeout(() => {
      void loadDashboard({ quiet: true });
    }, EMBEDDING_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [loadDashboard, loadError, memoryApi, stats]);

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

  const embeddingProgress = getEmbeddingProgress(stats);
  const modelDownloadProgress = getModelDownloadProgress(stats);
  const modelLabel = getModelLabel(stats);
  const showDownloadButton = stats.embeddings.model.state !== "loading" && stats.embeddings.model.state !== "ready";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 980 }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 20, color: COLORS.textPrimary }}>Memory Health</h2>
        <p style={{ marginTop: 6, marginBottom: 0, fontSize: 12, color: COLORS.textMuted, fontFamily: MONO_FONT }}>
          Monitor memory usage, embedding coverage, and recent maintenance activity from one place.
        </p>
      </div>

      {loading ? (
        <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted }}>Loading memory health...</div>
      ) : null}

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

      <section style={cardStyle({ padding: 16 })}>
        <div style={SECTION_LABEL_STYLE}>ENTRY COUNTS</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
          {stats.scopes.map((scope) => (
            <section
              key={scope.scope}
              aria-label={`${scopeLabel(scope.scope)} entry counts`}
              style={{ border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg, padding: 12, display: "flex", flexDirection: "column", gap: 12 }}
            >
              <div style={{ fontSize: 12, fontFamily: MONO_FONT, color: COLORS.textPrimary, fontWeight: 700 }}>{scopeLabel(scope.scope)}</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
                <CountStat label="Tier 1" value={scope.counts.tier1} />
                <CountStat label="Tier 2" value={scope.counts.tier2} />
                <CountStat label="Tier 3" value={scope.counts.tier3} />
                <CountStat label="Archived" value={scope.counts.archived} />
              </div>
            </section>
          ))}
        </div>
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
        <section style={cardStyle({ padding: 16, display: "flex", flexDirection: "column", gap: 10 })}>
          <div style={SECTION_LABEL_STYLE}>LAST SWEEP</div>
          <div style={{ fontSize: 12, fontFamily: MONO_FONT, color: COLORS.textPrimary }}>
            {stats.lastSweep ? formatTimestamp(stats.lastSweep.completedAt) : "No sweeps yet"}
          </div>
          <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: stats.lastSweep ? COLORS.textSecondary : COLORS.textMuted, lineHeight: 1.6 }}>
            {sweepSummary(stats)}
          </div>
        </section>

        <section style={cardStyle({ padding: 16, display: "flex", flexDirection: "column", gap: 10 })}>
          <div style={SECTION_LABEL_STYLE}>LAST CONSOLIDATION</div>
          <div style={{ fontSize: 12, fontFamily: MONO_FONT, color: COLORS.textPrimary }}>
            {stats.lastConsolidation ? formatTimestamp(stats.lastConsolidation.completedAt) : "No consolidations yet"}
          </div>
          <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: stats.lastConsolidation ? COLORS.textSecondary : COLORS.textMuted, lineHeight: 1.6 }}>
            {consolidationSummary(stats)}
          </div>
        </section>
      </div>

      <section style={cardStyle({ padding: 16, display: "flex", flexDirection: "column", gap: 12 })}>
        <div style={SECTION_LABEL_STYLE}>HARD LIMIT USAGE</div>
        {stats.scopes.map((scope) => {
          const label = scopeLabel(scope.scope);
          const percent = clampPercent(scope.current, scope.max);
          return (
            <div key={scope.scope} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textSecondary }}>
                <span>{`${label}: ${formatNumber(scope.current)} / ${formatNumber(scope.max)}`}</span>
                <span>{percent}%</span>
              </div>
              <div
                role="progressbar"
                aria-label={`${label} hard limit usage`}
                aria-valuemin={0}
                aria-valuemax={scope.max}
                aria-valuenow={scope.current}
                style={{ height: 10, background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, overflow: "hidden" }}
              >
                <div style={{ width: `${percent}%`, height: "100%", background: percent >= 80 ? COLORS.warning : COLORS.accent, transition: "width 180ms ease" }} />
              </div>
            </div>
          );
        })}
      </section>

      <section style={cardStyle({ padding: 16, display: "grid", gap: 14 })}>
        <div style={SECTION_LABEL_STYLE}>EMBEDDINGS</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
          <section style={{ border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg, padding: 12, display: "grid", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
              <div style={{ fontSize: 12, fontFamily: MONO_FONT, color: COLORS.textPrimary, fontWeight: 700 }}>
                {`${formatNumber(stats.embeddings.entriesEmbedded)} / ${formatNumber(stats.embeddings.entriesTotal)} entries embedded`}
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
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>
              <span>{stats.embeddings.processing ? `Backfill active • ${formatNumber(stats.embeddings.queueDepth)} queued` : "Backfill idle"}</span>
              <span>{stats.embeddings.lastBatchProcessedAt ? `Last batch ${formatTimestamp(stats.embeddings.lastBatchProcessedAt)}` : "No batches yet"}</span>
            </div>
          </section>

          <section style={{ border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg, padding: 12, display: "grid", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 12, fontFamily: MONO_FONT, color: COLORS.textPrimary, fontWeight: 700 }}>{modelLabel}</div>
                <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, marginTop: 4 }}>
                  {stats.embeddings.model.file ?? stats.embeddings.model.modelId}
                </div>
              </div>
              {showDownloadButton ? (
                <button type="button" onClick={() => void handleDownloadModel()} style={outlineButton({ height: 30, padding: "0 10px", fontSize: 10 })}>
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
                  {`${modelDownloadProgress}%${stats.embeddings.model.loaded != null && stats.embeddings.model.total != null ? ` • ${formatNumber(stats.embeddings.model.loaded)} / ${formatNumber(stats.embeddings.model.total)}` : ""}`}
                </div>
              </>
            ) : stats.embeddings.model.error ? (
              <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.warning }}>{stats.embeddings.model.error}</div>
            ) : null}
          </section>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
          <section style={{ border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg, padding: 12, display: "grid", gap: 4 }}>
            <span style={{ ...LABEL_STYLE, fontSize: 9 }}>Cache size</span>
            <span style={{ fontSize: 16, fontFamily: MONO_FONT, color: COLORS.textPrimary }}>{formatNumber(stats.embeddings.cacheEntries)}</span>
          </section>
          <section style={{ border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg, padding: 12, display: "grid", gap: 4 }}>
            <span style={{ ...LABEL_STYLE, fontSize: 9 }}>Hit rate</span>
            <span style={{ fontSize: 16, fontFamily: MONO_FONT, color: COLORS.textPrimary }}>{formatPercent(stats.embeddings.cacheHitRate)}</span>
          </section>
          <section style={{ border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg, padding: 12, display: "grid", gap: 4 }}>
            <span style={{ ...LABEL_STYLE, fontSize: 9 }}>Cache hits</span>
            <span style={{ fontSize: 16, fontFamily: MONO_FONT, color: COLORS.textPrimary }}>{formatNumber(stats.embeddings.cacheHits)}</span>
          </section>
          <section style={{ border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg, padding: 12, display: "grid", gap: 4 }}>
            <span style={{ ...LABEL_STYLE, fontSize: 9 }}>Cache misses</span>
            <span style={{ fontSize: 16, fontFamily: MONO_FONT, color: COLORS.textPrimary }}>{formatNumber(stats.embeddings.cacheMisses)}</span>
          </section>
        </div>
      </section>

      <section style={cardStyle({ padding: 16, display: "grid", gap: 14 })}>
        <div style={SECTION_LABEL_STYLE}>MAINTENANCE</div>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={LABEL_STYLE}>Consolidation model</span>
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

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => void handleRunSweep()}
            disabled={sweepRunning}
            style={{ ...primaryButton(), opacity: sweepRunning ? 0.7 : 1, cursor: sweepRunning ? "not-allowed" : "pointer" }}
          >
            {sweepRunning ? "Running Sweep..." : "Run Sweep Now"}
          </button>
          <button
            type="button"
            onClick={() => void handleRunConsolidation()}
            disabled={consolidationRunning}
            style={{ ...outlineButton(), opacity: consolidationRunning ? 0.7 : 1, cursor: consolidationRunning ? "not-allowed" : "pointer" }}
          >
            {consolidationRunning ? "Running Consolidation..." : "Run Consolidation Now"}
          </button>
        </div>
      </section>
    </div>
  );
}

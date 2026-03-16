import React, { useEffect, useState, useCallback, useRef } from "react";
import type { MemoryHealthStats } from "../../../shared/types";
import { COLORS, SANS_FONT, MONO_FONT, LABEL_STYLE, inlineBadge } from "../lanes/laneDesignTokens";
import { Button } from "../ui/Button";

/** Poll fast while downloading so the progress bar feels responsive. */
const POLL_DOWNLOADING_MS = 1_500;
const POLL_IDLE_MS = 10_000;

const MODEL_DISPLAY_NAME = "all-MiniLM-L6-v2";
const MODEL_SIZE = "~31 MB";
const MODEL_DIMENSIONS = 384;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function EmbeddingsSection() {
  const [stats, setStats] = useState<MemoryHealthStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const memoryApi = window.ade.memory;

  const loadStats = useCallback(async () => {
    try {
      const s = await memoryApi?.getHealthStats();
      if (s) setStats(s);
    } catch {
      // leave previous stats
    } finally {
      setLoading(false);
    }
  }, [memoryApi]);

  useEffect(() => { void loadStats(); }, [loadStats]);

  // Poll — fast while downloading, slow otherwise
  useEffect(() => {
    if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; }
    const isDownloading = stats?.embeddings.model.state === "loading";
    const interval = isDownloading ? POLL_DOWNLOADING_MS : POLL_IDLE_MS;
    if (isDownloading || stats?.embeddings.model.state === "idle") {
      pollRef.current = setTimeout(() => { void loadStats(); }, interval);
    }
    return () => { if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; } };
  }, [stats?.embeddings.model.state, loadStats]);

  const handleDownload = useCallback(async () => {
    setActionError(null);
    try {
      const s = await memoryApi?.downloadEmbeddingModel();
      if (s) setStats(s);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const model = stats?.embeddings.model;
  const state = model?.state ?? "idle";

  const downloadPct = (() => {
    if (!model) return 0;
    const { progress, loaded, total } = model;
    if (typeof progress === "number" && Number.isFinite(progress)) return Math.max(0, Math.min(100, Math.round(progress)));
    if (typeof loaded === "number" && typeof total === "number" && total > 0) return Math.round((loaded / total) * 100);
    return 0;
  })();

  const bytesLabel = (() => {
    if (!model) return null;
    const { loaded: ld, total: tt } = model;
    if (typeof ld === "number" && typeof tt === "number" && tt > 0) {
      return `${formatBytes(ld)} / ${formatBytes(tt)}`;
    }
    return null;
  })();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={cardStyle()}>
        <div style={{ fontSize: 14, fontWeight: 600, fontFamily: SANS_FONT, color: COLORS.textPrimary, marginBottom: 6 }}>
          Local embedding model
        </div>
        <div style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: "20px", marginBottom: 16 }}>
          Download a small model ({MODEL_SIZE}) that runs entirely on your machine.
          It converts text into {MODEL_DIMENSIONS}-dimensional vectors so ADE can find semantically similar memories
          — not just exact keyword matches.
          This is <strong style={{ color: COLORS.textSecondary }}>optional</strong> — basic text search works without it.
        </div>

        {/* Model details row */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: 12,
            padding: 12,
            background: COLORS.recessedBg,
            borderRadius: 8,
            marginBottom: 16,
          }}
        >
          <div>
            <div style={LABEL_STYLE}>MODEL</div>
            <div style={{ marginTop: 4, fontSize: 12, fontFamily: MONO_FONT, color: COLORS.textPrimary }}>
              {MODEL_DISPLAY_NAME}
            </div>
          </div>
          <div>
            <div style={LABEL_STYLE}>DIMENSIONS</div>
            <div style={{ marginTop: 4, fontSize: 12, fontFamily: MONO_FONT, color: COLORS.textPrimary }}>
              {MODEL_DIMENSIONS}
            </div>
          </div>
          <div>
            <div style={LABEL_STYLE}>RUNS</div>
            <div style={{ marginTop: 4, fontSize: 12, fontFamily: MONO_FONT, color: COLORS.textPrimary }}>
              Locally (CPU)
            </div>
          </div>
        </div>

        {loading && !stats ? (
          <div style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textDim }}>Checking model status...</div>
        ) : state === "ready" ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={inlineBadge(COLORS.success)}>READY</span>
            <span style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textSecondary }}>
              Semantic search is active — {MODEL_DISPLAY_NAME} loaded
            </span>
          </div>
        ) : state === "loading" ? (
          <div>
            <div style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.info, marginBottom: 8 }}>
              {model?.file
                ? <>Downloading <span style={{ fontFamily: MONO_FONT }}>{model.file}</span>...</>
                : "Downloading model files..."}
            </div>
            <div style={{ height: 6, borderRadius: 3, background: "rgba(255,255,255,0.06)", overflow: "hidden" }}>
              <div
                style={{
                  height: "100%",
                  borderRadius: 3,
                  width: `${downloadPct}%`,
                  background: COLORS.info,
                  transition: "width 0.4s ease",
                }}
              />
            </div>
            <div style={{ marginTop: 4, display: "flex", justifyContent: "space-between", fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim }}>
              <span>{downloadPct}%</span>
              {bytesLabel ? <span>{bytesLabel}</span> : null}
            </div>
          </div>
        ) : (
          <div>
            <Button size="md" variant="primary" onClick={() => void handleDownload()}>
              Download model
            </Button>
          </div>
        )}

        {model?.error && state !== "loading" ? (
          <div style={{ marginTop: 10, fontSize: 11, fontFamily: SANS_FONT, color: COLORS.warning, lineHeight: "18px" }}>
            {model.error}
            <span style={{ marginLeft: 8 }}>
              <Button size="sm" variant="outline" onClick={() => void handleDownload()}>Retry</Button>
            </span>
          </div>
        ) : null}

        {actionError ? (
          <div style={{ marginTop: 10, fontSize: 11, fontFamily: SANS_FONT, color: COLORS.danger, lineHeight: "18px" }}>
            {actionError}
          </div>
        ) : null}
      </div>

      {/* How it works explainer */}
      <div style={cardStyle()}>
        <div style={{ fontSize: 13, fontWeight: 600, fontFamily: SANS_FONT, color: COLORS.textPrimary, marginBottom: 8 }}>
          How it works
        </div>
        <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: "20px" }}>
          When you save a memory, ADE converts the text into a numerical vector using this model.
          Later, when you search, your query is also vectorized and compared against stored vectors
          to find results that are semantically related — even if the exact words don't match.
          Everything runs locally; no data leaves your machine.
        </div>
      </div>
    </div>
  );
}

function cardStyle(): React.CSSProperties {
  return {
    padding: 18,
    background: COLORS.cardBg,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 14,
  };
}

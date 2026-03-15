import React, { useEffect, useState, useCallback, useRef } from "react";
import type { MemoryHealthStats } from "../../../shared/types";
import { COLORS, SANS_FONT, MONO_FONT, inlineBadge } from "../lanes/laneDesignTokens";
import { Button } from "../ui/Button";

const POLL_MS = 10_000;

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

  // Poll while loading model
  useEffect(() => {
    if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; }
    if (stats?.embeddings.model.state === "loading") {
      pollRef.current = setTimeout(() => { void loadStats(); }, POLL_MS);
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

  return (
    <div style={cardStyle()}>
      <div style={{ fontSize: 14, fontWeight: 600, fontFamily: SANS_FONT, color: COLORS.textPrimary, marginBottom: 6 }}>
        Local embedding model
      </div>
      <div style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: "20px", marginBottom: 16 }}>
        Download a small model (~30 MB) that runs locally to enable meaning-based memory search.
        This is <strong style={{ color: COLORS.textSecondary }}>optional</strong> — text search works without it.
      </div>

      {loading && !stats ? (
        <div style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textDim }}>Checking model status...</div>
      ) : state === "ready" ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={inlineBadge(COLORS.success)}>READY</span>
          <span style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textSecondary }}>
            Smart search is active
          </span>
        </div>
      ) : state === "loading" ? (
        <div>
          <div style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.info, marginBottom: 8 }}>
            Downloading model...
          </div>
          <div style={{ height: 6, borderRadius: 3, background: "rgba(255,255,255,0.06)", overflow: "hidden" }}>
            <div
              style={{
                height: "100%",
                borderRadius: 3,
                width: `${downloadPct}%`,
                background: COLORS.info,
                transition: "width 0.3s ease",
              }}
            />
          </div>
          <div style={{ marginTop: 4, fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim }}>
            {downloadPct}%
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

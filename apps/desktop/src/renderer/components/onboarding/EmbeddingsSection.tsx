import React, { useEffect, useState, useCallback, useRef } from "react";
import { Brain, Cube, Desktop, MagnifyingGlass, ShieldCheck, TextT } from "@phosphor-icons/react";
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

function getVisualState(model: MemoryHealthStats["embeddings"]["model"] | null | undefined) {
  if (!model) return "missing" as const;
  if (model.state === "ready") return "ready" as const;
  if (model.state === "loading" && (model.activity === "loading-local" || model.installState === "installed")) return "loading-local" as const;
  if (model.state === "loading") return "downloading" as const;
  if (model.state === "unavailable") return "error" as const;
  if (model.installState === "installed") return "installed" as const;
  if (model.installState === "partial") return "partial" as const;
  return "missing" as const;
}

function ProgressBar({
  value,
  max,
  color,
  label,
  description,
}: {
  value: number;
  max: number;
  color: string;
  label: string;
  description?: string | null;
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, Math.round((value / max) * 100))) : 0;
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
        <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textSecondary, lineHeight: "18px" }}>
          {label}
        </div>
        {description ? (
          <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim, lineHeight: "16px" }}>
            {description}
          </div>
        ) : null}
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={description ? `${pct}% complete, ${description}` : `${pct}% complete`}
        style={{ height: 10, background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, overflow: "hidden" }}
      >
        <div style={{ width: `${pct}%`, height: "100%", background: color, transition: "width 180ms ease" }} />
      </div>
    </div>
  );
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

  // Poll -- fast while downloading, slow otherwise
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
  }, [memoryApi]);

  const model = stats?.embeddings.model;
  const state = model?.state ?? "idle";
  const visualState = getVisualState(model);
  const installPath = model?.installPath ?? model?.cacheDir ?? null;
  const installPathLabel = visualState === "ready"
    ? "VERIFIED AT"
    : model?.installState === "installed"
      ? "FOUND ON DISK AT"
      : model?.installState === "partial"
      ? "PARTIAL DOWNLOAD AT"
      : "INSTALLS TO";
  const installPathHelp = visualState === "ready"
    ? "ADE loaded and verified this machine-wide model install. Future projects reuse the same cache path."
    : model?.installState === "installed"
      ? "ADE detected model files at this machine-wide cache path. Smart search turns ready only after ADE loads and verifies them locally."
      : model?.installState === "partial"
      ? "ADE found partially downloaded model files here. Repairing the download finishes the install for every project on this machine."
      : "ADE stores the model under this ADE app-data path on your machine. Future projects reuse the same install.";
  const actionLabel =
    model?.installState === "partial" || (model?.state === "unavailable" && model?.installState === "installed")
      ? "Repair model"
      : model?.installState === "installed"
        ? "Verify model"
      : "Download model";

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

        {/* Visual flow diagram */}
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 0,
          padding: "14px 12px",
          background: COLORS.recessedBg,
          borderRadius: 10,
          marginBottom: 16,
        }}>
          <FlowBox icon={<TextT size={18} weight="duotone" style={{ color: COLORS.accent }} />} label="Your Text" />
          <FlowArrow />
          <FlowBox icon={<Brain size={18} weight="duotone" style={{ color: COLORS.info }} />} label="Vector Model" />
          <FlowArrow />
          <FlowBox icon={<MagnifyingGlass size={18} weight="duotone" style={{ color: COLORS.success }} />} label="Smart Search" />
        </div>

        {/* Model details row with icon badges */}
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
            <div style={{ ...LABEL_STYLE, display: "flex", alignItems: "center", gap: 5 }}>
              <Brain size={11} weight="bold" style={{ color: COLORS.textMuted }} />
              MODEL
            </div>
            <div style={{ marginTop: 4, fontSize: 12, fontFamily: MONO_FONT, color: COLORS.textPrimary }}>
              {MODEL_DISPLAY_NAME}
            </div>
          </div>
          <div>
            <div style={{ ...LABEL_STYLE, display: "flex", alignItems: "center", gap: 5 }}>
              <Cube size={11} weight="bold" style={{ color: COLORS.textMuted }} />
              DIMENSIONS
            </div>
            <div style={{ marginTop: 4, fontSize: 12, fontFamily: MONO_FONT, color: COLORS.textPrimary }}>
              {MODEL_DIMENSIONS}
            </div>
          </div>
          <div>
            <div style={{ ...LABEL_STYLE, display: "flex", alignItems: "center", gap: 5 }}>
              <Desktop size={11} weight="bold" style={{ color: COLORS.textMuted }} />
              RUNS
            </div>
            <div style={{ marginTop: 4, fontSize: 12, fontFamily: MONO_FONT, color: COLORS.textPrimary }}>
              Locally (CPU)
            </div>
          </div>
        </div>

        {installPath ? (
          <div
            style={{
              padding: 12,
              background: COLORS.recessedBg,
              borderRadius: 8,
              marginBottom: 16,
              display: "grid",
              gap: 6,
            }}
          >
            <div style={LABEL_STYLE}>{installPathLabel}</div>
            <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textPrimary, lineHeight: "18px", wordBreak: "break-all" }}>
              {installPath}
            </div>
            <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: "18px" }}>
              {installPathHelp}
            </div>
          </div>
        ) : null}

        {loading && !stats ? (
          <div style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textDim }}>Checking model status...</div>
        ) : visualState === "ready" ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={inlineBadge(COLORS.success)}>READY</span>
            <span style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textSecondary }}>
              Semantic search is active — {MODEL_DISPLAY_NAME} loaded
            </span>
          </div>
        ) : visualState === "installed" ? (
          <div style={{ display: "grid", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={inlineBadge(COLORS.info)}>ON DISK</span>
              <span style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textSecondary }}>
                ADE found model files on this machine. Smart search only shows Ready after the model loads and passes a local verification check.
              </span>
            </div>
            <div>
              <Button size="md" variant="primary" onClick={() => void handleDownload()}>
                {actionLabel}
              </Button>
            </div>
          </div>
        ) : visualState === "loading-local" ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={inlineBadge(COLORS.info)}>LOADING</span>
            <span style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textSecondary }}>
              Found the installed model on this machine. ADE is loading it from local cache without downloading it again.
              This usually finishes in a few seconds and continues in the background if you leave setup.
            </span>
          </div>
        ) : visualState === "downloading" ? (
          <div>
            <div style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.info, marginBottom: 8 }}>
              {model?.file
                ? <>Downloading <span style={{ fontFamily: MONO_FONT }}>{model.file}</span>...</>
                : "Downloading model files..."}
            </div>
            <ProgressBar
              key={model?.modelId ?? "embedding-download-progress"}
              value={downloadPct}
              max={100}
              color={COLORS.info}
              label={model?.file ? `Downloading ${model.file}` : "Downloading model files"}
              description={bytesLabel}
            />
            <div style={{ marginTop: 4, display: "flex", justifyContent: "space-between", fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim }}>
              <span>{downloadPct}%</span>
              {bytesLabel ? <span>{bytesLabel}</span> : null}
            </div>
          </div>
        ) : visualState === "partial" ? (
          <div style={{ display: "grid", gap: 10 }}>
            <div style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.warning, lineHeight: "18px" }}>
              ADE found a partial model download on this machine. Repair it to finish enabling semantic search.
            </div>
            <div>
              <Button size="md" variant="primary" onClick={() => void handleDownload()}>
                {actionLabel}
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <Button size="md" variant="primary" onClick={() => void handleDownload()}>
              {actionLabel}
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
      <div style={{
        ...cardStyle(),
        borderLeft: `3px solid ${COLORS.info}`,
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, fontFamily: SANS_FONT, color: COLORS.textPrimary, marginBottom: 8 }}>
          How it works
        </div>
        <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: "20px" }}>
          When you save a memory, ADE converts the text into a numerical vector using this model.
          Later, when you search, your query is also vectorized and compared against stored vectors
          to find results that are semantically related — even if the exact words don't match.
        </div>
      </div>

      {/* Privacy note */}
      <div style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        padding: "12px 14px",
        background: `${COLORS.success}06`,
        border: `1px solid ${COLORS.success}15`,
        borderRadius: 10,
      }}>
        <ShieldCheck size={16} weight="duotone" style={{ color: COLORS.success, flexShrink: 0, marginTop: 1 }} />
        <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textSecondary, lineHeight: "18px" }}>
          <strong style={{ color: COLORS.textPrimary, fontWeight: 500 }}>Privacy.</strong>{" "}
          All processing happens locally on your machine. No data leaves your device — embeddings are computed and stored entirely offline.
        </div>
      </div>
    </div>
  );
}

function FlowBox({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 6,
      padding: "10px 18px",
      background: "rgba(255,255,255,0.04)",
      border: `1px solid ${COLORS.border}`,
      borderRadius: 10,
      minWidth: 90,
    }}>
      {icon}
      <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textSecondary, fontWeight: 500, whiteSpace: "nowrap" }}>
        {label}
      </div>
    </div>
  );
}

function FlowArrow() {
  return (
    <div style={{
      width: 32,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      color: COLORS.textDim,
      fontSize: 14,
      fontFamily: SANS_FONT,
    }}>
      →
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

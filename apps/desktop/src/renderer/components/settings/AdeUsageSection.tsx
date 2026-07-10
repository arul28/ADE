import React from "react";
import {
  ArrowClockwise,
  ChartLineUp,
  GitBranch,
  GitPullRequest,
  Robot,
  WarningCircle,
} from "@phosphor-icons/react";
import type {
  AdeUsageModelSummary,
  AdeUsageProviderSummary,
  AdeUsageRangePreset,
  AdeUsageStats,
} from "../../../shared/types";
import { formatCost, formatTokens, relativeTimeCompact } from "../../lib/format";
import {
  COLORS,
  LABEL_STYLE,
  MONO_FONT,
  SANS_FONT,
  outlineButton,
} from "../lanes/laneDesignTokens";
import { UsageActivityCarousel } from "../usage/UsageActivityCarousel";

const ACCENT = {
  tokens: "#60A5FA",
  code: "#63D471",
  pr: "#A78BFA",
  cost: "#FBBF24",
} as const;

const RANGE_OPTIONS: Array<{ preset: AdeUsageRangePreset; label: string }> = [
  { preset: "today", label: "Today" },
  { preset: "7d", label: "7 days" },
  { preset: "30d", label: "30 days" },
  { preset: "year", label: "Year" },
  { preset: "all", label: "All time" },
];

const PANEL_STYLE: React.CSSProperties = {
  background: "color-mix(in srgb, var(--color-card) 88%, var(--color-bg) 12%)",
  border: "1px solid color-mix(in srgb, var(--color-border) 82%, transparent)",
  borderRadius: 8,
  padding: 16,
};

const usageStatsCache = new Map<string, AdeUsageStats>();

function statsCacheKey(scope: string, preset: AdeUsageRangePreset): string {
  return `${scope}:${preset}`;
}

function cacheScopeFromProject(project: { rootPath?: string | null } | null | undefined): string {
  return project?.rootPath?.trim() || "browser-preview";
}

function formatWhole(value: number): string {
  return Math.max(0, Math.floor(value || 0)).toLocaleString();
}

function formatUsd(value: number): string {
  return value > 0 ? formatCost(value) : "$0.00";
}

function humanizeProvider(provider: string): string {
  const known: Record<string, string> = {
    anthropic: "Anthropic",
    claude: "Claude",
    codex: "Codex",
    copilot: "Copilot",
    cursor: "Cursor",
    "cursor-agent": "Cursor Agent",
    deepseek: "DeepSeek",
    droid: "Droid",
    gemini: "Gemini",
    google: "Google",
    lmstudio: "LM Studio",
    mistral: "Mistral",
    ollama: "Ollama",
    opencode: "OpenCode",
    openai: "OpenAI",
    openclaw: "OpenClaw",
    openrouter: "OpenRouter",
    xai: "xAI",
  };
  const normalized = provider.trim().toLowerCase();
  return known[normalized] ?? provider
    .split(/[-_/\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function compactRange(stats: AdeUsageStats | null): string {
  if (!stats) return "";
  const since = stats.range.since ? new Date(stats.range.since) : null;
  const until = new Date(stats.range.until);
  if (!since || Number.isNaN(since.getTime())) return "All time";
  if (Number.isNaN(until.getTime())) return "";
  return `${since.toLocaleDateString([], { month: "short", day: "numeric" })} - ${until.toLocaleDateString([], { month: "short", day: "numeric" })}`;
}

function StatCard({
  label,
  value,
  detail,
  accent,
  icon,
}: {
  label: string;
  value: string;
  detail: string;
  accent: string;
  icon: React.ReactNode;
}) {
  return (
    <div style={{ ...PANEL_STYLE, minHeight: 112, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ ...LABEL_STYLE, textTransform: "uppercase", letterSpacing: 0.8 }}>{label}</div>
        <div style={{ color: accent, display: "flex" }}>{icon}</div>
      </div>
      <div>
        <div style={{ fontFamily: MONO_FONT, fontSize: 24, fontWeight: 700, color: COLORS.textPrimary, lineHeight: 1.05 }}>
          {value}
        </div>
        <div style={{ marginTop: 8, fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted, lineHeight: 1.35 }}>
          {detail}
        </div>
      </div>
    </div>
  );
}

function SectionHeader({ label, detail }: { label: string; detail?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16 }}>
      <h2 style={{ margin: 0, fontFamily: SANS_FONT, fontSize: 14, fontWeight: 700, color: COLORS.textPrimary }}>
        {label}
      </h2>
      {detail ? (
        <span style={{ ...LABEL_STYLE, fontFamily: MONO_FONT, letterSpacing: 0.6, textAlign: "right" }}>
          {detail}
        </span>
      ) : null}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 12, padding: "8px 0" }}>
      <WarningCircle size={14} />
      <span>{text}</span>
    </div>
  );
}

function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.max(2, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div style={{ height: 6, background: "color-mix(in srgb, var(--color-fg) 8%, transparent)", borderRadius: 3, overflow: "hidden" }}>
      <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 3 }} />
    </div>
  );
}

function ProviderBreakdown({
  providers,
  models,
}: {
  providers: AdeUsageProviderSummary[];
  models: AdeUsageModelSummary[];
}) {
  const topModels = models.slice(0, 8);
  const maxProvider = Math.max(1, ...providers.map((provider) => provider.totalTokens));
  const maxModel = Math.max(1, ...topModels.map((model) => model.totalTokens));

  return (
    <section style={PANEL_STYLE}>
      <SectionHeader label="AI usage" detail="Providers and models" />
      <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 14 }}>
        {providers.length === 0 ? (
          <EmptyState text="No local AI usage found for this range." />
        ) : providers.map((provider) => (
          <div key={provider.provider} style={{ display: "grid", gridTemplateColumns: "112px minmax(0, 1fr) 92px", gap: 12, alignItems: "center" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontFamily: SANS_FONT, fontSize: 12, fontWeight: 650, color: COLORS.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {humanizeProvider(provider.provider)}
              </div>
              <div style={{ fontFamily: MONO_FONT, fontSize: 9, color: COLORS.textMuted }}>
                {formatUsd(provider.rangeCostUsd)}
              </div>
            </div>
            <Bar value={provider.totalTokens} max={maxProvider} color={provider.provider === "claude" ? "#D97757" : ACCENT.tokens} />
            <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textSecondary, textAlign: "right" }}>
              {formatTokens(provider.totalTokens)}
            </div>
          </div>
        ))}
      </div>

      {topModels.length > 0 ? (
        <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${COLORS.borderMuted}`, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ ...LABEL_STYLE, textTransform: "uppercase", letterSpacing: 0.8 }}>Top models</div>
          {topModels.map((model) => (
            <div key={`${model.provider}:${model.model}`} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 96px", gap: 12, alignItems: "center" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                  <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textSecondary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {model.model}
                  </span>
                  <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textMuted, flexShrink: 0 }}>
                    {formatTokens(model.totalTokens)}
                  </span>
                </div>
                <div style={{ marginTop: 5 }}>
                  <Bar value={model.totalTokens} max={maxModel} color={model.provider === "claude" ? "#D97757" : ACCENT.tokens} />
                </div>
              </div>
              <div style={{ fontFamily: MONO_FONT, fontSize: 9, color: COLORS.textMuted, textAlign: "right" }}>
                {formatUsd(model.costUsd)}<br />
                {formatTokens(model.inputTokens)} in / {formatTokens(model.outputTokens)} out
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function GithubBreakdown({ stats }: { stats: AdeUsageStats }) {
  const summary = stats.summary;
  const totalCode = summary.insertions + summary.deletions;
  const maxLine = Math.max(1, summary.insertions, summary.deletions, summary.filesChanged);
  const repoLabel = stats.github.repo ?? "GitHub";
  const githubLoading = stats.github.error === "GitHub activity is still loading.";

  return (
    <section style={PANEL_STYLE}>
      <SectionHeader label="Code activity" detail={stats.github.available ? repoLabel : githubLoading ? "Loading GitHub + local history" : "ADE local history"} />
      <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10, marginTop: 14 }}>
            <MiniMetric label="Commits" value={formatWhole(summary.commitsCreated)} accent={ACCENT.cost} />
            <MiniMetric label="PRs" value={formatWhole(summary.prsTracked)} accent={ACCENT.pr} />
            <MiniMetric label="Merged" value={formatWhole(summary.prsMerged)} accent={ACCENT.pr} />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 18 }}>
            <ChangeRow label="Additions" value={summary.insertions} max={maxLine} color={ACCENT.code} />
            <ChangeRow label="Deletions" value={summary.deletions} max={maxLine} color="#F87171" />
            <ChangeRow label="Files changed" value={summary.filesChanged} max={maxLine} color={ACCENT.tokens} />
          </div>

          <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${COLORS.borderMuted}`, display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
            <Fact label="Open PRs" value={formatWhole(summary.prsOpen)} />
            <Fact label="Code movement" value={formatWhole(totalCode)} />
          </div>
          {!stats.github.available ? (
            <div style={{ marginTop: 12, fontFamily: SANS_FONT, fontSize: 10, color: COLORS.textMuted }}>
              {githubLoading ? "GitHub activity is still loading; local ADE history is shown now." : "GitHub is unavailable; local ADE history is shown."}
            </div>
          ) : null}
        </>
    </section>
  );
}

function MiniMetric({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div style={{ border: `1px solid ${COLORS.borderMuted}`, borderRadius: 8, padding: 12, background: "color-mix(in srgb, var(--color-card) 70%, transparent)" }}>
      <div style={{ ...LABEL_STYLE, textTransform: "uppercase", letterSpacing: 0.7 }}>{label}</div>
      <div style={{ marginTop: 8, fontFamily: MONO_FONT, fontSize: 18, fontWeight: 700, color: accent }}>{value}</div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontFamily: MONO_FONT, fontSize: 15, color: COLORS.textPrimary, fontWeight: 700 }}>{value}</div>
      <div style={{ marginTop: 3, fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted }}>{label}</div>
    </div>
  );
}

function ChangeRow({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "104px minmax(0, 1fr) 78px", gap: 12, alignItems: "center" }}>
      <span style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textSecondary }}>{label}</span>
      <Bar value={value} max={max} color={color} />
      <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textSecondary, textAlign: "right" }}>{formatWhole(value)}</span>
    </div>
  );
}

export function AdeUsageSection() {
  const [preset, setPreset] = React.useState<AdeUsageRangePreset>("7d");
  const [cacheScope, setCacheScope] = React.useState<string | null>(null);
  const [stats, setStats] = React.useState<AdeUsageStats | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const loadSeqRef = React.useRef(0);

  const loadStats = React.useCallback(async (nextPreset: AdeUsageRangePreset, scope: string, force = false) => {
    const loadSeq = loadSeqRef.current + 1;
    loadSeqRef.current = loadSeq;
    const key = statsCacheKey(scope, nextPreset);
    const cached = usageStatsCache.get(key);
    if (cached) {
      setStats(cached);
      setLoading(false);
    } else {
      setStats(null);
      setLoading(true);
    }

    try {
      setError(null);
      if (force) {
        setRefreshing(true);
        await window.ade?.usage?.refresh?.();
      }
      const result = await window.ade?.usage?.getAdeStats?.({ preset: nextPreset });
      if (!result) {
        throw new Error("Stats are unavailable.");
      }
      if (loadSeqRef.current === loadSeq) {
        usageStatsCache.set(key, result);
        setStats(result);
      }
    } catch (err) {
      if (loadSeqRef.current === loadSeq) {
        if (cached && !force) {
          setError(null);
          setStats(cached);
        } else {
          usageStatsCache.delete(key);
          setError(err instanceof Error ? err.message : String(err));
          setStats(null);
        }
      }
    } finally {
      if (loadSeqRef.current === loadSeq) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  React.useEffect(() => {
    let mounted = true;
    const applyProject = (project: { rootPath?: string | null } | null) => {
      if (!mounted) return;
      loadSeqRef.current += 1;
      setCacheScope(cacheScopeFromProject(project));
      setStats(null);
      setLoading(true);
      setError(null);
    };

    if (!window.ade?.app?.getProject) {
      applyProject(null);
      return () => {
        mounted = false;
      };
    }

    void window.ade.app.getProject()
      .then(applyProject)
      .catch(() => applyProject(null));
    const unsubscribe = window.ade.app.onProjectChanged?.(applyProject);
    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, []);

  React.useEffect(() => {
    if (!cacheScope) return;
    void loadStats(preset, cacheScope, false);
  }, [cacheScope, loadStats, preset]);

  React.useEffect(() => {
    if (!cacheScope) return;
    if (stats?.freshness?.state !== "refreshing") return;
    const timeout = window.setTimeout(() => {
      void loadStats(preset, cacheScope, false);
    }, 3_500);
    return () => window.clearTimeout(timeout);
  }, [cacheScope, loadStats, preset, stats?.freshness?.state, stats?.generatedAt]);

  const summary = stats?.summary;
  const providerCount = stats?.providers.length ?? 0;
  const modelCount = stats?.models.length ?? 0;
  const topProvider = stats?.providers[0] ? humanizeProvider(stats.providers[0].provider) : "No providers";
  const updatedLabel = stats?.generatedAt ? relativeTimeCompact(stats.generatedAt) : "";
  const rangeLabel = compactRange(stats);
  const loadingEmpty = loading && !stats;
  const headerDetail = [
    "ADE activity across desktop, mobile, terminal, and web",
    rangeLabel,
    updatedLabel ? `updated ${updatedLabel}` : "",
  ].filter(Boolean).join(" / ");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div>
          <div style={{ ...LABEL_STYLE, textTransform: "uppercase", letterSpacing: 1.3, marginBottom: 8 }}>Settings</div>
          <h1 style={{ margin: 0, fontFamily: SANS_FONT, fontSize: 26, lineHeight: 1.1, color: COLORS.textPrimary }}>
            Stats
          </h1>
          <div style={{ marginTop: 8, fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted }}>
            {headerDetail}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", justifyContent: "flex-end", maxWidth: "100%" }}>
          <div style={{ display: "flex", flexWrap: "wrap", border: `1px solid ${COLORS.borderMuted}`, borderRadius: 8, overflow: "hidden", maxWidth: "100%" }}>
            {RANGE_OPTIONS.map((option) => {
              const active = preset === option.preset;
              return (
                <button
                  key={option.preset}
                  type="button"
                  onClick={() => setPreset(option.preset)}
                  style={{
                    border: "none",
                    borderRight: option.preset === "all" ? "none" : `1px solid ${COLORS.borderMuted}`,
                    background: active ? COLORS.textPrimary : "transparent",
                    color: active ? COLORS.pageBg : COLORS.textSecondary,
                    fontFamily: SANS_FONT,
                    fontSize: 12,
                    fontWeight: 650,
                    padding: "9px 14px",
                    cursor: "pointer",
                  }}
                >
                  {option.label}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => cacheScope && loadStats(preset, cacheScope, true)}
            disabled={refreshing || !cacheScope}
            style={{ ...outlineButton, height: 37, display: "inline-flex", alignItems: "center", gap: 8, opacity: refreshing ? 0.7 : 1 }}
          >
            <ArrowClockwise size={14} />
            {refreshing ? "Refreshing" : "Refresh"}
          </button>
        </div>
      </header>

      {error ? <EmptyState text={error} /> : null}

      <UsageActivityCarousel
        stats={stats}
        loading={loadingEmpty}
        preset={preset}
        onPresetChange={setPreset}
      />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 14 }}>
        <StatCard
          label="AI tokens"
          value={summary ? formatTokens(summary.totalTokens) : loading ? "..." : "0"}
          detail={summary ? `${formatTokens(summary.observedProviderInputTokens)} input / ${formatTokens(summary.observedProviderOutputTokens)} output / ${formatTokens(summary.observedProviderCachedTokens)} cached` : "Waiting for local scans"}
          accent={ACCENT.tokens}
          icon={<ChartLineUp size={18} />}
        />
        <StatCard
          label="Estimated cost"
          value={summary ? formatUsd(summary.observedProviderCostRangeUsd) : loading ? "..." : "$0.00"}
          detail={summary ? `${formatUsd(summary.observedProviderCostTodayUsd)} today / ${formatUsd(summary.observedProviderCost30dUsd)} 30d` : "Provider pricing registry"}
          accent={ACCENT.cost}
          icon={<Robot size={18} />}
        />
        <StatCard
          label="Code movement"
          value={summary ? formatWhole(summary.insertions + summary.deletions) : "0"}
          detail={summary ? `${formatWhole(summary.insertions)} added / ${formatWhole(summary.deletions)} deleted / ${formatWhole(summary.filesChanged)} files` : "ADE and GitHub activity"}
          accent={ACCENT.code}
          icon={<GitBranch size={18} />}
        />
        <StatCard
          label="Pull requests"
          value={summary ? formatWhole(summary.prsTracked) : "0"}
          detail={summary ? `${formatWhole(summary.prsMerged)} merged / ${formatWhole(summary.prsOpen)} open / ${formatWhole(summary.commitsCreated)} commits` : "ADE and GitHub activity"}
          accent={ACCENT.pr}
          icon={<GitPullRequest size={18} />}
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14 }}>
        {loadingEmpty ? (
          <section style={PANEL_STYLE}><EmptyState text="Loading local AI usage." /></section>
        ) : (
          <ProviderBreakdown providers={stats?.providers ?? []} models={stats?.models ?? []} />
        )}
        {stats ? <GithubBreakdown stats={stats} /> : <section style={PANEL_STYLE}><EmptyState text="Loading GitHub activity." /></section>}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 14 }}>
        <StatCard
          label="Providers"
          value={formatWhole(providerCount)}
          detail={topProvider}
          accent={ACCENT.tokens}
          icon={<Robot size={18} />}
        />
        <StatCard
          label="Models"
          value={formatWhole(modelCount)}
          detail={stats?.models[0]?.model ?? "No model usage in range"}
          accent={ACCENT.pr}
          icon={<ChartLineUp size={18} />}
        />
      </div>
    </div>
  );
}

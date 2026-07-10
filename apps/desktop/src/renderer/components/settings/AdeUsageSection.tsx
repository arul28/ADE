import React from "react";
import {
  ArrowClockwise,
  ChartLineUp,
  GitBranch,
  GitPullRequest,
  Robot,
} from "@phosphor-icons/react";
import type {
  AdeUsageModelSummary,
  AdeUsageProviderSummary,
  AdeUsageRangePreset,
  AdeUsageScope,
  AdeUsageStats,
} from "../../../shared/types";
import { formatCost, formatTokens, relativeTimeCompact } from "../../lib/format";
import {
  COLORS,
  LABEL_STYLE,
  SANS_FONT,
  outlineButton,
} from "../lanes/laneDesignTokens";
import { useAppStore } from "../../state/appStore";
import { ActivityModule } from "../usage/ActivityModule";
import { providerColor } from "../usage/providerColors";

const SCOPE_STORAGE_KEY = "ade.stats.scope.v1";

const RANGE_OPTIONS: Array<{ preset: AdeUsageRangePreset; label: string }> = [
  { preset: "today", label: "Today" },
  { preset: "7d", label: "7d" },
  { preset: "30d", label: "30d" },
  { preset: "year", label: "Year" },
  { preset: "all", label: "All" },
];

const PANEL_STYLE: React.CSSProperties = {
  background: "color-mix(in srgb, var(--color-card) 90%, var(--color-bg) 10%)",
  border: "1px solid color-mix(in srgb, var(--color-border) 78%, transparent)",
  borderRadius: 10,
  padding: 16,
};

const usageStatsCache = new Map<string, AdeUsageStats>();

function statsCacheKey(scope: string, sourceScope: AdeUsageScope, preset: AdeUsageRangePreset): string {
  return `${scope}:${sourceScope}:${preset}`;
}

function cacheScopeFromProject(project: { rootPath?: string | null } | null | undefined): string {
  return project?.rootPath?.trim() || "browser-preview";
}

function readScope(): AdeUsageScope {
  if (typeof localStorage === "undefined") return "project";
  const value = localStorage.getItem(SCOPE_STORAGE_KEY);
  return value === "machine" ? "machine" : "project";
}

function persistScope(scope: AdeUsageScope): void {
  try {
    localStorage.setItem(SCOPE_STORAGE_KEY, scope);
  } catch {
    // best-effort
  }
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

function estimationNote(kind: AdeUsageProviderSummary["estimation"]): string | null {
  switch (kind) {
    case "chars":
      return "estimated from text length";
    case "distribution":
      return "daily split estimated";
    case "mixed":
      return "partly estimated";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function StatTile({
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
    <div style={{ ...PANEL_STYLE, minHeight: 108, display: "flex", flexDirection: "column", justifyContent: "space-between", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ fontFamily: SANS_FONT, fontSize: 12, fontWeight: 500, color: COLORS.textMuted }}>{label}</div>
        <div style={{ color: accent, display: "flex" }}>{icon}</div>
      </div>
      <div>
        <div style={{ fontFamily: SANS_FONT, fontSize: 26, fontWeight: 700, color: COLORS.textPrimary, lineHeight: 1.05, fontVariantNumeric: "tabular-nums" }}>
          {value}
        </div>
        <div style={{ marginTop: 6, fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted, lineHeight: 1.35 }}>
          {detail}
        </div>
      </div>
    </div>
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <h2 style={{ margin: "0 0 12px", fontFamily: SANS_FONT, fontSize: 13, fontWeight: 650, color: COLORS.textPrimary }}>
      {label}
    </h2>
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

function AiUsage({
  providers,
  models,
  theme,
}: {
  providers: AdeUsageProviderSummary[];
  models: AdeUsageModelSummary[];
  theme: "dark" | "light";
}) {
  const topModels = models.slice(0, 8);
  const maxProvider = Math.max(1, ...providers.map((provider) => provider.totalTokens));
  const maxModel = Math.max(1, ...topModels.map((model) => model.totalTokens));

  const adeTokens = providers.reduce((sum, provider) => sum + (provider.adeOriginatedTokens ?? 0), 0);
  const externalTokens = providers.reduce((sum, provider) => sum + (provider.externalTokens ?? 0), 0);
  const hasSplit = providers.some(
    (provider) => provider.adeOriginatedTokens != null || provider.externalTokens != null,
  ) && adeTokens + externalTokens > 0;

  return (
    <section style={PANEL_STYLE}>
      <SectionHeader label="AI usage" />
      {hasSplit ? (
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", background: "color-mix(in srgb, var(--color-fg) 8%, transparent)" }}>
            <div style={{ width: `${(adeTokens / (adeTokens + externalTokens)) * 100}%`, background: COLORS.accent }} />
            <div style={{ flex: 1, background: "color-mix(in srgb, var(--color-fg) 22%, transparent)" }} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontFamily: SANS_FONT, fontSize: 10, color: COLORS.textMuted }}>
            <span>{formatTokens(adeTokens)} in ADE</span>
            <span>{formatTokens(externalTokens)} external</span>
          </div>
        </div>
      ) : null}

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {providers.length === 0 ? (
          <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted }}>No AI usage found for this range.</div>
        ) : providers.map((provider) => {
          const note = estimationNote(provider.estimation);
          return (
            <div key={provider.provider} style={{ display: "grid", gridTemplateColumns: "128px minmax(0, 1fr) 92px", gap: 12, alignItems: "center" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: SANS_FONT, fontSize: 12, fontWeight: 600, color: COLORS.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {humanizeProvider(provider.provider)}
                </div>
                <div style={{ fontFamily: SANS_FONT, fontSize: 10, color: COLORS.textMuted }}>
                  {formatUsd(provider.rangeCostUsd)}{note ? ` · ${note}` : ""}
                </div>
              </div>
              <Bar value={provider.totalTokens} max={maxProvider} color={providerColor(provider.provider, theme)} />
              <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textSecondary, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                {formatTokens(provider.totalTokens)}
              </div>
            </div>
          );
        })}
      </div>

      {topModels.length > 0 ? (
        <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${COLORS.borderMuted}`, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ ...LABEL_STYLE, fontSize: 11 }}>Top models</div>
          {topModels.map((model) => (
            <div key={`${model.provider}:${model.model}`} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 120px", gap: 12, alignItems: "center" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                  <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textSecondary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {model.model}
                  </span>
                  <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted, flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
                    {formatTokens(model.totalTokens)}
                  </span>
                </div>
                <div style={{ marginTop: 5 }}>
                  <Bar value={model.totalTokens} max={maxModel} color={providerColor(model.provider, theme)} />
                </div>
              </div>
              <div style={{ fontFamily: SANS_FONT, fontSize: 10, color: COLORS.textMuted, textAlign: "right" }}>
                {formatUsd(model.costUsd)} · {formatTokens(model.inputTokens)} in / {formatTokens(model.outputTokens)} out
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function CodeColumn({
  title,
  subtitle,
  rows,
}: {
  title: string;
  subtitle: string;
  rows: Array<{ label: string; value: string }>;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div>
        <div style={{ fontFamily: SANS_FONT, fontSize: 12, fontWeight: 650, color: COLORS.textPrimary }}>{title}</div>
        <div style={{ fontFamily: SANS_FONT, fontSize: 10, color: COLORS.textMuted, marginTop: 2 }}>{subtitle}</div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {rows.map((row) => (
          <div key={row.label}>
            <div style={{ fontFamily: SANS_FONT, fontSize: 16, fontWeight: 700, color: COLORS.textPrimary, fontVariantNumeric: "tabular-nums" }}>{row.value}</div>
            <div style={{ fontFamily: SANS_FONT, fontSize: 10, color: COLORS.textMuted, marginTop: 2 }}>{row.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CodeAndPrs({ stats }: { stats: AdeUsageStats }) {
  const github = stats.githubActivity;
  const local = stats.localActivity;
  const summary = stats.summary;

  // Prefer the labeled github/local groups; fall back to legacy summary fields
  // (which max-merge sources) as a single column so a merged number is never
  // shown twice.
  const githubColumn = github
    ? {
        title: "GitHub",
        subtitle: stats.github.repo ?? "Remote repository",
        rows: [
          { label: "Commits", value: formatWhole(github.commits) },
          { label: "PRs merged", value: formatWhole(github.prsMerged) },
          { label: "PRs open", value: formatWhole(github.prsOpen) },
          { label: "Lines +/-", value: `${formatWhole(github.prAdditions)} / ${formatWhole(github.prDeletions)}` },
        ],
      }
    : null;

  const localColumn = local
    ? {
        title: "Local lanes",
        subtitle: "This project's git history",
        rows: [
          { label: "Commits", value: formatWhole(local.commits) },
          { label: "PR landings", value: formatWhole(local.prLandings) },
          { label: "Files changed", value: formatWhole(local.filesChanged) },
          { label: "Lines +/-", value: `${formatWhole(local.insertions)} / ${formatWhole(local.deletions)}` },
        ],
      }
    : null;

  const legacyColumn =
    !github && !local
      ? {
          title: "Code activity",
          subtitle: stats.github.available ? (stats.github.repo ?? "GitHub + local history") : "ADE local history",
          rows: [
            { label: "Commits", value: formatWhole(summary.commitsCreated) },
            { label: "PRs merged", value: formatWhole(summary.prsMerged) },
            { label: "Files changed", value: formatWhole(summary.filesChanged) },
            { label: "Lines +/-", value: `${formatWhole(summary.insertions)} / ${formatWhole(summary.deletions)}` },
          ],
        }
      : null;

  const columns = [githubColumn, localColumn, legacyColumn].filter(Boolean) as Array<{
    title: string;
    subtitle: string;
    rows: Array<{ label: string; value: string }>;
  }>;

  return (
    <section style={PANEL_STYLE}>
      <SectionHeader label="Code & PRs" />
      <div style={{ display: "grid", gridTemplateColumns: columns.length > 1 ? "1fr 1fr" : "1fr", gap: 20 }}>
        {columns.map((column) => (
          <CodeColumn key={column.title} title={column.title} subtitle={column.subtitle} rows={column.rows} />
        ))}
      </div>
    </section>
  );
}

function metaLine(stats: AdeUsageStats | null, scope: AdeUsageScope): string {
  if (!stats) return "";
  const parts: string[] = [];
  const updated = relativeTimeCompact(stats.freshness?.providerUpdatedAt ?? stats.generatedAt);
  if (updated) parts.push(`Updated ${updated} ago`);
  if (stats.freshness?.state === "refreshing") parts.push("refreshing");

  const estimated = stats.providers
    .filter((provider) => provider.estimation && provider.estimation !== "exact")
    .map((provider) => humanizeProvider(provider.provider));
  if (estimated.length === 1) parts.push(`${estimated[0]} tokens estimated`);
  else if (estimated.length > 1) {
    const last = estimated.at(-1)!;
    parts.push(`${estimated.slice(0, -1).join(", ")} and ${last} tokens estimated`);
  }

  parts.push(scope === "machine" ? "Provider totals cover this machine" : "Provider totals scoped to this project");

  for (const note of stats.sourceNotes ?? []) {
    if (note.trim()) parts.push(note.trim());
  }
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

export function AdeUsageSection() {
  const theme = useAppStore((state) => state.theme);
  const [preset, setPreset] = React.useState<AdeUsageRangePreset>("7d");
  const [scope, setScope] = React.useState<AdeUsageScope>(() => readScope());
  const [cacheScope, setCacheScope] = React.useState<string | null>(null);
  const [stats, setStats] = React.useState<AdeUsageStats | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const loadSeqRef = React.useRef(0);

  const loadStats = React.useCallback(
    async (nextPreset: AdeUsageRangePreset, sourceScope: AdeUsageScope, scopeKey: string, force = false) => {
      const loadSeq = loadSeqRef.current + 1;
      loadSeqRef.current = loadSeq;
      const key = statsCacheKey(scopeKey, sourceScope, nextPreset);
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
        const result = await window.ade?.usage?.getAdeStats?.({ preset: nextPreset, scope: sourceScope });
        if (!result) throw new Error("Stats are unavailable.");
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
    },
    [],
  );

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

    void window.ade.app.getProject().then(applyProject).catch(() => applyProject(null));
    const unsubscribe = window.ade.app.onProjectChanged?.(applyProject);
    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, []);

  React.useEffect(() => {
    if (!cacheScope) return;
    void loadStats(preset, scope, cacheScope, false);
  }, [cacheScope, loadStats, preset, scope]);

  // Re-fetch when a background ledger refresh completes, instead of a capped
  // freshness-driven retry.
  React.useEffect(() => {
    if (!cacheScope) return;
    const unsubscribe = window.ade?.usage?.onUpdate?.(() => {
      void loadStats(preset, scope, cacheScope, false);
    });
    return () => unsubscribe?.();
  }, [cacheScope, loadStats, preset, scope]);

  const changeScope = React.useCallback((next: AdeUsageScope) => {
    setScope(next);
    persistScope(next);
  }, []);

  const summary = stats?.summary;
  const loadingEmpty = loading && !stats;
  const meta = metaLine(stats, scope);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <header style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div>
          <div style={{ ...LABEL_STYLE, textTransform: "uppercase", letterSpacing: 1.3, marginBottom: 8 }}>Settings</div>
          <h1 style={{ margin: 0, fontFamily: SANS_FONT, fontSize: 26, lineHeight: 1.1, color: COLORS.textPrimary }}>Stats</h1>
          <div style={{ marginTop: 8, fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted }}>
            Your ADE activity across desktop, mobile, terminal, and web.
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", justifyContent: "flex-end", maxWidth: "100%" }}>
          <Segmented
            options={[
              { value: "project", label: "This project" },
              { value: "machine", label: "This machine" },
            ]}
            value={scope}
            onChange={(value) => changeScope(value as AdeUsageScope)}
          />
          <Segmented
            options={RANGE_OPTIONS.map((option) => ({ value: option.preset, label: option.label }))}
            value={preset}
            onChange={(value) => setPreset(value as AdeUsageRangePreset)}
          />
          <button
            type="button"
            onClick={() => cacheScope && loadStats(preset, scope, cacheScope, true)}
            disabled={refreshing || !cacheScope}
            style={{ ...outlineButton({ height: 34 }), opacity: refreshing ? 0.7 : 1 }}
          >
            <ArrowClockwise size={14} />
            {refreshing ? "Refreshing" : "Refresh"}
          </button>
        </div>
      </header>

      {error ? (
        <div style={{ ...PANEL_STYLE, fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted }}>{error}</div>
      ) : null}

      <section>
        <SectionHeader label="Overview" />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
          <StatTile
            label="AI tokens"
            value={summary ? formatTokens(summary.totalTokens) : loading ? "…" : "0"}
            detail={summary
              ? `${formatTokens(summary.observedProviderInputTokens)} in · ${formatTokens(summary.observedProviderOutputTokens)} out · ${formatTokens(summary.observedProviderCachedTokens)} cache`
              : "Waiting for local scans"}
            accent={providerColor("codex", theme)}
            icon={<ChartLineUp size={18} />}
          />
          <StatTile
            label="Estimated cost"
            value={summary ? formatUsd(summary.observedProviderCostRangeUsd) : loading ? "…" : "$0.00"}
            detail={summary
              ? `${formatUsd(summary.observedProviderCostTodayUsd)} today · ${formatUsd(summary.observedProviderCost30dUsd)} 30d`
              : "From the provider pricing registry"}
            accent={providerColor("droid", theme)}
            icon={<Robot size={18} />}
          />
          <StatTile
            label="Code movement"
            value={summary ? formatWhole(summary.insertions + summary.deletions) : "0"}
            detail={summary
              ? `${formatWhole(summary.insertions)} added · ${formatWhole(summary.deletions)} removed · ${formatWhole(summary.filesChanged)} files`
              : "ADE and GitHub activity"}
            accent={providerColor("copilot", theme)}
            icon={<GitBranch size={18} />}
          />
          <StatTile
            label="Pull requests"
            value={summary ? formatWhole(summary.prsTracked) : "0"}
            detail={summary
              ? `${formatWhole(summary.prsMerged)} merged · ${formatWhole(summary.prsOpen)} open · ${formatWhole(summary.commitsCreated)} commits`
              : "ADE and GitHub activity"}
            accent={providerColor("opencode", theme)}
            icon={<GitPullRequest size={18} />}
          />
        </div>
      </section>

      <section>
        <SectionHeader label="Activity" />
        <ActivityModule
          stats={stats}
          loading={loadingEmpty}
          variant="full"
          preset={preset}
          showRangeControl={false}
        />
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 14 }}>
        {loadingEmpty ? (
          <section style={PANEL_STYLE}><div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted }}>Loading AI usage.</div></section>
        ) : (
          <AiUsage providers={stats?.providers ?? []} models={stats?.models ?? []} theme={theme} />
        )}
        {stats ? (
          <CodeAndPrs stats={stats} />
        ) : (
          <section style={PANEL_STYLE}><div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted }}>Loading code activity.</div></section>
        )}
      </div>

      {meta ? (
        <div style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textMuted, lineHeight: 1.5 }}>{meta}</div>
      ) : null}
    </div>
  );
}

function Segmented({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: string; label: string }>;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div style={{ display: "inline-flex", border: `1px solid ${COLORS.borderMuted}`, borderRadius: 8, overflow: "hidden" }}>
      {options.map((option, index) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            style={{
              border: "none",
              borderRight: index === options.length - 1 ? "none" : `1px solid ${COLORS.borderMuted}`,
              background: active ? COLORS.textPrimary : "transparent",
              color: active ? COLORS.pageBg : COLORS.textSecondary,
              fontFamily: SANS_FONT,
              fontSize: 12,
              fontWeight: 600,
              padding: "8px 13px",
              cursor: "pointer",
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

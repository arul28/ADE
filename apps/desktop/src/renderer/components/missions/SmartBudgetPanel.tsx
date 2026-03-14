import React, { useCallback, useState } from "react";
import { Info, Check, Clock, Warning } from "@phosphor-icons/react";
import type { SmartBudgetConfig, MissionBudgetProviderSnapshot, ProviderBudgetLimits, ModelProvider } from "../../../shared/types";
import { getModelById, resolveModelAlias } from "../../../shared/modelRegistry";
import { COLORS, MONO_FONT, LABEL_STYLE } from "../lanes/laneDesignTokens";

type BillingContext = {
  hasSubscription: boolean;
  subscriptionProviders: string[];
  apiProviders: string[];
};

type SmartBudgetPanelProps = {
  value: SmartBudgetConfig;
  onChange: (config: SmartBudgetConfig) => void;
  currentSpend?: { fiveHourUsd: number; weeklyUsd: number } | null;
  modelUsage?: Record<string, { inputTokens: number; outputTokens: number; costUsd: number; sessions?: number }>;
  billingContext?: BillingContext;
  /** Per-provider budget snapshots from the budget service */
  perProvider?: MissionBudgetProviderSnapshot[];
};

const inputStyle: React.CSSProperties = {
  height: 28,
  background: COLORS.recessedBg,
  border: `1px solid ${COLORS.outlineBorder}`,
  color: COLORS.textPrimary,
  fontFamily: MONO_FONT,
  fontSize: 12,
  padding: "0 6px",
  outline: "none",
  borderRadius: 0,
  width: 100,
};

const smallInputStyle: React.CSSProperties = {
  ...inputStyle,
  width: 72,
};

const STEERING_ACTIONS = [
  "Downgrade models",
  "Inject conciseness",
  "Warn workers",
  "Skip optional",
  "Reduce parallelism",
  "Switch provider",
];

const PROVIDERS: ModelProvider[] = ["claude", "codex"];

function ProgressBar({
  current,
  threshold,
  tokenMode,
}: {
  current: number;
  threshold: number;
  tokenMode?: boolean;
}) {
  const pct = threshold > 0 ? Math.min((current / threshold) * 100, 100) : 0;
  const barColor =
    pct >= 80 ? COLORS.danger : pct >= 50 ? COLORS.warning : COLORS.success;

  const label = tokenMode
    ? `${formatTokenCount(current)} (${Math.round(pct)}%)`
    : `$${current.toFixed(2)} (${Math.round(pct)}%)`;

  return (
    <div className="flex items-center gap-2 flex-1">
      <div
        style={{
          height: 4,
          flex: 1,
          background: COLORS.border,
          borderRadius: 0,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: barColor,
            transition: "width 0.3s ease",
          }}
        />
      </div>
      <span
        style={{
          fontFamily: MONO_FONT,
          fontSize: 10,
          color: COLORS.textDim,
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
    </div>
  );
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K tok`;
  return `${n} tok`;
}

function formatTimeRemaining(ms: number | null): string {
  if (ms == null || ms <= 0) return "--";
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function Tooltip({ text, children }: { text: string; children: React.ReactNode }) {
  const [show, setShow] = useState(false);
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      {show && (
        <div
          className="absolute z-50 left-1/2 -translate-x-1/2 bottom-full mb-2 px-3 py-2 text-[10px] whitespace-normal max-w-xs"
          style={{
            background: COLORS.cardBg,
            border: `1px solid ${COLORS.border}`,
            color: COLORS.textSecondary,
            fontFamily: MONO_FONT,
            lineHeight: 1.4,
          }}
        >
          {text}
        </div>
      )}
    </span>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: MONO_FONT,
        fontSize: 10,
        fontWeight: 700,
        color: COLORS.textMuted,
        textTransform: "uppercase",
        letterSpacing: "1px",
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}

function FieldLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={className ?? "w-24 shrink-0"}
      style={{
        fontFamily: MONO_FONT,
        fontSize: 10,
        fontWeight: 700,
        color: COLORS.textMuted,
        textTransform: "uppercase",
        letterSpacing: "1px",
      }}
    >
      {children}
    </span>
  );
}

export function SmartBudgetPanel({
  value,
  onChange,
  currentSpend,
  modelUsage,
  billingContext,
  perProvider,
}: SmartBudgetPanelProps) {
  const subscriptionOnly = billingContext?.hasSubscription && !billingContext?.apiProviders.length;

  const handleToggle = useCallback(() => {
    onChange({ ...value, enabled: !value.enabled });
  }, [value, onChange]);

  const handleFiveHourChange = useCallback(
    (raw: string) => {
      const num = parseFloat(raw);
      if (!isNaN(num) && num >= 0) {
        onChange({ ...value, fiveHourThresholdUsd: num });
      }
    },
    [value, onChange]
  );

  const handleWeeklyChange = useCallback(
    (raw: string) => {
      const num = parseFloat(raw);
      if (!isNaN(num) && num >= 0) {
        onChange({ ...value, weeklyThresholdUsd: num });
      }
    },
    [value, onChange]
  );

  const handleProviderLimitChange = useCallback(
    (provider: ModelProvider, field: keyof ProviderBudgetLimits, raw: string) => {
      const num = parseInt(raw, 10);
      if (isNaN(num) || num < 0) return;
      const current = value.providerLimits ?? {};
      const provLimits = current[provider] ?? { fiveHourTokenLimit: 0, weeklyTokenLimit: 0 };
      onChange({
        ...value,
        providerLimits: {
          ...current,
          [provider]: { ...provLimits, [field]: num },
        },
      });
    },
    [value, onChange]
  );

  const handleHardStopChange = useCallback(
    (field: "fiveHourHardStopPercent" | "weeklyHardStopPercent", raw: string) => {
      const num = parseInt(raw, 10);
      if (isNaN(num) || num < 0 || num > 100) return;
      onChange({ ...value, [field]: num });
    },
    [value, onChange]
  );

  const handleApiKeyMaxChange = useCallback(
    (raw: string) => {
      const num = parseFloat(raw);
      if (isNaN(num) || num < 0) return;
      onChange({ ...value, apiKeyMaxSpendUsd: num });
    },
    [value, onChange]
  );

  const handleDowngradeThresholdChange = useCallback(
    (raw: string) => {
      const num = parseInt(raw, 10);
      if (isNaN(num) || num < 0 || num > 100) return;
      onChange({ ...value, modelDowngradeThresholdPct: num });
    },
    [value, onChange]
  );

  const dimmed = !value.enabled;

  return (
    <div
      style={{
        background: COLORS.cardBg,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 0,
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2">
        <span style={LABEL_STYLE}>SMART TOKEN BUDGET</span>

        {/* Toggle switch */}
        <button
          onClick={handleToggle}
          className="relative"
          style={{
            width: 32,
            height: 16,
            background: value.enabled ? COLORS.accent : COLORS.border,
            border: "none",
            borderRadius: 0,
            cursor: "pointer",
            transition: "background 0.2s ease",
          }}
        >
          <div
            style={{
              position: "absolute",
              top: 2,
              left: value.enabled ? 16 : 2,
              width: 12,
              height: 12,
              background: value.enabled ? COLORS.textPrimary : COLORS.textDim,
              borderRadius: 0,
              transition: "left 0.2s ease",
            }}
          />
        </button>

        <Tooltip text={subscriptionOnly
          ? "When enabled, the orchestrator tracks token usage across subscription providers and steers model usage to stay within budget thresholds."
          : "When enabled, the orchestrator will automatically steer model usage to stay within budget thresholds. It can downgrade models, inject conciseness prompts, warn workers, skip optional steps, reduce parallelism, and switch providers."
        }>
          <span className="cursor-help">
            <Info size={14} weight="bold" color={COLORS.textDim} />
          </span>
        </Tooltip>
      </div>

      {/* Body */}
      <div
        className="px-3 pb-3 space-y-3"
        style={{
          borderTop: `1px solid ${COLORS.border}`,
          opacity: dimmed ? 0.4 : 1,
          pointerEvents: dimmed ? "none" : "auto",
          transition: "opacity 0.2s ease",
        }}
      >
        {/* Threshold rows */}
        <div className="space-y-2 pt-2">
          {/* 5-Hour Limit */}
          <div className="flex items-center gap-3">
            <FieldLabel>
              {subscriptionOnly ? "5-Hour Token Budget" : "5-Hour Limit"}
            </FieldLabel>
            <div className="flex items-center gap-1">
              {!subscriptionOnly && (
                <span
                  style={{
                    fontFamily: MONO_FONT,
                    fontSize: 12,
                    color: COLORS.textDim,
                  }}
                >
                  $
                </span>
              )}
              <input
                type="number"
                min={0}
                step={1}
                style={inputStyle}
                value={value.fiveHourThresholdUsd}
                onChange={(e) => handleFiveHourChange(e.target.value)}
              />
            </div>
            {currentSpend != null && (
              <ProgressBar
                current={currentSpend.fiveHourUsd}
                threshold={value.fiveHourThresholdUsd}
                tokenMode={subscriptionOnly}
              />
            )}
          </div>

          {/* Weekly Limit */}
          <div className="flex items-center gap-3">
            <FieldLabel>
              {subscriptionOnly ? "Weekly Token Budget" : "Weekly Limit"}
            </FieldLabel>
            <div className="flex items-center gap-1">
              {!subscriptionOnly && (
                <span
                  style={{
                    fontFamily: MONO_FONT,
                    fontSize: 12,
                    color: COLORS.textDim,
                  }}
                >
                  $
                </span>
              )}
              <input
                type="number"
                min={0}
                step={5}
                style={inputStyle}
                value={value.weeklyThresholdUsd}
                onChange={(e) => handleWeeklyChange(e.target.value)}
              />
            </div>
            {currentSpend != null && (
              <ProgressBar
                current={currentSpend.weeklyUsd}
                threshold={value.weeklyThresholdUsd}
                tokenMode={subscriptionOnly}
              />
            )}
          </div>
        </div>

        {/* Per-provider usage display */}
        {perProvider && perProvider.length > 0 && (
          <div
            className="pt-2"
            style={{ borderTop: `1px solid ${COLORS.border}` }}
          >
            <SectionLabel>Per-Provider Usage</SectionLabel>
            <div className="space-y-3">
              {perProvider.map((snap) => {
                const fiveHrPct = snap.fiveHour.usedPct ?? 0;
                const weeklyPct = snap.weekly.usedPct ?? 0;
                const fiveHrColor = fiveHrPct >= 80 ? COLORS.danger : fiveHrPct >= 50 ? COLORS.warning : COLORS.success;
                const weeklyColor = weeklyPct >= 80 ? COLORS.danger : weeklyPct >= 50 ? COLORS.warning : COLORS.success;
                return (
                  <div key={snap.provider}>
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        style={{
                          fontFamily: MONO_FONT,
                          fontSize: 11,
                          fontWeight: 700,
                          color: COLORS.textSecondary,
                          textTransform: "uppercase",
                        }}
                      >
                        {snap.provider}
                      </span>
                      {snap.fiveHour.timeUntilResetMs != null && snap.fiveHour.timeUntilResetMs > 0 && (
                        <span className="flex items-center gap-1">
                          <Clock size={10} color={COLORS.textDim} />
                          <span
                            style={{
                              fontFamily: MONO_FONT,
                              fontSize: 9,
                              color: COLORS.textDim,
                            }}
                          >
                            5hr reset: {formatTimeRemaining(snap.fiveHour.timeUntilResetMs)}
                          </span>
                        </span>
                      )}
                    </div>
                    {/* 5-hour bar */}
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className="w-12 shrink-0"
                        style={{ fontFamily: MONO_FONT, fontSize: 9, color: COLORS.textDim }}
                      >
                        5hr
                      </span>
                      <div
                        style={{
                          height: 4,
                          flex: 1,
                          background: COLORS.border,
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            height: "100%",
                            width: `${Math.min(fiveHrPct, 100)}%`,
                            background: fiveHrColor,
                            transition: "width 0.3s ease",
                          }}
                        />
                      </div>
                      <span
                        style={{
                          fontFamily: MONO_FONT,
                          fontSize: 9,
                          color: COLORS.textDim,
                          whiteSpace: "nowrap",
                          minWidth: 80,
                          textAlign: "right",
                        }}
                      >
                        {formatTokenCount(snap.fiveHour.usedTokens)}
                        {snap.fiveHour.limitTokens != null ? ` / ${formatTokenCount(snap.fiveHour.limitTokens)}` : ""}
                        {" "}({Math.round(fiveHrPct)}%)
                      </span>
                    </div>
                    {/* Weekly bar */}
                    <div className="flex items-center gap-2">
                      <span
                        className="w-12 shrink-0"
                        style={{ fontFamily: MONO_FONT, fontSize: 9, color: COLORS.textDim }}
                      >
                        weekly
                      </span>
                      <div
                        style={{
                          height: 4,
                          flex: 1,
                          background: COLORS.border,
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            height: "100%",
                            width: `${Math.min(weeklyPct, 100)}%`,
                            background: weeklyColor,
                            transition: "width 0.3s ease",
                          }}
                        />
                      </div>
                      <span
                        style={{
                          fontFamily: MONO_FONT,
                          fontSize: 9,
                          color: COLORS.textDim,
                          whiteSpace: "nowrap",
                          minWidth: 80,
                          textAlign: "right",
                        }}
                      >
                        {formatTokenCount(snap.weekly.usedTokens)}
                        {snap.weekly.limitTokens != null ? ` / ${formatTokenCount(snap.weekly.limitTokens)}` : ""}
                        {" "}({Math.round(weeklyPct)}%)
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Per-provider tier ceilings */}
        <div
          className="pt-2"
          style={{ borderTop: `1px solid ${COLORS.border}` }}
        >
          <SectionLabel>Provider Tier Ceilings</SectionLabel>
          <div className="space-y-2">
            {PROVIDERS.map((provider) => {
              const limits = value.providerLimits?.[provider] ?? { fiveHourTokenLimit: 0, weeklyTokenLimit: 0 };
              return (
                <div key={provider} className="flex items-center gap-3">
                  <span
                    className="w-16 shrink-0"
                    style={{
                      fontFamily: MONO_FONT,
                      fontSize: 10,
                      fontWeight: 700,
                      color: COLORS.textSecondary,
                      textTransform: "uppercase",
                    }}
                  >
                    {provider}
                  </span>
                  <div className="flex items-center gap-1">
                    <span style={{ fontFamily: MONO_FONT, fontSize: 9, color: COLORS.textDim }}>5hr</span>
                    <input
                      type="number"
                      min={0}
                      step={10000}
                      style={smallInputStyle}
                      value={limits.fiveHourTokenLimit}
                      onChange={(e) => handleProviderLimitChange(provider, "fiveHourTokenLimit", e.target.value)}
                      title={`${provider} 5-hour token ceiling`}
                    />
                  </div>
                  <div className="flex items-center gap-1">
                    <span style={{ fontFamily: MONO_FONT, fontSize: 9, color: COLORS.textDim }}>wk</span>
                    <input
                      type="number"
                      min={0}
                      step={50000}
                      style={smallInputStyle}
                      value={limits.weeklyTokenLimit}
                      onChange={(e) => handleProviderLimitChange(provider, "weeklyTokenLimit", e.target.value)}
                      title={`${provider} weekly token ceiling`}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Hard stop controls */}
        <div
          className="pt-2"
          style={{ borderTop: `1px solid ${COLORS.border}` }}
        >
          <div className="flex items-center gap-2 mb-2">
            <SectionLabel>Hard Stop Limits</SectionLabel>
            <Tooltip text="When usage reaches these percentages of your tier ceiling, the mission will automatically pause. Running workers finish their current task.">
              <span className="cursor-help">
                <Warning size={12} weight="bold" color={COLORS.warning} />
              </span>
            </Tooltip>
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <FieldLabel className="w-28 shrink-0">5hr Hard Stop</FieldLabel>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={5}
                  style={smallInputStyle}
                  value={value.fiveHourHardStopPercent ?? 80}
                  onChange={(e) => handleHardStopChange("fiveHourHardStopPercent", e.target.value)}
                />
                <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim }}>%</span>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <FieldLabel className="w-28 shrink-0">Weekly Hard Stop</FieldLabel>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={5}
                  style={smallInputStyle}
                  value={value.weeklyHardStopPercent ?? 95}
                  onChange={(e) => handleHardStopChange("weeklyHardStopPercent", e.target.value)}
                />
                <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim }}>%</span>
              </div>
            </div>
            {!subscriptionOnly && (
              <div className="flex items-center gap-3">
                <FieldLabel className="w-28 shrink-0">API Key Max</FieldLabel>
                <div className="flex items-center gap-1">
                  <span style={{ fontFamily: MONO_FONT, fontSize: 12, color: COLORS.textDim }}>$</span>
                  <input
                    type="number"
                    min={0}
                    step={5}
                    style={smallInputStyle}
                    value={value.apiKeyMaxSpendUsd ?? 0}
                    onChange={(e) => handleApiKeyMaxChange(e.target.value)}
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Model downgrade threshold */}
        <div
          className="pt-2"
          style={{ borderTop: `1px solid ${COLORS.border}` }}
        >
          <div className="flex items-center gap-2 mb-2">
            <SectionLabel>Model Downgrade</SectionLabel>
            <Tooltip text="When subscription usage exceeds this threshold, the orchestrator will automatically switch new workers to a cheaper model tier. Set to 0 to disable.">
              <span className="cursor-help">
                <Info size={12} weight="bold" color={COLORS.textDim} />
              </span>
            </Tooltip>
          </div>
          <div className="flex items-center gap-3">
            <FieldLabel className="w-28 shrink-0">Threshold</FieldLabel>
            <div className="flex items-center gap-1">
              <input
                type="number"
                min={0}
                max={100}
                step={5}
                style={smallInputStyle}
                value={value.modelDowngradeThresholdPct ?? 0}
                onChange={(e) => handleDowngradeThresholdChange(e.target.value)}
              />
              <span style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim }}>%</span>
            </div>
            <span style={{ fontFamily: MONO_FONT, fontSize: 9, color: COLORS.textDim }}>
              {(value.modelDowngradeThresholdPct ?? 0) > 0
                ? `Switch to cheaper model at ${value.modelDowngradeThresholdPct}% usage`
                : "Disabled — no automatic downgrade"
              }
            </span>
          </div>
        </div>

        {/* Per-model usage breakdown */}
        {modelUsage && Object.keys(modelUsage).length > 0 && (
          <div
            className="pt-2"
            style={{ borderTop: `1px solid ${COLORS.border}` }}
          >
            <SectionLabel>Current Model Usage</SectionLabel>
            <div className="space-y-2">
              {Object.entries(modelUsage).map(([model, usage]) => {
                const totalTokens = usage.inputTokens + usage.outputTokens;
                const totalBudget = value.fiveHourThresholdUsd || 1;
                const pct = Math.min((usage.costUsd / totalBudget) * 100, 100);
                const barColor =
                  pct >= 80
                    ? COLORS.danger
                    : pct >= 50
                      ? COLORS.warning
                      : COLORS.success;
                const desc = getModelById(model) ?? resolveModelAlias(model);
                const family = desc?.family ?? "";
                const isSub = billingContext?.subscriptionProviders.includes(family) ?? false;
                const isApi = billingContext?.apiProviders.includes(family) ?? false;
                return (
                  <div key={model} className="flex items-center gap-2">
                    <span
                      className="w-32 shrink-0 truncate flex items-center gap-1"
                      title={model}
                    >
                      <span
                        style={{
                          fontFamily: MONO_FONT,
                          fontSize: 10,
                          color: COLORS.textSecondary,
                        }}
                      >
                        {model}
                      </span>
                      {billingContext && (isSub || isApi) && (
                        <span
                          className="px-1 py-0.5"
                          style={{
                            background: isSub ? "#22C55E18" : "#F59E0B18",
                            color: isSub ? "#22C55E" : "#F59E0B",
                            fontFamily: MONO_FONT,
                            fontSize: 8,
                            fontWeight: 700,
                            textTransform: "uppercase",
                            letterSpacing: "1px",
                          }}
                        >
                          {isSub ? "SUB" : "API"}
                        </span>
                      )}
                    </span>
                    <div
                      style={{
                        height: 4,
                        flex: 1,
                        background: COLORS.border,
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          height: "100%",
                          width: `${pct}%`,
                          background: barColor,
                          transition: "width 0.3s ease",
                        }}
                      />
                    </div>
                    <span
                      style={{
                        fontFamily: MONO_FONT,
                        fontSize: 10,
                        color: COLORS.textDim,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {isSub
                        ? `${totalTokens.toLocaleString()} tok${usage.sessions ? ` · ${usage.sessions} sessions` : ""}`
                        : `$${usage.costUsd.toFixed(2)} · ${totalTokens.toLocaleString()} tok`
                      }
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Steering actions */}
        <div
          className="pt-2"
          style={{ borderTop: `1px solid ${COLORS.border}` }}
        >
          <SectionLabel>When approaching limit:</SectionLabel>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {STEERING_ACTIONS.map((action) => (
              <div key={action} className="flex items-center gap-1.5">
                <Check size={12} weight="bold" color={COLORS.success} />
                <span
                  style={{
                    fontFamily: MONO_FONT,
                    fontSize: 11,
                    color: COLORS.textSecondary,
                  }}
                >
                  {action}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

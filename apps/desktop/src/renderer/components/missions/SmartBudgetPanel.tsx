import React, { useCallback } from "react";
import { Info, Check } from "@phosphor-icons/react";
import type { SmartBudgetConfig } from "../../../shared/types";
import { COLORS, MONO_FONT, LABEL_STYLE } from "../lanes/laneDesignTokens";

type SmartBudgetPanelProps = {
  value: SmartBudgetConfig;
  onChange: (config: SmartBudgetConfig) => void;
  currentSpend?: { fiveHourUsd: number; weeklyUsd: number } | null;
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

const STEERING_ACTIONS = [
  "Downgrade models",
  "Inject conciseness",
  "Warn workers",
  "Skip optional",
  "Reduce parallelism",
  "Switch provider",
];

function ProgressBar({
  current,
  threshold,
}: {
  current: number;
  threshold: number;
}) {
  const pct = threshold > 0 ? Math.min((current / threshold) * 100, 100) : 0;
  const barColor =
    pct >= 80 ? COLORS.danger : pct >= 50 ? COLORS.warning : COLORS.success;

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
        ${current.toFixed(2)} ({Math.round(pct)}%)
      </span>
    </div>
  );
}

export function SmartBudgetPanel({
  value,
  onChange,
  currentSpend,
}: SmartBudgetPanelProps) {
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

        <span
          title="When enabled, the orchestrator will automatically steer model usage to stay within budget thresholds. It can downgrade models, inject conciseness prompts, warn workers, skip optional steps, reduce parallelism, and switch providers."
          className="cursor-help"
        >
          <Info size={14} weight="bold" color={COLORS.textDim} />
        </span>
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
            <span
              className="w-24 shrink-0"
              style={{
                fontFamily: MONO_FONT,
                fontSize: 10,
                fontWeight: 700,
                color: COLORS.textMuted,
                textTransform: "uppercase",
                letterSpacing: "1px",
              }}
            >
              5-Hour Limit
            </span>
            <div className="flex items-center gap-1">
              <span
                style={{
                  fontFamily: MONO_FONT,
                  fontSize: 12,
                  color: COLORS.textDim,
                }}
              >
                $
              </span>
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
              />
            )}
          </div>

          {/* Weekly Limit */}
          <div className="flex items-center gap-3">
            <span
              className="w-24 shrink-0"
              style={{
                fontFamily: MONO_FONT,
                fontSize: 10,
                fontWeight: 700,
                color: COLORS.textMuted,
                textTransform: "uppercase",
                letterSpacing: "1px",
              }}
            >
              Weekly Limit
            </span>
            <div className="flex items-center gap-1">
              <span
                style={{
                  fontFamily: MONO_FONT,
                  fontSize: 12,
                  color: COLORS.textDim,
                }}
              >
                $
              </span>
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
              />
            )}
          </div>
        </div>

        {/* Steering actions */}
        <div
          className="pt-2"
          style={{ borderTop: `1px solid ${COLORS.border}` }}
        >
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
            When approaching limit:
          </div>
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

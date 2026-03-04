import React from "react";
import { MagnifyingGlass, Plus, X, CircleNotch } from "@phosphor-icons/react";
import { COLORS, MONO_FONT, LABEL_STYLE, primaryButton, outlineButton, inlineBadge, cardStyle } from "../lanes/laneDesignTokens";
import { ModelSelector } from "../missions/ModelSelector";
import type { ModelConfig, CiScanResult, CiJobCandidate } from "../../../shared/types";

export type AiScanSuggestion = {
  id: string;
  name: string;
  command: string;
  stack: string;
  source: string; // e.g. "package.json", "CI workflow", "Dockerfile"
};

export type AiScanPanelProps = {
  open: boolean;
  onClose: () => void;
  onAddCommand: (suggestion: AiScanSuggestion) => void;
  onAddAll: (suggestions: AiScanSuggestion[]) => void;
};

function jobsToSuggestions(jobs: CiJobCandidate[]): AiScanSuggestion[] {
  return jobs.map((job, i) => ({
    id: `ci-${i}-${job.jobName.replace(/\s+/g, "-").toLowerCase()}`,
    name: job.jobName,
    command: job.suggestedCommandLine ?? (job.commands.join(" && ") || job.jobName),
    stack: categorizeJob(job.jobName),
    source: job.provider ?? "CI",
  }));
}

function categorizeJob(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("test") || lower.includes("lint") || lower.includes("check")) return "Tests";
  if (lower.includes("deploy") || lower.includes("release") || lower.includes("publish")) return "Deploy";
  if (lower.includes("build") || lower.includes("compile")) return "Build";
  return "Dev";
}

export function AiScanPanel({ open, onClose, onAddCommand, onAddAll }: AiScanPanelProps) {
  const [scanning, setScanning] = React.useState(false);
  const [suggestions, setSuggestions] = React.useState<AiScanSuggestion[]>([]);
  const [dismissed, setDismissed] = React.useState<Set<string>>(new Set());
  const [scanError, setScanError] = React.useState<string | null>(null);
  const [modelConfig, setModelConfig] = React.useState<ModelConfig>({
    provider: "claude",
    modelId: "anthropic/claude-sonnet-4-6",
    thinkingLevel: "medium",
  });

  const handleScan = React.useCallback(async () => {
    setScanning(true);
    setScanError(null);
    setSuggestions([]);
    setDismissed(new Set());
    try {
      const result: CiScanResult = await window.ade.ci.scan();
      const converted = jobsToSuggestions(result.jobs);
      setSuggestions(converted);
      if (converted.length === 0) {
        setScanError("No commands detected. Try adding commands manually.");
      }
    } catch (err) {
      setScanError(err instanceof Error ? err.message : "Scan failed");
    } finally {
      setScanning(false);
    }
  }, []);

  if (!open) return null;

  const visibleSuggestions = suggestions.filter((s) => !dismissed.has(s.id));
  const groupedByStack = visibleSuggestions.reduce<Record<string, AiScanSuggestion[]>>((acc, s) => {
    (acc[s.stack] ??= []).push(s);
    return acc;
  }, {});

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.6)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: COLORS.cardBg,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 0,
          width: 560,
          maxWidth: "90vw",
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 16px",
            borderBottom: `1px solid ${COLORS.border}`,
          }}
        >
          <span
            style={{
              fontFamily: MONO_FONT,
              fontSize: 12,
              fontWeight: 700,
              color: COLORS.textPrimary,
              textTransform: "uppercase",
              letterSpacing: "1px",
            }}
          >
            Scan Repository
          </span>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: COLORS.textMuted,
              cursor: "pointer",
              padding: 2,
              display: "flex",
            }}
          >
            <X size={16} weight="bold" />
          </button>
        </div>

        {/* Model picker + scan button */}
        <div
          style={{
            padding: "12px 16px",
            display: "flex",
            alignItems: "center",
            gap: 10,
            borderBottom: `1px solid ${COLORS.border}`,
          }}
        >
          <span style={{ ...LABEL_STYLE, whiteSpace: "nowrap" }}>Model</span>
          <ModelSelector value={modelConfig} onChange={setModelConfig} compact />
          <button
            type="button"
            onClick={handleScan}
            disabled={scanning}
            style={primaryButton({
              marginLeft: "auto",
              opacity: scanning ? 0.6 : 1,
              cursor: scanning ? "default" : "pointer",
            })}
          >
            {scanning ? (
              <CircleNotch size={14} weight="bold" style={{ animation: "spin 1s linear infinite" }} />
            ) : (
              <MagnifyingGlass size={14} weight="bold" />
            )}
            {scanning ? "Scanning..." : "Scan"}
          </button>
        </div>

        {/* Results */}
        <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
          {scanError && (
            <div
              style={{
                fontFamily: MONO_FONT,
                fontSize: 11,
                color: COLORS.danger,
                padding: "8px 0",
              }}
            >
              {scanError}
            </div>
          )}

          {!scanning && suggestions.length === 0 && !scanError && (
            <div
              style={{
                fontFamily: MONO_FONT,
                fontSize: 11,
                color: COLORS.textDim,
                textAlign: "center",
                padding: "24px 0",
              }}
            >
              Click Scan to analyze your repository for runnable commands.
            </div>
          )}

          {Object.entries(groupedByStack).map(([stackName, items]) => (
            <div key={stackName} style={{ marginBottom: 16 }}>
              <div style={{ ...LABEL_STYLE, marginBottom: 8 }}>{stackName}</div>
              {items.map((suggestion) => (
                <div
                  key={suggestion.id}
                  style={{
                    ...cardStyle({ padding: "10px 14px", marginBottom: 6 }),
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontFamily: MONO_FONT,
                        fontSize: 11,
                        fontWeight: 700,
                        color: COLORS.textPrimary,
                      }}
                    >
                      {suggestion.name}
                    </div>
                    <div
                      style={{
                        fontFamily: MONO_FONT,
                        fontSize: 10,
                        color: COLORS.textMuted,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        marginTop: 2,
                      }}
                    >
                      {suggestion.command}
                    </div>
                  </div>

                  <span style={inlineBadge(COLORS.info, { fontSize: 9, padding: "1px 6px" })}>
                    {suggestion.source}
                  </span>

                  <button
                    type="button"
                    onClick={() => onAddCommand(suggestion)}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      height: 24,
                      padding: "0 8px",
                      fontSize: 10,
                      fontWeight: 700,
                      fontFamily: MONO_FONT,
                      textTransform: "uppercase",
                      letterSpacing: "1px",
                      color: COLORS.pageBg,
                      background: COLORS.accent,
                      border: `1px solid ${COLORS.accent}`,
                      borderRadius: 0,
                      cursor: "pointer",
                    }}
                  >
                    <Plus size={10} weight="bold" />
                    Add
                  </button>

                  <button
                    type="button"
                    onClick={() => setDismissed((prev) => new Set(prev).add(suggestion.id))}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 24,
                      height: 24,
                      background: "transparent",
                      border: `1px solid ${COLORS.outlineBorder}`,
                      borderRadius: 0,
                      color: COLORS.textMuted,
                      cursor: "pointer",
                    }}
                    title="Dismiss"
                  >
                    <X size={10} weight="bold" />
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* Footer */}
        {visibleSuggestions.length > 0 && (
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
              padding: "12px 16px",
              borderTop: `1px solid ${COLORS.border}`,
            }}
          >
            <button type="button" onClick={onClose} style={outlineButton()}>
              Done
            </button>
            <button
              type="button"
              onClick={() => onAddAll(visibleSuggestions)}
              style={primaryButton()}
            >
              Add All ({visibleSuggestions.length})
            </button>
          </div>
        )}
      </div>

      {/* Spin animation */}
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  );
}

import React from "react";
import {
  CaretDown,
  CaretRight,
  CheckCircle,
  Warning,
  XCircle,
  Clock,
  Sparkle,
  CircleNotch,
} from "@phosphor-icons/react";
import type {
  IntegrationProposalStep,
  IntegrationStepResolution,
  LaneSummary,
  AgentChatModelInfo,
  AgentChatProvider,
} from "../../../shared/types";
import { ConflictFilePreview } from "./ConflictFilePreview";

/* ---- Outcome dot ---- */

function OutcomeDot({ outcome }: { outcome: "clean" | "conflict" | "blocked" | "pending" }) {
  const config = {
    clean:    { icon: CheckCircle, color: "#22C55E" },
    conflict: { icon: Warning,     color: "#F59E0B" },
    blocked:  { icon: XCircle,     color: "#EF4444" },
    pending:  { icon: Clock,       color: "#71717A" },
  }[outcome];
  const Icon = config.icon;
  return (
    <span
      className="inline-flex items-center justify-center"
      style={{ width: 20, height: 20, background: `${config.color}18` }}
    >
      <Icon size={12} weight="fill" style={{ color: config.color }} />
    </span>
  );
}

/* ---- Status badge for lane readiness ---- */

function LaneStatusBadge({ outcome }: { outcome: "clean" | "conflict" | "blocked" | "pending" }) {
  const map = {
    clean:    { label: "READY",    fg: "#22C55E", bg: "#22C55E18" },
    conflict: { label: "CONFLICT", fg: "#F59E0B", bg: "#F59E0B18" },
    blocked:  { label: "BLOCKED",  fg: "#EF4444", bg: "#EF444418" },
    pending:  { label: "PENDING",  fg: "#71717A", bg: "#71717A18" },
  };
  const s = map[outcome];
  return (
    <span
      className="font-mono font-bold uppercase tracking-[1px]"
      style={{ fontSize: 9, padding: "1px 6px", background: s.bg, color: s.fg }}
    >
      {s.label}
    </span>
  );
}

/* ---- Resolution status indicator ---- */

function ResolutionIndicator({ resolution }: { resolution: IntegrationStepResolution | undefined }) {
  if (!resolution || resolution === "pending") return null;

  const map: Record<string, { label: string; color: string; spinning?: boolean }> = {
    "merged-clean": { label: "MERGED CLEAN", color: "#22C55E" },
    resolving:      { label: "RESOLVING...",  color: "#A78BFA", spinning: true },
    resolved:       { label: "RESOLVED",      color: "#22C55E" },
    failed:         { label: "FAILED",        color: "#EF4444" },
  };
  const s = map[resolution] ?? { label: resolution.toUpperCase(), color: "#71717A" };

  return (
    <span className="inline-flex items-center" style={{ gap: 4 }}>
      {s.spinning && (
        <CircleNotch size={10} className="animate-spin" style={{ color: s.color }} />
      )}
      <span
        className="font-mono font-bold uppercase tracking-[1px]"
        style={{ fontSize: 9, color: s.color }}
      >
        {s.label}
      </span>
    </span>
  );
}

/* ---- Main component ---- */

type IntegrationStepDetailProps = {
  step: IntegrationProposalStep;
  lane: LaneSummary | undefined;
  expanded: boolean;
  onToggle: () => void;
  resolution?: IntegrationStepResolution;
  onResolveWithAI?: (provider: AgentChatProvider, model: string, reasoningEffort?: string) => void;
  resolving?: boolean;
};

export function IntegrationStepDetail({
  step,
  lane,
  expanded,
  onToggle,
  resolution,
  onResolveWithAI,
  resolving,
}: IntegrationStepDetailProps) {
  const [models, setModels] = React.useState<AgentChatModelInfo[]>([]);
  const [selectedProvider, setSelectedProvider] = React.useState<AgentChatProvider>("claude");
  const [selectedModel, setSelectedModel] = React.useState("sonnet");
  const [selectedEffort, setSelectedEffort] = React.useState<string>("medium");

  // Load models on first expand
  React.useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    window.ade.agentChat
      .models({ provider: "claude" })
      .then((result) => {
        if (!cancelled && result.length > 0) {
          setModels(result);
          setSelectedModel(result[0].id);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [expanded]);

  const selectedModelInfo = models.find((m) => m.id === selectedModel);
  const reasoningOptions = selectedModelInfo?.reasoningEfforts ?? [];

  const outcomeColor =
    step.outcome === "clean" ? "#22C55E" :
    step.outcome === "conflict" ? "#F59E0B" :
    step.outcome === "blocked" ? "#EF4444" : "#71717A";

  const hasConflicts = step.conflictingFiles.length > 0;
  const isResolved = resolution === "resolved" || resolution === "merged-clean";

  return (
    <div
      style={{
        background: `${outcomeColor}06`,
        border: `1px solid ${outcomeColor}15`,
        marginBottom: 4,
      }}
    >
      {/* Collapsed header row */}
      <button
        type="button"
        className="flex w-full items-center justify-between text-left transition-colors duration-100"
        style={{
          padding: "10px 12px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = `${outcomeColor}08`; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
        onClick={onToggle}
      >
        <div className="flex items-center" style={{ gap: 8 }}>
          {expanded ? (
            <CaretDown size={12} weight="bold" style={{ color: "#52525B" }} />
          ) : (
            <CaretRight size={12} weight="bold" style={{ color: "#52525B" }} />
          )}
          <OutcomeDot outcome={step.outcome} />
          <span className="font-mono font-semibold" style={{ fontSize: 12, color: "#FAFAFA" }}>
            {step.laneName}
          </span>
          {lane?.branchRef && (
            <span className="font-mono" style={{ fontSize: 10, color: "#52525B" }}>
              {lane.branchRef.replace(/^refs\/heads\//, "").replace(/^origin\//, "")}
            </span>
          )}
        </div>

        <div className="flex items-center" style={{ gap: 8 }}>
          {/* Diff stats */}
          <span className="font-mono" style={{ fontSize: 11, color: "#71717A" }}>
            <span style={{ color: "#22C55E" }}>+{step.diffStat.insertions}</span>{" "}
            <span style={{ color: "#EF4444" }}>-{step.diffStat.deletions}</span>
          </span>
          <span className="font-mono" style={{ fontSize: 10, color: "#52525B" }}>
            {step.diffStat.filesChanged} {step.diffStat.filesChanged === 1 ? "file" : "files"}
          </span>
          <ResolutionIndicator resolution={resolution} />
          <LaneStatusBadge outcome={isResolved ? "clean" : step.outcome} />
        </div>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div
          style={{
            borderTop: `1px solid ${outcomeColor}15`,
            padding: "12px 12px 12px 36px",
          }}
        >
          {/* Conflict file previews */}
          {hasConflicts && (
            <div style={{ marginBottom: 12 }}>
              <div
                className="font-mono font-bold uppercase tracking-[1px]"
                style={{ fontSize: 9, color: "#F59E0B", marginBottom: 8 }}
              >
                CONFLICTING FILES ({step.conflictingFiles.length})
              </div>
              {step.conflictingFiles.map((file) => (
                <ConflictFilePreview key={file.path} file={file} />
              ))}
            </div>
          )}

          {/* No conflicts - clean merge info */}
          {!hasConflicts && (
            <div
              className="font-mono"
              style={{ fontSize: 11, color: "#22C55E", marginBottom: 12 }}
            >
              This lane merges cleanly. No conflicts detected.
            </div>
          )}

          {/* RESOLVE WITH AI button row (only show when there are conflicts and not yet resolved) */}
          {hasConflicts && !isResolved && onResolveWithAI && (
            <div
              style={{
                padding: "10px 12px",
                background: "#13101A",
                border: "1px solid #1E1B26",
              }}
            >
              <div className="flex items-center flex-wrap" style={{ gap: 8 }}>
                {/* Provider selector */}
                <select
                  className="font-mono font-bold uppercase tracking-[1px]"
                  style={{
                    fontSize: 10,
                    height: 28,
                    padding: "0 8px",
                    background: "#0C0A10",
                    color: "#A1A1AA",
                    border: "1px solid #27272A",
                    cursor: "pointer",
                    appearance: "auto",
                  }}
                  value={selectedProvider}
                  onChange={(e) => {
                    const prov = e.target.value as AgentChatProvider;
                    setSelectedProvider(prov);
                    // Reset model when provider changes
                    window.ade.agentChat
                      .models({ provider: prov })
                      .then((result) => {
                        if (result.length > 0) {
                          setModels(result);
                          setSelectedModel(result[0].id);
                        }
                      })
                      .catch(() => {});
                  }}
                >
                  <option value="claude">CLAUDE</option>
                  <option value="codex">CODEX</option>
                </select>

                {/* Model selector */}
                <select
                  className="font-mono"
                  style={{
                    fontSize: 10,
                    height: 28,
                    padding: "0 8px",
                    background: "#0C0A10",
                    color: "#A1A1AA",
                    border: "1px solid #27272A",
                    cursor: "pointer",
                    minWidth: 120,
                    appearance: "auto",
                  }}
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                >
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName}
                    </option>
                  ))}
                  {models.length === 0 && (
                    <option value={selectedModel}>{selectedModel}</option>
                  )}
                </select>

                {/* Reasoning effort selector */}
                {reasoningOptions.length > 0 && (
                  <select
                    className="font-mono"
                    style={{
                      fontSize: 10,
                      height: 28,
                      padding: "0 8px",
                      background: "#0C0A10",
                      color: "#A1A1AA",
                      border: "1px solid #27272A",
                      cursor: "pointer",
                      appearance: "auto",
                    }}
                    value={selectedEffort}
                    onChange={(e) => setSelectedEffort(e.target.value)}
                  >
                    {reasoningOptions.map((r) => (
                      <option key={r.effort} value={r.effort}>
                        {r.description}
                      </option>
                    ))}
                  </select>
                )}

                {/* Resolve button */}
                <button
                  type="button"
                  className="inline-flex items-center font-mono font-bold uppercase tracking-[1px] transition-all duration-100"
                  style={{
                    fontSize: 10,
                    height: 28,
                    padding: "0 12px",
                    background: resolving ? "#A78BFA40" : "#A78BFA",
                    color: "#0F0D14",
                    border: "none",
                    cursor: resolving ? "not-allowed" : "pointer",
                    opacity: resolving ? 0.6 : 1,
                  }}
                  disabled={resolving}
                  onClick={() => {
                    onResolveWithAI(
                      selectedProvider,
                      selectedModel,
                      reasoningOptions.length > 0 ? selectedEffort : undefined,
                    );
                  }}
                >
                  {resolving ? (
                    <CircleNotch size={12} className="animate-spin" style={{ marginRight: 6, color: "#0F0D14" }} />
                  ) : (
                    <Sparkle size={12} weight="fill" style={{ marginRight: 6 }} />
                  )}
                  {resolving ? "RESOLVING..." : "RESOLVE WITH AI"}
                </button>
              </div>
            </div>
          )}

          {/* Already resolved indicator */}
          {hasConflicts && isResolved && (
            <div
              className="flex items-center font-mono"
              style={{
                gap: 8,
                padding: "10px 12px",
                background: "#22C55E08",
                border: "1px solid #22C55E15",
                fontSize: 11,
                color: "#22C55E",
              }}
            >
              <CheckCircle size={14} weight="fill" />
              Conflicts resolved successfully.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

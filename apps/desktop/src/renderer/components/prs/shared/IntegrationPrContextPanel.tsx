import React from "react";
import { ArrowRight, CheckCircle, Warning } from "@phosphor-icons/react";
import type { LaneSummary, PrMergeContext, PrWithConflicts } from "../../../../shared/types";
import { deriveIntegrationPrLiveModel } from "./integrationPrModel";

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="font-mono font-bold uppercase tracking-[1px]"
      style={{ fontSize: 10, color: "#71717A", marginBottom: 12 }}
    >
      {children}
    </div>
  );
}

function Timeline({
  stages,
}: {
  stages: Array<{ key: string; label: string; status: "done" | "current" | "pending" }>;
}) {
  return (
    <div
      style={{
        background: "#13101A",
        border: "1px solid #1E1B26",
        padding: 16,
      }}
    >
      <SectionLabel>INTEGRATION TIMELINE</SectionLabel>
      <div className="flex items-center flex-wrap" style={{ gap: 10 }}>
        {stages.map((stage, index) => {
          const palette = stage.status === "done"
            ? { bg: "#22C55E18", fg: "#22C55E", border: "#22C55E30" }
            : stage.status === "current"
              ? { bg: "#A78BFA18", fg: "#C4B5FD", border: "#A78BFA30" }
              : { bg: "#71717A12", fg: "#71717A", border: "#27272A" };
          return (
            <React.Fragment key={stage.key}>
              <div
                className="inline-flex items-center font-mono font-bold uppercase tracking-[1px]"
                style={{
                  fontSize: 10,
                  minHeight: 28,
                  padding: "0 10px",
                  background: palette.bg,
                  color: palette.fg,
                  border: `1px solid ${palette.border}`,
                }}
              >
                {stage.label}
              </div>
              {index < stages.length - 1 ? (
                <ArrowRight size={12} weight="bold" style={{ color: "#52525B" }} />
              ) : null}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

type IntegrationPrContextPanelProps = {
  pr: PrWithConflicts;
  lanes: LaneSummary[];
  mergeContext: PrMergeContext | null;
  statusNode?: React.ReactNode;
  actions?: React.ReactNode;
  messages?: string[];
};

export function IntegrationPrContextPanel({
  pr,
  lanes,
  mergeContext,
  statusNode,
  actions,
  messages = [],
}: IntegrationPrContextPanelProps) {
  const laneById = React.useMemo(() => new Map(lanes.map((lane) => [lane.id, lane])), [lanes]);
  const liveModel = React.useMemo(
    () => deriveIntegrationPrLiveModel({ prLaneId: pr.laneId, mergeContext }),
    [mergeContext, pr.laneId],
  );
  const sourceLanes = React.useMemo(
    () => liveModel.provenanceLaneIds.map((laneId) => ({
      laneId,
      laneName: laneById.get(laneId)?.name ?? laneId,
      branchRef: laneById.get(laneId)?.branchRef ?? null,
    })),
    [laneById, liveModel.provenanceLaneIds],
  );
  const liveLaneName = liveModel.integrationLaneId
    ? laneById.get(liveModel.integrationLaneId)?.name ?? pr.headBranch
    : pr.headBranch;
  const targetLaneName = liveModel.baseLaneId
    ? laneById.get(liveModel.baseLaneId)?.name ?? pr.baseBranch
    : pr.baseBranch;
  const stages = [
    { key: "proposal", label: "Proposal", status: "done" as const },
    { key: "integration-lane", label: "Integration Lane Created", status: "done" as const },
    { key: "pr-opened", label: "PR Opened", status: pr.state === "merged" ? "done" as const : "current" as const },
    { key: "merged", label: `Merged Into ${pr.baseBranch}`, status: pr.state === "merged" ? "done" as const : "pending" as const },
  ];

  return (
    <div className="flex flex-col" style={{ gap: 16, marginBottom: 16 }}>
      <Timeline stages={stages} />

      <div
        style={{
          background: "#13101A",
          border: "1px solid #1E1B26",
          padding: 16,
        }}
      >
        <div className="flex items-start justify-between" style={{ gap: 12 }}>
          <div className="flex items-start" style={{ gap: 10 }}>
            <CheckCircle size={14} weight="fill" style={{ color: "#A78BFA", marginTop: 1, flexShrink: 0 }} />
            <div className="flex flex-col" style={{ gap: 6 }}>
              <div className="font-mono font-semibold uppercase tracking-[1px]" style={{ fontSize: 10, color: "#C4B5FD" }}>
                Integration Lane Is Now A Normal PR
              </div>
              <div className="font-mono" style={{ fontSize: 10, color: "#DDD6FE", lineHeight: "16px" }}>
                ADE assembled the selected source lanes into <span style={{ color: "#FAFAFA" }}>{pr.headBranch}</span> and opened this PR from that integration lane.
                {" "}
                From here on, this behaves like a normal PR. The original source lanes stay visible here as provenance.
              </div>
            </div>
          </div>
          {statusNode ? <div className="shrink-0">{statusNode}</div> : null}
        </div>

        {messages.length > 0 ? (
          <div
            style={{
              background: "#F59E0B08",
              border: "1px solid #F59E0B30",
              padding: 12,
              marginTop: 12,
            }}
          >
            <div className="flex items-start" style={{ gap: 10 }}>
              <Warning size={14} weight="fill" style={{ color: "#F59E0B", marginTop: 1, flexShrink: 0 }} />
              <div className="flex flex-col" style={{ gap: 6 }}>
                {messages.map((message) => (
                  <div key={message} className="font-mono" style={{ fontSize: 10, color: "#D4A857" }}>
                    {message}
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        <div
          style={{
            marginTop: 12,
            paddingTop: 12,
            borderTop: "1px solid #1E1B26",
          }}
        >
          <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
            <SectionLabel>INTEGRATION PROVENANCE</SectionLabel>
            <span className="font-mono font-bold uppercase tracking-[1px]" style={{ fontSize: 9, color: "#A1A1AA" }}>
              {sourceLanes.length} LANE{sourceLanes.length !== 1 ? "S" : ""}
            </span>
          </div>
          <div className="font-mono" style={{ fontSize: 10, color: "#71717A", marginBottom: 12 }}>
            These lanes were used to assemble the integration lane. Live merge checks now run on {liveLaneName}.
          </div>
          <div className="flex flex-col" style={{ gap: 4 }}>
            {sourceLanes.map((lane) => (
              <div
                key={lane.laneId}
                style={{
                  padding: "10px 12px",
                  background: "#0F0D14",
                  border: "1px solid #1E1B26",
                }}
              >
                <div className="flex items-center justify-between" style={{ gap: 8 }}>
                  <div className="flex items-center" style={{ gap: 8 }}>
                    <span className="font-mono font-semibold" style={{ fontSize: 12, color: "#FAFAFA" }}>
                      {lane.laneName}
                    </span>
                    {lane.branchRef ? (
                      <span className="font-mono" style={{ fontSize: 10, color: "#52525B" }}>
                        {lane.branchRef}
                      </span>
                    ) : null}
                  </div>
                  <span
                    className="font-mono font-bold uppercase tracking-[1px]"
                    style={{ fontSize: 9, color: "#22C55E", background: "#22C55E18", padding: "1px 6px" }}
                  >
                    Included
                  </span>
                </div>
              </div>
            ))}
          </div>
          <div className="flex items-center" style={{ gap: 8, marginTop: 8, paddingTop: 8, borderTop: "1px solid #1E1B2680" }}>
            <ArrowRight size={12} weight="bold" style={{ color: "#52525B" }} />
            <span
              className="font-mono font-bold uppercase tracking-[1px] inline-flex items-center"
              style={{
                fontSize: 10,
                padding: "4px 10px",
                background: "#A78BFA18",
                color: "#A78BFA",
                border: "1px solid #A78BFA30",
              }}
            >
              {targetLaneName}
            </span>
            <span className="font-mono" style={{ fontSize: 10, color: "#52525B" }}>integration target</span>
          </div>
        </div>

        {actions ? (
          <div
            className="flex flex-wrap items-center"
            style={{ gap: 8, marginTop: 12, paddingTop: 12, borderTop: "1px solid #1E1B26" }}
          >
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}

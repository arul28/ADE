import { useCallback, useEffect, useMemo, useState } from "react";
import { CircleNotch } from "@phosphor-icons/react";
import type {
  AgentChatSession,
  LaneLinearIssue,
  LaneSummary,
} from "../../../shared/types";
import type { WorkDraftKind } from "../../state/appStore";
import { useAppStore } from "../../state/appStore";
import { AgentChatPane, type AgentChatSessionCreatedOptions } from "../chat/AgentChatPane";
import type { WorkPtyLaunchArgs, WorkPtyLaunchResult } from "./cliLaunch";
import type { ExternalSessionImportResult, ExternalSessionSummary } from "./importSessions/contract";

type WorkStartSurfaceProps = {
  draftKind: WorkDraftKind;
  orchestratorEnabled?: boolean;
  draftLaneId?: string | null;
  draftContextTargetId?: string | null;
  lanes: LaneSummary[];
  onOpenChatSession: (session: AgentChatSession, options?: AgentChatSessionCreatedOptions) => void | Promise<void>;
  onLaunchPtySession: (args: WorkPtyLaunchArgs) => Promise<WorkPtyLaunchResult>;
  onImportedSession?: (summary: ExternalSessionSummary, result: ExternalSessionImportResult) => void;
  onOpenExistingImportedSession?: (ref: { kind: "chat" | "cli"; sessionId: string }) => void;
  onDraftLaneChange?: (laneId: string) => void;
  initialLinearIssueContext?: LaneLinearIssue | null;
  initialLinearIssueContextSource?: "manual" | "lane_link";
  initialModelId?: string | null;
  onInitialLinearIssueContextConsumed?: () => void;
  suppressDraftLaunchNavigation?: boolean;
};

export function WorkStartSurface({
  draftKind,
  orchestratorEnabled = false,
  draftLaneId = null,
  draftContextTargetId = null,
  lanes,
  onOpenChatSession,
  onLaunchPtySession,
  onImportedSession,
  onOpenExistingImportedSession,
  onDraftLaneChange,
  initialLinearIssueContext = null,
  initialLinearIssueContextSource = "lane_link",
  initialModelId = null,
  onInitialLinearIssueContextConsumed,
  suppressDraftLaunchNavigation = false,
}: WorkStartSurfaceProps) {
  const globallySelectedLaneId = useAppStore((s) => s.selectedLaneId);
  const lanesLoading = useAppStore((s) => s.lanesLoading);
  const selectLaneGlobal = useAppStore((s) => s.selectLane);
  const [selectedLaneId, setSelectedLaneId] = useState<string>(() => {
    if (draftLaneId && lanes.some((lane) => lane.id === draftLaneId)) {
      return draftLaneId;
    }
    if (globallySelectedLaneId && lanes.some((lane) => lane.id === globallySelectedLaneId)) {
      return globallySelectedLaneId;
    }
    return lanes[0]?.id ?? "";
  });
  const [launchBusy, setLaunchBusy] = useState(false);
  const selectedLane = useMemo(
    () => lanes.find((lane) => lane.id === selectedLaneId) ?? lanes[0] ?? null,
    [lanes, selectedLaneId],
  );

  const setLaneAndSync = useCallback((laneId: string) => {
    setSelectedLaneId(laneId);
    onDraftLaneChange?.(laneId);
    selectLaneGlobal(laneId);
  }, [onDraftLaneChange, selectLaneGlobal]);

  useEffect(() => {
    if (!lanes.length) {
      setSelectedLaneId("");
      return;
    }
    if (draftLaneId && draftLaneId !== selectedLaneId && lanes.some((lane) => lane.id === draftLaneId)) {
      setSelectedLaneId(draftLaneId);
      selectLaneGlobal(draftLaneId);
      return;
    }
    if (!selectedLaneId || !lanes.some((lane) => lane.id === selectedLaneId)) {
      const fallbackLaneId =
        draftLaneId && lanes.some((lane) => lane.id === draftLaneId)
          ? draftLaneId
          : globallySelectedLaneId && lanes.some((lane) => lane.id === globallySelectedLaneId)
            ? globallySelectedLaneId
            : lanes[0]!.id;
      setSelectedLaneId(fallbackLaneId);
      onDraftLaneChange?.(fallbackLaneId);
      selectLaneGlobal(fallbackLaneId);
    }
  }, [draftLaneId, globallySelectedLaneId, lanes, onDraftLaneChange, selectedLaneId, selectLaneGlobal]);

  const launchShell = async (laneId: string) => {
    if (!laneId || launchBusy) return;
    setLaunchBusy(true);
    try {
      await onLaunchPtySession({
        laneId,
        profile: "shell",
        title: "Shell",
      });
    } finally {
      setLaunchBusy(false);
    }
  };

  if (!lanes.length) {
    return (
      <div className="flex h-full items-center justify-center px-6" style={{ background: "var(--chat-canvas-bg)" }}>
        <div className="ade-liquid-glass ade-liquid-glass-menu rounded-lg p-5 text-center">
          {lanesLoading ? (
            <CircleNotch size={18} className="mx-auto mb-2 animate-spin text-muted-fg" />
          ) : null}
          <div className="text-[12px] font-medium text-fg">
            {lanesLoading ? "Loading lanes" : "No lanes available"}
          </div>
          <div className="mt-1.5 text-[11px] text-muted-fg">
            {lanesLoading
              ? "Reading lane state for this project."
              : "Create or reopen a lane before starting work."}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ background: "var(--chat-canvas-bg)" }}>
      <div className="flex w-full min-h-0 flex-1 flex-col overflow-hidden">
        <AgentChatPane
          laneId={selectedLaneId}
          laneLabel={selectedLane?.name ?? selectedLaneId}
          hideSessionTabs
          hideLaneToolDrawers
          forceDraftMode
          draftContextTargetId={draftContextTargetId}
          embeddedWorkLayout
          suppressDraftLaunchNavigation={suppressDraftLaunchNavigation}
          workDraftKind={draftKind}
          orchestratorEnabled={orchestratorEnabled}
          initialLinearIssueContext={initialLinearIssueContext}
          initialLinearIssueContextSource={initialLinearIssueContextSource}
          initialModelId={initialModelId}
          onInitialLinearIssueContextConsumed={onInitialLinearIssueContextConsumed}
          onSessionCreated={onOpenChatSession}
          onLaunchCliSession={onLaunchPtySession}
          onImportedSession={onImportedSession}
          onOpenExistingImportedSession={onOpenExistingImportedSession}
          onOpenShellSession={launchShell}
          availableLanes={lanes}
          onLaneChange={setLaneAndSync}
        />
      </div>
    </div>
  );
}

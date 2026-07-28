import { useCallback, useEffect, useMemo, useState } from "react";
import { CircleNotch } from "@phosphor-icons/react";
import type {
  AgentChatSession,
  LaneLinearIssue,
  LaneSummary,
} from "../../../shared/types";
import type { WorkDraftKind } from "../../state/appStore";
import { useAppStore, useRootAppStore } from "../../state/appStore";
import { AgentChatPane, type AgentChatSessionCreatedOptions } from "../chat/AgentChatPane";
import type { WorkPtyLaunchArgs, WorkPtyLaunchResult } from "./cliLaunch";
import type { ExternalSessionImportResult, ExternalSessionSummary } from "./importSessions/contract";

type WorkStartSurfaceProps = {
  draftKind: WorkDraftKind;
  orchestratorEnabled?: boolean;
  draftLaneId?: string | null;
  draftMachineId?: string | null;
  draftContextTargetId?: string | null;
  lanes: LaneSummary[];
  onOpenChatSession: (session: AgentChatSession, options?: AgentChatSessionCreatedOptions) => void | Promise<void>;
  onLaunchPtySession: (args: WorkPtyLaunchArgs) => Promise<WorkPtyLaunchResult>;
  onImportedSession?: (summary: ExternalSessionSummary, result: ExternalSessionImportResult) => void;
  onOpenExistingImportedSession?: (ref: { kind: "chat" | "cli"; sessionId: string }) => void;
  onDraftLaneChange?: (laneId: string) => void;
  onDraftMachineChange?: (machineId: string | null) => void;
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
  draftMachineId = null,
  draftContextTargetId = null,
  lanes,
  onOpenChatSession,
  onLaunchPtySession,
  onImportedSession,
  onOpenExistingImportedSession,
  onDraftLaneChange,
  onDraftMachineChange,
  initialLinearIssueContext = null,
  initialLinearIssueContextSource = "lane_link",
  initialModelId = null,
  onInitialLinearIssueContextConsumed,
  suppressDraftLaunchNavigation = false,
}: WorkStartSurfaceProps) {
  const globallySelectedLaneId = useAppStore((s) => s.selectedLaneId);
  const projectBinding = useAppStore((s) => s.projectBinding);
  const lanesLoading = useAppStore((s) => s.lanesLoading);
  const selectLaneGlobal = useAppStore((s) => s.selectLane);
  const crossMachineLanesByMachineId = useRootAppStore(
    (state) => state.crossMachineLanesByMachineId,
  );
  const boundMachineId = projectBinding?.kind === "remote"
    ? projectBinding.targetId
    : "this-mac";
  const draftMachinePending = Boolean(
    draftMachineId
    && draftMachineId !== boundMachineId
    && !crossMachineLanesByMachineId[draftMachineId],
  );
  const laneForMachine = useCallback((machineId: string | null, laneId: string) => {
    const resolvedMachineId = machineId ?? boundMachineId;
    if (resolvedMachineId === boundMachineId) {
      return lanes.find((lane) => lane.id === laneId) ?? null;
    }
    return crossMachineLanesByMachineId[resolvedMachineId]?.lanes.find(
      (lane) => lane.id === laneId,
    ) ?? null;
  }, [boundMachineId, crossMachineLanesByMachineId, lanes]);
  const isKnownLaneId = useCallback(
    (laneId: string | null | undefined): laneId is string =>
      typeof laneId === "string" && Boolean(laneForMachine(draftMachineId, laneId)),
    [draftMachineId, laneForMachine],
  );
  const [selectedLaneId, setSelectedLaneId] = useState<string>(() => {
    if (isKnownLaneId(draftLaneId)) {
      return draftLaneId;
    }
    if (draftMachinePending && draftLaneId) {
      return draftLaneId;
    }
    if (isKnownLaneId(globallySelectedLaneId)) {
      return globallySelectedLaneId;
    }
    return lanes[0]?.id ?? "";
  });
  const [launchBusy, setLaunchBusy] = useState(false);
  const selectedLane = useMemo(
    () => laneForMachine(draftMachineId, selectedLaneId)
      ?? (draftMachinePending ? null : lanes[0])
      ?? null,
    [draftMachineId, draftMachinePending, laneForMachine, lanes, selectedLaneId],
  );

  const setLaneAndSync = useCallback((laneId: string) => {
    setSelectedLaneId(laneId);
    onDraftLaneChange?.(laneId);
    if (!draftMachineId || draftMachineId === boundMachineId) {
      selectLaneGlobal(laneId);
    }
  }, [boundMachineId, draftMachineId, onDraftLaneChange, selectLaneGlobal]);

  useEffect(() => {
    if (!lanes.length) {
      setSelectedLaneId("");
      return;
    }
    if (draftLaneId && draftLaneId !== selectedLaneId && isKnownLaneId(draftLaneId)) {
      setSelectedLaneId(draftLaneId);
      if (!draftMachineId || draftMachineId === boundMachineId) {
        selectLaneGlobal(draftLaneId);
      }
      return;
    }
    if (draftMachinePending && draftLaneId) {
      if (selectedLaneId !== draftLaneId) setSelectedLaneId(draftLaneId);
      return;
    }
    if (!selectedLaneId || !isKnownLaneId(selectedLaneId)) {
      const fallbackLaneId =
        draftLaneId && isKnownLaneId(draftLaneId)
          ? draftLaneId
          : globallySelectedLaneId && isKnownLaneId(globallySelectedLaneId)
            ? globallySelectedLaneId
            : lanes[0]!.id;
      setSelectedLaneId(fallbackLaneId);
      onDraftLaneChange?.(fallbackLaneId);
      if (!draftMachineId || draftMachineId === boundMachineId) {
        selectLaneGlobal(fallbackLaneId);
      }
    }
  }, [
    draftLaneId,
    draftMachineId,
    draftMachinePending,
    boundMachineId,
    globallySelectedLaneId,
    isKnownLaneId,
    lanes,
    onDraftLaneChange,
    selectedLaneId,
    selectLaneGlobal,
  ]);

  const launchShell = async (
    laneId: string,
    pin?: Parameters<typeof onLaunchPtySession>[0]["pin"],
  ) => {
    if (!laneId || launchBusy) return;
    setLaunchBusy(true);
    try {
      await onLaunchPtySession({
        laneId,
        profile: "shell",
        title: "Shell",
        ...(pin ? { pin } : {}),
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
          initialDraftMachineId={draftMachineId}
          onDraftMachineChange={onDraftMachineChange}
        />
      </div>
    </div>
  );
}

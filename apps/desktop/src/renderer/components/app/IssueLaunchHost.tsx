import React, { useCallback, useEffect, useRef, useState } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import {
  BatchLaunchAgentReadinessTracker,
  defaultIssueKickoffPrompt,
  defaultKickoffIntro,
  isBatchLaunchInFlight,
  launchIssueIdentity,
  runBatchLaunch,
  type BatchLaunchItemState,
  type BatchLaunchIssueConfig,
} from "../../lib/linearBatchLaunch";
import { ensureHarnessPresetOnBrain } from "../../lib/harnessPresetAccountSync";
import { announceWorkChatSessionCreated } from "../../lib/chatSessionEvents";
import { copyLaunchPromptToClipboard } from "../../lib/launchPromptClipboard";
import { clearCreatingIssue, rememberCreatingIssues, rememberLaunchedLanes } from "../../lib/launchedLanesHighlight";
import {
  clearPendingIssueLaunchRequest,
  notifyIssueLaunchCancelled,
  notifyIssueLaunchRequestClosed,
  publishIssueLaunchProgress,
  subscribeIssueLaunchRequests,
  takePendingIssueLaunchRequest,
  type IssueLaunchProgress,
  type IssueLaunchRequest,
} from "../../lib/issueLaunchRequests";
import { requestCrossMachineLanesForMachine } from "../../state/crossMachineLanes";
import { useActiveProjectRoot, useAppStore, workViewStoreForProject } from "../../state/appStore";
import { settingsRouteFor } from "../settings/settingsManifest";
import { BatchLaunchModal, type BatchLaunchMachine, type BatchLaunchSubmit } from "./BatchLaunchModal";
import { BatchLaunchStatusToast } from "./BatchLaunchStatusToast";

type PendingIssueLaunchRequest = IssueLaunchRequest & { nonce: string };

function issueLaunchProgress(states: Map<string, BatchLaunchItemState>): IssueLaunchProgress | null {
  if (states.size === 0) return null;
  const rows = [...states.values()];
  return {
    total: rows.length,
    completed: rows.filter((row) => row.status === "done").length,
    failed: rows.filter((row) => row.status === "failed" || row.status === "agent-error").length,
    running: rows.some((row) => isBatchLaunchInFlight(row.status)),
  };
}

/** App-wide owner for issue launch configuration, execution, and status. */
export function IssueLaunchHost() {
  const projectRoot = useActiveProjectRoot();
  const project = useAppStore((state) => state.project);
  const lanes = useAppStore((state) => state.lanes);
  const refreshLanes = useAppStore((state) => state.refreshLanes);
  const selectLane = useAppStore((state) => state.selectLane);
  const launchPromptClipboardEnabled = useAppStore((state) => state.launchPromptClipboardEnabled);
  const [request, setRequest] = useState<PendingIssueLaunchRequest | null>(null);
  const [states, setStates] = useState<Map<string, BatchLaunchItemState>>(new Map());
  const statesRef = useRef(states);
  const batchAgentReadinessRef = useRef(new BatchLaunchAgentReadinessTracker());
  const batchConfigByIssueRef = useRef<Map<string, BatchLaunchIssueConfig>>(new Map());
  const batchMachineByIssueRef = useRef<Map<string, BatchLaunchMachine>>(new Map());
  const batchMachineByLaneIdRef = useRef<Map<string, BatchLaunchMachine>>(new Map());

  const updateStates = useCallback((update: (current: Map<string, BatchLaunchItemState>) => Map<string, BatchLaunchItemState>) => {
    const next = update(statesRef.current);
    statesRef.current = next;
    setStates(next);
    publishIssueLaunchProgress(issueLaunchProgress(next));
  }, []);

  useEffect(() => {
    const pending = takePendingIssueLaunchRequest();
    if (pending) setRequest(pending);
    return subscribeIssueLaunchRequests((next) => {
      clearPendingIssueLaunchRequest();
      setRequest(next);
      updateStates(() => new Map());
      batchConfigByIssueRef.current.clear();
      batchMachineByIssueRef.current.clear();
      batchMachineByLaneIdRef.current.clear();
    });
  }, [updateStates]);

  useEffect(() => window.ade.agentChat.onEvent((envelope) => {
    const transition = batchAgentReadinessRef.current.observe(envelope);
    if (!transition) return;
    updateStates((current) => {
      const state = current.get(transition.issueId);
      if (!state || (state.status !== "initializing-agent" && state.status !== "done")) return current;
      if (state.status === "done" && transition.outcome.status === "done") return current;
      const next = new Map(current);
      next.set(transition.issueId, { ...state, ...transition.outcome });
      return next;
    });
  }), [updateStates]);

  const launchBatch = useCallback(async (entries: BatchLaunchSubmit[], machine: BatchLaunchMachine) => {
    if (!entries.length) return;
    const pin = machine.pin;
    for (const { issue } of entries) batchMachineByIssueRef.current.set(launchIssueIdentity(issue), machine);
    batchAgentReadinessRef.current.beginBatch();
    if (launchPromptClipboardEnabled) {
      const lastLaunchEntry = [...entries].reverse().find(({ config }) => !config.laneOnly);
      const lastPrompt = lastLaunchEntry
        ? lastLaunchEntry.config.kickoffPrompt.trim()
          || (lastLaunchEntry.config.sessionType === "cli" && lastLaunchEntry.issue.tracker === "linear"
            ? defaultKickoffIntro()
            : defaultIssueKickoffPrompt(lastLaunchEntry.issue))
        : "";
      void copyLaunchPromptToClipboard(lastPrompt);
    }
    const creatingPlaceholders = entries
      .filter(({ config }) => !config.existingLaneId)
      .map(({ issue }) => ({ issueId: launchIssueIdentity(issue), tracker: issue.tracker, name: issue.laneName }));
    if (creatingPlaceholders.length) rememberCreatingIssues({ issues: creatingPlaceholders });

    updateStates(() => {
      const next = new Map<string, BatchLaunchItemState>();
      for (const { issue, config } of entries) {
        const issueId = launchIssueIdentity(issue);
        next.set(issueId, { issue, status: "pending", laneId: null, sessionId: null, error: null });
        batchConfigByIssueRef.current.set(issueId, config);
      }
      return next;
    });

    const result = await runBatchLaunch(entries, {
      createLane: (args) => pin ? window.ade.lanes.create(args, pin) : window.ade.lanes.create(args),
      launch: async (args) => {
        const launchArgs: Parameters<typeof window.ade.agentChat.launch>[0] = {
          laneId: args.laneId,
          provider: args.provider,
          model: args.model,
          modelId: args.modelId,
          reasoningEffort: args.reasoningEffort,
          ...(args.fastMode !== undefined ? { fastMode: args.fastMode } : {}),
          ...(args.permissionMode != null ? { permissionMode: args.permissionMode } : {}),
          ...(args.interactionMode !== undefined ? { interactionMode: args.interactionMode } : {}),
          ...(args.claudePermissionMode !== undefined ? { claudePermissionMode: args.claudePermissionMode } : {}),
          ...(args.codexApprovalPolicy !== undefined ? { codexApprovalPolicy: args.codexApprovalPolicy } : {}),
          ...(args.codexSandbox !== undefined ? { codexSandbox: args.codexSandbox } : {}),
          ...(args.codexConfigSource !== undefined ? { codexConfigSource: args.codexConfigSource } : {}),
          ...(args.opencodePermissionMode !== undefined ? { opencodePermissionMode: args.opencodePermissionMode } : {}),
          ...(args.droidPermissionMode !== undefined ? { droidPermissionMode: args.droidPermissionMode } : {}),
          ...(args.cursorModeId !== undefined ? { cursorModeId: args.cursorModeId } : {}),
          ...(args.cursorConfigValues !== undefined ? { cursorConfigValues: args.cursorConfigValues } : {}),
          kickoffText: args.kickoffText,
          contextAttachments: args.contextAttachments,
          ...(args.presetId ? { presetId: args.presetId } : {}),
        };
        await ensureHarnessPresetOnBrain(args.presetId, { targetsAnotherMachine: pin?.kind === "remote" });
        const session = pin
          ? await window.ade.agentChat.launch(launchArgs, pin)
          : await window.ade.agentChat.launch(launchArgs);
        if (projectRoot && !pin) announceWorkChatSessionCreated(projectRoot, session);
        return session;
      },
      launchCli: async (args) => {
        await ensureHarnessPresetOnBrain(args.presetId, { targetsAnotherMachine: pin?.kind === "remote" });
        const cliArgs: Parameters<typeof window.ade.agentChat.launchCli>[0] = {
          laneId: args.laneId,
          provider: args.provider,
          model: args.model,
          reasoningEffort: args.reasoningEffort,
          ...(args.fastMode !== undefined ? { fastMode: args.fastMode } : {}),
          ...(args.permissionMode != null ? { permissionMode: args.permissionMode } : {}),
          kickoffPrompt: args.kickoffPrompt,
          ...(args.linearIssues ? { linearIssues: args.linearIssues } : {}),
          ...(args.presetId ? { presetId: args.presetId } : {}),
        };
        return pin ? window.ade.agentChat.launchCli(cliArgs, pin) : window.ade.agentChat.launchCli(cliArgs);
      },
      deleteLane: (args) => (pin ? window.ade.lanes.delete(args, pin) : window.ade.lanes.delete(args)).then(() => undefined),
    }, {
      onItem: (issueId, patch) => {
        if (patch.laneId) {
          clearCreatingIssue(issueId);
          batchMachineByLaneIdRef.current.set(patch.laneId, machine);
        }
        const earlyOutcome = patch.sessionId ? batchAgentReadinessRef.current.registerSession(issueId, patch.sessionId) : null;
        updateStates((current) => {
          const prev = current.get(issueId);
          if (!prev) return current;
          const next = new Map(current);
          next.set(issueId, { ...prev, ...patch, ...(patch.status === "initializing-agent" && earlyOutcome ? earlyOutcome : {}) });
          return next;
        });
      },
    }).finally(() => batchAgentReadinessRef.current.finishRegistration());

    for (const issueId of result.failedIssueIds) clearCreatingIssue(issueId);
    if (pin) requestCrossMachineLanesForMachine(machine.machineId);
    else {
      // This host sits in AppShell, above the project's AppStoreProvider, so
      // its own store is the root one. Refresh the project surface's store
      // too, or the Lanes page keeps its old list until the next reload.
      const projectStore = workViewStoreForProject(projectRoot);
      await Promise.all([
        refreshLanes({ includeStatus: false }),
        projectStore.getState().refreshLanes === refreshLanes
          ? Promise.resolve()
          : projectStore.getState().refreshLanes({ includeStatus: false }),
      ]).catch(() => undefined);
    }
    if (!pin && (result.createdLaneIds.length || result.createdSessionIds.length)) {
      rememberLaunchedLanes({ laneIds: result.createdLaneIds, sessionIds: result.createdSessionIds });
    }
  }, [launchPromptClipboardEnabled, projectRoot, refreshLanes, updateStates]);

  const handleLaunch = useCallback((entries: BatchLaunchSubmit[], machine: BatchLaunchMachine) => {
    if (request) notifyIssueLaunchRequestClosed(request.nonce);
    setRequest(null);
    window.location.hash = "#/lanes?drawer=stack";
    void launchBatch(entries, machine).catch((error: unknown) => {
      console.error("[Issue launch] Batch launch failed:", error);
    });
  }, [launchBatch, request]);

  const handleOpenChange = useCallback((open: boolean) => {
    if (open) return;
    if (request) {
      notifyIssueLaunchRequestClosed(request.nonce);
      if (request.returnToLinearPane) notifyIssueLaunchCancelled(request.nonce);
    }
    setRequest(null);
  }, [request]);

  const handleRetryFailed = useCallback(() => {
    const failed = [...statesRef.current.values()].filter((state) => state.status === "failed");
    if (!failed.length) return;
    const machineIds = new Set(failed.map((state) => batchMachineByIssueRef.current.get(launchIssueIdentity(state.issue))?.machineId ?? ""));
    if (machineIds.has("") || machineIds.size !== 1) return;
    const machine = batchMachineByIssueRef.current.get(launchIssueIdentity(failed[0]!.issue))!;
    const entries = failed.map((state) => ({
      issue: state.issue,
      config: batchConfigByIssueRef.current.get(launchIssueIdentity(state.issue)) ?? {
        modelId: "",
        reasoningEffort: null,
        fastMode: false,
        kickoffPrompt: "",
        branchOverride: "",
      },
    }));
    void launchBatch(entries, machine).catch((error: unknown) => {
      console.error("[Issue launch] Batch retry failed:", error);
    });
  }, [launchBatch]);

  const dismissStatus = useCallback(() => updateStates(() => new Map()), [updateStates]);
  const openLane = useCallback((laneId: string) => {
    const machine = batchMachineByLaneIdRef.current.get(laneId);
    if (machine?.pin) {
      window.location.hash = `#/lanes?laneId=${encodeURIComponent(laneId)}&machineId=${encodeURIComponent(machine.machineId)}&focus=single`;
      return;
    }
    selectLane(laneId);
    workViewStoreForProject(projectRoot).getState().selectLane(laneId);
    window.location.hash = `#/lanes?laneId=${encodeURIComponent(laneId)}&focus=single`;
  }, [projectRoot, selectLane]);

  return (
    <>
      <BatchLaunchModal
        onOpenHarnessSettings={request?.onOpenHarnessSettings ?? (() => { window.location.hash = `#${settingsRouteFor("agents.harnesses")}`; })}
        open={request !== null}
        projectRoot={project?.rootPath}
        issues={request?.issues ?? []}
        lanes={lanes}
        laneOnly={request?.laneOnly}
        onOpenChange={handleOpenChange}
        onLaunch={handleLaunch}
      />
      <BatchLaunchStatusToast
        states={states}
        onRetryFailed={handleRetryFailed}
        onDismiss={dismissStatus}
        onOpenLane={openLane}
      />
    </>
  );
}

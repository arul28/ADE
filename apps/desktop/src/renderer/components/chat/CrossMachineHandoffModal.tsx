import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle,
  CircleNotch,
  CloudArrowUp,
  Desktop,
  GitBranch,
  GitFork,
  HardDrives,
  Hourglass,
  LockKey,
  ShieldWarning,
  Warning,
  X,
} from "@phosphor-icons/react";
import type {
  AgentChatCrossMachineHandoffOptionsResult,
  AgentChatCrossMachineHandoffRecord,
  AgentChatPermissionMode,
  AgentChatCrossMachineDestinationPreflightResult,
  AgentChatCrossMachineTargetConfig,
  AgentChatPrepareCrossMachineHandoffResult,
  AgentChatProvider,
  GitUpstreamSyncStatus,
  LaneSummary,
  OpenProjectBinding,
  RemoteRuntimeConnectionStatus,
  RemoteRuntimeHandoffStoragePreflightResult,
  RemoteRuntimeProjectRecord,
} from "../../../shared/types";
import {
  decodeCrossMachineDestinationPreflightResult,
  normalizeGitRemoteIdentity,
} from "../../../shared/crossMachineHandoff";
import { stripElectronErrorWrapper } from "../../../shared/codedError";
import { providerSupportsCrossMachineHandoffFork } from "../../../shared/types/chat";
import { providerDisplayLabel as providerDisplayLabelShared } from "../../../shared/pendingInputLabels";
import {
  getModelById,
  modelSupportsFastMode,
  resolveProviderGroupForModel,
  type ModelDescriptor,
  type ProviderFamily,
} from "../../../shared/modelRegistry";
import {
  applyUnifiedPermissionToNativeControls,
  summarizeNativeControls,
} from "../../lib/nativeLaunchControls";
import type { NativeControlState } from "../../lib/draftLaunchJobs";
import { getPermissionOptions, type SafetyLevel } from "../shared/permissionOptions";
import {
  PERMISSION_TRIGGER_CLASS,
  PermissionModePicker,
  type PermissionModeIconKind,
  type PermissionModeTone,
} from "../shared/PermissionModePicker";
import { ModelPicker } from "../shared/ModelPicker/ModelPicker";
import { ReasoningEffortPicker } from "../shared/ModelPicker/ReasoningEffortPicker";
import {
  BlockedActionButton,
  BlockedReasons,
  type BlockedActionReason,
} from "../shared/BlockedAction";
import { ProviderLogo } from "../shared/ProviderLogos";
import { formatBytes } from "../../lib/format";
import { describeTravellingChanges } from "./CrossMachineHandoffBanner";
import {
  branchRowDetail,
  branchRowState,
  CheckRow,
  EMPTY_SOURCE_CHECK,
  forkFallbackReasonForPrepareError,
  isInsecureRoute,
  PERMISSION_MODE_ICONS,
  PERMISSION_SAFETY_TONES,
  providerDisplayLabel,
  repoNameFromRemote,
  repoReadinessClass,
  repoReadinessLabel,
  routeLabel,
  toPermissionPickerOption,
  type ForkHandoffSupport,
  type HandoffMode,
  type ModalStage,
  type SourceCheck,
} from "./crossMachineHandoffPresentation";
import { cn } from "../ui/cn";
import { Banner } from "../ui/notice/Banner";
import { Dialog } from "../ui/dialog";

/**
 * A machine can take a handoff when it is connected, serves projects, and is new
 * enough for the storage preflight. The source chat's own machine never can.
 */
function isEligibleHandoffConnection(
  connection: RemoteRuntimeConnectionStatus,
  sourceMachineTargetId: string | null,
): boolean {
  return connection.state === "connected"
    && connection.target.id !== sourceMachineTargetId
    && connection.capabilities?.projects === true
    && connection.capabilities.machineProjects.handoffStoragePreflight === true;
}

export function CrossMachineHandoffModal({
  open,
  sourceSessionId,
  sourceLaneId,
  runtimePin = null,
  sourceMachineTargetId = null,
  sourceMachineName = null,
  sourceProvider,
  target,
  modelId,
  onModelChange,
  availableModelIds,
  forkAvailableModelIds,
  reasoningEffort,
  onReasoningEffortChange,
  fastMode,
  onFastModeChange,
  nativeControls,
  onNativeControlsChange,
  onOpenSignIn,
  turnActive,
  awaitingInput,
  onStopTurn,
  onClose,
  onStarted,
  preselectedMachine = null,
}: {
  open: boolean;
  sourceSessionId: string;
  sourceLaneId: string;
  /**
   * The machine the SOURCE chat runs on, or null when it runs on the machine
   * this tab is bound to. Every source-side call (lane/git inspection, capsule
   * preparation, validation, the source marker) is pinned to it; destination
   * dispatch already routes by target id and is unaffected.
   */
  runtimePin?: OpenProjectBinding | null;
  /**
   * The remote target the source chat runs on, when this window reaches it as a
   * remote machine. That machine cannot be its own destination, so it is left
   * out of the machine list.
   */
  sourceMachineTargetId?: string | null;
  /** Display name of that source machine, for the empty machine list. */
  sourceMachineName?: string | null;
  /** Source chat provider; drives whether forking history is offered. */
  sourceProvider?: AgentChatProvider | null;
  target: AgentChatCrossMachineTargetConfig;
  /** Destination model for the new chat; the modal owns this choice now. */
  modelId?: string;
  onModelChange?: (modelId: string) => void;
  availableModelIds?: string[];
  /** Same-provider models offered when forking (fork must stay on one provider). */
  forkAvailableModelIds?: string[];
  /**
   * Destination reasoning/permission settings. The capsule has always carried
   * these and the destination has always honored them — until now there was
   * simply no UI to set them, so every handoff silently shipped whatever the
   * local handoff drawer happened to hold.
   */
  reasoningEffort?: string | null;
  onReasoningEffortChange?: (effort: string | null) => void;
  fastMode?: boolean;
  onFastModeChange?: (next: boolean) => void;
  nativeControls?: NativeControlState;
  onNativeControlsChange?: (next: NativeControlState) => void;
  onOpenSignIn?: (family?: ProviderFamily) => void;
  turnActive: boolean;
  awaitingInput: boolean;
  onStopTurn: () => Promise<void>;
  onClose: () => void;
  /**
   * The brain accepted the move. Progress from here lives in the banner above
   * the composer, so the modal closes.
   */
  onStarted: (record: AgentChatCrossMachineHandoffRecord) => void;
  /** Machine to select on open (name or target id), e.g. from the session menu. */
  preselectedMachine?: string | null;
}) {
  const [stage, setStage] = useState<ModalStage>("choose");
  const [loading, setLoading] = useState(false);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [sourceCheck, setSourceCheck] = useState<SourceCheck>(EMPTY_SOURCE_CHECK);
  const [connections, setConnections] = useState<RemoteRuntimeConnectionStatus[]>([]);
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [continuationPrompt, setContinuationPrompt] = useState("");
  const [prepared, setPrepared] = useState<AgentChatPrepareCrossMachineHandoffResult | null>(null);
  const [destinationProject, setDestinationProject] = useState<RemoteRuntimeProjectRecord | null>(null);
  const [destinationPreflight, setDestinationPreflight] = useState<AgentChatCrossMachineDestinationPreflightResult | null>(null);
  const [storagePreflight, setStoragePreflight] = useState<RemoteRuntimeHandoffStoragePreflightResult | null>(null);
  const [cloneApproved, setCloneApproved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * "Bring them along": uncommitted and unpushed work travels as a git bundle
   * instead of blocking the move. Ignored files (.env) stay here.
   */
  const [includeChanges, setIncludeChanges] = useState(false);
  /** A busy chat moves once its current turn ends instead of being stopped. */
  const [whenTurnEnds, setWhenTurnEnds] = useState(false);
  /** Clone consent for a queued move, which skips the clone step's own screen. */
  const [queuedCloneApproved, setQueuedCloneApproved] = useState(false);
  /** The brain's view of this chat: what `includeChanges` would carry. */
  const [brainOptions, setBrainOptions] = useState<AgentChatCrossMachineHandoffOptionsResult | null>(null);
  /**
   * Per-machine repository readiness, resolved while the picker is on screen so
   * the choice is informed instead of a guess you find out about two steps
   * later. Deliberately narrow: it answers "is this repo already there", not
   * "is everything ready" — provider auth and branch state are still the review
   * step's job, and claiming more here would be a lie the user can't check.
   */
  const [machineRepoReadiness, setMachineRepoReadiness] = useState<
    Record<string, "checking" | "present" | "absent" | "unknown">
  >({});
  /**
   * Projects seen while resolving readiness, reused by `prepareDestination` so
   * the hint costs nothing: the picker already had to ask each machine what it
   * has, and prepare would otherwise ask the same question again a moment later.
   */
  const machineProjectsRef = useRef<Record<string, RemoteRuntimeProjectRecord[]>>({});
  /**
   * The source machine's binding, held in a ref so each operation can freeze it
   * once and keep every one of its awaits on the same machine. Reading it fresh
   * after an await could cross a lane-index change and split one handoff across
   * two runtimes.
   */
  const runtimePinRef = useRef<OpenProjectBinding | null>(runtimePin);
  runtimePinRef.current = runtimePin;
  /**
   * `inspectSource` builds the blocker list, and the "behind" blocker needs to
   * offer the pull that clears it — but `updateBranch` is defined below and
   * itself calls `inspectSource`. The ref breaks that cycle without making
   * either callback depend on the other's identity.
   */
  const updateBranchRef = useRef<(() => Promise<void>) | null>(null);
  // Cross-machine fork is narrower than local fork: Droid's session index is
  // machine-local, so it can fork here but never onto another machine.
  const sourceProviderSupportsFork = providerSupportsCrossMachineHandoffFork(sourceProvider);
  const [mode, setMode] = useState<HandoffMode>(sourceProviderSupportsFork ? "fork" : "brief");
  // Destination fork capability, learned only after preflight. `null` = not yet
  // checked; absent field on the response resolves to { supported: false }.
  const [forkHandoffSupport, setForkHandoffSupport] = useState<ForkHandoffSupport | null>(null);
  // Plain reason the current fork attempt fell back to brief (oversize history or
  // an older/unsupported destination); drives the one-click "send as brief" offer.
  const [forkFallbackReason, setForkFallbackReason] = useState<string | null>(null);
  const providerLabel = providerDisplayLabel(sourceProvider);
  const forkModelIds = forkAvailableModelIds ?? availableModelIds;
  const modelIdsForMode = mode === "fork" ? forkModelIds : availableModelIds;
  const forkModelFilter = useCallback((descriptor: ModelDescriptor) => (
    Boolean(sourceProvider && resolveProviderGroupForModel(descriptor) === sourceProvider)
  ), [sourceProvider]);

  /**
   * Everything about the *destination* chat's controls is derived from the model
   * chosen here, never from the local handoff drawer's model. Getting that wrong
   * is how the modal previously shipped permission values computed against a
   * different provider than the one that would actually run them.
   */
  const destinationDescriptor = useMemo(
    () => (modelId ? getModelById(modelId) ?? null : null),
    [modelId],
  );
  const destinationFastModeSupported = Boolean(
    destinationDescriptor && modelSupportsFastMode(destinationDescriptor),
  );
  const destinationPermissionPicker = useMemo(() => {
    if (!modelId || !nativeControls || !onNativeControlsChange || !destinationDescriptor) return null;
    const providerGroup = resolveProviderGroupForModel(destinationDescriptor);
    if (!providerGroup) return null;
    // Two different vocabularies, and they are not interchangeable:
    // `getPermissionOptions` branches on ProviderFamily ("anthropic", "openai",
    // "factory") while `summarizeNativeControls` keys off the provider group
    // ("claude", "codex", "droid"). Passing the group as the family silently
    // falls through to the generic option list, which then cannot represent the
    // mode the capsule is actually carrying — so the pill shows one thing and
    // the destination runs another.
    const options = getPermissionOptions({
      family: destinationDescriptor.family,
      isCliWrapped: destinationDescriptor.isCliWrapped,
    });
    if (options.length === 0) return null;
    const summarized = summarizeNativeControls(providerGroup, nativeControls).permissionMode;
    const representable = options.some((option) => option.value === summarized);
    // A native combination the presets cannot express (e.g. Codex approval
    // "never" with sandbox "workspace-write") must not borrow the first option's
    // label. The raw controls are what actually travel in the capsule, so
    // showing "Default" there would claim the destination asks for approval when
    // it does not. Surface it as Custom instead, and leave it unselectable —
    // picking a real preset is what overwrites the underlying controls.
    const customValue = "__custom__";
    const pickerOptions = representable
      ? options.map(toPermissionPickerOption)
      : [
        ...options.map(toPermissionPickerOption),
        {
          value: customValue,
          label: "Custom",
          detail: "This chat's provider settings don't match a preset. They travel as-is.",
          tone: "slate" as PermissionModeTone,
          icon: "config" as PermissionModeIconKind,
        },
      ];
    const current = representable ? summarized! : customValue;
    return (
      <PermissionModePicker
        ariaLabel="Permission mode for the new chat"
        selectedValue={current}
        options={pickerOptions}
        onSelect={(value) => {
          if (value === customValue) return;
          onNativeControlsChange(
            applyUnifiedPermissionToNativeControls(modelId, value as AgentChatPermissionMode, nativeControls),
          );
        }}
      />
    );
  }, [destinationDescriptor, modelId, nativeControls, onNativeControlsChange]);

  const selectedConnection = useMemo(
    () => connections.find((connection) => connection.target.id === selectedTargetId) ?? null,
    [connections, selectedTargetId],
  );
  const eligibleConnections = useMemo(
    () => connections.filter((connection) => isEligibleHandoffConnection(connection, sourceMachineTargetId)),
    [connections, sourceMachineTargetId],
  );
  /**
   * A stable identity for "which machines are eligible". `eligibleConnections`
   * is a fresh array on every connection snapshot, and `listProjects` itself
   * triggers a snapshot broadcast — depending on the array meant the readiness
   * effect re-fired forever, hammering every paired machine with RPCs.
   */
  const eligibleTargetIds = useMemo(
    () => eligibleConnections.map((connection) => connection.target.id).join("\u0000"),
    [eligibleConnections],
  );
  const incompatibleConnectedCount = connections.filter((connection) =>
    connection.state === "connected"
    && connection.target.id !== sourceMachineTargetId
    && connection.capabilities?.machineProjects.handoffStoragePreflight !== true,
  ).length;

  const inspectSource = useCallback(async (
    pinOverride?: OpenProjectBinding | null,
  ): Promise<SourceCheck> => {
    const pin = pinOverride !== undefined ? pinOverride : runtimePinRef.current;
    const [lanes, sync, origin] = await Promise.all([
      window.ade.lanes.list({ includeArchived: false, includeStatus: true }, pin),
      window.ade.git.getSyncStatus({ laneId: sourceLaneId }, pin),
      window.ade.git.getOriginRemote({ laneId: sourceLaneId }, pin),
    ]);
    const lane = lanes.find((candidate) => candidate.id === sourceLaneId) ?? null;
    const blockingErrors: BlockedActionReason[] = [];
    const warnings: string[] = [];
    if (!lane) {
      blockingErrors.push({
        id: "lane-missing",
        title: "ADE could not find this chat's lane",
        detail: "Reopen the project, then try again.",
      });
    }
    if (lane?.status.dirty) {
      blockingErrors.push({
        id: "dirty",
        title: "You have uncommitted changes",
        detail: "The other machine picks the work up from Git. Commit it, or bring it along with this move.",
      });
    }
    if (lane?.status.rebaseInProgress) {
      blockingErrors.push({
        id: "rebase",
        title: "A rebase is in progress",
        detail: "Finish or abort it before handing this chat off.",
      });
    }
    // Behind/diverged is the blocker that used to be invisible: nothing rendered
    // it, and the "Remote branch" row reported a cheerful "<branch> is pushed"
    // because it only ever looked at the push direction.
    if (sync.diverged) {
      blockingErrors.push({
        id: "diverged",
        title: `${origin.branch ?? "This branch"} has diverged from origin`,
        detail: `Local and origin both have commits the other doesn't (${sync.ahead} here, ${sync.behind} there). Reconcile them before handing off — ADE won't pick a strategy for you.`,
      });
    } else if (sync.behind > 0) {
      blockingErrors.push({
        id: "behind",
        title: `${origin.branch ?? "This branch"} is ${sync.behind} ${sync.behind === 1 ? "commit" : "commits"} behind origin`,
        detail: "The other machine would start from older code than origin has.",
        fix: { label: "Update branch", onFix: () => void updateBranchRef.current?.() },
      });
    }
    if (!origin.remoteUrl) {
      blockingErrors.push({
        id: "no-origin",
        title: "This repository has no origin remote",
        detail: "The other machine fetches your branch from origin, so one is required.",
      });
    }
    if (!origin.branch) {
      blockingErrors.push({
        id: "no-branch",
        title: "This lane isn't on a named branch",
        detail: "Detached HEAD can't be handed off. Check out a branch first.",
      });
    }
    const needsPush = !sync.hasUpstream || sync.ahead > 0 || sync.recommendedAction === "push";
    if (needsPush) warnings.push("Publish the branch before ADE can prepare the destination.");
    const next = { lane, sync, originUrl: origin.remoteUrl, branch: origin.branch, needsPush, blockingErrors, warnings };
    setSourceCheck(next);
    return next;
  }, [sourceLaneId]);

  const loadInitial = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [, snapshot, options] = await Promise.all([
        inspectSource(),
        window.ade.remoteRuntime.getConnectionSnapshot(),
        // Counts for "Bring them along". Optional: an older brain without the
        // action still gets the full setup, just without the counts.
        window.ade.agentChat
          .getCrossMachineHandoffOptions({ sourceSessionId }, runtimePinRef.current)
          .catch(() => null),
      ]);
      setConnections(snapshot.connections);
      setBrainOptions(options);
      const eligible = snapshot.connections.filter((connection) =>
        isEligibleHandoffConnection(connection, sourceMachineTargetId),
      );
      const wanted = preselectedMachine?.trim().toLowerCase() ?? "";
      const preselected = wanted
        ? eligible.find((item) => item.target.id.toLowerCase() === wanted || item.target.name.trim().toLowerCase() === wanted)
        : undefined;
      setSelectedTargetId((current) => preselected?.target.id
        ?? (current && eligible.some((item) => item.target.id === current)
          ? current
          : eligible[0]?.target.id ?? null));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [inspectSource, preselectedMachine, sourceMachineTargetId, sourceSessionId]);

  useEffect(() => {
    if (!open) return;
    setStage("choose");
    setBusyLabel(null);
    setSourceCheck(EMPTY_SOURCE_CHECK);
    setContinuationPrompt("");
    setPrepared(null);
    setDestinationProject(null);
    setDestinationPreflight(null);
    setStoragePreflight(null);
    setCloneApproved(false);
    setIncludeChanges(false);
    setWhenTurnEnds(false);
    setQueuedCloneApproved(false);
    setBrainOptions(null);
    machineProjectsRef.current = {};
    setMachineRepoReadiness({});
    setMode(sourceProviderSupportsFork ? "fork" : "brief");
    setForkHandoffSupport(null);
    setForkFallbackReason(null);
    void loadInitial();
  }, [loadInitial, open, sourceProvider, sourceProviderSupportsFork]);

  useEffect(() => {
    if (!open) return;
    return window.ade.remoteRuntime.onConnectionSnapshotChanged((snapshot) => {
      setConnections(snapshot.connections);
    });
  }, [open]);

  // Resolve repository presence for every eligible machine once the source
  // origin is known. Failures resolve to "unknown" rather than a scary state —
  // a machine we couldn't ask about is not a machine that's broken.
  useEffect(() => {
    if (stage !== "choose") return;
    const sourceOrigin = sourceCheck.originUrl ? normalizeGitRemoteIdentity(sourceCheck.originUrl) : null;
    if (!sourceOrigin) return;
    const targets = eligibleTargetIds ? eligibleTargetIds.split("\u0000") : [];
    if (targets.length === 0) return;
    let cancelled = false;
    setMachineRepoReadiness((current) => {
      const next = { ...current };
      for (const id of targets) next[id] ??= "checking";
      return next;
    });
    void Promise.all(targets.map(async (targetId) => {
      let state: "present" | "absent" | "unknown" = "unknown";
      let projects: RemoteRuntimeProjectRecord[] | null = null;
      try {
        projects = await window.ade.remoteRuntime.listProjects(targetId);
        state = projects.some((project) => normalizeGitRemoteIdentity(project.gitOriginUrl) === sourceOrigin)
          ? "present"
          : "absent";
      } catch {
        state = "unknown";
      }
      // The cache write is inside the guard too: a superseded response landing
      // after a newer one would otherwise leave a stale list that
      // `prepareDestination` consumes, walking the user into a clone prompt for
      // a repository the destination already has.
      if (cancelled) return;
      if (projects) machineProjectsRef.current[targetId] = projects;
      setMachineRepoReadiness((current) => ({ ...current, [targetId]: state }));
    }));
    return () => { cancelled = true; };
  }, [eligibleTargetIds, sourceCheck.originUrl, stage]);

  const runDestinationPreflight = useCallback(async (
    connection: RemoteRuntimeConnectionStatus,
    project: RemoteRuntimeProjectRecord,
    handoff: AgentChatPrepareCrossMachineHandoffResult,
    requestedMode: HandoffMode,
  ) => {
    const response = await window.ade.remoteRuntime.callAction(connection.target.id, project.projectId, {
      domain: "chat",
      action: "preflightCrossMachineDestination",
      args: {
        targetModelId: handoff.capsule.target.targetModelId,
        sourceBranchRef: handoff.capsule.source.branchRef,
        sourceHeadSha: handoff.capsule.source.headSha,
        mode: requestedMode,
        ...(sourceProvider ? { sourceProvider } : {}),
        ...(handoff.capsule.gitBundle ? { hasGitBundle: true } : {}),
      },
    });
    const next = decodeCrossMachineDestinationPreflightResult(response.result);
    // Absent field = older destination that predates fork handoff.
    const forkSupport = requestedMode === "fork"
      ? (next.forkHandoffSupport
        ?? { supported: false, reason: "That machine needs an ADE update for fork handoff." })
      : null;
    setDestinationPreflight(next);
    setForkHandoffSupport(forkSupport);
    if (requestedMode === "fork" && forkSupport && !forkSupport.supported) {
      setForkFallbackReason(forkSupport.reason ?? "That machine needs an ADE update for fork handoff.");
    }
    setDestinationProject(project);
    setStage("review");
    return next;
  }, [sourceProvider]);

  const prepareDestination = useCallback(async (requestedMode: HandoffMode = mode) => {
    const sourceBlocks = sourceCheck.blockingErrors.filter((reason) => !(includeChanges && reason.id === "dirty"));
    if (!selectedConnection || sourceBlocks.length || (sourceCheck.needsPush && !includeChanges)) return;
    if (turnActive || awaitingInput) {
      setError(turnActive
        ? "Stop the current response, or choose to move when this turn ends."
        : "Resolve the current approval or question before preparing the handoff.");
      return;
    }
    setBusyLabel(requestedMode === "fork" ? "Packaging this chat's history…" : "Preparing the handoff…");
    setError(null);
    setForkFallbackReason(null);
    try {
      const handoff = await window.ade.agentChat.prepareCrossMachineHandoff({
        sourceSessionId,
        handoffId: crypto.randomUUID(),
        continuationPrompt,
        mode: requestedMode,
        ...(includeChanges ? { includeChanges: true } : {}),
        ...target,
      }, runtimePinRef.current);
      setPrepared(handoff);
      // Prefer what the readiness pass already fetched; only ask again when the
      // picker never got an answer for this machine.
      const projects = machineProjectsRef.current[selectedConnection.target.id]
        ?? await window.ade.remoteRuntime.listProjects(selectedConnection.target.id);
      const sourceOrigin = normalizeGitRemoteIdentity(handoff.capsule.source.originUrl);
      const matchingProject = projects.find((project) => normalizeGitRemoteIdentity(project.gitOriginUrl) === sourceOrigin) ?? null;
      if (matchingProject) {
        await runDestinationPreflight(selectedConnection, matchingProject, handoff, requestedMode);
        return;
      }
      if (!sourceOrigin?.startsWith("github.com/")) {
        throw new Error("The repository is not registered on the destination. Automatic clone currently supports GitHub repositories; add this repository to ADE on that machine, then retry.");
      }
      const parentDir = await window.ade.remoteRuntime.getDefaultParentDir(selectedConnection.target.id);
      const storage = await window.ade.remoteRuntime.getHandoffStoragePreflight(selectedConnection.target.id, {
        parentDir,
        repoName: repoNameFromRemote(handoff.capsule.source.originUrl),
        originUrl: handoff.capsule.source.originUrl,
        branchRef: handoff.capsule.source.branchRef,
        sourceHeadSha: handoff.capsule.source.headSha,
        // The commits travel in the bundle, so origin need not have them.
        ...(handoff.capsule.gitBundle ? { hasGitBundle: true } : {}),
      });
      setStoragePreflight(storage);
      setStage("clone");
    } catch (prepareError) {
      const message = prepareError instanceof Error ? prepareError.message : String(prepareError);
      // A fork that can't be packaged (oversize, or an unforkable provider file)
      // still works as a brief — offer the one-click swap instead of a dead end.
      const fallbackReason = requestedMode === "fork" ? forkFallbackReasonForPrepareError(message) : null;
      if (fallbackReason) {
        setForkFallbackReason(fallbackReason);
        setError(null);
      } else {
        setError(message);
      }
    } finally {
      setBusyLabel(null);
    }
  }, [
    awaitingInput,
    continuationPrompt,
    includeChanges,
    mode,
    runDestinationPreflight,
    selectedConnection,
    sourceCheck.blockingErrors,
    sourceCheck.needsPush,
    sourceSessionId,
    target,
    turnActive,
  ]);

  const switchMode = useCallback((next: HandoffMode) => {
    setMode(next);
    setPrepared(null);
    setDestinationProject(null);
    setDestinationPreflight(null);
    setForkHandoffSupport(null);
    setForkFallbackReason(null);
    setStoragePreflight(null);
    setCloneApproved(false);
    setError(null);
    if (next === "fork" && modelId && forkModelIds && forkModelIds.length > 0 && !forkModelIds.includes(modelId)) {
      onModelChange?.(forkModelIds[0]!);
    }
  }, [forkModelIds, modelId, onModelChange]);

  // One-click recovery: drop to a brief and re-run prepare + preflight. Used both
  // when the source history is too big and when the destination can't fork.
  const sendAsBrief = useCallback(() => {
    setStage("choose");
    setMode("brief");
    setForkHandoffSupport(null);
    setForkFallbackReason(null);
    setPrepared(null);
    setDestinationProject(null);
    setDestinationPreflight(null);
    setStoragePreflight(null);
    setCloneApproved(false);
    void prepareDestination("brief");
  }, [prepareDestination]);

  const publishBranch = useCallback(async () => {
    setBusyLabel("Publishing source branch…");
    setError(null);
    try {
      const pin = runtimePinRef.current;
      await window.ade.git.push({ laneId: sourceLaneId }, pin);
      await inspectSource(pin);
    } catch (pushError) {
      setError(pushError instanceof Error ? pushError.message : String(pushError));
    } finally {
      setBusyLabel(null);
    }
  }, [inspectSource, sourceLaneId]);

  /**
   * Clears the "behind origin" blocker in place. Only offered when the branch is
   * strictly behind — a diverged branch keeps the hard block, because picking
   * merge-vs-rebase for the user is exactly the kind of decision this flow
   * should not be making on their behalf.
   */
  const updateBranch = useCallback(async () => {
    setBusyLabel("Updating source branch…");
    setError(null);
    try {
      const pin = runtimePinRef.current;
      await window.ade.git.pull({ laneId: sourceLaneId }, pin);
      await inspectSource(pin);
    } catch (pullError) {
      setError(pullError instanceof Error ? pullError.message : String(pullError));
    } finally {
      setBusyLabel(null);
    }
  }, [inspectSource, sourceLaneId]);

  useEffect(() => {
    updateBranchRef.current = updateBranch;
  }, [updateBranch]);

  const cloneDestination = useCallback(async () => {
    if (!selectedConnection || !prepared || !storagePreflight || !cloneApproved) return;
    setBusyLabel("Cloning repository on destination…");
    setError(null);
    try {
      if (storagePreflight.blockingErrors.length) {
        throw new Error(storagePreflight.blockingErrors.join(" "));
      }
      const project = await window.ade.remoteRuntime.cloneProject(selectedConnection.target.id, {
        url: prepared.capsule.source.originUrl,
        parentDir: storagePreflight.parentDir,
        name: repoNameFromRemote(prepared.capsule.source.originUrl),
      }, { credentialMode: "destination_only" });
      await runDestinationPreflight(selectedConnection, project, prepared, mode);
    } catch (cloneError) {
      const expectedOrigin = normalizeGitRemoteIdentity(prepared.capsule.source.originUrl);
      try {
        const projects = await window.ade.remoteRuntime.listProjects(selectedConnection.target.id);
        const recovered = projects.find((project) =>
          normalizeGitRemoteIdentity(project.gitOriginUrl) === expectedOrigin,
        ) ?? null;
        if (recovered) {
          await runDestinationPreflight(selectedConnection, recovered, prepared, mode);
          return;
        }
      } catch {
        // Preserve the original clone failure; it explains whether the remote
        // result was uncertain or the target path was already occupied.
      }
      setError(cloneError instanceof Error ? cloneError.message : String(cloneError));
    } finally {
      setBusyLabel(null);
    }
  }, [cloneApproved, mode, prepared, runDestinationPreflight, selectedConnection, storagePreflight]);

  /**
   * Asks the destination to catch its own lane up. The destination re-validates
   * everything and only ever does a `--ff-only` merge, so a stale preflight here
   * can be refused there rather than silently rewriting someone's branch.
   */
  const fastForwardDestinationLane = useCallback(async () => {
    const target = destinationPreflight?.laneFastForward;
    if (!target || !selectedConnection || !destinationProject || !prepared) return;
    setBusyLabel("Fast-forwarding the lane on the other machine…");
    setError(null);
    try {
      await window.ade.remoteRuntime.callAction(selectedConnection.target.id, destinationProject.projectId, {
        domain: "chat",
        action: "fastForwardCrossMachineHandoffLane",
        args: { laneId: target.laneId, expectedHead: prepared.capsule.source.headSha },
      });
      await runDestinationPreflight(selectedConnection, destinationProject, prepared, mode);
    } catch (ffError) {
      setError(ffError instanceof Error ? ffError.message : String(ffError));
    } finally {
      setBusyLabel(null);
    }
  }, [destinationPreflight, destinationProject, mode, prepared, runDestinationPreflight, selectedConnection]);

  /**
   * The brain runs the move from here (prepare, destination checks, accept,
   * mark) and persists each step, so the modal's job ends when it accepts.
   * Progress, failure and "lost confirmation" all live in the banner above
   * the composer, where they survive this modal closing.
   */
  const startMove = useCallback(async () => {
    if (!selectedConnection) return;
    setBusyLabel(turnActive ? "Queuing the move…" : "Starting the move…");
    setError(null);
    try {
      // The brain knows machines by its own key; match by name, then id.
      const name = selectedConnection.target.name.trim().toLowerCase();
      const brainMachine = brainOptions?.machines.find((machine) =>
        machine.machineKey === selectedConnection.target.id || machine.name.trim().toLowerCase() === name,
      );
      const record = await window.ade.agentChat.startCrossMachineHandoff({
        ...target,
        sourceSessionId,
        machine: brainMachine?.machineKey ?? selectedConnection.target.name,
        mode,
        continuationPrompt: continuationPrompt.trim() || null,
        ...(includeChanges ? { includeChanges: true } : {}),
        ...(cloneApproved || queuedCloneApproved ? { clone: true } : {}),
        ...(turnActive ? { whenTurnEnds: true } : {}),
      }, runtimePinRef.current);
      onStarted(record);
      onClose();
    } catch (startError) {
      setError(stripElectronErrorWrapper(startError instanceof Error ? startError.message : String(startError)));
    } finally {
      setBusyLabel(null);
    }
  }, [
    brainOptions,
    cloneApproved,
    continuationPrompt,
    includeChanges,
    mode,
    onClose,
    onStarted,
    queuedCloneApproved,
    selectedConnection,
    sourceSessionId,
    target,
    turnActive,
  ]);

  if (!open) return null;

  const busyNow = Boolean(busyLabel);
  const changes = brainOptions?.changes ?? null;
  const changesLabel = changes ? describeTravellingChanges(changes.unpushedCommits, changes.changedFiles) : null;
  const bringAlong = {
    label: changesLabel ? `Bring them along (${changesLabel})` : "Bring them along",
    onFix: () => setIncludeChanges(true),
    busy: busyNow,
  };
  // With "Bring them along", uncommitted work travels instead of blocking.
  const effectiveSourceBlocks = sourceCheck.blockingErrors.filter((reason) => !(includeChanges && reason.id === "dirty"));
  const hasSourceBlock = effectiveSourceBlocks.length > 0;
  // Fix buttons share the modal's single busy slot, so they grey out together
  // with everything else while an operation is running.
  const sourceBlockReasons: BlockedActionReason[] = effectiveSourceBlocks.map((reason) => {
    const withBusy = reason.fix ? { ...reason, fix: { ...reason.fix, busy: busyNow } } : reason;
    return reason.id === "dirty" ? { ...withBusy, moreFixes: [bringAlong] } : withBusy;
  });
  const selectedRepoReadiness = selectedConnection ? machineRepoReadiness[selectedConnection.target.id] : undefined;
  // A queued move never sees the clone screen, so it asks for consent here.
  const queuedMoveNeedsClone = turnActive && whenTurnEnds && selectedRepoReadiness === "absent";
  /**
   * Everything standing between the user and "Continue". Assembled in one place
   * so the button cannot be disabled for a reason the user was never shown —
   * the blockers below the checks and the button's own tooltip read from this
   * same list.
   */
  const continueBlockers: BlockedActionReason[] = [
    ...sourceBlockReasons,
    // Only when a plain push can actually resolve it. A diverged branch also
    // reports needsPush (ahead > 0), but its upstream already exists and the
    // push would be rejected as non-fast-forward — offering Publish there sits
    // next to the divergence blocker suggesting a fix that cannot work.
    ...(sourceCheck.needsPush && !hasSourceBlock && !includeChanges
      ? [{
        id: "needs-push",
        title: `${sourceCheck.branch ?? "This branch"} hasn't been published`,
        detail: "The other machine fetches your work from origin, so publish it or bring the commits along.",
        fix: { label: "Publish branch", onFix: () => void publishBranch(), busy: busyNow },
        moreFixes: [bringAlong],
      }]
      : []),
    ...(!selectedConnection
      ? [{
        id: "no-machine",
        title: "No machine selected",
        detail: eligibleConnections.length === 0
          ? "No other ADE machine is connected right now."
          : "Pick which computer should continue this chat.",
      }]
      : []),
    // A busy chat is not a dead end: it can move once the turn ends.
    ...(turnActive && !whenTurnEnds
      ? [{
        id: "turn-active",
        title: "This chat is still responding",
        detail: "Move it when this turn ends, or stop the current response.",
        fix: { label: "Move when this turn ends", onFix: () => setWhenTurnEnds(true), busy: busyNow },
        moreFixes: [{ label: "Stop current response", onFix: () => void onStopTurn(), busy: busyNow }],
      }]
      : []),
    ...(queuedMoveNeedsClone && !queuedCloneApproved
      ? [{
        id: "queued-clone",
        title: `This repository isn't on ${selectedConnection?.target.name ?? "that machine"} yet`,
        detail: "ADE clones it there when the move starts. Nothing uncommitted or secret leaves this machine unless you bring it along.",
        fix: { label: "Clone it there", onFix: () => setQueuedCloneApproved(true), busy: busyNow },
      }]
      : []),
    ...(awaitingInput
      ? [{
        id: "awaiting-input",
        title: "This chat is waiting on you",
        detail: "Resolve the pending approval or question in the chat first.",
      }]
      : []),
  ];
  // A fork prepared against a destination that can't fork must not send as-is;
  // the user switches to a brief (one click) or backs out.
  const forkUnsupportedAtReview = mode === "fork" && forkHandoffSupport != null && !forkHandoffSupport.supported;
  const reviewBundle = prepared?.capsule.gitBundle ?? null;
  // An older destination would silently drop the bundle; the brain refuses it
  // too, but the review should say so before Send.
  const bundleUnsupportedAtReview = Boolean(reviewBundle) && destinationPreflight != null
    && destinationPreflight.gitBundleSupport !== true;
  // A pending fast-forward must gate Send. Preflight reports it as a warning so
  // the offer can render, but `acceptCrossMachineHandoff` still requires the
  // destination lane to be at the exact source commit — without this the user
  // could send and hit a hard failure after acceptance had already started.
  const reviewBlocked = Boolean(destinationPreflight?.blockingErrors.length)
    || Boolean(destinationPreflight?.laneFastForward)
    || forkUnsupportedAtReview
    || bundleUnsupportedAtReview;
  const reviewIsFork = prepared?.capsule.mode === "fork";
  const insecureRouteNotice = reviewIsFork
    ? "This connection is authenticated but not end-to-end encrypted. The full chat history is sent exactly as recorded."
    : "This connection is authenticated but not end-to-end encrypted. Only the summary is sent — never secrets.";
  const queueOnly = turnActive && whenTurnEnds;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Continue on another computer"
      hideHeader
      width={760}
      maxHeight="min(780px, calc(100vh - 32px))"
      bodyPadding={false}
      scrollBody={false}
      bodyStyle={{ display: "flex", flexDirection: "column" }}
      // Nothing inside takes focus on open; the panel holds it.
      preventAutoFocus
      // Closing mid-start would hide the answer; the move itself is the brain's.
      dismissible={!busyLabel}
      onEscapeKeyDown={(event) => {
        // An open permission list takes Escape first and closes itself only.
        // (Dialog stops the key either way, so it never reaches the chat.)
        if (document.querySelector("[data-permission-mode-picker-dropdown]")) event.preventDefault();
      }}
      footerStart={
        <div className="min-w-0 text-[10px] text-fg/38">
          {busyLabel ? (
            <span className="inline-flex items-center gap-1.5"><CircleNotch size={12} className="animate-spin" />{busyLabel}</span>
          ) : stage === "choose"
            ? (queueOnly ? "Nothing moves until this turn ends. A new message from you keeps it here." : "Nothing is sent until you confirm.")
            : "This chat stays here too. Progress shows above its composer."}
        </div>
      }
      footer={
        <div className="flex shrink-0 items-center gap-2">
          {stage === "clone" || stage === "review" ? (
            <button
              type="button"
              disabled={Boolean(busyLabel)}
              onClick={() => {
                setStage("choose");
                setPrepared(null);
                setDestinationProject(null);
                setDestinationPreflight(null);
                setStoragePreflight(null);
                setCloneApproved(false);
                setError(null);
              }}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-fg/[0.08] bg-fg/[0.03] px-2.5 text-[10px] font-semibold text-fg/58 hover:text-fg/80 disabled:opacity-40"
            >
              <ArrowLeft size={12} /> Back
            </button>
          ) : null}
          {stage === "choose" ? (
            <BlockedActionButton
              reasons={loading ? [] : continueBlockers}
              busy={loading || Boolean(busyLabel)}
              // A busy chat can't be packed yet, so a queued move skips review:
              // the brain re-runs every check when the turn ends.
              onClick={() => void (queueOnly ? startMove() : prepareDestination())}
            >
              {queueOnly ? <>Move when this turn ends <ArrowRight size={12} /></> : <>Continue <ArrowRight size={12} /></>}
            </BlockedActionButton>
          ) : null}
          {stage === "clone" ? (
            <button
              type="button"
              disabled={Boolean(busyLabel) || !cloneApproved || Boolean(storagePreflight?.blockingErrors.length)}
              onClick={() => void cloneDestination()}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-sky-300/24 bg-sky-400/12 px-3 text-[10px] font-semibold text-sky-100 hover:bg-sky-400/17 disabled:cursor-not-allowed disabled:opacity-35"
            >
              Clone repository <ArrowRight size={12} />
            </button>
          ) : null}
          {stage === "review" ? (
            <button
              type="button"
              disabled={Boolean(busyLabel) || reviewBlocked}
              onClick={() => void startMove()}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-emerald-300/24 bg-emerald-400/12 px-3 text-[10px] font-semibold text-emerald-100 hover:bg-emerald-400/17 disabled:cursor-not-allowed disabled:opacity-35"
            >
              {turnActive ? "Send when this turn ends" : "Send chat"} <ArrowRight size={12} />
            </button>
          ) : null}
        </div>
      }
    >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-fg/[0.065] px-5 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-sky-300/20 bg-sky-400/10 text-sky-200">
              <CloudArrowUp size={19} weight="duotone" />
            </div>
            <div className="min-w-0">
              <h2 aria-hidden="true" className="font-sans text-[14px] font-semibold text-fg/92">
                Continue on another computer
              </h2>
              <p className="mt-1 text-[11px] leading-4 text-fg/48">
                Continue this chat on one of your other computers. ADE copies your branch over and starts a new chat where this one left off.
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close handoff setup"
            onClick={onClose}
            disabled={Boolean(busyLabel)}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-fg/42 transition-colors hover:bg-fg/[0.06] hover:text-fg/80 disabled:opacity-30"
          >
            <X size={15} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {stage === "choose" ? (
            <div className="space-y-5">
              <div>
                <div className="inline-flex w-full rounded-lg border border-fg/[0.07] bg-fg/[0.02] p-0.5">
                  {([
                    { value: "fork" as const, label: "Fork", disabled: !sourceProviderSupportsFork },
                    { value: "brief" as const, label: "Brief", disabled: false },
                  ]).map(({ value, label, disabled }) => {
                    const active = mode === value;
                    return (
                      <button
                        key={value}
                        type="button"
                        disabled={disabled}
                        aria-pressed={active}
                        onClick={() => switchMode(value)}
                        className={cn(
                          "flex-1 rounded-md px-3 py-1.5 font-sans text-[11px] font-semibold transition-colors",
                          active ? "bg-sky-400/[0.14] text-sky-50 shadow-[inset_0_0_0_1px_rgba(125,211,252,0.28)]" : "text-fg/52 hover:text-fg/78",
                          disabled && "cursor-not-allowed opacity-40 hover:text-fg/52",
                        )}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                <div className="mt-1.5 text-[10px] leading-4 text-fg/46">
                  {!sourceProviderSupportsFork
                    ? `${providerLabel} can't fork chat history — send a brief instead.`
                    : mode === "fork"
                      ? "Sends the full history so the new chat picks up exactly where this one left off."
                      : "Sends a short summary; the new chat starts fresh from it."}
                </div>
              </div>
              <div className="grid gap-5 md:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
              <div className="space-y-3">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-fg/38">Get this machine ready</div>
                  <div className="mt-1 text-[11px] leading-4 text-fg/48">Commit and push your work, or bring it along with the move.</div>
                </div>
                {loading ? <CheckRow label="Inspecting source lane" detail="Checking Git state and publication" state="pending" /> : (
                  <>
                    <CheckRow
                      label="Working tree"
                      detail={sourceCheck.lane?.status.dirty
                        ? (includeChanges ? "Your uncommitted changes travel with this move" : "Commit them, or bring them along")
                        : "No uncommitted changes"}
                      state={sourceCheck.lane?.status.dirty && !includeChanges ? "error" : sourceCheck.lane ? "ok" : "pending"}
                    />
                    <CheckRow
                      label="Remote branch"
                      detail={includeChanges && sourceCheck.needsPush && !sourceCheck.sync?.diverged
                        ? "Unpublished commits travel with this move"
                        : branchRowDetail(sourceCheck)}
                      state={includeChanges && sourceCheck.needsPush && !sourceCheck.sync?.diverged
                        ? "ok"
                        : branchRowState(sourceCheck)}
                    />
                    <CheckRow
                      label="Repository"
                      detail={sourceCheck.originUrl ? normalizeGitRemoteIdentity(sourceCheck.originUrl) ?? sourceCheck.originUrl : "No origin remote configured"}
                      state={sourceCheck.originUrl ? "ok" : "error"}
                    />
                  </>
                )}
                {/*
                  Every blocker renders here and only here. Standalone panels for
                  the active turn and the unpublished branch used to sit
                  alongside this list, so the same blocker and the same fix button
                  appeared twice — with different disabled behavior on each copy.
                */}
                <BlockedReasons
                  reasons={continueBlockers}
                  {...(continueBlockers.length > 1
                    ? { heading: `${continueBlockers.length} things to fix first` }
                    : {})}
                />
                {includeChanges ? (
                  <Banner
                    layout="inline"
                    testId="handoff-bring-changes"
                    model={{
                      id: "handoff-bring-changes",
                      tone: "accent",
                      icon: <GitBranch size={13} weight="bold" />,
                      title: changesLabel ? `Bringing ${changesLabel} along` : "Bringing your uncommitted work along",
                      detail: ".env and other ignored files stay here.",
                      actions: [{ label: "Leave them here", variant: "link", onClick: () => setIncludeChanges(false) }],
                    }}
                  />
                ) : null}
                {queueOnly ? (
                  <Banner
                    layout="inline"
                    testId="handoff-when-turn-ends"
                    model={{
                      id: "handoff-when-turn-ends",
                      tone: "info",
                      icon: <Hourglass size={13} weight="bold" />,
                      title: "Moves when this turn ends",
                      detail: queuedCloneApproved
                        ? `ADE checks everything again then, and clones the repository on ${selectedConnection?.target.name ?? "that machine"}.`
                        : "ADE checks everything again then. A new message from you keeps it here.",
                      actions: [
                        { label: "Stop current response", variant: "secondary", disabled: busyNow, onClick: () => void onStopTurn() },
                        { label: "Don't wait", variant: "link", onClick: () => setWhenTurnEnds(false) },
                      ],
                    }}
                  />
                ) : null}
              </div>

              <div className="space-y-3">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-fg/38">Choose a machine</div>
                  <div className="mt-1 text-[11px] leading-4 text-fg/48">Computers connected to ADE appear here.</div>
                </div>
                <div className="space-y-2">
                  {eligibleConnections.map((connection) => {
                    const selected = selectedTargetId === connection.target.id;
                    return (
                      <button
                        key={connection.target.id}
                        type="button"
                        onClick={() => {
                          setSelectedTargetId(connection.target.id);
                        }}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left transition-colors",
                          selected
                            ? "border-sky-300/26 bg-sky-400/[0.09]"
                            : "border-fg/[0.065] bg-fg/[0.025] hover:bg-fg/[0.045]",
                        )}
                      >
                        <div className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-lg", selected ? "bg-sky-300/12 text-sky-200" : "bg-fg/[0.04] text-fg/48")}>
                          <Desktop size={17} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[11px] font-semibold text-fg/82">{connection.target.name}</div>
                          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-fg/42">
                            {connection.route?.kind === "ssh" || connection.route?.kind === "tailnet" ? <LockKey size={11} /> : <ShieldWarning size={11} />}
                            {routeLabel(connection)}
                            {repoReadinessLabel(machineRepoReadiness[connection.target.id]) ? (
                              <>
                                <span className="text-fg/22">·</span>
                                <span className={repoReadinessClass(machineRepoReadiness[connection.target.id])}>
                                  {repoReadinessLabel(machineRepoReadiness[connection.target.id])}
                                </span>
                              </>
                            ) : null}
                          </div>
                        </div>
                        {selected ? <CheckCircle size={16} weight="fill" className="text-sky-200" /> : null}
                      </button>
                    );
                  })}
                  {!loading && eligibleConnections.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-fg/[0.09] px-4 py-6 text-center">
                      <Desktop size={22} className="mx-auto text-fg/28" />
                      <div className="mt-2 text-[11px] font-semibold text-fg/62">No eligible connected machines</div>
                      <div className="mt-1 text-[10px] leading-4 text-fg/40">
                        {sourceMachineTargetId
                          ? `This chat runs on ${sourceMachineName ?? "another machine"}. Connect a different ADE machine to this Mac, then reopen this setup.`
                          : "Connect another ADE machine, then reopen this setup."}
                      </div>
                    </div>
                  ) : null}
                  {incompatibleConnectedCount > 0 ? (
                    <div className="text-[10px] leading-4 text-amber-200/55">
                      {incompatibleConnectedCount} connected {incompatibleConnectedCount === 1 ? "machine needs" : "machines need"} an ADE update before handoff.
                    </div>
                  ) : null}
                </div>
                {onModelChange && modelId != null ? (
                  <div className="space-y-1.5">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-fg/38">The new chat</span>
                    {/*
                      Same control row as the composer, so there is nothing new to
                      learn and each picker keeps its own "can this model do it?"
                      logic — ReasoningEffortPicker renders nothing for a model
                      with no tiers, and fast mode only appears where supported.
                    */}
                    <div className="flex flex-wrap items-center gap-1.5">
                      <ModelPicker
                        value={modelId}
                        onChange={(nextModelId, options) => {
                          if (options) onFastModeChange?.(options.fastMode);
                          onModelChange(nextModelId);
                        }}
                        compact
                        {...(modelIdsForMode ? { availableModelIds: modelIdsForMode } : {})}
                        {...(mode === "fork" ? { filter: forkModelFilter } : {})}
                        {...(onOpenSignIn ? { onOpenSignIn } : {})}
                        fastMode={Boolean(fastMode)}
                        fastModeSupported={destinationFastModeSupported}
                        {...(onFastModeChange ? { onFastModeChange } : {})}
                      />
                      {onReasoningEffortChange ? (
                        <ReasoningEffortPicker
                          modelId={modelId}
                          reasoningEffort={reasoningEffort ?? null}
                          onChange={onReasoningEffortChange}
                          compact
                        />
                      ) : null}
                      {destinationPermissionPicker}
                    </div>
                    {mode === "fork" ? (
                      <span className="block text-[10px] leading-4 text-fg/40">Forked history stays with {providerLabel}; any {providerLabel} model is fine.</span>
                    ) : null}
                  </div>
                ) : null}
                <label className="block">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-fg/38">Note for the new chat</span>
                  <textarea
                    value={continuationPrompt}
                    onChange={(event) => setContinuationPrompt(event.target.value)}
                    maxLength={4000}
                    rows={4}
                    placeholder={mode === "fork"
                      ? "Optional. Tell the new chat what to do next; otherwise it just keeps going from the full history."
                      : "Optional. Tell the new chat what to do next; otherwise it just continues from the summary."}
                    className="mt-1.5 min-h-[82px] w-full resize-y rounded-lg border border-fg/[0.075] bg-black/20 px-3 py-2 text-[11px] leading-4 text-fg/78 outline-none placeholder:text-fg/28 focus:border-sky-300/25"
                  />
                  <span className="mt-1 block text-right text-[9px] text-fg/28">{continuationPrompt.length} / 4,000</span>
                </label>
              </div>
              </div>
              {forkFallbackReason ? (
                <Banner
                  model={{
                    id: "handoff-fork-fallback",
                    tone: "warning",
                    title: forkFallbackReason,
                    actions: [{ label: "Send as brief instead", disabled: Boolean(busyLabel), onClick: sendAsBrief }],
                  }}
                  layout="inline"
                />
              ) : null}
            </div>
          ) : null}

          {stage === "clone" && selectedConnection && prepared && storagePreflight ? (
            <div className="mx-auto max-w-[580px] space-y-4">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-fg/38">Repository setup</div>
                <h3 className="mt-1 text-[14px] font-semibold text-fg/88">Clone on {selectedConnection.target.name}?</h3>
                <p className="mt-1 text-[11px] leading-5 text-fg/48">
                  This repository isn&rsquo;t on {selectedConnection.target.name} yet. ADE will clone it there first.
                </p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <CheckRow label="Clone destination" detail={storagePreflight.targetPath} state={storagePreflight.targetExists ? "error" : "ok"} />
                <CheckRow
                  label="Free disk space"
                  detail={`${storagePreflight.freeBytes > 0 ? formatBytes(storagePreflight.freeBytes) : "Unavailable"} free · ${formatBytes(storagePreflight.requiredBytes)} minimum`}
                  state={storagePreflight.blockingErrors.some((item) => /space/i.test(item)) ? "error" : storagePreflight.warnings.length ? "warn" : "ok"}
                />
              </div>
              {storagePreflight.blockingErrors.map((message, index) => (
                <Banner
                  key={`error:${index}:${message}`}
                  model={{ id: `handoff-storage-error-${index}`, tone: "error", title: message }}
                  layout="inline"
                />
              ))}
              {storagePreflight.warnings.map((message, index) => (
                <Banner
                  key={`warning:${index}:${message}`}
                  model={{ id: `handoff-storage-warning-${index}`, tone: "warning", title: message }}
                  layout="inline"
                />
              ))}
              {isInsecureRoute(selectedConnection) ? (
                <Banner
                  model={{ id: "handoff-insecure-route", tone: "warning", title: insecureRouteNotice }}
                  layout="inline"
                />
              ) : null}
              <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-fg/[0.07] bg-fg/[0.025] px-3 py-2.5">
                <input
                  type="checkbox"
                  checked={cloneApproved}
                  onChange={(event) => setCloneApproved(event.target.checked)}
                  className="mt-0.5 accent-sky-400"
                />
                <span className="text-[10px] leading-4 text-fg/58">
                  Clone the repository on {selectedConnection.target.name}. Nothing uncommitted or secret leaves this machine.
                </span>
              </label>
            </div>
          ) : null}

          {(stage === "review" || stage === "sending") && selectedConnection && prepared && destinationPreflight ? (
            <div className="mx-auto max-w-[620px] space-y-3.5">
              {/* The destination is the headline, not a sentence: its icon, its
                  name, and the route it travels on, in one glance. */}
              <div className="flex items-center gap-3 rounded-xl border border-sky-300/18 bg-[linear-gradient(150deg,rgba(56,189,248,0.13),rgba(255,255,255,0.014)_62%)] px-4 py-3.5">
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-sky-300/24 bg-sky-400/12 text-sky-100">
                  <Desktop size={20} weight="duotone" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-semibold text-fg/90">Ready to continue on {selectedConnection.target.name}</div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5 rounded-full border border-fg/[0.08] bg-fg/[0.03] px-2.5 py-1 text-[10px] text-fg/60">
                  {isInsecureRoute(selectedConnection) ? <ShieldWarning size={11} /> : <LockKey size={11} />}
                  {routeLabel(selectedConnection)}
                </div>
              </div>
              {forkUnsupportedAtReview ? (
                <Banner
                  model={{
                    id: "handoff-fork-fallback-review",
                    tone: "warning",
                    title: forkFallbackReason ?? forkHandoffSupport?.reason ?? "That machine needs an ADE update for fork handoff.",
                    actions: [{ label: "Send as brief instead", disabled: Boolean(busyLabel), onClick: sendAsBrief }],
                  }}
                  layout="inline"
                />
              ) : null}
              {/* The four checks ARE the "is this ready" answer, so they stay —
                  now with the subject's own mark instead of four identical rows. */}
              <div className="grid gap-2 sm:grid-cols-2">
                <CheckRow icon={<HardDrives size={13} weight="duotone" />} label="Repository" detail={destinationProject?.displayName || destinationProject?.rootPath || "Ready on the other machine"} state="ok" />
                <CheckRow icon={<GitBranch size={13} weight="duotone" />} label="Branch commit" detail={`${prepared.capsule.source.branchRef} · ${prepared.capsule.source.headSha.slice(0, 10)}`} state={reviewBundle || destinationPreflight.remoteBranchHeadSha === prepared.capsule.source.headSha ? "ok" : "error"} />
                <CheckRow
                  icon={destinationDescriptor ? <ProviderLogo family={destinationDescriptor.family} size={13} /> : undefined}
                  label="Model access"
                  detail={destinationPreflight.modelAvailable ? "The model is available there" : "That model isn't available there yet"}
                  state={destinationPreflight.modelAvailable && destinationPreflight.providerAuthorized ? "ok" : "error"}
                />
                <CheckRow icon={<GitFork size={13} weight="duotone" />} label="Lane plan" detail={destinationPreflight.existingLaneId ? "Reuse the existing clean lane" : "Start a new lane from your branch"} state="ok" />
              </div>
              {bundleUnsupportedAtReview ? (
                <Banner
                  layout="inline"
                  model={{
                    id: "handoff-bundle-unsupported",
                    tone: "warning",
                    title: `${selectedConnection.target.name} needs an ADE update to take uncommitted changes.`,
                    detail: "Update ADE there, or go back and commit and publish instead.",
                  }}
                />
              ) : null}
              {includeChanges ? (
                /* What travels with "Bring them along", in two lines. */
                <div className="space-y-1 rounded-xl border border-fg/[0.065] bg-fg/[0.025] px-3.5 py-2.5 text-[10.5px]" data-testid="handoff-what-travels">
                  <div className="kit-eyebrow text-fg/40">What travels</div>
                  <div className="inline-flex items-center gap-1.5 text-fg/70">
                    <Check size={12} weight="bold" className="text-emerald-300/80" aria-hidden />
                    {[
                      reviewIsFork ? "fork" : "brief",
                      reviewBundle
                        ? describeTravellingChanges(reviewBundle.unpushedCommitCount, reviewBundle.changedFileCount)
                        : changesLabel,
                    ].filter(Boolean).join(" · ")}
                  </div>
                  <div className="flex items-center gap-1.5 text-fg/48">
                    <X size={12} weight="bold" className="text-fg/40" aria-hidden />
                    .env and ignored files stay here
                  </div>
                </div>
              ) : null}
              {destinationPreflight.warnings.map((message, index) => (
                <Banner
                  key={`warning:${index}:${message}`}
                  model={{ id: `handoff-destination-warning-${index}`, tone: "warning", title: message }}
                  layout="inline"
                />
              ))}
              {destinationPreflight.blockingErrors.map((message, index) => (
                <Banner
                  key={`error:${index}:${message}`}
                  model={{ id: `handoff-destination-error-${index}`, tone: "error", title: message }}
                  layout="inline"
                />
              ))}
              {destinationPreflight.laneFastForward ? (
                /*
                  The destination's lane is clean and a strict ancestor of your
                  commit, so it can catch up without losing anything. Offered
                  rather than done automatically: this rewrites git state on a
                  machine the user isn't sitting at.
                */
                <Banner
                  model={{
                    id: "handoff-lane-fast-forward",
                    tone: "warning",
                    title: `Lane ‘${destinationPreflight.laneFastForward.laneName}’ is ${destinationPreflight.laneFastForward.behindBy} ${destinationPreflight.laneFastForward.behindBy === 1 ? "commit" : "commits"} behind`,
                    detail: `It’s clean, so ADE can fast-forward it to your commit on ${selectedConnection?.target.name ?? "that machine"}. Nothing is discarded.`,
                    actions: [{
                      label: "Fetch & fast-forward there",
                      icon: <GitBranch size={12} />,
                      disabled: Boolean(busyLabel),
                      onClick: () => void fastForwardDestinationLane(),
                    }],
                  }}
                  layout="inline"
                />
              ) : null}
              {/* What travels, as marks rather than a paragraph. */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-fg/[0.065] bg-fg/[0.025] px-3.5 py-2.5 text-[10.5px] text-fg/55">
                <span className="inline-flex items-center gap-1.5">
                  <HardDrives size={13} className="text-fg/40" />
                  {reviewIsFork ? "Sent: the full conversation history" : "Sent: a short summary of this chat"}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <GitBranch size={13} className="text-fg/40" />
                  Sent: the branch and commit, plus your note
                </span>
                {!reviewIsFork ? (
                  <>
                    <span className="inline-flex items-center gap-1.5">
                      <LockKey size={13} className="text-fg/40" />
                      Never sent: the raw transcript, secrets, terminals, and caches
                    </span>
                  </>
                ) : (
                  <span className="inline-flex items-center gap-1.5">
                    <Warning size={13} className="text-fg/40" />
                    Includes anything pasted into this conversation
                  </span>
                )}
                {prepared.sanitizedSensitiveContext ? (
                  <span className="inline-flex items-center gap-1.5 text-emerald-200/70">
                    <CheckCircle size={13} weight="fill" />
                    {reviewIsFork
                      ? "ADE removed secret-shaped values from your note."
                      : "ADE removed detected secret-shaped values or source-only absolute paths from the summary."}
                  </span>
                ) : null}
              </div>
              {isInsecureRoute(selectedConnection) ? (
                /*
                  Informational, not a second confirmation. Sending the chat from
                  a non-end-to-end route is already an explicit act; the notice
                  has to be visible but must not stand between the user and a
                  button they just read.
                */
                <Banner
                  model={{ id: "handoff-insecure-route-review", tone: "warning", title: insecureRouteNotice }}
                  layout="inline"
                  testId="insecure-route-notice"
                />
              ) : null}
            </div>
          ) : null}

          {error && stage !== "complete" ? (
            <Banner
              model={{
                id: "handoff-error",
                tone: "error",
                title: error,
              }}
              layout="inline"
              style={{ margin: "16px auto 0", maxWidth: 620 }}
            />
          ) : null}
        </div>

    </Dialog>
  );
}

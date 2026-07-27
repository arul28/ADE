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
  Lightning,
  LockKey,
  ShieldWarning,
  Warning,
  X,
} from "@phosphor-icons/react";
import type {
  AgentChatAcceptCrossMachineHandoffResult,
  AgentChatPermissionMode,
  AgentChatCrossMachineDestinationPreflightResult,
  AgentChatCrossMachineTargetConfig,
  AgentChatPrepareCrossMachineHandoffResult,
  AgentChatProvider,
  GitUpstreamSyncStatus,
  LaneSummary,
  RemoteRuntimeConnectionStatus,
  RemoteRuntimeHandoffStoragePreflightResult,
  RemoteRuntimeProjectRecord,
} from "../../../shared/types";
import {
  decodeAcceptCrossMachineHandoffResult,
  decodeCrossMachineDestinationPreflightResult,
  normalizeGitRemoteIdentity,
  requireRemoteRuntimeRouteKind,
} from "../../../shared/crossMachineHandoff";
import { providerSupportsCrossMachineHandoffFork } from "../../../shared/types/chat";
import { providerDisplayLabel as providerDisplayLabelShared } from "../../../shared/pendingInputLabels";
import {
  isRemoteRuntimeConnectionError,
  isRuntimeTransportTimeoutError,
} from "../../../shared/runtimeErrors";
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
import { formatBytes } from "../../lib/format";
import {
  branchRowDetail,
  branchRowState,
  CheckRow,
  CROSS_MACHINE_HANDOFF_STILL_COMPLETING_MESSAGE,
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
  SEND_STEPS,
  type ForkHandoffSupport,
  type HandoffMode,
  type ModalStage,
  type SendStep,
  type SourceCheck,
} from "./crossMachineHandoffPresentation";
import { cn } from "../ui/cn";


export function CrossMachineHandoffModal({
  open,
  sourceSessionId,
  sourceLaneId,
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
  onFinished,
}: {
  open: boolean;
  sourceSessionId: string;
  sourceLaneId: string;
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
  onFinished: () => void;
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
  const [routeApproved, setRouteApproved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AgentChatAcceptCrossMachineHandoffResult | null>(null);
  const [sourceMarkerWarning, setSourceMarkerWarning] = useState<string | null>(null);
  /**
   * Which of the real send checkpoints have completed. These mirror the durable
   * states the destination actually walks (validate -> lane_ready/chat_ready ->
   * dispatched), so the list is reporting progress rather than animating it.
   */
  const [sendProgress, setSendProgress] = useState<SendStep[]>([]);
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
    const current = options.some((option) => option.value === summarized)
      ? summarized!
      : options[0]!.value;
    return (
      <PermissionModePicker
        ariaLabel="Permission mode for the new chat"
        selectedValue={current}
        options={options.map((option) => ({
          value: option.value,
          label: option.label,
          detail: option.shortDesc,
          tone: PERMISSION_SAFETY_TONES[option.safety],
          icon: PERMISSION_MODE_ICONS[option.value],
        }))}
        onSelect={(value) => {
          onNativeControlsChange(applyUnifiedPermissionToNativeControls(modelId, value, nativeControls));
        }}
      />
    );
  }, [destinationDescriptor, modelId, nativeControls, onNativeControlsChange]);

  const selectedConnection = useMemo(
    () => connections.find((connection) => connection.target.id === selectedTargetId) ?? null,
    [connections, selectedTargetId],
  );
  const eligibleConnections = useMemo(
    () => connections.filter((connection) =>
      connection.state === "connected"
      && connection.capabilities?.projects === true
      && connection.capabilities.machineProjects.handoffStoragePreflight === true,
    ),
    [connections],
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
    && connection.capabilities?.machineProjects.handoffStoragePreflight !== true,
  ).length;

  const inspectSource = useCallback(async (): Promise<SourceCheck> => {
    const [lanes, sync, origin] = await Promise.all([
      window.ade.lanes.list({ includeArchived: false, includeStatus: true }),
      window.ade.git.getSyncStatus({ laneId: sourceLaneId }),
      window.ade.git.getOriginRemote({ laneId: sourceLaneId }),
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
        detail: "The other machine picks the work up from Git, so anything uncommitted would be left behind here. Commit or discard it first.",
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
      const [, snapshot] = await Promise.all([
        inspectSource(),
        window.ade.remoteRuntime.getConnectionSnapshot(),
      ]);
      setConnections(snapshot.connections);
      const eligible = snapshot.connections.filter((connection) =>
        connection.state === "connected"
        && connection.capabilities?.projects === true
        && connection.capabilities.machineProjects.handoffStoragePreflight === true,
      );
      setSelectedTargetId((current) => current && eligible.some((item) => item.target.id === current)
        ? current
        : eligible[0]?.target.id ?? null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [inspectSource]);

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
    setRouteApproved(false);
    setResult(null);
    setSourceMarkerWarning(null);
    setSendProgress([]);
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

  useEffect(() => {
    setRouteApproved(false);
  }, [selectedConnection?.route?.kind]);

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

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && stage !== "sending") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose, open, stage]);

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
    if (!selectedConnection || sourceCheck.blockingErrors.length || sourceCheck.needsPush) return;
    if (turnActive || awaitingInput) {
      setError(turnActive
        ? "Stop the current response before preparing the handoff."
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
        ...target,
      });
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
    mode,
    runDestinationPreflight,
    selectedConnection,
    sourceCheck.blockingErrors.length,
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
      await window.ade.git.push({ laneId: sourceLaneId });
      await inspectSource();
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
      await window.ade.git.pull({ laneId: sourceLaneId });
      await inspectSource();
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

  const markSource = useCallback(async (
    accepted: AgentChatAcceptCrossMachineHandoffResult,
    connection: RemoteRuntimeConnectionStatus,
  ) => {
    await window.ade.agentChat.markCrossMachineHandoff({
      sourceSessionId,
      handoffId: accepted.handoffId,
      targetMachineName: connection.target.name,
      targetLaneId: accepted.laneId,
      targetSessionId: accepted.session.id,
    });
  }, [sourceSessionId]);

  const sendHandoff = useCallback(async () => {
    if (!selectedConnection || !prepared || !destinationProject || !destinationPreflight) return;
    if (destinationPreflight.blockingErrors.length) return;
    if (isInsecureRoute(selectedConnection) && !routeApproved) return;
    setStage("sending");
    setSendProgress([]);
    setBusyLabel("Rechecking source branch and chat…");
    setError(null);
    let destinationAcceptanceStarted = false;
    try {
      await window.ade.agentChat.validateCrossMachineSource({
        sourceSessionId,
        capsule: prepared.capsule,
        capsuleFingerprint: prepared.capsuleFingerprint,
      });
      setSendProgress(["validate"]);
      setBusyLabel("Creating destination lane and chat…");
      const requiredRouteKind = requireRemoteRuntimeRouteKind(selectedConnection.route?.kind);
      destinationAcceptanceStarted = true;
      const response = await window.ade.remoteRuntime.callAction(
        selectedConnection.target.id,
        destinationProject.projectId,
        {
          domain: "chat",
          action: "acceptCrossMachineHandoff",
          args: {
            capsule: prepared.capsule,
            capsuleFingerprint: prepared.capsuleFingerprint,
          },
          requiredRouteKind,
        },
      );
      const accepted = decodeAcceptCrossMachineHandoffResult(response.result);
      setSendProgress(["validate", "accept"]);
      setResult(accepted);
      try {
        await markSource(accepted, selectedConnection);
      } catch (markerError) {
        setSourceMarkerWarning(markerError instanceof Error ? markerError.message : String(markerError));
      } finally {
        // Destination acceptance is the commit point. A source-side marker is
        // useful bookkeeping, but its failure must not strand the parent UI in
        // a pre-transfer state or hide the successfully created destination.
        onFinished();
      }
      setStage("complete");
    } catch (sendError) {
      const rawMessage = sendError instanceof Error ? sendError.message : String(sendError);
      const completionMayBeUnconfirmed =
        isRemoteRuntimeConnectionError(sendError)
        || isRuntimeTransportTimeoutError(sendError);
      setError(
        destinationAcceptanceStarted && completionMayBeUnconfirmed
          ? CROSS_MACHINE_HANDOFF_STILL_COMPLETING_MESSAGE
          : rawMessage,
      );
      setStage("review");
    } finally {
      setBusyLabel(null);
    }
  }, [
    destinationPreflight,
    destinationProject,
    markSource,
    onFinished,
    prepared,
    routeApproved,
    selectedConnection,
    sourceSessionId,
  ]);

  if (!open) return null;

  const hasSourceBlock = sourceCheck.blockingErrors.length > 0;
  // Fix buttons share the modal's single busy slot, so they grey out together
  // with everything else while an operation is running.
  const sourceBlockReasons: BlockedActionReason[] = sourceCheck.blockingErrors.map((reason) => (
    reason.fix ? { ...reason, fix: { ...reason.fix, busy: Boolean(busyLabel) } } : reason
  ));
  /**
   * Everything standing between the user and "Continue". Assembled in one place
   * so the button cannot be disabled for a reason the user was never shown —
   * the blockers below the checks and the button's own tooltip read from this
   * same list.
   */
  const continueBlockers: BlockedActionReason[] = [
    ...sourceBlockReasons,
    ...(sourceCheck.needsPush
      ? [{
        id: "needs-push",
        title: `${sourceCheck.branch ?? "This branch"} hasn't been published`,
        detail: "The other machine fetches your work from origin, so the branch has to exist there.",
        fix: { label: "Publish branch", onFix: () => void publishBranch(), busy: Boolean(busyLabel) },
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
    ...(turnActive
      ? [{
        id: "turn-active",
        title: "This chat is still responding",
        detail: "Stop the current response, or wait for it to finish.",
        fix: { label: "Stop current response", onFix: () => void onStopTurn(), busy: Boolean(busyLabel) },
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
  // A pending fast-forward must gate Send. Preflight reports it as a warning so
  // the offer can render, but `acceptCrossMachineHandoff` still requires the
  // destination lane to be at the exact source commit — without this the user
  // could send and hit a hard failure after acceptance had already started.
  const reviewBlocked = Boolean(destinationPreflight?.blockingErrors.length)
    || Boolean(destinationPreflight?.laneFastForward)
    || forkUnsupportedAtReview;
  const routeNeedsApproval = isInsecureRoute(selectedConnection);
  const reviewIsFork = prepared?.capsule.mode === "fork";
  const handoffMayStillComplete = error === CROSS_MACHINE_HANDOFF_STILL_COMPLETING_MESSAGE;
  const insecureConsentLine = reviewIsFork
    ? "This connection is authenticated but not end-to-end encrypted. The full chat history is sent exactly as recorded."
    : "This connection is authenticated but not end-to-end encrypted. Only the summary is sent — never secrets.";

  return (
    <div
      className="fixed inset-0 z-[190] flex items-center justify-center bg-black/70 p-4 backdrop-blur-md"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && stage !== "sending") onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="cross-machine-handoff-title"
        className="grid max-h-[min(780px,calc(100vh-32px))] w-[min(760px,calc(100vw-32px))] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-2xl border border-white/[0.09] bg-[#11131a] shadow-[0_32px_120px_rgba(0,0,0,0.65)]"
      >
        <header className="flex items-start justify-between gap-4 border-b border-white/[0.065] px-5 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-sky-300/20 bg-sky-400/10 text-sky-200">
              <CloudArrowUp size={19} weight="duotone" />
            </div>
            <div className="min-w-0">
              <h2 id="cross-machine-handoff-title" className="font-sans text-[14px] font-semibold text-fg/92">
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
            disabled={stage === "sending"}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-fg/42 transition-colors hover:bg-white/[0.06] hover:text-fg/80 disabled:opacity-30"
          >
            <X size={15} />
          </button>
        </header>

        <div className="min-h-0 overflow-y-auto px-5 py-4">
          {stage === "complete" && result && selectedConnection ? (
            <div className="mx-auto flex max-w-[520px] flex-col items-center py-8 text-center">
              <div className="grid h-14 w-14 place-items-center rounded-full border border-emerald-300/25 bg-emerald-400/10 text-emerald-200">
                <Check size={28} weight="bold" />
              </div>
              <h3 className="mt-4 font-sans text-[16px] font-semibold text-fg/92">Handoff complete</h3>
              <p className="mt-2 text-[11px] leading-5 text-fg/52">
                {selectedConnection.target.name} now has the repository, lane, and continuation chat. This source chat and lane remain intact.
              </p>
              <div className="mt-5 grid w-full grid-cols-2 gap-2 text-left">
                <CheckRow label="Destination lane" detail={result.reusedLane ? "Existing clean lane reused" : "New lane created from the remote branch"} state="ok" />
                <CheckRow label="Destination chat" detail={result.reusedSession ? "Existing handoff chat resumed safely" : "New chat started with bounded context"} state="ok" />
              </div>
              {sourceMarkerWarning ? (
                <div className="mt-4 w-full rounded-lg border border-amber-300/20 bg-amber-400/[0.07] p-3 text-left text-[10px] leading-4 text-amber-100/75">
                  The destination succeeded, but ADE could not mark the source chat: {sourceMarkerWarning}
                  <button
                    type="button"
                    className="ml-2 font-semibold text-amber-100 underline decoration-amber-200/35 underline-offset-2"
                    onClick={() => {
                      void markSource(result, selectedConnection)
                        .then(() => {
                          setSourceMarkerWarning(null);
                          onFinished();
                        })
                        .catch((markerError) => setSourceMarkerWarning(markerError instanceof Error ? markerError.message : String(markerError)));
                    }}
                  >
                    Retry marker
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {stage === "choose" ? (
            <div className="space-y-5">
              <div>
                <div className="inline-flex w-full rounded-lg border border-white/[0.07] bg-white/[0.02] p-0.5">
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
                  <div className="mt-1 text-[11px] leading-4 text-fg/48">Your work needs to be committed and pushed so the other machine can pick it up.</div>
                </div>
                {loading ? <CheckRow label="Inspecting source lane" detail="Checking Git state and publication" state="pending" /> : (
                  <>
                    <CheckRow
                      label="Working tree"
                      detail={sourceCheck.lane?.status.dirty ? "Commit or discard your changes first" : "No uncommitted changes"}
                      state={sourceCheck.lane?.status.dirty ? "error" : sourceCheck.lane ? "ok" : "pending"}
                    />
                    <CheckRow
                      label="Remote branch"
                      detail={branchRowDetail(sourceCheck)}
                      state={branchRowState(sourceCheck)}
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
                          setRouteApproved(false);
                        }}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left transition-colors",
                          selected
                            ? "border-sky-300/26 bg-sky-400/[0.09]"
                            : "border-white/[0.065] bg-white/[0.025] hover:bg-white/[0.045]",
                        )}
                      >
                        <div className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-lg", selected ? "bg-sky-300/12 text-sky-200" : "bg-white/[0.04] text-fg/48")}>
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
                    <div className="rounded-xl border border-dashed border-white/[0.09] px-4 py-6 text-center">
                      <Desktop size={22} className="mx-auto text-fg/28" />
                      <div className="mt-2 text-[11px] font-semibold text-fg/62">No eligible connected machines</div>
                      <div className="mt-1 text-[10px] leading-4 text-fg/40">Connect another ADE machine, then reopen this setup.</div>
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
                        onChange={onModelChange}
                        surfaceKey="cross-machine-handoff"
                        compact
                        {...(modelIdsForMode ? { availableModelIds: modelIdsForMode } : {})}
                        {...(mode === "fork" ? { filter: forkModelFilter } : {})}
                        {...(onOpenSignIn ? { onOpenSignIn } : {})}
                      />
                      {onReasoningEffortChange ? (
                        <ReasoningEffortPicker
                          modelId={modelId}
                          reasoningEffort={reasoningEffort ?? null}
                          onChange={onReasoningEffortChange}
                          compact
                        />
                      ) : null}
                      {destinationFastModeSupported && onFastModeChange ? (
                        <button
                          type="button"
                          aria-pressed={Boolean(fastMode)}
                          onClick={() => onFastModeChange(!fastMode)}
                          className={cn(
                            PERMISSION_TRIGGER_CLASS,
                            fastMode && "border-amber-300/30 bg-amber-400/[0.10] text-amber-100",
                          )}
                        >
                          <Lightning size={10} weight="fill" />
                          Fast
                        </button>
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
                    className="mt-1.5 min-h-[82px] w-full resize-y rounded-lg border border-white/[0.075] bg-black/20 px-3 py-2 text-[11px] leading-4 text-fg/78 outline-none placeholder:text-fg/28 focus:border-sky-300/25"
                  />
                  <span className="mt-1 block text-right text-[9px] text-fg/28">{continuationPrompt.length} / 4,000</span>
                </label>
              </div>
              </div>
              {forkFallbackReason ? (
                <div className="rounded-lg border border-amber-300/20 bg-amber-400/[0.07] px-3 py-2.5">
                  <div className="text-[10.5px] leading-4 text-amber-100/80">{forkFallbackReason}</div>
                  <button
                    type="button"
                    disabled={Boolean(busyLabel)}
                    onClick={sendAsBrief}
                    className="mt-2 inline-flex h-7 items-center gap-1.5 rounded-md border border-amber-200/25 bg-amber-300/10 px-2.5 text-[10px] font-semibold text-amber-100 hover:bg-amber-300/15 disabled:opacity-45"
                  >
                    Send as brief instead
                  </button>
                </div>
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
              {[...storagePreflight.blockingErrors, ...storagePreflight.warnings].map((message) => (
                <div key={message} className="rounded-lg border border-amber-300/18 bg-amber-400/[0.06] px-3 py-2 text-[10px] leading-4 text-amber-100/70">{message}</div>
              ))}
              {routeNeedsApproval ? (
                <div className="rounded-lg border border-amber-300/20 bg-amber-400/[0.065] px-3 py-2.5 text-[10px] leading-4 text-amber-100/72">
                  {insecureConsentLine}
                </div>
              ) : null}
              <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-white/[0.07] bg-white/[0.025] px-3 py-2.5">
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
            <div className="mx-auto max-w-[620px] space-y-4">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-fg/38">Final review</div>
                <h3 className="mt-1 text-[14px] font-semibold text-fg/88">Ready to continue on {selectedConnection.target.name}</h3>
                <p className="mt-1 text-[11px] leading-5 text-fg/48">ADE double-checks everything when you send. Retrying is safe — it never creates duplicates.</p>
              </div>
              {forkUnsupportedAtReview ? (
                <div className="rounded-lg border border-amber-300/20 bg-amber-400/[0.07] px-3 py-2.5">
                  <div className="text-[10.5px] leading-4 text-amber-100/80">
                    {forkFallbackReason ?? forkHandoffSupport?.reason ?? "That machine needs an ADE update for fork handoff."}
                  </div>
                  <button
                    type="button"
                    disabled={Boolean(busyLabel)}
                    onClick={sendAsBrief}
                    className="mt-2 inline-flex h-7 items-center gap-1.5 rounded-md border border-amber-200/25 bg-amber-300/10 px-2.5 text-[10px] font-semibold text-amber-100 hover:bg-amber-300/15 disabled:opacity-45"
                  >
                    Send as brief instead
                  </button>
                </div>
              ) : null}
              <div className="grid gap-2 sm:grid-cols-2">
                <CheckRow label="Repository" detail={destinationProject?.displayName || destinationProject?.rootPath || "Ready on the other machine"} state="ok" />
                <CheckRow label="Branch commit" detail={`${prepared.capsule.source.branchRef} · ${prepared.capsule.source.headSha.slice(0, 10)}`} state={destinationPreflight.remoteBranchHeadSha === prepared.capsule.source.headSha ? "ok" : "error"} />
                <CheckRow label="Model access" detail={destinationPreflight.modelAvailable ? "The model is available there" : "That model isn't available there yet"} state={destinationPreflight.modelAvailable && destinationPreflight.providerAuthorized ? "ok" : "error"} />
                <CheckRow label="Lane plan" detail={destinationPreflight.existingLaneId ? "Reuse the existing clean lane" : "Start a new lane from your branch"} state="ok" />
              </div>
              {destinationPreflight.warnings.map((message) => (
                <div key={message} className="rounded-lg border border-amber-300/18 bg-amber-400/[0.06] px-3 py-2 text-[10px] leading-4 text-amber-100/70">{message}</div>
              ))}
              {destinationPreflight.blockingErrors.map((message) => (
                <div key={message} className="rounded-lg border border-red-300/18 bg-red-400/[0.06] px-3 py-2 text-[10px] leading-4 text-red-100/72">{message}</div>
              ))}
              {destinationPreflight.laneFastForward ? (
                /*
                  The destination's lane is clean and a strict ancestor of your
                  commit, so it can catch up without losing anything. Offered
                  rather than done automatically: this rewrites git state on a
                  machine the user isn't sitting at.
                */
                <div className="rounded-lg border border-amber-300/22 bg-amber-400/[0.07] px-3 py-2.5">
                  <div className="text-[11px] font-semibold text-amber-100/90">
                    Lane &lsquo;{destinationPreflight.laneFastForward.laneName}&rsquo; is {destinationPreflight.laneFastForward.behindBy}{" "}
                    {destinationPreflight.laneFastForward.behindBy === 1 ? "commit" : "commits"} behind
                  </div>
                  <div className="mt-1 text-[10px] leading-4 text-amber-100/60">
                    It&rsquo;s clean, so ADE can fast-forward it to your commit on {selectedConnection?.target.name ?? "that machine"}. Nothing is discarded.
                  </div>
                  <button
                    type="button"
                    disabled={Boolean(busyLabel)}
                    onClick={() => void fastForwardDestinationLane()}
                    className="mt-2 inline-flex h-7 items-center gap-1.5 rounded-md border border-amber-200/25 bg-amber-300/10 px-2.5 text-[10px] font-semibold text-amber-100 hover:bg-amber-300/16 disabled:opacity-45"
                  >
                    <GitBranch size={12} /> Fetch &amp; fast-forward there
                  </button>
                </div>
              ) : null}
              <div className="rounded-xl border border-white/[0.065] bg-white/[0.025] p-3">
                <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-fg/42">
                  <HardDrives size={13} /> What gets sent
                </div>
                <div className="mt-2 grid gap-x-6 gap-y-1 text-[10px] leading-4 text-fg/48 sm:grid-cols-2">
                  {reviewIsFork ? (
                    <>
                      <span>Sent: the full conversation history</span>
                      <span>Sent: the branch and commit, plus your note</span>
                      <span>The history is sent exactly as recorded — anything pasted into this conversation is included.</span>
                    </>
                  ) : (
                    <>
                      <span>Sent: a short summary of this chat</span>
                      <span>Sent: the branch and commit, plus your note</span>
                      <span>Never sent: secrets, terminals, and caches</span>
                      <span>Never sent: the raw transcript</span>
                    </>
                  )}
                </div>
                {prepared.sanitizedSensitiveContext ? (
                  <div className="mt-2 flex items-center gap-1.5 text-[10px] leading-4 text-emerald-200/65">
                    <CheckCircle size={12} weight="fill" /> {reviewIsFork
                      ? "ADE removed secret-shaped values from your note."
                      : "ADE removed detected secret-shaped values or source-only absolute paths from the summary."}
                  </div>
                ) : null}
              </div>
              {routeNeedsApproval ? (
                <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-amber-300/20 bg-amber-400/[0.065] px-3 py-2.5">
                  <input type="checkbox" checked={routeApproved} onChange={(event) => setRouteApproved(event.target.checked)} className="mt-0.5 accent-amber-400" />
                  <span className="text-[10px] leading-4 text-amber-100/72" data-testid="insecure-consent-review">
                    {insecureConsentLine}
                  </span>
                </label>
              ) : null}
            </div>
          ) : null}

          {error && stage !== "complete" ? (
            <div
              className={cn(
                "mx-auto mt-4 max-w-[620px] rounded-lg border px-3 py-2.5 text-[10px] leading-4",
                handoffMayStillComplete
                  ? "border-amber-300/20 bg-amber-400/[0.07] text-amber-100/75"
                  : "border-red-300/20 bg-red-400/[0.07] text-red-100/75",
              )}
            >
              {error}
            </div>
          ) : null}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-white/[0.065] px-5 py-3.5">
          <div className="min-w-0 text-[10px] text-fg/38">
            {stage === "sending" ? (
              <div className="flex flex-col gap-1">
                {SEND_STEPS.map((step) => {
                  const done = sendProgress.includes(step.id);
                  const current = !done && sendProgress.length === SEND_STEPS.findIndex((item) => item.id === step.id);
                  return (
                    <span
                      key={step.id}
                      className={cn(
                        "inline-flex items-center gap-1.5",
                        done ? "text-emerald-200/70" : current ? "text-fg/62" : "text-fg/26",
                      )}
                    >
                      {done ? (
                        <Check size={11} weight="bold" />
                      ) : current ? (
                        <CircleNotch size={11} className="animate-spin" />
                      ) : (
                        <span className="h-[11px] w-[11px] rounded-full border border-current opacity-45" />
                      )}
                      {step.label}
                    </span>
                  );
                })}
              </div>
            ) : busyLabel ? (
              <span className="inline-flex items-center gap-1.5"><CircleNotch size={12} className="animate-spin" />{busyLabel}</span>
            ) : stage === "choose" ? "Nothing is sent until you confirm." : stage === "complete" ? "This chat stays here too." : "Retrying is safe."}
          </div>
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
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 text-[10px] font-semibold text-fg/58 hover:text-fg/80 disabled:opacity-40"
              >
                <ArrowLeft size={12} /> Back
              </button>
            ) : null}
            {stage === "choose" ? (
              <BlockedActionButton
                reasons={loading ? [] : continueBlockers}
                busy={loading || Boolean(busyLabel)}
                onClick={() => void prepareDestination()}
              >
                Continue <ArrowRight size={12} />
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
                disabled={Boolean(busyLabel) || reviewBlocked || (routeNeedsApproval && !routeApproved)}
                onClick={() => void sendHandoff()}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-emerald-300/24 bg-emerald-400/12 px-3 text-[10px] font-semibold text-emerald-100 hover:bg-emerald-400/17 disabled:cursor-not-allowed disabled:opacity-35"
              >
                Send chat <ArrowRight size={12} />
              </button>
            ) : null}
            {stage === "complete" ? (
              <button type="button" onClick={onClose} className="h-8 rounded-md border border-emerald-300/24 bg-emerald-400/12 px-3 text-[10px] font-semibold text-emerald-100 hover:bg-emerald-400/17">Done</button>
            ) : null}
          </div>
        </footer>
      </section>
    </div>
  );
}

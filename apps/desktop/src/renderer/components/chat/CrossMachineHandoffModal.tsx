import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleNotch,
  CloudArrowUp,
  Desktop,
  GitBranch,
  GitFork,
  HardDrives,
  LockKey,
  Warning,
  X,
} from "@phosphor-icons/react";
import type {
  AgentChatCrossMachineHandoffBlocker,
  AgentChatCrossMachineHandoffMachineOption,
  AgentChatCrossMachineHandoffOptionsResult,
  AgentChatCrossMachineHandoffRecord,
  AgentChatCrossMachineTargetConfig,
  AgentChatPermissionMode,
  AgentChatPreviewCrossMachineHandoffResult,
  AgentChatProvider,
  OpenProjectBinding,
} from "../../../shared/types";
import { stripElectronErrorWrapper } from "../../../shared/codedError";
import { providerSupportsCrossMachineHandoffFork } from "../../../shared/types/chat";
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
import { getPermissionOptions } from "../shared/permissionOptions";
import {
  PermissionModePicker,
  type PermissionModeIconKind,
  type PermissionModeTone,
} from "../shared/PermissionModePicker";
import { ModelPicker } from "../shared/ModelPicker/ModelPicker";
import { ReasoningEffortPicker } from "../shared/ModelPicker/ReasoningEffortPicker";
import {
  BlockedActionButton,
  type BlockedActionFix,
  type BlockedActionReason,
} from "../shared/BlockedAction";
import { ProviderLogo } from "../shared/ProviderLogos";
import { describeTravellingChanges } from "./CrossMachineHandoffBanner";
import { CrossMachineHandoffChooseStage, machineAvailable } from "./CrossMachineHandoffChooseStage";
import {
  CheckRow,
  forkFallbackReasonForPrepareError,
  providerDisplayLabel,
  toPermissionPickerOption,
  type HandoffMode,
  type ModalStage,
} from "./crossMachineHandoffPresentation";
import { Banner } from "../ui/notice/Banner";
import { Dialog } from "../ui/dialog";

/**
 * Setup for moving a chat to another machine. A thin client of the source
 * brain (`crossMachineHandoffOrchestrator`): the brain lists the machines and
 * what blocks the move, previews what the destination would say over its own
 * transport, and runs the move itself. Nothing here talks to the destination
 * or packs the chat; the modal only collects choices and shows answers.
 */

const ROUTE_LINE = "The move travels over your account's paired connection between the two ADE brains.";

function errorText(error: unknown): string {
  return stripElectronErrorWrapper(error instanceof Error ? error.message : String(error));
}

/** Finds a machine by key or display name, case-insensitively. */
function findMachine(
  machines: AgentChatCrossMachineHandoffMachineOption[],
  wanted: string | null | undefined,
): AgentChatCrossMachineHandoffMachineOption | undefined {
  const needle = wanted?.trim().toLowerCase() ?? "";
  if (!needle) return undefined;
  return machines.find((machine) =>
    machine.machineKey.toLowerCase() === needle || machine.name.trim().toLowerCase() === needle,
  );
}

export function CrossMachineHandoffModal({
  open,
  sourceSessionId,
  sourceLaneId,
  runtimePin = null,
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
  /** The chat's lane, for the Publish/Update branch fixes. */
  sourceLaneId: string;
  /**
   * The machine the SOURCE chat runs on, or null when it runs on the machine
   * this tab is bound to. Every call goes to that brain: the options, the
   * preview, the start, and the git push/pull behind the branch fixes.
   */
  runtimePin?: OpenProjectBinding | null;
  /** Source chat provider; drives whether forking history is offered. */
  sourceProvider?: AgentChatProvider | null;
  target: AgentChatCrossMachineTargetConfig;
  /** Destination model for the new chat; the modal owns this choice. */
  modelId?: string;
  onModelChange?: (modelId: string) => void;
  availableModelIds?: string[];
  /** Same-provider models offered when forking (fork must stay on one provider). */
  forkAvailableModelIds?: string[];
  /** Destination reasoning/permission settings, carried with the move. */
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
  onStarted: (record: AgentChatCrossMachineHandoffRecord, continuationPrompt: string | null) => void;
  /** Machine to select on open (key or name), e.g. from the session menu. */
  preselectedMachine?: string | null;
}) {
  const [stage, setStage] = useState<ModalStage>("choose");
  const [loading, setLoading] = useState(false);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [options, setOptions] = useState<AgentChatCrossMachineHandoffOptionsResult | null>(null);
  const [selectedMachineKey, setSelectedMachineKey] = useState<string | null>(null);
  const [continuationPrompt, setContinuationPrompt] = useState("");
  const [preview, setPreview] = useState<AgentChatPreviewCrossMachineHandoffResult | null>(null);
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
  /**
   * The source machine's binding, held in a ref so each operation freezes it
   * once and keeps every one of its awaits on the same brain.
   */
  const runtimePinRef = useRef<OpenProjectBinding | null>(runtimePin);
  runtimePinRef.current = runtimePin;
  /** Drops answers from a load that a newer one replaced. */
  const loadRequestRef = useRef(0);
  // Cross-machine fork is narrower than local fork: Droid's session index is
  // machine-local, so it can fork here but never onto another machine.
  const sourceProviderSupportsFork = providerSupportsCrossMachineHandoffFork(sourceProvider);
  const [mode, setMode] = useState<HandoffMode>(sourceProviderSupportsFork ? "fork" : "brief");
  // Plain reason a fork can't go as asked (an older destination, or history
  // too big); drives the one-click "send as brief" offer.
  const [forkFallbackReason, setForkFallbackReason] = useState<string | null>(null);
  const providerLabel = providerDisplayLabel(sourceProvider);
  const forkModelIds = forkAvailableModelIds ?? availableModelIds;
  const modelIdsForMode = mode === "fork" ? forkModelIds : availableModelIds;
  const forkModelFilter = useCallback((descriptor: ModelDescriptor) => (
    Boolean(sourceProvider && resolveProviderGroupForModel(descriptor) === sourceProvider)
  ), [sourceProvider]);

  /**
   * Everything about the *destination* chat's controls is derived from the model
   * chosen here, never from the local handoff drawer's model.
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
    // Two vocabularies that are not interchangeable: `getPermissionOptions`
    // branches on ProviderFamily ("anthropic", "openai", "factory") while
    // `summarizeNativeControls` keys off the provider group ("claude", "codex",
    // "droid").
    const permissionOptions = getPermissionOptions({
      family: destinationDescriptor.family,
      isCliWrapped: destinationDescriptor.isCliWrapped,
    });
    if (permissionOptions.length === 0) return null;
    const summarized = summarizeNativeControls(providerGroup, nativeControls).permissionMode;
    const representable = permissionOptions.some((option) => option.value === summarized);
    // A native combination the presets cannot express travels as-is, so it
    // shows as Custom rather than borrowing the first preset's label.
    const customValue = "__custom__";
    const pickerOptions = representable
      ? permissionOptions.map(toPermissionPickerOption)
      : [
        ...permissionOptions.map(toPermissionPickerOption),
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

  const machines = useMemo(() => options?.machines ?? [], [options]);
  const selectedMachine = useMemo(
    () => machines.find((machine) => machine.machineKey === selectedMachineKey) ?? null,
    [machines, selectedMachineKey],
  );

  /** Asks the brain what the move looks like from here. */
  const loadOptions = useCallback(async (): Promise<void> => {
    const request = ++loadRequestRef.current;
    const pin = runtimePinRef.current;
    setLoading(true);
    try {
      const next = await window.ade.agentChat.getCrossMachineHandoffOptions({ sourceSessionId }, pin);
      if (request !== loadRequestRef.current) return;
      setOptions(next);
      setSelectedMachineKey((current) => {
        // A reload after a branch fix keeps the person's pick.
        const kept = current ? next.machines.find((machine) => machine.machineKey === current) : undefined;
        if (kept && machineAvailable(kept)) return kept.machineKey;
        const preselected = findMachine(next.machines, preselectedMachine);
        if (preselected && machineAvailable(preselected)) return preselected.machineKey;
        return next.machines.find(machineAvailable)?.machineKey ?? null;
      });
    } catch (loadError) {
      if (request === loadRequestRef.current) setError(errorText(loadError));
    } finally {
      if (request === loadRequestRef.current) setLoading(false);
    }
  }, [preselectedMachine, sourceSessionId]);

  useEffect(() => {
    if (!open) return;
    setStage("choose");
    setBusyLabel(null);
    setOptions(null);
    setSelectedMachineKey(null);
    setContinuationPrompt("");
    setPreview(null);
    setCloneApproved(false);
    setError(null);
    setIncludeChanges(false);
    setWhenTurnEnds(false);
    setQueuedCloneApproved(false);
    setMode(sourceProviderSupportsFork ? "fork" : "brief");
    setForkFallbackReason(null);
    void loadOptions();
  }, [loadOptions, open, sourceProviderSupportsFork]);

  const backToChoose = useCallback(() => {
    setStage("choose");
    setPreview(null);
    setCloneApproved(false);
    setError(null);
  }, []);

  /**
   * The review step: the source brain asks the destination over its own
   * transport, so what shows here is what the move will actually meet.
   */
  const reviewMove = useCallback(async (requestedMode: HandoffMode = mode) => {
    if (!selectedMachine || !modelId) return;
    setBusyLabel(`Checking ${selectedMachine.name}…`);
    setError(null);
    setForkFallbackReason(null);
    try {
      const next = await window.ade.agentChat.previewCrossMachineHandoff({
        sourceSessionId,
        machine: selectedMachine.machineKey,
        targetModelId: modelId,
        mode: requestedMode,
        ...(includeChanges ? { includeChanges: true } : {}),
      }, runtimePinRef.current);
      setPreview(next);
      const fork = requestedMode === "fork" ? next.preflight?.forkHandoffSupport : undefined;
      if (requestedMode === "fork" && next.preflight && !fork?.supported) {
        // Absent = an older destination that predates fork handoff.
        setForkFallbackReason(fork?.reason ?? `${next.machineName} needs an ADE update for fork handoff.`);
      }
      setStage(next.hasRepository ? "review" : "clone");
    } catch (previewError) {
      setError(errorText(previewError));
    } finally {
      setBusyLabel(null);
    }
  }, [includeChanges, mode, modelId, selectedMachine, sourceSessionId]);

  const switchMode = useCallback((next: HandoffMode) => {
    setMode(next);
    setForkFallbackReason(null);
    setError(null);
    if (next === "fork" && modelId && forkModelIds && forkModelIds.length > 0 && !forkModelIds.includes(modelId)) {
      onModelChange?.(forkModelIds[0]!);
    }
  }, [forkModelIds, modelId, onModelChange]);

  /**
   * The brain runs the move from here (pack, destination checks, fast-forward,
   * accept, mark) and persists each step, so the modal's job ends when it
   * accepts. Progress, failure and "lost confirmation" live in the banner.
   */
  const startMove = useCallback(async (overrideMode?: HandoffMode) => {
    if (!selectedMachine) return;
    const moveMode = overrideMode ?? mode;
    setBusyLabel(turnActive ? "Queuing the move…" : "Starting the move…");
    setError(null);
    try {
      const record = await window.ade.agentChat.startCrossMachineHandoff({
        ...target,
        sourceSessionId,
        machine: selectedMachine.machineKey,
        mode: moveMode,
        continuationPrompt: continuationPrompt.trim() || null,
        ...(includeChanges ? { includeChanges: true } : {}),
        ...(cloneApproved || queuedCloneApproved ? { clone: true } : {}),
        ...(turnActive ? { whenTurnEnds: true } : {}),
      }, runtimePinRef.current);
      onStarted(record, continuationPrompt.trim() || null);
      onClose();
    } catch (startError) {
      const message = errorText(startError);
      // A fork that can't be packed still works as a brief: offer the swap.
      const fallbackReason = moveMode === "fork" ? forkFallbackReasonForPrepareError(message) : null;
      if (fallbackReason) setForkFallbackReason(fallbackReason);
      else setError(message);
    } finally {
      setBusyLabel(null);
    }
  }, [
    cloneApproved,
    continuationPrompt,
    includeChanges,
    mode,
    onClose,
    onStarted,
    queuedCloneApproved,
    selectedMachine,
    sourceSessionId,
    target,
    turnActive,
  ]);

  // One click from "can't fork" to a brief. A queued move or a clone the
  // person already confirmed starts at once; otherwise the brief is reviewed
  // against the destination again.
  const sendAsBrief = useCallback(() => {
    switchMode("brief");
    if (stage === "clone" || (stage === "choose" && turnActive && whenTurnEnds)) {
      void startMove("brief");
    } else {
      void reviewMove("brief");
    }
  }, [reviewMove, stage, startMove, switchMode, turnActive, whenTurnEnds]);

  /** Runs a git fix on the chat's own machine, then asks the brain again. */
  const runBranchFix = useCallback(async (label: string, action: (pin: OpenProjectBinding | null) => Promise<unknown>) => {
    setBusyLabel(label);
    setError(null);
    try {
      await action(runtimePinRef.current);
      await loadOptions();
    } catch (fixError) {
      setError(errorText(fixError));
    } finally {
      setBusyLabel(null);
    }
  }, [loadOptions]);
  const publishBranch = useCallback(() => runBranchFix(
    "Publishing the branch…",
    (pin) => window.ade.git.push({ laneId: sourceLaneId }, pin),
  ), [runBranchFix, sourceLaneId]);
  /**
   * Only offered when the branch is strictly behind. A diverged branch keeps
   * the hard block: picking merge or rebase is not this flow's decision.
   */
  const updateBranch = useCallback(() => runBranchFix(
    "Updating the branch…",
    (pin) => window.ade.git.pull({ laneId: sourceLaneId }, pin),
  ), [runBranchFix, sourceLaneId]);
  /**
   * A move whose answer was lost blocks new ones; the same Retry and Dismiss
   * as the banner, on the chat's own brain, then the options again.
   */
  const retryUnknownMove = useCallback(() => runBranchFix(
    "Retrying the move…",
    (pin) => window.ade.agentChat.retryCrossMachineHandoff({ sourceSessionId }, pin),
  ), [runBranchFix, sourceSessionId]);
  const dismissUnknownMove = useCallback(() => runBranchFix(
    "Dismissing the move…",
    (pin) => window.ade.agentChat.cancelCrossMachineHandoff({ sourceSessionId }, pin),
  ), [runBranchFix, sourceSessionId]);

  if (!open) return null;

  const busyNow = Boolean(busyLabel);
  const changes = options?.changes ?? null;
  const changesLabel = changes ? describeTravellingChanges(changes.unpushedCommits, changes.changedFiles) : null;
  const bringAlong: BlockedActionFix = {
    label: changesLabel ? `Bring them along (${changesLabel})` : "Bring them along",
    onFix: () => setIncludeChanges(true),
    busy: busyNow,
  };
  const fixesFor = (blocker: AgentChatCrossMachineHandoffBlocker): BlockedActionFix[] => {
    const fixes: BlockedActionFix[] = [];
    if (blocker.id === "unpushed" || blocker.id === "no_upstream") {
      fixes.push({ label: "Publish branch", onFix: () => void publishBranch(), busy: busyNow });
    }
    if (blocker.id === "behind") {
      fixes.push({ label: "Update branch", onFix: () => void updateBranch(), busy: busyNow });
    }
    if (blocker.id === "move_unknown") {
      fixes.push({ label: "Retry", onFix: () => void retryUnknownMove(), busy: busyNow });
      fixes.push({ label: "Dismiss", onFix: () => void dismissUnknownMove(), busy: busyNow });
    }
    if (blocker.clearedByIncludeChanges) fixes.push(bringAlong);
    return fixes;
  };
  // With "Bring them along", what travels no longer blocks.
  const brainBlockers = (options?.blockers ?? []).filter((blocker) =>
    !(includeChanges && blocker.clearedByIncludeChanges),
  );
  const brainSaysAwaitingInput = brainBlockers.some((blocker) => blocker.id === "awaiting_input");
  const queueOnly = turnActive && whenTurnEnds;
  // A queued move never sees the clone screen, so it asks for consent here.
  const queuedMoveNeedsClone = queueOnly && selectedMachine?.hasRepository === false;
  /**
   * Everything standing between the user and "Continue", in one list so the
   * button cannot be disabled for a reason the user was never shown.
   */
  const continueBlockers: BlockedActionReason[] = [
    ...brainBlockers.map((blocker) => {
      const fixes = fixesFor(blocker);
      return {
        id: blocker.id,
        title: blocker.title,
        detail: blocker.detail,
        ...(fixes.length ? { fixes } : {}),
      };
    }),
    ...(!modelId
      ? [{
        id: "no-model",
        title: "No model picked for the new chat",
        detail: "Pick the model the chat should continue with.",
      }]
      : []),
    ...(!loading && !selectedMachine
      ? [{
        id: "no-machine",
        title: "No machine selected",
        detail: machines.some(machineAvailable)
          ? "Pick which computer should continue this chat."
          : "No other ADE machine on this account can take it right now.",
      }]
      : []),
    // A busy chat is not a dead end: it can move once the turn ends.
    ...(turnActive && !whenTurnEnds
      ? [{
        id: "turn-active",
        title: "This chat is still responding",
        detail: "Move it when this turn ends, or stop the current response.",
        fixes: [
          { label: "Move when this turn ends", onFix: () => setWhenTurnEnds(true), busy: busyNow },
          { label: "Stop current response", onFix: () => void onStopTurn(), busy: busyNow },
        ],
      }]
      : []),
    ...(queuedMoveNeedsClone && !queuedCloneApproved
      ? [{
        id: "queued-clone",
        title: `This repository isn't on ${selectedMachine?.name ?? "that machine"} yet`,
        detail: "ADE clones it there from GitHub when the move starts.",
        fixes: [{ label: "Clone it there", onFix: () => setQueuedCloneApproved(true), busy: busyNow }],
      }]
      : []),
    ...(awaitingInput && !brainSaysAwaitingInput
      ? [{
        id: "awaiting-input",
        title: "This chat is waiting on you",
        detail: "Resolve the pending approval or question in the chat first.",
      }]
      : []),
  ];

  const preflight = preview?.preflight ?? null;
  const reviewMachineName = preview?.machineName ?? selectedMachine?.name ?? "that machine";
  // A fork against a destination that can't fork must not send as-is.
  const forkUnsupportedAtReview = mode === "fork" && preflight != null && preflight.forkHandoffSupport?.supported !== true;
  // An older destination would drop the changes; the brain refuses it too,
  // but the review says so before Send.
  const bundleUnsupportedAtReview = includeChanges && preflight != null && preflight.gitBundleSupport !== true;
  const modelReady = preflight ? preflight.modelAvailable && preflight.providerAuthorized : false;
  const reviewBlocked = !preflight
    || preflight.blockingErrors.length > 0
    || !modelReady
    || forkUnsupportedAtReview
    || bundleUnsupportedAtReview;
  const fastForward = preflight?.laneFastForward ?? null;
  const lanePlan = fastForward
    ? `Will fast-forward ‘${fastForward.laneName}’ there (${fastForward.behindBy} ${fastForward.behindBy === 1 ? "commit" : "commits"} behind)`
    : preflight?.existingLaneId
      ? "Reuse the existing clean lane there"
      : "Start a new lane from your branch";
  const sendLabel = turnActive ? "Send when this turn ends" : "Send chat";

  const newChatControls = onModelChange && modelId != null ? (
    <div className="space-y-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-fg/38">The new chat</span>
      {/* The composer's own control row, so each picker keeps its
          own "can this model do it?" logic. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <ModelPicker
          value={modelId}
          onChange={(nextModelId, pickerOptions) => {
            if (pickerOptions) onFastModeChange?.(pickerOptions.fastMode);
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
  ) : null;

  const whatTravels = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-fg/[0.065] bg-fg/[0.025] px-3.5 py-2.5 text-[10.5px] text-fg/55" data-testid="handoff-what-travels">
      <span className="inline-flex items-center gap-1.5">
        <HardDrives size={13} className="text-fg/40" />
        {mode === "fork" ? "Sent: the full conversation history" : "Sent: a short summary of this chat"}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <GitBranch size={13} className="text-fg/40" />
        {includeChanges
          ? `Sent: the branch, your note, and ${changesLabel ?? "your uncommitted work"}`
          : "Sent: the branch and commit, plus your note"}
      </span>
      {mode === "fork" ? (
        <span className="inline-flex items-center gap-1.5">
          <Warning size={13} className="text-fg/40" />
          Includes anything pasted into this conversation
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5">
          <LockKey size={13} className="text-fg/40" />
          Never sent: the raw transcript, secrets, terminals, and caches
        </span>
      )}
      <span className="inline-flex items-center gap-1.5">
        <X size={12} weight="bold" className="text-fg/40" aria-hidden />
        .env and ignored files stay here
      </span>
      <span className="block w-full text-fg/42">{ROUTE_LINE}</span>
    </div>
  );

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
              disabled={busyNow}
              onClick={backToChoose}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-fg/[0.08] bg-fg/[0.03] px-2.5 text-[10px] font-semibold text-fg/58 hover:text-fg/80 disabled:opacity-40"
            >
              <ArrowLeft size={12} /> Back
            </button>
          ) : null}
          {stage === "choose" ? (
            <BlockedActionButton
              reasons={loading ? [] : continueBlockers}
              busy={loading || busyNow}
              // A queued move skips review: the brain re-runs every check when
              // the turn ends.
              onClick={() => void (queueOnly ? startMove() : reviewMove())}
            >
              {queueOnly ? <>Move when this turn ends <ArrowRight size={12} /></> : <>Continue <ArrowRight size={12} /></>}
            </BlockedActionButton>
          ) : null}
          {stage === "clone" ? (
            <button
              type="button"
              disabled={busyNow || !cloneApproved}
              onClick={() => void startMove()}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-sky-300/24 bg-sky-400/12 px-3 text-[10px] font-semibold text-sky-100 hover:bg-sky-400/17 disabled:cursor-not-allowed disabled:opacity-35"
            >
              Clone and {turnActive ? "send when this turn ends" : "send"} <ArrowRight size={12} />
            </button>
          ) : null}
          {stage === "review" ? (
            <button
              type="button"
              disabled={busyNow || reviewBlocked}
              onClick={() => void startMove()}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-emerald-300/24 bg-emerald-400/12 px-3 text-[10px] font-semibold text-emerald-100 hover:bg-emerald-400/17 disabled:cursor-not-allowed disabled:opacity-35"
            >
              {sendLabel} <ArrowRight size={12} />
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
            disabled={busyNow}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-fg/42 transition-colors hover:bg-fg/[0.06] hover:text-fg/80 disabled:opacity-30"
          >
            <X size={15} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {stage === "choose" ? (
            <CrossMachineHandoffChooseStage
              mode={mode}
              sourceProviderSupportsFork={sourceProviderSupportsFork}
              providerLabel={providerLabel}
              onSwitchMode={switchMode}
              loading={loading}
              optionsLoaded={options != null}
              continueBlockers={continueBlockers}
              includeChanges={includeChanges}
              changesLabel={changesLabel}
              onLeaveChangesHere={() => setIncludeChanges(false)}
              queueOnly={queueOnly}
              queuedCloneApproved={queuedCloneApproved}
              busy={busyNow}
              onStopTurn={onStopTurn}
              onDontWait={() => setWhenTurnEnds(false)}
              machines={machines}
              selectedMachineKey={selectedMachineKey}
              selectedMachineName={selectedMachine?.name ?? null}
              onSelectMachine={(machineKey) => {
                setSelectedMachineKey(machineKey);
                setQueuedCloneApproved(false);
              }}
              newChatControls={newChatControls}
              continuationPrompt={continuationPrompt}
              onContinuationPromptChange={setContinuationPrompt}
            />
          ) : null}

          {stage === "clone" ? (
            <div className="mx-auto max-w-[580px] space-y-4">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-fg/38">Repository setup</div>
                <h3 className="mt-1 text-[14px] font-semibold text-fg/88">Clone on {reviewMachineName}?</h3>
                <p className="mt-1 text-[11px] leading-5 text-fg/48">
                  This repository isn&rsquo;t on {reviewMachineName} yet. ADE clones it there from GitHub with that
                  machine&rsquo;s own Git sign-in, checks everything, then sends the chat.
                </p>
              </div>
              {whatTravels}
              <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-fg/[0.07] bg-fg/[0.025] px-3 py-2.5">
                <input
                  type="checkbox"
                  checked={cloneApproved}
                  onChange={(event) => setCloneApproved(event.target.checked)}
                  className="mt-0.5 accent-sky-400"
                />
                <span className="text-[10px] leading-4 text-fg/58">
                  Clone the repository on {reviewMachineName}.
                </span>
              </label>
            </div>
          ) : null}

          {stage === "review" && preview ? (
            <div className="mx-auto max-w-[620px] space-y-3.5">
              <div className="flex items-center gap-3 rounded-xl border border-sky-300/18 bg-[linear-gradient(150deg,rgba(56,189,248,0.13),rgba(255,255,255,0.014)_62%)] px-4 py-3.5">
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-sky-300/24 bg-sky-400/12 text-sky-100">
                  <Desktop size={20} weight="duotone" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-semibold text-fg/90">
                    {reviewBlocked ? `Not ready on ${reviewMachineName} yet` : `Ready to continue on ${reviewMachineName}`}
                  </div>
                </div>
              </div>
              {preflight ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <CheckRow icon={<HardDrives size={13} weight="duotone" />} label="Repository" detail="Already on that machine" state="ok" />
                  <CheckRow
                    icon={destinationDescriptor ? <ProviderLogo family={destinationDescriptor.family} size={13} /> : undefined}
                    label="Model access"
                    detail={!preflight.providerAuthorized
                      ? "That machine isn't signed in to this provider"
                      : preflight.modelAvailable
                        ? "The model is available there"
                        : "That model isn't available there yet"}
                    state={modelReady ? "ok" : "error"}
                  />
                  <CheckRow icon={<GitFork size={13} weight="duotone" />} label="Lane plan" detail={lanePlan} state="ok" />
                  {mode === "fork" ? (
                    <CheckRow
                      icon={<Check size={13} weight="bold" />}
                      label="Full history"
                      detail={forkUnsupportedAtReview ? "That machine can't take a fork" : "That machine can take the full history"}
                      state={forkUnsupportedAtReview ? "error" : "ok"}
                    />
                  ) : null}
                </div>
              ) : null}
              {bundleUnsupportedAtReview ? (
                <Banner
                  layout="inline"
                  model={{
                    id: "handoff-bundle-unsupported",
                    tone: "warning",
                    title: `${reviewMachineName} needs an ADE update to take uncommitted changes.`,
                    detail: "Update ADE there, or go back and commit and publish instead.",
                  }}
                />
              ) : null}
              {preflight?.warnings
                // The fast-forward is a plan, not a warning: the brain does it.
                .filter((message) => !(fastForward && /fast-forward/i.test(message)))
                .map((message, index) => (
                  <Banner
                    key={`warning:${index}:${message}`}
                    model={{ id: `handoff-destination-warning-${index}`, tone: "warning", title: message }}
                    layout="inline"
                  />
                ))}
              {preflight?.blockingErrors.map((message, index) => (
                <Banner
                  key={`error:${index}:${message}`}
                  model={{ id: `handoff-destination-error-${index}`, tone: "error", title: message }}
                  layout="inline"
                />
              ))}
              {whatTravels}
            </div>
          ) : null}

          {mode === "fork" && (forkFallbackReason || forkUnsupportedAtReview) ? (
            <Banner
              model={{
                id: "handoff-fork-fallback",
                tone: "warning",
                title: forkFallbackReason ?? `${reviewMachineName} needs an ADE update for fork handoff.`,
                actions: [{ label: "Send as brief instead", disabled: busyNow, onClick: sendAsBrief }],
              }}
              layout="inline"
              style={{ margin: "16px auto 0", maxWidth: 620 }}
            />
          ) : null}
          {error ? (
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

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { selectActiveProjectRoot, useAppStore } from "../../state/appStore";
import { useLaneMachineChoice } from "./useLaneMachineChoice";
import { requestCrossMachineLanesForMachine } from "../../state/crossMachineLanes";
import { CreateLaneDialog, type CreateLaneMode, type CreateLaneSetupStep } from "./CreateLaneDialog";
import { DEFAULT_LANE_START, plainLaneStartBranch, type LaneStart } from "../../../shared/laneStart";
import { startSourceBranch } from "./laneStartOptions";
import { getNewLaneDefaultsCached, saveNewLaneDefaults } from "../../lib/newLaneDefaultsCache";
import { linearIssueLaneName, resolveLinearIssueBranchName } from "../../../shared/linearIssueBranch";
import { dismissToast, showToast } from "../app/toast/toastStore";
import { openConnectionsPanel } from "../../lib/connectionsPanel";
import {
  canCreateLaneOnMachine,
  type LaneMachineOption,
} from "./laneMachines";
import type { LaneBranchOption } from "./laneUtils";
import type {
  BranchPullRequest,
  ChatLaunchLaneConfig,
  LaneEnvInitEvent,
  LaneEnvInitProgress,
  LaneLinearIssue,
  LaneSummary,
  LaneTemplate,
  NewLaneDefaultsSnapshot,
  OpenProjectBinding,
} from "../../../shared/types";
import { useLaneEmojiSuggestion } from "./useLaneEmojiSuggestion";

type CreateSetupPhase =
  | "creating"
  | "appearance"
  | "refreshing"
  | "environment";

export type CreateLaneBehavior = "stay-open-setup" | "close-on-create" | "configure-for-chat";

/**
 * The lane recipe a "configure-for-chat" dialog hands back. It is the launch's
 * own `ChatLaunchLaneConfig` plus the name, which travels separately on a
 * launch, so a new recipe field cannot be forgotten on one side. Nothing is
 * created here: the composer holds this and the new-lane launch applies it
 * when the chat is sent.
 */
export type NewLaneDraftConfig = ChatLaunchLaneConfig & {
  name: string;
};

export type CreateLanePrefill = {
  /** Pre-fill the lane name (e.g. dialog-bus `props.name`). */
  name?: string;
  /** Pre-connect a Linear issue. */
  linearIssue?: LaneLinearIssue | null;
};

/* ---------------------------------------------------------------------------
 * Detached background env setup (close-on-create mode).
 *
 * The Work-tab pane that opens the dialog can unmount the moment the lane is
 * created, so env setup must not be tied to any component lifetime. These
 * module-level helpers run the setup and surface a sticky, retryable failure
 * toast entirely outside React.
 * ------------------------------------------------------------------------- */

type DetachedSetupParams = {
  laneId: string;
  laneName: string;
  templateId: string;
  projectRoot: string | null;
  /** The lane's machine when it is not the tab's; setup runs there. */
  pin: OpenProjectBinding | null;
};

/**
 * The trailing pin argument for a preload call: none for the tab's machine, so
 * an unpinned call keeps exactly its pre-pin shape.
 */
function pinArg(pin: OpenProjectBinding | null): [] | [OpenProjectBinding] {
  return pin ? [pin] : [];
}

async function applyLaneEnvSetup(
  laneId: string,
  templateId: string,
  pin: OpenProjectBinding | null,
): Promise<LaneEnvInitProgress> {
  return templateId
    ? await window.ade.lanes.applyTemplate({ laneId, templateId }, ...pinArg(pin))
    : await window.ade.lanes.initEnv({ laneId }, ...pinArg(pin));
}

function normalizedProjectRoot(root: string | null | undefined): string | null {
  return root?.trim() || null;
}

function getActiveProjectRoot(): string | null {
  return selectActiveProjectRoot(useAppStore.getState());
}

function isDetachedSetupProjectActive(params: DetachedSetupParams): boolean {
  return normalizedProjectRoot(getActiveProjectRoot()) === normalizedProjectRoot(params.projectRoot);
}

function setupFailureToastId(laneId: string): string {
  return `lane-setup-failed:${laneId}`;
}

function showSetupFailureToast(params: DetachedSetupParams, detail?: string): void {
  showToast({
    // Keyed by lane so a retry replaces the existing toast in place.
    id: setupFailureToastId(params.laneId),
    title: params.laneName,
    message: detail ?? "Environment setup failed. Retry to finish setting up this lane.",
    tone: "error",
    durationMs: 0,
    actions: [{
      label: "Retry",
      onClick: () => runDetachedLaneSetup(params),
    }],
  });
}

/** Run env setup for an already-created lane, detached from any component. */
function runDetachedLaneSetup(params: DetachedSetupParams): void {
  void (async () => {
    try {
      if (!isDetachedSetupProjectActive(params)) {
        showSetupFailureToast(params, "Open the original project to retry this lane setup.");
        return;
      }
      const progress = await applyLaneEnvSetup(params.laneId, params.templateId, params.pin);
      if (progress.overallStatus === "failed") {
        showSetupFailureToast(params, "Environment setup failed. Retry to finish setting up this lane.");
      } else {
        // A successful retry must clear the sticky failure toast; on the first
        // run this is a no-op.
        dismissToast(setupFailureToastId(params.laneId));
      }
    } catch (err) {
      showSetupFailureToast(params, err instanceof Error ? err.message : String(err));
    }
  })();
}

/**
 * Self-contained host for {@link CreateLaneDialog}: owns all of the create-lane
 * form state, base-branch loading, submit + env-setup orchestration, and the
 * two post-create behaviors.
 *
 * - `stay-open-setup` (Lanes tab): keeps today's flow. After the lane record
 *   is created it navigates (via `onCreated`) and keeps the dialog open to
 *   stream env-setup progress, with in-dialog error + "Retry setup".
 * - `close-on-create` (Work tab): closes the dialog as soon as the lane record
 *   exists and runs env setup in the background; a failure surfaces a sticky,
 *   retryable toast instead of in-dialog UI.
 *
 * Memoized: the chat pane mounts a closed host and re-renders on every streamed
 * event; with stable props a closed dialog must not re-render its whole form.
 */
export const CreateLaneDialogHost = memo(function CreateLaneDialogHost({
  open,
  onOpenChange,
  behavior,
  prefill,
  onCreated,
  onConfigured,
  onBusyChange,
  onNavigateToTemplates,
  onOpenLinearSettings,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  behavior: CreateLaneBehavior;
  prefill?: CreateLanePrefill | null;
  /**
   * Called after the lane record is created + refreshed (before env setup).
   * `machine` names the machine the lane was created on when it is not the
   * tab's (`pin` set); `lane.id` is only meaningful on that machine.
   */
  onCreated?: (lane: LaneSummary, machine?: { machineId: string; pin: OpenProjectBinding | null }) => void;
  /** "configure-for-chat" only: the validated recipe, with no lane created. */
  onConfigured?: (config: NewLaneDraftConfig) => void;
  /** Mirrors the in-flight create/setup state so callers can guard forced closes. */
  onBusyChange?: (busy: boolean) => void;
  onNavigateToTemplates?: () => void;
  onOpenLinearSettings?: () => void;
}) {
  const boundLanes = useAppStore((s) => s.lanes);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const activeProjectRoot = useAppStore(selectActiveProjectRoot);

  const [createLaneName, setCreateLaneName] = useState("");
  const [createMode, setCreateMode] = useState<CreateLaneMode>("new");
  // Starts as the project's saved default; a pick here is for this lane only.
  const [createStart, setCreateStartState] = useState<LaneStart>(DEFAULT_LANE_START);
  const createStartUserPickedRef = useRef(false);
  const [newLaneDefaults, setNewLaneDefaults] = useState<NewLaneDefaultsSnapshot | null>(null);
  const createBaseBranchesLoadSeqRef = useRef(0);
  const [createImportBranch, setCreateImportBranch] = useState("");
  const [createBranches, setCreateBranches] = useState<LaneBranchOption[]>([]);
  const [createBranchesLoading, setCreateBranchesLoading] = useState(false);
  const [createBranchPullRequests, setCreateBranchPullRequests] = useState<BranchPullRequest[]>([]);
  const [createGitUserName, setCreateGitUserName] = useState<string>("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createEnvInitProgress, setCreateEnvInitProgress] = useState<LaneEnvInitProgress | null>(null);
  const [laneCreated, setLaneCreated] = useState(false);
  const [createSetupPhase, setCreateSetupPhase] = useState<CreateSetupPhase | null>(null);
  const createEnvInitLaneIdRef = useRef<string | null>(null);
  /** Machine the created lane lives on; env setup and retries go there. */
  const createdLaneMachineRef = useRef<{ machineId: string; pin: OpenProjectBinding | null } | null>(null);
  /** The create in flight, so Cancel can stop its git checkout on the lane's machine. */
  const createOperationRef = useRef<{ operationId: string; pin: OpenProjectBinding | null } | null>(null);
  const [createCancelRequested, setCreateCancelRequested] = useState(false);
  const [templates, setTemplates] = useState<LaneTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [createSelectedColor, setCreateSelectedColor] = useState<string | null>(null);
  const [createSelectedLinearIssue, setCreateSelectedLinearIssue] = useState<LaneLinearIssue | null>(null);
  const createLinearIssueAutoNameRef = useRef<string | null>(null);

  /* -------------------------------------------------------------------------
   * Machine selection.
   *
   * A lane owns its machine (`worktree_path` is absolute on exactly one), so
   * this dialog always asks where the lane goes. There is no silent default:
   * the dialog cannot submit until a machine is picked, except when exactly one
   * machine can hold the lane, which is then shown pre-selected. Picking a
   * machine never rebinds the project tab; the create call (and every read the
   * form makes: branches, templates, lanes) is pinned to that machine.
   *
   * The list is a pure derivation over the remote-runtime connection snapshot:
   * one read + one subscription to an existing broadcast, both scoped to while
   * the dialog is open. No polling, no per-machine probing.
   * ---------------------------------------------------------------------- */
  const {
    machines,
    machineTargets,
    selectedMachineId,
    selectedTarget,
    targetPin,
    targetPinKey,
    targetPinRef,
    setPickedMachineId,
  } = useLaneMachineChoice(open);

  const {
    selectedEmoji: createSelectedEmoji,
    suggestedEmoji,
    pick: handleSetCreateEmoji,
    accept: handleAcceptSuggestedEmoji,
    reset: resetLaneEmoji,
    nameChanged: laneNameChangedEmoji,
  } = useLaneEmojiSuggestion({
    name: createLaneName,
    enabled: open && behavior !== "configure-for-chat" && !createBusy && !laneCreated,
    pin: targetPin,
    pinKey: targetPinKey,
  });

  /**
   * The chosen machine's own lane list (parents, colors, its Primary for
   * branch listing). Read once per machine pick, seeded from the union so the
   * form fills in immediately. Never the tab's lanes for another machine: a
   * lane id can exist on both.
   */
  const [pinnedLanes, setPinnedLanes] = useState<{ key: string; lanes: LaneSummary[] } | null>(null);
  useEffect(() => {
    if (!open || !targetPin) return;
    let cancelled = false;
    const pin = targetPin;
    void window.ade.lanes.list({ includeStatus: true }, pin)
      .then((next) => {
        if (!cancelled) setPinnedLanes({ key: pin.key, lanes: Array.isArray(next) ? next : [] });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // `targetPinKey` carries the pin's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, targetPinKey]);
  const lanes = useMemo<LaneSummary[]>(() => {
    if (!targetPin) return boundLanes;
    if (pinnedLanes?.key === targetPin.key) return pinnedLanes.lanes;
    return selectedTarget?.lanes ?? [];
  }, [boundLanes, pinnedLanes, selectedTarget, targetPin]);
  const primaryLane = useMemo(() => lanes.find((l) => l.laneType === "primary") ?? null, [lanes]);

  // Mirror busy so callers can block a forced close mid-create (parity with the
  // old `handleCreateDialogOpenChange` guard).
  const busyRef = useRef(false);
  useEffect(() => {
    busyRef.current = createBusy;
    onBusyChange?.(createBusy);
  }, [createBusy, onBusyChange]);

  // Env-init progress events for the lane currently being created. Only matters
  // while the dialog is open (stay-open mode); close-on-create runs setup
  // detached after the dialog is gone. Gated on `open` so a mounted-but-closed
  // host never touches the env-event bridge.
  useEffect(() => {
    if (!open) return;
    return window.ade.lanes.onEnvEvent((event: LaneEnvInitEvent) => {
      if (event.progress.laneId !== createEnvInitLaneIdRef.current) return;
      setCreateEnvInitProgress(event.progress);
    });
  }, [open]);

  const resetCreateDialogState = useCallback(() => {
    createEnvInitLaneIdRef.current = null;
    createdLaneMachineRef.current = null;
    createStartUserPickedRef.current = false;
    createBaseBranchesLoadSeqRef.current += 1;
    setLaneCreated(false);
    setCreateLaneName("");
    setCreateMode("new");
    setCreateStartState(DEFAULT_LANE_START);
    setNewLaneDefaults(null);
    setCreateImportBranch("");
    setCreateBusy(false);
    setCreateError(null);
    setCreateEnvInitProgress(null);
    setCreateSetupPhase(null);
    setSelectedTemplateId("");
    setCreateSelectedColor(null);
    resetLaneEmoji();
    setCreateSelectedLinearIssue(null);
    createLinearIssueAutoNameRef.current = null;
    setPickedMachineId("");
    setPinnedLanes(null);
  }, [resetLaneEmoji, setPickedMachineId]);

  const handleSetCreateLaneName = useCallback((value: string) => {
    setCreateLaneName(value);
    laneNameChangedEmoji();
  }, [laneNameChangedEmoji]);

  const handleSetCreateLinearIssue = useCallback((issue: LaneLinearIssue | null) => {
    setCreateSelectedLinearIssue(issue);
    if (!issue) return;

    const nextName = linearIssueLaneName(issue);
    laneNameChangedEmoji();
    setCreateLaneName((current) => {
      const trimmed = current.trim();
      const previousAutoName = createLinearIssueAutoNameRef.current;
      if (!trimmed || (previousAutoName && trimmed === previousAutoName)) {
        createLinearIssueAutoNameRef.current = nextName;
        return nextName;
      }
      createLinearIssueAutoNameRef.current = nextName;
      return current;
    });
    setCreateImportBranch("");
    setCreateMode("new");
  }, [laneNameChangedEmoji]);

  /**
   * Load what the form reads from the chosen machine: the project's new-lane
   * defaults there, its branches (via its Primary lane), git identity, and lane
   * templates. Re-run whenever the target machine changes; the name, color and
   * Linear issue are kept. No fetch: a lane that starts from pushed work
   * fetches when it is created.
   */
  const machineDataKeyRef = useRef<string | null>(null);
  const loadMachineData = useCallback((pin: OpenProjectBinding | null, primary: LaneSummary | null) => {
    machineDataKeyRef.current = `${pin?.key ?? "bound"}::${primary?.id ?? ""}`;
    createStartUserPickedRef.current = false;
    setCreateImportBranch("");
    setCreateBranches([]);
    setCreateBranchPullRequests([]);
    setCreateGitUserName("");
    setNewLaneDefaults(null);
    const loadSeq = ++createBaseBranchesLoadSeqRef.current;
    const current = () => createBaseBranchesLoadSeqRef.current === loadSeq;

    // Fresh on every open: another computer may have changed them. An older
    // brain without new-lane defaults answers null, and the form keeps the
    // built-in default (pushed work from the default branch).
    const defaultsRead = getNewLaneDefaultsCached({ projectRoot: getActiveProjectRoot(), pin, force: true });
    setCreateBranchesLoading(Boolean(primary));
    if (primary) {
      window.ade.git.listBranches({ laneId: primary.id }, ...pinArg(pin))
        .then((branches) => {
          if (current()) setCreateBranches(branches);
        })
        .catch(() => {})
        .finally(() => {
          if (current()) setCreateBranchesLoading(false);
        });

      // Capture git user.name so the picker can resolve `mine` / `author:me`.
      window.ade.git.getUserIdentity({ laneId: primary.id }, ...pinArg(pin))
        .then((identity) => {
          if (current()) setCreateGitUserName(identity?.name ?? "");
        })
        .catch(() => setCreateGitUserName(""));

      // Lazily attach open-PR metadata. Repo-wide (GitHub), so the tab's
      // machine answers it for every target. Fail-soft.
      window.ade.prs.listOpenForRepo()
        .then(setCreateBranchPullRequests)
        .catch(() => setCreateBranchPullRequests([]));
    }
    Promise.all([
      defaultsRead,
      window.ade.lanes.listTemplates(...pinArg(pin)).catch(() => [] as LaneTemplate[]),
    ]).then(([snapshot, nextTemplates]) => {
      if (!current()) return;
      setNewLaneDefaults(snapshot);
      if (snapshot && !createStartUserPickedRef.current) setCreateStartState(snapshot.defaults.start);
      setTemplates(nextTemplates);
      const defaultTemplateId = snapshot?.defaults.templateId ?? null;
      setSelectedTemplateId(
        defaultTemplateId && nextTemplates.some((template) => template.id === defaultTemplateId)
          ? defaultTemplateId
          : ""
      );
    });
  }, []);

  const handleSetCreateStart = useCallback((start: LaneStart) => {
    createStartUserPickedRef.current = true;
    setCreateStartState(start);
  }, []);

  // "Make default": the dialog's start becomes the project's, on the machine
  // the lane is being created on (the account setting is shared, but the
  // machine answers with its own branch names).
  const handleMakeStartDefault = useCallback(() => {
    const pin = targetPinRef.current;
    // Only the start: the brain keeps the rest (the default template).
    void saveNewLaneDefaults({
      projectRoot: getActiveProjectRoot(),
      pin,
      defaults: { start: createStart },
    })
      .then(setNewLaneDefaults)
      .catch((error: unknown) => setCreateError(error instanceof Error ? error.message : String(error)));
  }, [createStart, targetPinRef]);

  const prepareCreateDialog = useCallback((prefillInput?: CreateLanePrefill | null) => {
    setCreateLaneName("");
    setCreateMode("new");
    // The colour is not cleared here: closing already cleared it, and the
    // dialog's own effect picks a free one on open. Clearing it again here, in
    // the same commit as that pick, left every new lane with no colour.
    resetLaneEmoji();
    setCreateSelectedLinearIssue(null);
    createLinearIssueAutoNameRef.current = null;
    setCreateBusy(false);
    setCreateError(null);
    setCreateEnvInitProgress(null);
    setCreateSetupPhase(null);
    setLaneCreated(false);
    createEnvInitLaneIdRef.current = null;
    createdLaneMachineRef.current = null;
    setPickedMachineId("");
    // Form data starts on the tab's machine; picking another machine reloads it
    // from there (effect below).
    loadMachineData(null, boundLanes.find((l) => l.laneType === "primary") ?? null);

    // Apply caller prefill after resetting to defaults.
    if (prefillInput?.name) setCreateLaneName(prefillInput.name.trim());
    if (prefillInput?.linearIssue) handleSetCreateLinearIssue(prefillInput.linearIssue);
  }, [boundLanes, handleSetCreateLinearIssue, loadMachineData, resetLaneEmoji, setPickedMachineId]);

  // Prepare on open; reset on close. `open` is the single source of truth, so
  // any external trigger (deeplink, button, dialog bus, Work-tab pane) that sets
  // it to true runs prepare exactly once per open.
  const prevOpenRef = useRef(false);
  const prefillRef = useRef(prefill);
  prefillRef.current = prefill;
  useEffect(() => {
    if (open === prevOpenRef.current) return;
    prevOpenRef.current = open;
    if (open) {
      prepareCreateDialog(prefillRef.current);
    } else {
      resetCreateDialogState();
    }
  }, [open, prepareCreateDialog, resetCreateDialogState]);

  /** Picking a machine only chooses where the lane goes; nothing is rebound. */
  const handleSelectMachine = useCallback((machineId: string) => {
    if (createBusy || laneCreated || machineId === selectedMachineId) return;
    const machine = machines.find((candidate) => candidate.id === machineId);
    if (!machine || !canCreateLaneOnMachine(machine)) return;
    if (!machineTargets.has(machineId)) {
      setCreateError(`Open this repository on ${machine.name} first, then create the lane there.`);
      return;
    }
    setCreateError(null);
    setPickedMachineId(machineId);
  }, [createBusy, laneCreated, machineTargets, machines, selectedMachineId, setPickedMachineId]);

  // Reload the form's branches, templates and identity from the chosen
  // machine once its Primary lane is known. Keyed so a lane-list refresh of the
  // same machine does not reset what the user already picked.
  const targetPrimaryId = primaryLane?.id ?? null;
  useEffect(() => {
    if (!open || laneCreated || createBusy) return;
    const key = `${targetPinKey ?? "bound"}::${targetPrimaryId ?? ""}`;
    if (machineDataKeyRef.current === key) return;
    loadMachineData(targetPinRef.current, primaryLane);
    // `primaryLane` is read through its id; `targetPinKey` carries the pin.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, targetPinKey, targetPrimaryId]);

  const handleConnectMachine = useCallback(() => {
    if (createBusy || laneCreated) return;
    onOpenChange(false);
    openConnectionsPanel("machines");
  }, [createBusy, laneCreated, onOpenChange]);

  const createSetupStatus = useMemo(() => {
    switch (createSetupPhase) {
      case "creating":
        return createMode === "existing"
          ? "Opening the branch in a new lane..."
          : createStart.bring === "pushed"
            ? "Fetching, then creating the lane's branch..."
            : "Creating the lane's branch...";
      case "appearance":
        return "Saving lane appearance...";
      case "refreshing":
        return "Refreshing the lane list...";
      case "environment":
        return selectedTemplateId ? "Applying the lane template..." : "Running lane environment setup...";
      default:
        return laneCreated ? "Lane exists. Finish setup or retry the failed step." : null;
    }
  }, [createMode, createSetupPhase, createStart.bring, laneCreated, selectedTemplateId]);

  const createSetupSteps = useMemo<CreateLaneSetupStep[]>(() => {
    if (!createBusy && !laneCreated) return [];
    const laneLabel = createMode === "existing" ? "Open the branch in a new lane" : "Create the lane's branch";
    let laneState: CreateLaneSetupStep["state"];
    if (createSetupPhase === "creating") laneState = "active";
    else if (laneCreated) laneState = "done";
    else laneState = "pending";
    const steps: CreateLaneSetupStep[] = [{
      label: laneLabel,
      detail: createMode === "new" && createStart.bring === "pushed"
        ? "Fetch, then check out the branch in its own folder."
        : "Check out the branch in its own folder.",
      state: laneState,
    }];
    steps.push({
      label: selectedTemplateId ? "Apply template" : "Initialize environment",
      detail: selectedTemplateId
        ? "Run the selected lane template setup."
        : "Run the default lane setup checks.",
      state: createSetupPhase === "environment" ? "active" : "pending",
    });
    return steps;
  }, [createBusy, createMode, createSetupPhase, createStart.bring, laneCreated, selectedTemplateId]);

  /** Run post-create setup for a lane that already exists. Used as the retry path
   *  when environment setup fails (stay-open mode). */
  const runSetupForCreatedLane = useCallback(async (laneId: string) => {
    setCreateBusy(true);
    setCreateError(null);
    setCreateEnvInitProgress(null);
    setCreateSetupPhase("environment");

    // Setup runs on the machine the lane was created on, not the current pick.
    const pin = createdLaneMachineRef.current?.pin ?? null;
    try {
      const envProgress = selectedTemplateId
        ? await window.ade.lanes.applyTemplate({ laneId, templateId: selectedTemplateId }, ...pinArg(pin))
        : await window.ade.lanes.initEnv({ laneId }, ...pinArg(pin));
      setCreateEnvInitProgress(envProgress);

      if (envProgress.overallStatus === "failed") {
        setCreateError("Environment setup failed. Review the progress log and retry.");
        return;
      }

      resetCreateDialogState();
      onOpenChange(false);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreateSetupPhase(null);
      setCreateBusy(false);
    }
  }, [selectedTemplateId, resetCreateDialogState, onOpenChange]);

  /**
   * The two form errors the submit button cannot express (everything else is in
   * `isSubmitDisabled`): a template that has since been deleted, and a Linear
   * issue attached to an import. Shared by the real create and configure-for-chat
   * so the two cannot diverge again.
   */
  const validateLaneFormExtras = useCallback((): string | null => {
    if (createSelectedLinearIssue && createMode === "existing") {
      return "Detach the Linear issue before using an existing branch.";
    }
    if (selectedTemplateId && !templates.some((template) => template.id === selectedTemplateId)) {
      return "The selected lane template no longer exists. Refresh templates or choose a different option.";
    }
    return null;
  }, [createMode, createSelectedLinearIssue, selectedTemplateId, templates]);

  const handleCreateSubmit = useCallback(async () => {
    // Configure-for-chat: validate like a create, then hand the recipe back
    // instead of creating. The composer owns the deferred creation.
    if (behavior === "configure-for-chat") {
      const error = validateLaneFormExtras();
      if (error) {
        setCreateError(error);
        return;
      }
      setCreateError(null);
      onConfigured?.({
        mode: createMode,
        name: createLaneName.trim(),
        start: createMode === "new" ? createStart : null,
        branchRef: createMode === "existing" ? createImportBranch : "",
        templateId: selectedTemplateId || null,
        color: createSelectedColor,
        linearIssue: createSelectedLinearIssue,
      });
      resetCreateDialogState();
      onOpenChange(false);
      return;
    }

    // If the lane was already created (e.g. env setup failed on a previous
    // attempt), retry setup only; never re-run creation.
    if (createEnvInitLaneIdRef.current) {
      await runSetupForCreatedLane(createEnvInitLaneIdRef.current);
      return;
    }

    const name = createLaneName.trim();
    if (!name || createBusy) return;
    // Always asks: never create on a machine nobody chose.
    const machineId = selectedMachineId;
    if (!machineId || !machineTargets.has(machineId)) {
      setCreateError("Choose the machine this lane will live on.");
      return;
    }
    const pin = machineTargets.get(machineId)?.pin ?? null;
    // A named branch must be picked. Default and Primary are the brain's to
    // resolve, so a failed defaults read does not block them.
    const startBranchMissing = createStart.from === "branch"
      ? !plainLaneStartBranch(createStart.branch)
      : newLaneDefaults !== null && !startSourceBranch(createStart, newLaneDefaults);
    if (createMode === "new" && startBranchMissing) {
      setCreateError("Choose the branch this lane starts from.");
      return;
    }
    if (createMode === "existing" && !createImportBranch) return;
    const extrasError = validateLaneFormExtras();
    if (extrasError) {
      setCreateError(extrasError);
      return;
    }

    setCreateBusy(true);
    setCreateError(null);
    setCreateEnvInitProgress(null);
    setCreateSetupPhase("creating");
    const operationId = crypto.randomUUID();
    createOperationRef.current = { operationId, pin };
    setCreateCancelRequested(false);

    try {
      const linearIssueArgs = createSelectedLinearIssue
        ? {
          linearIssue: {
            ...createSelectedLinearIssue,
            branchName: resolveLinearIssueBranchName(createSelectedLinearIssue),
          },
          branchName: resolveLinearIssueBranchName(createSelectedLinearIssue),
        }
        : {};
      let lane: LaneSummary;
      if (createMode === "existing") {
        lane = await window.ade.lanes.importBranch({ branchRef: createImportBranch, name, operationId }, ...pinArg(pin));
      } else {
        lane = await window.ade.lanes.create({ name, start: createStart, ...linearIssueArgs, operationId }, ...pinArg(pin));
      }
      createOperationRef.current = null;
      // A fallback the brain had to take (a failed fetch, a copy that did not
      // apply) is worth a word; the lane itself is fine.
      const notes = lane.createdFrom?.notes ?? [];
      if (notes.length > 0) {
        showToast({ title: `${lane.name} was created`, message: notes.join(" "), tone: "warning" });
      }

      // Lane created successfully: record its id (and machine) so retries skip
      // creation and run setup on the same machine.
      createEnvInitLaneIdRef.current = lane.id;
      createdLaneMachineRef.current = { machineId, pin };
      setLaneCreated(true);

      if (createSelectedColor || createSelectedEmoji) {
        try {
          setCreateSetupPhase("appearance");
          await window.ade.lanes.updateAppearance({
            laneId: lane.id,
            ...(createSelectedColor ? { color: createSelectedColor } : {}),
            ...(createSelectedEmoji ? { emoji: createSelectedEmoji } : {}),
          }, ...pinArg(pin));
        } catch {
          // Appearance is optional and must not block lane creation.
        }
      }

      setCreateSetupPhase("refreshing");
      if (pin) {
        // Another machine has no change feed here; the shared union re-reads it.
        requestCrossMachineLanesForMachine(machineId);
      } else {
        await refreshLanes();
      }
      onCreated?.(lane, { machineId, pin });

      if (behavior === "close-on-create") {
        // Detach env setup from this component's lifetime; the opening pane may
        // unmount as soon as the lane exists. Capture everything the background
        // runner needs before we reset/close.
        const detachParams: DetachedSetupParams = {
          laneId: lane.id,
          laneName: lane.name,
          templateId: selectedTemplateId,
          projectRoot: activeProjectRoot,
          pin,
        };
        resetCreateDialogState();
        onOpenChange(false);
        runDetachedLaneSetup(detachParams);
        return;
      }

      // stay-open-setup: keep the dialog open and stream env-setup progress.
      await runSetupForCreatedLane(lane.id);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
      setCreateSetupPhase(null);
      setCreateBusy(false);
    } finally {
      createOperationRef.current = null;
      setCreateCancelRequested(false);
    }
  }, [
    behavior,
    createLaneName,
    createMode,
    createStart,
    newLaneDefaults,
    createImportBranch,
    createBusy,
    refreshLanes,
    onCreated,
    onConfigured,
    resetCreateDialogState,
    onOpenChange,
    runSetupForCreatedLane,
    selectedTemplateId,
    createSelectedColor,
    createSelectedEmoji,
    createSelectedLinearIssue,
    activeProjectRoot,
    validateLaneFormExtras,
    selectedMachineId,
    machineTargets,
  ]);

  // Stops the git checkout of the create in flight. A create that has not
  // reached git yet, or is past it, cannot stop; the button then comes back.
  const handleCancelCreate = useCallback(() => {
    const operation = createOperationRef.current;
    if (!operation) return;
    setCreateCancelRequested(true);
    void window.ade.lanes.cancelGitWrite({ operationId: operation.operationId }, ...pinArg(operation.pin))
      .then((result) => {
        if (!result?.cancelled) setCreateCancelRequested(false);
      })
      .catch(() => setCreateCancelRequested(false));
  }, []);

  const handleDialogOpenChange = useCallback((next: boolean) => {
    // Never dismiss the dialog while a create/setup is in flight.
    if (!next && busyRef.current) return;
    onOpenChange(next);
  }, [onOpenChange]);

  // Configuring a draft creates nothing and owns no machine; the two behaviors
  // differ in one bundle of props, kept here instead of nine ternaries inline.
  const configureForChat = behavior === "configure-for-chat";
  const behaviorChrome: {
    envInitProgress: LaneEnvInitProgress | null;
    laneCreated: boolean;
    setupStatus: string | null;
    setupSteps: CreateLaneSetupStep[];
    submitLabelOverride: string | null;
    machines: LaneMachineOption[];
    onSelectMachine: ((machineId: string) => void) | undefined;
    onConnectMachine: (() => void) | undefined;
  } = configureForChat
    ? {
        envInitProgress: null,
        laneCreated: false,
        setupStatus: null,
        setupSteps: [],
        submitLabelOverride: "Use this setup",
        machines: [],
        onSelectMachine: undefined,
        onConnectMachine: undefined,
      }
    : {
        envInitProgress: createEnvInitProgress,
        laneCreated,
        setupStatus: createSetupStatus,
        setupSteps: createSetupSteps,
        submitLabelOverride: null,
        machines,
        onSelectMachine: handleSelectMachine,
        onConnectMachine: handleConnectMachine,
      };

  return (
    <CreateLaneDialog
      open={open}
      onOpenChange={handleDialogOpenChange}
      createLaneName={createLaneName}
      setCreateLaneName={handleSetCreateLaneName}
      createMode={createMode}
      setCreateMode={setCreateMode}
      createStart={createStart}
      setCreateStart={handleSetCreateStart}
      newLaneDefaults={newLaneDefaults}
      onMakeStartDefault={handleMakeStartDefault}
      createImportBranch={createImportBranch}
      setCreateImportBranch={setCreateImportBranch}
      projectRoot={activeProjectRoot}
      createBranches={createBranches}
      lanes={lanes}
      onSubmit={handleCreateSubmit}
      machineRequired={!configureForChat}
      busy={createBusy}
      onCancelBusy={createSetupPhase === "creating" && !createCancelRequested ? handleCancelCreate : undefined}
      error={createError}
      {...behaviorChrome}
      templates={templates}
      selectedTemplateId={selectedTemplateId}
      setSelectedTemplateId={setSelectedTemplateId}
      selectedColor={createSelectedColor}
      setSelectedColor={setCreateSelectedColor}
      selectedEmoji={createSelectedEmoji}
      setSelectedEmoji={handleSetCreateEmoji}
      suggestedEmoji={suggestedEmoji}
      onAcceptSuggestedEmoji={handleAcceptSuggestedEmoji}
      showEmojiControl={!configureForChat}
      selectedLinearIssue={createSelectedLinearIssue}
      setSelectedLinearIssue={handleSetCreateLinearIssue}
      branchPullRequests={createBranchPullRequests}
      currentGitUserName={createGitUserName}
      loadingBranches={createBranchesLoading}
      onOpenLinearSettings={onOpenLinearSettings}
      onNavigateToTemplates={onNavigateToTemplates}
      selectedMachineId={selectedMachineId}
    />
  );
});

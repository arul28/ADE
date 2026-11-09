import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { selectActiveProjectRoot, useAppStore } from "../../state/appStore";
import { useLaneMachineChoice } from "./useLaneMachineChoice";
import { requestCrossMachineLanesForMachine } from "../../state/crossMachineLanes";
import { CreateLaneDialog, type CreateLaneMode } from "./CreateLaneDialog";
import { DEFAULT_LANE_START, plainLaneStartBranch, type LaneStart } from "../../../shared/laneStart";
import { startSourceBranch } from "./laneStartOptions";
import { loadLaneStartMenuData } from "./useLaneStartMenuData";
import { getNewLaneDefaultsCached, saveNewLaneDefaults } from "../../lib/newLaneDefaultsCache";
import { linearIssueLaneName, resolveLinearIssueBranchName } from "../../../shared/linearIssueBranch";
import { branchNameProblem, renderLaneBranchName, renderLaneBranchPrefix } from "../../../shared/laneBranchName";
import { dismissToast, showToast } from "../app/toast/toastStore";
import { openConnectionsPanel } from "../../lib/connectionsPanel";
import {
  allowPendingLaneCreateStop,
  beginPendingLaneCreate,
  endPendingLaneCreate,
  markPendingLaneCreateSetup,
} from "../../lib/pendingLaneCreates";
import {
  canCreateLaneOnMachine,
  type LaneMachineOption,
} from "./laneMachines";
import type { LaneBranchOption } from "./laneUtils";
import type {
  BranchPullRequest,
  ChatLaunchLaneConfig,
  CreateLaneArgs,
  LaneEnvInitProgress,
  LaneLinearIssue,
  LaneSummary,
  LaneTemplate,
  NewLaneDefaultsSnapshot,
  OpenProjectBinding,
} from "../../../shared/types";
import { useLaneEmojiSuggestion } from "./useLaneEmojiSuggestion";

export type CreateLaneBehavior = "create" | "configure-for-chat";

/** Where a created lane lives when that is not the tab's machine (`pin` set). */
export type CreatedLaneMachine = { machineId: string; pin: OpenProjectBinding | null };

/** Told once the lane exists and the lane list has it, before its setup runs. */
export type LaneCreatedHandler = (lane: LaneSummary, machine: CreatedLaneMachine) => void;

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
 * Background create and setup.
 *
 * The dialog closes when the user submits, and the page that held it can be
 * gone a moment later, so nothing here is tied to a component. These
 * module-level helpers create the lane, run its setup, keep the lane lists'
 * "Creating…" row current (`pendingLaneCreates`), and report a failure in a
 * sticky toast that can retry.
 * ------------------------------------------------------------------------- */

type DetachedSetupParams = {
  laneId: string;
  laneName: string;
  templateId: string;
  projectRoot: string | null;
  machineId: string;
  /** The lane's machine when it is not the tab's; setup runs there. */
  pin: OpenProjectBinding | null;
};

type DetachedCreateParams = {
  name: string;
  /** New branch: the create args. Existing branch: the branch to open. */
  request: { mode: "new"; args: CreateLaneArgs } | { mode: "existing"; branchRef: string };
  color: string | null;
  emoji: string | null;
  templateId: string;
  projectRoot: string | null;
  machineId: string;
  /** The lane's machine when it is not the tab's; every call goes there. */
  pin: OpenProjectBinding | null;
  onCreated?: LaneCreatedHandler;
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

function isProjectActive(projectRoot: string | null): boolean {
  return normalizedProjectRoot(getActiveProjectRoot()) === normalizedProjectRoot(projectRoot);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function setupFailureToastId(laneId: string): string {
  return `lane-setup-failed:${laneId}`;
}

/** The step that failed and why; the dialog that used to list the steps is closed. */
function setupFailureDetail(progress: LaneEnvInitProgress): string {
  const failed = progress.steps.find((step) => step.status === "failed");
  if (!failed) return "Environment setup failed. Retry to finish setting up this lane.";
  return `${failed.label} failed${failed.error ? `: ${failed.error}` : "."} Retry to finish setting up this lane.`;
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
      onClick: () => {
        const pendingId = beginPendingLaneCreate({
          name: params.laneName,
          projectRoot: params.projectRoot,
          machineId: params.pin ? params.machineId : null,
        });
        markPendingLaneCreateSetup(pendingId, params.laneId);
        void runLaneSetup(params).finally(() => endPendingLaneCreate(pendingId));
      },
    }],
  });
}

/** Run env setup for a lane that exists. A failure leaves a toast that can retry. */
async function runLaneSetup(params: DetachedSetupParams): Promise<void> {
  try {
    if (!isProjectActive(params.projectRoot)) {
      showSetupFailureToast(params, "Open the original project to retry this lane setup.");
      return;
    }
    const progress = await applyLaneEnvSetup(params.laneId, params.templateId, params.pin);
    if (progress.overallStatus === "failed") {
      showSetupFailureToast(params, setupFailureDetail(progress));
    } else {
      // A successful retry must clear the sticky failure toast; on the first
      // run this is a no-op.
      dismissToast(setupFailureToastId(params.laneId));
    }
  } catch (err) {
    showSetupFailureToast(params, errorMessage(err));
  }
}

function showCreateFailureToast(params: DetachedCreateParams, detail: string): void {
  showToast({
    title: `Could not create ${params.name}`,
    message: detail,
    tone: "error",
    durationMs: 0,
    actions: [{
      label: "Try again",
      onClick: () => {
        if (!isProjectActive(params.projectRoot)) {
          showCreateFailureToast(params, "Open the original project to create this lane.");
          return;
        }
        runDetachedLaneCreate(params);
      },
    }],
  });
}

/**
 * Create a lane and set it up, detached from any component.
 *
 * Every call goes to `params.pin`, the machine the user chose, for the whole
 * flow: the create, its Stop, the appearance, and the setup.
 */
function runDetachedLaneCreate(params: DetachedCreateParams): void {
  const { pin, machineId } = params;
  const operationId = crypto.randomUUID();
  let stopRequested = false;
  const pendingId = beginPendingLaneCreate({
    name: params.name,
    projectRoot: params.projectRoot,
    machineId: pin ? machineId : null,
    // Stops the git checkout of the create. A create that has not reached git
    // yet, or is past it, cannot stop; the button then comes back.
    stop: () => {
      stopRequested = true;
      const refused = () => {
        stopRequested = false;
        allowPendingLaneCreateStop(pendingId);
      };
      void window.ade.lanes.cancelGitWrite({ operationId }, ...pinArg(pin))
        .then((result) => {
          if (!result?.cancelled) refused();
        })
        .catch(refused);
    },
  });

  void (async () => {
    try {
      let lane: LaneSummary;
      try {
        lane = params.request.mode === "existing"
          ? await window.ade.lanes.importBranch(
            { branchRef: params.request.branchRef, name: params.name, operationId },
            ...pinArg(pin),
          )
          : await window.ade.lanes.create({ ...params.request.args, operationId }, ...pinArg(pin));
      } catch (err) {
        // A create the user stopped is not a failure to report.
        if (!stopRequested) showCreateFailureToast(params, errorMessage(err));
        return;
      }
      markPendingLaneCreateSetup(pendingId, lane.id);
      // A fallback the brain had to take (a failed fetch, a copy that did not
      // apply) is worth a word; the lane itself is fine.
      const notes = lane.createdFrom?.notes ?? [];
      if (notes.length > 0) {
        showToast({ title: `${lane.name} was created`, message: notes.join(" "), tone: "warning" });
      }

      if (params.color || params.emoji) {
        try {
          await window.ade.lanes.updateAppearance({
            laneId: lane.id,
            ...(params.color ? { color: params.color } : {}),
            ...(params.emoji ? { emoji: params.emoji } : {}),
          }, ...pinArg(pin));
        } catch {
          // Appearance is optional and must not block lane creation.
        }
      }

      if (pin) {
        // Another machine has no change feed here; the shared union re-reads it.
        requestCrossMachineLanesForMachine(machineId);
      } else if (isProjectActive(params.projectRoot)) {
        // The lane is made either way; a failed re-read must not stop its setup.
        await useAppStore.getState().refreshLanes().catch(() => undefined);
      }
      if (isProjectActive(params.projectRoot)) params.onCreated?.(lane, { machineId, pin });

      await runLaneSetup({
        laneId: lane.id,
        laneName: lane.name,
        templateId: params.templateId,
        projectRoot: params.projectRoot,
        machineId,
        pin,
      });
    } finally {
      endPendingLaneCreate(pendingId);
    }
  })();
}

/**
 * Self-contained host for {@link CreateLaneDialog}: owns the create-lane form
 * state, base-branch loading, and the submit.
 *
 * - `create`: checks the form, closes the dialog, and creates the lane in the
 *   background (`runDetachedLaneCreate`). The lane lists show the progress, so
 *   the user is free to leave the page.
 * - `configure-for-chat`: creates nothing; hands the checked recipe back.
 *
 * Memoized: the chat pane mounts a closed host and re-renders on every streamed
 * event; with stable props a closed dialog must not re-render its whole form.
 */
export const CreateLaneDialogHost = memo(function CreateLaneDialogHost({
  open,
  onOpenChange,
  behavior,
  prefill,
  onCreateStarted,
  onConfigured,
  onNavigateToTemplates,
  onOpenLinearSettings,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  behavior: CreateLaneBehavior;
  prefill?: CreateLanePrefill | null;
  /**
   * Called when a create starts. The handler it returns is called once the
   * lane exists and the lane list has it, which can be long after this host
   * is gone; it must decide for itself whether the user is still there.
   */
  onCreateStarted?: () => LaneCreatedHandler | void;
  /** "configure-for-chat" only: the validated recipe, with no lane created. */
  onConfigured?: (config: NewLaneDraftConfig) => void;
  onNavigateToTemplates?: () => void;
  onOpenLinearSettings?: () => void;
}) {
  const boundLanes = useAppStore((s) => s.lanes);
  const activeProjectRoot = useAppStore(selectActiveProjectRoot);

  const [createLaneName, setCreateLaneName] = useState("");
  // The branch follows the lane name (or the Linear issue) until the user
  // types one; null while it follows.
  const [editedBranchName, setEditedBranchName] = useState<string | null>(null);
  const [createBranchProblem, setCreateBranchProblem] = useState<string | null>(null);
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
  const [createError, setCreateError] = useState<string | null>(null);
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
    enabled: open && behavior !== "configure-for-chat",
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

  const resetCreateDialogState = useCallback(() => {
    createStartUserPickedRef.current = false;
    createBaseBranchesLoadSeqRef.current += 1;
    setCreateLaneName("");
    setEditedBranchName(null);
    setCreateBranchProblem(null);
    setCreateMode("new");
    setCreateStartState(DEFAULT_LANE_START);
    setNewLaneDefaults(null);
    setCreateImportBranch("");
    setCreateError(null);
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

  // What the branch is called while it follows: an issue keeps its own branch
  // name; otherwise the project's pattern, rendered on the lane's machine.
  const followedBranchName = useMemo(() => {
    if (createSelectedLinearIssue) return resolveLinearIssueBranchName(createSelectedLinearIssue);
    const name = createLaneName.trim();
    if (!name) return "";
    const prefix = newLaneDefaults?.branchPrefix
      ?? renderLaneBranchPrefix(newLaneDefaults?.defaults.branchPattern ?? "", newLaneDefaults?.branchUser ?? null);
    return renderLaneBranchName(prefix, name);
  }, [createLaneName, createSelectedLinearIssue, newLaneDefaults]);
  const createBranchName = editedBranchName ?? followedBranchName;
  const handleSetCreateBranchName = useCallback((value: string) => {
    // Cleared: follow the name again.
    setEditedBranchName(value.trim() ? value : null);
    setCreateBranchProblem(value.trim() ? branchNameProblem(value) : null);
  }, []);

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
   * Linear issue are kept. No fetch: a lane that starts on the remote
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
    // built-in default (the default branch on the remote).
    const defaultsRead = getNewLaneDefaultsCached({ projectRoot: getActiveProjectRoot(), pin, force: true });
    setCreateBranchesLoading(Boolean(primary));
    if (primary) {
      loadLaneStartMenuData(primary.id, pin, current, {
        setBranches: setCreateBranches,
        setBranchesLoading: setCreateBranchesLoading,
        setGitUserName: setCreateGitUserName,
        setPullRequests: setCreateBranchPullRequests,
      });
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
    setEditedBranchName(null);
    setCreateBranchProblem(null);
    setCreateMode("new");
    // The colour is not cleared here: closing already cleared it, and the
    // dialog's own effect picks a free one on open. Clearing it again here, in
    // the same commit as that pick, left every new lane with no colour.
    resetLaneEmoji();
    setCreateSelectedLinearIssue(null);
    createLinearIssueAutoNameRef.current = null;
    setCreateError(null);
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
    if (machineId === selectedMachineId) return;
    const machine = machines.find((candidate) => candidate.id === machineId);
    if (!machine || !canCreateLaneOnMachine(machine)) return;
    if (!machineTargets.has(machineId)) {
      setCreateError(`Open this repository on ${machine.name} first, then create the lane there.`);
      return;
    }
    setCreateError(null);
    setPickedMachineId(machineId);
  }, [machineTargets, machines, selectedMachineId, setPickedMachineId]);

  // Reload the form's branches, templates and identity from the chosen
  // machine once its Primary lane is known. Keyed so a lane-list refresh of the
  // same machine does not reset what the user already picked.
  const targetPrimaryId = primaryLane?.id ?? null;
  useEffect(() => {
    if (!open) return;
    const key = `${targetPinKey ?? "bound"}::${targetPrimaryId ?? ""}`;
    if (machineDataKeyRef.current === key) return;
    loadMachineData(targetPinRef.current, primaryLane);
    // `primaryLane` is read through its id; `targetPinKey` carries the pin.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, targetPinKey, targetPrimaryId]);

  const handleConnectMachine = useCallback(() => {
    onOpenChange(false);
    openConnectionsPanel("machines");
  }, [onOpenChange]);

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

  /** Asks the lane's machine; false (with the reason shown under the field) when the name is taken or invalid. */
  const branchNameIsFree = useCallback(async (branchName: string, pin: OpenProjectBinding | null): Promise<boolean> => {
    const local = branchNameProblem(branchName);
    if (local) {
      setCreateBranchProblem(local);
      return false;
    }
    try {
      const check = await window.ade.lanes.checkBranchName({ name: branchName }, ...pinArg(pin));
      setCreateBranchProblem(check.problem);
      return !check.problem;
    } catch (error) {
      // An older brain can't check (and a dropped connection can't either);
      // creating the lane still refuses a taken name.
      console.warn("create_lane.branch_name_check_failed", error);
      return true;
    }
  }, []);

  // Enter and the Create button can both fire while the branch-name check is
  // still out: one submit at a time.
  const submittingRef = useRef(false);
  const submitCreate = useCallback(async () => {
    // Configure-for-chat: validate like a create, then hand the recipe back
    // instead of creating. The composer owns the deferred creation.
    if (behavior === "configure-for-chat") {
      const error = validateLaneFormExtras();
      if (error) {
        setCreateError(error);
        return;
      }
      setCreateError(null);
      const typedBranch = createMode === "new" ? editedBranchName?.trim() ?? "" : "";
      if (typedBranch && !(await branchNameIsFree(typedBranch, targetPinRef.current))) return;
      onConfigured?.({
        mode: createMode,
        name: createLaneName.trim(),
        start: createMode === "new" ? createStart : null,
        branchRef: createMode === "existing" ? createImportBranch : "",
        ...(typedBranch ? { branchName: typedBranch } : {}),
        templateId: selectedTemplateId || null,
        color: createSelectedColor,
        linearIssue: createSelectedLinearIssue,
      });
      resetCreateDialogState();
      onOpenChange(false);
      return;
    }

    const name = createLaneName.trim();
    if (!name) return;
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
    // A typed branch name is checked where the lane will live; a followed one
    // is the brain's to make unique.
    const typedBranch = createMode === "new" ? editedBranchName?.trim() ?? "" : "";
    if (typedBranch && !(await branchNameIsFree(typedBranch, pin))) return;

    const issueBranchName = createSelectedLinearIssue
      ? resolveLinearIssueBranchName(createSelectedLinearIssue)
      : null;
    // The form is checked: the rest runs in the background. Everything it
    // needs is captured here, before the reset clears the form.
    const params: DetachedCreateParams = {
      name,
      request: createMode === "existing"
        ? { mode: "existing", branchRef: createImportBranch }
        : {
          mode: "new",
          args: {
            name,
            start: createStart,
            ...(createSelectedLinearIssue && issueBranchName
              ? {
                linearIssue: { ...createSelectedLinearIssue, branchName: issueBranchName },
                branchName: issueBranchName,
              }
              : {}),
            ...(typedBranch ? { branchName: typedBranch } : {}),
          },
        },
      color: createSelectedColor,
      emoji: createSelectedEmoji,
      templateId: selectedTemplateId,
      projectRoot: activeProjectRoot,
      machineId,
      pin,
      onCreated: onCreateStarted?.() ?? undefined,
    };
    resetCreateDialogState();
    onOpenChange(false);
    runDetachedLaneCreate(params);
  }, [
    behavior,
    createLaneName,
    editedBranchName,
    branchNameIsFree,
    targetPinRef,
    createMode,
    createStart,
    newLaneDefaults,
    createImportBranch,
    onCreateStarted,
    onConfigured,
    resetCreateDialogState,
    onOpenChange,
    selectedTemplateId,
    createSelectedColor,
    createSelectedEmoji,
    createSelectedLinearIssue,
    activeProjectRoot,
    validateLaneFormExtras,
    selectedMachineId,
    machineTargets,
  ]);
  const handleCreateSubmit = useCallback(async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    try {
      await submitCreate();
    } finally {
      submittingRef.current = false;
    }
  }, [submitCreate]);

  // Configuring a draft creates nothing and owns no machine; the two behaviors
  // differ in one bundle of props, kept here instead of nine ternaries inline.
  const configureForChat = behavior === "configure-for-chat";
  const behaviorChrome: {
    submitLabelOverride: string | null;
    machines: LaneMachineOption[];
    onSelectMachine: ((machineId: string) => void) | undefined;
    onConnectMachine: (() => void) | undefined;
  } = configureForChat
    ? {
        submitLabelOverride: "Use this setup",
        machines: [],
        onSelectMachine: undefined,
        onConnectMachine: undefined,
      }
    : {
        submitLabelOverride: null,
        machines,
        onSelectMachine: handleSelectMachine,
        onConnectMachine: handleConnectMachine,
      };

  return (
    <CreateLaneDialog
      open={open}
      onOpenChange={onOpenChange}
      createLaneName={createLaneName}
      setCreateLaneName={handleSetCreateLaneName}
      createBranchName={createBranchName}
      setCreateBranchName={handleSetCreateBranchName}
      createBranchProblem={createBranchProblem}
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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { selectActiveProjectRoot, useAppStore } from "../../state/appStore";
import { CreateLaneDialog, type CreateLaneMode, type CreateLaneSetupStep } from "./CreateLaneDialog";
import {
  DEFAULT_NEW_LANE_BASE_SOURCE,
  effectiveNewLaneBaseSource,
  fetchNewLaneBaseBranches,
  listNewLaneBaseOptions,
  selectDefaultNewLaneBaseRef,
} from "./newLaneBaseSource";
import { resolveCreateLaneRequest } from "./lanePageModel";
import { linearIssueBranchName, linearIssueLaneName } from "../../../shared/linearIssueBranch";
import { dismissToast, showToast } from "../app/toast/toastStore";
import { openConnectionsPanel } from "../../lib/connectionsPanel";
import {
  canCreateLaneOnMachine,
  deriveLaneMachineOptions,
  THIS_MACHINE_ID,
  type LaneMachineProjectRef,
} from "./laneMachines";
import type { LaneBranchOption } from "./laneUtils";
import type {
  BranchPullRequest,
  LaneEnvInitEvent,
  LaneEnvInitProgress,
  LaneLinearIssue,
  LaneSummary,
  LaneTemplate,
  NewLaneBaseSource,
  OpenProjectBinding,
  RemoteRuntimeConnectionSnapshot,
} from "../../../shared/types";

type CreateSetupPhase =
  | "creating"
  | "appearance"
  | "refreshing"
  | "environment";

export type CreateLaneBehavior = "stay-open-setup" | "close-on-create";

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
};

async function applyLaneEnvSetup(laneId: string, templateId: string): Promise<LaneEnvInitProgress> {
  return templateId
    ? await window.ade.lanes.applyTemplate({ laneId, templateId })
    : await window.ade.lanes.initEnv({ laneId });
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
    action: {
      label: "Retry",
      onClick: () => runDetachedLaneSetup(params),
    },
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
      const progress = await applyLaneEnvSetup(params.laneId, params.templateId);
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
 */
export function CreateLaneDialogHost({
  open,
  onOpenChange,
  behavior,
  prefill,
  onCreated,
  onBusyChange,
  onNavigateToTemplates,
  onOpenLinearSettings,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  behavior: CreateLaneBehavior;
  prefill?: CreateLanePrefill | null;
  /** Called after the lane record is created + refreshed (before env setup). */
  onCreated?: (lane: LaneSummary) => void;
  /** Mirrors the in-flight create/setup state so callers can guard forced closes. */
  onBusyChange?: (busy: boolean) => void;
  onNavigateToTemplates?: () => void;
  onOpenLinearSettings?: () => void;
}) {
  const lanes = useAppStore((s) => s.lanes);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const activeProjectRoot = useAppStore(selectActiveProjectRoot);
  const projectBinding = useAppStore((s) => s.projectBinding);
  const project = useAppStore((s) => s.project);
  const openProjectTabRoots = useAppStore((s) => s.openProjectTabRoots);
  const switchRemoteProject = useAppStore((s) => s.switchRemoteProject);
  const switchProjectToPath = useAppStore((s) => s.switchProjectToPath);

  const [createLaneName, setCreateLaneName] = useState("");
  const [createParentLaneId, setCreateParentLaneId] = useState<string>("");
  const [createMode, setCreateMode] = useState<CreateLaneMode>("primary");
  const [createBaseSource, setCreateBaseSource] = useState<NewLaneBaseSource>(DEFAULT_NEW_LANE_BASE_SOURCE);
  const createBaseSourceRef = useRef<NewLaneBaseSource>(DEFAULT_NEW_LANE_BASE_SOURCE);
  const createBaseSourceUserPickedRef = useRef(false);
  const createBaseBranchesLoadSeqRef = useRef(0);
  const createBaseSourceSaveInFlightRef = useRef(false);
  const createBaseSourceSavePendingRef = useRef<NewLaneBaseSource | null>(null);
  const [createBaseBranch, setCreateBaseBranch] = useState("");
  const [createImportBranch, setCreateImportBranch] = useState("");
  const [createChildBaseBranch, setCreateChildBaseBranch] = useState("");
  const [createBranches, setCreateBranches] = useState<LaneBranchOption[]>([]);
  const [createBranchesLoading, setCreateBranchesLoading] = useState(false);
  const [createBranchPullRequests, setCreateBranchPullRequests] = useState<BranchPullRequest[]>([]);
  const [createBranchPullRequestsLoading, setCreateBranchPullRequestsLoading] = useState(false);
  const [createGitUserName, setCreateGitUserName] = useState<string>("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createEnvInitProgress, setCreateEnvInitProgress] = useState<LaneEnvInitProgress | null>(null);
  const [laneCreated, setLaneCreated] = useState(false);
  const [createSetupPhase, setCreateSetupPhase] = useState<CreateSetupPhase | null>(null);
  const createEnvInitLaneIdRef = useRef<string | null>(null);
  const createBaseBranchUserPickedRef = useRef(false);
  const [templates, setTemplates] = useState<LaneTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [createSelectedColor, setCreateSelectedColor] = useState<string | null>(null);
  const [createSelectedLinearIssue, setCreateSelectedLinearIssue] = useState<LaneLinearIssue | null>(null);
  const createLinearIssueAutoNameRef = useRef<string | null>(null);

  const primaryLane = useMemo(() => lanes.find((l) => l.laneType === "primary") ?? null, [lanes]);

  /* -------------------------------------------------------------------------
   * Machine selection.
   *
   * A lane owns its machine (`worktree_path` is absolute on exactly one), so
   * this dialog is the only place a machine gets picked. The list is a pure
   * derivation over the remote-runtime connection snapshot: one read + one
   * subscription to an existing broadcast, both scoped to while the dialog is
   * open. No polling, no per-machine probing.
   * ---------------------------------------------------------------------- */
  const [remoteSnapshot, setRemoteSnapshot] = useState<RemoteRuntimeConnectionSnapshot | null>(null);
  const [selectedMachineId, setSelectedMachineId] = useState<string>(THIS_MACHINE_ID);
  const pendingMachinePrepareRef = useRef(false);
  /** Lane name / Linear issue carried across a machine switch's re-prepare. */
  const machinePrefillRef = useRef<CreateLanePrefill | null>(null);
  /**
   * Picking a machine rebinds the whole app, so a dialog that is closed without
   * creating anything has to put the binding back. Without this, "open dialog →
   * look at another machine → press Escape" leaves the window pointed at that
   * machine with nothing on screen saying a dialog did it.
   */
  const bindingOnOpenRef = useRef<OpenProjectBinding | null>(null);
  const machineRebindPendingRef = useRef(false);
  const projectBindingRef = useRef<OpenProjectBinding | null>(projectBinding);
  projectBindingRef.current = projectBinding;

  useEffect(() => {
    if (!open) return;
    const remoteRuntime = window.ade.remoteRuntime;
    if (!remoteRuntime?.getConnectionSnapshot) return;
    let cancelled = false;
    const apply = (snapshot: RemoteRuntimeConnectionSnapshot) => {
      if (cancelled) return;
      setRemoteSnapshot((current) =>
        current && current.updatedAt > snapshot.updatedAt ? current : snapshot,
      );
    };
    void remoteRuntime.getConnectionSnapshot().then(apply).catch(() => {});
    const unsubscribe = remoteRuntime.onConnectionSnapshotChanged?.(apply) ?? (() => {});
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [open]);

  const boundProject = useMemo<LaneMachineProjectRef | null>(() => {
    if (projectBinding) {
      return {
        // The active binding IS this repo by definition — no inference involved.
        matchedBy: "origin" as const,
        projectId: projectBinding.kind === "remote" ? projectBinding.projectId : null,
        rootPath: projectBinding.rootPath,
        displayName: projectBinding.displayName,
      };
    }
    if (!project) return null;
    return {
      // The open project is the repo lanes are being created for, not a guess.
      matchedBy: "origin" as const,
      projectId: null,
      rootPath: project.rootPath,
      displayName: project.displayName,
    };
  }, [project, projectBinding]);

  const boundTargetId = projectBinding?.kind === "remote" ? projectBinding.targetId : null;

  /** `origin` of the bound checkout, taken straight from the snapshot record. */
  const repoOriginUrl = useMemo(() => {
    if (!boundTargetId || !projectBinding || projectBinding.kind !== "remote") return null;
    const connection = remoteSnapshot?.connections.find(
      (candidate) => candidate.target.id === boundTargetId,
    );
    const record = connection?.projects.find(
      (candidate) => candidate.projectId === projectBinding.projectId,
    );
    return record?.gitOriginUrl ?? null;
  }, [boundTargetId, projectBinding, remoteSnapshot]);

  const machines = useMemo(
    () =>
      deriveLaneMachineOptions({
        connections: remoteSnapshot?.connections ?? [],
        boundTargetId,
        boundProject,
        repoOriginUrl,
        repoDisplayName: boundProject?.displayName ?? null,
        localProjectRoots: openProjectTabRoots,
      }),
    [boundProject, boundTargetId, openProjectTabRoots, remoteSnapshot, repoOriginUrl],
  );

  // Derived from the binding, not the snapshot, so the default is correct on the
  // very first render — before the first snapshot lands.
  const boundMachineId = boundTargetId ?? THIS_MACHINE_ID;

  // A machine that drops off the list (disconnected, repo closed) can't stay
  // selected; fall back to the machine the project is actually bound to. The
  // bound machine is always legal — it may simply not be in the first snapshot.
  useEffect(() => {
    if (!open || selectedMachineId === boundMachineId) return;
    const selected = machines.find((machine) => machine.id === selectedMachineId);
    if (selected && canCreateLaneOnMachine(selected)) return;
    setSelectedMachineId(boundMachineId);
  }, [boundMachineId, machines, open, selectedMachineId]);

  // Mirror busy so callers can block a forced close mid-create (parity with the
  // old `handleCreateDialogOpenChange` guard).
  const busyRef = useRef(false);
  useEffect(() => {
    busyRef.current = createBusy;
    onBusyChange?.(createBusy);
  }, [createBusy, onBusyChange]);

  // Env-init progress events for the lane currently being created. Only matters
  // while the dialog is open (stay-open mode); close-on-create runs setup
  // detached after the dialog is gone.
  useEffect(() => {
    return window.ade.lanes.onEnvEvent((event: LaneEnvInitEvent) => {
      if (event.progress.laneId !== createEnvInitLaneIdRef.current) return;
      setCreateEnvInitProgress(event.progress);
    });
  }, []);

  /** Put the app back on the machine it was on before the dialog opened. */
  const restoreBindingFromBeforeOpen = useCallback(() => {
    const previous = bindingOnOpenRef.current;
    bindingOnOpenRef.current = null;
    if (!machineRebindPendingRef.current) return;
    machineRebindPendingRef.current = false;
    if (!previous || projectBindingRef.current?.key === previous.key) return;
    const restoring = previous.kind === "remote"
      ? switchRemoteProject(previous.targetId, previous.projectId).then(() => {})
      : switchProjectToPath(previous.rootPath);
    void restoring.catch(() => {
      // Best effort: the dialog is already gone, and the machine picker in the
      // top bar remains the way back.
    });
  }, [switchProjectToPath, switchRemoteProject]);

  const resetCreateDialogState = useCallback(() => {
    restoreBindingFromBeforeOpen();
    createEnvInitLaneIdRef.current = null;
    createBaseBranchUserPickedRef.current = false;
    createBaseBranchesLoadSeqRef.current += 1;
    setLaneCreated(false);
    setCreateLaneName("");
    setCreateParentLaneId("");
    setCreateMode("primary");
    setCreateBaseBranch("");
    setCreateImportBranch("");
    setCreateChildBaseBranch("");
    setCreateBusy(false);
    setCreateError(null);
    setCreateEnvInitProgress(null);
    setCreateSetupPhase(null);
    setSelectedTemplateId("");
    setCreateSelectedColor(null);
    setCreateSelectedLinearIssue(null);
    createLinearIssueAutoNameRef.current = null;
  }, [restoreBindingFromBeforeOpen]);

  const handleSetCreateLinearIssue = useCallback((issue: LaneLinearIssue | null) => {
    setCreateSelectedLinearIssue(issue);
    if (!issue) return;

    const nextName = linearIssueLaneName(issue);
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
    setCreateMode((mode) => mode === "existing" ? "primary" : mode);
  }, []);

  const prepareCreateDialog = useCallback((prefillInput?: CreateLanePrefill | null) => {
    setCreateLaneName("");
    setCreateParentLaneId("");
    setCreateMode("primary");
    setCreateBaseSource(DEFAULT_NEW_LANE_BASE_SOURCE);
    createBaseSourceRef.current = DEFAULT_NEW_LANE_BASE_SOURCE;
    createBaseSourceUserPickedRef.current = false;
    setCreateBaseBranch("");
    setCreateImportBranch("");
    setCreateChildBaseBranch("");
    setCreateBranches([]);
    setCreateBranchPullRequests([]);
    setCreateGitUserName("");
    setCreateSelectedColor(null);
    setCreateSelectedLinearIssue(null);
    createLinearIssueAutoNameRef.current = null;
    setCreateBranchesLoading(false);
    setCreateBranchPullRequestsLoading(false);
    setCreateBusy(false);
    setCreateError(null);
    setCreateEnvInitProgress(null);
    setCreateSetupPhase(null);
    setLaneCreated(false);
    createEnvInitLaneIdRef.current = null;
    createBaseBranchUserPickedRef.current = false;
    setSelectedMachineId(boundMachineId);
    const primary = lanes.find((l) => l.laneType === "primary");
    if (primary) {
      const loadSeq = ++createBaseBranchesLoadSeqRef.current;
      setCreateBranchesLoading(true);
      window.ade.projectConfig.get()
        .catch(() => null)
        .then(async (snapshot) => {
          const baseSource = effectiveNewLaneBaseSource(snapshot);
          const selectedBaseSource = createBaseSourceUserPickedRef.current
            ? createBaseSourceRef.current
            : baseSource;
          if (!createBaseSourceUserPickedRef.current) {
            createBaseSourceRef.current = baseSource;
            setCreateBaseSource(baseSource);
          }
          const branches = await fetchNewLaneBaseBranches({
            source: selectedBaseSource,
            fetchRemoteBranches: () => window.ade.git.fetch({ laneId: primary.id }),
            listBranches: () => window.ade.git.listBranches({ laneId: primary.id }),
          });
          if (createBaseBranchesLoadSeqRef.current !== loadSeq) return;
          setCreateBranches(branches);
          if (!createBaseBranchUserPickedRef.current) {
            const defaultBaseRef = selectDefaultNewLaneBaseRef({
              branches,
              source: createBaseSourceUserPickedRef.current
                ? createBaseSourceRef.current
                : selectedBaseSource,
              primaryBaseRef: primary.baseRef,
            });
            if (defaultBaseRef) setCreateBaseBranch(defaultBaseRef);
          }
        })
        .catch(() => {})
        .finally(() => {
          if (createBaseBranchesLoadSeqRef.current === loadSeq) setCreateBranchesLoading(false);
        });

      // Capture git user.name so the picker can resolve `mine` / `author:me`.
      window.ade.git.getUserIdentity({ laneId: primary.id })
        .then((identity) => setCreateGitUserName(identity?.name ?? ""))
        .catch(() => setCreateGitUserName(""));

      // Lazily attach open-PR metadata. Fail-soft; picker degrades gracefully.
      setCreateBranchPullRequestsLoading(true);
      window.ade.prs.listOpenForRepo()
        .then(setCreateBranchPullRequests)
        .catch(() => setCreateBranchPullRequests([]))
        .finally(() => setCreateBranchPullRequestsLoading(false));
    }
    Promise.all([
      window.ade.lanes.listTemplates().catch(() => [] as LaneTemplate[]),
      window.ade.lanes.getDefaultTemplate().catch(() => null),
    ]).then(([nextTemplates, defaultTemplateId]) => {
      setTemplates(nextTemplates);
      setSelectedTemplateId(
        defaultTemplateId && nextTemplates.some((template) => template.id === defaultTemplateId)
          ? defaultTemplateId
          : ""
      );
    });

    // Apply caller prefill after resetting to defaults.
    if (prefillInput?.name) setCreateLaneName(prefillInput.name.trim());
    if (prefillInput?.linearIssue) handleSetCreateLinearIssue(prefillInput.linearIssue);
  }, [boundMachineId, lanes, handleSetCreateLinearIssue]);

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
      // Captured before anything in the dialog can rebind the app.
      bindingOnOpenRef.current = projectBindingRef.current;
      machineRebindPendingRef.current = false;
      prepareCreateDialog(prefillRef.current);
    } else {
      resetCreateDialogState();
    }
  }, [open, prepareCreateDialog, resetCreateDialogState]);

  /**
   * Picking a different machine re-binds this repo to that machine, because
   * every create-lane call (branch listing included) is routed by the active
   * binding. The rebind is async and lands lanes for the new machine, so the
   * dialog re-prepares once that machine's primary lane is in the store —
   * keeping the lane name and any connected Linear issue.
   */
  const handleSelectMachine = useCallback((machineId: string) => {
    if (createBusy || laneCreated || machineId === selectedMachineId) return;
    const machine = machines.find((candidate) => candidate.id === machineId);
    if (!machine || !canCreateLaneOnMachine(machine)) return;

    const previousMachineId = selectedMachineId;
    setSelectedMachineId(machineId);
    setCreateError(null);

    const failSwitch = (message: string) => {
      setSelectedMachineId(previousMachineId);
      setCreateError(message);
    };

    // From here on the app may end up bound to another machine purely because a
    // dialog was open; closing it without creating a lane has to undo that.
    machineRebindPendingRef.current = true;

    machinePrefillRef.current = {
      name: createLaneName.trim(),
      linearIssue: createSelectedLinearIssue,
    };
    pendingMachinePrepareRef.current = true;

    const switching = machine.targetId
      ? machine.project?.projectId
        ? switchRemoteProject(machine.targetId, machine.project.projectId).then(() => {})
        : null
      : machine.project?.rootPath
        ? switchProjectToPath(machine.project.rootPath)
        : null;

    if (!switching) {
      pendingMachinePrepareRef.current = false;
      failSwitch(`Open this repository on ${machine.name} first, then create the lane there.`);
      return;
    }

    void switching.catch((err: unknown) => {
      pendingMachinePrepareRef.current = false;
      failSwitch(err instanceof Error ? err.message : String(err));
    });
  }, [
    createBusy,
    createLaneName,
    createSelectedLinearIssue,
    laneCreated,
    machines,
    selectedMachineId,
    switchProjectToPath,
    switchRemoteProject,
  ]);

  // The rebind above only settles when the new machine's lanes land. Re-prepare
  // exactly once at that point; the ref makes every later lane change a no-op.
  const primaryLaneId = primaryLane?.id ?? null;
  useEffect(() => {
    if (!open || !pendingMachinePrepareRef.current || !primaryLaneId) return;
    pendingMachinePrepareRef.current = false;
    const carried = machinePrefillRef.current;
    machinePrefillRef.current = null;
    prepareCreateDialog(carried);
  }, [open, primaryLaneId, prepareCreateDialog]);

  const handleConnectMachine = useCallback(() => {
    if (createBusy || laneCreated) return;
    onOpenChange(false);
    openConnectionsPanel("machines");
  }, [createBusy, laneCreated, onOpenChange]);

  const createSetupStatus = useMemo(() => {
    switch (createSetupPhase) {
      case "creating":
        return createMode === "existing"
          ? "Importing branch and creating the lane worktree..."
          : "Creating the lane branch and worktree...";
      case "appearance":
        return "Saving lane appearance...";
      case "refreshing":
        return "Refreshing the lane list...";
      case "environment":
        return selectedTemplateId ? "Applying the lane template..." : "Running lane environment setup...";
      default:
        return laneCreated ? "Lane exists. Finish setup or retry the failed step." : null;
    }
  }, [createMode, createSetupPhase, laneCreated, selectedTemplateId]);

  const createSetupSteps = useMemo<CreateLaneSetupStep[]>(() => {
    if (!createBusy && !laneCreated) return [];
    let laneLabel: string;
    if (createMode === "child") laneLabel = "Create child lane";
    else if (createMode === "existing") laneLabel = "Import branch";
    else laneLabel = "Create lane";
    let laneState: CreateLaneSetupStep["state"];
    if (createSetupPhase === "creating") laneState = "active";
    else if (laneCreated) laneState = "done";
    else laneState = "pending";
    const steps: CreateLaneSetupStep[] = [{
      label: laneLabel,
      detail: "Create the branch metadata and worktree on disk.",
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
  }, [createBusy, createMode, createSetupPhase, laneCreated, selectedTemplateId]);

  /** Wraps setCreateBaseBranch so we can track user-driven selections and avoid
   *  the async branch-list fetch from overwriting a value the user already picked. */
  const handleSetCreateBaseBranch = useCallback((v: string) => {
    createBaseBranchUserPickedRef.current = true;
    setCreateBaseBranch(v);
  }, []);

  const persistCreateBaseSourceConfig = useCallback(() => {
    if (createBaseSourceSaveInFlightRef.current) return;
    if (!createBaseSourceSavePendingRef.current) return;
    createBaseSourceSaveInFlightRef.current = true;
    let failed = false;

    void (async () => {
      try {
        while (createBaseSourceSavePendingRef.current) {
          const source: NewLaneBaseSource = createBaseSourceSavePendingRef.current;
          const snapshot = await window.ade.projectConfig.get();
          const currentGit = snapshot.local.git ?? {};
          await window.ade.projectConfig.save({
            shared: snapshot.shared,
            local: {
              ...snapshot.local,
              git: {
                ...currentGit,
                newLaneBaseSource: source,
              },
            },
          });
          if (createBaseSourceSavePendingRef.current === source) {
            createBaseSourceSavePendingRef.current = null;
          }
        }
      } catch (saveError) {
        failed = true;
        setCreateError(saveError instanceof Error ? saveError.message : String(saveError));
      } finally {
        createBaseSourceSaveInFlightRef.current = false;
        if (!failed && createBaseSourceSavePendingRef.current) {
          persistCreateBaseSourceConfig();
        }
      }
    })();
  }, []);

  const handleSetCreateBaseSource = useCallback((source: NewLaneBaseSource) => {
    createBaseSourceRef.current = source;
    createBaseSourceUserPickedRef.current = true;
    createBaseBranchUserPickedRef.current = false;
    const loadSeq = ++createBaseBranchesLoadSeqRef.current;
    setCreateBaseSource(source);
    setCreateBaseBranch("");
    setCreateBranches([]);
    const primary = lanes.find((l) => l.laneType === "primary");
    if (primary) {
      setCreateBranchesLoading(true);
      fetchNewLaneBaseBranches({
        source,
        fetchRemoteBranches: () => window.ade.git.fetch({ laneId: primary.id }),
        listBranches: () => window.ade.git.listBranches({ laneId: primary.id }),
        })
        .then((branches) => {
          if (createBaseSourceRef.current !== source || createBaseBranchesLoadSeqRef.current !== loadSeq) return;
          setCreateBranches(branches);
          if (!createBaseBranchUserPickedRef.current) {
            setCreateBaseBranch(selectDefaultNewLaneBaseRef({
              branches,
              source,
              primaryBaseRef: primary.baseRef,
            }));
          }
        })
        .catch(() => {})
        .finally(() => {
          if (createBaseSourceRef.current === source && createBaseBranchesLoadSeqRef.current === loadSeq) {
            setCreateBranchesLoading(false);
          }
        });
    } else {
      setCreateBranchesLoading(false);
    }
    createBaseSourceSavePendingRef.current = source;
    persistCreateBaseSourceConfig();
  }, [lanes, persistCreateBaseSourceConfig]);

  /** Run post-create setup for a lane that already exists. Used as the retry path
   *  when environment setup fails (stay-open mode). */
  const runSetupForCreatedLane = useCallback(async (laneId: string) => {
    setCreateBusy(true);
    setCreateError(null);
    setCreateEnvInitProgress(null);
    setCreateSetupPhase("environment");

    try {
      const envProgress = selectedTemplateId
        ? await window.ade.lanes.applyTemplate({ laneId, templateId: selectedTemplateId })
        : await window.ade.lanes.initEnv({ laneId });
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

  const handleCreateSubmit = useCallback(async () => {
    // If the lane was already created (e.g. env setup failed on a previous
    // attempt), retry setup only; never re-run creation.
    if (createEnvInitLaneIdRef.current) {
      await runSetupForCreatedLane(createEnvInitLaneIdRef.current);
      return;
    }

    const name = createLaneName.trim();
    if (!name || createBusy) return;
    if (createMode === "child" && !createParentLaneId) return;
    if (createMode === "primary") {
      const validBaseBranch = listNewLaneBaseOptions(createBranches, createBaseSource)
        .some((option) => option.ref === createBaseBranch);
      if (createBranchesLoading || !validBaseBranch) {
        setCreateError(createBranchesLoading
          ? "Still loading base branches. Try again in a moment."
          : "Choose a valid base branch for the selected source.");
        return;
      }
    }
    if (createMode === "existing" && !createImportBranch) return;
    if (createSelectedLinearIssue && createMode === "existing") {
      setCreateError("Detach the Linear issue before importing an existing branch.");
      return;
    }
    if (selectedTemplateId && !templates.some((template) => template.id === selectedTemplateId)) {
      setCreateError("The selected lane template no longer exists. Refresh templates or choose a different option.");
      return;
    }

    setCreateBusy(true);
    setCreateError(null);
    setCreateEnvInitProgress(null);
    setCreateSetupPhase("creating");

    try {
      const request = resolveCreateLaneRequest({
        name,
        createMode,
        createParentLaneId,
        createBaseBranch,
        createImportBranch,
      });
      const linearIssueArgs = createSelectedLinearIssue
        ? {
          linearIssue: {
            ...createSelectedLinearIssue,
            branchName: linearIssueBranchName(createSelectedLinearIssue),
          },
          branchName: linearIssueBranchName(createSelectedLinearIssue),
        }
        : {};
      let lane: LaneSummary;
      if (request.kind === "import") {
        lane = await window.ade.lanes.importBranch(request.args);
      } else if (request.kind === "child") {
        const trimmedBase = createChildBaseBranch.trim();
        const parentLane = lanes.find((l) => l.id === request.args.parentLaneId);
        if (!parentLane) {
          setCreateError("Parent lane no longer exists. Please close and reopen the dialog.");
          setCreateBusy(false);
          setCreateSetupPhase(null);
          return;
        }
        const childArgs = trimmedBase && trimmedBase !== parentLane.branchRef
          ? { ...request.args, baseBranchRef: trimmedBase, ...linearIssueArgs }
          : { ...request.args, ...linearIssueArgs };
        lane = await window.ade.lanes.createChild(childArgs);
      } else {
        lane = await window.ade.lanes.create({ ...request.args, ...linearIssueArgs });
      }

      // Lane created successfully: record its id so retries skip creation.
      createEnvInitLaneIdRef.current = lane.id;
      setLaneCreated(true);
      // The lane now lives on the selected machine, so the rebind is the user's
      // intent rather than a dialog side effect — nothing to undo on close.
      machineRebindPendingRef.current = false;
      bindingOnOpenRef.current = null;

      if (createSelectedColor) {
        try {
          setCreateSetupPhase("appearance");
          await window.ade.lanes.updateAppearance({ laneId: lane.id, color: createSelectedColor });
        } catch {
          // Color collisions or transient errors shouldn't block lane creation.
        }
      }

      setCreateSetupPhase("refreshing");
      await refreshLanes();
      onCreated?.(lane);

      if (behavior === "close-on-create") {
        // Detach env setup from this component's lifetime; the opening pane may
        // unmount as soon as the lane exists. Capture everything the background
        // runner needs before we reset/close.
        const detachParams: DetachedSetupParams = {
          laneId: lane.id,
          laneName: lane.name,
          templateId: selectedTemplateId,
          projectRoot: activeProjectRoot,
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
    }
  }, [
    behavior,
    createLaneName,
    createMode,
    createParentLaneId,
    createBaseSource,
    createBaseBranch,
    createBranches,
    createBranchesLoading,
    createImportBranch,
    createChildBaseBranch,
    lanes,
    createBusy,
    refreshLanes,
    onCreated,
    resetCreateDialogState,
    onOpenChange,
    runSetupForCreatedLane,
    selectedTemplateId,
    templates,
    createSelectedColor,
    createSelectedLinearIssue,
    activeProjectRoot,
  ]);

  const handleDialogOpenChange = useCallback((next: boolean) => {
    // Never dismiss the dialog while a create/setup is in flight.
    if (!next && busyRef.current) return;
    onOpenChange(next);
  }, [onOpenChange]);

  const importBranchWarning = createMode === "existing" && createImportBranch && primaryLane?.status.dirty
    && createBranches.find((b) => b.name === createImportBranch && !b.isRemote)?.isCurrent
    ? "This branch is currently checked out and has uncommitted changes. The new lane will only include committed changes - uncommitted work will not carry over."
    : null;

  return (
    <CreateLaneDialog
      open={open}
      onOpenChange={handleDialogOpenChange}
      createLaneName={createLaneName}
      setCreateLaneName={setCreateLaneName}
      createMode={createMode}
      setCreateMode={setCreateMode}
      createParentLaneId={createParentLaneId}
      setCreateParentLaneId={setCreateParentLaneId}
      createBaseSource={createBaseSource}
      setCreateBaseSource={handleSetCreateBaseSource}
      createBaseBranch={createBaseBranch}
      setCreateBaseBranch={handleSetCreateBaseBranch}
      createImportBranch={createImportBranch}
      setCreateImportBranch={setCreateImportBranch}
      createChildBaseBranch={createChildBaseBranch}
      setCreateChildBaseBranch={setCreateChildBaseBranch}
      projectRoot={activeProjectRoot}
      createBranches={createBranches}
      lanes={lanes}
      onSubmit={handleCreateSubmit}
      busy={createBusy}
      error={createError}
      envInitProgress={createEnvInitProgress}
      laneCreated={laneCreated}
      setupStatus={createSetupStatus}
      setupSteps={createSetupSteps}
      templates={templates}
      selectedTemplateId={selectedTemplateId}
      setSelectedTemplateId={setSelectedTemplateId}
      selectedColor={createSelectedColor}
      setSelectedColor={setCreateSelectedColor}
      selectedLinearIssue={createSelectedLinearIssue}
      setSelectedLinearIssue={handleSetCreateLinearIssue}
      branchPullRequests={createBranchPullRequests}
      currentGitUserName={createGitUserName}
      loadingBranches={createBranchesLoading}
      loadingBranchPullRequests={createBranchPullRequestsLoading}
      onOpenLinearSettings={onOpenLinearSettings}
      onNavigateToTemplates={onNavigateToTemplates}
      importBranchWarning={importBranchWarning}
      machines={machines}
      selectedMachineId={selectedMachineId}
      onSelectMachine={handleSelectMachine}
      onConnectMachine={handleConnectMachine}
    />
  );
}

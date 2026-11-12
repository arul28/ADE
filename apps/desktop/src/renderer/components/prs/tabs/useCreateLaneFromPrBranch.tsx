import React from "react";
import { useNavigate } from "react-router-dom";
import type {
  CreateLaneFromPrBranchPreflight,
  CreateLaneFromPrBranchPreflightResult,
  CreateLaneFromPrBranchResult,
  GitHubPrListItem,
} from "../../../../shared/types";
import type { CloudTierId } from "../../../../shared/cloudTiers";
import { ADE_CLOUD_NAME } from "../../remoteTargets/cloudBrand";
import { originUrlForBinding } from "../../lanes/laneMachines";
import { startAdeCloudLaunch } from "../../chat/launch/adeCloudLaunch";
import { openLaneOnMachinePath } from "../../../lib/laneNavigation";
import {
  selectActiveProjectRoot,
  selectActiveProjectStateKey,
  useAppStore,
  useAppStoreApi,
} from "../../../state/appStore";
import { requestCrossMachineLanesForMachine } from "../../../state/crossMachineLanes";
import {
  isProjectTabOnScreen,
  laneCreateFailureToastId,
  trackPendingLaneCreate,
} from "../../../lib/pendingLaneCreates";
import { useActiveRef } from "../../../lib/useActiveRef";
import { dismissToast, showToast } from "../../app/toast/toastStore";
import type { LaneMachine } from "../../../state/laneMachineRouting";
import { withMachineTimeout } from "../../../state/projectMachines";
import { isAdeCloudPick, useProjectMachinePicker } from "../../lanes/ProjectMachinePicker";
import type { PrMachineIndex } from "../state/prMachines";
import {
  CreateLaneFromPrBranchDialog,
  createLaneFromPrBranchApi,
  createLaneFromPrBranchArgs,
  createLaneFromPrBranchRequestKey,
  formatActionError,
  upsertLaneSummary,
} from "./GitHubTabCreateLaneDialog";

/**
 * What the dialog shows for a lane on ADE Cloud. Nothing on this computer is
 * asked: the new computer clones the project and checks the branch out from
 * GitHub. A fork's branch is in another repository, so it can't.
 */
function adeCloudPrPreflight(item: GitHubPrListItem): CreateLaneFromPrBranchPreflight {
  const headOwner = item.headRepoOwner?.trim() || item.repoOwner;
  const headRepo = item.headRepoName?.trim() || item.repoName;
  const fromFork = headOwner.toLowerCase() !== item.repoOwner.toLowerCase()
    || headRepo.toLowerCase() !== item.repoName.toLowerCase();
  const headBranch = item.headBranch?.trim() || null;
  const canCreate = !fromFork && headBranch != null;
  return {
    repoOwner: item.repoOwner,
    repoName: item.repoName,
    githubPrNumber: item.githubPrNumber,
    githubUrl: item.githubUrl,
    title: item.title,
    headBranch,
    headSha: null,
    headRepoOwner: headOwner,
    headRepoName: headRepo,
    remoteBranch: headBranch,
    importBranchRef: null,
    targetLaneName: headBranch ?? "",
    baseBranch: item.baseBranch,
    canCreate,
    status: canCreate ? "ready" : "blocked",
    blockingConflict: null,
    blockingConflicts: [],
  };
}

function adeCloudPrProblem(item: GitHubPrListItem, preflight: CreateLaneFromPrBranchPreflight): string | null {
  if (preflight.canCreate) return null;
  if (!preflight.headBranch) return "This pull request has no branch to check out.";
  return `This pull request's branch is in ${preflight.headRepoOwner}/${preflight.headRepoName}, a fork. ADE Cloud checks out branches of ${item.repoOwner}/${item.repoName} only.`;
}

const CREATE_LANE_MACHINE_COPY = {
  title: "Where should this lane live?",
  description: "The pull request's branch is checked out into a new lane on the machine you pick. Its chats and runs stay on that machine.",
  confirmLabel: "Continue",
};

/**
 * "Create a lane from this PR's branch", on the machine the user picks.
 *
 * A new lane always names its machine. Preflight and create run on the chosen
 * machine (pinned, timed out, for another machine). A lane created on another
 * machine is never folded into the tab machine's state: that machine's slice
 * of the union is re-read and the lane opens where it lives. A lane created on
 * the tab's own machine is handed to `onCreatedOnTabMachine`, which owns the
 * PR list's bookkeeping.
 */
export function useCreateLaneFromPrBranch({
  machineIndex,
  active,
  onCreatedOnTabMachine,
}: {
  machineIndex: PrMachineIndex;
  /** Whether the page that holds this hook is the one on screen. */
  active: boolean;
  /**
   * `stillHere()` is false once the user left the page: do the bookkeeping,
   * but do not change a selection or the route. Ask it at each such step; the
   * refreshes in between take seconds.
   */
  onCreatedOnTabMachine: (
    result: CreateLaneFromPrBranchResult,
    item: GitHubPrListItem,
    createProjectRoot: string | null,
    stillHere: () => boolean,
  ) => Promise<void>;
}): { open: (item: GitHubPrListItem) => Promise<void>; element: React.ReactNode } {
  const navigate = useNavigate();
  const appStore = useAppStoreApi();
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const tabBinding = useAppStore((state) => state.projectBinding);
  const tabScopeKey = useAppStore(selectActiveProjectStateKey);
  const { ask: askForMachine, element: machinePicker } = useProjectMachinePicker();
  const [item, setItem] = React.useState<GitHubPrListItem | null>(null);
  /** The machine the open dialog creates on; null = the tab's machine. */
  const [target, setTarget] = React.useState<LaneMachine | null>(null);
  /** The open dialog creates on ADE Cloud, on a new computer of this size. */
  const [cloudSize, setCloudSize] = React.useState<CloudTierId | null>(null);
  /** Shown in the dialog whenever there was a machine to choose. */
  const [machineName, setMachineName] = React.useState<string | null>(null);
  const [preflight, setPreflight] = React.useState<CreateLaneFromPrBranchPreflightResult | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const requestIdRef = React.useRef(0);
  const requestRef = React.useRef<{ id: number; itemKey: string } | null>(null);
  const onCreatedRef = React.useRef(onCreatedOnTabMachine);
  onCreatedRef.current = onCreatedOnTabMachine;

  /** The latest `open`, for a failure toast that outlives this render. */
  const openRef = React.useRef<(item: GitHubPrListItem) => Promise<void>>(async () => {});
  /** PRs with a create in flight, so the same one is not started twice. */
  const creatingKeysRef = React.useRef(new Set<string>());

  const close = React.useCallback(() => {
    requestRef.current = null;
    setItem(null);
    setTarget(null);
    setCloudSize(null);
    setPreflight(null);
    setError(null);
    setLoading(false);
  }, []);

  const open = React.useCallback(async (next: GitHubPrListItem) => {
    if (creatingKeysRef.current.has(createLaneFromPrBranchRequestKey(next))) {
      showToast({ title: "A lane for this pull request is already being created.", tone: "info" });
      return;
    }
    const laneCountByMachineId = new Map(
      machineIndex.machines.map((machine) => [
        machine.machineId,
        machineIndex.lanesByMachineId.get(machine.machineId)?.length ?? 0,
      ] as const),
    );
    const chosen = await askForMachine(machineIndex.machines, {
      ...CREATE_LANE_MACHINE_COPY,
      laneCountByMachineId,
      adeCloudOriginUrl: originUrlForBinding(tabBinding),
    });
    if (!chosen) return;
    if (isAdeCloudPick(chosen)) {
      // Checked from what the list already knows; nothing is asked of a machine.
      requestRef.current = null;
      const cloudPreflight = adeCloudPrPreflight(next);
      setItem(next);
      setTarget(null);
      setCloudSize(chosen.sizeId);
      setMachineName(ADE_CLOUD_NAME);
      setPreflight({ preflight: cloudPreflight, lane: null, pr: null });
      setError(adeCloudPrProblem(next, cloudPreflight));
      setLoading(false);
      return;
    }
    setCloudSize(null);
    const nextTarget = chosen.isActiveBinding ? null : chosen;
    const requestId = requestIdRef.current + 1;
    const itemKey = createLaneFromPrBranchRequestKey(next);
    requestIdRef.current = requestId;
    requestRef.current = { id: requestId, itemKey };
    const isCurrent = () => requestRef.current?.id === requestId && requestRef.current.itemKey === itemKey;
    setItem(next);
    setTarget(nextTarget);
    setMachineName(machineIndex.machines.length > 1 ? chosen.machineName : null);
    setPreflight(null);
    setError(null);
    setLoading(true);
    const api = createLaneFromPrBranchApi();
    const preflightArgs = createLaneFromPrBranchArgs(next);
    // The check runs on the machine the lane will be made on: the picked one,
    // or the tab's own (the same machine the create below is pinned to).
    const preflightPin = nextTarget?.pin ?? tabBinding;
    if (!preflightPin) {
      setError("This project is still opening. Try again in a moment.");
      setLoading(false);
      return;
    }
    void (nextTarget?.pin
      ? withMachineTimeout(api.preflightCreateLaneFromPrBranch(preflightArgs, nextTarget.pin), nextTarget.machineName)
      : api.preflightCreateLaneFromPrBranch(preflightArgs, preflightPin))
      .then((result) => {
        if (isCurrent()) setPreflight(result);
      })
      .catch((err) => {
        if (isCurrent()) setError(formatActionError(err));
      })
      .finally(() => {
        if (isCurrent()) setLoading(false);
      });
  }, [askForMachine, machineIndex.lanesByMachineId, machineIndex.machines, tabBinding]);
  openRef.current = open;

  // The dialog closes on confirm and the create runs in the background; the
  // Lanes sidebar shows a "Creating…" row until the lane exists. The user can
  // be on another page by then, so what follows a create asks `stillHereRef`.
  const stillHereRef = useActiveRef(active);
  const confirm = React.useCallback((laneName: string) => {
    if (!item) return;
    const createItem = item;
    const createKey = createLaneFromPrBranchRequestKey(createItem);
    const createProjectRoot = projectRoot;
    const createTarget = target;
    // ADE Cloud: a lane-only launch checks the branch out on a new computer.
    // Its card shows in the launches slide-out, with retry and cancel.
    if (cloudSize) {
      const headBranch = preflight?.preflight.headBranch ?? null;
      if (!tabBinding || !headBranch) {
        setError("This project is still opening. Try again in a moment.");
        return;
      }
      const sizeId = cloudSize;
      close();
      void startAdeCloudLaunch({
        args: {
          kind: "lane",
          mode: "background",
          launchId: crypto.randomUUID(),
          laneId: crypto.randomUUID(),
          laneName,
          title: laneName,
          prompt: "",
          // The computer links the new lane to this PR, as a lane made here is.
          laneConfig: {
            mode: "existing",
            branchRef: `origin/${headBranch}`,
            ...(createItem.githubUrl ? { pullRequestUrl: createItem.githubUrl } : {}),
          },
        },
        sizeId,
        originUrl: originUrlForBinding(tabBinding),
        binding: tabBinding,
      });
      return;
    }
    // The user is free to switch project tabs while this runs, and an unpinned
    // call follows the active tab: pin it to the tab that started it.
    const callPin = createTarget?.pin ?? tabBinding;
    if (!callPin) {
      setError("This project is still opening. Try again in a moment.");
      return;
    }
    const failureToastId = laneCreateFailureToastId(tabScopeKey, laneName);
    close();
    void (async () => {
      const api = createLaneFromPrBranchApi();
      const createArgs = createLaneFromPrBranchArgs(createItem, laneName);
      let result: CreateLaneFromPrBranchResult;
      creatingKeysRef.current.add(createKey);
      try {
        result = await trackPendingLaneCreate(
          { name: laneName, scopeKey: tabScopeKey },
          () => api.createLaneFromPrBranch(createArgs, callPin),
        );
        // An earlier failure for this name is answered now.
        dismissToast(failureToastId);
      } catch (err) {
        console.warn("create_lane_from_pr.failed", err);
        showToast({
          id: failureToastId,
          // The colon keeps the lane name out of the toast's log event name.
          title: `Could not create lane: ${laneName}`,
          message: formatActionError(err),
          // The lane name is the person's own text, and an error can quote a path.
          replayMask: { title: true, message: true },
          tone: "error",
          durationMs: 0,
          actions: [{
            label: "Try again",
            onClick: () => {
              // The dialog opens on this page; a page the user left cannot show it.
              if (stillHereRef.current) void openRef.current(createItem);
              else showToast({ title: "Open the pull request again to create its lane.", tone: "info" });
            },
          }],
        });
        return;
      } finally {
        creatingKeysRef.current.delete(createKey);
      }
      // The create was pinned, so it also ends after a switch to another
      // project tab. The follow-up below is not pinned: it re-reads through
      // the active tab into this tab's lists, so it runs only from this tab.
      const stillHere = () => stillHereRef.current && isProjectTabOnScreen(tabScopeKey);
      try {
        if (!createTarget?.pin) {
          if (isProjectTabOnScreen(tabScopeKey)) {
            await onCreatedRef.current(result, createItem, createProjectRoot, stillHere);
          } else if (result.lane) {
            // Another project's tab is on screen, and a read would go through
            // it: put the new lane in this tab's list as the create returned it.
            const createdLane = result.lane;
            appStore.setState((prev) => ({ lanes: upsertLaneSummary(prev.lanes, createdLane) }));
          }
          return;
        }
        // The lane and its PR row now live on that machine. Nothing here may
        // hold their ids as the tab machine's: refresh that machine's slice of
        // the union instead, and let the lane open where it lives.
        requestCrossMachineLanesForMachine(createTarget.machineId);
        const createdLaneId = result.lane?.id ?? null;
        const currentProjectRoot = selectActiveProjectRoot(appStore.getState());
        // Only while the user is still on this page; a lane that finishes
        // later must not pull them away from where they went.
        if (stillHere() && createdLaneId && (!createProjectRoot || currentProjectRoot === createProjectRoot)) {
          navigate(openLaneOnMachinePath(createdLaneId, createTarget.machineId));
        }
      } catch (err) {
        // The lane exists; only the follow-up on this page failed.
        console.warn("create_lane_from_pr.follow_up_failed", err);
      }
    })();
  }, [appStore, close, cloudSize, item, navigate, preflight, projectRoot, stillHereRef, tabBinding, tabScopeKey, target]);

  const element = (
    <>
      {item ? (
        <CreateLaneFromPrBranchDialog
          item={item}
          preflight={preflight?.preflight ?? null}
          loading={loading}
          error={error}
          onCancel={close}
          onConfirm={confirm}
          machineName={machineName}
          onAdeCloud={cloudSize != null}
        />
      ) : null}
      {machinePicker}
    </>
  );
  return { open, element };
}

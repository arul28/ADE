import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { AgentChatSessionSummary, LaneSummary, OpenProjectBinding } from "../../../shared/types";
import { isUnsupportedAdeActionError, stripElectronErrorWrapper } from "../../../shared/codedError";
import { machineIdForBinding } from "../../../shared/machineIdentity";
import { extractError } from "../../lib/format";
import { useLaneChatHandoff } from "../../lib/laneChatHandoff";
import { newestLaneWorkChat, type LaneCatchUpPromptInput } from "../../lib/laneCatchUpPrompt";
import { requestCrossMachineLanesForMachine } from "../../state/crossMachineLanes";
import { showToast } from "../app/toast/toastStore";
import type { LaneTabPrTag } from "./lanePageModel";
import { requestLaneRebaseNeedsRescan, type LaneRebaseLine } from "./laneRebaseNeeds";
import { laneBranchLabel } from "./sidebar/laneSidebarModel";

/**
 * The conflict check a catch-up waits for: `git merge-tree` against the base,
 * run on the lane's own machine.
 */
export type LaneCatchUpConflict =
  | { state: "checking" }
  | { state: "done"; predicted: boolean; files: string[] }
  | { state: "failed" };

/**
 * What a lane's Catch up menu offers. "Ask an agent" is always there; the two
 * direct ways are offered only when they are safe:
 *
 * - **Rebase now**: nothing uncommitted, no rebase or merge in progress, a
 *   conflict check that found none, and the branch was never pushed (a
 *   rebase would rewrite pushed history).
 * - **Merge <base> in**: nothing uncommitted, nothing in progress, a conflict
 *   check that found none, and a machine that can run it. It rewrites
 *   nothing, so a pushed branch is fine.
 *
 * A check that is still running or failed is not safe: the direct ways wait
 * for it. When neither is safe, `blocker` names why, in a few words.
 */
export type LaneCatchUpFacts = {
  conflict: LaneCatchUpConflict;
  dirty: boolean;
  /** A rebase or merge is in progress in the lane. */
  inProgress: boolean;
  /** Whether the branch is on the remote. Null until known. */
  pushed: boolean | null;
  /**
   * The lane's machine can run the merge (`git.mergeBaseIn`). False once that
   * machine refused it as an unknown action (an older ADE); see
   * `laneCatchUpMergeAvailable`.
   */
  mergeAvailable: boolean;
};

export type LaneCatchUpOptions = {
  rebase: boolean;
  merge: boolean;
  blocker: string | null;
};

/** Why neither direct way is safe, before the branch's push state counts. */
function laneCatchUpBlocker(facts: LaneCatchUpFacts): string | null {
  const { conflict } = facts;
  if (facts.inProgress) return "A rebase or merge is in progress";
  if (conflict.state === "done" && conflict.predicted) {
    const count = conflict.files.length;
    return count > 0 ? `Conflicts expected in ${count} file${count === 1 ? "" : "s"}` : "Conflicts expected";
  }
  if (facts.dirty) return "Uncommitted changes";
  if (conflict.state === "checking") return "Checking for conflicts…";
  if (conflict.state === "failed") return "Couldn't check for conflicts";
  return null;
}

export function laneCatchUpOptions(facts: LaneCatchUpFacts): LaneCatchUpOptions {
  const blocker = laneCatchUpBlocker(facts);
  const rebase = blocker == null && facts.pushed === false;
  const merge = blocker == null && facts.mergeAvailable;
  if (rebase || merge) return { rebase, merge, blocker: null };
  return {
    rebase,
    merge,
    blocker: blocker ?? (facts.pushed === true ? "Already pushed — rebasing would rewrite it" : null),
  };
}

/**
 * A fresh conflict check on the lane's own machine, so a lane on another
 * computer is checked like a local one. Never rejects: a machine that can't
 * check reads as "failed".
 */
export async function readLaneCatchUpConflict(
  laneId: string,
  pin: OpenProjectBinding | null,
): Promise<LaneCatchUpConflict> {
  try {
    const need = await window.ade.rebase.getNeed(laneId, pin);
    // No need means nothing to catch up with now: nothing to conflict.
    if (!need) return { state: "done", predicted: false, files: [] };
    return {
      state: "done",
      predicted: need.conflictPredicted,
      files: need.conflictPredicted ? need.conflictingFiles ?? [] : [],
    };
  } catch (error) {
    console.warn("lane_catch_up.conflict_check_failed", error);
    return { state: "failed" };
  }
}

/** The lane has a pull request of its own (not one it only carried before). */
export function laneHasCurrentPr(prs: readonly Pick<LaneTabPrTag, "laneRole">[] | undefined): boolean {
  return (prs ?? []).some((pr) => pr.laneRole !== "previous");
}

/**
 * True when the lane's record proves its branch is on the remote (a tracked
 * upstream, or a pull request); null when only git can say.
 */
export function lanePushedFromStatus(lane: Pick<LaneSummary, "status">, hasPr: boolean): true | null {
  return hasPr || (lane.status?.remoteBehind ?? -1) >= 0 ? true : null;
}

/**
 * What the agent's draft says about the lane. The conflicting files come from
 * the fresh check once it is done, else from the lane's scan.
 */
export function laneCatchUpPromptInput(
  lane: Pick<LaneSummary, "name" | "branchRef">,
  line: LaneRebaseLine,
  pushed: boolean | null,
  conflict: LaneCatchUpConflict,
): LaneCatchUpPromptInput {
  return {
    laneName: lane.name,
    branch: laneBranchLabel(lane.branchRef),
    baseBranch: line.baseBranch,
    kind: line.kind,
    behindBy: line.behindBy,
    mergedPrNumber: line.mergedPrNumber,
    pushed,
    conflictingFiles: conflict.state === "done" ? conflict.files : line.conflictingFiles,
    failure: null,
  };
}

const BUSY_LABEL = { rebase: "Rebasing…", merge: "Merging…" } as const;

/** "Rebasing…" / "Merging…" while a direct catch-up runs; null when idle. */
export function laneCatchUpBusyLabel(busy: "rebase" | "merge" | null): string | null {
  return busy ? BUSY_LABEL[busy] : null;
}

/* ---- Per-lane run state, shared by every trigger of the same lane ---- */

export type LaneCatchUpFailure = {
  action: "rebase" | "merge";
  message: string;
  laneId: string;
  pin: OpenProjectBinding | null;
  prompt: LaneCatchUpPromptInput;
};

type LaneCatchUpState = {
  busy: "rebase" | "merge" | null;
  failure: LaneCatchUpFailure | null;
};

const IDLE: LaneCatchUpState = { busy: null, failure: null };
const states = new Map<string, LaneCatchUpState>();
/** How many inline hosts (a lane's overview) show each lane's failure. */
const hosts = new Map<string, number>();
const listeners = new Set<() => void>();

/** One key per lane per machine: lane ids are only unique on their machine. */
export function laneCatchUpKey(laneId: string, pin: OpenProjectBinding | null): string {
  return `${pin?.key ?? "tab"}::${laneId}`;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readLaneCatchUp(key: string): LaneCatchUpState {
  return states.get(key) ?? IDLE;
}

export function patchLaneCatchUp(key: string, patch: Partial<LaneCatchUpState>): void {
  const next = { ...readLaneCatchUp(key), ...patch };
  if (next.busy == null && next.failure == null) states.delete(key);
  else states.set(key, next);
  emit();
}

/** Whether a lane overview is on screen to show this lane's failure inline. */
export function laneCatchUpHasInlineHost(key: string): boolean {
  return (hosts.get(key) ?? 0) > 0;
}

export function useLaneCatchUpState(key: string | null): LaneCatchUpState {
  return useSyncExternalStore(subscribe, () => (key ? readLaneCatchUp(key) : IDLE), () => IDLE);
}

/**
 * The lane's failure, for the surface that shows it inline. Mounting this
 * marks the lane as hosted, so a failure from the sidebar shows here instead
 * of in a toast.
 */
export function useLaneCatchUpFailureHost(key: string | null): LaneCatchUpFailure | null {
  useEffect(() => {
    if (!key) return;
    hosts.set(key, (hosts.get(key) ?? 0) + 1);
    return () => {
      const count = (hosts.get(key) ?? 1) - 1;
      if (count <= 0) hosts.delete(key);
      else hosts.set(key, count);
    };
  }, [key]);
  return useLaneCatchUpState(key).failure;
}

/* ---- Running a catch-up ---- */

/**
 * "Ask an agent": a chat draft in the lane, never sent. The lane's newest
 * Work chat gets it (it knows the lane's intent); else a new chat in the lane.
 * Every call goes to the lane's machine.
 */
export function useLaneCatchUpAskAgent(pin: OpenProjectBinding | null) {
  const handOff = useLaneChatHandoff(pin, { startDraftInLane: true });
  return useCallback(async (laneId: string, prompt: string, knownChats?: AgentChatSessionSummary[] | null) => {
    const chats = knownChats ?? await window.ade.agentChat
      .list({ laneId, includeArchived: false }, pin)
      .catch((error) => {
        // A new chat in the lane still works; the newest one just isn't reused.
        console.warn("lane_catch_up.chat_list_failed", error);
        return [] as AgentChatSessionSummary[];
      });
    const chat = newestLaneWorkChat(chats);
    handOff({ laneId, sessionId: chat?.sessionId ?? null, prompt });
  }, [handOff, pin]);
}

/** Machines (by pin key; "" for the tab's own) whose ADE predates `git.mergeBaseIn`. */
const mergeUnsupportedHosts = new Set<string>();

/**
 * Whether the lane's machine can run "Merge <base> in". There is no cheap
 * probe, so a machine counts as able until it refuses the action once.
 */
export function laneCatchUpMergeAvailable(pin: OpenProjectBinding | null): boolean {
  return typeof window.ade?.git?.mergeBaseIn === "function" && !mergeUnsupportedHosts.has(pin?.key ?? "");
}

export type LaneCatchUpOutcome =
  | { ok: true; upToDate: boolean }
  | { ok: false; failure: LaneCatchUpFailure };

/**
 * Run a direct catch-up on the lane's machine: the rebase engine
 * (`lanes.rebaseStart`, no push) or `git.mergeBaseIn`. Both undo themselves
 * on a conflict. Marks the lane busy while it runs, records a failure for the
 * lane's overview (its agent prompt is `prompt` plus the error), toasts a
 * success unless `quiet`, and refreshes the lane list it came from. Resolves
 * to null when this lane is already running one.
 */
export async function runLaneCatchUpDirect(args: {
  action: "rebase" | "merge";
  laneId: string;
  pin: OpenProjectBinding | null;
  machineId: string | null;
  laneName: string;
  baseBranch: string;
  prompt: LaneCatchUpPromptInput;
  refreshLanes: () => Promise<unknown>;
  quiet?: boolean;
}): Promise<LaneCatchUpOutcome | null> {
  const { action, laneId, pin, laneName: name } = args;
  const key = laneCatchUpKey(laneId, pin);
  if (readLaneCatchUp(key).busy) return null;
  patchLaneCatchUp(key, { busy: action, failure: null });
  try {
    let upToDate: boolean;
    if (action === "rebase") {
      const start = await window.ade.lanes.rebaseStart({ laneId, pushMode: "none", actor: "user" }, pin);
      const run = start.run;
      if (run.state === "failed" || run.failedLaneId || run.error) {
        const files = run.lanes.find((entry) => entry.laneId === run.failedLaneId)?.conflictingFiles ?? [];
        throw new Error(files.length > 0
          ? `Rebasing onto origin/${args.baseBranch} conflicts in ${files.length} file${files.length === 1 ? "" : "s"} (${files.slice(0, 5).join(", ")}${files.length > 5 ? ", …" : ""}). The rebase was undone; nothing changed.`
          : run.error ?? "Rebase failed.");
      }
      upToDate = run.lanes.every((entry) => entry.status === "skipped");
      if (!args.quiet) {
        showToast({
          tone: "success",
          title: upToDate ? `${name} is already up to date` : `Rebased ${name} onto ${run.baseBranch || args.baseBranch}`,
          message: "Nothing was pushed.",
        });
      }
    } else {
      const result = await window.ade.git.mergeBaseIn({ laneId }, pin);
      upToDate = result.upToDate;
      if (!args.quiet) {
        showToast({
          tone: "success",
          title: result.upToDate ? `${name} is already up to date` : `Merged ${result.mergedRef} into ${name}`,
          message: result.fetched
            ? "Nothing was pushed."
            : `Could not fetch, so the last known ${result.mergedRef} was used. Nothing was pushed.`,
        });
      }
    }
    patchLaneCatchUp(key, { busy: null });
    return { ok: true, upToDate };
  } catch (error) {
    const unsupported = action === "merge" && isUnsupportedAdeActionError(error);
    if (unsupported) mergeUnsupportedHosts.add(pin?.key ?? "");
    const message = unsupported
      ? "The ADE on this lane's machine is too old to merge here. Update it, or ask an agent."
      : stripElectronErrorWrapper(extractError(error));
    const failure: LaneCatchUpFailure = {
      action,
      message,
      laneId,
      pin,
      prompt: { ...args.prompt, failure: { action, error: message } },
    };
    patchLaneCatchUp(key, { busy: null, failure });
    return { ok: false, failure };
  } finally {
    try {
      if (pin) requestCrossMachineLanesForMachine(args.machineId ?? machineIdForBinding(pin));
      else {
        await args.refreshLanes();
        requestLaneRebaseNeedsRescan();
      }
    } catch (error) {
      // The next lane refresh picks it up.
      console.warn("lane_catch_up.refresh_failed", error);
    }
  }
}

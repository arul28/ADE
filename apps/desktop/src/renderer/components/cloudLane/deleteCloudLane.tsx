import { useMemo, useState, useSyncExternalStore } from "react";
import { CloudArrowUp } from "@phosphor-icons/react";
import { cloudWorkLaneName, type CloudLaneDeleteOptions, type CloudLaneWorkLane, type CloudLaneWorkState } from "../../../shared/cloudLaneLife";
import type { OpenProjectBinding } from "../../../shared/types/core";
import { adeCloudLaneComputersNow, useAdeCloudLaneComputers } from "../../state/adeCloudLaneIndex";
import { requestCloudSavedChatsRead, requestCrossMachineLanesForMachine } from "../../state/crossMachineLanes";
import { ipcErrorMessage } from "../../lib/format";
import { READABLE_TOAST_DURATION_MS, dismissToast, getToasts, showToast } from "../app/toast/toastStore";
import { CloudMark, ADE_CLOUD_NAME } from "../remoteTargets/cloudBrand";
import { confirmDialog } from "../ui/dialog";
import { CLOUD_LANE_LIFE_UNAVAILABLE, cloudLaneComputerOfLane, cloudLaneLifeAvailable, cloudLaneWorkState, deleteCloudLane, freeCloudLane, pushCloudLaneWork } from "./cloudLaneActions";
import { refreshCloudLanesWithoutComputer } from "./cloudLaneStores";
import { CloudLaneSavedWork } from "./CloudLaneSavedWork";
import "./cloudLane.css";

/**
 * Where a cloud lane's delete is, by computer, for the surfaces that show the
 * lane (the dashboard's row and its building): `checking` while ADE reads its
 * work, `deleting` once the computer is going, `deleted` once it is gone (kept
 * a short while, so the row leaves at once instead of waiting for the next
 * read of the list). Nothing polls; each delete sets and clears its own entry.
 */
export type CloudLaneDeletePhase = "checking" | "deleting" | "deleted";

let deletes: ReadonlyMap<string, CloudLaneDeletePhase> = new Map();
const deleteListeners = new Set<() => void>();
/** A deleted computer's entry stays this long; the list has dropped it long before. */
const DELETED_KEEP_MS = 60_000;

function setDeletePhase(instanceId: string, phase: CloudLaneDeletePhase | null): void {
  if ((deletes.get(instanceId) ?? null) === phase) return;
  const next = new Map(deletes);
  if (phase) next.set(instanceId, phase);
  else next.delete(instanceId);
  deletes = next;
  for (const listener of deleteListeners) listener();
  if (phase === "deleted") {
    window.setTimeout(() => {
      if (deletes.get(instanceId) === "deleted") setDeletePhase(instanceId, null);
    }, DELETED_KEEP_MS);
  }
}

function subscribeDeletes(listener: () => void): () => void {
  deleteListeners.add(listener);
  return () => {
    deleteListeners.delete(listener);
  };
}
const readDeletes = () => deletes;

/** Every cloud lane delete under way (or just done) in this window, by computer. */
export function useCloudLaneDeletes(): ReadonlyMap<string, CloudLaneDeletePhase> {
  return useSyncExternalStore(subscribeDeletes, readDeletes, readDeletes);
}

/** Drops the progress toast, never a result that already replaced it. */
function dismissProgressToast(toastId: string): void {
  if (getToasts().some((toast) => toast.id === toastId && toast.busy)) dismissToast(toastId);
}

/**
 * Delete a cloud lane: the lane, its computer and its saved chats go
 * together. It is direct, with one exception: when the computer holds work
 * that isn't on GitHub (or ADE couldn't check), it warns first, with "Push all
 * work to GitHub" and "Delete anyway". `keepChats` keeps the saved chats on
 * ADE Cloud to read later; the confirm that `askFirst` shows offers it too.
 *
 * One flow with feedback from the click: on an awake computer the work check
 * starts at once, and the question (`askFirst`) shows at the same moment
 * instead of after the check. The check wakes a sleeping computer, so on one
 * that is not known to be awake it starts only after the yes: a Cancel never
 * spends hours on a wake. One progress toast ("Deleting fix-login…") then turns into the
 * result, and the lane's row says where the delete is (`useCloudLaneDeletes`).
 *
 * Every place that deletes a cloud lane calls this: the dashboard, the Lanes
 * tab, the lane menus on the Work and PRs tabs. Account level, by ADE Cloud
 * id (no pin), through this app's main process.
 *
 * `askFirst`: the caller has no confirm of its own (the dashboard), so a
 * clean lane still gets one plain question. A lane menu already asked.
 *
 * Resolves true when the lane was deleted.
 */
export async function deleteCloudLaneWithCheck(input: CloudLaneDeleteOptions & {
  instanceId: string;
  laneName: string;
  askFirst: boolean;
  /** Runs after a delete that worked (a list refresh, a selection clear). */
  onDeleted?: () => void;
}): Promise<boolean> {
  const { instanceId, laneName } = input;
  const toastId = `cloud-lane-delete:${instanceId}`;
  const fail = (error: unknown) => {
    showToast({
      id: toastId,
      tone: "error",
      title: `Couldn't delete ${laneName}`,
      message: ipcErrorMessage(error) || `${ADE_CLOUD_NAME} didn't answer. Try again in a moment.`,
      durationMs: READABLE_TOAST_DURATION_MS,
      replayMask: { title: true },
    });
    return false;
  };
  // The web app (and an older preload) can't delete a lane's computer: say so before any dialog.
  if (!cloudLaneLifeAvailable()) return fail(new Error(CLOUD_LANE_LIFE_UNAVAILABLE));
  // A second click while one runs: the first one's toast and row already say where it is.
  const phase = deletes.get(instanceId);
  if (phase === "checking" || phase === "deleting") return false;

  const progress = (message: string) => showToast({
    id: toastId,
    tone: "info",
    busy: true,
    title: `Deleting ${laneName}`,
    message,
    durationMs: 0,
    dismissible: false,
    replayMask: { title: true },
  });
  const readWork = (): Promise<CloudLaneWorkState> => cloudLaneWorkState(instanceId).catch((error: unknown) => {
    // The check itself failed: warn as if there were work, never delete blind.
    console.warn("[cloud] checking a lane's work before its delete failed", error);
    return { unpushed: null, unpushedLanes: [], message: ipcErrorMessage(error) || null };
  });

  let deleted = false;
  let keepChats = input.keepChats === true;
  try {
    setDeletePhase(instanceId, "checking");
    // On an awake computer the check runs while the question is up, so a yes
    // rarely waits on it. Anywhere else it would wake the computer, so it waits for the yes.
    const laneComputer = adeCloudLaneComputersNow().find((computer) => computer.instanceId === instanceId) ?? null;
    const awake = laneComputer?.state === "running";
    let checking: Promise<CloudLaneWorkState> | null = awake || !input.askFirst ? readWork() : null;
    if (input.askFirst) {
      const confirmed = await confirmDialog({
        title: `Delete ${laneName}?`,
        message: "ADE deletes the lane, its computer and its chats. If any of its work isn't on GitHub, ADE asks again first.",
        icon: <CloudMark size={16} brand />,
        confirmLabel: "Delete lane",
        destructive: true,
        children: () => <KeepChatsChoice initial={keepChats} onChange={(value) => { keepChats = value; }} />,
      });
      if (!confirmed) return false;
    }

    for (;;) {
      progress("Checking for work that isn't on GitHub…");
      checking ??= readWork();
      const work = await checking;
      if (work.unpushed === false) break;
      dismissToast(toastId);
      let pushFirst = false;
      const confirmed = await confirmDialog({
        title: work.unpushed ? `${laneName} has work that isn't on GitHub` : `ADE couldn't check ${laneName} for unpushed work`,
        message: work.unpushed
          ? "Deleting the lane deletes its computer, and this work goes with it. Push it first, or delete anyway."
          : `${work.message ? `${work.message} ` : ""}Deleting the lane deletes its computer. Work that isn't pushed goes with it.`,
        icon: <CloudMark size={16} brand />,
        tone: "warning",
        size: "md",
        confirmLabel: "Delete anyway",
        destructive: true,
        children: ({ dismiss }) => (
          <div className="adecl-delete-body">
            {work.unpushedLanes.length ? <UnpushedList lanes={work.unpushedLanes} /> : null}
            {/* The work ADE Cloud saved at its last rest: a download with no wake, also at 0 hours. */}
            {laneComputer ? <CloudLaneSavedWork laneId={laneComputer.laneId} laneName={laneName} /> : null}
            <button
              type="button"
              className="kit-btn"
              data-size="sm"
              onClick={() => {
                pushFirst = true;
                dismiss();
              }}
            >
              <CloudArrowUp size={13} />
              Push all work to GitHub
            </button>
            <p className="adecl-delete-note">ADE pushes every lane&apos;s work on this computer, then deletes the lane.</p>
          </div>
        ),
      });
      if (!pushFirst) {
        if (!confirmed) return false;
        break;
      }
      progress("Pushing its work to GitHub…");
      try {
        await pushCloudLaneWork(instanceId);
      } catch (error) {
        showToast({
          id: toastId,
          tone: "error",
          title: `Kept ${laneName}`,
          message: `${ipcErrorMessage(error) || "ADE couldn't push the work."} The lane and its computer stay.`,
          durationMs: READABLE_TOAST_DURATION_MS,
          replayMask: { title: true },
        });
        return false;
      }
      // Pushed: check once more, so nothing new since slips through.
      checking = readWork();
    }

    setDeletePhase(instanceId, "deleting");
    progress("Deleting its computer…");
    const done = await deleteCloudLane(instanceId, { skipCheck: true, keepChats });
    if (!done.ok) return fail(new Error(done.message));
    deleted = true;
    setDeletePhase(instanceId, "deleted");
    const { chatsKept } = done;
    showToast({
      id: toastId,
      tone: chatsKept && !keepChats ? "warning" : "success",
      title: `Deleted ${laneName}`,
      message: keepChats
        ? "The lane and its computer are gone. Its chats stay in Work to read."
        : chatsKept
          ? "The lane and its computer are gone. ADE couldn't delete all its chats; remove the rest in Work."
          : "The lane, its computer and its chats are gone.",
      durationMs: chatsKept && !keepChats ? READABLE_TOAST_DURATION_MS : undefined,
      replayMask: { title: true },
    });
    // Its chats went, or move to the lanes without a computer: the list says so now, not after its 30 s wait.
    requestCloudSavedChatsRead();
    input.onDeleted?.();
    return true;
  } catch (error) {
    return fail(error);
  } finally {
    if (!deleted) {
      setDeletePhase(instanceId, null);
      dismissProgressToast(toastId);
    }
  }
}

/**
 * "Keep the lane, free its computer": asks once, then ADE pushes the work,
 * removes the computer and keeps the lane with its chats. The next message
 * makes a new computer. The ADE Cloud page and Manage lane both call this.
 * Resolves true when the computer was freed.
 */
export async function freeCloudLaneWithConfirm(input: { instanceId: string; laneName: string; onDone?: () => void }): Promise<boolean> {
  const { instanceId, laneName } = input;
  const ok = await confirmDialog({
    title: `Free the computer of ${laneName}?`,
    message: "ADE pushes its work to GitHub, then removes the computer. The lane and its chats stay. Your next message makes a new computer.",
    icon: <CloudMark size={16} brand />,
    confirmLabel: "Free the computer",
    cancelLabel: "Cancel",
  });
  if (!ok) return false;
  // Waking it, pushing and removing it take minutes: say so until it ends, as a delete does.
  const toastId = `cloud-lane-free:${instanceId}`;
  showToast({
    id: toastId,
    tone: "info",
    busy: true,
    title: `Freeing ${laneName}'s computer`,
    message: "ADE pushes its work to GitHub, then removes the computer. This can take a few minutes.",
    durationMs: 0,
    dismissible: false,
    replayMask: { title: true },
  });
  try {
    const done = await freeCloudLane(instanceId);
    showToast({ id: toastId, tone: done.ok ? "success" : "error", title: done.ok ? `Freed ${laneName}'s computer` : `Kept ${laneName}'s computer`, message: done.message, durationMs: done.ok ? undefined : READABLE_TOAST_DURATION_MS, replayMask: { title: true } });
    return done.ok;
  } catch (error) {
    showToast({ id: toastId, tone: "error", title: `Couldn't free ${laneName}'s computer`, message: ipcErrorMessage(error) || "Try again in a moment.", durationMs: READABLE_TOAST_DURATION_MS, replayMask: { title: true } });
    return false;
  } finally {
    input.onDone?.();
    refreshCloudLanesWithoutComputer();
  }
}

/**
 * The lane hosts' (Lanes tab, Work and PRs lane menus) view of ADE Cloud lanes:
 * whether a lane lives on its own ADE Cloud computer, and its delete. It
 * follows the lane computer index, so a component re-renders as reads arrive.
 */
export function useCloudLaneDelete() {
  const { computers } = useAdeCloudLaneComputers();
  return useMemo(() => {
    const computerOf = (pin: OpenProjectBinding | null | undefined, laneId: string) => cloudLaneComputerOfLane(pin, laneId, computers);
    return {
      computerOf,
      isCloudLane: (pin: OpenProjectBinding | null | undefined, laneId: string): boolean => computerOf(pin, laneId) != null,
      /**
       * Starts the cloud delete (warned only when work isn't on GitHub) when the
       * lane is an ADE Cloud lane, then re-reads `machineId`'s lanes. False for
       * any other lane, which the caller deletes the usual way.
       */
      deleteIfCloudLane: (input: CloudLaneDeleteOptions & {
        pin: OpenProjectBinding | null | undefined;
        laneId: string;
        laneName: string;
        machineId: string | null;
        onDeleted?: () => void;
      }): boolean => {
        const cloudLane = computerOf(input.pin, input.laneId);
        if (!cloudLane) return false;
        void deleteCloudLaneWithCheck({
          instanceId: cloudLane.instanceId,
          laneName: input.laneName,
          askFirst: false,
          keepChats: input.keepChats,
          onDeleted: () => {
            if (input.machineId) requestCrossMachineLanesForMachine(input.machineId);
            input.onDeleted?.();
          },
        });
        return true;
      },
    };
  }, [computers]);
}

/** "Keep its chats": off by default, so a deleted lane leaves nothing behind. */
export function KeepChatsCheckbox({ checked, disabled, onChange }: { checked: boolean; disabled?: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="adecl-keep-chats">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        Keep its chats to read later
        <span className="adecl-muted">They stay in Work under the lanes without a computer.</span>
      </span>
    </label>
  );
}

/** The box in a confirm dialog: it holds its own tick and reports each change. */
function KeepChatsChoice({ initial, onChange }: { initial: boolean; onChange: (value: boolean) => void }) {
  const [checked, setChecked] = useState(initial);
  return <KeepChatsCheckbox checked={checked} onChange={(value) => { setChecked(value); onChange(value); }} />;
}

function UnpushedList({ lanes }: { lanes: readonly CloudLaneWorkLane[] }) {
  return (
    <ul className="adecl-unpushed">
      {lanes.map((lane) => (
        <li key={lane.laneId}>
          <b>{cloudWorkLaneName(lane)}</b>
          <span>{unpushedText(lane)}</span>
        </li>
      ))}
    </ul>
  );
}

function unpushedText(lane: CloudLaneWorkLane): string {
  const parts: string[] = [];
  if (lane.dirty) parts.push("changes not committed");
  if (lane.ahead > 0) parts.push(`${lane.ahead} commit${lane.ahead === 1 ? "" : "s"} not pushed`);
  // `failed` with nothing counted is a lane push-work couldn't read (or fetch for), not a push.
  if (lane.state === "failed") parts.push(lane.dirty || lane.ahead > 0 ? "the last push failed" : "ADE couldn't read this lane's work");
  return parts.length ? parts.join(", ") : "work not pushed";
}

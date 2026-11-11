import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CloudTierId } from "../../../shared/cloudTiers";
import { useAppStore, useAppStoreApi, type WorkDraftCloudTarget } from "../../state/appStore";

function sameDraftCloudTarget(a: WorkDraftCloudTarget | null, b: WorkDraftCloudTarget | null): boolean {
  if (!a || !b) return a === b;
  if (a.provider === "ade" && b.provider === "ade") return a.laneId === b.laneId && a.sizeId === b.sizeId;
  return a.provider === b.provider;
}

/**
 * A cloud picked in the Work draft's Run on menu (ADE Cloud with its lane and
 * size, Cursor Cloud, Devin Cloud) is kept with the draft's machine pick
 * (`draftCloudTarget` beside `draftMachineId` in Work's view state), so leaving
 * the draft and coming back shows the same pick. Only the draft surface that
 * keeps its machine pick (`keeps`) keeps this one.
 *
 * The saved pick is read and written through the project's own store (the one
 * in context), never the root store, which holds only the copy loaded at
 * startup.
 *
 * Every place the person picks a machine or a cloud calls `markChosen()`
 * before setting its state: a saved pick still waiting to be put back must not
 * replace that choice, and the choice is saved even while Cursor or Devin
 * Cloud's gate is closed.
 */
export function useDraftCloudPick({
  projectKey,
  keeps,
  adePicked,
  adeLaneId,
  adeSizeId,
  cursorPicked,
  devinPicked,
  cursorCanLaunch,
  devinCanLaunch,
  apply,
}: {
  projectKey: string | null;
  keeps: boolean;
  adePicked: boolean;
  adeLaneId: string | null;
  adeSizeId: CloudTierId | null;
  cursorPicked: boolean;
  devinPicked: boolean;
  cursorCanLaunch: boolean;
  devinCanLaunch: boolean;
  /** Puts a saved pick back on the draft. Cursor and Devin come only once they can launch. */
  apply: (saved: WorkDraftCloudTarget) => void;
}): { markChosen: () => void } {
  const appStoreApi = useAppStoreApi();
  const setWorkViewState = useAppStore((s) => s.setWorkViewState);
  /**
   * The project key the saved pick was put back for (or the person picked
   * over it). Until then nothing is written, so the first render's "no cloud"
   * never overwrites the saved pick.
   */
  const restoredKeyRef = useRef<string | null>(null);
  /** The next save follows a pick by the person, not a gate dropping Cursor or Devin. */
  const personPickedRef = useRef(false);
  // A pick that changes no state here (This computer while the draft already
  // shows no cloud) still has to reach the save.
  const [chosenSeq, setChosenSeq] = useState(0);
  const markChosen = useCallback(() => {
    restoredKeyRef.current = projectKey;
    personPickedRef.current = true;
    setChosenSeq((seq) => seq + 1);
  }, [projectKey]);

  const current = useMemo<WorkDraftCloudTarget | null>(() => (
    adePicked
      ? { provider: "ade", laneId: adeLaneId, sizeId: adeSizeId }
      : cursorPicked
        ? { provider: "cursor" }
        : devinPicked
          ? { provider: "devin" }
          : null
  ), [adeLaneId, adePicked, adeSizeId, cursorPicked, devinPicked]);

  useEffect(() => {
    if (!keeps || !projectKey) return;
    if (restoredKeyRef.current === projectKey) return;
    const saved = appStoreApi.getState().getWorkViewState(projectKey).draftCloudTarget;
    // ADE Cloud's pick is put back at once: it takes effect only while access
    // says so. Cursor and Devin Cloud are put back once they can be picked
    // here (sign-in read); until then the saved pick waits, untouched.
    if (saved?.provider === "cursor" && !cursorCanLaunch) return;
    if (saved?.provider === "devin" && !devinCanLaunch) return;
    if (saved) apply(saved);
    restoredKeyRef.current = projectKey;
  }, [appStoreApi, apply, cursorCanLaunch, devinCanLaunch, keeps, projectKey]);

  useEffect(() => {
    const byPerson = personPickedRef.current;
    personPickedRef.current = false;
    if (!keeps || !projectKey) return;
    if (restoredKeyRef.current !== projectKey) return;
    const saved = appStoreApi.getState().getWorkViewState(projectKey).draftCloudTarget;
    if (sameDraftCloudTarget(saved, current)) return;
    // A Cursor or Devin pick dropped because that cloud can't be picked here
    // right now (sign-in, a chat that already started) was dropped by its
    // gate, not by the person: the saved pick stays for when it can.
    if (!byPerson && !current && (
      (saved?.provider === "cursor" && !cursorCanLaunch)
      || (saved?.provider === "devin" && !devinCanLaunch)
    )) return;
    setWorkViewState(projectKey, { draftCloudTarget: current });
  }, [appStoreApi, chosenSeq, current, cursorCanLaunch, devinCanLaunch, keeps, projectKey, setWorkViewState]);

  return { markChosen };
}

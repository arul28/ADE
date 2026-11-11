import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type CloudMachine } from "../../../shared/adeCloud";
import { CLOUD_READY_WAKE_WAIT_MS } from "../../../shared/cloudReady";
import { githubRepoOf } from "../../../shared/cloudLaneLaunch";
import { ipcErrorMessage } from "../../lib/format";
import { useAdeCloudEnabled } from "../../state/cloudAccess";
import { connectWithRetry } from "./connectWithRetry";
import { withoutAdeCloudLaneComputers, type LaneMachineOption } from "../lanes/laneMachines";
import type { AdeCloudLaneComputer } from "../../state/adeCloudLaneIndex";
import type { DraftMachineOption } from "./DraftMachinePicker";

const CLONE_ROW_PREFIX = "__ade_clone__:";
const WAKE_ROW_PREFIX = "__ade_wake__:";
const CONNECT_RETRY_MS = 2_000;
/** A machine that has the repository shows up among the picker's machines within a moment; past this it isn't coming. */
const SELECT_WAIT_MS = 20_000;

export type OfflineDraftMachine = { targetId: string; name: string; machineKey: string | null };

/** The machine (remote target id) a clone row stands for, or null for any other row. */
export function draftCloneRowTargetId(rowId: string): string | null {
  return rowId.startsWith(CLONE_ROW_PREFIX) ? rowId.slice(CLONE_ROW_PREFIX.length) : null;
}

type Busy = { targetId: string; name: string; phase: "waking" | "cloning" | "selecting" };

/** `https://github.com/owner/repo.git` for a GitHub origin, else null: only GitHub repositories are set up on another machine. */
function githubCloneUrl(originUrl: string | null): { url: string; repo: string } | null {
  const repo = githubRepoOf(originUrl);
  return repo ? { url: `https://github.com/${repo.owner}/${repo.repo}.git`, repo: repo.repo } : null;
}

/**
 * Picker rows for machines that need one step before a chat can start there:
 *
 * - a connected machine without this repository (a new cloud machine never has
 *   it): "Clone the project here". Picking it clones the repository there with
 *   that machine's own Git sign-in (nothing travels from this computer), then
 *   selects it.
 * - a cloud machine of the account that is not connected (asleep, or not
 *   connected from this window): picking it wakes and connects it, clones the
 *   repository when it is missing, then selects it.
 *
 * Every call goes to the picked machine's own connection (its target id); the
 * the provider list is account-level and takes no pin.
 */
export function useDraftMachineSetup({
  enabled,
  originUrl,
  cloudMachines,
  laneComputers,
  cloneCandidates,
  offlineMachines,
  selectableMachineIds,
  onMachineReady,
  onNotice,
}: {
  enabled: boolean;
  originUrl: string | null;
  /**
   * The account's computers, from the shared read that runs while the draft
   * shows (`useCloudMachines`). The wake rows come from it, so they are in
   * the menu when it opens instead of arriving after.
   */
  cloudMachines: readonly CloudMachine[];
  /** ADE Cloud lane computers: the picker lists them under ADE Cloud, so no row of their own here. */
  laneComputers: readonly AdeCloudLaneComputer[];
  /** Connected machines without this repository. */
  cloneCandidates: readonly LaneMachineOption[];
  /** Saved paired machines that are not connected now. */
  offlineMachines: readonly OfflineDraftMachine[];
  /** The ids the picker can select right now. */
  selectableMachineIds: readonly string[];
  onMachineReady: (machineId: string) => void;
  onNotice: (notice: { message: string; kind: "hint" | "status" } | null) => void;
}) {
  // Stable for one origin, so the effects below don't restart on each render.
  const cloudEnabled = useAdeCloudEnabled();
  const clone = useMemo(() => githubCloneUrl(originUrl), [originUrl]);
  const [busy, setBusy] = useState<Busy | null>(null);
  /** Prepared (connected, repository there): selected as soon as the picker lists it. */
  const [pendingTargetId, setPendingTargetId] = useState<string | null>(null);
  const attemptRef = useRef(0);

  const cloudOffline = useMemo(() => {
    if (!enabled || !cloudEnabled) return [];
    const byKey = new Map(cloudMachines.filter((machine) => machine.machineKey).map((machine) => [machine.machineKey!, machine]));
    return withoutAdeCloudLaneComputers(offlineMachines, laneComputers).flatMap((machine) => {
      const cloud = machine.machineKey ? byKey.get(machine.machineKey) : null;
      if (!cloud || cloud.state === "deleting" || cloud.state === "error") return [];
      return [{ ...machine, asleep: cloud.state === "asleep" || cloud.state === "stopped" }];
    });
  }, [cloudEnabled, cloudMachines, enabled, laneComputers, offlineMachines]);

  const cloneRepository = useCallback(async (targetId: string, name: string, stillWanted: () => boolean) => {
    if (!clone) throw new Error(`${name} doesn't have this repository, and ADE sets up GitHub repositories only. Clone it there by hand.`);
    const remoteRuntime = window.ade.remoteRuntime;
    setBusy({ targetId, name, phase: "cloning" });
    onNotice({ message: `Cloning ${clone.repo} on ${name}…`, kind: "status" });
    const parentDir = await remoteRuntime.getDefaultParentDir(targetId);
    if (!stillWanted()) return;
    // That machine's own Git sign-in: no credential from this computer goes with it.
    await remoteRuntime.cloneProject(targetId, { url: clone.url, parentDir, name: clone.repo }, { credentialMode: "destination_only" });
    if (stillWanted()) setBusy({ targetId, name, phase: "selecting" });
  }, [clone, onNotice]);

  const prepare = useCallback(async (targetId: string, name: string) => {
    const attempt = ++attemptRef.current;
    const stillWanted = () => attemptRef.current === attempt;
    setPendingTargetId(null);
    try {
      if (selectableMachineIds.includes(targetId)) {
        onNotice(null);
        onMachineReady(targetId);
        return;
      }
      if (!cloneCandidates.some((option) => option.targetId === targetId)) {
        // Not connected: connecting wakes an asleep cloud machine first.
        setBusy({ targetId, name, phase: "waking" });
        onNotice({ message: `Waking ${name}…`, kind: "status" });
        const { value: connected, lastError } = await connectWithRetry({
          connect: () => window.ade.remoteRuntime.connect(targetId),
          stillWanted,
          waitMs: CLOUD_READY_WAKE_WAIT_MS,
          retryMs: CONNECT_RETRY_MS,
        });
        if (!stillWanted()) return;
        if (!connected) {
          const reason = lastError ? ipcErrorMessage(lastError) : "";
          throw new Error(`ADE couldn't connect to ${name}${reason ? `: ${reason}` : "."}`);
        }
        // Its projects arrive with the connection: the effect below clones or selects.
        setPendingTargetId(targetId);
        return;
      }
      await cloneRepository(targetId, name, stillWanted);
      if (stillWanted()) setPendingTargetId(targetId);
    } catch (error) {
      if (!stillWanted()) return;
      setBusy(null);
      onNotice({ message: ipcErrorMessage(error) || `ADE couldn't set up ${name}.`, kind: "status" });
    }
  }, [cloneCandidates, cloneRepository, onMachineReady, onNotice, selectableMachineIds]);

  // A prepared machine: selected once the picker lists it, cloned first when it
  // connected without the repository.
  useEffect(() => {
    if (!pendingTargetId) return;
    if (selectableMachineIds.includes(pendingTargetId)) {
      setPendingTargetId(null);
      setBusy(null);
      onNotice(null);
      onMachineReady(pendingTargetId);
      return;
    }
    // A clone takes as long as it takes (a big repository, half a minute).
    if (busy?.phase === "cloning") return;
    const needsClone = cloneCandidates.find((option) => option.targetId === pendingTargetId);
    if (needsClone && busy?.phase !== "selecting") {
      const attempt = attemptRef.current;
      const name = needsClone.name;
      void cloneRepository(pendingTargetId, name, () => attemptRef.current === attempt).catch((error: unknown) => {
        if (attemptRef.current !== attempt) return;
        setPendingTargetId(null);
        setBusy(null);
        onNotice({ message: ipcErrorMessage(error) || `ADE couldn't clone the project on ${name}.`, kind: "status" });
      });
      return;
    }
    const timer = window.setTimeout(() => {
      setPendingTargetId(null);
      setBusy(null);
      onNotice({ message: "ADE set the machine up but couldn't offer it here. Open the picker again.", kind: "status" });
    }, SELECT_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [busy?.phase, cloneCandidates, cloneRepository, onMachineReady, onNotice, pendingTargetId, selectableMachineIds]);

  /** The person picked another machine, or the draft launched: stop following this one. */
  const abandon = useCallback(() => {
    attemptRef.current += 1;
    setPendingTargetId(null);
    setBusy(null);
  }, []);

  useEffect(() => {
    if (!enabled) abandon();
  }, [abandon, enabled]);

  const rows = useMemo<DraftMachineOption[]>(() => {
    const busyDetail = (targetId: string) =>
      busy?.targetId === targetId ? (busy.phase === "waking" ? "Waking…" : busy.phase === "cloning" ? "Cloning the project…" : "Opening…") : null;
    return [
      ...cloneCandidates.map((option) => ({
        id: `${CLONE_ROW_PREFIX}${option.targetId}`,
        name: option.name,
        detail: busyDetail(option.targetId!) ?? "Clone the project here",
        unavailableReason: clone ? null : "ADE sets up GitHub repositories only. Clone it there by hand.",
      })),
      ...cloudOffline.map((machine) => ({
        id: `${WAKE_ROW_PREFIX}${machine.targetId}`,
        name: machine.name,
        kind: "cloud" as const,
        cloudProvider: "cloud" as const,
        detail: busyDetail(machine.targetId) ?? (machine.asleep ? "Asleep · wakes when picked" : "Connects when picked"),
      })),
    ];
  }, [busy, clone, cloneCandidates, cloudOffline]);

  /** Whether `rowId` is one of these rows; `choose` then starts its step. */
  const owns = useCallback((rowId: string) => rowId.startsWith(CLONE_ROW_PREFIX) || rowId.startsWith(WAKE_ROW_PREFIX), []);
  const choose = useCallback((rowId: string) => {
    const targetId = rowId.slice(rowId.startsWith(CLONE_ROW_PREFIX) ? CLONE_ROW_PREFIX.length : WAKE_ROW_PREFIX.length);
    const name = rows.find((row) => row.id === rowId)?.name ?? targetId;
    void prepare(targetId, name);
  }, [prepare, rows]);

  return {
    rows,
    owns,
    choose,
    /** Sets up and selects a machine by its target id (a new machine ADE just connected). */
    prepare,
    abandon,
    /** The row to show as the choice while a step runs. */
    busyRowId: busy
      ? `${cloneCandidates.some((option) => option.targetId === busy.targetId) ? CLONE_ROW_PREFIX : WAKE_ROW_PREFIX}${busy.targetId}`
      : null,
  };
}

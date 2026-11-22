import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { githubRepoOf } from "../../../shared/cloudLaneLaunch";
import type { RemoteRuntimeConnectionStatus } from "../../../shared/types/remoteRuntime";
import { repoKeyForUrl } from "../projects/projectCopies";
import { ipcErrorMessage } from "../../lib/format";
import type { LaneMachineOption } from "../lanes/laneMachines";
import type { DraftMachineOption } from "./DraftMachinePicker";

const CLONE_ROW_PREFIX = "__ade_clone__:";
/** A machine that has the repository shows up among the picker's machines within a moment; past this it isn't coming. */
const SELECT_WAIT_MS = 20_000;

/** The machine (remote target id) a clone row stands for, or null for any other row. */
export function draftCloneRowTargetId(rowId: string): string | null {
  return rowId.startsWith(CLONE_ROW_PREFIX) ? rowId.slice(CLONE_ROW_PREFIX.length) : null;
}

type Busy = { targetId: string; name: string; phase: "cloning" | "selecting" };

/** `https://github.com/owner/repo.git` for a GitHub origin, else null: only GitHub repositories are set up on another machine. */
function githubCloneUrl(originUrl: string | null): { url: string; repoName: string; repoKey: string } | null {
  const repo = githubRepoOf(originUrl);
  if (!repo) return null;
  const url = `https://github.com/${repo.owner}/${repo.repo}.git`;
  const repoKey = repoKeyForUrl(url);
  return repoKey ? { url, repoName: repo.repo, repoKey } : null;
}

/**
 * Picker rows for machines that need one step before a chat can start there:
 * a connected machine of the person's own without this repository, "Clone the
 * project here". Picking it clones the repository there with that machine's
 * own Git sign-in (nothing travels from this computer), then selects it.
 *
 * No ADE Cloud computer gets a row of its own: ADE Cloud is one Run on entry
 * (`useAdeCloudDraft`), and the caller leaves cloud computers out of the
 * candidates.
 *
 * Every call goes to the picked machine's own connection (its target id).
 */
export function useDraftMachineSetup({
  enabled,
  originUrl,
  cloneCandidates,
  selectableMachineIds,
  connections,
  onMachineReady,
  onNotice,
}: {
  enabled: boolean;
  originUrl: string | null;
  /** Connected machines of the person's own without this repository (no ADE Cloud computer). */
  cloneCandidates: readonly LaneMachineOption[];
  /** The ids the picker can select right now. */
  selectableMachineIds: readonly string[];
  /** The connected machines: the clone dialog lists the projects already on its machine. */
  connections: readonly RemoteRuntimeConnectionStatus[];
  onMachineReady: (machineId: string) => void;
  onNotice: (notice: { message: string; kind: "hint" | "status" } | null) => void;
}) {
  // Stable for one origin, so the effects below don't restart on each render.
  const clone = useMemo(() => githubCloneUrl(originUrl), [originUrl]);
  const [busy, setBusy] = useState<Busy | null>(null);
  /** Prepared (connected, repository there): selected as soon as the picker lists it. */
  const [pendingTargetId, setPendingTargetId] = useState<string | null>(null);
  const attemptRef = useRef(0);
  /**
   * The clone dialog for a machine with no copy yet: the person picks the
   * folder, the clone runs as the first step (`startCopyJob`), then the
   * machine is selected and, when asked, the draft is sent.
   */
  const [cloneDialog, setCloneDialog] = useState<{ targetId: string; name: string } | null>(null);
  /** The folders of the projects already on the clone dialog's machine (it suggests one beside them). */
  const cloneOtherPaths = useMemo(
    () => (cloneDialog
      ? connections.find((connection) => connection.target.id === cloneDialog.targetId)?.projects.map((project) => project.rootPath) ?? []
      : []),
    [cloneDialog, connections],
  );
  const sendAfterRef = useRef<string | null>(null);

  const cloneRepository = useCallback(async (targetId: string, name: string, stillWanted: () => boolean) => {
    if (!clone) throw new Error(`${name} doesn't have this repository, and ADE sets up GitHub repositories only. Clone it there by hand.`);
    const remoteRuntime = window.ade.remoteRuntime;
    setBusy({ targetId, name, phase: "cloning" });
    onNotice({ message: `Cloning ${clone.repoName} on ${name}…`, kind: "status" });
    const parentDir = await remoteRuntime.getDefaultParentDir(targetId);
    if (!stillWanted()) return;
    // That machine's own Git sign-in: no credential from this computer goes with it.
    await remoteRuntime.cloneProject(targetId, { url: clone.url, parentDir, name: clone.repoName }, { credentialMode: "destination_only" });
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
      await cloneRepository(targetId, name, stillWanted);
      if (stillWanted()) setPendingTargetId(targetId);
    } catch (error) {
      if (!stillWanted()) return;
      setBusy(null);
      onNotice({ message: ipcErrorMessage(error) || `ADE couldn't set up ${name}.`, kind: "status" });
    }
  }, [cloneRepository, onMachineReady, onNotice, selectableMachineIds]);

  // A prepared machine: selected once the picker lists it.
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
    const timer = window.setTimeout(() => {
      sendAfterRef.current = null;
      setPendingTargetId(null);
      setBusy(null);
      onNotice({ message: "ADE set the machine up but couldn't offer it here. Open the picker again.", kind: "status" });
    }, SELECT_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [busy?.phase, onMachineReady, onNotice, pendingTargetId, selectableMachineIds]);

  /** The person picked another machine, or the draft launched: stop following this one. */
  const abandon = useCallback(() => {
    attemptRef.current += 1;
    sendAfterRef.current = null;
    setPendingTargetId(null);
    setBusy(null);
  }, []);

  useEffect(() => {
    if (!enabled) abandon();
  }, [abandon, enabled]);

  /** The copy is there: select the machine once the picker lists it, then send. */
  const cloneDialogReady = useCallback((targetId: string, name: string, options: { send: boolean }) => {
    attemptRef.current += 1;
    sendAfterRef.current = options.send ? targetId : null;
    setCloneDialog(null);
    setBusy({ targetId, name, phase: "selecting" });
    setPendingTargetId(targetId);
  }, []);
  /** The machine the last clone dialog asked to send to, once (then cleared). */
  const takeSendAfter = useCallback((machineId: string): boolean => {
    if (sendAfterRef.current !== machineId) return false;
    sendAfterRef.current = null;
    return true;
  }, []);

  const rows = useMemo<DraftMachineOption[]>(() => {
    const busyDetail = (targetId: string) =>
      busy?.targetId === targetId ? (busy.phase === "cloning" ? "Cloning the project…" : "Opening…") : null;
    return cloneCandidates.map((option) => ({
      id: `${CLONE_ROW_PREFIX}${option.targetId}`,
      name: option.name,
      detail: busyDetail(option.targetId!) ?? "No copy yet",
      unavailableReason: clone ? null : "ADE sets up GitHub repositories only. Clone it there by hand.",
    }));
  }, [busy, clone, cloneCandidates]);

  /** Whether `rowId` is one of these rows; `choose` then starts its step. */
  const owns = useCallback((rowId: string) => rowId.startsWith(CLONE_ROW_PREFIX), []);
  const choose = useCallback((rowId: string) => {
    const targetId = rowId.slice(CLONE_ROW_PREFIX.length);
    const name = rows.find((row) => row.id === rowId)?.name ?? targetId;
    // A connected machine with no copy: the person picks the folder first.
    if (clone) {
      // A step still running for the last pick stops here.
      attemptRef.current += 1;
      setPendingTargetId(null);
      setBusy(null);
      setCloneDialog({ targetId, name });
      return;
    }
    void prepare(targetId, name);
  }, [clone, prepare, rows]);

  return {
    rows,
    owns,
    choose,
    /** The clone dialog to show (a machine with no copy yet), with what it clones. */
    cloneDialog: cloneDialog && clone ? { ...cloneDialog, ...clone, otherProjectPaths: cloneOtherPaths } : null,
    closeCloneDialog: () => setCloneDialog(null),
    cloneDialogReady,
    takeSendAfter,
    abandon,
    /** The row to show as the choice while a step runs. */
    busyRowId: busy ? `${CLONE_ROW_PREFIX}${busy.targetId}` : null,
  };
}

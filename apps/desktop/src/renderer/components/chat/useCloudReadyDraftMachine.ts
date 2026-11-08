import { useCallback, useEffect, useRef, useState } from "react";
import { CLOUD_JOIN_WATCH_MS, type CloudCreateMachineResult, type CloudStatus } from "../../../shared/adeCloud";
import { CLOUD_READY_WAKE_WAIT_MS, type CloudReadyProjectStatus } from "../../../shared/cloudReady";
import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import { captureError } from "../../../shared/sentry/capture";
import { ipcErrorMessage } from "../../lib/format";
import type { DraftMachineOption } from "./DraftMachinePicker";
import { connectWithRetry } from "./connectWithRetry";

/** The picker row for this project's ready cloud machine. */
export const CLOUD_READY_MACHINE_ID = "__ade_cloud_ready__";
/** The picker row that makes a new cloud machine for this chat (no ready machine for the project). */
export const CLOUD_NEW_MACHINE_ID = "__ade_cloud_new__";
/** The same row while the provider is not connected: picking it opens the provider page to connect a key. */
export const CLOUD_CONNECT_ID = "__ade_cloud_connect__";

const CONNECT_RETRY_MS = 1_500;

/** Pairs this window with the account machine and connects; its target id once connected. */
async function pairAndConnect(machineKey: string): Promise<string | null> {
  const paired = await window.ade.account.pairMachine(machineKey);
  return (await window.ade.remoteRuntime.connect(paired.targetId)) ? paired.targetId : null;
}
/** A connected machine shows up among the picker's machines within a moment; past this it isn't coming. */
const SELECT_WAIT_MS = 20_000;

/**
 * "the provider · ready" in the new-chat machine picker: this project's prepared,
 * sleeping cloud machine. Picking it claims and wakes it at once, so the wake
 * overlaps the typing; ADE then pairs and connects to it and selects it like
 * any other machine, and the chat launches there through the ordinary path.
 * Picking another machine before it is selected gives the claim back (ready
 * again, asleep), so an abandoned wake does not leave it billing.
 *
 * Account-level calls only (the provider pool, the account's machine list,
 * this desktop's connections), so nothing here takes a pin; once selected, the
 * machine's own connection carries every call to it.
 */
export function useCloudReadyDraftMachine({
  enabled,
  originUrl,
  pickerOpened,
  connectedMachineIds,
  onMachineReady,
  onNotice,
}: {
  enabled: boolean;
  originUrl: string | null;
  /** Read the pool only once the person opened the picker. */
  pickerOpened: boolean;
  /** The ids the picker can select right now (connected machines). */
  connectedMachineIds: readonly string[];
  /** The woken machine is connected: select it. */
  onMachineReady: (machineId: string) => void;
  onNotice: (notice: { message: string; kind: "hint" | "status" } | null) => void;
}) {
  const bridge = window.ade.cloud;
  const identity = normalizeGitRemoteIdentity(originUrl);
  const [project, setProject] = useState<CloudReadyProjectStatus | null>(null);
  /**
   * The machine on its way to being the selection, until it is selected or
   * given back: this project's ready machine being woken, or one this chat
   * just made. Each flow has its own words.
   */
  const [waking, setWaking] = useState<{ flow: "ready" | "new"; name: string } | null>(null);
  const [pendingTargetId, setPendingTargetId] = useState<string | null>(null);
  /** the provider's connection, read once the picker opens: the row shows only while a key works. */
  const [cloudStatus, setCloudStatus] = useState<CloudStatus | null>(null);
  /** The New cloud machine form is open. */
  const [creating, setCreating] = useState(false);
  const attemptRef = useRef(0);
  const claimingRef = useRef(false);
  /** The claim not yet selected: what `abandon` gives back. */
  const unusedClaimRef = useRef<{ instanceId: string; claimToken: string } | null>(null);

  useEffect(() => {
    if (!enabled || !pickerOpened || !identity || !bridge?.readyStatus) return;
    let cancelled = false;
    const apply = (status: { projects: CloudReadyProjectStatus[] } | null) => {
      if (cancelled || !status) return;
      setProject(status.projects.find((entry) => entry.settings.identity === identity) ?? null);
    };
    void bridge.readyStatus().then(apply, () => undefined);
    const off = bridge.onReadyStatus?.(apply);
    return () => {
      cancelled = true;
      off?.();
    };
  }, [bridge, enabled, identity, pickerOpened]);

  useEffect(() => {
    if (!enabled || !pickerOpened || !bridge?.getStatus) return;
    let cancelled = false;
    const read = () => {
      void bridge.getStatus().then((next) => { if (!cancelled) setCloudStatus(next); }, () => undefined);
    };
    read();
    const off = bridge.onStatusChanged?.(read);
    return () => {
      cancelled = true;
      off?.();
    };
  }, [bridge, enabled, pickerOpened]);

  // Selected once its connection shows up among the picker's machines; from
  // then on it is the person's machine, never given back from here.
  useEffect(() => {
    if (!pendingTargetId || !connectedMachineIds.includes(pendingTargetId)) return;
    unusedClaimRef.current = null;
    setPendingTargetId(null);
    setWaking(null);
    onNotice(null);
    onMachineReady(pendingTargetId);
  }, [connectedMachineIds, onMachineReady, onNotice, pendingTargetId]);

  /** Hands an unselected claim back: tagged ready again and put back to sleep. */
  const giveBack = useCallback(() => {
    const claim = unusedClaimRef.current;
    unusedClaimRef.current = null;
    if (!claim || !bridge?.readyRelease) return;
    void bridge.readyRelease(claim.instanceId, claim.claimToken).catch((error: unknown) => {
      // It stays claimed and awake; its row under Your computers can sleep it.
      captureError(error, { fingerprint: ["cloud", "ready_release"], handled: true });
    });
  }, [bridge]);

  // Connected but never listed among the picker's machines: say so, and give
  // a ready machine back. A machine this chat made stays the person's.
  const wakingFlow = waking?.flow ?? null;
  const wakingName = waking?.name ?? null;
  useEffect(() => {
    if (!pendingTargetId) return;
    const timer = window.setTimeout(() => {
      setPendingTargetId(null);
      setWaking(null);
      giveBack();
      onNotice({
        message: wakingFlow === "new"
          ? `ADE connected to ${wakingName ?? "the new machine"} but couldn't offer it here. Pick it under Your computers.`
          : "ADE connected to the ready machine but couldn't offer it here. Try again, or pick it under Your computers.",
        kind: "status",
      });
    }, SELECT_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [giveBack, onNotice, pendingTargetId, wakingFlow, wakingName]);

  // A draft that goes away mid-wake (closed, launched elsewhere) stops the wake
  // and gives its claim back, including a claim still on its way.
  useEffect(() => () => {
    attemptRef.current += 1;
    giveBack();
  }, [giveBack]);

  const cloudConnected = cloudStatus?.connected === true && !cloudStatus.error;
  const option: DraftMachineOption | null = project
    ? {
        id: CLOUD_READY_MACHINE_ID,
        name: waking ? `Waking ${waking.name}…` : "ADE Cloud · ready",
        kind: "cloud",
        cloudProvider: "cloud",
        // While waking it is the selection, never an unavailable one.
        unavailableReason: waking || project.state === "ready" ? null : project.message,
      }
    : cloudConnected || waking
      ? {
          // No ready machine for this project: make one for this chat.
          id: CLOUD_NEW_MACHINE_ID,
          name: waking ? `Connecting to ${waking.name}…` : "New ADE Cloud machine",
          kind: "cloud",
          cloudProvider: "cloud",
          unavailableReason: null,
        }
      : cloudStatus && !cloudStatus.connected
        ? {
            // Not connected yet: the row says what a cloud machine needs first.
            id: CLOUD_CONNECT_ID,
            name: "New ADE Cloud machine",
            detail: "Not available on this account yet",
            kind: "cloud",
            cloudProvider: "cloud",
            unavailableReason: null,
          }
        : null;

  /** "New cloud machine": open the create form. */
  const chooseNew = useCallback(() => {
    if (waking) return;
    setCreating(true);
  }, [waking]);

  /**
   * The form made the machine and it signed in to the account: pair with it
   * and connect, then select it once the picker lists it. A machine that
   * signed in but isn't listed yet gets retried until the join window ends.
   */
  const onNewMachineCreated = useCallback(async (result: CloudCreateMachineResult) => {
    setCreating(false);
    const machineKey = result.machineKey;
    if (!machineKey) {
      onNotice({ message: `${result.name} is still starting. It shows under Your computers once it's ready.`, kind: "status" });
      return;
    }
    const attempt = ++attemptRef.current;
    const stillWanted = () => attemptRef.current === attempt;
    setWaking({ flow: "new", name: result.name });
    onNotice({ message: `${result.name} is signed in. Connecting…`, kind: "status" });
    const { value: targetId, lastError } = await connectWithRetry({
      connect: () => pairAndConnect(machineKey),
      stillWanted,
      waitMs: CLOUD_JOIN_WATCH_MS,
      retryMs: CONNECT_RETRY_MS * 2,
    });
    if (!stillWanted()) return;
    if (targetId) {
      setPendingTargetId(targetId);
      return;
    }
    setWaking(null);
    const reason = lastError ? ipcErrorMessage(lastError) : "";
    onNotice({ message: `ADE made ${result.name} but couldn't connect to it yet${reason ? `: ${reason}` : "."} Connect it under Your computers.`, kind: "status" });
  }, [onNotice]);

  const choose = useCallback(async () => {
    if (!originUrl || !bridge?.readyClaim || waking) return;
    // One claim at a time: a second pick while one is in flight would wake a second machine.
    if (unusedClaimRef.current || claimingRef.current) {
      onNotice({ message: "Still handing back the last ready machine. Pick it again in a moment.", kind: "hint" });
      return;
    }
    const attempt = ++attemptRef.current;
    const startedAt = Date.now();
    // Shown as the choice from the pick on, so picking any machine cancels it.
    setWaking({ flow: "ready", name: "the ready machine" });
    const stillWanted = () => attemptRef.current === attempt;
    onNotice({ message: "Waking this project's ready machine on ADE Cloud…", kind: "status" });
    try {
      claimingRef.current = true;
      const claim = await bridge.readyClaim(originUrl).finally(() => {
        claimingRef.current = false;
      });
      if (!claim) {
        setWaking(null);
        onNotice(null);
        return;
      }
      unusedClaimRef.current = { instanceId: claim.instanceId, claimToken: claim.claimToken };
      if (!stillWanted()) {
        // Picked another machine while the claim was in flight.
        giveBack();
        return;
      }
      setWaking({ flow: "ready", name: claim.name });
      onNotice({ message: `${claim.name} is awake. Connecting to its ADE…`, kind: "status" });
      // Its ADE reconnects a few seconds after the wake; until then a pair or connect fails.
      const { value: targetId, lastError } = await connectWithRetry({
        connect: () => pairAndConnect(claim.machineKey),
        stillWanted,
        waitMs: CLOUD_READY_WAKE_WAIT_MS - (Date.now() - startedAt),
        retryMs: CONNECT_RETRY_MS,
      });
      if (targetId && stillWanted()) {
        setPendingTargetId(targetId);
        return;
      }
      if (stillWanted()) {
        const reason = lastError ? ipcErrorMessage(lastError) : "";
        throw new Error(`${claim.name} woke but ADE couldn't connect to it in time${reason ? `: ${reason}` : "."} ADE put it back to sleep for the next chat.`);
      }
    } catch (error) {
      if (!stillWanted()) return;
      // Nothing used it: back to ready and asleep.
      giveBack();
      setWaking(null);
      onNotice({ message: ipcErrorMessage(error) || "ADE couldn't wake the ready machine.", kind: "status" });
    }
  }, [bridge, giveBack, onNotice, originUrl, waking]);

  /** The person picked another machine (or the draft launched): stop following this one and give an unselected claim back. */
  const abandon = useCallback(() => {
    attemptRef.current += 1;
    setWaking(null);
    setPendingTargetId(null);
    giveBack();
  }, [giveBack]);

  // The draft launched or closed its launch controls mid-wake: the wake is not for it anymore.
  useEffect(() => {
    if (!enabled) abandon();
  }, [abandon, enabled]);

  /** While waking, the picker shows this row as the choice, so picking any machine (even the previous one) cancels it. */
  return {
    option,
    choose,
    chooseNew,
    abandon,
    waking: waking != null || pendingTargetId != null,
    /** The New cloud machine form, open; the pane renders it. */
    create: creating && cloudStatus?.connected
      ? { status: cloudStatus, onCreated: onNewMachineCreated, onClose: () => setCreating(false) }
      : null,
  };
}

import { useCallback, useEffect, useRef, useState } from "react";
import { AGENT37_JOIN_WATCH_MS, AGENT37_READY_WAKE_WAIT_MS, type Agent37CreateMachineResult, type Agent37ReadyProjectStatus, type Agent37Status } from "../../../shared/agent37";
import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import { captureError } from "../../../shared/sentry/capture";
import { ipcErrorMessage } from "../../lib/format";
import type { DraftMachineOption } from "./DraftMachinePicker";

/** The picker row for this project's ready Agent 37 machine. */
export const AGENT37_READY_MACHINE_ID = "__ade_agent37_ready__";
/** The picker row that makes a new Agent 37 machine for this chat (no ready machine for the project). */
export const AGENT37_NEW_MACHINE_ID = "__ade_agent37_new__";

const CONNECT_RETRY_MS = 1_500;
/** A connected machine shows up among the picker's machines within a moment; past this it isn't coming. */
const SELECT_WAIT_MS = 20_000;

/**
 * "Agent 37 · ready" in the new-chat machine picker: this project's prepared,
 * sleeping cloud machine. Picking it claims and wakes it at once, so the wake
 * overlaps the typing; ADE then pairs and connects to it and selects it like
 * any other machine, and the chat launches there through the ordinary path.
 * Picking another machine before it is selected gives the claim back (ready
 * again, asleep), so an abandoned wake does not leave it billing.
 *
 * Account-level calls only (the Agent 37 pool, the account's machine list,
 * this desktop's connections), so nothing here takes a pin; once selected, the
 * machine's own connection carries every call to it.
 */
export function useAgent37ReadyDraftMachine({
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
  const bridge = window.ade.agent37;
  const identity = normalizeGitRemoteIdentity(originUrl);
  const [project, setProject] = useState<Agent37ReadyProjectStatus | null>(null);
  /** The machine being woken, by name, until it is selected or given back. */
  const [wakingName, setWakingName] = useState<string | null>(null);
  const [pendingTargetId, setPendingTargetId] = useState<string | null>(null);
  /** Agent 37's connection, read once the picker opens: the row shows only while a key works. */
  const [agent37Status, setAgent37Status] = useState<Agent37Status | null>(null);
  /** The New Agent 37 machine form is open. */
  const [creating, setCreating] = useState(false);
  const attemptRef = useRef(0);
  const claimingRef = useRef(false);
  /** The claim not yet selected: what `abandon` gives back. */
  const unusedClaimRef = useRef<{ instanceId: string; claimToken: string } | null>(null);

  useEffect(() => {
    if (!enabled || !pickerOpened || !identity || !bridge?.readyStatus) return;
    let cancelled = false;
    const apply = (status: { projects: Agent37ReadyProjectStatus[] } | null) => {
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
      void bridge.getStatus().then((next) => { if (!cancelled) setAgent37Status(next); }, () => undefined);
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
    setWakingName(null);
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
      captureError(error, { fingerprint: ["agent37", "ready_release"], handled: true });
    });
  }, [bridge]);

  // Connected but never listed among the picker's machines: say so, and give it back.
  useEffect(() => {
    if (!pendingTargetId) return;
    const timer = window.setTimeout(() => {
      setPendingTargetId(null);
      setWakingName(null);
      giveBack();
      onNotice({ message: "ADE connected to the ready machine but couldn't offer it here. Try again, or pick it under Your computers.", kind: "status" });
    }, SELECT_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [giveBack, onNotice, pendingTargetId]);

  // A draft that goes away mid-wake (closed, launched elsewhere) stops the wake
  // and gives its claim back, including a claim still on its way.
  useEffect(() => () => {
    attemptRef.current += 1;
    giveBack();
  }, [giveBack]);

  const agent37Connected = agent37Status?.connected === true && !agent37Status.error;
  const option: DraftMachineOption | null = project
    ? {
        id: AGENT37_READY_MACHINE_ID,
        name: wakingName ? `Waking ${wakingName}…` : "Agent 37 · ready",
        kind: "cloud",
        cloudProvider: "agent37",
        // While waking it is the selection, never an unavailable one.
        unavailableReason: wakingName || project.state === "ready" ? null : project.message,
      }
    : agent37Connected || wakingName
      ? {
          // No ready machine for this project: make one for this chat.
          id: AGENT37_NEW_MACHINE_ID,
          name: wakingName ? `Connecting to ${wakingName}…` : "New Agent 37 machine",
          kind: "cloud",
          cloudProvider: "agent37",
          unavailableReason: null,
        }
      : null;

  /** "New Agent 37 machine": open the create form. */
  const chooseNew = useCallback(() => {
    if (wakingName) return;
    setCreating(true);
  }, [wakingName]);

  /**
   * The form made the machine and it signed in to the account: pair with it
   * and connect, then select it once the picker lists it. A machine that
   * signed in but isn't listed yet gets retried until the join window ends.
   */
  const onNewMachineCreated = useCallback(async (result: Agent37CreateMachineResult) => {
    setCreating(false);
    if (!result.machineKey) {
      onNotice({ message: `${result.name} is still starting. It shows under Your computers once it's ready.`, kind: "status" });
      return;
    }
    const attempt = ++attemptRef.current;
    const stillWanted = () => attemptRef.current === attempt;
    const startedAt = Date.now();
    setWakingName(result.name);
    onNotice({ message: `${result.name} is signed in. Connecting…`, kind: "status" });
    let lastError: unknown = null;
    while (stillWanted() && Date.now() - startedAt < AGENT37_JOIN_WATCH_MS) {
      try {
        const paired = await window.ade.account.pairMachine(result.machineKey);
        const connected = await window.ade.remoteRuntime.connect(paired.targetId);
        if (connected && stillWanted()) {
          setPendingTargetId(paired.targetId);
          return;
        }
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_MS * 2));
    }
    if (!stillWanted()) return;
    setWakingName(null);
    const reason = lastError ? ipcErrorMessage(lastError) : "";
    onNotice({ message: `ADE made ${result.name} but couldn't connect to it yet${reason ? `: ${reason}` : "."} Connect it under Your computers.`, kind: "status" });
  }, [onNotice]);

  const choose = useCallback(async () => {
    if (!originUrl || !bridge?.readyClaim || wakingName) return;
    // One claim at a time: a second pick while one is in flight would wake a second machine.
    if (unusedClaimRef.current || claimingRef.current) {
      onNotice({ message: "Still handing back the last ready machine. Pick it again in a moment.", kind: "hint" });
      return;
    }
    const attempt = ++attemptRef.current;
    const startedAt = Date.now();
    // Shown as the choice from the pick on, so picking any machine cancels it.
    setWakingName("the ready machine");
    const stillWanted = () => attemptRef.current === attempt;
    onNotice({ message: "Waking this project's ready machine on Agent 37…", kind: "status" });
    try {
      claimingRef.current = true;
      const claim = await bridge.readyClaim(originUrl).finally(() => {
        claimingRef.current = false;
      });
      if (!claim) {
        setWakingName(null);
        onNotice(null);
        return;
      }
      unusedClaimRef.current = { instanceId: claim.instanceId, claimToken: claim.claimToken };
      if (!stillWanted()) {
        // Picked another machine while the claim was in flight.
        giveBack();
        return;
      }
      setWakingName(claim.name);
      onNotice({ message: `${claim.name} is awake. Connecting to its ADE…`, kind: "status" });
      // Its ADE reconnects a few seconds after the wake; until then a pair or connect fails.
      let lastError: unknown = null;
      while (stillWanted() && Date.now() - startedAt < AGENT37_READY_WAKE_WAIT_MS) {
        try {
          const paired = await window.ade.account.pairMachine(claim.machineKey);
          const connected = await window.ade.remoteRuntime.connect(paired.targetId);
          if (connected && stillWanted()) {
            setPendingTargetId(paired.targetId);
            return;
          }
        } catch (error) {
          lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_MS));
      }
      if (stillWanted()) {
        const reason = lastError ? ipcErrorMessage(lastError) : "";
        throw new Error(`${claim.name} woke but ADE couldn't connect to it in time${reason ? `: ${reason}` : "."} ADE put it back to sleep for the next chat.`);
      }
    } catch (error) {
      if (!stillWanted()) return;
      // Nothing used it: back to ready and asleep.
      giveBack();
      setWakingName(null);
      onNotice({ message: ipcErrorMessage(error) || "ADE couldn't wake the ready machine.", kind: "status" });
    }
  }, [bridge, giveBack, onNotice, originUrl, wakingName]);

  /** The person picked another machine (or the draft launched): stop following this one and give an unselected claim back. */
  const abandon = useCallback(() => {
    attemptRef.current += 1;
    setWakingName(null);
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
    waking: wakingName != null || pendingTargetId != null,
    /** The New Agent 37 machine form, open; the pane renders it. */
    create: creating && agent37Status?.connected
      ? { status: agent37Status, onCreated: onNewMachineCreated, onClose: () => setCreating(false) }
      : null,
  };
}

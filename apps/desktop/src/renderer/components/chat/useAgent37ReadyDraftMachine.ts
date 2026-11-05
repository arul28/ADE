import { useCallback, useEffect, useRef, useState } from "react";
import type { Agent37ReadyProjectStatus } from "../../../shared/agent37";
import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import type { DraftMachineOption } from "./DraftMachinePicker";

/** The picker row for this project's ready Agent 37 machine. */
export const AGENT37_READY_MACHINE_ID = "__ade_agent37_ready__";

/** From the claim: Agent 37 wakes it in about a second, ADE reconnects after. */
const WAKE_WAIT_MS = 120_000;
const CONNECT_RETRY_MS = 1_500;

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  return raw.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, "").trim() || "Something went wrong.";
}

export type Agent37ReadyWaking = { name: string; startedAt: number };

/**
 * "Agent 37 · ready" in the new-chat machine picker: this project's prepared,
 * sleeping cloud machine. Picking it claims and wakes it at once, so the wake
 * overlaps the typing; ADE then pairs and connects to it and selects it like
 * any other machine, and the chat launches there through the ordinary path.
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
  const [waking, setWaking] = useState<Agent37ReadyWaking | null>(null);
  const [pendingTargetId, setPendingTargetId] = useState<string | null>(null);
  const attemptRef = useRef(0);

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

  // Selected once its connection shows up among the picker's machines.
  useEffect(() => {
    if (!pendingTargetId || !connectedMachineIds.includes(pendingTargetId)) return;
    setPendingTargetId(null);
    setWaking(null);
    onNotice(null);
    onMachineReady(pendingTargetId);
  }, [connectedMachineIds, onMachineReady, onNotice, pendingTargetId]);

  const option: DraftMachineOption | null = project
    ? {
        id: AGENT37_READY_MACHINE_ID,
        name: waking ? `Waking ${waking.name}…` : "Agent 37 · ready",
        kind: "cloud",
        cloudProvider: "agent37",
        unavailableReason: waking
          ? "Waking the ready machine."
          : project.state === "ready"
            ? null
            : project.message,
      }
    : null;

  const choose = useCallback(async () => {
    if (!originUrl || !bridge?.readyClaim || waking) return;
    const attempt = ++attemptRef.current;
    const startedAt = Date.now();
    const stillWanted = () => attemptRef.current === attempt;
    onNotice({ message: "Waking this project's ready machine on Agent 37…", kind: "status" });
    try {
      const claim = await bridge.readyClaim(originUrl);
      if (!claim || !stillWanted()) return;
      if (!claim.machineKey) throw new Error(`${claim.name} has no ADE machine recorded on it. Delete it from its row; ADE prepares another.`);
      setWaking({ name: claim.name, startedAt });
      onNotice({ message: `${claim.name} is awake. Connecting to its ADE…`, kind: "status" });
      // Its ADE reconnects a few seconds after the wake; until then a pair or connect fails.
      let lastError: unknown = null;
      while (stillWanted() && Date.now() - startedAt < WAKE_WAIT_MS) {
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
        throw new Error(`${claim.name} woke but ADE couldn't connect to it in time${lastError ? `: ${errorText(lastError)}` : "."} It's under Your computers.`);
      }
    } catch (error) {
      if (!stillWanted()) return;
      setWaking(null);
      onNotice({ message: errorText(error), kind: "status" });
    }
  }, [bridge, onNotice, originUrl, waking]);

  /** The person picked another machine while this one was waking: stop following it. */
  const abandon = useCallback(() => {
    attemptRef.current += 1;
    setWaking(null);
    setPendingTargetId(null);
  }, []);

  return { option, choose, abandon, waking };
}

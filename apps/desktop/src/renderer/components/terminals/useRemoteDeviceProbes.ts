import { useEffect, useMemo, useRef, useState } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import type { AgentChatRemoteWorkUse } from "../../../shared/types/chat";
import type { DeviceKind } from "../../../shared/types/deviceSources";
import { remoteWorkUseKey } from "../../../shared/chatRemoteWork";
import { useRemoteWorkPinResolver } from "../../lib/remoteWorkPins";
import { laneDeviceBooted } from "../apple/appleDeviceState";
import { workCopyUseOn } from "./workToolCatalog";
import type { ToolMachine } from "./useToolMachines";

/*
 * Whether this chat's device runs on the machine it CHOSE for that kind,
 * when that machine is another one: the green dot on its rail chip and the
 * live state of its card.
 *
 * One read per chosen kind, through the pin this window already holds for
 * that machine (never connecting on its own: an unreachable machine reads
 * nothing and says "unknown"), keyed by the chat's code there. iPhone and
 * Android re-read on their device-state events, as their panels do; the
 * screen and App Control re-read when the agent's last call to that tool
 * answers (`rereadKey`). No timer.
 */

export type RemoteDeviceProbe = "running" | "off" | "unknown";

type Target = { kind: DeviceKind; laneId: string; pin: OpenProjectBinding; useKey: string };

async function readProbe(kind: DeviceKind, laneId: string, pin: OpenProjectBinding): Promise<boolean> {
  switch (kind) {
    case "ios": {
      const listed = await window.ade?.iosSimulator?.deviceList?.({ laneId, installed: true }, pin);
      return laneDeviceBooted(listed ?? null);
    }
    case "android": {
      const status = await window.ade?.androidEmulator?.getStatus?.({ laneId }, pin);
      const state = status?.lane?.state;
      return state === "booted" || state === "starting";
    }
    case "screen": {
      const status = await window.ade?.macDesktop?.getStatus?.({ laneId }, pin);
      return Boolean(status?.display);
    }
    case "app": {
      const status = await window.ade?.appControl?.getStatus?.({ laneId }, pin);
      const session = status?.activeSession;
      return Boolean(session && !["stopped", "exited", "failed"].includes(session.status));
    }
  }
}

function follow(kind: DeviceKind, laneId: string, pin: OpenProjectBinding, changed: () => void): (() => void) | undefined {
  if (kind === "ios") {
    return window.ade?.iosSimulator?.onEvent?.((event) => {
      if (event.type === "apple.device.state" && (!event.laneId || event.laneId === laneId)) changed();
    }, pin);
  }
  if (kind === "android") {
    return window.ade?.androidEmulator?.onEvent?.((event) => {
      if (event.type === "android.device.state" && event.laneId === laneId) changed();
    }, pin);
  }
  return undefined;
}

export function useRemoteDeviceProbes(args: {
  active: boolean;
  remoteWork: readonly AgentChatRemoteWorkUse[] | null | undefined;
  /** Each kind's chosen machine, only where that is another machine than the chat's. */
  chosenRemote: Partial<Record<DeviceKind, ToolMachine>>;
  /** Per kind, changes when the agent's last call to that tool answered. */
  rereadKeys: Partial<Record<DeviceKind, string | number | null>>;
}): Partial<Record<DeviceKind, RemoteDeviceProbe>> {
  const { active, remoteWork, chosenRemote, rereadKeys } = args;
  const resolvePin = useRemoteWorkPinResolver(active && Object.keys(chosenRemote).length > 0);
  const targets = useMemo(() => {
    const out: Target[] = [];
    for (const [kind, machine] of Object.entries(chosenRemote) as Array<[DeviceKind, ToolMachine]>) {
      const use = workCopyUseOn(remoteWork, machine.key);
      if (!use) continue;
      const pin = resolvePin(use);
      if (pin === "unreachable") continue;
      out.push({ kind, laneId: use.workCopyLaneId, pin, useKey: `${remoteWorkUseKey(use)}@${pin.key}` });
    }
    return out;
  }, [chosenRemote, remoteWork, resolvePin]);
  const signature = targets.map((target) => `${target.kind}:${target.useKey}:${target.laneId}`).join("|");
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const [probes, setProbes] = useState<Partial<Record<DeviceKind, RemoteDeviceProbe>>>({});
  const rereadSignature = (["ios", "android", "screen", "app"] as const).map((kind) => `${kind}=${rereadKeys[kind] ?? ""}`).join("|");

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    const disposers: Array<(() => void) | undefined> = [];
    const known = new Set<DeviceKind>();
    for (const target of targetsRef.current) {
      known.add(target.kind);
      let seq = 0;
      const read = () => {
        const mine = ++seq;
        void readProbe(target.kind, target.laneId, target.pin)
          .then((running) => {
            if (cancelled || mine !== seq) return;
            setProbes((current) => (current[target.kind] === (running ? "running" : "off")
              ? current
              : { ...current, [target.kind]: running ? "running" : "off" }));
          })
          .catch(() => {
            if (cancelled || mine !== seq) return;
            setProbes((current) => (current[target.kind] === "unknown" ? current : { ...current, [target.kind]: "unknown" }));
          });
      };
      read();
      disposers.push(follow(target.kind, target.laneId, target.pin, read));
    }
    // A kind with no target any more has nothing to say.
    setProbes((current) => {
      const stale = (Object.keys(current) as DeviceKind[]).filter((kind) => !known.has(kind));
      if (!stale.length) return current;
      const next = { ...current };
      for (const kind of stale) delete next[kind];
      return next;
    });
    return () => {
      cancelled = true;
      for (const dispose of disposers) dispose?.();
    };
    // Keyed on what the targets are (kind, copy, pin key) and the reread keys, not the objects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, signature, rereadSignature]);

  return probes;
}

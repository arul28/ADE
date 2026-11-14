import { useEffect, useMemo, useState } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import type { AdeAccountMachine } from "../../../shared/types/account";
import { accountMachineDisplayName } from "../../../shared/accountDirectory";
import { accountMachinePresence } from "../../../shared/machinePresence";
import { machineNameForBinding, remoteMachineHostPlatform } from "../../../shared/machineIdentity";
import { sameMachineKey } from "../../../shared/machineAddress";
import { fetchAccountMachines } from "../../lib/account";
import { useRemoteConnectionSnapshot } from "../../state/projectMachines";
import { useAppStore } from "../../state/appStore";

/**
 * One machine on the person's ADE account, as the tools pane's "runs on" rails
 * name it.
 *
 * `isChat` is the chat's own machine: `here` for `ade devices use`, the machine
 * a device runs on when the chat chose nothing. `isViewer` is the computer
 * this window runs on (the browser tool's machine).
 */
export type ToolMachine = {
  key: string;
  name: string;
  platform: NodeJS.Platform | null;
  online: boolean;
  isChat: boolean;
  isViewer: boolean;
};

export type ToolMachines = {
  machines: ToolMachine[];
};

let localKeyCache: string | null = null;
let localKeyRead: Promise<string | null> | null = null;

function readLocalMachineKey(): Promise<string | null> {
  if (localKeyCache) return Promise.resolve(localKeyCache);
  localKeyRead ??= (window.ade?.account?.getLocalMachineIdentity?.() ?? Promise.resolve(null))
    .then((identity) => {
      localKeyCache = identity?.machineKey?.trim() || null;
      return localKeyCache;
    })
    .catch((error: unknown) => {
      // Without it this computer is not marked as the viewer; the rest still lists.
      console.warn("[tools-pane] could not read this machine's identity", error);
      return null;
    })
    .finally(() => { localKeyRead = null; });
  return localKeyRead;
}

function viewerPlatformGuess(): NodeJS.Platform | null {
  if (typeof navigator === "undefined") return null;
  const text = `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`;
  if (/Win/i.test(text)) return "win32";
  if (/Mac/i.test(text)) return "darwin";
  if (/Linux/i.test(text)) return "linux";
  return null;
}

/**
 * Every machine a device could run on for this chat: the account directory's
 * machines (one cached read per activation, `fetchAccountMachines`), joined
 * with this window's connection snapshot (a push feed) and this computer's
 * identity (read once). Nothing here polls.
 *
 * `runtimePin` is the chat's machine. A remote pin names its machine through
 * the connection whose target it addresses; a local pin, or none, is this
 * computer.
 */
export function useToolMachines(runtimePin: OpenProjectBinding | null, active: boolean, hostPlatform: NodeJS.Platform | null): ToolMachines {
  const { snapshot } = useRemoteConnectionSnapshot(active);
  const projectBinding = useAppStore((state) => state.projectBinding);
  const [directory, setDirectory] = useState<AdeAccountMachine[] | null>(null);
  const [localKey, setLocalKey] = useState<string | null>(localKeyCache);

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    void Promise.all([
      fetchAccountMachines().catch((error: unknown) => {
        // Signed out or offline: only the chat's own machine (and connections) list.
        console.warn("[tools-pane] could not read the account's machines", error);
        return null;
      }),
      readLocalMachineKey(),
    ]).then(([result, key]) => {
      if (cancelled) return;
      setDirectory(result?.state === "ok" ? result.machines : null);
      if (key) setLocalKey(key);
    });
    return () => { cancelled = true; };
  }, [active]);

  const binding = runtimePin ?? projectBinding ?? null;
  const bindingKey = binding?.key ?? null;
  const targetId = binding?.kind === "remote" ? binding.targetId : null;
  const bindingName = binding ? machineNameForBinding(binding) : null;

  return useMemo<ToolMachines>(() => {
    const connections = snapshot?.connections ?? [];
    const connectedKeys = connections
      .filter((entry) => entry.state === "connected")
      .map((entry) => entry.target.pairedMachine?.machineKey ?? null)
      .filter((key): key is string => Boolean(key));
    const chatKey = targetId
      ? connections.find((entry) => entry.target.id === targetId)?.target.pairedMachine?.machineKey ?? `target:${targetId}`
      : localKey ?? "this-machine";
    const isConnected = (key: string) => connectedKeys.some((entry) => sameMachineKey(entry, key));
    const out: ToolMachine[] = [];
    const seen = (key: string) => out.some((machine) => sameMachineKey(machine.key, key));
    for (const machine of directory ?? []) {
      if (seen(machine.machineKey)) continue;
      const isViewer = Boolean(localKey && sameMachineKey(machine.machineKey, localKey));
      const connected = isConnected(machine.machineKey);
      const presence = accountMachinePresence(machine, { connected });
      out.push({
        key: machine.machineKey,
        name: accountMachineDisplayName(machine) ?? machine.machineKey.slice(0, 8),
        platform: remoteMachineHostPlatform(machine.platform),
        online: isViewer || connected || presence === "online",
        isChat: sameMachineKey(machine.machineKey, chatKey),
        isViewer,
      });
    }
    // Connected machines the directory did not list (signed out, an SSH box).
    for (const entry of connections) {
      const key = entry.target.pairedMachine?.machineKey;
      if (!key || seen(key)) continue;
      out.push({
        key,
        name: entry.target.name,
        platform: remoteMachineHostPlatform(entry.target.lastSeenArch ?? null),
        online: entry.state === "connected",
        isChat: sameMachineKey(key, chatKey),
        isViewer: false,
      });
    }
    // The chat's machine always has a chip, whatever the directory said.
    if (!out.some((machine) => machine.isChat)) {
      const isViewer = !targetId;
      out.unshift({
        key: chatKey,
        name: isViewer ? "This computer" : bindingName ?? "This chat's machine",
        platform: hostPlatform ?? (isViewer ? viewerPlatformGuess() : null),
        online: true,
        isChat: true,
        isViewer,
      });
    }
    // The chat's machine, then this computer, then the online, then the rest.
    const rank = (machine: ToolMachine) => (machine.isChat ? 0 : machine.isViewer ? 1 : machine.online ? 2 : 3);
    out.sort((a, b) => rank(a) - rank(b));
    const chatMachine = out.find((machine) => machine.isChat) ?? null;
    if (chatMachine && !chatMachine.platform && hostPlatform) chatMachine.platform = hostPlatform;
    return { machines: out };
    // `bindingKey` stands for the binding's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bindingKey, bindingName, directory, hostPlatform, localKey, snapshot, targetId]);
}

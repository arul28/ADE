import { useEffect, useMemo, useRef, useState } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import type { AdeAccountMachine } from "../../../shared/types/account";
import { accountMachineDisplayName } from "../../../shared/accountDirectory";
import { accountMachinePresence } from "../../../shared/machinePresence";
import { machineNameForBinding, remoteMachineHostPlatform } from "../../../shared/machineIdentity";
import { sameMachineKey } from "../../../shared/machineAddress";
import { fetchAccountMachines } from "../../lib/account";
import { useReadRetryOnReconnect, useRemoteConnectionSnapshot } from "../../state/projectMachines";
import { useAppStore } from "../../state/appStore";
import { isAdeCloudComputer, useAdeCloudLaneComputers } from "../../state/adeCloudLaneIndex";
import { ADE_CLOUD_NAME } from "../../../shared/adeCloudMachine";
import { isCloudPhoneMissingAnswer } from "../../../shared/types/deviceSources";

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
  /** The chat's machine is one of the account's ADE Cloud computers (named "ADE Cloud"). */
  adeCloud?: boolean;
  /** ADE Cloud: the account's cloud iPhone, not a machine of the person's (`ios@cloud`). */
  isCloudIphone?: boolean;
};

/** The ADE Cloud iPhone as a chip in the iPhone's "runs on" row. Only the iPhone has it. */
export const ADE_CLOUD_TOOL_MACHINE: ToolMachine = {
  key: "ade-cloud",
  name: "ADE Cloud",
  platform: "darwin",
  online: true,
  isChat: false,
  isViewer: false,
  isCloudIphone: true,
};

export type ToolMachines = {
  machines: ToolMachine[];
  /** The account's machine list: not read yet, read, or unreadable (signed out, offline). */
  read: "pending" | "ok" | "failed";
  /**
   * The ADE Cloud iPhone on this account, as the chat's brain reads it: `on`
   * (its chip is in `machines`), `off`, `update` (the chat's machine runs an
   * ADE from before the cloud iPhone, so it can't drive one until it
   * updates), or null before the read or when the brain can't say.
   */
  cloudIphone: "on" | "off" | "update" | null;
  /**
   * The ADE Cloud iPhone's read lost its link and runs again when the link is
   * back. Until then nobody knows whether a Mac can run the iPhone, so no tile
   * says none is online.
   */
  cloudIphoneLinkLost: boolean;
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
  const [read, setRead] = useState<ToolMachines["read"]>("pending");
  const [localKey, setLocalKey] = useState<string | null>(localKeyCache);
  const cloudIndex = useAdeCloudLaneComputers();

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
      setRead(result?.state === "ok" ? "ok" : "failed");
      if (key) setLocalKey(key);
    });
    return () => { cancelled = true; };
  }, [active]);

  const binding = runtimePin ?? projectBinding ?? null;
  const bindingKey = binding?.key ?? null;

  // The ADE Cloud iPhone, read once each time the pane opens, from the chat's
  // own brain (its account's beta list and minutes). Keyed on the pin's key.
  // Each answer names the pin it was read for: one read for another pin never shows here.
  // A read that lost its link (sent as the link dropped, or before it was
  // ready) runs again when the link to that machine is back: a null pin goes
  // to the tab's machine, so that is the link it waits on.
  const [cloudIphoneRead, setCloudIphoneRead] = useState<{ pinKey: string | null; access: ToolMachines["cloudIphone"]; linkLost: boolean } | null>(null);
  const cloudIphoneRetry = useReadRetryOnReconnect(binding);
  const pinRef = useRef(runtimePin);
  pinRef.current = runtimePin;
  const runtimePinKey = runtimePin?.key ?? null;
  useEffect(() => {
    if (!active) return undefined;
    const api = typeof window === "undefined" ? undefined : window.ade?.cloudPhone;
    if (!api?.status) return undefined;
    let cancelled = false;
    const pinKey = runtimePinKey;
    const failed = cloudIphoneRetry.begin();
    void api.status(pinRef.current).then(
      // Access is on or off; an older server's `soon` reads as off.
      (status) => { if (!cancelled) setCloudIphoneRead({ pinKey, access: status.access === "on" ? "on" : "off", linkLost: false }); },
      (error: unknown) => {
        // An older brain answers that it has no `cloud_phone` domain: the
        // panes say to update that machine. Anything else (signed out) shows nothing.
        console.warn("[tools-pane] could not read the ADE Cloud iPhone", error);
        const linkLost = failed(error);
        const access = isCloudPhoneMissingAnswer(error instanceof Error ? error.message : String(error ?? "")) ? "update" : null;
        if (!cancelled) setCloudIphoneRead({ pinKey, access, linkLost });
      },
    );
    return () => { cancelled = true; };
    // `begin` is stable; `retryKey` is the read again after a lost link.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, runtimePinKey, cloudIphoneRetry.retryKey]);
  const cloudIphoneForPin = cloudIphoneRead?.pinKey === runtimePinKey ? cloudIphoneRead : null;
  const cloudIphone = cloudIphoneForPin?.access ?? null;
  const cloudIphoneLinkLost = cloudIphoneForPin?.linkLost === true;
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
    // ADE Cloud computers are never a machine to pick by name. The chat's own
    // one stays, as "ADE Cloud", so the panes can say what runs there.
    const cloudOf = (key: string, hostname: string | null) => isAdeCloudComputer({ machineKey: key, hostname }, cloudIndex);
    const chatTarget = targetId ? connections.find((entry) => entry.target.id === targetId)?.target ?? null : null;
    const chatOnCloud = chatTarget != null && cloudOf(chatKey, chatTarget.hostname);
    for (const machine of directory ?? []) {
      if (seen(machine.machineKey)) continue;
      if (cloudOf(machine.machineKey, null)) {
        if (!sameMachineKey(machine.machineKey, chatKey)) continue;
        out.push({ key: machine.machineKey, name: ADE_CLOUD_NAME, platform: "linux", online: true, isChat: true, isViewer: false, adeCloud: true });
        continue;
      }
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
      if (cloudOf(key, entry.target.hostname)) {
        if (!sameMachineKey(key, chatKey)) continue;
        out.push({ key, name: ADE_CLOUD_NAME, platform: "linux", online: entry.state === "connected", isChat: true, isViewer: false, adeCloud: true });
        continue;
      }
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
        name: isViewer ? "This computer" : chatOnCloud ? ADE_CLOUD_NAME : bindingName ?? "This chat's machine",
        platform: hostPlatform ?? (isViewer ? viewerPlatformGuess() : null),
        online: true,
        isChat: true,
        isViewer,
        ...(chatOnCloud ? { adeCloud: true } : {}),
      });
    }
    // The chat's machine, then this computer, then the online, then the rest.
    const rank = (machine: ToolMachine) => (machine.isChat ? 0 : machine.isViewer ? 1 : machine.online ? 2 : 3);
    out.sort((a, b) => rank(a) - rank(b));
    const chatMachine = out.find((machine) => machine.isChat) ?? null;
    if (chatMachine && !chatMachine.platform && hostPlatform) chatMachine.platform = hostPlatform;
    if (cloudIphone === "on") out.push(ADE_CLOUD_TOOL_MACHINE);
    return { machines: out, read, cloudIphone, cloudIphoneLinkLost };
    // `bindingKey` stands for the binding's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bindingKey, bindingName, cloudIndex, cloudIphone, cloudIphoneLinkLost, directory, hostPlatform, localKey, read, snapshot, targetId]);
}

import type { ChatDeviceSources, DeviceKind } from "../../../shared/types/deviceSources";
import { deviceKindRunsOnPlatform } from "../../../shared/types/deviceSources";
import { sameMachineKey } from "../../../shared/machineAddress";
import { remoteMachineHostPlatform } from "../../../shared/machineIdentity";
import type { AgentChatRemoteWorkUse } from "../../../shared/types/chat";
import type { RemoteWorkCopyUse } from "../../../shared/chatRemoteWork";
import type { ToolMachine } from "./useToolMachines";

/*
 * The tools pane's front page: one equal tile per tool this chat can open,
 * devices first, then the code tools. A tile says only what it is, where it
 * runs and what it is doing now; every choice (which machine, which device)
 * lives in the tool it opens.
 *
 * Pure: the picker renders what these functions return. Nothing here reads
 * the chat's history of machines: where a device is comes from the chat's
 * CURRENT choice (`ade devices use`) or its current turn.
 */

/** A tile. `screen` is the lane-screen tool, opened as Mac, Linux or Windows Desktop. */
export type CatalogCardId =
  | "ios"
  | "android"
  | "screen"
  | "app-control"
  | "terminal"
  | "browser"
  | "git"
  | "pr"
  | "issues"
  | "files"
  | "side-chat";

/** Tile order: the four devices, then Terminal and the code tools. */
export const WORK_TOOL_TILES: readonly CatalogCardId[] = [
  "ios",
  "android",
  "screen",
  "app-control",
  "terminal",
  "browser",
  "git",
  "pr",
  "issues",
  "files",
  "side-chat",
];

/** The device kind (`ade devices use <kind>@…`) a tile's tool chooses the machine for. */
export const CARD_DEVICE_KIND: Partial<Record<CatalogCardId, DeviceKind>> = {
  ios: "ios",
  android: "android",
  screen: "screen",
  "app-control": "app",
};

/** The tiles this surface shows: Side chat only for a chat that has one. */
export function visibleCatalogCards(hasSideChat: boolean): CatalogCardId[] {
  return WORK_TOOL_TILES.filter((card) => card !== "side-chat" || hasSideChat);
}

/** The machines a device kind can run on, the chat's own first; offline ones only when chosen. */
export function machinesForKind(
  kind: DeviceKind,
  machines: readonly ToolMachine[],
  chosen: ToolMachine | null,
): { able: ToolMachine[]; unable: ToolMachine[] } {
  const able: ToolMachine[] = [];
  const unable: ToolMachine[] = [];
  for (const machine of machines) {
    const isChosen = Boolean(chosen && sameMachineKey(chosen.key, machine.key));
    if (!deviceKindRunsOnPlatform(kind, machine.platform)) {
      if (machine.isChat || machine.isViewer) unable.push(machine);
      continue;
    }
    if (machine.online || isChosen) able.push(machine);
  }
  if (chosen && !chosen.isChat && !able.some((machine) => sameMachineKey(machine.key, chosen.key))) able.unshift(chosen);
  return { able, unable };
}

/** The machine this chat's device of `kind` is on: its choice, else the chat's own machine. */
export function chosenMachineFor(
  kind: DeviceKind,
  sources: ChatDeviceSources | null,
  machines: readonly ToolMachine[],
): ToolMachine | null {
  const choice = sources?.[kind];
  if (choice) {
    const listed = machines.find((machine) => sameMachineKey(machine.key, choice.machineKey));
    if (listed) return listed;
    // A choice of a machine the directory no longer lists still routes there.
    return { key: choice.machineKey, name: choice.machineName, platform: null, online: false, reachable: false, isChat: false, isViewer: false };
  }
  return machines.find((machine) => machine.isChat) ?? null;
}

const DEVICE_FLAG: Readonly<Record<DeviceKind, "usesSimulator" | "usesAndroidEmulator" | "usesDesktop" | "usesAppControl">> = {
  ios: "usesSimulator",
  android: "usesAndroidEmulator",
  screen: "usesDesktop",
  app: "usesAppControl",
};

/**
 * Where each of this chat's devices is NOW, when that is another machine
 * than the chat's: its device choice (`ade devices use`), else the machine
 * its CURRENT turn drives that kind on with `--machine` (`activeUses`, the
 * row's machines in use this turn). Not a machine it used in an earlier turn.
 */
export function currentRemoteDeviceMachines(
  sources: ChatDeviceSources | null,
  machines: readonly ToolMachine[],
  activeUses: readonly AgentChatRemoteWorkUse[],
): Partial<Record<DeviceKind, ToolMachine>> {
  const out: Partial<Record<DeviceKind, ToolMachine>> = {};
  for (const kind of Object.keys(DEVICE_FLAG) as DeviceKind[]) {
    if (sources?.[kind]) {
      const chosen = chosenMachineFor(kind, sources, machines);
      // A choice of a machine that cannot run the kind (an iPhone on a PC)
      // is not where the device is; the tool asks for one that can.
      if (chosen && !chosen.isChat && deviceKindRunsOnPlatform(kind, chosen.platform)) out[kind] = chosen;
      continue;
    }
    const use = [...activeUses]
      .filter((entry) => entry[DEVICE_FLAG[kind]] === true && entry.workCopyLaneId)
      .sort((a, b) => Date.parse(b.lastStartedAt) - Date.parse(a.lastStartedAt))[0];
    if (!use) continue;
    const listed = machines.find((machine) => sameMachineKey(machine.key, use.machineKey));
    if (listed?.isChat) continue;
    out[kind] = listed ?? {
      key: use.machineKey,
      name: use.machineName,
      platform: remoteMachineHostPlatform(use.machinePlatform),
      online: true,
      reachable: false,
      isChat: false,
      isViewer: false,
    };
  }
  return out;
}

/**
 * The chat's code on a machine: its newest remote-work entry there that names
 * a work-copy lane (what that machine's simulator, emulator, screen and app
 * are keyed by). Not "the machines it ever drove a device on": any command
 * there made the copy, and the device tool reads the copy's lane live.
 */
export function workCopyUseOn(
  remoteWork: readonly AgentChatRemoteWorkUse[] | null | undefined,
  machineKey: string,
): RemoteWorkCopyUse | null {
  let best: RemoteWorkCopyUse | null = null;
  for (const use of remoteWork ?? []) {
    if (!use.workCopyLaneId || !sameMachineKey(use.machineKey, machineKey)) continue;
    if (!best || Date.parse(use.lastStartedAt) > Date.parse(best.lastStartedAt)) best = use as RemoteWorkCopyUse;
  }
  return best;
}

function keyIn(set: ReadonlySet<string>, key: string): boolean {
  for (const entry of set) if (sameMachineKey(entry, key)) return true;
  return false;
}

/** Joins names the way a sentence does: "A", "A and B", "A, B and C". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** How a machine is named on a tile or in a picker: this computer by what it is. */
export function railMachineName(machine: ToolMachine): string {
  if (!machine.isViewer) return machine.name;
  return machine.platform === "darwin" ? "This Mac" : machine.platform === "win32" ? "This PC" : "This computer";
}

/** What this chat left on other machines, for the one Clean up line. */
export type LeftoverMachine = {
  use: RemoteWorkCopyUse;
  /** "your code", "a simulator", "an emulator", "a screen", "an app". */
  things: string[];
};

/**
 * The machines where this chat has code it is not using now: each work copy
 * whose machine is neither a current device choice nor busy in this turn.
 * History belongs here and nowhere else: it is what there is to clean up.
 */
export function leftoverMachines(
  remoteWork: readonly AgentChatRemoteWorkUse[] | null | undefined,
  sources: ChatDeviceSources | null,
  activeMachineKeys: readonly string[],
  cleaned: ReadonlySet<string>,
): LeftoverMachine[] {
  const inUse = (key: string) => Object.values(sources ?? {}).some((choice) => choice && sameMachineKey(choice.machineKey, key))
    || activeMachineKeys.some((active) => sameMachineKey(active, key));
  const out: LeftoverMachine[] = [];
  for (const use of remoteWork ?? []) {
    if (!use.workCopyLaneId || inUse(use.machineKey) || keyIn(cleaned, use.machineKey)) continue;
    if (out.some((entry) => sameMachineKey(entry.use.machineKey, use.machineKey))) continue;
    const things = ["your code"];
    if (use.usesSimulator) things.push("a simulator");
    if (use.usesAndroidEmulator) things.push("an emulator");
    if (use.usesDesktop) things.push("a screen");
    if (use.usesAppControl) things.push("an app");
    out.push({ use: use as RemoteWorkCopyUse, things });
  }
  return out;
}

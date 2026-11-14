import type { ChatDeviceSources, DeviceKind } from "../../../shared/types/deviceSources";
import { deviceKindRunsOnPlatform } from "../../../shared/types/deviceSources";
import { sameMachineKey } from "../../../shared/machineAddress";
import { remoteMachineHostPlatform } from "../../../shared/machineIdentity";
import type { AgentChatRemoteWorkUse } from "../../../shared/types/chat";
import { isRemoteWorkCopyUse, type RemoteWorkCopyUse, type RemoteWorkDeviceFlag } from "../../../shared/chatRemoteWork";
import type { ToolMachine } from "./useToolMachines";
import type { RemoteDeviceProbe } from "./useRemoteDeviceProbes";
import type { ToolActivityTool } from "./useChatToolActivity";
import type { WorkSidebarTab } from "../../state/appStore";
import { desktopToolForMachinePlatform } from "./workTools";

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
const WORK_TOOL_TILES: readonly CatalogCardId[] = [
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

/**
 * Each device kind (`ade devices use <kind>@…`), in tile order: the
 * `remoteWork` flag that says the chat drove one on a machine, what a note to
 * the agent calls it, what the Clean up line says was left there, and the
 * agent activity its tile shows.
 */
export const DEVICE_KINDS: Readonly<Record<DeviceKind, {
  flag: RemoteWorkDeviceFlag;
  noun: string;
  thing: string;
  activity: ToolActivityTool;
}>> = {
  ios: { flag: "usesSimulator", noun: "Apple simulator", thing: "a simulator", activity: "ios" },
  android: { flag: "usesAndroidEmulator", noun: "Android emulator", thing: "an emulator", activity: "android" },
  screen: { flag: "usesDesktop", noun: "screen", thing: "a screen", activity: "screen" },
  app: { flag: "usesAppControl", noun: "App Control app", thing: "an app", activity: "app-control" },
};

export const DEVICE_KIND_ORDER = Object.keys(DEVICE_KINDS) as DeviceKind[];

/** The tab that shows a device kind on `machine`: the lane-screen tool is named for that machine. */
export function deviceKindTool(kind: DeviceKind, machine: Pick<ToolMachine, "platform">): WorkSidebarTab {
  if (kind === "screen") return desktopToolForMachinePlatform(machine.platform);
  return kind === "app" ? "app-control" : kind;
}

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
    return { key: choice.machineKey, name: choice.machineName, platform: null, online: false, isChat: false, isViewer: false };
  }
  return machines.find((machine) => machine.isChat) ?? null;
}

/**
 * Where each of this chat's devices is NOW, when that is another machine
 * than the chat's: its device choice (`ade devices use`), else the machine
 * its CURRENT turn drives that kind on with `--machine` (`activeUses`, the
 * row's machines in use this turn). Not a machine it used in an earlier turn.
 * `pickedHere` holds, per kind, the newest such use (`lastStartedAt`, ms) when
 * the person chose the chat's own machine: those uses no longer say where the
 * device is, only a newer one does.
 */
export function currentRemoteDeviceMachines(
  sources: ChatDeviceSources | null,
  machines: readonly ToolMachine[],
  activeUses: readonly AgentChatRemoteWorkUse[],
  pickedHere: Partial<Record<DeviceKind, number>> = {},
): Partial<Record<DeviceKind, ToolMachine>> {
  const out: Partial<Record<DeviceKind, ToolMachine>> = {};
  for (const kind of DEVICE_KIND_ORDER) {
    if (sources?.[kind]) {
      const chosen = chosenMachineFor(kind, sources, machines);
      // A choice of a machine that cannot run the kind (an iPhone on a PC)
      // is not where the device is; the tool asks for one that can.
      if (chosen && !chosen.isChat && deviceKindRunsOnPlatform(kind, chosen.platform)) out[kind] = chosen;
      continue;
    }
    const pickedAt = pickedHere[kind];
    const use = activeUses
      .filter((entry): entry is RemoteWorkCopyUse => entry[DEVICE_KINDS[kind].flag] === true && isRemoteWorkCopyUse(entry)
        && (pickedAt === undefined || Date.parse(entry.lastStartedAt) > pickedAt))
      .sort((a, b) => Date.parse(b.lastStartedAt) - Date.parse(a.lastStartedAt))[0];
    if (!use) continue;
    const listed = machines.find((machine) => sameMachineKey(machine.key, use.machineKey));
    if (listed?.isChat) continue;
    out[kind] = listed ?? {
      key: use.machineKey,
      name: use.machineName,
      platform: remoteMachineHostPlatform(use.machinePlatform),
      online: true,
      isChat: false,
      isViewer: false,
    };
  }
  return out;
}

/** The newest `lastStartedAt` (ms) among the uses that drive `kind`, or -Infinity. */
export function newestDeviceUseAt(kind: DeviceKind, uses: readonly AgentChatRemoteWorkUse[]): number {
  let newest = Number.NEGATIVE_INFINITY;
  for (const use of uses) {
    if (use[DEVICE_KINDS[kind].flag] !== true) continue;
    const at = Date.parse(use.lastStartedAt);
    if (at > newest) newest = at;
  }
  return newest;
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
    if (!isRemoteWorkCopyUse(use) || !sameMachineKey(use.machineKey, machineKey)) continue;
    if (!best || Date.parse(use.lastStartedAt) > Date.parse(best.lastStartedAt)) best = use;
  }
  return best;
}

/** A Mac of the account other than the chat's own is online: a simulator can open there. */
export function onlineMacElsewhere(machines: readonly ToolMachine[]): boolean {
  return machines.some((machine) => !machine.isChat && machine.online && machine.platform === "darwin");
}

/**
 * What a device on another machine is doing, for its tile and the header's
 * dot: the machine is offline, it has none of this chat's code yet, or the
 * device's live state read there (`probe`).
 */
export function remoteDeviceStatus(
  remote: ToolMachine,
  probe: RemoteDeviceProbe | null,
  remoteWork: readonly AgentChatRemoteWorkUse[] | null | undefined,
): { line: string; detail: string; running: boolean } {
  if (!remote.online) {
    return { line: `${remote.name} is offline`, detail: "The tool opens there when it is back", running: false };
  }
  if (!workCopyUseOn(remoteWork, remote.key)) {
    return { line: "Ready there", detail: "Starts with the agent's next command", running: false };
  }
  let line = "Ready";
  if (probe === "running") line = "Running";
  else if (probe === "off") line = "Off";
  return { line, detail: "This chat's code is there", running: probe === "running" };
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
  if (machine.platform === "darwin") return "This Mac";
  if (machine.platform === "win32") return "This PC";
  return "This computer";
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
    if (!isRemoteWorkCopyUse(use) || inUse(use.machineKey) || keyIn(cleaned, use.machineKey)) continue;
    if (out.some((entry) => sameMachineKey(entry.use.machineKey, use.machineKey))) continue;
    const things = ["your code", ...DEVICE_KIND_ORDER.filter((kind) => use[DEVICE_KINDS[kind].flag]).map((kind) => DEVICE_KINDS[kind].thing)];
    out.push({ use, things });
  }
  return out;
}

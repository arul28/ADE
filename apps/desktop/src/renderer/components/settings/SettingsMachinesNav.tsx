import { useMemo } from "react";
import { THIS_MACHINE_NAME } from "../../../shared/machineIdentity";
import type { ProjectMachine } from "../../state/projectMachines";
import { useStableBinding } from "../../state/laneMachineRouting";
import { Banner } from "../ui/notice";
import { settingsMachineScope, type SettingsMachineScope, type SettingsMachineTarget } from "./SettingsMachineScope";

/**
 * The Machines group of Settings: one section per machine, each page scoped to
 * that machine. Everything here decides which machine a page is about, which
 * of its sections can reach it, and how the nav names it.
 */

/**
 * How a Machines page section reaches its machine.
 *  - `routed`: every call takes the machine's pin, so it works for any
 *    reachable machine.
 *  - `local`: plain IPC to the main process ADE runs in (Electron power
 *    blocker, the desktop updater, the `ade` shell installer, the ADE browser),
 *    so it is only ever about This computer.
 *  - `bound`: unpinned calls that follow the tab's binding, so it is shown for
 *    the machine the project tab is bound to and nowhere else.
 */
export type MachineSectionKind = "routed" | "local" | "bound";

/** A Machines page's machine: its scope plus what the page header shows. */
export type SettingsMachinePage = SettingsMachineScope & {
  hasRepo: boolean;
  /** The ADE version another machine reported; its About card can't be shown here. */
  version: string | null;
};

/**
 * How a page reaches `machine`. This computer on its own tab binding is the
 * unpinned path. Every other reachable machine, the tab's own remote machine
 * included, is pinned explicitly, so a section whose unpinned fallback is plain
 * IPC to This computer can never misread it. Null when nothing can reach it.
 */
function settingsTargetFor(machine: ProjectMachine): SettingsMachineTarget | null {
  if (machine.isActiveBinding) {
    if (machine.isThisMachine) return { kind: "this" };
    return machine.binding ? { kind: "pinned", binding: machine.binding } : null;
  }
  return machine.routable && machine.pin ? { kind: "pinned", binding: machine.pin } : null;
}

/** The page scope for a machine in the Machines group. */
export function settingsMachinePageFor(machine: ProjectMachine): SettingsMachinePage {
  return {
    ...settingsMachineScope({
      machineId: machine.machineId,
      machineName: machine.machineName,
      target: settingsTargetFor(machine),
      isThisMachine: machine.isThisMachine,
      isActiveBinding: machine.isActiveBinding,
      online: machine.online,
    }),
    hasRepo: machine.hasRepo,
    version: machine.version,
  };
}

/**
 * The page scope for `machine`, with a pin that keeps its identity until its
 * key changes. The machine list re-derives with fresh pin objects on every
 * sync tick; sections key effects on `pin`, and an in-flight sign-in cancels
 * itself (and its status feed re-anchors past its result) when `pin` changes.
 */
export function useSettingsMachinePage(machine: ProjectMachine | null): SettingsMachinePage | null {
  const derived = useMemo(() => (machine ? settingsMachinePageFor(machine) : null), [machine]);
  const stablePin = useStableBinding(derived?.pin ?? null);
  return useMemo(() => {
    if (!derived || !stablePin || derived.pin === stablePin) return derived;
    return { ...derived, pin: stablePin, target: { kind: "pinned", binding: stablePin } };
  }, [derived, stablePin]);
}

/**
 * Whether a Machines page section can be shown for a machine without any of
 * its calls landing on a different one.
 */
export function machineSectionAvailable(kind: MachineSectionKind, page: SettingsMachineScope): boolean {
  if (!page.online) return false;
  if (kind === "local") return page.isThisMachine;
  if (kind === "bound") return page.isActiveBinding;
  return page.target != null;
}

/**
 * Why some (or all) of a machine's settings are not on screen. Calm, and
 * specific about the reason, because "missing" reads as a bug.
 */
export function MachineUnavailableNotice({
  machine,
  unavailableTitles,
}: {
  machine: SettingsMachinePage;
  unavailableTitles?: string[];
}) {
  const titles = unavailableTitles ?? [];
  const list = titles.length > 1
    ? `${titles.slice(0, -1).join(", ")} and ${titles[titles.length - 1]}`
    : titles[0] ?? "These settings";
  let message: string;
  let detail: string | undefined;
  if (!machine.online) {
    message = `${machine.machineName} is offline. Its settings come back when it does.`;
  } else if (!machine.isThisMachine && !machine.isActiveBinding && !machine.hasRepo) {
    message = `ADE reaches ${machine.machineName}'s settings through its copy of this repository. Open this repository on ${machine.machineName} to manage it from here.`;
  } else if (machine.isThisMachine) {
    message = `${list} can't be reached on ${THIS_MACHINE_NAME} from this project tab yet.`;
  } else {
    message = `Open ADE on ${machine.machineName} to change these.`;
    detail = `${list} ${titles.length === 1 ? "is" : "are"} managed on that computer for now.`;
  }
  return (
    <Banner
      layout="inline"
      testId="settings-machine-unavailable"
      model={{ id: `settings-machine-unavailable:${machine.machineId}`, tone: "neutral", title: message, detail }}
    />
  );
}

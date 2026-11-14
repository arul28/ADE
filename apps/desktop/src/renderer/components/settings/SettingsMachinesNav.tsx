import { useMemo } from "react";
import { THIS_MACHINE_NAME } from "../../../shared/machineIdentity";
import { machineScopePin } from "../../../shared/machineScope";
import type { OpenProjectBinding } from "../../../shared/types";
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
 *  - `machine`: the computer's own settings (Providers). Reaches the machine
 *    through its copy of the repository when there is one, else through the
 *    machine route (`shared/machineScope.ts`), so every online computer and
 *    This computer show up whichever project window is open.
 */
export type MachineSectionKind = "routed" | "local" | "bound" | "machine";

/** A Machines page's machine: its scope plus what the page header shows. */
export type SettingsMachinePage = SettingsMachineScope & {
  /**
   * The machine's own route, with no project (`shared/machineScope.ts`). Set
   * for an online machine the repository route (`target`) cannot reach:
   * This computer from a tab bound elsewhere, or a connected computer
   * without this repository. Only `machine` sections use it.
   */
  machineRoute: OpenProjectBinding | null;
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

/**
 * The machine route for a machine no repository route reaches. This computer
 * always has one; another computer has one while it is online (its id is the
 * saved connection's id). The pin is cached per machine, so it keeps its
 * identity across machine-list ticks.
 */
function machineRouteFor(machine: ProjectMachine, target: SettingsMachineTarget | null): OpenProjectBinding | null {
  if (target) return null;
  if (machine.isThisMachine) return machineScopePin({ kind: "this", name: machine.machineName });
  if (!machine.online) return null;
  return machineScopePin({ kind: "remote", targetId: machine.machineId, name: machine.machineName, hostname: machine.hostname });
}

/** The page scope for a machine in the Machines group. */
export function settingsMachinePageFor(machine: ProjectMachine): SettingsMachinePage {
  const target = settingsTargetFor(machine);
  return {
    ...settingsMachineScope({
      machineId: machine.machineId,
      machineName: machine.machineName,
      target,
      isThisMachine: machine.isThisMachine,
      isActiveBinding: machine.isActiveBinding,
      online: machine.online,
    }),
    machineRoute: machineRouteFor(machine, target),
    hasRepo: machine.hasRepo,
    version: machine.version,
  };
}

/**
 * The scope a `machine` section runs under: the page as it is when the
 * repository route reaches the machine, else the page with its machine route
 * as the pin. Null when neither reaches it.
 */
export function machineRoutedPage(page: SettingsMachinePage): SettingsMachinePage | null {
  if (page.target) return page;
  if (!page.machineRoute) return null;
  return { ...page, target: { kind: "pinned", binding: page.machineRoute }, pin: page.machineRoute };
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
  if (kind === "machine") return page.target != null || ("machineRoute" in page && page.machineRoute != null);
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

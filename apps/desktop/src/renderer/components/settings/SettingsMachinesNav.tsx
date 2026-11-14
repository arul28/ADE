import { useMemo } from "react";
import { THIS_MACHINE_NAME } from "../../../shared/machineIdentity";
import {
  machineScopeDomainAnswered,
  machineScopePin,
  machineScopeUpdateMessage,
  THIS_COMPUTER_MACHINE_SCOPE_UPDATE_MESSAGE,
  type MachineScopeLaterDomain,
} from "../../../shared/machineScope";
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
 *  - `machine`: the computer's own settings (Providers, Terminal shell,
 *    Android devices, the Machines page's Restarts, Update track, Shell and
 *    Keep awake rows). Reaches the machine through its machine route
 *    (`shared/machineScope.ts`), which needs no project and so never waits on
 *    a project's drive; through its copy of the repository only when its ADE
 *    predates the route (or the domain). Every online computer and This
 *    computer show up whichever project window is open. A section of this
 *    kind renders under `routedPageFor`.
 *  - `account`: the account's settings as one computer holds them
 *    (Passwords), reached the same way.
 */
export type MachineSectionKind = "routed" | "local" | "bound" | "machine" | "account";

/** The kinds a page can pick its machine for: each reaches a machine through a pin. */
export type PickableSectionKind = Extract<MachineSectionKind, "routed" | "machine" | "account">;

/** The kinds whose sections run under a routed scope (`routedPageFor`). */
export type RoutedSectionKind = Extract<MachineSectionKind, "machine" | "account">;

export function isRoutedSectionKind(kind: MachineSectionKind | null | undefined): kind is RoutedSectionKind {
  return kind === "machine" || kind === "account";
}

/** A Machines page's machine: its scope plus what the page header shows. */
export type SettingsMachinePage = SettingsMachineScope & {
  /**
   * The machine's own route, with no project (`shared/machineScope.ts`). Set
   * for every online machine; `machine` and `account` sections use it.
   * Project pages (`ProjectCopyScope`) never do.
   */
  machineRoute: OpenProjectBinding | null;
  /**
   * The machine route reaches a brain older than it (no `machineScope`
   * capability): `machine` sections go through its copy of this repository,
   * or say to update ADE there.
   */
  machineRouteOutdated: boolean;
  /**
   * The domains the route's brain answers (`machineScopeDomains`). Null for
   * This computer (its brain is this app's) and for a brain of the route's
   * first version (`machineScopeDomainAnswered`).
   */
  machineRouteDomains: readonly string[] | null;
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
 * A machine's own route. This computer always has one; another computer has
 * one while it is online (its id is the saved connection's id). The pin is
 * cached per machine, so it keeps its identity across machine-list ticks.
 */
function machineRouteFor(machine: ProjectMachine): OpenProjectBinding | null {
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
    machineRoute: machineRouteFor(machine),
    machineRouteOutdated: !machine.isThisMachine && machine.machineScope === false,
    machineRouteDomains: machine.isThisMachine ? null : machine.machineScopeDomains ?? null,
    hasRepo: machine.hasRepo,
    version: machine.version,
  };
}

/**
 * The domain an `account` section needs on the machine route: Passwords is
 * its only one. A `machine` section names its own, when it came after the
 * route's first version.
 */
const ACCOUNT_SECTION_DOMAIN: MachineScopeLaterDomain = "passwords";

/** Whether the page's machine route answers `domain` (`machineScopeDomainAnswered`). */
export function machineRouteAnswers(page: SettingsMachinePage, domain?: MachineScopeLaterDomain | null): boolean {
  return page.machineRoute != null
    && !page.machineRouteOutdated
    && machineScopeDomainAnswered(page.machineRouteDomains, domain);
}

/**
 * The scope a `machine` or `account` section runs under: the page with its
 * machine route as the pin, so a read about the computer never goes through
 * a project (whose drive can stall). `projectTarget` keeps the copy of this
 * repository there, for the few parts that are the project's (Providers'
 * project AI config). A machine whose ADE predates the route, or `domain` on
 * it, is reached through that copy as before. Null when neither reaches it
 * (`MachineUnavailableNotice` says why).
 */
export function routedPageFor(
  kind: RoutedSectionKind,
  page: SettingsMachinePage,
  domain?: MachineScopeLaterDomain | null,
): SettingsMachinePage | null {
  const needs = domain ?? (kind === "account" ? ACCOUNT_SECTION_DOMAIN : null);
  if (page.machineRoute && machineRouteAnswers(page, needs)) {
    if (page.pin?.key === page.machineRoute.key) return page;
    return {
      ...page,
      target: { kind: "pinned", binding: page.machineRoute },
      pin: page.machineRoute,
      projectTarget: page.projectTarget !== undefined ? page.projectTarget : page.target,
    };
  }
  return page.target ? page : null;
}

/**
 * Whether the machine's ADE is too old for `domain` on the machine route and
 * nothing else reaches it, so the section says to update ADE there.
 */
export function machineRouteNeedsUpdate(
  kind: RoutedSectionKind,
  page: SettingsMachinePage,
  domain?: MachineScopeLaterDomain | null,
): boolean {
  if (page.target || !page.machineRoute) return false;
  return !machineRouteAnswers(page, domain ?? (kind === "account" ? ACCOUNT_SECTION_DOMAIN : null));
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
export function machineSectionAvailable(kind: MachineSectionKind, page: SettingsMachinePage): boolean {
  if (!page.online) return false;
  if (kind === "local") return page.isThisMachine;
  if (kind === "bound") return page.isActiveBinding;
  if (kind === "machine" || kind === "account") return page.target != null || page.machineRoute != null;
  return page.target != null;
}

/**
 * Why some (or all) of a machine's settings are not on screen. Calm, and
 * specific about the reason, because "missing" reads as a bug.
 */
export function MachineUnavailableNotice({
  machine,
  unavailableTitles,
  needsUpdate = false,
}: {
  machine: SettingsMachinePage;
  unavailableTitles?: string[];
  /** Its ADE answers the machine route, but not these settings yet (`machineRouteNeedsUpdate`). */
  needsUpdate?: boolean;
}) {
  const titles = unavailableTitles ?? [];
  const list = titles.length > 1
    ? `${titles.slice(0, -1).join(", ")} and ${titles[titles.length - 1]}`
    : titles[0] ?? "These settings";
  let message: string;
  let detail: string | undefined;
  if (!machine.online) {
    message = `${machine.machineName} is offline. Its settings come back when it does.`;
  } else if (machine.machineRouteOutdated || needsUpdate) {
    message = machine.isThisMachine ? THIS_COMPUTER_MACHINE_SCOPE_UPDATE_MESSAGE : machineScopeUpdateMessage(machine.machineName);
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

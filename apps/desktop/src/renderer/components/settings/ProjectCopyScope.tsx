import React, { useMemo } from "react";
import { THIS_MACHINE_ID, THIS_MACHINE_NAME } from "../../../shared/machineIdentity";
import type { OpenProjectBinding } from "../../../shared/types";
import type { ProjectMachine } from "../../state/projectMachines";
import { useActiveRepositoryCopies, useCopyPick, useOnlineCopyPins, useTabCopyPin, type CopyPick } from "../../state/repositoryScope";
import { Banner } from "../ui/notice";
import { MachinePicker } from "./ProvidersMachinePicker";
import { settingsMachineScope, SettingsMachineScopeProvider, useSettingsMachineScope } from "./SettingsMachineScope";
import { MachineUnavailableNotice, settingsMachinePageFor, type SettingsMachinePage } from "./SettingsMachinesNav";
import { useSettingsMachines } from "./machines/settingsMachinesContext";
import "./machines/machinesPage.css";

/**
 * Settings › Project pages read one copy of the open project, on one computer.
 * The person picks the copy (`useCopyPick`, remembered per project and page);
 * the default is the copy the tab is on, which is where these pages read
 * before they had a picker.
 *
 * Every section under the page reads the copy's pin from
 * `useSettingsMachineScope()`. The pin is never null here, the tab's own copy
 * included, so no call takes the tab's default route.
 */

/**
 * This computer's copy of the open project, for a setting that only matters
 * where this desktop runs (how it opens links). Null when this computer has
 * no copy online, and always in the hosted web client.
 */
export function useThisComputerCopyPin(active = true): OpenProjectBinding | null {
  return useOnlineCopyPins(active).find((pin) => pin.kind === "local") ?? null;
}

/**
 * The pin for a read on the machine a Settings page is about. A pinned page
 * gives its pin. A page about This computer while the tab is on this computer
 * has no pin (its calls take the tab's route); this gives the tab's own copy,
 * which is the same computer and shares the same caches, so the read names its
 * machine. Null otherwise, which keeps the old route.
 */
export function useSettingsReadPin(): OpenProjectBinding | null {
  const scope = useSettingsMachineScope();
  const tabPin = useTabCopyPin();
  if (scope.pin) return scope.pin;
  return scope.isThisMachine && tabPin?.kind === "local" ? tabPin : null;
}

/** The `useCopyPick` scope of a Settings page. */
export function settingsCopyScope(page: string): string {
  return `settings.${page}`;
}

function machineForPin(machines: readonly ProjectMachine[], pin: OpenProjectBinding): ProjectMachine | null {
  return machines.find((machine) => machine.pin?.key === pin.key)
    ?? machines.find((machine) => machine.binding?.key === pin.key)
    ?? null;
}

/**
 * The page scope for one copy: the machine's own page facts when Settings
 * knows the machine, else facts read off the copy. The target is always the
 * copy's pin.
 */
function copyPageFor(
  pin: OpenProjectBinding,
  machine: ProjectMachine | null,
  fallback: { machineId: string; machineName: string; isThisMachine: boolean },
  tabPinKey: string | null,
): SettingsMachinePage {
  const base = machine ? settingsMachinePageFor(machine) : null;
  return {
    ...settingsMachineScope({
      machineId: base?.machineId ?? fallback.machineId,
      machineName: base?.machineName ?? fallback.machineName,
      target: { kind: "pinned", binding: pin },
      isThisMachine: base?.isThisMachine ?? fallback.isThisMachine,
      isActiveBinding: pin.key === tabPinKey,
      // The tab's own copy is offered even while its machine is away; the
      // page then says so instead of calling it.
      online: base?.online ?? true,
    }),
    // A project page reads the copy, never the machine route.
    machineRoute: null,
    machineRouteOutdated: false,
    hasRepo: true,
    version: base?.version ?? null,
  };
}

export type ProjectCopyPage = {
  pick: CopyPick;
  /** The picked copy as a Settings page scope. Null when no copy is online. */
  page: SettingsMachinePage | null;
  /** The machines of the online copies, for the picker. */
  choices: ProjectMachine[];
  thisMachineName: string | null;
};

/** The copy a Settings page reads, picked per project and page. */
export function useProjectCopyPage(scope: string, active = true): ProjectCopyPage {
  const pick = useCopyPick(scope, active);
  const tabPin = useTabCopyPin();
  const copies = useActiveRepositoryCopies(active);
  const { machines, thisMachineName } = useSettingsMachines();
  const tabPinKey = tabPin?.key ?? null;

  const page = useMemo(() => {
    const pin = pick.pin;
    if (!pin) return null;
    const copy = copies.find((candidate) => candidate.address?.key === pin.key) ?? null;
    const isThisMachine = copy?.isThisMachine ?? pin.kind === "local";
    return copyPageFor(pin, machineForPin(machines, pin), {
      machineId: copy?.machineId ?? (pin.kind === "remote" ? pin.targetId : THIS_MACHINE_ID),
      machineName: copy?.machineName
        ?? (pin.kind === "remote" ? pin.runtimeName || pin.hostname || pin.displayName : thisMachineName ?? THIS_MACHINE_NAME),
      isThisMachine,
    }, tabPinKey);
  }, [copies, machines, pick.pin, tabPinKey, thisMachineName]);

  const choices = useMemo(() => {
    const seen = new Set<string>();
    const list: ProjectMachine[] = [];
    for (const pin of pick.pins) {
      const machine = machineForPin(machines, pin);
      if (!machine || seen.has(machine.machineId)) continue;
      seen.add(machine.machineId);
      list.push(machine);
    }
    return list;
  }, [machines, pick.pins]);

  return { pick, page, choices, thisMachineName };
}

/**
 * The line above a project page that names the computer it reads, with a
 * picker when the project has copies on more than one online computer. With
 * no picker, it names the computer only when it is not this one.
 */
export function ProjectCopyBar({ copy }: { copy: ProjectCopyPage }) {
  const { page, pick, choices, thisMachineName } = copy;
  if (!page) return null;
  const pickable = choices.length >= 2;
  if (!pickable && page.isThisMachine) return null;
  const name = page.isThisMachine ? (thisMachineName ?? page.machineName) : page.machineName;
  return (
    <div className="ade-copy-scope" data-testid="settings-copy-scope">
      <span className="ade-copy-scope-label">{pickable ? "Showing the copy on" : "Copy on"}</span>
      {pickable ? (
        <MachinePicker
          machines={choices}
          selectedId={page.machineId}
          thisMachineName={thisMachineName}
          onPick={(machineId) => {
            const machine = choices.find((candidate) => candidate.machineId === machineId);
            const key = machine?.pin?.key ?? machine?.binding?.key ?? null;
            if (key) pick.pick(key);
          }}
        />
      ) : (
        <span className="ade-copy-scope-name" title={name}>{name}</span>
      )}
    </div>
  );
}

/** What a project page shows when no computer with a copy of the project is online. */
export function NoProjectCopyNotice() {
  return (
    <Banner
      layout="inline"
      testId="settings-no-project-copy"
      model={{
        id: "settings-no-project-copy",
        tone: "neutral",
        title: "No computer with this project is online",
        detail: "These settings live in a copy of the project. They come back when a computer with a copy connects.",
      }}
    />
  );
}

/** The pin a project block calls through: the picked copy, only while its computer is online. */
export function onlineCopyPin(copy: ProjectCopyPage): OpenProjectBinding | null {
  return copy.page?.online ? copy.page.pin : null;
}

/**
 * What a project block shows in place of its settings when it cannot call:
 * the picked copy's computer is offline (the line still offers the others),
 * or no computer with a copy is online.
 */
export function ProjectCopyUnavailable({ copy }: { copy: ProjectCopyPage }) {
  if (!copy.page) return <NoProjectCopyNotice />;
  return (
    <>
      <ProjectCopyBar copy={copy} />
      <MachineUnavailableNotice machine={copy.page} />
    </>
  );
}

/**
 * Hands a project page the picked copy as its machine scope. Keyed by the
 * copy, so nothing one copy loaded lingers into, or is saved onto, another.
 */
export function ProjectCopyScopeProvider({
  page,
  children,
}: {
  page: SettingsMachinePage;
  children: React.ReactNode;
}) {
  return (
    <SettingsMachineScopeProvider key={page.pin?.key ?? page.machineId} scope={page}>
      {children}
    </SettingsMachineScopeProvider>
  );
}

/**
 * A block of project settings on a page that is not a project page (App ›
 * Chat): it names the copy it reads, offers the others, and hands its
 * sections the copy's pin. With no copy online it says so.
 */
export function ProjectCopyBlock({ page, children }: { page: string; children: React.ReactNode }) {
  const copy = useProjectCopyPage(settingsCopyScope(page));
  if (!copy.page || !onlineCopyPin(copy)) return <ProjectCopyUnavailable copy={copy} />;
  return (
    <ProjectCopyScopeProvider page={copy.page}>
      {/* Sits close above the sections it names, in a stack with wide gaps. */}
      <div className="ade-copy-scope-block">
        <ProjectCopyBar copy={copy} />
      </div>
      {children}
    </ProjectCopyScopeProvider>
  );
}

import React, { useState } from "react";
import { Desktop, HardDrives } from "@phosphor-icons/react";
import { THIS_MACHINE_NAME } from "../../../shared/machineIdentity";
import type { ProjectMachine } from "../../state/projectMachines";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
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
  const list = unavailableTitles?.join(", ") ?? "These settings";
  let message: string;
  if (!machine.online) {
    message = `${machine.machineName} is offline. Its settings come back when it does.`;
  } else if (!machine.isThisMachine && !machine.isActiveBinding && !machine.hasRepo) {
    message = `ADE reaches ${machine.machineName}'s settings through its copy of this repository. Open this repository on ${machine.machineName} to manage it from here.`;
  } else if (machine.isThisMachine) {
    message = `${list} can't be reached on ${THIS_MACHINE_NAME} from this project tab yet.`;
  } else {
    message = `${list} can only be changed on ${machine.machineName} itself for now.`;
  }
  return (
    <Banner
      layout="inline"
      testId="settings-machine-unavailable"
      model={{ id: `settings-machine-unavailable:${machine.machineId}`, tone: "neutral", title: message }}
    />
  );
}

/**
 * One machine in the Machines group. The selected one opens to its pages
 * (`children`); the rest stay a single row. Offline machines are dimmed, not
 * hidden.
 */
export function SettingsMachineNavRow({
  machine,
  selected,
  active,
  onOpen,
  children,
}: {
  machine: ProjectMachine;
  /** This machine's pages are the ones listed. */
  selected: boolean;
  /** One of this machine's pages is on screen. */
  active: boolean;
  onOpen: () => void;
  children?: React.ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  const Icon = machine.isThisMachine ? Desktop : HardDrives;
  return (
    <div data-testid={`settings-machine-${machine.machineId}`}>
      <button
        type="button"
        onClick={onOpen}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        title={machine.online ? undefined : `${machine.machineName} is offline`}
        style={{
          display: "flex",
          width: "100%",
          alignItems: "center",
          gap: 9,
          padding: "6px 10px",
          border: "none",
          background: hovered && !active ? "var(--shell-sidebar-item-hover-bg)" : "transparent",
          color: active || hovered ? "var(--shell-sidebar-item-hover-fg)" : "var(--shell-sidebar-item-fg)",
          opacity: machine.online ? 1 : 0.5,
          fontFamily: SANS_FONT,
          fontSize: 12.5,
          fontWeight: active ? 600 : 500,
          letterSpacing: "-0.01em",
          cursor: "pointer",
          borderRadius: 7,
          textAlign: "left",
          transition: "background 120ms ease, color 120ms ease",
        }}
      >
        <Icon size={14} weight="regular" style={{ flexShrink: 0 }} />
        <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {machine.machineName}
        </span>
        {machine.online ? null : (
          <span style={{ fontSize: 10.5, fontWeight: 500, opacity: 0.8 }}>offline</span>
        )}
      </button>
      {selected ? children : null}
    </div>
  );
}

/** The machine a Machines page is about, above its title. */
export function SettingsMachineEyebrow({ page }: { page: SettingsMachinePage }) {
  return (
    <div
      data-testid="settings-machine-eyebrow"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        marginBottom: 4,
        fontFamily: SANS_FONT,
        fontSize: 11.5,
        color: COLORS.textMuted,
        opacity: page.online ? 1 : 0.6,
      }}
    >
      {page.isThisMachine ? <Desktop size={12} weight="regular" /> : <HardDrives size={12} weight="regular" />}
      <span>{page.machineName}</span>
      {page.version && !page.isThisMachine ? <span>· ADE {page.version}</span> : null}
      {page.online ? null : <span>· offline</span>}
    </div>
  );
}

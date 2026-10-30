import { useMemo, useRef, useState } from "react";
import { CaretDown, Check } from "@phosphor-icons/react";
import type { ProjectMachine } from "../../state/projectMachines";
import { AnchoredMenu } from "../ui/AnchoredMenu";
import { MachineAvatar, machineFormFactor } from "../remoteTargets/MachineIdentity";
import { machineSectionAvailable, settingsMachinePageFor } from "./SettingsMachinesNav";
import { useMachineFacts, type MachineFacts } from "./machines/machineFacts";
import { useAutoUpdateSnapshot } from "../app/useAutoUpdateSnapshot";
import "./machines/machinesPage.css";

/** The machines whose brain a setting can be read and changed through from here. */
export function reachableMachines(machines: readonly ProjectMachine[]): ProjectMachine[] {
  return machines.filter((machine) => machineSectionAvailable("routed", settingsMachinePageFor(machine)));
}

/**
 * A machine as a tile and a name, opening a menu of the machines a page can
 * act on. Only machines reachable from here are offered; with just one,
 * nothing is drawn and the page acts on This computer.
 */
export function MachinePicker({
  machines,
  selectedId,
  thisMachineName,
  onPick,
  variant = "inline",
}: {
  machines: readonly ProjectMachine[];
  selectedId: string;
  thisMachineName: string | null;
  onPick: (machineId: string) => void;
  /** `title`: sits in a page title ("Providers on [machine ▾]"), at its size. */
  variant?: "inline" | "title";
}) {
  const reachable = useMemo(() => reachableMachines(machines), [machines]);
  const update = useAutoUpdateSnapshot();
  const facts = useMachineFacts(reachable, update.currentVersion || null);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  if (reachable.length < 2) return null;
  const selected = reachable.find((machine) => machine.machineId === selectedId) ?? reachable[0]!;
  const nameOf = (machine: ProjectMachine) => (machine.isThisMachine ? (thisMachineName ?? machine.machineName) : machine.machineName);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="ade-mpick-trigger"
        data-variant={variant}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Machine: ${nameOf(selected)}`}
        data-testid="settings-machine-picker"
        onClick={() => setOpen((value) => !value)}
      >
        <PickerTile machine={selected} facts={facts.get(selected.machineId)} size={variant === "title" ? 24 : 20} />
        <span className="ade-mpick-name">{nameOf(selected)}</span>
        <CaretDown size={variant === "title" ? 13 : 11} weight="bold" aria-hidden />
      </button>
      <AnchoredMenu
        open={open}
        anchorRef={anchorRef}
        onClose={() => setOpen(false)}
        role="menu"
        aria-label="Machine"
        className="ade-mpick-menu"
      >
        {reachable.map((machine) => {
          const isSelected = machine.machineId === selected.machineId;
          return (
            <button
              key={machine.machineId}
              type="button"
              role="menuitemradio"
              aria-checked={isSelected}
              className="ade-mpick-item"
              onClick={() => {
                setOpen(false);
                if (!isSelected) onPick(machine.machineId);
              }}
            >
              <PickerTile machine={machine} facts={facts.get(machine.machineId)} size={22} />
              <span className="ade-mpick-item-name">{nameOf(machine)}</span>
              {isSelected ? <Check size={12} weight="bold" aria-hidden /> : <span aria-hidden />}
            </button>
          );
        })}
      </AnchoredMenu>
    </>
  );
}

function PickerTile({ machine, facts, size }: { machine: ProjectMachine; facts: MachineFacts | undefined; size: number }) {
  return (
    <MachineAvatar
      colorKey={facts?.colorKey ?? machine.machineId}
      name={machine.machineName}
      platform={facts?.platform ?? "unknown"}
      formFactor={machineFormFactor({ name: machine.machineName })}
      size={size}
    />
  );
}

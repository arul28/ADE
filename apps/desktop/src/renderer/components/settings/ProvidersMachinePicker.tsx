import { useMemo, useRef, useState } from "react";
import { CaretDown, Check } from "@phosphor-icons/react";
import type { ProjectMachine } from "../../state/projectMachines";
import { AnchoredMenu } from "../ui/AnchoredMenu";
import { MachineAvatar, machineFormFactor } from "../remoteTargets/MachineIdentity";
import { machineSectionAvailable, settingsMachinePageFor } from "./SettingsMachinesNav";
import { useMachineFacts, type MachineFacts } from "./machines/machineFacts";
import { useAutoUpdateSnapshot } from "../app/useAutoUpdateSnapshot";
import { useSettingsMachines } from "./machines/settingsMachinesContext";
import { useSettingsMachineScope } from "./SettingsMachineScope";
import "./machines/machinesPage.css";

/**
 * "Providers on: <machine> ▾": the one place Providers picks the machine it
 * shows. Only machines whose providers can be reached from here are offered
 * (online, with a route for pinned calls); with just one, nothing is drawn.
 */
export function ProvidersMachinePicker() {
  const { machines, thisMachineName, openMachine } = useSettingsMachines();
  const nameOf = (machine: ProjectMachine) => (machine.isThisMachine ? (thisMachineName ?? machine.machineName) : machine.machineName);
  const { machineId: selectedId } = useSettingsMachineScope();
  const onPick = (machineId: string) => openMachine(machineId, "agents");
  const reachable = useMemo(
    () => machines.filter((machine) => machineSectionAvailable("routed", settingsMachinePageFor(machine))),
    [machines],
  );
  const update = useAutoUpdateSnapshot();
  const facts = useMachineFacts(reachable, update.currentVersion || null);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  if (reachable.length < 2) return null;
  const selected = reachable.find((machine) => machine.machineId === selectedId) ?? reachable[0]!;

  return (
    <div className="ade-mpick" data-testid="providers-machine-picker">
      <span className="ade-mpick-label">Providers on</span>
      <button
        ref={anchorRef}
        type="button"
        className="ade-mpick-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <PickerTile machine={selected} facts={facts.get(selected.machineId)} />
        <span className="ade-mpick-name">{nameOf(selected)}</span>
        <CaretDown size={11} weight="bold" aria-hidden />
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
              <PickerTile machine={machine} facts={facts.get(machine.machineId)} />
              <span className="ade-mpick-item-name">{nameOf(machine)}</span>
              {isSelected ? <Check size={12} weight="bold" aria-hidden /> : <span aria-hidden />}
            </button>
          );
        })}
      </AnchoredMenu>
    </div>
  );
}

function PickerTile({ machine, facts }: { machine: ProjectMachine; facts: MachineFacts | undefined }) {
  return (
    <MachineAvatar
      colorKey={facts?.colorKey ?? machine.machineId}
      name={machine.machineName}
      platform={facts?.platform ?? "unknown"}
      formFactor={machineFormFactor({ name: machine.machineName })}
      size={22}
    />
  );
}

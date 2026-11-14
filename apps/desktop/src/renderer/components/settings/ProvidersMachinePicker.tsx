import { useMemo, useRef, useState } from "react";
import { CaretDown, Check } from "@phosphor-icons/react";
import type { ProjectMachine } from "../../state/projectMachines";
import { AnchoredMenu } from "../ui/AnchoredMenu";
import { MachineAvatar, machineFormFactor } from "../remoteTargets/MachineIdentity";
import { machineSectionAvailable, settingsMachinePageFor, type PickableSectionKind } from "./SettingsMachinesNav";
import { useMachineFacts, type MachineFacts } from "./machines/machineFacts";
import { useAutoUpdateSnapshot } from "../app/useAutoUpdateSnapshot";
import { ADE_CLOUD_NAME, CloudMark } from "../remoteTargets/cloudBrand";
import "./machines/machinesPage.css";

/**
 * The machines whose brain a setting can be read and changed through from
 * here. `kind` is how the page's sections reach a machine: `machine` (Providers)
 * reaches every online computer and This computer, with or without this
 * repository; `account` (Passwords) This computer and the others it reaches
 * through a copy of it; `routed` only those it reaches through a copy of it.
 */
export function reachableMachines(
  machines: readonly ProjectMachine[],
  kind: PickableSectionKind = "routed",
): ProjectMachine[] {
  return machines.filter((machine) => machineSectionAvailable(kind, settingsMachinePageFor(machine)));
}

/**
 * A machine as a tile and a name, opening a menu of the machines a page can
 * act on. Only machines reachable from here are offered; with just one (and
 * no ADE Cloud item), nothing is drawn and the page acts on This computer.
 *
 * `adeCloud`: Providers also offers ADE Cloud, after a rule. It is not a
 * machine; the page says what cloud chats sign in with.
 */
export function MachinePicker({
  machines,
  selectedId,
  thisMachineName,
  onPick,
  variant = "inline",
  adeCloud = null,
  kind = "routed",
}: {
  machines: readonly ProjectMachine[];
  selectedId: string;
  thisMachineName: string | null;
  onPick: (machineId: string) => void;
  /** `title`: sits in a page title ("Providers on [machine ▾]"), at its size. */
  variant?: "inline" | "title";
  adeCloud?: { selected: boolean; onPick: () => void } | null;
  /** How the page reaches a machine (`reachableMachines`). */
  kind?: PickableSectionKind;
}) {
  const reachable = useMemo(() => reachableMachines(machines, kind), [kind, machines]);
  const update = useAutoUpdateSnapshot();
  const facts = useMachineFacts(reachable, update.currentVersion || null);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  if (reachable.length < (adeCloud ? 1 : 2)) return null;
  // The trigger names the machine the page is about, reachable or not (the
  // page then says why it can't show it). Naming another one here would put
  // one computer in the title and act on a different one.
  const selected = machines.find((machine) => machine.machineId === selectedId) ?? reachable[0]!;
  const nameOf = (machine: ProjectMachine) => (machine.isThisMachine ? (thisMachineName ?? machine.machineName) : machine.machineName);
  const cloudSelected = adeCloud?.selected === true;
  const triggerName = cloudSelected ? ADE_CLOUD_NAME : nameOf(selected);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="ade-mpick-trigger"
        data-variant={variant}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Machine: ${triggerName}`}
        data-testid="settings-machine-picker"
        onClick={() => setOpen((value) => !value)}
      >
        {cloudSelected
          ? <CloudTile size={variant === "title" ? 24 : 20} />
          : <PickerTile machine={selected} facts={facts.get(selected.machineId)} size={variant === "title" ? 24 : 20} />}
        <span className="ade-mpick-name">{triggerName}</span>
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
        {(reachable.includes(selected) || cloudSelected ? reachable : [selected, ...reachable]).map((machine) => {
          const isSelected = !cloudSelected && machine.machineId === selected.machineId;
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
        {adeCloud ? (
          <>
            <div role="separator" className="ade-mpick-rule" />
            <button
              type="button"
              role="menuitemradio"
              aria-checked={cloudSelected}
              className="ade-mpick-item"
              data-testid="settings-machine-picker-ade-cloud"
              onClick={() => {
                setOpen(false);
                if (!cloudSelected) adeCloud.onPick();
              }}
            >
              <CloudTile size={22} />
              <span className="ade-mpick-item-name">{ADE_CLOUD_NAME}</span>
              {cloudSelected ? <Check size={12} weight="bold" aria-hidden /> : <span aria-hidden />}
            </button>
          </>
        ) : null}
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

/** ADE Cloud's mark at a machine tile's size. */
function CloudTile({ size }: { size: number }) {
  return (
    <span className="ade-mpick-cloud" style={{ width: size, height: size }} aria-hidden>
      <CloudMark size={Math.round(size * 0.62)} bold />
    </span>
  );
}

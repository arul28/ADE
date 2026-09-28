import { Desktop, DesktopTower } from "@phosphor-icons/react";
import { cn } from "../../ui/cn";
import { inputCls } from "../designTokens";
import type { LaneMachine } from "../../../state/laneMachineRouting";

/**
 * "Runs on [machine ▾]" — the machine a rule runs on, as part of the recipe.
 *
 * New rules start with nothing selected (the machine is always a choice, never
 * a silent default) unless exactly one machine can take the rule. Offline
 * machines are listed but can't be chosen. For a saved rule, picking another
 * machine is a move, which the workspace confirms on Save.
 */
export function RuleMachineField({
  machines,
  valueMachineId,
  onChange,
  savedMachineId,
  disabled,
}: {
  machines: readonly LaneMachine[];
  /** Selected machine, or null while nothing is chosen. */
  valueMachineId: string | null;
  onChange: (machineId: string) => void;
  /** Where the saved rule lives today; null for a new rule. */
  savedMachineId: string | null;
  disabled?: boolean;
}) {
  const selected = valueMachineId ? machines.find((machine) => machine.machineId === valueMachineId) ?? null : null;
  const Icon = selected?.isThisMachine ? Desktop : DesktopTower;
  const moving = Boolean(savedMachineId && valueMachineId && savedMachineId !== valueMachineId);
  const savedName = savedMachineId ? machines.find((machine) => machine.machineId === savedMachineId)?.machineName ?? null : null;
  return (
    <div className="mb-3 space-y-1" data-testid="automation-machine-field">
      <label className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-[11px] text-muted-fg/70">Runs on</span>
        <span className="relative flex min-w-0 flex-1 items-center">
          <Icon size={12} weight="duotone" className="pointer-events-none absolute left-2 text-muted-fg/60" aria-hidden />
          <select
            className={cn(inputCls, "h-7 min-w-0 flex-1 pl-7", !valueMachineId && "text-muted-fg/60")}
            value={valueMachineId ?? ""}
            disabled={disabled}
            aria-label="Machine this automation runs on"
            aria-invalid={!valueMachineId}
            onChange={(event) => {
              if (event.target.value) onChange(event.target.value);
            }}
          >
            {!valueMachineId ? <option value="" disabled>Choose a machine</option> : null}
            {machines.map((machine) => (
              <option key={machine.machineId} value={machine.machineId} disabled={!machine.online}>
                {machine.machineName}
                {machine.online ? "" : " (offline)"}
              </option>
            ))}
          </select>
        </span>
      </label>
      {!valueMachineId ? (
        <div className="text-[10.5px] text-amber-300/80" data-testid="automation-machine-required">
          Choose the machine this automation runs on before saving.
        </div>
      ) : moving ? (
        <div className="text-[10.5px] text-muted-fg/60">
          Saving moves this rule from {savedName ?? "its machine"} to {selected?.machineName ?? "the new machine"}.
          Its run history stays on {savedName ?? "the old machine"}.
        </div>
      ) : null}
    </div>
  );
}

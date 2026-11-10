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
 * machine is a move, which the workspace confirms on Save. A rule that follows
 * the account is already on every machine; picking another one only changes
 * which machine runs it.
 */
const UNREACHABLE_HOME = "__home__";

export function RuleMachineField({
  machines,
  valueMachineId,
  onChange,
  savedMachineId,
  followsAccount = false,
  unreachableHomeName = null,
  homeGaps = [],
  disabled,
}: {
  machines: readonly LaneMachine[];
  /** Selected machine, or null while nothing is chosen. */
  valueMachineId: string | null;
  onChange: (machineId: string) => void;
  /** Where the saved rule lives today; null for a new rule. */
  savedMachineId: string | null;
  /** The rule follows the account: every machine shows it, one runs it. */
  followsAccount?: boolean;
  /** The machine that runs it, when this window cannot reach that machine. */
  unreachableHomeName?: string | null;
  /** What the rule needs on the machine that runs it and does not find there. */
  homeGaps?: readonly string[];
  disabled?: boolean;
}) {
  const selected = valueMachineId ? machines.find((machine) => machine.machineId === valueMachineId) ?? null : null;
  const Icon = selected?.isThisMachine ? Desktop : DesktopTower;
  const moving = Boolean(savedMachineId && valueMachineId && savedMachineId !== valueMachineId);
  const savedName = unreachableHomeName
    ?? (savedMachineId ? machines.find((machine) => machine.machineId === savedMachineId)?.machineName ?? null : null);
  const selectValue = unreachableHomeName ? UNREACHABLE_HOME : valueMachineId ?? "";
  return (
    <div className="mb-3 space-y-1" data-testid="automation-machine-field">
      <label className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-[11px] text-muted-fg/70">Runs on</span>
        <span className="relative flex min-w-0 flex-1 items-center">
          <Icon size={12} weight="duotone" className="pointer-events-none absolute left-2 text-muted-fg/60" aria-hidden />
          <select
            className={cn(inputCls, "h-7 min-w-0 flex-1 pl-7", !valueMachineId && "text-muted-fg/60")}
            value={selectValue}
            disabled={disabled}
            aria-label="Machine this automation runs on"
            aria-invalid={!valueMachineId}
            onChange={(event) => {
              if (event.target.value && event.target.value !== UNREACHABLE_HOME) onChange(event.target.value);
            }}
          >
            {!valueMachineId && !unreachableHomeName ? <option value="" disabled>Choose a machine</option> : null}
            {unreachableHomeName ? (
              <option value={UNREACHABLE_HOME} disabled>{unreachableHomeName} (not reachable from here)</option>
            ) : null}
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
      ) : moving && followsAccount ? (
        <div className="text-[10.5px] text-muted-fg/60">
          Saving makes {selected?.machineName ?? "the new machine"} run this rule instead of {savedName ?? "its machine"}.
          Every computer with this repository still shows it; its run history stays on {savedName ?? "the old machine"}.
        </div>
      ) : moving ? (
        <div className="text-[10.5px] text-muted-fg/60">
          Saving moves this rule from {savedName ?? "its machine"} to {selected?.machineName ?? "the new machine"}.
          Its run history stays on {savedName ?? "the old machine"}.
        </div>
      ) : followsAccount ? (
        <div className="text-[10.5px] text-muted-fg/50" data-testid="automation-machine-follows-account">
          Follows your ADE account: every computer with this repository shows it, only this one runs it.
        </div>
      ) : null}
      {homeGaps.length > 0 && !moving ? (
        <div className="text-[10.5px] text-amber-300/80" data-testid="automation-machine-gaps">
          {homeGaps.map((gap) => <div key={gap}>{gap}</div>)}
        </div>
      ) : null}
    </div>
  );
}

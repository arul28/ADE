import { Desktop, DesktopTower } from "@phosphor-icons/react";
import { cn } from "../../ui/cn";
import { SmartTooltip } from "../../ui/SmartTooltip";
import { inputCls } from "../designTokens";
import type { LaneMachine } from "../../../state/laneMachineRouting";
import type { RuleSyncLine } from "../ruleSync";

/**
 * "Runs on [machine ▾]" — the machine a rule runs on, as part of the recipe.
 *
 * New rules start with nothing selected (the machine is always a choice, never
 * a silent default) unless exactly one machine can take the rule. Offline
 * machines are listed but can't be chosen. For a saved rule, picking another
 * machine is a move, which the workspace confirms on Save. A rule that follows
 * the account is already on every machine; picking another one only changes
 * which machine runs it. One quiet line under the field says where the rule
 * lives (`ruleSyncLine`).
 */
const UNREACHABLE_HOME = "__home__";

export function RuleMachineField({
  machines,
  valueMachineId,
  onChange,
  savedMachineId,
  followsAccount = false,
  unreachableHomeName = null,
  homeName = null,
  rehoming = false,
  sync = null,
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
  /** The name of the computer that runs it today, for a rule that follows the account. */
  homeName?: string | null;
  /** A new machine was picked for a rule whose home this window can't reach. */
  rehoming?: boolean;
  /** Where the saved rule lives and who runs it; null for a new rule. */
  sync?: RuleSyncLine | null;
  disabled?: boolean;
}) {
  const selected = valueMachineId ? machines.find((machine) => machine.machineId === valueMachineId) ?? null : null;
  const Icon = selected?.isThisMachine ? Desktop : DesktopTower;
  const moving = rehoming || Boolean(savedMachineId && valueMachineId && savedMachineId !== valueMachineId);
  const savedName = unreachableHomeName
    ?? homeName
    ?? (savedMachineId ? machines.find((machine) => machine.machineId === savedMachineId)?.machineName ?? null : null);
  const selectValue = unreachableHomeName ? UNREACHABLE_HOME : valueMachineId ?? "";
  const SyncIcon = sync?.icon ?? null;
  return (
    <div className="mb-3 space-y-1.5" data-testid="automation-machine-field">
      <label className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-[11px] text-muted-fg/70">Runs on</span>
        <span className="relative flex min-w-0 flex-1 items-center">
          <Icon size={12} weight="duotone" className="pointer-events-none absolute left-2 text-muted-fg/60" aria-hidden />
          <select
            className={cn(inputCls, "h-7 min-w-0 flex-1 pl-7", !valueMachineId && !unreachableHomeName && "text-muted-fg/60")}
            value={selectValue}
            disabled={disabled}
            aria-label="Machine this automation runs on"
            aria-invalid={!valueMachineId && !unreachableHomeName}
            onChange={(event) => {
              if (event.target.value && event.target.value !== UNREACHABLE_HOME) onChange(event.target.value);
            }}
          >
            {!valueMachineId && !unreachableHomeName ? <option value="" disabled>Choose a machine</option> : null}
            {unreachableHomeName ? (
              <option value={UNREACHABLE_HOME} disabled>{unreachableHomeName} (not connected to this window)</option>
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
      {!valueMachineId && !unreachableHomeName ? (
        <div className="text-[10.5px] text-amber-300/80" data-testid="automation-machine-required">
          Choose the machine this automation runs on before saving.
        </div>
      ) : moving && followsAccount ? (
        <div className="text-[10.5px] text-muted-fg/60" data-testid="automation-machine-moving">
          Saving hands it to {selected?.machineName ?? "the new machine"}. {savedName ?? "Its machine"} stops within a minute,
          and {selected?.machineName ?? "the new machine"} starts two minutes after you save. Run history stays on {savedName ?? "the old machine"}.
        </div>
      ) : moving ? (
        <div className="text-[10.5px] text-muted-fg/60" data-testid="automation-machine-moving">
          Saving moves this rule from {savedName ?? "its machine"} to {selected?.machineName ?? "the new machine"}.
          Its run history stays on {savedName ?? "the old machine"}.
        </div>
      ) : sync && SyncIcon ? (
        <SmartTooltip content={{ label: sync.label, description: sync.detail }} wrapperClassName="max-w-full">
          <div
            className={cn(
              "inline-flex max-w-full items-center gap-1.5 text-[10.5px]",
              sync.tone === "notice" ? "text-amber-300/80" : "text-muted-fg/55",
            )}
            data-testid="automation-machine-sync"
            data-sync-tone={sync.tone}
            tabIndex={0}
          >
            <SyncIcon size={12} weight={sync.tone === "notice" ? "bold" : "regular"} className="shrink-0" aria-hidden />
            <span className="truncate">{sync.label}</span>
          </div>
        </SmartTooltip>
      ) : null}
    </div>
  );
}

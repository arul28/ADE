import { Desktop, DesktopTower } from "@phosphor-icons/react";
import { cn } from "../../ui/cn";
import { SmartTooltip } from "../../ui/SmartTooltip";
import { inputCls } from "../designTokens";
import type { LaneMachine } from "../../../state/laneMachineRouting";
import type { RuleSyncLine } from "../ruleSync";
import { AUTOMATION_HOME_HANDOVER_MINUTES } from "../../../../shared/automationHome";
import type { AutomationCloudHomeState } from "../../../../shared/types";

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
/** "ADE Cloud" as the home (C9): ADE's server watches the trigger. */
const ADE_CLOUD = "__ade_cloud__";

/** ADE Cloud in "Runs on": offered only to an account with ADE Cloud, or for a rule already there. */
export type RuleCloudHomeChoice = {
  /** The account has ADE Cloud. */
  available: boolean;
  /** ADE Cloud is the home picked (or saved and not changed). */
  chosen: boolean;
  /** Why the rule can't run there as it is (`automationCloudHomeProblem`), or null. */
  problem: string | null;
  onChoose: () => void;
  /** The server's state for a rule already there (its next fire and last runs), or null. */
  state?: AutomationCloudHomeState | null;
};

const RUN_STATE_WORDS: Record<AutomationCloudHomeState["runs"][number]["state"], string> = {
  queued: "Waiting",
  starting: "Starting",
  running: "Running",
  finishing: "Saving its work",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
};

/** The server's side of a cloud-homed rule: paused or next fire, and its last runs. */
function CloudHomeRuns({ state }: { state: AutomationCloudHomeState }) {
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : null);
  return (
    <div className="space-y-0.5" data-testid="automation-cloud-runs">
      {!state.registered ? <p>ADE Cloud doesn't have this rule yet. It gets it once a computer with ADE open syncs.</p> : null}
      {state.pausedReason === "storm" ? <p className="text-amber-300/80">Paused after too many runs in an hour. Save it again to turn it back on.</p> : null}
      {state.registered && state.nextFireAt ? <p>Next run: {when(state.nextFireAt)}</p> : null}
      {state.runs.slice(0, 5).map((run) => (
        <p key={run.runId} className="truncate" title={run.reason ?? undefined}>
          {RUN_STATE_WORDS[run.state]} · {run.trigger} · {when(run.startedAt ?? run.createdAt)}
          {run.computer === "freed" ? " · computer freed, lane kept" : run.computer === "kept" ? " · computer kept" : ""}
          {run.reason ? ` · ${run.reason}` : ""}
        </p>
      ))}
    </div>
  );
}

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
  cloudHome = null,
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
  /** ADE Cloud as a choice, or null where it isn't one (no ADE Cloud, a rule kept on one computer). */
  cloudHome?: RuleCloudHomeChoice | null;
  disabled?: boolean;
}) {
  const onCloud = Boolean(cloudHome?.chosen);
  const selected = !onCloud && valueMachineId ? machines.find((machine) => machine.machineId === valueMachineId) ?? null : null;
  const Icon = selected?.isThisMachine ? Desktop : DesktopTower;
  const moving = rehoming || Boolean(savedMachineId && valueMachineId && savedMachineId !== valueMachineId);
  const savedName = unreachableHomeName
    ?? homeName
    ?? (savedMachineId ? machines.find((machine) => machine.machineId === savedMachineId)?.machineName ?? null : null);
  const selectValue = onCloud ? ADE_CLOUD : unreachableHomeName ? UNREACHABLE_HOME : valueMachineId ?? "";
  const SyncIcon = sync?.icon ?? null;
  return (
    <div className="mb-3 space-y-1.5" data-testid="automation-machine-field">
      <label className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-[11px] text-muted-fg/70">Runs on</span>
        <span className="relative flex min-w-0 flex-1 items-center">
          <Icon size={12} weight="duotone" className="pointer-events-none absolute left-2 text-muted-fg/60" aria-hidden />
          <select
            className={cn(inputCls, "h-7 min-w-0 flex-1 pl-7", !valueMachineId && !unreachableHomeName && !onCloud && "text-muted-fg/60")}
            value={selectValue}
            disabled={disabled}
            aria-label="Machine this automation runs on"
            aria-invalid={!valueMachineId && !unreachableHomeName && !onCloud}
            onChange={(event) => {
              if (event.target.value === ADE_CLOUD) cloudHome?.onChoose();
              else if (event.target.value && event.target.value !== UNREACHABLE_HOME) onChange(event.target.value);
            }}
          >
            {!valueMachineId && !unreachableHomeName && !onCloud ? <option value="" disabled>Choose a machine</option> : null}
            {unreachableHomeName && !onCloud ? (
              <option value={UNREACHABLE_HOME} disabled>{unreachableHomeName} (not connected to this window)</option>
            ) : null}
            {cloudHome && (cloudHome.available || onCloud) ? (
              <option value={ADE_CLOUD} disabled={!cloudHome.available && !onCloud}>ADE Cloud (runs with no computer on)</option>
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
      {onCloud ? (
        <div className="space-y-1 text-[10.5px] text-muted-fg/60" data-testid="automation-machine-cloud">
          <p>
            ADE Cloud watches its schedule or webhook and starts each run on a new computer of its own, as an unattended
            agent under your agent limits. After the run its work is pushed and the computer is freed; its lane stays.
          </p>
          {cloudHome?.problem ? <p className="text-amber-300/80" data-testid="automation-cloud-home-problem">{cloudHome.problem}</p> : null}
          {cloudHome?.state ? <CloudHomeRuns state={cloudHome.state} /> : null}
          {!cloudHome?.available ? <p className="text-amber-300/80">ADE Cloud isn't available on this account. Pick a computer to run it.</p> : null}
        </div>
      ) : !valueMachineId && !unreachableHomeName ? (
        <div className="text-[10.5px] text-amber-300/80" data-testid="automation-machine-required">
          Choose the machine this automation runs on before saving.
        </div>
      ) : moving && followsAccount ? (
        <div className="text-[10.5px] text-muted-fg/60" data-testid="automation-machine-moving">
          Saving hands it to {selected?.machineName ?? "the new machine"}, which starts it {AUTOMATION_HOME_HANDOVER_MINUTES} minutes
          after you save, once {savedName ?? "its machine"} has surely stopped. Run history stays on {savedName ?? "the old machine"}.
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

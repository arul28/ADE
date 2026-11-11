import { Desktop, DesktopTower, Plus, Scales } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { formatBytes } from "../../lib/format";
import { LABEL_CLASS_NAME, SECTION_CLASS_NAME, CARD_CLASS_NAME, CARD_ACTIVE_CLASS_NAME } from "./laneDialogTokens";
import {
  autoLaneMachine,
  canAutoPlaceOnMachine,
  canCreateLaneOnMachine,
  isLowLaneMachineDisk,
  laneMachineFreeBytes,
  THIS_MACHINE_ID,
  type LaneMachineOption,
} from "./laneMachines";
import { autoPickSummary, machineLoadSummary, placementTag } from "./machineLoadText";
import { ADE_CLOUD_NAME, CloudMark } from "../remoteTargets/cloudBrand";
import type { AdeCloudLaneChoice } from "./useAdeCloudLaneTarget";

/**
 * "Create on" — the machine a new lane (and therefore every chat inside it)
 * will live on.
 *
 * Deliberately does NOT reuse the dialog's "Remote"/"Local" vocabulary: that
 * pair already means the git base-branch source a few rows below. Machines are
 * named absolutely instead ("This computer", "MacBook Pro (97)").
 */
export function LaneMachineSelector({
  machines,
  selectedMachineId,
  onSelectMachine,
  onConnectMachine,
  disabled,
  selectableMachineIds,
  adeCloud = null,
}: {
  machines: LaneMachineOption[];
  selectedMachineId: string;
  onSelectMachine: (machineId: string) => void;
  onConnectMachine?: () => void;
  disabled?: boolean;
  /**
   * The machines a pick can be sent to, when the caller knows. A machine left
   * out reads as unavailable and says why, instead of a card that takes the
   * click and does nothing.
   */
  selectableMachineIds?: readonly string[];
  /** ADE Cloud as one more card, after the machines; null when the account has no access. */
  adeCloud?: AdeCloudLaneChoice | null;
}) {
  /*
   * The machine is always an explicit choice; `selectedMachineId` is "" until
   * one is made and no card reads as selected. The Auto card offers the
   * least-loaded machine in one click; picking a named machine below forces
   * one. With fewer than two machines able to host this repo there is nothing
   * to balance, so the card is absent.
   */
  // Only machines automatic placement may choose: a Manual only one is not balanced across.
  // Auto picks only among machines a pick can be sent to.
  const autoCandidates = selectableMachineIds
    ? machines.filter((machine) => selectableMachineIds.includes(machine.id))
    : machines;
  const eligibleCount = autoCandidates.filter(canAutoPlaceOnMachine).length;
  const autoMachine = autoLaneMachine(autoCandidates);
  return (
    <section className={SECTION_CLASS_NAME} data-tour="lanes.createDialog.machine">
      <span className={LABEL_CLASS_NAME}>Create on</span>
      {!selectedMachineId && !adeCloud?.selected ? (
        <span className="ml-2 text-[10px] text-amber-300/80" data-testid="lane-machine-selector-required">
          Choose a machine
        </span>
      ) : null}
      {autoMachine ? (
        <button
          type="button"
          aria-pressed={selectedMachineId === autoMachine.id}
          disabled={disabled}
          title={`Balance across ${eligibleCount} connected machines`}
          onClick={() => onSelectMachine(autoMachine.id)}
          className={cn(
            CARD_CLASS_NAME,
            "mt-2 flex w-full items-center gap-2 !px-2.5 !py-2 text-left",
            selectedMachineId === autoMachine.id && CARD_ACTIVE_CLASS_NAME,
          )}
        >
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-fg/[0.06] text-muted-fg"
            aria-hidden="true"
          >
            <Scales size={14} weight="duotone" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-semibold text-fg">Auto — least loaded</span>
            <span className="block truncate text-[10px] leading-snug text-muted-fg/60">
              {autoPickSummary(autoMachine)}
            </span>
          </span>
        </button>
      ) : null}
      <div
        className="mt-2 grid grid-cols-2 gap-2"
        role="radiogroup"
        aria-label="Machine for this lane"
      >
        {machines.map((machine) => (
          <LaneMachineCard
            key={machine.id}
            machine={machine}
            selected={machine.id === selectedMachineId}
            disabled={disabled}
            unconfirmed={selectableMachineIds !== undefined
              && canCreateLaneOnMachine(machine)
              && !selectableMachineIds.includes(machine.id)}
            onSelect={() => onSelectMachine(machine.id)}
          />
        ))}
        {adeCloud ? <AdeCloudCard choice={adeCloud} disabled={disabled} /> : null}
      </div>
      {onConnectMachine ? (
        <button
          type="button"
          className="mt-2 inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-fg/70 transition-colors hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
          disabled={disabled}
          onClick={onConnectMachine}
        >
          <Plus size={11} weight="bold" />
          Connect another machine…
        </button>
      ) : null}
    </section>
  );
}

function LaneMachineCard({
  machine,
  selected,
  disabled,
  unconfirmed = false,
  onSelect,
}: {
  machine: LaneMachineOption;
  selected: boolean;
  disabled?: boolean;
  /** A same-named folder whose repository ADE could not confirm by git origin. */
  unconfirmed?: boolean;
  onSelect: () => void;
}) {
  const repoPresent = canCreateLaneOnMachine(machine);
  const available = repoPresent && !unconfirmed;
  const Icon = machine.id === THIS_MACHINE_ID ? Desktop : DesktopTower;
  const freeBytes = laneMachineFreeBytes(machine);
  const lowDisk = isLowLaneMachineDisk(freeBytes);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled || !available}
      title={available
        ? undefined
        : unconfirmed
          ? `ADE can't confirm ${machine.name}'s ${machine.project?.displayName ?? "folder"} is this repo: its git remote doesn't match or isn't known.`
          : `${machine.name} doesn't have this repo yet.`}
      onClick={onSelect}
      className={cn(CARD_CLASS_NAME, "!p-2.5", selected && CARD_ACTIVE_CLASS_NAME)}
    >
      <div className="flex items-start gap-2">
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-fg/[0.06] text-muted-fg"
          aria-hidden="true"
        >
          <Icon size={14} weight="duotone" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-fg">{machine.name}</div>
          {freeBytes !== null ? (
            <div
              className={cn(
                "mt-0.5 text-[10px]",
                lowDisk ? "text-amber-300" : "text-muted-fg/70",
              )}
            >
              {formatBytes(freeBytes)} free
            </div>
          ) : null}
        </div>
      </div>
      <div className="mt-1 truncate text-[10px] leading-snug text-muted-fg/60">
        {unconfirmed ? "Can't confirm it's this repo" : machineDetailLine(machine, available)}
      </div>
    </button>
  );
}

/** ADE Cloud's card: the lane gets a new computer of its own, in the cloud's own color. */
function AdeCloudCard({ choice, disabled }: { choice: AdeCloudLaneChoice; disabled?: boolean }) {
  const available = !choice.unavailableReason;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={choice.selected}
      disabled={disabled || !available}
      title={available ? "Each lane gets a new ADE Cloud computer of its own. It sleeps when idle." : undefined}
      onClick={choice.onSelect}
      className={cn(CARD_CLASS_NAME, "!p-2.5", choice.selected && CARD_ACTIVE_CLASS_NAME)}
    >
      <div className="flex items-start gap-2">
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[color:var(--adec-tile-bg)] text-[color:var(--adec-mark)]"
          aria-hidden="true"
        >
          <CloudMark size={14} bold />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-fg">{ADE_CLOUD_NAME}</div>
          <div className="mt-0.5 text-[10px] text-muted-fg/70">A new computer for each lane</div>
        </div>
      </div>
      {/* The reason it is off is read here, not only in a tooltip. */}
      <div className={cn("mt-1 text-[10px] leading-snug", available ? "truncate text-muted-fg/60" : "whitespace-normal text-amber-300/80")}>
        {available ? choice.detail : choice.unavailableReason}
      </div>
    </button>
  );
}

function machineDetailLine(machine: LaneMachineOption, available: boolean): string {
  if (!available) return "This repo isn't here yet";
  const load = [placementTag(machine), machineLoadSummary(machine.stats)].filter(Boolean).join(" · ");
  if (load) return load;
  if (machine.project) return machine.project.rootPath;
  if (machine.hostname) return machine.hostname;
  return "Connected";
}

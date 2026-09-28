import React, { useEffect, useMemo, useState } from "react";
import { CheckCircle, Circle, Desktop, HardDrives, Strategy } from "@phosphor-icons/react";
import type { ProjectMachine } from "../../lib/projectMachines";
import { cn } from "../ui/cn";

const CTO_ACCENT_RGB = "34, 211, 238";

/** Why a machine cannot be picked, or null when it can. */
function unavailableReason(machine: ProjectMachine): string | null {
  if (!machine.online) return `${machine.name} is offline`;
  if (!machine.hasRepo) return "No checkout of this repository";
  if (!machine.routable) return "Not reachable from this computer yet";
  // This computer is recorded by its account device id; without it, no other
  // machine could ever find the CTO here.
  if (machine.isThisMachine && !machine.deviceId) return "Still reading this computer's identity";
  return null;
}

function machineDetail(machine: ProjectMachine): string {
  if (machine.isThisMachine) return "The computer you're using";
  if (machine.isBound) return "This project tab is open on it";
  return "Has this repository";
}

/**
 * The one question the CTO's home asks: which machine does it live on.
 *
 * First run lists every machine with a checkout of this repo, with This
 * computer suggested when it has one. Changing it later says plainly what does
 * not move: memory, team and past threads stay on the old machine.
 */
export function CtoHomeChooser({
  machines,
  suggested,
  current,
  currentName,
  onChoose,
  onCancel,
}: {
  machines: readonly ProjectMachine[];
  suggested: ProjectMachine | null;
  /** The present home, when changing it. Null on first run. */
  current: ProjectMachine | null;
  /** The present home's name, even when this computer cannot see it. */
  currentName: string | null;
  onChoose: (machine: ProjectMachine) => Promise<void>;
  onCancel?: () => void;
}) {
  const changing = currentName != null;
  const options = useMemo(
    () => machines.filter((machine) => machine.hasRepo || machine.isThisMachine),
    [machines],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Preselect the suggestion once it is known, and follow it until the user
  // picks something themselves. When changing, nothing is preselected: the
  // current home is not a new choice.
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (touched || changing) return;
    const pick = suggested && !unavailableReason(suggested) ? suggested.id : null;
    setSelectedId(pick);
  }, [changing, suggested, touched]);

  const selected = options.find((machine) => machine.id === selectedId) ?? null;
  const sameAsCurrent = Boolean(current && selected && current.id === selected.id);
  const canConfirm = Boolean(selected && !unavailableReason(selected) && !sameAsCurrent && !saving);

  const confirm = async () => {
    if (!selected || !canConfirm) return;
    setSaving(true);
    setError(null);
    try {
      await onChoose(selected);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save where the CTO runs.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center p-6" data-testid="cto-home-chooser">
      <div className="flex w-full max-w-[440px] flex-col">
        <div className="flex items-center gap-2.5">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-xl"
            style={{
              background: `rgba(${CTO_ACCENT_RGB}, 0.12)`,
              border: `1px solid rgba(${CTO_ACCENT_RGB}, 0.28)`,
            }}
          >
            <Strategy size={17} weight="duotone" style={{ color: `rgb(${CTO_ACCENT_RGB})` }} />
          </div>
          <span className="text-[13px] font-semibold text-fg">
            {changing ? "Move the CTO" : "Where should the CTO run?"}
          </span>
        </div>

        <p className="mt-4 text-[13px] leading-6 text-fg/80">
          {changing
            ? "The CTO runs on one machine. Every computer you sign in on talks to it there."
            : "This project has one CTO, and it runs on one machine. Every computer you sign in on talks to it there, so pick the one that's usually on."}
        </p>

        {changing ? (
          <div
            className="mt-3 rounded-lg border border-amber-500/18 bg-amber-500/[0.06] px-3 py-2 text-[11.5px] leading-[1.5] text-amber-100/85"
            data-testid="cto-home-change-note"
          >
            Its memory, team and past threads stay on {currentName}. They don't move. The CTO on the
            new machine starts with that machine's own.
          </div>
        ) : null}

        <div className="mt-4 flex flex-col gap-1.5" role="radiogroup" aria-label="Machine for the CTO">
          {options.map((machine) => {
            const reason = unavailableReason(machine);
            const isSelected = machine.id === selectedId;
            const isCurrent = current?.id === machine.id;
            const Icon = machine.isThisMachine ? Desktop : HardDrives;
            return (
              <button
                key={machine.id}
                type="button"
                role="radio"
                aria-checked={isSelected}
                disabled={reason != null}
                data-testid={`cto-home-option-${machine.id}`}
                onClick={() => {
                  setTouched(true);
                  setSelectedId(machine.id);
                }}
                className={cn(
                  "flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
                  isSelected
                    ? "border-cyan-400/40 bg-cyan-400/[0.07]"
                    : "border-white/[0.08] hover:bg-white/[0.03]",
                  reason != null && "cursor-default opacity-45 hover:bg-transparent",
                )}
              >
                <Icon size={15} className="shrink-0 text-muted-fg/70" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium text-fg">
                    {machine.name}
                    {isCurrent ? <span className="ml-1.5 text-[11px] font-normal text-muted-fg/55">· runs here now</span> : null}
                  </span>
                  <span className="block truncate text-[11px] text-muted-fg/55">
                    {reason ?? machineDetail(machine)}
                  </span>
                </span>
                {isSelected
                  ? <CheckCircle size={16} weight="fill" className="shrink-0 text-cyan-300" />
                  : <Circle size={16} className="shrink-0 text-muted-fg/30" />}
              </button>
            );
          })}
        </div>

        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            data-testid="cto-home-confirm"
            disabled={!canConfirm}
            onClick={() => void confirm()}
            className="rounded-lg border border-white/[0.12] bg-white/[0.06] px-3 py-1.5 text-[12px] font-medium text-fg transition-colors hover:bg-white/[0.1] disabled:cursor-default disabled:opacity-50"
          >
            {saving ? "Saving…" : selected ? `Run the CTO on ${selected.name}` : "Pick a machine"}
          </button>
          {onCancel ? (
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg px-2.5 py-1.5 text-[12px] text-muted-fg/60 transition-colors hover:text-fg/85"
            >
              Cancel
            </button>
          ) : null}
        </div>

        {error ? <div className="mt-3 text-[11.5px] text-red-300/90">{error}</div> : null}
      </div>
    </div>
  );
}

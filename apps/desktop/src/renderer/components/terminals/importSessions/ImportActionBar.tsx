import { CircleNotch, LockSimple } from "@phosphor-icons/react";
import type { ImportPlan, ImportPlanAction, ImportSurface } from "../../../../shared/externalSessionPolicy";
import { cn } from "../../ui/cn";
import { SmartTooltip } from "../../ui/SmartTooltip";
import { ModelPicker } from "../../shared/ModelPicker/ModelPicker";
import { LaneCombobox, type LaneComboboxLane } from "../LaneCombobox";
import { LaneDot } from "./ImportSessionParts";

const SURFACE_LABELS: Record<ImportSurface, string> = {
  chat: "ADE chat",
  cli: "CLI",
};

export type ImportActionBarProps = {
  plan: ImportPlan;
  onSurfaceChange: (surface: ImportSurface) => void;
  lanes: LaneComboboxLane[];
  /** The session's home lane, shown on the locked pill when the lane list lacks it. */
  homeLane: { name: string; color: string | null } | null;
  onTargetLaneChange: (laneId: string) => void;
  /** Shown only for a chat copy. */
  model: string | null;
  onModelChange: (model: string) => void;
  /** The action currently running for this session, if any. */
  running: ImportPlanAction["mode"] | null;
  /** True while any import runs. */
  disabled: boolean;
  /** First click on a live continue arms this; the next click runs it. */
  confirming: boolean;
  /** First click on a chat "Copy" arms this: the model picker shows and the next click copies. */
  copyArmed: boolean;
  onCancelCopy: () => void;
  noteTone: "muted" | "warning";
  error: string | null;
  onRun: (action: ImportPlanAction) => void;
  /** Replaces the plan when the session is already in ADE. */
  openExisting: { onOpen: () => void } | null;
};

function PrimaryButton({
  label,
  busy,
  disabled,
  tone = "accent",
  onClick,
}: {
  label: string;
  busy: boolean;
  disabled: boolean;
  tone?: "accent" | "warning";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-2 rounded-lg px-3.5 text-[12px] font-semibold text-[#0F0D14] transition-[filter,background-color] duration-100 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:brightness-100",
        tone === "warning" ? "bg-amber-300" : "bg-violet-400",
      )}
    >
      {busy ? <CircleNotch size={13} className="animate-spin" /> : null}
      {label}
      <kbd className="rounded bg-black/[0.14] px-1 font-sans text-[10px] font-medium leading-4 text-black/60">⏎</kbd>
    </button>
  );
}

function SurfaceSwitch({
  surfaces,
  value,
  disabled,
  onChange,
}: {
  surfaces: ImportSurface[];
  value: ImportSurface;
  disabled: boolean;
  onChange: (surface: ImportSurface) => void;
}) {
  if (surfaces.length < 2) {
    return <span className="inline-flex h-7 items-center text-[11.5px] font-medium text-fg/80">{SURFACE_LABELS[value]}</span>;
  }
  return (
    <div
      role="radiogroup"
      aria-label="Open as"
      className="inline-flex h-7 shrink-0 items-center rounded-full border border-white/[0.07] bg-white/[0.03] p-0.5"
    >
      {surfaces.map((surface) => {
        const selected = surface === value;
        return (
          <button
            key={surface}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(surface)}
            className={cn(
              "inline-flex h-6 items-center rounded-full px-2.5 text-[11px] font-medium transition-colors duration-100 disabled:cursor-not-allowed",
              selected ? "bg-white/[0.1] text-fg shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]" : "text-muted-fg/70 hover:text-fg",
            )}
          >
            {SURFACE_LABELS[surface]}
          </button>
        );
      })}
    </div>
  );
}

function LockedLanePill({ name, color, reason }: { name: string; color: string | null; reason: string }) {
  return (
    <SmartTooltip content={{ label: name, description: reason }} forceEnabled>
      <span
        tabIndex={0}
        data-testid="import-locked-lane"
        aria-label={`${name}. ${reason}`}
        className="inline-flex h-7 min-w-0 max-w-[260px] cursor-default items-center gap-1.5 rounded-full border border-white/[0.05] px-2.5 text-[11px] text-fg/75 outline-none focus-visible:border-white/[0.16]"
      >
        <LaneDot color={color} />
        <span className="min-w-0 truncate">{name}</span>
        <LockSimple size={10} weight="bold" className="shrink-0 text-muted-fg/55" aria-hidden="true" />
      </span>
    </SmartTooltip>
  );
}

/**
 * Pinned to the bottom of the preview. Renders the plan from `planImport` and
 * nothing else: which surfaces, which lane, which buttons, which note.
 */
export function ImportActionBar({
  plan,
  onSurfaceChange,
  lanes,
  homeLane,
  onTargetLaneChange,
  model,
  onModelChange,
  running,
  disabled,
  confirming,
  copyArmed,
  onCancelCopy,
  noteTone,
  error,
  onRun,
  openExisting,
}: ImportActionBarProps) {
  const busy = disabled || running != null;

  if (openExisting) {
    return (
      <footer className="shrink-0 border-t border-white/[0.06] px-5 py-3">
        <div className="flex items-center gap-3">
          <span className="text-[11.5px] text-muted-fg/65">Already in ADE.</span>
          <div className="ml-auto">
            <PrimaryButton label="Open in ADE" busy={false} disabled={busy} onClick={openExisting.onOpen} />
          </div>
        </div>
      </footer>
    );
  }

  const targetLane = lanes.find((lane) => lane.id === plan.targetLaneId) ?? null;
  const primary = plan.primary;
  const secondary = plan.secondary;
  // The model only matters to a copy, so the picker shows when the copy is
  // the main action, or once the user has asked for the secondary copy.
  const showModel = Boolean(
    (primary?.needsModel && primary.target === "chat")
      || (copyArmed && secondary?.needsModel && secondary.target === "chat"),
  );

  return (
    <footer className="shrink-0 border-t border-white/[0.06] px-5 py-3">
      {plan.surface ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
          <SurfaceSwitch surfaces={plan.surfaces} value={plan.surface} disabled={busy} onChange={onSurfaceChange} />
          <span className="text-[11px] text-muted-fg/50">in</span>
          {plan.laneLocked ? (
            <LockedLanePill
              name={targetLane?.name ?? homeLane?.name ?? "Its lane"}
              color={targetLane?.color ?? homeLane?.color ?? null}
              reason={plan.lockReason ?? ""}
            />
          ) : (
            <LaneCombobox
              lanes={lanes}
              value={plan.targetLaneId ?? ""}
              onChange={onTargetLaneChange}
              variant="pill"
              compact
              aria-label="Import into lane"
            />
          )}
          {showModel && model ? (
            <div className="min-w-0 max-w-[220px]" data-testid="import-model">
              <ModelPicker value={model} onChange={(next) => onModelChange(next)} compact disabled={busy} />
            </div>
          ) : null}
          <div className="ml-auto flex items-center gap-1">
            {copyArmed && secondary ? (
              <>
                <button
                  type="button"
                  onClick={onCancelCopy}
                  disabled={busy}
                  className="inline-flex h-8 items-center rounded-lg px-3 text-[12px] font-medium text-muted-fg/80 transition-colors hover:bg-white/[0.05] hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Cancel
                </button>
                <PrimaryButton
                  label="Make copy"
                  busy={running === secondary.mode}
                  disabled={busy}
                  onClick={() => onRun(secondary)}
                />
              </>
            ) : (
              <>
                {secondary ? (
                  <button
                    type="button"
                    onClick={() => onRun(secondary)}
                    disabled={busy}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12px] font-medium text-muted-fg/80 transition-colors hover:bg-white/[0.05] hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {running === secondary.mode ? <CircleNotch size={12} className="animate-spin" /> : null}
                    {secondary.label}
                  </button>
                ) : null}
                {primary ? (
                  <PrimaryButton
                    label={confirming ? "Continue anyway" : primary.label}
                    tone={confirming ? "warning" : "accent"}
                    busy={running === primary.mode}
                    disabled={busy}
                    onClick={() => onRun(primary)}
                  />
                ) : null}
              </>
            )}
          </div>
        </div>
      ) : null}
      {!primary ? (
        <p className={cn("text-[11px] text-muted-fg/55", plan.surface ? "mt-2" : null)}>
          Nothing to do for this session here.
        </p>
      ) : null}
      {plan.note ? (
        <p className={cn("mt-2 text-[11px]", noteTone === "warning" ? "text-amber-200/80" : "text-muted-fg/55")}>
          {plan.note}
        </p>
      ) : null}
      {error ? <p role="alert" className="mt-1.5 text-[11px] text-red-300/90">{error}</p> : null}
    </footer>
  );
}

import { CircleNotch, LockSimple } from "@phosphor-icons/react";
import type { ImportPlan, ImportPlanAction, ImportSurface } from "../../../../shared/externalSessionPolicy";
import { Banner } from "../../ui/notice";
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
      className="kit-btn kit-btn-primary"
      data-tone={tone === "warning" ? "warn" : undefined}
    >
      {busy ? <CircleNotch size={13} className="animate-spin" /> : null}
      {label}
      <kbd className="import-kbd" aria-hidden="true">⏎</kbd>
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
    return <span className="text-[12px] font-medium text-(--kit-text-2)">{SURFACE_LABELS[value]}</span>;
  }
  return (
    <div role="radiogroup" aria-label="Open as" className="kit-seg shrink-0" data-case="sentence">
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
        className="inline-flex h-[30px] min-w-0 max-w-[260px] cursor-default items-center gap-1.5 rounded-md border border-(--kit-rule) px-2.5 text-[11.5px] text-(--kit-text-2) outline-none focus-visible:border-fg/[0.2]"
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
      <footer className="import-actions">
        <div className="import-actions-row">
          <span className="import-actions-label">Already in ADE.</span>
          <div className="import-actions-end">
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
    primary?.needsModel || (copyArmed && secondary?.needsModel),
  );

  return (
    <footer className="import-actions">
      {plan.surface ? (
        <div className="import-actions-row">
          <SurfaceSwitch surfaces={plan.surfaces} value={plan.surface} disabled={busy} onChange={onSurfaceChange} />
          <span className="import-actions-label">in</span>
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
              aria-label="Import into lane"
            />
          )}
          {showModel && model ? (
            <div className="min-w-0 max-w-[220px]" data-testid="import-model">
              <ModelPicker value={model} onChange={(next) => onModelChange(next)} disabled={busy} />
            </div>
          ) : null}
          <div className="import-actions-end">
            {copyArmed && secondary ? (
              <>
                <button type="button" onClick={onCancelCopy} disabled={busy} className="kit-btn kit-btn-ghost">
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
                    className="kit-btn kit-btn-ghost"
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
        <p className="import-actions-note" style={plan.surface ? undefined : { marginTop: 0 }}>
          Nothing to do for this session here.
        </p>
      ) : null}
      {plan.note ? (
        noteTone === "warning" ? (
          <Banner
            layout="inline"
            style={{ marginTop: 8 }}
            model={{ id: "import-session-action-warning", tone: "warning", title: plan.note }}
          />
        ) : (
          <p className="import-actions-note">{plan.note}</p>
        )
      ) : null}
      {error ? (
        <Banner
          layout="inline"
          style={{ marginTop: 6 }}
          model={{ id: "import-session-action-error", tone: "error", title: error }}
        />
      ) : null}
    </footer>
  );
}

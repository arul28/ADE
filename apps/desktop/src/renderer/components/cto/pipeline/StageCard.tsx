import React from "react";
import { Robot, Lightning as LightningIcon, GitBranch, ShieldCheck, Kanban } from "@phosphor-icons/react";
import type { LinearWorkflowTarget } from "../../../../shared/types/linearSync";
import {
  TARGET_TYPE_LABELS,
  RUN_MODE_LABELS,
  LANE_SELECTION_LABELS,
  SESSION_REUSE_LABELS,
  STAGE_COLORS,
  enumLabel,
  enumDescription,
} from "./pipelineLabels";
import { cn } from "../../ui/cn";

const TYPE_ICONS: Record<string, React.ElementType> = {
  employee_session: Robot,
  worker_run: LightningIcon,
  mission: Kanban,
  pr_resolution: GitBranch,
  review_gate: ShieldCheck,
};

type Props = {
  stage: Omit<LinearWorkflowTarget, "downstreamTarget">;
  index: number;
  selected: boolean;
  onSelect: () => void;
  onRemove?: () => void;
};

export function StageCard({ stage, index, selected, onSelect, onRemove }: Props) {
  const color = STAGE_COLORS[stage.type] ?? "#38BDF8";
  const Icon = TYPE_ICONS[stage.type] ?? Robot;
  const typeName = enumLabel(TARGET_TYPE_LABELS, stage.type);
  const typeDesc = enumDescription(TARGET_TYPE_LABELS, stage.type);
  const modeName = enumLabel(RUN_MODE_LABELS, stage.runMode);

  // Lane behavior
  const laneBehavior = stage.laneSelection
    ? enumLabel(LANE_SELECTION_LABELS, stage.laneSelection)
    : null;

  // PR behavior
  let prBehavior: string | null = null;
  if (stage.prStrategy) {
    const draft = "draft" in stage.prStrategy ? stage.prStrategy.draft : false;
    const kind = "kind" in stage.prStrategy ? stage.prStrategy.kind : null;
    if (draft) {
      prBehavior = "Draft PR";
    } else if (kind === "per-lane") {
      prBehavior = "Per-lane PR";
    } else if (kind) {
      prBehavior = "PR";
    }
  }

  // Session behavior (for employee_session)
  const sessionBehavior =
    stage.type === "employee_session" && stage.sessionReuse
      ? enumLabel(SESSION_REUSE_LABELS, stage.sessionReuse)
      : null;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "group relative flex flex-col items-start rounded-xl px-4 py-3 text-left transition-all duration-200",
        "min-w-[200px] max-w-[230px]",
        !selected && "hover:bg-white/[0.03]",
      )}
      style={{
        background: selected ? `${color}0D` : "rgba(19,24,34,0.7)",
        border: `1px solid ${selected ? `${color}40` : "rgba(255,255,255,0.06)"}`,
        backdropFilter: "blur(12px)",
        boxShadow: selected
          ? `0 0 20px ${color}18, 0 0 40px ${color}08`
          : "none",
      }}
    >
      {/* Colored top bar -- thicker */}
      <div
        className="absolute left-0 top-0 h-[4px] w-full rounded-t-xl"
        style={{ background: `linear-gradient(90deg, ${color}, ${color}80)` }}
      />

      {/* Remove button */}
      {onRemove && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-[#1a1f2e] text-muted-fg/40 opacity-0 transition-opacity group-hover:opacity-100 hover:text-error"
          style={{ border: "1px solid rgba(255,255,255,0.1)" }}
          title="Remove stage"
        >
          <span className="text-[10px] leading-none">&times;</span>
        </button>
      )}

      {/* Icon + type name */}
      <div className="mt-1 flex items-center gap-2">
        <Icon size={14} style={{ color }} weight="duotone" />
        <span className="text-[13px] font-medium text-fg">{typeName}</span>
      </div>

      {/* Type description */}
      {typeDesc && (
        <div className="mt-1 text-[10px] leading-tight text-muted-fg/40">{typeDesc}</div>
      )}

      {/* Run mode badge */}
      <div
        className="mt-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium"
        style={{ color, background: `${color}14`, border: `1px solid ${color}20` }}
      >
        {modeName}
      </div>

      {/* Detail lines */}
      <div className="mt-1.5 flex flex-col gap-0.5">
        {laneBehavior && (
          <div className="flex items-center gap-1.5 text-[10px] text-muted-fg/50">
            <GitBranch size={10} style={{ color, opacity: 0.6 }} />
            <span>{laneBehavior}</span>
          </div>
        )}
        {prBehavior && (
          <div className="flex items-center gap-1.5 text-[10px] text-muted-fg/50">
            <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: color, opacity: 0.5 }} />
            <span>{prBehavior}</span>
          </div>
        )}
        {sessionBehavior && (
          <div className="flex items-center gap-1.5 text-[10px] text-muted-fg/50">
            <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: color, opacity: 0.5 }} />
            <span>{sessionBehavior}</span>
          </div>
        )}
      </div>

      {/* Stage number */}
      <div className="absolute bottom-1.5 right-2 text-[9px] text-muted-fg/20 font-medium">
        {index + 1}
      </div>
    </button>
  );
}

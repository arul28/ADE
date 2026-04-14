import React from "react";
import type { LinearWorkflowVisualPlan } from "../../../../../shared/linearWorkflowPresets";
import type { LinearWorkflowHumanReview } from "../../../../../shared/types/linearSync";
import { selectCls, labelCls, textareaCls } from "../../shared/designTokens";
import {
  COMPLETION_CONTRACT_LABELS,
  SUPERVISOR_MODE_LABELS,
  REJECT_ACTION_LABELS,
  NOTIFY_ON_LABELS,
  fieldLabel,
  fieldDescription,
} from "../pipelineLabels";
import { cn } from "../../../ui/cn";

type Props = {
  visualPlan: LinearWorkflowVisualPlan;
  onPatchPlan: (patch: Partial<LinearWorkflowVisualPlan>) => void;
  agents: Array<{ value: string; label: string }>;
  humanReview?: LinearWorkflowHumanReview;
  onUpdateHumanReview?: (patch: Partial<LinearWorkflowHumanReview>) => void;
};

function SelectField({
  label,
  description,
  value,
  options,
  onChange,
}: {
  label: string;
  description: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className={labelCls}>{label}</label>
      <p className="mb-2 text-[10px] text-muted-fg/35">{description}</p>
      <select className={selectCls} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

function toSelectOptions(labels: Record<string, { displayName: string }>): Array<{ value: string; label: string }> {
  return Object.entries(labels).map(([value, info]) => ({
    value,
    label: info.displayName,
  }));
}

export function PlanConfig({ visualPlan, onPatchPlan, agents, humanReview, onUpdateHumanReview }: Props) {
  const showRejectAction = visualPlan.supervisorMode !== "none";

  return (
    <div className="space-y-4">
      <div className="text-xs font-medium text-fg/70">Execution Plan</div>

      {/* Done When */}
      <SelectField
        label={fieldLabel("completionContract")}
        description={fieldDescription("completionContract")}
        value={visualPlan.completionContract}
        options={toSelectOptions(COMPLETION_CONTRACT_LABELS)}
        onChange={(v) => onPatchPlan({ completionContract: v as LinearWorkflowVisualPlan["completionContract"] })}
      />

      {/* Review checkpoint */}
      <SelectField
        label={fieldLabel("supervisorMode")}
        description={fieldDescription("supervisorMode")}
        value={visualPlan.supervisorMode}
        options={toSelectOptions(SUPERVISOR_MODE_LABELS)}
        onChange={(v) => onPatchPlan({ supervisorMode: v as LinearWorkflowVisualPlan["supervisorMode"] })}
      />

      {/* Reviewer */}
      <SelectField
        label={fieldLabel("supervisorIdentityKey")}
        description={fieldDescription("supervisorIdentityKey")}
        value={visualPlan.supervisorIdentityKey}
        options={agents.length > 0 ? agents : [{ value: "cto", label: "CTO Agent" }]}
        onChange={(v) => onPatchPlan({ supervisorIdentityKey: v })}
      />

      {/* If reviewer rejects */}
      {showRejectAction && (
        <SelectField
          label={fieldLabel("rejectAction")}
          description={fieldDescription("rejectAction")}
          value={visualPlan.rejectAction}
          options={toSelectOptions(REJECT_ACTION_LABELS)}
          onChange={(v) => onPatchPlan({ rejectAction: v as LinearWorkflowVisualPlan["rejectAction"] })}
        />
      )}

      {/* Review instructions -- visible when supervisor mode is active */}
      {showRejectAction && onUpdateHumanReview && (
        <div>
          <label className={labelCls}>{fieldLabel("humanReview.instructions")}</label>
          <p className="mb-2 text-[10px] text-muted-fg/35">{fieldDescription("humanReview.instructions")}</p>
          <textarea
            className={cn(textareaCls, "min-h-[60px]")}
            value={humanReview?.instructions ?? ""}
            onChange={(e) => onUpdateHumanReview({ instructions: e.target.value || null })}
            placeholder="Describe what the reviewer should check before approving..."
          />
        </div>
      )}

      {/* Multi-stage note */}
      {showRejectAction && (
        <p className="text-[10px] text-muted-fg/30 leading-relaxed">
          To add a second stage (e.g., a review agent after work completes), use the + button between stages in the pipeline above.
        </p>
      )}

      {/* Notification */}
      <div className="flex items-center gap-3 pt-1">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={visualPlan.notificationEnabled}
            onChange={(e) => onPatchPlan({ notificationEnabled: e.target.checked })}
            className="accent-[#A78BFA]"
          />
          <span className="text-xs text-fg/60">{fieldLabel("notificationEnabled")}</span>
        </label>
        {visualPlan.notificationEnabled && (
          <select
            className={cn(selectCls, "!w-auto !h-8 text-[11px]")}
            value={visualPlan.notificationMilestone}
            onChange={(e) => onPatchPlan({ notificationMilestone: e.target.value as LinearWorkflowVisualPlan["notificationMilestone"] })}
          >
            {Object.entries(NOTIFY_ON_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v.displayName}</option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}

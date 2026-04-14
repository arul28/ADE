import React, { useCallback, useMemo, useState } from "react";
import { FloppyDisk, Info } from "@phosphor-icons/react";
import type {
  LinearWorkflowDefinition,
  LinearWorkflowTargetType,
} from "../../../../shared/types/linearSync";
import { deriveVisualPlan, rebuildWorkflowSteps } from "../../../../shared/linearWorkflowPresets";
import { inputCls, labelCls, cardCls } from "../shared/designTokens";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { PipelineVisualization, type PipelineSelection } from "./PipelineVisualization";
import {
  flattenTargetChain,
  insertStageAt,
  removeStageAt,
  updateStageAt,
  createDefaultStage,
  type PipelineStage,
} from "./pipelineHelpers";
import { TARGET_TYPE_LABELS, STAGE_COLORS, generateWorkflowSummary } from "./pipelineLabels";
import { StageConfigPanel } from "./StageConfigPanel";

type Props = {
  workflow: LinearWorkflowDefinition;
  onUpdateWorkflow: (updater: (w: LinearWorkflowDefinition) => LinearWorkflowDefinition) => void;
  onSave: () => void;
  saving: boolean;
  agents: Array<{ value: string; label: string }>;
};

export function PipelineCanvas({ workflow, onUpdateWorkflow, onSave, saving, agents }: Props) {
  const [selection, setSelection] = useState<PipelineSelection>(null);
  const [showAddPopover, setShowAddPopover] = useState<number | null>(null);

  const stages = useMemo(() => flattenTargetChain(workflow.target), [workflow.target]);
  const visualPlan = useMemo(() => deriveVisualPlan(workflow), [workflow]);

  const handleAddStage = useCallback(
    (afterIndex: number) => {
      setShowAddPopover(afterIndex);
    },
    [],
  );

  const confirmAddStage = useCallback(
    (type: LinearWorkflowTargetType, afterIndex: number) => {
      onUpdateWorkflow((w) => ({
        ...w,
        target: insertStageAt(w.target, afterIndex, createDefaultStage(type)),
      }));
      setShowAddPopover(null);
      setSelection({ kind: "stage", index: afterIndex });
    },
    [onUpdateWorkflow],
  );

  const handleRemoveStage = useCallback(
    (index: number) => {
      onUpdateWorkflow((w) => ({
        ...w,
        target: removeStageAt(w.target, index),
      }));
      setSelection(null);
    },
    [onUpdateWorkflow],
  );

  const handleUpdateStage = useCallback(
    (index: number, partial: Partial<PipelineStage>) => {
      onUpdateWorkflow((w) => ({
        ...w,
        target: updateStageAt(w.target, index, (stage) => ({ ...stage, ...partial })),
      }));
    },
    [onUpdateWorkflow],
  );

  const handlePatchVisualPlan = useCallback(
    (patch: Partial<ReturnType<typeof deriveVisualPlan>>) => {
      onUpdateWorkflow((w) => rebuildWorkflowSteps(w, patch));
    },
    [onUpdateWorkflow],
  );

  const autoSummary = useMemo(() => generateWorkflowSummary(workflow), [workflow]);

  return (
    <div className="space-y-4">
      {/* Workflow header */}
      <div className={cn(cardCls, "space-y-2")}>
        <div className="flex items-center gap-3">
          <input
            className={cn(inputCls, "flex-1 text-base font-medium")}
            value={workflow.name}
            onChange={(e) => onUpdateWorkflow((w) => ({ ...w, name: e.target.value }))}
            placeholder="Workflow name"
          />
          {/* Source badge */}
          <span
            className="shrink-0 rounded-full px-2 py-0.5 text-[9px] font-medium uppercase tracking-wider"
            style={{
              color: workflow.source === "repo" ? "#FBBF24" : "#A78BFA",
              background: workflow.source === "repo" ? "rgba(251,191,36,0.08)" : "rgba(167,139,250,0.08)",
              border: `1px solid ${workflow.source === "repo" ? "rgba(251,191,36,0.15)" : "rgba(167,139,250,0.15)"}`,
            }}
          >
            {workflow.source === "repo" ? "From repo YAML" : "Generated"}
          </span>
          <label className="flex items-center gap-2 shrink-0">
            <input
              type="checkbox"
              checked={workflow.enabled}
              onChange={(e) => onUpdateWorkflow((w) => ({ ...w, enabled: e.target.checked }))}
              className="accent-[#A78BFA]"
            />
            <span className="text-xs text-muted-fg/50">Active</span>
          </label>
          <div className="flex items-center gap-1.5 shrink-0" title="Higher = matched first when multiple workflows apply">
            <label className={cn(labelCls, "!mb-0")}>Priority</label>
            <input
              type="number"
              className={cn(inputCls, "!w-16 text-center")}
              value={workflow.priority}
              onChange={(e) => onUpdateWorkflow((w) => ({ ...w, priority: Number(e.target.value) || 100 }))}
            />
            <Info size={12} className="text-muted-fg/30" />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <input
            className={cn(inputCls, "flex-1 !h-8 text-xs")}
            value={workflow.description ?? ""}
            onChange={(e) => onUpdateWorkflow((w) => ({ ...w, description: e.target.value }))}
            placeholder="Description (optional)"
          />
        </div>
        {/* Auto-generated summary */}
        <p className="text-[10px] leading-relaxed text-muted-fg/35 italic">{autoSummary}</p>
      </div>

      {/* Pipeline visualization */}
      <div
        className="rounded-2xl border border-white/[0.06] p-2"
        style={{ background: "rgba(10,14,21,0.7)" }}
      >
        <PipelineVisualization
          workflow={workflow}
          selection={selection}
          onSelect={setSelection}
          onAddStage={handleAddStage}
          onRemoveStage={handleRemoveStage}
        />

        {/* Add stage popover */}
        {showAddPopover !== null && (
          <div className="flex items-center justify-center gap-2 py-2 px-4 border-t border-white/[0.04]">
            <span className="text-[10px] text-muted-fg/35 mr-2">Add stage:</span>
            {(["worker_run", "employee_session", "mission", "pr_resolution", "review_gate"] as const).map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => confirmAddStage(type, showAddPopover)}
                className="rounded-lg px-2.5 py-1.5 text-[10px] font-medium transition-all duration-200 hover:bg-white/[0.04]"
                style={{
                  color: STAGE_COLORS[type],
                  border: `1px solid ${STAGE_COLORS[type]}20`,
                }}
              >
                {TARGET_TYPE_LABELS[type]?.displayName ?? type}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setShowAddPopover(null)}
              className="ml-2 text-[10px] text-muted-fg/30 hover:text-muted-fg/50"
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      {/* Stage configuration panel */}
      <StageConfigPanel
        workflow={workflow}
        selection={selection}
        stages={stages}
        visualPlan={visualPlan}
        onUpdateWorkflow={onUpdateWorkflow}
        onUpdateStage={handleUpdateStage}
        onPatchVisualPlan={handlePatchVisualPlan}
        agents={agents}
      />

      {/* Save bar */}
      <div className="flex items-center justify-end gap-3 pt-2">
        <Button variant="primary" size="sm" onClick={onSave} disabled={saving}>
          <FloppyDisk size={10} />
          Save Workflow
        </Button>
      </div>
    </div>
  );
}

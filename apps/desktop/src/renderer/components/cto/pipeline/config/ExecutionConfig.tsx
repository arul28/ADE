import React from "react";
import type { PipelineStage } from "../pipelineHelpers";
import { inputCls, labelCls, selectCls } from "../../shared/designTokens";
import { VisualSelector, type VisualSelectorOption } from "../shared/VisualSelector";
import {
  TARGET_TYPE_LABELS,
  RUN_MODE_LABELS,
  LANE_SELECTION_LABELS,
  SESSION_REUSE_LABELS,
  PR_TIMING_LABELS,
  PR_STRATEGY_KIND_LABELS,
  WORKER_SELECTOR_MODE_LABELS,
  STAGE_COLORS,
  fieldLabel,
  fieldDescription,
} from "../pipelineLabels";
import { cn } from "../../../ui/cn";

type Props = {
  stage: PipelineStage;
  agents: Array<{ value: string; label: string }>;
  onUpdate: (partial: Partial<PipelineStage>) => void;
};

function toOptions(labels: Record<string, { displayName: string; description?: string }>, color?: string): VisualSelectorOption[] {
  return Object.entries(labels).map(([value, info]) => ({
    value,
    label: info.displayName,
    description: info.description,
    color,
  }));
}

export function ExecutionConfig({ stage, agents, onUpdate }: Props) {
  const accent = STAGE_COLORS[stage.type] ?? "#A78BFA";
  const showSessionHandling = stage.type === "employee_session";
  const showWorkerSelector = stage.type === "worker_run" || stage.type === "mission" || stage.type === "pr_resolution";
  const showPrStrategy = stage.type !== "review_gate";
  const showLane = stage.type !== "mission" && stage.type !== "review_gate";

  return (
    <div className="space-y-5">
      <div className="text-xs font-medium text-fg/70">Execution</div>

      {/* Action type */}
      <div>
        <label className={labelCls}>{fieldLabel("target.type")}</label>
        <p className="mb-2 text-[10px] text-muted-fg/35">{fieldDescription("target.type")}</p>
        <VisualSelector
          options={toOptions(TARGET_TYPE_LABELS).map((o) => ({
            ...o,
            color: STAGE_COLORS[o.value] ?? "#A78BFA",
          }))}
          value={stage.type}
          onChange={(v) => onUpdate({ type: v as PipelineStage["type"] })}
        />
      </div>

      {/* Autonomy level */}
      <div>
        <label className={labelCls}>{fieldLabel("target.runMode")}</label>
        <p className="mb-2 text-[10px] text-muted-fg/35">{fieldDescription("target.runMode")}</p>
        <VisualSelector
          options={toOptions(RUN_MODE_LABELS, accent)}
          value={stage.runMode ?? "autopilot"}
          onChange={(v) => onUpdate({ runMode: v as PipelineStage["runMode"] })}
        />
      </div>

      {/* Branch strategy */}
      {showLane && (
        <div>
          <label className={labelCls}>{fieldLabel("target.laneSelection")}</label>
          <p className="mb-2 text-[10px] text-muted-fg/35">{fieldDescription("target.laneSelection")}</p>
          <VisualSelector
            options={toOptions(LANE_SELECTION_LABELS, accent)}
            value={stage.laneSelection ?? "fresh_issue_lane"}
            onChange={(v) => onUpdate({ laneSelection: v as PipelineStage["laneSelection"] })}
          />
          {/* Contextual help text based on selected branch strategy */}
          <p className="mt-1.5 text-[10px] text-muted-fg/30 leading-relaxed">
            {(stage.laneSelection ?? "fresh_issue_lane") === "fresh_issue_lane" && "ADE will create a fresh git branch named after the issue."}
            {stage.laneSelection === "primary" && "Work happens directly on the primary branch (no isolation)."}
            {stage.laneSelection === "operator_prompt" && "ADE will pause and wait for you to choose a branch."}
          </p>
        </div>
      )}

      {/* Session handling (employee_session only) */}
      {showSessionHandling && (
        <>
          <div>
            <label className={labelCls}>{fieldLabel("target.employeeIdentityKey")}</label>
            <p className="mb-2 text-[10px] text-muted-fg/35">{fieldDescription("target.employeeIdentityKey")}</p>
            <select
              className={selectCls}
              value={stage.employeeIdentityKey ?? ""}
              onChange={(e) => {
                const value = e.target.value.trim();
                onUpdate({
                  employeeIdentityKey: value.length ? (value as PipelineStage["employeeIdentityKey"]) : undefined,
                });
              }}
            >
              <option value="">Match the current Linear assignee</option>
              {agents.map((agent) => (
                <option key={agent.value} value={agent.value}>
                  {agent.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={labelCls}>{fieldLabel("target.sessionReuse")}</label>
            <p className="mb-2 text-[10px] text-muted-fg/35">{fieldDescription("target.sessionReuse")}</p>
            <VisualSelector
              options={toOptions(SESSION_REUSE_LABELS, accent)}
              value={stage.sessionReuse ?? "fresh_session"}
              onChange={(v) => onUpdate({ sessionReuse: v as PipelineStage["sessionReuse"] })}
            />
            <p className="mt-1.5 text-[10px] text-muted-fg/30 leading-relaxed">
              A fresh session means a clean chat context. Continuing reuses the agent&apos;s existing conversation.
            </p>
          </div>
        </>
      )}

      {/* Worker selector */}
      {showWorkerSelector && (
        <div>
          <label className={labelCls}>{fieldLabel("target.workerSelector")}</label>
          <p className="mb-2 text-[10px] text-muted-fg/35">{fieldDescription("target.workerSelector")}</p>
          <div className="flex items-center gap-2">
            <select
              className={cn(selectCls, "!w-auto")}
              value={stage.workerSelector?.mode ?? "none"}
              onChange={(e) => {
                const mode = e.target.value as "none" | "slug" | "id" | "capability";
                onUpdate({
                  workerSelector: mode === "none" ? { mode } : { mode, value: stage.workerSelector && "value" in stage.workerSelector ? stage.workerSelector.value : "" },
                });
              }}
            >
              {Object.entries(WORKER_SELECTOR_MODE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v.displayName}</option>
              ))}
            </select>
            {stage.workerSelector && stage.workerSelector.mode !== "none" && "value" in stage.workerSelector && (
              <input
                className={cn(inputCls, "flex-1")}
                value={stage.workerSelector.value}
                onChange={(e) => onUpdate({ workerSelector: { mode: stage.workerSelector!.mode as "slug", value: e.target.value } })}
                placeholder={fieldDescription("target.workerSelector.value")}
              />
            )}
          </div>
        </div>
      )}

      {/* PR strategy */}
      {showPrStrategy && (
        <>
          <div>
            <label className={labelCls}>{fieldLabel("target.prStrategy")}</label>
            <p className="mb-2 text-[10px] text-muted-fg/35">{fieldDescription("target.prStrategy")}</p>
            <VisualSelector
              options={[
                { value: "__none__", label: "No PR management", description: "ADE won't create a PR.", color: accent },
                ...toOptions(PR_STRATEGY_KIND_LABELS, accent),
              ]}
              value={stage.prStrategy?.kind ?? "__none__"}
              onChange={(v) => {
                if (v === "__none__") {
                  onUpdate({ prStrategy: null, prTiming: "none" });
                } else {
                  onUpdate({
                    prStrategy: { kind: v as "per-lane", draft: stage.prStrategy && "draft" in stage.prStrategy ? stage.prStrategy.draft : true },
                  });
                }
              }}
            />
          </div>

          {/* PR timing */}
          {stage.prStrategy && (
            <div>
              <label className={labelCls}>{fieldLabel("target.prTiming")}</label>
              <p className="mb-2 text-[10px] text-muted-fg/35">{fieldDescription("target.prTiming")}</p>
              <select
                className={selectCls}
                value={stage.prTiming ?? "none"}
                onChange={(e) => onUpdate({ prTiming: e.target.value as PipelineStage["prTiming"] })}
              >
                {Object.entries(PR_TIMING_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v.displayName}</option>
                ))}
              </select>
            </div>
          )}
        </>
      )}
    </div>
  );
}

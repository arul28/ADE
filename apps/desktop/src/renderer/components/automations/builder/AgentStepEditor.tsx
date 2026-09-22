import { useState } from "react";
import { CaretDown, Timer } from "@phosphor-icons/react";
import { getAppDefaultModelDescriptor, getDefaultModelDescriptor } from "../../../../shared/modelRegistry";
import type { ModelConfig, ThinkingLevel } from "../../../../shared/types";
import { ModelPicker } from "../../shared/ModelPicker/ModelPicker";
import { ReasoningEffortPicker } from "../../shared/ModelPicker/ReasoningEffortPicker";
import { labelCls, selectCls } from "../designTokens";
import { permissionControlsForModel, patchPermissionConfig } from "../permissionControls";
import { cn } from "../../ui/cn";
import { AUTOMATION_AGENT_LIMIT_MAX_MIN } from "../../../../shared/automationLimits";
import type { WorkflowStep } from "./draftBridge";
import { MinutesInput } from "./MinutesInput";
import { VariableInput, VariableTextarea } from "./VariableMenu";

/** Read on use: the app-wide default can move with model-manifest.json. */
const defaultModelId = (): string =>
  getAppDefaultModelDescriptor()?.id
  ?? getDefaultModelDescriptor("opencode")?.id
  ?? "anthropic/claude-sonnet-5";

function PermissionPicker({
  step,
  onChange,
}: {
  step: WorkflowStep;
  onChange: (next: WorkflowStep) => void;
}) {
  const modelId = step.modelConfig?.modelId ?? defaultModelId();
  const meta = permissionControlsForModel(modelId);
  if (!meta) return null;
  const current = (step.permissionConfig?.providers as Record<string, string> | undefined)?.[meta.key] ?? "";
  return (
    <label className="block space-y-1">
      <span className={labelCls}>Permissions</span>
      <select
        className={selectCls}
        value={current}
        onChange={(e) =>
          onChange({
            ...step,
            permissionConfig: patchPermissionConfig(step.permissionConfig, modelId, e.target.value),
          })
        }
      >
        <option value="">Rule default</option>
        {meta.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function describeAgentLimits(step: Pick<WorkflowStep, "stopAfterMin" | "stopWhenIdleMin">): string {
  const parts: string[] = [];
  if (step.stopAfterMin) parts.push(`Stops after ${step.stopAfterMin} min`);
  if (step.stopWhenIdleMin) {
    parts.push(parts.length ? `or after ${step.stopWhenIdleMin} min idle` : `Stops after ${step.stopWhenIdleMin} min idle`);
  }
  return parts.length ? parts.join(" · ") : "No limits · runs until it finishes";
}

/**
 * An automation's agent runs like a chat you start yourself: no clock. Limits
 * are opt-in, and the collapsed row always says which ones apply.
 */
function AgentLimits({
  step,
  onChange,
}: {
  step: WorkflowStep;
  onChange: (next: WorkflowStep) => void;
}) {
  const [open, setOpen] = useState(false);
  const hasLimits = Boolean(step.stopAfterMin || step.stopWhenIdleMin);

  return (
    <div className="rounded-md border border-white/[0.06] bg-white/[0.02]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Timer size={12} weight="regular" className={hasLimits ? "text-accent" : "text-muted-fg/60"} />
          <span className={cn("truncate text-[11.5px]", hasLimits ? "text-fg/90" : "text-muted-fg/75")}>
            {describeAgentLimits(step)}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1 text-[10.5px] text-muted-fg/60">
          {open ? "Done" : hasLimits ? "Edit" : "Add a limit"}
          <CaretDown size={9} weight="bold" className={cn("transition-transform", open && "rotate-180")} />
        </span>
      </button>
      {open ? (
        <div className="space-y-2.5 border-t border-white/[0.06] px-3 pb-3 pt-2.5">
          <div className="grid items-center gap-x-3 gap-y-2 sm:grid-cols-[8rem_1fr]">
            <span className="text-[11.5px] text-fg/85">Stop after</span>
            <MinutesInput
              value={step.stopAfterMin}
              onChange={(v) => onChange({ ...step, stopAfterMin: v })}
              placeholder="No limit"
              ariaLabel="Stop the agent after this many minutes"
              max={AUTOMATION_AGENT_LIMIT_MAX_MIN}
            />
            <span className="text-[11.5px] text-fg/85">Stop when idle for</span>
            <MinutesInput
              value={step.stopWhenIdleMin}
              onChange={(v) => onChange({ ...step, stopWhenIdleMin: v })}
              placeholder="No limit"
              ariaLabel="Stop the agent after this many idle minutes"
              max={AUTOMATION_AGENT_LIMIT_MAX_MIN}
            />
          </div>
          <p className="text-[10.5px] leading-relaxed text-muted-fg/60">
            Either limit interrupts the agent and keeps the chat open. Waiting on a command, tool, subagent, or
            approval doesn't count as idle; long silent thinking can, so leave some room.
          </p>
        </div>
      ) : null}
    </div>
  );
}

export function AgentStepEditor({
  step,
  triggerType,
  onChange,
}: {
  step: WorkflowStep;
  triggerType: string;
  onChange: (next: WorkflowStep) => void;
}) {
  const modelId = step.modelConfig?.modelId ?? defaultModelId();

  const setModel = (nextId: string) => {
    const next: ModelConfig = { ...(step.modelConfig ?? { modelId: nextId }), modelId: nextId };
    onChange({ ...step, modelConfig: next });
  };
  const setEffort = (effort: string | null) => {
    const next: ModelConfig = {
      ...(step.modelConfig ?? { modelId }),
      modelId,
      thinkingLevel: (effort ?? undefined) as ThinkingLevel | undefined,
    };
    onChange({ ...step, modelConfig: next });
  };

  return (
    <div className="space-y-3">
      <VariableInput
        value={step.sessionTitle ?? ""}
        onChange={(v) => onChange({ ...step, sessionTitle: v })}
        triggerType={triggerType}
        placeholder="Thread title (optional)"
        showVariables={false}
      />
      <VariableTextarea
        value={step.prompt ?? ""}
        onChange={(v) => onChange({ ...step, prompt: v })}
        triggerType={triggerType}
        placeholder="What should the agent do? Reference issue and PR fields with variables."
        rows={5}
      />

      <div className="grid gap-2 sm:grid-cols-3">
        <div className="space-y-1">
          <span className={labelCls}>Model</span>
          <ModelPicker
            value={modelId}
            onChange={setModel}
            hidePermissionRail
            triggerClassName="w-full justify-between"
          />
        </div>
        <div className="space-y-1">
          <span className={labelCls}>Reasoning</span>
          <ReasoningEffortPicker
            modelId={modelId}
            reasoningEffort={step.modelConfig?.thinkingLevel ?? null}
            onChange={setEffort}
            triggerClassName="w-full justify-between"
          />
        </div>
        <PermissionPicker step={step} onChange={onChange} />
      </div>

      <AgentLimits step={step} onChange={onChange} />
    </div>
  );
}

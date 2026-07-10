import { getDefaultModelDescriptor } from "../../../../shared/modelRegistry";
import type { ModelConfig, ThinkingLevel } from "../../../../shared/types";
import { ModelPicker } from "../../shared/ModelPicker/ModelPicker";
import { ReasoningEffortPicker } from "../../shared/ModelPicker/ReasoningEffortPicker";
import { labelCls, selectCls } from "../designTokens";
import { permissionControlsForModel, patchPermissionConfig } from "../permissionControls";
import type { WorkflowStep } from "./draftBridge";
import { VariableInput, VariableTextarea } from "./VariableMenu";

const DEFAULT_MODEL_ID =
  getDefaultModelDescriptor("opencode")?.id
  ?? getDefaultModelDescriptor("claude")?.id
  ?? "anthropic/claude-sonnet-5";

function PermissionPicker({
  step,
  onChange,
}: {
  step: WorkflowStep;
  onChange: (next: WorkflowStep) => void;
}) {
  const modelId = step.modelConfig?.modelId ?? DEFAULT_MODEL_ID;
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

export function AgentStepEditor({
  step,
  triggerType,
  onChange,
}: {
  step: WorkflowStep;
  triggerType: string;
  onChange: (next: WorkflowStep) => void;
}) {
  const modelId = step.modelConfig?.modelId ?? DEFAULT_MODEL_ID;

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
            surfaceKey="automations.agent-step"
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
    </div>
  );
}

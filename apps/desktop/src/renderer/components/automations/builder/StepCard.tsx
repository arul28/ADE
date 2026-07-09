import { ArrowDown, ArrowUp, Trash } from "@phosphor-icons/react";
import type { TestSuiteDefinition } from "../../../../shared/types";
import { Chip } from "../../ui/Chip";
import { cn } from "../../ui/cn";
import { SettingsToggle } from "../../settings/settingsSectionUi";
import { AdeActionEditor } from "../AdeActionEditor";
import { inputCls, labelCls, selectCls } from "../designTokens";
import { stepDef } from "../actionCatalog";
import type { WorkflowStep } from "./draftBridge";
import { AgentStepEditor } from "./AgentStepEditor";

function ToggleRow({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 rounded-md border border-white/[0.06] bg-white/[0.02] px-3 py-2">
      <span className="min-w-0">
        <span className="block text-[11.5px] text-fg/90">{label}</span>
        {hint ? <span className="mt-0.5 block text-[10px] text-muted-fg/60">{hint}</span> : null}
      </span>
      <SettingsToggle id={id} checked={checked} onChange={onChange} />
    </label>
  );
}

function DeleteLaneFields({
  step,
  onChange,
  idBase,
}: {
  step: WorkflowStep;
  onChange: (next: WorkflowStep) => void;
  idBase: string;
}) {
  const opts = step.laneDeleteOptions ?? {};
  const setOpt = (patch: Partial<typeof opts>) =>
    onChange({ ...step, laneDeleteOptions: { ...opts, ...patch } });
  return (
    <div className="space-y-2.5">
      <label className="block space-y-1">
        <span className={labelCls}>Delay before deleting</span>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            className={cn(inputCls, "w-24")}
            value={Number.isFinite(step.afterMinutes) ? String(step.afterMinutes) : ""}
            onChange={(e) => {
              const raw = e.target.value.trim();
              onChange({ ...step, afterMinutes: raw ? Math.max(0, Number(raw)) : undefined });
            }}
            placeholder="0"
          />
          <span className="text-[11px] text-muted-fg/70">minutes after the run finishes</span>
        </div>
      </label>
      <ToggleRow
        id={`${idBase}-del-branch`}
        label="Also delete the local branch"
        checked={opts.deleteBranch === true}
        onChange={(v) => setOpt({ deleteBranch: v })}
      />
      <ToggleRow
        id={`${idBase}-del-remote`}
        label="Also delete the remote branch"
        checked={opts.deleteRemoteBranch === true}
        onChange={(v) => setOpt({ deleteRemoteBranch: v })}
      />
      <ToggleRow
        id={`${idBase}-del-force`}
        label="Force delete even with unmerged changes"
        checked={opts.force === true}
        onChange={(v) => setOpt({ force: v })}
      />
    </div>
  );
}

export function StepCard({
  step,
  index,
  total,
  triggerType,
  suites,
  isCleanup,
  onChange,
  onRemove,
  onMove,
}: {
  step: WorkflowStep;
  index: number;
  total: number;
  triggerType: string;
  suites: TestSuiteDefinition[];
  isCleanup: boolean;
  onChange: (next: WorkflowStep) => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
}) {
  const def = stepDef(step.kind);
  const Icon = def.icon;
  const idBase = `step-${index}-${step.kind}`;

  return (
    <div
      className={cn(
        "rounded-xl border bg-white/[0.03] shadow-card",
        isCleanup ? "border-amber-500/25" : "border-white/[0.07]",
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
              isCleanup ? "bg-amber-500/15 text-amber-300" : "bg-accent/15 text-accent",
            )}
          >
            <Icon size={12} weight="fill" />
          </span>
          {!isCleanup ? (
            <span className="text-[10px] font-semibold tracking-wider text-muted-fg/60">STEP {index + 1}</span>
          ) : null}
          <span className="text-[12px] font-semibold text-fg">{isCleanup ? "Cleanup" : def.label}</span>
          {step.alwaysRun ? (
            <Chip className="border-amber-400/30 text-[8.5px] text-amber-200">Always runs</Chip>
          ) : null}
        </div>
        {!isCleanup ? (
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => onMove(-1)}
              disabled={index === 0}
              className="rounded p-1 text-muted-fg/60 hover:text-fg disabled:cursor-not-allowed disabled:opacity-30"
              title="Move up"
            >
              <ArrowUp size={11} weight="bold" />
            </button>
            <button
              type="button"
              onClick={() => onMove(1)}
              disabled={index === total - 1}
              className="rounded p-1 text-muted-fg/60 hover:text-fg disabled:cursor-not-allowed disabled:opacity-30"
              title="Move down"
            >
              <ArrowDown size={11} weight="bold" />
            </button>
            <button
              type="button"
              onClick={onRemove}
              className="rounded p-1 text-muted-fg/60 hover:text-red-300"
              title="Remove step"
            >
              <Trash size={11} weight="regular" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={onRemove}
            className="rounded p-1 text-muted-fg/60 hover:text-red-300"
            title="Remove cleanup"
          >
            <Trash size={11} weight="regular" />
          </button>
        )}
      </div>

      <div className="space-y-3 p-3">
        {step.kind === "agent-session" ? (
          <AgentStepEditor step={step} triggerType={triggerType} onChange={onChange} />
        ) : null}

        {step.kind === "ade-action" ? (
          <AdeActionEditor
            value={step.adeAction ?? { domain: "", action: "" }}
            onChange={(adeAction) => onChange({ ...step, adeAction })}
          />
        ) : null}

        {step.kind === "run-tests" ? (
          <label className="block space-y-1">
            <span className={labelCls}>Suite</span>
            <select
              className={selectCls}
              value={step.suiteId ?? ""}
              onChange={(e) => onChange({ ...step, suiteId: e.target.value })}
            >
              <option value="" disabled>
                Select a suite
              </option>
              {suites.map((suite) => (
                <option key={suite.id} value={suite.id}>
                  {suite.name ?? suite.id}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {step.kind === "run-command" ? (
          <div className="grid gap-2 sm:grid-cols-[2fr_1fr]">
            <input
              className={cn(inputCls, "font-mono")}
              value={step.command ?? ""}
              onChange={(e) => onChange({ ...step, command: e.target.value })}
              placeholder="npm test"
              spellCheck={false}
            />
            <input
              className={inputCls}
              value={step.cwd ?? ""}
              onChange={(e) => onChange({ ...step, cwd: e.target.value })}
              placeholder="Working dir (optional)"
              spellCheck={false}
            />
          </div>
        ) : null}

        {step.kind === "predict-conflicts" ? (
          <p className="text-[11px] leading-relaxed text-muted-fg/70">
            Runs the built-in conflict-prediction pass against recent lanes. No configuration needed.
          </p>
        ) : null}

        {step.kind === "delete-lane" ? (
          <DeleteLaneFields step={step} onChange={onChange} idBase={idBase} />
        ) : null}

        {/* Cleanup steps always run by definition; other steps opt in. */}
        {!isCleanup && index > 0 ? (
          <ToggleRow
            id={`${idBase}-always`}
            label="Always run, even if earlier steps fail"
            checked={step.alwaysRun === true}
            onChange={(v) => onChange({ ...step, alwaysRun: v || undefined })}
          />
        ) : null}
      </div>
    </div>
  );
}

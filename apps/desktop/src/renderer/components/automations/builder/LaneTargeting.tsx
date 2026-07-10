import { useMemo } from "react";
import { GitBranch, Sparkle, Warning } from "@phosphor-icons/react";
import type {
  AutomationLaneNamePreset,
  AutomationTrigger,
} from "../../../../shared/types";
import { cn } from "../../ui/cn";
import { labelCls, recessedCls, selectCls } from "../designTokens";
import { VariableInput } from "./VariableMenu";

export type LaneTargetingValue = {
  laneMode: string;
  laneNamePreset: AutomationLaneNamePreset;
  laneNameTemplate: string;
  targetLaneId: string | null;
};

export type LaneTargetingPatch = Partial<{
  laneMode: string;
  laneNamePreset: AutomationLaneNamePreset;
  laneNameTemplate: string;
  targetLaneId: string | null;
}>;

const LANE_NAME_PRESETS: Array<{
  value: AutomationLaneNamePreset;
  label: string;
  template: string;
  reads: "issue" | "pr" | "any";
}> = [
  { value: "issue-title", label: "Issue title", template: "{{trigger.issue.title}}", reads: "issue" },
  { value: "issue-num-title", label: "Issue #N – Title", template: "#{{trigger.issue.number}} – {{trigger.issue.title}}", reads: "issue" },
  { value: "pr-title-author", label: "PR title – Author", template: "{{trigger.pr.title}} – {{trigger.pr.author}}", reads: "pr" },
  { value: "custom", label: "Custom template", template: "", reads: "any" },
];

function presetTemplate(preset: AutomationLaneNamePreset, custom: string): string {
  if (preset === "custom") return custom;
  return LANE_NAME_PRESETS.find((p) => p.value === preset)?.template ?? "";
}

function sampleContext(trigger: AutomationTrigger): { kind: "issue" | "pr" | "any"; sample: Record<string, unknown> } {
  const t = trigger.type as string;
  if (t.includes("issue")) {
    return {
      kind: "issue",
      sample: { issue: { number: 427, title: "Fix Safari login", author: "octocat", url: "…" } },
    };
  }
  if (t.includes("pr")) {
    return { kind: "pr", sample: { pr: { number: 314, title: "Add image caching", author: "octocat" } } };
  }
  return { kind: "any", sample: {} };
}

function previewResolve(template: string, sample: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    if (path === "date") return new Date().toISOString().slice(0, 10);
    if (path === "time") return "09:00";
    const segs = path.split(".");
    let cursor: unknown = sample;
    for (let i = 1; i < segs.length; i++) {
      if (cursor && typeof cursor === "object" && segs[i]! in (cursor as Record<string, unknown>)) {
        cursor = (cursor as Record<string, unknown>)[segs[i]!];
      } else {
        return `‹${segs[segs.length - 1]}›`;
      }
    }
    return String(cursor ?? "");
  });
}

const RUN_IN_OPTIONS = [
  { value: "create", label: "A new lane each run" },
  { value: "reuse", label: "An existing lane" },
  { value: "require-on-trigger", label: "The lane that triggered it" },
];

export function LaneTargeting({
  value,
  trigger,
  lanes,
  onChange,
}: {
  value: LaneTargetingValue;
  trigger: AutomationTrigger;
  lanes: Array<{ id: string; name: string }>;
  onChange: (patch: LaneTargetingPatch) => void;
}) {
  const sortedLanes = useMemo(() => [...lanes].sort((a, b) => a.name.localeCompare(b.name)), [lanes]);
  const mode =
    value.laneMode === "create"
      ? "create"
      : value.laneMode === "require-on-trigger" || value.laneMode === "provided" || value.laneMode === "prompt-at-run"
        ? "require-on-trigger"
        : "reuse";

  // "The triggering lane" only makes sense for event triggers, not schedule/manual.
  const triggerType = trigger.type as string;
  const supportsTriggerLane = !(triggerType === "schedule" || triggerType === "manual");

  const { kind: triggerKind } = sampleContext(trigger);
  const template = presetTemplate(value.laneNamePreset, value.laneNameTemplate);
  const preview = useMemo(
    () => previewResolve(template, sampleContext(trigger).sample),
    [template, trigger],
  );
  const presetMeta = LANE_NAME_PRESETS.find((p) => p.value === value.laneNamePreset);
  const presetMismatch =
    value.laneNamePreset !== "custom"
    && presetMeta?.reads !== "any"
    && presetMeta?.reads !== triggerKind
    && triggerKind !== "any";

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-[auto_1fr] sm:items-center">
        <span className={labelCls}>Run in</span>
        <select
          className={selectCls}
          value={mode === "reuse" ? `reuse:${value.targetLaneId ?? ""}` : mode}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "create") return onChange({ laneMode: "create", targetLaneId: null });
            if (v === "require-on-trigger") return onChange({ laneMode: "require-on-trigger", targetLaneId: null });
            if (v === "reuse:") return onChange({ laneMode: "reuse", targetLaneId: null });
            if (v.startsWith("reuse:")) return onChange({ laneMode: "reuse", targetLaneId: v.slice(6) });
          }}
        >
          <option value="create">{RUN_IN_OPTIONS[0]!.label}</option>
          {supportsTriggerLane ? (
            <option value="require-on-trigger">{RUN_IN_OPTIONS[2]!.label}</option>
          ) : null}
          <option value="reuse:">The primary lane</option>
          {sortedLanes.map((lane) => (
            <option key={lane.id} value={`reuse:${lane.id}`}>
              {lane.name}
            </option>
          ))}
        </select>
      </div>

      {mode === "create" ? (
        <div className={cn(recessedCls, "space-y-3 p-3")}>
          <div className="flex items-center gap-2 text-[11px] text-accent">
            <Sparkle size={12} weight="fill" />
            <span className="font-medium">A fresh lane is created for every run.</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block space-y-1.5">
              <div className={labelCls}>Name</div>
              <select
                className={selectCls}
                value={value.laneNamePreset}
                onChange={(e) => onChange({ laneNamePreset: e.target.value as AutomationLaneNamePreset })}
              >
                {LANE_NAME_PRESETS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            {value.laneNamePreset === "custom" ? (
              <label className="block space-y-1.5">
                <div className={labelCls}>Template</div>
                <VariableInput
                  value={value.laneNameTemplate}
                  onChange={(next) => onChange({ laneNameTemplate: next })}
                  triggerType={triggerType}
                  placeholder="{{trigger.issue.title}}"
                />
              </label>
            ) : null}
          </div>

          <div className="rounded-md border border-white/[0.06] bg-black/[0.18] px-3 py-2">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.1em] text-muted-fg/60">
              <GitBranch size={10} weight="regular" />
              Preview
            </div>
            <div className="mt-1 break-all font-mono text-[11px] text-fg">
              {preview.trim() || <span className="text-muted-fg/50">(pick a preset or type a template)</span>}
            </div>
          </div>

          {presetMismatch ? (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
              <Warning size={12} weight="regular" className="mt-0.5 shrink-0" />
              <span>
                This preset reads a {presetMeta?.reads === "issue" ? "issue" : "PR"} field the selected trigger doesn't
                provide. Switch presets or the run will fail.
              </span>
            </div>
          ) : (
            <p className="text-[11px] leading-relaxed text-muted-fg/60">
              Auto-numbered if a name repeats.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

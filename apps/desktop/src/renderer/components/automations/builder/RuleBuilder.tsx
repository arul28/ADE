import { useEffect, useMemo, useRef } from "react";
import type { ElementType } from "react";
import {
  CheckCircle,
  FloppyDisk,
  Flask,
  GitBranch,
  ListChecks,
  Play,
  Sliders,
} from "@phosphor-icons/react";
import type {
  AutomationDraftConfirmationRequirement,
  AutomationDraftIssue,
  AutomationIngressStatus,
  AutomationLaneNamePreset,
  AutomationRuleDraft,
  AutomationTrigger,
  TestSuiteDefinition,
} from "../../../../shared/types";
import { Button } from "../../ui/Button";
import { Chip } from "../../ui/Chip";
import { cn } from "../../ui/cn";
import { SettingsToggle } from "../../settings/settingsSectionUi";
import { inputCls, sectionCls, textareaCls } from "../designTokens";
import { buildRuleSentence } from "../automationCopy";
import { sourceDef, sourceForTriggerType } from "../triggerCatalog";
import { RuleSentence } from "../list/RuleSentence";
import { TriggerCard } from "./TriggerCard";
import { LaneTargeting } from "./LaneTargeting";
import { StepStack } from "./StepStack";
import { applyStepsToDraft, draftToSteps, isRequireLaneMode, readLaneMode, type WorkflowStep } from "./draftBridge";

function Section({
  icon: Icon,
  title,
  hint,
  children,
}: {
  icon: ElementType;
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn(sectionCls, "overflow-hidden")}>
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-2.5">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/12 text-accent">
          <Icon size={13} weight="fill" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-semibold text-fg">{title}</div>
          {hint ? <div className="text-[11px] text-muted-fg/65">{hint}</div> : null}
        </div>
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function IssueList({ title, issues, tone }: { title: string; issues: AutomationDraftIssue[]; tone: "error" | "warning" }) {
  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2 text-[11px]",
        tone === "error" ? "border-red-500/30 bg-red-500/10 text-red-200" : "border-amber-500/25 bg-amber-500/10 text-amber-200",
      )}
    >
      <div className="font-semibold">{title}</div>
      <ul className="mt-1 space-y-0.5">
        {issues.map((issue, i) => (
          <li key={`${issue.path}-${i}`}>
            <span className="font-mono text-[10px] text-fg/70">{issue.path}</span>: {issue.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ConfirmationsChecklist({
  required,
  accepted,
  onToggle,
}: {
  required: AutomationDraftConfirmationRequirement[];
  accepted: Set<string>;
  onToggle: (key: string, checked: boolean) => void;
}) {
  if (!required.length) return null;
  return (
    <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.06] p-3">
      <div className="text-xs font-semibold text-fg">Confirm before saving</div>
      <div className="mt-2 space-y-2">
        {required.map((req) => (
          <label key={req.key} className="flex items-start gap-2 text-[11px] text-fg/85">
            <input
              type="checkbox"
              checked={accepted.has(req.key)}
              onChange={(e) => onToggle(req.key, e.target.checked)}
              className="mt-0.5 accent-accent"
            />
            <span>
              <span className={cn("font-semibold", req.severity === "danger" ? "text-red-300" : "text-amber-200")}>{req.title}</span>
              {" · "}
              {req.message}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

export function RuleBuilder({
  draft,
  setDraft,
  lanes,
  suites,
  ingressStatus,
  issues,
  simulationNotes,
  requiredConfirmations,
  acceptedConfirmations,
  onToggleConfirmation,
  onSave,
  onSimulate,
  onRunNow,
  onIngressChanged,
  saving,
  simulating = false,
  running = false,
  dirty = false,
}: {
  draft: AutomationRuleDraft;
  setDraft: (draft: AutomationRuleDraft) => void;
  lanes: Array<{ id: string; name: string }>;
  suites: TestSuiteDefinition[];
  ingressStatus: AutomationIngressStatus | null;
  issues: AutomationDraftIssue[];
  simulationNotes?: string[];
  requiredConfirmations: AutomationDraftConfirmationRequirement[];
  acceptedConfirmations: Set<string>;
  onToggleConfirmation: (key: string, checked: boolean) => void;
  onSave: () => void;
  onSimulate?: () => void;
  onRunNow?: () => void;
  onIngressChanged?: () => void;
  saving: boolean;
  simulating?: boolean;
  running?: boolean;
  dirty?: boolean;
}) {
  const primaryTrigger: AutomationTrigger = draft.triggers[0] ?? draft.trigger ?? { type: "manual" };
  const source = sourceForTriggerType(primaryTrigger.type);
  const meta = sourceDef(source);

  const steps = useMemo(() => draftToSteps(draft), [draft]);
  const sentence = useMemo(() => buildRuleSentence(draft), [draft]);

  const laneMode = readLaneMode(draft);
  const lanePreset: AutomationLaneNamePreset = draft.execution?.laneNamePreset ?? "issue-title";

  const laneDirtyRef = useRef(false);

  const setTrigger = (next: AutomationTrigger) => setDraft({ ...draft, triggers: [next], trigger: next });

  const patchExecution = (patch: {
    laneMode?: string;
    targetLaneId?: string | null;
    laneNamePreset?: AutomationLaneNamePreset;
    laneNameTemplate?: string;
  }) => {
    const current = draft.execution ?? { kind: "agent-session" as const };
    const next = { ...current };
    if (patch.laneMode !== undefined) (next as { laneMode?: string }).laneMode = patch.laneMode;
    if (patch.laneNamePreset !== undefined) next.laneNamePreset = patch.laneNamePreset;
    if (patch.laneNameTemplate !== undefined) next.laneNameTemplate = patch.laneNameTemplate;
    if (patch.targetLaneId !== undefined) {
      if (patch.targetLaneId == null) delete next.targetLaneId;
      else next.targetLaneId = patch.targetLaneId;
    }
    let nextDraft: AutomationRuleDraft = { ...draft, execution: next };
    if (isRequireLaneMode((next as { laneMode?: string }).laneMode)) {
      // Require-on-trigger resolves the lane from the event; per-step lane
      // overrides would conflict, so strip them.
      nextDraft = applyStepsToDraft(nextDraft, draftToSteps(nextDraft));
    }
    setDraft(nextDraft);
  };

  // Smart defaults: when the trigger EVENT changes and the user hasn't touched
  // lane targeting, snap to a sensible lane mode.
  const lastTriggerType = useRef(primaryTrigger.type);
  useEffect(() => {
    if (lastTriggerType.current === primaryTrigger.type) return;
    lastTriggerType.current = primaryTrigger.type;
    if (laneDirtyRef.current) return;
    const t = primaryTrigger.type as string;
    if (t === "github.issue_opened" || t === "linear.issue_created") {
      patchExecution({ laneMode: "create", laneNamePreset: "issue-title" });
    } else if (t === "github.pr_opened") {
      patchExecution({ laneMode: "create", laneNamePreset: "pr-title-author" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryTrigger.type]);

  const setSteps = (next: WorkflowStep[]) => setDraft(applyStepsToDraft(draft, next));

  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");
  const notes = simulationNotes ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-white/[0.06] bg-white/[0.02] px-5 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <meta.icon size={15} weight="fill" className="text-accent" />
              <span className="text-[14px] font-semibold text-fg">{draft.id ? "Edit automation" : "New automation"}</span>
              {dirty ? (
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400" title="Unsaved changes" />
              ) : null}
            </div>
            <div className="mt-1.5 max-w-xl">
              <RuleSentence sentence={sentence} className="text-[12px]" />
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Chip className="text-[9px]">{steps.length} step{steps.length === 1 ? "" : "s"}</Chip>
            {onRunNow ? (
              <Button size="sm" variant="outline" disabled={running || saving || !draft.id} onClick={onRunNow} title={draft.id ? "Run this rule now" : "Save first to run"}>
                <Play size={12} weight="fill" className={cn(running && "animate-pulse")} />
                Run now
              </Button>
            ) : null}
            {onSimulate ? (
              <Button size="sm" variant="outline" disabled={simulating || saving} onClick={onSimulate}>
                <Flask size={12} weight="regular" className={cn(simulating && "animate-spin")} />
                Dry run
              </Button>
            ) : null}
            <Button size="sm" variant="primary" disabled={saving} onClick={onSave}>
              <FloppyDisk size={12} weight="regular" className={cn(saving && "animate-spin")} />
              Save
            </Button>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3.5 px-5 py-5">
          {errors.length ? <IssueList title="Errors" issues={errors} tone="error" /> : null}
          {warnings.length ? <IssueList title="Notes" issues={warnings} tone="warning" /> : null}
          {notes.length ? (
            <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-100">
              <div className="flex items-center gap-1.5 font-semibold">
                <CheckCircle size={13} weight="fill" />
                Dry run ready
              </div>
              <ul className="mt-1 space-y-0.5">
                {notes.map((note, i) => (
                  <li key={`${note}-${i}`}>{note}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <ConfirmationsChecklist required={requiredConfirmations} accepted={acceptedConfirmations} onToggle={onToggleConfirmation} />

          <Section icon={Sliders} title="Details" hint="Name and describe this automation">
            <div className="space-y-3">
              <input
                className={inputCls}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="e.g. Triage new GitHub issues"
              />
              <textarea
                className={cn(textareaCls, "min-h-[64px]")}
                value={draft.description ?? ""}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                placeholder="What this automation is for (optional)"
              />
              <label className="flex cursor-pointer items-center justify-between gap-3 rounded-md border border-white/[0.06] bg-white/[0.02] px-3 py-2">
                <span className="min-w-0">
                  <span className="block text-[11.5px] text-fg/90">Enabled</span>
                  <span className="mt-0.5 block text-[10px] text-muted-fg/60">
                    {draft.enabled ? "Runs when its trigger fires" : "Paused — won't run"}
                  </span>
                </span>
                <SettingsToggle id="automation-enabled" checked={draft.enabled} onChange={(v) => setDraft({ ...draft, enabled: v })} />
              </label>
            </div>
          </Section>

          <Section icon={meta.icon} title="Trigger" hint={meta.hint}>
            <TriggerCard
              trigger={primaryTrigger}
              ingressStatus={ingressStatus}
              onChange={setTrigger}
              onIngressChanged={onIngressChanged}
            />
          </Section>

          <Section icon={GitBranch} title="Where it runs" hint="Which lane each run works in">
            <LaneTargeting
              value={{
                laneMode,
                laneNamePreset: lanePreset,
                laneNameTemplate: draft.execution?.laneNameTemplate ?? "",
                targetLaneId: draft.execution?.targetLaneId ?? null,
              }}
              trigger={primaryTrigger}
              lanes={lanes}
              onChange={(patch) => {
                laneDirtyRef.current = true;
                patchExecution(patch);
              }}
            />
          </Section>

          <Section
            icon={ListChecks}
            title="Workflow"
            hint={`${steps.length} step${steps.length === 1 ? "" : "s"} — runs top to bottom`}
          >
            <StepStack steps={steps} triggerType={primaryTrigger.type} suites={suites} onChange={setSteps} />
          </Section>
        </div>
      </div>
    </div>
  );
}

import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  CaretDown,
  CaretRight,
  FloppyDisk,
  Flask,
} from "@phosphor-icons/react";
import { getDefaultModelDescriptor } from "../../../../shared/modelRegistry";
import type {
  AutomationAction,
  AutomationDraftConfirmationRequirement,
  AutomationDraftIssue,
  AutomationRuleDraft,
  AutomationTrigger,
  TestSuiteDefinition,
} from "../../../../shared/types";
import { ModelSelector } from "../../missions/ModelSelector";
import { Button } from "../../ui/Button";
import { Chip } from "../../ui/Chip";
import { cn } from "../../ui/cn";
import { permissionControlsForModel, patchPermissionConfig } from "../permissionControls";
import { CARD_STYLE, INPUT_CLS, INPUT_STYLE } from "../shared";
import { GitHubTriggerFilters } from "../GitHubTriggerFilters";
import { LinearTriggerFilters } from "../LinearTriggerFilters";
import { ActionList } from "../ActionList";
import type { ActionRowValue } from "../ActionRow";

const DEFAULT_MODEL_ID =
  getDefaultModelDescriptor("opencode")?.id
  ?? getDefaultModelDescriptor("claude")?.id
  ?? "anthropic/claude-sonnet-4-6";

type TriggerFamily = "manual" | "schedule" | "github" | "linear" | "local-git" | "file-change" | "lane" | "session" | "webhook";

const TRIGGER_FAMILIES: Array<{ value: TriggerFamily; label: string }> = [
  { value: "github", label: "GitHub" },
  { value: "linear", label: "Linear" },
  { value: "schedule", label: "Schedule" },
  { value: "local-git", label: "Local git" },
  { value: "file-change", label: "File change" },
  { value: "lane", label: "Lane" },
  { value: "session", label: "Session" },
  { value: "webhook", label: "Webhook" },
  { value: "manual", label: "Manual" },
];

const TRIGGER_OPTIONS: Record<TriggerFamily, Array<{ value: AutomationTrigger["type"]; label: string }>> = {
  github: [
    { value: "github.pr_opened", label: "PR opened" },
    { value: "github.pr_updated", label: "PR updated" },
    { value: "github.pr_merged", label: "PR merged" },
    { value: "github.pr_closed", label: "PR closed" },
    { value: "github.pr_commented", label: "PR commented" },
    { value: "github.pr_review_submitted", label: "PR review submitted" },
    { value: "github.issue_opened", label: "Issue opened" },
    { value: "github.issue_edited", label: "Issue edited" },
    { value: "github.issue_closed", label: "Issue closed" },
    { value: "github.issue_labeled", label: "Issue labeled" },
    { value: "github.issue_commented", label: "Issue commented" },
  ],
  linear: [
    { value: "linear.issue_created", label: "Issue created" },
    { value: "linear.issue_updated", label: "Issue updated" },
    { value: "linear.issue_assigned", label: "Issue assigned" },
    { value: "linear.issue_status_changed", label: "Status changed" },
  ],
  schedule: [{ value: "schedule", label: "Cron schedule" }],
  "local-git": [
    { value: "git.commit", label: "Commit created" },
    { value: "git.push", label: "Push completed" },
  ],
  "file-change": [{ value: "file.change", label: "File changed" }],
  lane: [
    { value: "lane.created", label: "Lane created" },
    { value: "lane.archived", label: "Lane archived" },
  ],
  session: [{ value: "session-end", label: "Session ended" }],
  webhook: [
    { value: "github-webhook", label: "GitHub relay webhook" },
    { value: "webhook", label: "Custom webhook" },
  ],
  manual: [{ value: "manual", label: "Run on click only" }],
};

const SCHEDULE_PRESETS: Array<{ label: string; cron: string }> = [
  { label: "Weekdays at 9 AM", cron: "0 9 * * 1-5" },
  { label: "Every day at 9 AM", cron: "0 9 * * *" },
  { label: "Every day at 2 AM", cron: "0 2 * * *" },
  { label: "Fridays at 4 PM", cron: "0 16 * * 5" },
];

function triggerFamilyForType(type: AutomationTrigger["type"]): TriggerFamily {
  if (type === "schedule") return "schedule";
  if (type.startsWith("github.")) return "github";
  if (type.startsWith("git.pr_")) return "github";
  if (type === "git.commit" || type === "git.push") return "local-git";
  if (type.startsWith("linear.")) return "linear";
  if (type === "file.change") return "file-change";
  if (type === "lane.created" || type === "lane.archived") return "lane";
  if (type === "session-end") return "session";
  if (type === "github-webhook" || type === "webhook") return "webhook";
  if (type === "manual") return "manual";
  return "manual";
}

function defaultTriggerForFamily(family: TriggerFamily): AutomationTrigger {
  switch (family) {
    case "github":
      return { type: "github.pr_opened" };
    case "linear":
      return { type: "linear.issue_created" };
    case "schedule":
      return { type: "schedule", cron: "0 9 * * 1-5" };
    case "local-git":
      return { type: "git.push" };
    case "file-change":
      return { type: "file.change" };
    case "lane":
      return { type: "lane.created" };
    case "session":
      return { type: "session-end" };
    case "webhook":
      return { type: "github-webhook", event: "pull_request", secretRef: "github-webhook" };
    case "manual":
      return { type: "manual" };
  }
}

function ensurePrimaryTrigger(draft: AutomationRuleDraft): AutomationTrigger {
  return draft.triggers[0] ?? draft.trigger ?? { type: "manual" };
}

function triggerLabel(trigger: AutomationTrigger): string {
  if (trigger.type === "schedule") return trigger.cron?.trim() ? `schedule · ${trigger.cron}` : "schedule";
  if (trigger.branch?.trim()) return `${trigger.type} · ${trigger.branch.trim()}`;
  if (trigger.team?.trim()) return `${trigger.type} · ${trigger.team.trim()}`;
  return trigger.type;
}

function computeIncludeProjectContext(draft: AutomationRuleDraft): boolean {
  if (typeof draft.includeProjectContext === "boolean") return draft.includeProjectContext;
  if (draft.memory?.mode && draft.memory.mode !== "none") return true;
  if ((draft.contextSources ?? []).length > 0) return true;
  return false;
}

// --- draft <-> ActionRow[] bridge ---

function draftToActionRows(draft: AutomationRuleDraft): ActionRowValue[] {
  const rows: ActionRowValue[] = [];
  const execution = draft.execution;
  if (execution?.kind === "agent-session") {
    rows.push({
      kind: "agent-session",
      prompt: draft.prompt ?? "",
      sessionTitle: execution.session?.title ?? "",
    });
  } else if (execution?.kind === "mission") {
    rows.push({
      kind: "launch-mission",
      missionTitle: execution.mission?.title ?? "",
    });
  } else if (execution?.kind === "built-in") {
    for (const action of execution.builtIn?.actions ?? []) {
      if (action.type === "create-lane") {
        rows.push({
          kind: "create-lane",
          laneNameTemplate: action.laneNameTemplate ?? "",
          laneDescriptionTemplate: action.laneDescriptionTemplate ?? "",
          parentLaneId: action.parentLaneId ?? null,
        });
      } else if (action.type === "run-tests") {
        rows.push({ kind: "run-tests", suiteId: action.suiteId ?? "" });
      } else if (action.type === "run-command") {
        rows.push({ kind: "run-command", command: action.command ?? "", cwd: action.cwd ?? "" });
      } else if (action.type === "predict-conflicts") {
        rows.push({ kind: "predict-conflicts" });
      } else if (action.type === "ade-action") {
        rows.push({ kind: "ade-action", adeAction: action.adeAction ?? { domain: "", action: "" } });
      } else if (action.type === "agent-session") {
        rows.push({
          kind: "agent-session",
          prompt: action.prompt ?? "",
          sessionTitle: action.sessionTitle ?? "",
          targetLaneId: action.targetLaneId ?? null,
          modelConfig: action.modelConfig,
          permissionConfig: action.permissionConfig,
        });
      } else if (action.type === "launch-mission") {
        rows.push({ kind: "launch-mission", missionTitle: action.sessionTitle ?? "" });
      }
    }
  }
  return rows;
}

function applyActionRowsToDraft(draft: AutomationRuleDraft, rows: ActionRowValue[]): AutomationRuleDraft {
  // If a single agent-session or launch-mission row is present alone, fold into execution.
  const soloAgent = rows.length === 1 && rows[0]!.kind === "agent-session";
  const soloMission = rows.length === 1 && rows[0]!.kind === "launch-mission";

  if (soloAgent) {
    const first = rows[0]!;
    const targetLaneId = first.targetLaneId ?? draft.execution?.targetLaneId ?? null;
    return {
      ...draft,
      execution: {
        kind: "agent-session",
        ...(targetLaneId ? { targetLaneId } : {}),
        session: { title: first.sessionTitle || null },
      },
      ...(first.modelConfig ? { modelConfig: { orchestratorModel: first.modelConfig } } : {}),
      ...(first.permissionConfig ? { permissionConfig: first.permissionConfig } : {}),
      prompt: first.prompt ?? "",
      actions: [],
      legacyActions: [],
    };
  }

  if (soloMission) {
    const first = rows[0]!;
    return {
      ...draft,
      execution: {
        kind: "mission",
        ...(draft.execution?.targetLaneId ? { targetLaneId: draft.execution.targetLaneId } : {}),
        mission: { title: first.missionTitle || null },
      },
      actions: [],
      legacyActions: [],
    };
  }

  // Otherwise treat the whole list as a built-in action pipeline (the ordered
  // list surface). Agent-session / mission rows collapse to the first non-built-in
  // entry being promoted to `execution`; the remaining rows store under `built-in`.
  const builtInActions: AutomationAction[] = rows.map((row) => rowToAutomationAction(row));
  const legacyDraftActions: AutomationRuleDraft["actions"] = builtInActions
    .map((action) => automationActionToDraftAction(action))
    .filter((entry): entry is AutomationRuleDraft["actions"][number] => entry != null);

  return {
    ...draft,
    execution: {
      kind: "built-in",
      ...(draft.execution?.targetLaneId ? { targetLaneId: draft.execution.targetLaneId } : {}),
      builtIn: { actions: builtInActions },
    },
    prompt: "",
    actions: legacyDraftActions,
    legacyActions: legacyDraftActions,
  };
}

function rowToAutomationAction(row: ActionRowValue): AutomationAction {
  switch (row.kind) {
    case "create-lane":
      return {
        type: "create-lane",
        ...(row.laneNameTemplate ? { laneNameTemplate: row.laneNameTemplate } : {}),
        ...(row.laneDescriptionTemplate ? { laneDescriptionTemplate: row.laneDescriptionTemplate } : {}),
        ...(row.parentLaneId ? { parentLaneId: row.parentLaneId } : {}),
      };
    case "run-tests":
      return { type: "run-tests", suiteId: row.suiteId ?? "" };
    case "run-command":
      return {
        type: "run-command",
        command: row.command ?? "",
        ...(row.cwd ? { cwd: row.cwd } : {}),
      };
    case "predict-conflicts":
      return { type: "predict-conflicts" };
    case "ade-action":
      return {
        type: "ade-action",
        adeAction: row.adeAction ?? { domain: "", action: "" },
      };
    case "agent-session":
      return {
        type: "agent-session",
        ...(row.targetLaneId ? { targetLaneId: row.targetLaneId } : {}),
        ...(row.modelConfig ? { modelConfig: row.modelConfig } : {}),
        ...(row.permissionConfig ? { permissionConfig: row.permissionConfig } : {}),
        ...(row.prompt ? { prompt: row.prompt } : {}),
        ...(row.sessionTitle ? { sessionTitle: row.sessionTitle } : {}),
      };
    case "launch-mission":
      return {
        type: "launch-mission",
        ...(row.missionTitle ? { sessionTitle: row.missionTitle } : {}),
      };
  }
}

function automationActionToDraftAction(
  action: AutomationAction,
): AutomationRuleDraft["actions"][number] | null {
  switch (action.type) {
    case "create-lane":
      return {
        type: "create-lane",
        ...(action.laneNameTemplate ? { laneNameTemplate: action.laneNameTemplate } : {}),
        ...(action.laneDescriptionTemplate ? { laneDescriptionTemplate: action.laneDescriptionTemplate } : {}),
        ...(action.parentLaneId ? { parentLaneId: action.parentLaneId } : {}),
      };
    case "run-tests":
      return { type: "run-tests", suite: action.suiteId ?? "" };
    case "run-command":
      return {
        type: "run-command",
        command: action.command ?? "",
        ...(action.cwd ? { cwd: action.cwd } : {}),
      };
    case "predict-conflicts":
      return { type: "predict-conflicts" };
    case "ade-action":
      return {
        type: "ade-action",
        adeAction: action.adeAction ?? { domain: "", action: "" },
      };
    case "agent-session":
      return {
        type: "agent-session",
        ...(action.targetLaneId ? { targetLaneId: action.targetLaneId } : {}),
        ...(action.modelConfig ? { modelConfig: action.modelConfig } : {}),
        ...(action.permissionConfig ? { permissionConfig: action.permissionConfig } : {}),
        ...(action.prompt ? { prompt: action.prompt } : {}),
        ...(action.sessionTitle ? { sessionTitle: action.sessionTitle } : {}),
      };
    case "launch-mission":
      return {
        type: "launch-mission",
        ...(action.sessionTitle ? { missionTitle: action.sessionTitle } : {}),
      };
  }
}

// --- component ---

export function RuleEditorPanel({
  draft,
  setDraft,
  lanes,
  suites,
  missionsEnabled: _missionsEnabled,
  issues,
  requiredConfirmations,
  acceptedConfirmations,
  onToggleConfirmation,
  onSave,
  onSimulate,
  saving,
  simulating = false,
}: {
  draft: AutomationRuleDraft;
  setDraft: (draft: AutomationRuleDraft) => void;
  lanes: Array<{ id: string; name: string }>;
  suites: TestSuiteDefinition[];
  missionsEnabled: boolean;
  issues: AutomationDraftIssue[];
  requiredConfirmations: AutomationDraftConfirmationRequirement[];
  acceptedConfirmations: Set<string>;
  onToggleConfirmation: (key: string, checked: boolean) => void;
  onSave: () => void;
  onSimulate?: () => void;
  saving: boolean;
  simulating?: boolean;
}) {
  const navigate = useNavigate();
  const openAiSettings = useCallback(() => navigate("/settings?tab=ai#ai-providers"), [navigate]);

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const primaryTrigger = ensurePrimaryTrigger(draft);
  const triggerFamily = triggerFamilyForType(primaryTrigger.type);
  const triggerOptions = TRIGGER_OPTIONS[triggerFamily];

  const actionRows = useMemo(() => draftToActionRows(draft), [draft]);
  const includeProjectContext = computeIncludeProjectContext(draft);
  const modelValue = draft.modelConfig?.orchestratorModel ?? { modelId: DEFAULT_MODEL_ID, thinkingLevel: "medium" as const };
  const permissionMeta = permissionControlsForModel(modelValue.modelId);
  const currentPermission = permissionMeta
    ? draft.permissionConfig?.providers?.[permissionMeta.key] ?? ""
    : "";

  const setPrimaryTrigger = (next: AutomationTrigger) => {
    setDraft({ ...draft, triggers: [next], trigger: next });
  };

  const patchTrigger = (patch: Partial<AutomationTrigger>) => {
    setPrimaryTrigger({ ...primaryTrigger, ...patch });
  };

  const setTriggerFamily = (family: TriggerFamily) => {
    setPrimaryTrigger(defaultTriggerForFamily(family));
  };

  const setActionRows = (rows: ActionRowValue[]) => {
    setDraft(applyActionRowsToDraft(draft, rows));
  };

  const patchExecutionLane = (targetLaneId: string | null) => {
    setDraft({
      ...draft,
      execution: {
        kind: draft.execution?.kind ?? "agent-session",
        ...(targetLaneId ? { targetLaneId } : {}),
        ...(draft.execution?.kind === "agent-session" && draft.execution.session ? { session: draft.execution.session } : {}),
        ...(draft.execution?.kind === "mission" && draft.execution.mission ? { mission: draft.execution.mission } : {}),
        ...(draft.execution?.kind === "built-in" && draft.execution.builtIn ? { builtIn: draft.execution.builtIn } : {}),
      },
    });
  };

  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-white/[0.06] px-5 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[15px] font-semibold text-[#F5FAFF]">
              {draft.id ? "Edit automation" : "New automation"}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Chip className="text-[9px]">{triggerLabel(primaryTrigger)}</Chip>
              <Chip className="text-[9px]">{actionRows.length} action{actionRows.length === 1 ? "" : "s"}</Chip>
              <Chip className="text-[9px]">{draft.enabled ? "enabled" : "disabled"}</Chip>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {onSimulate ? (
              <Button size="sm" variant="outline" disabled={simulating || saving} onClick={onSimulate}>
                <Flask size={12} weight="regular" className={cn(simulating && "animate-spin")} />
                Simulate
              </Button>
            ) : null}
            <Button size="sm" variant="primary" disabled={saving} onClick={onSave}>
              <FloppyDisk size={12} weight="regular" className={cn(saving && "animate-spin")} />
              Save
            </Button>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div className="mx-auto flex max-w-4xl flex-col gap-4">
          {errors.length ? <IssueList title="Errors" issues={errors} tone="error" /> : null}
          {warnings.length ? <IssueList title="Notes" issues={warnings} tone="warning" /> : null}
          <ConfirmationsChecklist
            required={requiredConfirmations}
            accepted={acceptedConfirmations}
            onToggle={onToggleConfirmation}
          />

          {/* Identity */}
          <section className="rounded-2xl p-4" style={CARD_STYLE}>
            <SectionHeader>Identity</SectionHeader>
            <div className="mt-3 space-y-3">
              <input
                className={INPUT_CLS}
                style={INPUT_STYLE}
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder="Automation name"
              />
              <textarea
                className="min-h-[72px] w-full rounded-md px-3 py-2 text-[12px] text-[#F5F7FA] placeholder:text-[#7E8A9A]"
                style={INPUT_STYLE}
                value={draft.description ?? ""}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                placeholder="What this automation is for"
              />
              <label className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-black/15 px-3 py-2 text-[12px] text-[#D8E3F2]">
                <span>Enabled</span>
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                  className="accent-[#7DD3FC]"
                />
              </label>
            </div>
          </section>

          {/* Trigger */}
          <section className="rounded-2xl p-4" style={CARD_STYLE}>
            <SectionHeader>Trigger</SectionHeader>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <label className="space-y-1 block">
                <span className="text-[10px] uppercase tracking-[1px] text-[#8FA1B8]">Source</span>
                <select
                  className={INPUT_CLS}
                  style={INPUT_STYLE}
                  value={triggerFamily}
                  onChange={(event) => setTriggerFamily(event.target.value as TriggerFamily)}
                >
                  {TRIGGER_FAMILIES.map((family) => (
                    <option key={family.value} value={family.value}>{family.label}</option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 block">
                <span className="text-[10px] uppercase tracking-[1px] text-[#8FA1B8]">Event</span>
                <select
                  className={INPUT_CLS}
                  style={INPUT_STYLE}
                  value={primaryTrigger.type}
                  onChange={(event) =>
                    setPrimaryTrigger({
                      ...defaultTriggerForFamily(triggerFamily),
                      type: event.target.value as AutomationTrigger["type"],
                    })
                  }
                >
                  {triggerOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="mt-3 rounded-xl border border-white/[0.08] bg-black/10 p-3">
              {primaryTrigger.type === "schedule" ? (
                <ScheduleFields trigger={primaryTrigger} onPatch={patchTrigger} />
              ) : triggerFamily === "github" ? (
                <GitHubTriggerFilters trigger={primaryTrigger} onPatch={patchTrigger} />
              ) : triggerFamily === "linear" ? (
                <LinearTriggerFilters trigger={primaryTrigger} onPatch={patchTrigger} />
              ) : triggerFamily === "local-git" ? (
                <LocalGitFields trigger={primaryTrigger} onPatch={patchTrigger} />
              ) : triggerFamily === "file-change" ? (
                <FileChangeFields trigger={primaryTrigger} onPatch={patchTrigger} />
              ) : triggerFamily === "lane" ? (
                <LaneFields trigger={primaryTrigger} onPatch={patchTrigger} />
              ) : triggerFamily === "session" ? (
                <div className="text-[11px] text-[#93A4B8]">Runs when an agent session ends.</div>
              ) : triggerFamily === "webhook" ? (
                <WebhookFields trigger={primaryTrigger} onPatch={patchTrigger} />
              ) : (
                <div className="text-[11px] text-[#93A4B8]">Runs only when you click Run now.</div>
              )}
            </div>
          </section>

          {/* Execution */}
          <section className="rounded-2xl p-4" style={CARD_STYLE}>
            <SectionHeader>Execution</SectionHeader>
            <div className="mt-3 grid gap-3 md:grid-cols-[1fr_1.25fr_1fr]">
              <label className="space-y-1 block">
                <span className="text-[10px] uppercase tracking-[1px] text-[#8FA1B8]">Lane</span>
                <select
                  className={INPUT_CLS}
                  style={INPUT_STYLE}
                  value={draft.execution?.targetLaneId ?? ""}
                  onChange={(event) => patchExecutionLane(event.target.value || null)}
                >
                  <option value="">Trigger or primary lane</option>
                  {lanes.map((lane) => (
                    <option key={lane.id} value={lane.id}>{lane.name}</option>
                  ))}
                </select>
              </label>

              <div className="space-y-1 min-w-0">
                <span className="text-[10px] uppercase tracking-[1px] text-[#8FA1B8]">Model</span>
                <ModelSelector
                  value={modelValue}
                  onChange={(next) =>
                    setDraft({
                      ...draft,
                      modelConfig: { orchestratorModel: next },
                    })
                  }
                  onOpenAiSettings={openAiSettings}
                />
              </div>

              <label className="space-y-1 block">
                <span className="text-[10px] uppercase tracking-[1px] text-[#8FA1B8]">
                  Permissions
                </span>
                <select
                  className={INPUT_CLS}
                  style={INPUT_STYLE}
                  value={currentPermission}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      permissionConfig: patchPermissionConfig(draft.permissionConfig, modelValue.modelId, event.target.value),
                    })
                  }
                  disabled={!permissionMeta}
                >
                  <option value="">Default permissions</option>
                  {permissionMeta?.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </section>

          {/* What to do */}
          <section className="rounded-2xl p-4" style={CARD_STYLE}>
            <SectionHeader>What to do</SectionHeader>
            <div className="mt-3">
              <ActionList
                actions={actionRows}
                lanes={lanes}
                suites={suites}
                fallbackModel={modelValue}
                onChange={setActionRows}
                onOpenAiSettings={openAiSettings}
              />
            </div>
          </section>

          {/* Advanced */}
          <section className="rounded-2xl p-4" style={CARD_STYLE}>
            <button
              type="button"
              onClick={() => setAdvancedOpen((open) => !open)}
              className="flex w-full items-center justify-between text-left"
            >
              <SectionHeader>Advanced</SectionHeader>
              {advancedOpen ? (
                <CaretDown size={12} weight="bold" className="text-[#8FA1B8]" />
              ) : (
                <CaretRight size={12} weight="bold" className="text-[#8FA1B8]" />
              )}
            </button>

            {advancedOpen ? (
              <div className="mt-3 space-y-3">
                <label className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-black/15 px-3 py-2 text-[12px] text-[#D8E3F2]">
                  <span>
                    Include project context
                    <span className="ml-2 text-[10px] text-[#7E8A9A]">memory + procedures</span>
                  </span>
                  <input
                    type="checkbox"
                    checked={includeProjectContext}
                    onChange={(event) => {
                      const next = event.target.checked;
                      setDraft({
                        ...draft,
                        includeProjectContext: next,
                        memory: { mode: next ? "automation-plus-project" : "none" },
                        contextSources: next
                          ? (draft.contextSources?.length ? draft.contextSources : [{ type: "project-memory" }])
                          : [],
                      });
                    }}
                    className="accent-[#7DD3FC]"
                  />
                </label>

                <div className="grid gap-2 md:grid-cols-2">
                  <LabeledNumber
                    label="Max duration (min)"
                    value={draft.guardrails.maxDurationMin ?? null}
                    onChange={(n) =>
                      setDraft({
                        ...draft,
                        guardrails: { ...draft.guardrails, maxDurationMin: n ?? undefined },
                      })
                    }
                    placeholder="20"
                  />
                  <ActiveHoursFields
                    hours={primaryTrigger.activeHours ?? null}
                    onChange={(next) => patchTrigger({ activeHours: next ?? undefined })}
                  />
                </div>

                <div className="rounded-lg border border-[#35506B] bg-[#122234] px-3 py-2 text-[11px] text-[#9FB2C7]">
                  Budget and usage caps live in Settings &gt; Usage. Every rule reads the shared policy.
                </div>
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}

// --- helpers ---

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-semibold uppercase tracking-[1px] text-[#8FA1B8]">
      {children}
    </div>
  );
}

function IssueList({
  title,
  issues,
  tone,
}: {
  title: string;
  issues: AutomationDraftIssue[];
  tone: "error" | "warning";
}) {
  return (
    <div
      className={cn(
        "rounded-lg px-3 py-2 text-[11px]",
        tone === "error" ? "border border-red-500/30 bg-red-500/10 text-red-200" : "border border-amber-500/25 bg-amber-500/10 text-amber-200",
      )}
    >
      <div className="font-semibold">{title}</div>
      <ul className="mt-1 space-y-0.5">
        {issues.map((issue, index) => (
          <li key={`${issue.path}-${index}`}>
            <span className="font-mono text-[10px] text-[#D8E3F2]">{issue.path}</span>: {issue.message}
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
    <div className="rounded-2xl p-3" style={CARD_STYLE}>
      <div className="text-[12px] font-semibold text-[#F5FAFF]">Confirm before saving</div>
      <div className="mt-2 space-y-2">
        {required.map((requirement) => (
          <label key={requirement.key} className="flex items-start gap-2 text-[11px] text-[#D8E3F2]">
            <input
              type="checkbox"
              checked={accepted.has(requirement.key)}
              onChange={(event) => onToggle(requirement.key, event.target.checked)}
              className="mt-0.5 accent-[#7DD3FC]"
            />
            <span>
              <span className={cn("font-semibold", requirement.severity === "danger" ? "text-red-200" : "text-amber-200")}>
                {requirement.title}
              </span>
              {" · "}
              {requirement.message}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

function ScheduleFields({
  trigger,
  onPatch,
}: {
  trigger: AutomationTrigger;
  onPatch: (patch: Partial<AutomationTrigger>) => void;
}) {
  const selectedPreset = SCHEDULE_PRESETS.find((preset) => preset.cron === trigger.cron)?.cron ?? "";
  return (
    <div className="grid gap-2 md:grid-cols-2">
      <label className="space-y-1 block">
        <span className="text-[10px] uppercase tracking-[1px] text-[#8FA1B8]">Preset</span>
        <select
          className={INPUT_CLS}
          style={INPUT_STYLE}
          value={selectedPreset}
          onChange={(event) => onPatch({ cron: event.target.value || trigger.cron || "" })}
        >
          <option value="">Custom</option>
          {SCHEDULE_PRESETS.map((preset) => (
            <option key={preset.cron} value={preset.cron}>{preset.label}</option>
          ))}
        </select>
      </label>
      <label className="space-y-1 block">
        <span className="text-[10px] uppercase tracking-[1px] text-[#8FA1B8]">Cron</span>
        <input
          className={INPUT_CLS}
          style={INPUT_STYLE}
          value={trigger.cron ?? ""}
          onChange={(event) => onPatch({ cron: event.target.value })}
          placeholder="0 9 * * 1-5"
        />
      </label>
    </div>
  );
}

function LocalGitFields({
  trigger,
  onPatch,
}: {
  trigger: AutomationTrigger;
  onPatch: (patch: Partial<AutomationTrigger>) => void;
}) {
  return (
    <label className="space-y-1 block">
      <span className="text-[10px] uppercase tracking-[1px] text-[#8FA1B8]">Branch</span>
      <input
        className={INPUT_CLS}
        style={INPUT_STYLE}
        value={trigger.branch ?? ""}
        onChange={(event) => onPatch({ branch: event.target.value })}
        placeholder="main"
      />
    </label>
  );
}

function FileChangeFields({
  trigger,
  onPatch,
}: {
  trigger: AutomationTrigger;
  onPatch: (patch: Partial<AutomationTrigger>) => void;
}) {
  return (
    <label className="space-y-1 block">
      <span className="text-[10px] uppercase tracking-[1px] text-[#8FA1B8]">Paths (comma separated globs)</span>
      <input
        className={INPUT_CLS}
        style={INPUT_STYLE}
        value={(trigger.paths ?? []).join(", ")}
        onChange={(event) =>
          onPatch({
            paths: event.target.value
              .split(",")
              .map((p) => p.trim())
              .filter(Boolean),
          })
        }
        placeholder="src/**, apps/**"
      />
    </label>
  );
}

function LaneFields({
  trigger,
  onPatch,
}: {
  trigger: AutomationTrigger;
  onPatch: (patch: Partial<AutomationTrigger>) => void;
}) {
  return (
    <label className="space-y-1 block">
      <span className="text-[10px] uppercase tracking-[1px] text-[#8FA1B8]">Name pattern</span>
      <input
        className={INPUT_CLS}
        style={INPUT_STYLE}
        value={trigger.namePattern ?? ""}
        onChange={(event) => onPatch({ namePattern: event.target.value })}
        placeholder="feature/*"
      />
    </label>
  );
}

function WebhookFields({
  trigger,
  onPatch,
}: {
  trigger: AutomationTrigger;
  onPatch: (patch: Partial<AutomationTrigger>) => void;
}) {
  return (
    <div className="grid gap-2 md:grid-cols-2">
      <label className="space-y-1 block">
        <span className="text-[10px] uppercase tracking-[1px] text-[#8FA1B8]">Event name</span>
        <input
          className={INPUT_CLS}
          style={INPUT_STYLE}
          value={trigger.event ?? ""}
          onChange={(event) => onPatch({ event: event.target.value })}
          placeholder="pull_request"
        />
      </label>
      <label className="space-y-1 block">
        <span className="text-[10px] uppercase tracking-[1px] text-[#8FA1B8]">Secret ref</span>
        <input
          className={INPUT_CLS}
          style={INPUT_STYLE}
          value={trigger.secretRef ?? ""}
          onChange={(event) => onPatch({ secretRef: event.target.value })}
          placeholder="github-webhook"
        />
      </label>
    </div>
  );
}

function LabeledNumber({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: number | null;
  placeholder?: string;
  onChange: (next: number | null) => void;
}) {
  return (
    <label className="space-y-1 block">
      <span className="text-[10px] uppercase tracking-[1px] text-[#8FA1B8]">{label}</span>
      <input
        className={INPUT_CLS}
        style={INPUT_STYLE}
        type="number"
        min={0}
        value={value ?? ""}
        onChange={(event) => {
          const raw = event.target.value.trim();
          if (!raw) {
            onChange(null);
            return;
          }
          const parsed = Number(raw);
          onChange(Number.isFinite(parsed) ? parsed : null);
        }}
        placeholder={placeholder}
      />
    </label>
  );
}

function ActiveHoursFields({
  hours,
  onChange,
}: {
  hours: { start: string; end: string; timezone: string } | null;
  onChange: (next: { start: string; end: string; timezone: string } | null) => void;
}) {
  const enabled = !!hours;
  return (
    <div className="space-y-1">
      <label className="flex items-center justify-between text-[10px] uppercase tracking-[1px] text-[#8FA1B8]">
        <span>Active hours</span>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) =>
            onChange(
              event.target.checked
                ? hours ?? { start: "09:00", end: "18:00", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
                : null,
            )
          }
          className="accent-[#7DD3FC]"
        />
      </label>
      {enabled && hours ? (
        <div className="grid grid-cols-2 gap-2">
          <input
            className={INPUT_CLS}
            style={INPUT_STYLE}
            value={hours.start}
            onChange={(event) => onChange({ ...hours, start: event.target.value })}
            placeholder="09:00"
          />
          <input
            className={INPUT_CLS}
            style={INPUT_STYLE}
            value={hours.end}
            onChange={(event) => onChange({ ...hours, end: event.target.value })}
            placeholder="18:00"
          />
        </div>
      ) : null}
    </div>
  );
}

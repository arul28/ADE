import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  FloppyDisk,
  Flask,
  Lightning,
  Plus,
  Rocket,
  TerminalWindow,
  Trash,
} from "@phosphor-icons/react";
import { getDefaultModelDescriptor } from "../../../../shared/modelRegistry";
import type {
  AutomationAction,
  AutomationDraftConfirmationRequirement,
  AutomationDraftIssue,
  AutomationExecution,
  AutomationRuleDraft,
  AutomationTrigger,
  MissionPermissionConfig,
  TestSuiteDefinition,
} from "../../../../shared/types";
import { ModelSelector } from "../../missions/ModelSelector";
import { WorkerPermissionsEditor } from "../../missions/WorkerPermissionsEditor";
import { Button } from "../../ui/Button";
import { Chip } from "../../ui/Chip";
import { cn } from "../../ui/cn";
import { CARD_STYLE, INPUT_CLS, INPUT_STYLE } from "../shared";

const DEFAULT_MODEL_ID =
  getDefaultModelDescriptor("opencode")?.id
  ?? getDefaultModelDescriptor("claude")?.id
  ?? "anthropic/claude-sonnet-4-6";

const DEFAULT_PERMISSION_CONFIG: MissionPermissionConfig = {
  providers: {
    claude: "full-auto",
    codex: "default",
    opencode: "full-auto",
    codexSandbox: "workspace-write",
  },
};

const SCHEDULE_PRESETS = [
  { label: "Weekdays at 9:00 AM", cron: "0 9 * * 1-5" },
  { label: "Every day at 9:00 AM", cron: "0 9 * * *" },
  { label: "Every day at 2:00 AM", cron: "0 2 * * *" },
  { label: "Fridays at 4:00 PM", cron: "0 16 * * 5" },
];

const EXECUTION_OPTIONS: Array<{
  value: AutomationExecution["kind"];
  label: string;
  description: string;
  accent: string;
}> = [
  {
    value: "agent-session",
    label: "Agent session",
    description: "Send the prompt to an automation-only chat thread. The thread stays in Automations history and never clutters Work.",
    accent: "#38BDF8",
  },
  {
    value: "mission",
    label: "Mission",
    description: "Launch a mission run with mission tooling, model selection, and permissions. Open the run later from Missions.",
    accent: "#22C55E",
  },
  {
    value: "built-in",
    label: "Built-in task",
    description: "Run deterministic ADE tasks like test suites, shell commands, or conflict prediction without creating a chat thread.",
    accent: "#F59E0B",
  },
];

const MODE_OPTIONS: Array<{ value: AutomationRuleDraft["mode"]; label: string }> = [
  { value: "review", label: "Review" },
  { value: "fix", label: "Fix" },
  { value: "monitor", label: "Monitor" },
];

const REVIEW_PROFILE_OPTIONS: Array<{ value: AutomationRuleDraft["reviewProfile"]; label: string }> = [
  { value: "quick", label: "Quick" },
  { value: "incremental", label: "Incremental" },
  { value: "full", label: "Full" },
  { value: "security", label: "Security" },
  { value: "release-risk", label: "Release risk" },
  { value: "cross-repo-contract", label: "Cross-repo contract" },
];

const TOOL_OPTIONS: Array<{ value: AutomationRuleDraft["toolPalette"][number]; label: string }> = [
  { value: "repo", label: "Repo files" },
  { value: "git", label: "Git" },
  { value: "tests", label: "Tests" },
  { value: "github", label: "GitHub" },
  { value: "linear", label: "Linear" },
  { value: "browser", label: "Browser" },
  { value: "memory", label: "Memory" },
  { value: "mission", label: "Mission" },
];

const CONTEXT_OPTIONS: Array<{ value: AutomationRuleDraft["contextSources"][number]["type"]; label: string }> = [
  { value: "project-memory", label: "Project memory" },
  { value: "automation-memory", label: "Automation history" },
  { value: "worker-memory", label: "Worker memory" },
  { value: "procedures", label: "Procedures" },
  { value: "skills", label: "Skills" },
  { value: "linked-doc", label: "Linked docs" },
  { value: "linked-repo", label: "Linked repos" },
  { value: "path-rules", label: "Path rules" },
];

type TriggerFamily = "manual" | "schedule" | "github" | "linear" | "ade" | "webhook";

const TRIGGER_FAMILIES: Array<{ value: TriggerFamily; label: string; description: string }> = [
  { value: "manual", label: "Manual only", description: "Use Run now when you want this rule on demand only." },
  { value: "schedule", label: "Scheduled time", description: "Run at a specific recurring time." },
  { value: "github", label: "GitHub action", description: "Run when a Git or PR event happens." },
  { value: "linear", label: "Linear action", description: "Run when a Linear issue event happens." },
  { value: "ade", label: "ADE action", description: "Run on ADE-native events like session end or lane changes." },
  { value: "webhook", label: "Webhook", description: "Run from GitHub relay or a custom webhook." },
];

const TRIGGER_OPTIONS: Record<TriggerFamily, Array<{ value: AutomationTrigger["type"]; label: string }>> = {
  manual: [{ value: "manual", label: "Run on click only" }],
  schedule: [{ value: "schedule", label: "Cron schedule" }],
  github: [
    { value: "git.commit", label: "Commit created" },
    { value: "git.push", label: "Push completed" },
    { value: "git.pr_opened", label: "PR opened" },
    { value: "git.pr_updated", label: "PR updated" },
    { value: "git.pr_merged", label: "PR merged" },
    { value: "git.pr_closed", label: "PR closed" },
  ],
  linear: [
    { value: "linear.issue_created", label: "Issue created" },
    { value: "linear.issue_updated", label: "Issue updated" },
    { value: "linear.issue_assigned", label: "Issue assigned" },
    { value: "linear.issue_status_changed", label: "Status changed" },
  ],
  ade: [
    { value: "session-end", label: "Session ended" },
    { value: "file.change", label: "Files changed" },
    { value: "lane.created", label: "Lane created" },
    { value: "lane.archived", label: "Lane archived" },
  ],
  webhook: [
    { value: "github-webhook", label: "GitHub relay webhook" },
    { value: "webhook", label: "Custom webhook" },
  ],
};

function sectionLabel(text: string) {
  return (
    <div className="font-mono text-[10px] font-bold uppercase tracking-[1px] text-[#8FA1B8]">
      {text}
    </div>
  );
}

function ensurePrimaryTrigger(draft: AutomationRuleDraft): AutomationTrigger {
  return draft.triggers[0] ?? draft.trigger ?? { type: "manual" };
}

function triggerFamilyForType(type: AutomationTrigger["type"]): TriggerFamily {
  if (type === "schedule") return "schedule";
  if (
    type === "git.commit" ||
    type === "git.push" ||
    type === "git.pr_opened" ||
    type === "git.pr_updated" ||
    type === "git.pr_merged" ||
    type === "git.pr_closed"
  ) {
    return "github";
  }
  if (
    type === "linear.issue_created" ||
    type === "linear.issue_updated" ||
    type === "linear.issue_assigned" ||
    type === "linear.issue_status_changed"
  ) {
    return "linear";
  }
  if (type === "github-webhook" || type === "webhook") return "webhook";
  if (type === "manual") return "manual";
  return "ade";
}

function defaultTriggerForFamily(family: TriggerFamily): AutomationTrigger {
  switch (family) {
    case "schedule":
      return { type: "schedule", cron: "0 9 * * 1-5" };
    case "github":
      return { type: "git.pr_opened" };
    case "linear":
      return { type: "linear.issue_created" };
    case "ade":
      return { type: "session-end" };
    case "webhook":
      return { type: "github-webhook", event: "pull_request", secretRef: "github-webhook" };
    default:
      return { type: "manual" };
  }
}

function labelForTrigger(trigger: AutomationTrigger): string {
  if (trigger.type === "schedule") {
    return trigger.cron?.trim() ? `schedule · ${trigger.cron}` : "schedule";
  }
  if (trigger.type === "git.pr_merged" && trigger.targetBranch?.trim()) {
    return `${trigger.type} · ${trigger.targetBranch.trim()}`;
  }
  if ((trigger.branch ?? "").trim()) return `${trigger.type} · ${trigger.branch!.trim()}`;
  if ((trigger.team ?? "").trim()) return `${trigger.type} · ${trigger.team!.trim()}`;
  if ((trigger.project ?? "").trim()) return `${trigger.type} · ${trigger.project!.trim()}`;
  return trigger.type;
}

function selectedSchedulePreset(cron?: string): string {
  return SCHEDULE_PRESETS.find((preset) => preset.cron === cron)?.cron ?? "";
}

function joinList(values: string[] | undefined): string {
  return Array.isArray(values) ? values.join(", ") : "";
}

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function draftActionFromBuiltIn(action: AutomationAction): AutomationRuleDraft["actions"][number] {
  if (action.type === "run-tests") {
    return { type: "run-tests", suite: action.suiteId ?? "" } as any;
  }
  if (action.type === "run-command") {
    return { type: "run-command", command: action.command ?? "", ...(action.cwd ? { cwd: action.cwd } : {}) } as any;
  }
  return { type: action.type } as any;
}

function builtInActionSummary(action: AutomationAction): string {
  if (action.type === "run-tests") return "Run test suite";
  if (action.type === "run-command") return "Run shell command";
  if (action.type === "predict-conflicts") return "Predict conflicts";
  return action.type;
}

function IssueList({ issues }: { issues: AutomationDraftIssue[] }) {
  if (!issues.length) return null;
  return (
    <div className="space-y-2">
      {issues.map((issue, index) => (
        <div
          key={`${issue.path}-${index}`}
          className={cn("rounded-lg px-3 py-2 text-xs", issue.level === "error" ? "text-red-200" : "text-amber-200")}
          style={{ background: issue.level === "error" ? "rgba(239,68,68,0.12)" : "rgba(245,158,11,0.12)" }}
        >
          <span className="font-mono">{issue.path}</span>: {issue.message}
        </div>
      ))}
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
    <div className="space-y-2 rounded-xl p-3" style={CARD_STYLE}>
      <div className="text-sm font-semibold text-[#F5FAFF]">Before saving</div>
      {required.map((requirement) => (
        <label key={requirement.key} className="flex items-start gap-2 text-xs text-[#D8E3F2]">
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
  );
}

export function RuleEditorPanel({
  draft,
  setDraft,
  lanes,
  suites,
  missionsEnabled,
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
  const openAiProvidersSettings = useCallback(() => {
    navigate("/settings?tab=ai#ai-providers");
  }, [navigate]);
  const primaryTrigger = ensurePrimaryTrigger(draft);
  const triggerFamily = triggerFamilyForType(primaryTrigger.type);
  const executionKind = draft.execution?.kind ?? "agent-session";
  const builtInActions = executionKind === "built-in" ? draft.execution?.builtIn?.actions ?? [] : [];
  const activeExecutionOption = EXECUTION_OPTIONS.find((option) => option.value === executionKind) ?? EXECUTION_OPTIONS[0]!;
  const modelValue = draft.modelConfig?.orchestratorModel ?? { modelId: DEFAULT_MODEL_ID, thinkingLevel: "medium" as const };
  const permissionConfig = draft.permissionConfig ?? DEFAULT_PERMISSION_CONFIG;
  const selectedLaneId = draft.execution?.targetLaneId ?? "";
  const triggerOptions = TRIGGER_OPTIONS[triggerFamily];
  const selectedPreset = selectedSchedulePreset(primaryTrigger.cron);
  const missionExecutionUnavailable = executionKind === "mission" && !missionsEnabled;

  const setPrimaryTrigger = (next: AutomationTrigger) => {
    setDraft({
      ...draft,
      triggers: [next],
      trigger: next,
    });
  };

  const setTriggerPatch = (patch: Partial<AutomationTrigger>) => {
    setPrimaryTrigger({ ...primaryTrigger, ...patch });
  };

  const setTriggerFamily = (family: TriggerFamily) => {
    setPrimaryTrigger(defaultTriggerForFamily(family));
  };

  const syncBuiltInActions = (nextActions: AutomationAction[]) => {
    const nextDraftActions = nextActions.map(draftActionFromBuiltIn) as AutomationRuleDraft["actions"];
    setDraft({
      ...draft,
      execution: {
        kind: "built-in",
        ...(draft.execution?.targetLaneId ? { targetLaneId: draft.execution.targetLaneId } : {}),
        builtIn: { actions: nextActions },
      },
      actions: nextDraftActions,
      legacyActions: nextDraftActions,
      prompt: "",
    });
  };

  const addBuiltInAction = (type: AutomationAction["type"]) => {
    const next = [...builtInActions];
    if (type === "run-tests") {
      next.push({ type: "run-tests", suiteId: suites[0]?.id ?? "" });
    } else if (type === "run-command") {
      next.push({ type: "run-command", command: "" });
    } else {
      next.push({ type });
    }
    syncBuiltInActions(next);
  };

  const updateBuiltInAction = (index: number, patch: Partial<AutomationAction>) => {
    const next = builtInActions.map((action, actionIndex) => (actionIndex === index ? { ...action, ...patch } : action));
    syncBuiltInActions(next);
  };

  const removeBuiltInAction = (index: number) => {
    syncBuiltInActions(builtInActions.filter((_, actionIndex) => actionIndex !== index));
  };

  const selectExecutionKind = (kind: AutomationExecution["kind"]) => {
    if (kind === "mission" && !missionsEnabled) return;
    if (kind === "built-in") {
      syncBuiltInActions(builtInActions.length ? builtInActions : [{ type: "run-tests", suiteId: suites[0]?.id ?? "" }]);
      return;
    }
    setDraft({
      ...draft,
      execution: {
        kind,
        ...(draft.execution?.targetLaneId ? { targetLaneId: draft.execution.targetLaneId } : {}),
        ...(kind === "agent-session"
          ? { session: { ...(draft.execution?.session ?? {}) } }
          : { mission: { ...(draft.execution?.mission ?? {}) } }),
      },
      actions: [],
      legacyActions: [],
    });
  };

  const toggleTool = (tool: AutomationRuleDraft["toolPalette"][number], enabled: boolean) => {
    const next = enabled
      ? [...new Set([...draft.toolPalette, tool])]
      : draft.toolPalette.filter((entry) => entry !== tool);
    setDraft({ ...draft, toolPalette: next });
  };

  const toggleContext = (type: AutomationRuleDraft["contextSources"][number]["type"], enabled: boolean) => {
    const next = enabled
      ? [...draft.contextSources, { type }].filter((entry, index, list) => list.findIndex((candidate) => candidate.type === entry.type) === index)
      : draft.contextSources.filter((entry) => entry.type !== type);
    setDraft({ ...draft, contextSources: next });
  };

  const advancedSummary = useMemo(() => {
    return [
      draft.mode,
      draft.reviewProfile,
      draft.guardrails.maxDurationMin ? `${draft.guardrails.maxDurationMin} min max` : null,
    ].filter(Boolean).join(" · ");
  }, [draft.guardrails.maxDurationMin, draft.mode, draft.reviewProfile]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-white/[0.06] px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[16px] font-semibold text-[#F5FAFF]">
              {draft.id ? "Edit automation" : "New automation"}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Chip className="text-[9px]">{labelForTrigger(primaryTrigger)}</Chip>
              <Chip className="text-[9px]">{activeExecutionOption.label}</Chip>
              {advancedSummary ? <Chip className="text-[9px]">{advancedSummary}</Chip> : null}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {onSimulate ? (
              <Button size="sm" variant="outline" disabled={simulating || saving} onClick={onSimulate}>
                <Flask size={12} weight="regular" className={cn(simulating && "animate-spin")} />
                Simulate
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="primary"
              disabled={saving || missionExecutionUnavailable}
              title={missionExecutionUnavailable ? "Mission automations are coming soon in production builds." : undefined}
              onClick={onSave}
            >
              <FloppyDisk size={12} weight="regular" className={cn(saving && "animate-spin")} />
              Save rule
            </Button>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div className="mx-auto flex max-w-5xl flex-col gap-5">
          <section className="grid gap-4 md:grid-cols-[1.2fr_0.8fr]">
            <div className="space-y-3 rounded-2xl p-4" style={CARD_STYLE}>
              {sectionLabel("Basics")}
              <div className="space-y-3">
                <input
                  className={INPUT_CLS}
                  style={INPUT_STYLE}
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  placeholder="Automation name"
                />
                <textarea
                  className="min-h-[96px] w-full rounded-md px-3 py-2 text-xs text-[#F5F7FA] placeholder:text-[#7E8A9A] font-mono"
                  style={INPUT_STYLE}
                  value={draft.description ?? ""}
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                  placeholder="What this automation is for"
                />
              </div>
            </div>

            <div className="space-y-3 rounded-2xl p-4" style={CARD_STYLE}>
              {sectionLabel("State")}
              <label className="flex items-center justify-between rounded-xl border border-white/[0.08] bg-black/15 px-3 py-2 text-xs text-[#D8E3F2]">
                <span>Enabled</span>
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                  className="accent-[#7DD3FC]"
                />
              </label>
              <div className="rounded-xl border border-[#35506B] bg-[#122234] px-3 py-3 text-xs text-[#9FB2C7]">
                Usage caps live in Settings &gt; Usage. Every automation reads the same shared budget policy.
              </div>
              <input
                className={INPUT_CLS}
                style={INPUT_STYLE}
                value={draft.billingCode}
                onChange={(event) => setDraft({ ...draft, billingCode: event.target.value })}
                placeholder="Billing code"
              />
            </div>
          </section>

          <section data-tour="automations.triggersList" className="rounded-2xl p-4" style={CARD_STYLE}>
            {sectionLabel("When it runs")}
            <div className="mt-3 grid gap-3 lg:grid-cols-[280px_1fr]">
              <div className="space-y-2">
                {TRIGGER_FAMILIES.map((family) => (
                  <button
                    key={family.value}
                    type="button"
                    onClick={() => setTriggerFamily(family.value)}
                    className={cn(
                      "w-full rounded-xl border px-3 py-3 text-left transition-colors",
                      triggerFamily === family.value
                        ? "border-[#7DD3FC]/50 bg-[#102032] text-[#F5FAFF]"
                        : "border-white/[0.08] bg-black/15 text-[#B9C7D7] hover:border-white/[0.14]",
                    )}
                  >
                    <div className="text-xs font-semibold">{family.label}</div>
                    <div className="mt-1 text-[11px] text-[#8FA1B8]">{family.description}</div>
                  </button>
                ))}
              </div>

              <div className="space-y-3 rounded-xl border border-white/[0.08] bg-black/15 p-4">
                <select
                  className={INPUT_CLS}
                  style={INPUT_STYLE}
                  value={primaryTrigger.type}
                  onChange={(event) => setPrimaryTrigger({ ...defaultTriggerForFamily(triggerFamily), type: event.target.value as AutomationTrigger["type"] })}
                >
                  {triggerOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>

                {primaryTrigger.type === "schedule" ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-2">
                      <div className="text-[11px] text-[#8FA1B8]">Preset</div>
                      <select
                        className={INPUT_CLS}
                        style={INPUT_STYLE}
                        value={selectedPreset}
                        onChange={(event) => setTriggerPatch({ cron: event.target.value || primaryTrigger.cron || "" })}
                      >
                        <option value="">Custom cron</option>
                        {SCHEDULE_PRESETS.map((preset) => (
                          <option key={preset.cron} value={preset.cron}>{preset.label}</option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-2">
                      <div className="text-[11px] text-[#8FA1B8]">Cron</div>
                      <input
                        className={INPUT_CLS}
                        style={INPUT_STYLE}
                        value={primaryTrigger.cron ?? ""}
                        onChange={(event) => setTriggerPatch({ cron: event.target.value })}
                        placeholder="0 9 * * 1-5"
                      />
                    </div>
                  </div>
                ) : null}

                {(primaryTrigger.type === "git.commit" || primaryTrigger.type === "git.push" || primaryTrigger.type.startsWith("git.pr_")) ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    <input
                      className={INPUT_CLS}
                      style={INPUT_STYLE}
                      value={primaryTrigger.type === "git.pr_merged" ? primaryTrigger.targetBranch ?? "" : primaryTrigger.branch ?? ""}
                      onChange={(event) => setTriggerPatch(primaryTrigger.type === "git.pr_merged" ? { targetBranch: event.target.value } : { branch: event.target.value })}
                      placeholder={primaryTrigger.type === "git.pr_merged" ? "Target branch filter" : "Branch filter"}
                    />
                    <input
                      className={INPUT_CLS}
                      style={INPUT_STYLE}
                      value={primaryTrigger.author ?? ""}
                      onChange={(event) => setTriggerPatch({ author: event.target.value })}
                      placeholder="Author filter"
                    />
                    <input
                      className={INPUT_CLS}
                      style={INPUT_STYLE}
                      value={joinList(primaryTrigger.labels)}
                      onChange={(event) => setTriggerPatch({ labels: parseList(event.target.value) })}
                      placeholder="Labels (comma separated)"
                    />
                    <input
                      className={INPUT_CLS}
                      style={INPUT_STYLE}
                      value={joinList(primaryTrigger.paths)}
                      onChange={(event) => setTriggerPatch({ paths: parseList(event.target.value) })}
                      placeholder="Paths (comma separated)"
                    />
                  </div>
                ) : null}

                {(primaryTrigger.type === "linear.issue_created"
                  || primaryTrigger.type === "linear.issue_updated"
                  || primaryTrigger.type === "linear.issue_assigned"
                  || primaryTrigger.type === "linear.issue_status_changed") ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    <input
                      className={INPUT_CLS}
                      style={INPUT_STYLE}
                      value={primaryTrigger.team ?? ""}
                      onChange={(event) => setTriggerPatch({ team: event.target.value })}
                      placeholder="Team filter"
                    />
                    <input
                      className={INPUT_CLS}
                      style={INPUT_STYLE}
                      value={primaryTrigger.project ?? ""}
                      onChange={(event) => setTriggerPatch({ project: event.target.value })}
                      placeholder="Project filter"
                    />
                    <input
                      className={INPUT_CLS}
                      style={INPUT_STYLE}
                      value={primaryTrigger.assignee ?? ""}
                      onChange={(event) => setTriggerPatch({ assignee: event.target.value })}
                      placeholder="Assignee filter"
                    />
                    <input
                      className={INPUT_CLS}
                      style={INPUT_STYLE}
                      value={primaryTrigger.stateTransition ?? ""}
                      onChange={(event) => setTriggerPatch({ stateTransition: event.target.value })}
                      placeholder="State transition"
                    />
                  </div>
                ) : null}

                {primaryTrigger.type === "file.change" ? (
                  <input
                    className={INPUT_CLS}
                    style={INPUT_STYLE}
                    value={joinList(primaryTrigger.paths)}
                    onChange={(event) => setTriggerPatch({ paths: parseList(event.target.value) })}
                    placeholder="Paths (comma separated)"
                  />
                ) : null}

                {(primaryTrigger.type === "lane.created" || primaryTrigger.type === "lane.archived") ? (
                  <input
                    className={INPUT_CLS}
                    style={INPUT_STYLE}
                    value={primaryTrigger.namePattern ?? ""}
                    onChange={(event) => setTriggerPatch({ namePattern: event.target.value })}
                    placeholder="Lane name pattern"
                  />
                ) : null}

                {(primaryTrigger.type === "github-webhook" || primaryTrigger.type === "webhook") ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    <input
                      className={INPUT_CLS}
                      style={INPUT_STYLE}
                      value={primaryTrigger.event ?? ""}
                      onChange={(event) => setTriggerPatch({ event: event.target.value })}
                      placeholder="Event name"
                    />
                    <input
                      className={INPUT_CLS}
                      style={INPUT_STYLE}
                      value={primaryTrigger.secretRef ?? ""}
                      onChange={(event) => setTriggerPatch({ secretRef: event.target.value })}
                      placeholder="Secret reference"
                    />
                  </div>
                ) : null}
              </div>
            </div>
          </section>

          <section data-tour="automations.actionsList" className="rounded-2xl p-4" style={CARD_STYLE}>
            {sectionLabel("What it does")}
            <div className="mt-3 grid gap-3 lg:grid-cols-3">
              {EXECUTION_OPTIONS.map((option) => {
                const Icon = option.value === "agent-session"
                  ? Lightning
                  : option.value === "mission"
                    ? Rocket
                    : TerminalWindow;
                const disabled = option.value === "mission" && !missionsEnabled;
                return (
                  <button
                    key={option.value}
                    type="button"
                    disabled={disabled}
                    onClick={() => selectExecutionKind(option.value)}
                    className={cn(
                      "rounded-xl border px-4 py-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45",
                      executionKind === option.value
                        ? "border-white/[0.16] bg-black/10"
                        : "border-white/[0.08] bg-black/15 hover:border-white/[0.14]",
                    )}
                    style={executionKind === option.value ? { boxShadow: `0 0 0 1px ${option.accent}35 inset` } : undefined}
                  >
                    <div className="flex items-center gap-2">
                      <Icon size={15} weight="regular" style={{ color: option.accent }} />
                      <div className="text-sm font-semibold text-[#F5FAFF]">{option.label}</div>
                      {disabled ? <Chip className="text-[8px]">Coming soon</Chip> : null}
                    </div>
                    <div className="mt-2 text-xs leading-relaxed text-[#9FB2C7]">
                      {disabled
                        ? "Mission automations are paused in production builds until Missions is ready."
                        : option.description}
                    </div>
                  </button>
                );
              })}
            </div>

            {executionKind === "built-in" ? (
              <div className="mt-4 space-y-3 rounded-xl border border-white/[0.08] bg-black/15 p-4">
                <div className="grid gap-2 md:grid-cols-[180px_1fr] md:items-center">
                  <div className="text-[11px] text-[#8FA1B8]">Target lane</div>
                  <select
                    className={INPUT_CLS}
                    style={INPUT_STYLE}
                    value={selectedLaneId}
                    onChange={(event) => setDraft({
                      ...draft,
                      execution: {
                        kind: "built-in",
                        builtIn: { actions: builtInActions },
                        targetLaneId: event.target.value || null,
                      },
                    })}
                  >
                    <option value="">Auto-select from the trigger or primary lane</option>
                    {lanes.map((lane) => (
                      <option key={lane.id} value={lane.id}>{lane.name}</option>
                    ))}
                  </select>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => addBuiltInAction("run-tests")}>
                    <Plus size={12} weight="regular" />
                    Test suite
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => addBuiltInAction("run-command")}>
                    <Plus size={12} weight="regular" />
                    Command
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => addBuiltInAction("predict-conflicts")}>
                    <Plus size={12} weight="regular" />
                    Conflict prediction
                  </Button>
                </div>

                {builtInActions.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-white/[0.12] px-4 py-6 text-sm text-[#8FA1B8]">
                    Add at least one built-in task.
                  </div>
                ) : (
                  builtInActions.map((action, index) => (
                    <div key={`${action.type}-${index}`} className="rounded-xl border border-white/[0.08] bg-[#0B121A] p-4">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-sm font-semibold text-[#F5FAFF]">
                          {index + 1}. {builtInActionSummary(action)}
                        </div>
                        <button
                          type="button"
                          onClick={() => removeBuiltInAction(index)}
                          className="rounded p-1 text-[#8FA1B8] transition-colors hover:text-red-200"
                          title="Remove task"
                        >
                          <Trash size={14} weight="regular" />
                        </button>
                      </div>

                      {action.type === "run-tests" ? (
                        <select
                          className={cn(INPUT_CLS, "mt-3")}
                          style={INPUT_STYLE}
                          value={action.suiteId ?? ""}
                          onChange={(event) => updateBuiltInAction(index, { suiteId: event.target.value })}
                        >
                          <option value="">Select a test suite</option>
                          {suites.map((suite) => (
                            <option key={suite.id} value={suite.id}>{suite.name || suite.id}</option>
                          ))}
                        </select>
                      ) : null}

                      {action.type === "run-command" ? (
                        <div className="mt-3 grid gap-3">
                          <input
                            className={INPUT_CLS}
                            style={INPUT_STYLE}
                            value={action.command ?? ""}
                            onChange={(event) => updateBuiltInAction(index, { command: event.target.value })}
                            placeholder="Command"
                          />
                          <input
                            className={INPUT_CLS}
                            style={INPUT_STYLE}
                            value={action.cwd ?? ""}
                            onChange={(event) => updateBuiltInAction(index, { cwd: event.target.value })}
                            placeholder="Working directory (optional)"
                          />
                        </div>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            ) : (
              <div className="mt-4 grid gap-4 lg:grid-cols-[1.3fr_0.7fr]">
                <div className="space-y-3 rounded-xl border border-white/[0.08] bg-black/15 p-4">
                  <input
                    className={INPUT_CLS}
                    style={INPUT_STYLE}
                    value={executionKind === "mission" ? draft.execution?.mission?.title ?? "" : draft.execution?.session?.title ?? ""}
                    onChange={(event) => setDraft({
                      ...draft,
                      execution: executionKind === "mission"
                        ? {
                            kind: "mission",
                            ...(draft.execution?.targetLaneId ? { targetLaneId: draft.execution.targetLaneId } : {}),
                            mission: { ...(draft.execution?.mission ?? {}), title: event.target.value },
                          }
                        : {
                            kind: "agent-session",
                            ...(draft.execution?.targetLaneId ? { targetLaneId: draft.execution.targetLaneId } : {}),
                            session: { ...(draft.execution?.session ?? {}), title: event.target.value },
                          },
                    })}
                    placeholder={executionKind === "mission" ? "Mission title (optional)" : "Thread title (optional)"}
                  />
                  <textarea
                    className="min-h-[180px] w-full rounded-md px-3 py-2 text-xs text-[#F5F7FA] placeholder:text-[#7E8A9A] font-mono"
                    style={INPUT_STYLE}
                    value={draft.prompt ?? ""}
                    onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
                    placeholder={
                      executionKind === "mission"
                        ? "Describe the mission this automation should launch."
                        : "Describe the prompt ADE should send to the automation thread."
                    }
                  />
                  <div className="rounded-xl border border-[#35506B] bg-[#102032] px-3 py-3 text-xs text-[#9FB2C7]">
                    {executionKind === "mission"
                      ? "Mission automations launch a full mission run. The run stays visible in the Missions tab, and Automations history keeps the scheduling context."
                      : "Agent-session automations create their own automation-only thread. The transcript stays inside Automations history and does not appear in Work."}
                  </div>
                </div>

                <div className="space-y-3 rounded-xl border border-white/[0.08] bg-black/15 p-4">
                  <div className="text-[11px] text-[#8FA1B8]">Target lane</div>
                  <select
                    className={INPUT_CLS}
                    style={INPUT_STYLE}
                    value={selectedLaneId}
                    onChange={(event) => setDraft({
                      ...draft,
                      execution: executionKind === "mission"
                        ? { kind: "mission", mission: { ...(draft.execution?.mission ?? {}) }, targetLaneId: event.target.value || null }
                        : { kind: "agent-session", session: { ...(draft.execution?.session ?? {}) }, targetLaneId: event.target.value || null },
                    })}
                  >
                    <option value="">Auto-select from the trigger or primary lane</option>
                    {lanes.map((lane) => (
                      <option key={lane.id} value={lane.id}>{lane.name}</option>
                    ))}
                  </select>

                  <div className="text-[11px] text-[#8FA1B8]">Model</div>
                  <ModelSelector
                    value={modelValue}
                    onChange={(next) => setDraft({
                      ...draft,
                      modelConfig: {
                        ...(draft.modelConfig ?? {}),
                        orchestratorModel: next,
                      },
                    })}
                    compact
                    onOpenAiSettings={openAiProvidersSettings}
                  />
                </div>
              </div>
            )}

            {executionKind === "mission" ? (
              <div className="mt-4 rounded-xl border border-white/[0.08] bg-black/15 p-4">
                {missionExecutionUnavailable ? (
                  <div className="mb-4 rounded-lg border border-emerald-400/25 bg-emerald-400/10 px-3 py-2 text-xs leading-5 text-emerald-100">
                    Mission automations are visible for planning, but cannot be saved from production builds until Missions ships.
                  </div>
                ) : null}
                <WorkerPermissionsEditor
                  orchestratorModelId={draft.modelConfig?.orchestratorModel?.modelId ?? DEFAULT_MODEL_ID}
                  phases={[]}
                  permissionConfig={permissionConfig}
                  onPermissionChange={(next) => setDraft({ ...draft, permissionConfig: next })}
                  title="Mission permissions"
                  description="These permissions match the runtime a launched mission will use."
                />
              </div>
            ) : null}
          </section>

          <section data-tour="automations.guardrails" className="rounded-2xl p-4" style={CARD_STYLE}>
            {sectionLabel("Advanced")}
            <div className="mt-3 grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
              <div className="space-y-3">
                <select
                  className={INPUT_CLS}
                  style={INPUT_STYLE}
                  value={draft.mode}
                  onChange={(event) => setDraft({ ...draft, mode: event.target.value as AutomationRuleDraft["mode"] })}
                >
                  {MODE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                <select
                  className={INPUT_CLS}
                  style={INPUT_STYLE}
                  value={draft.reviewProfile}
                  onChange={(event) => setDraft({ ...draft, reviewProfile: event.target.value as AutomationRuleDraft["reviewProfile"] })}
                >
                  {REVIEW_PROFILE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                <input
                  className={INPUT_CLS}
                  style={INPUT_STYLE}
                  type="number"
                  min={1}
                  value={draft.guardrails.maxDurationMin ?? ""}
                  onChange={(event) => setDraft({
                    ...draft,
                    guardrails: {
                      ...draft.guardrails,
                      maxDurationMin: event.target.value ? Number(event.target.value) : undefined,
                    },
                  })}
                  placeholder="Max duration (minutes)"
                />
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-xl border border-white/[0.08] bg-black/15 p-3">
                  <div className="text-sm font-semibold text-[#F5FAFF]">Tool access</div>
                  <div className="mt-3 grid gap-2">
                    {TOOL_OPTIONS.map((tool) => (
                      <label key={tool.value} className="flex items-center gap-2 text-xs text-[#D8E3F2]">
                        <input
                          type="checkbox"
                          checked={draft.toolPalette.includes(tool.value)}
                          onChange={(event) => toggleTool(tool.value, event.target.checked)}
                          className="accent-[#7DD3FC]"
                        />
                        {tool.label}
                      </label>
                    ))}
                  </div>
                </div>

                <div className="rounded-xl border border-white/[0.08] bg-black/15 p-3">
                  <div className="text-sm font-semibold text-[#F5FAFF]">Context</div>
                  <div className="mt-3 grid gap-2">
                    {CONTEXT_OPTIONS.map((option) => (
                      <label key={option.value} className="flex items-center gap-2 text-xs text-[#D8E3F2]">
                        <input
                          type="checkbox"
                          checked={draft.contextSources.some((source) => source.type === option.value)}
                          onChange={(event) => toggleContext(option.value, event.target.checked)}
                          className="accent-[#7DD3FC]"
                        />
                        {option.label}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </section>

          <IssueList issues={issues} />
          <ConfirmationsChecklist
            required={requiredConfirmations}
            accepted={acceptedConfirmations}
            onToggle={onToggleConfirmation}
          />
        </div>
      </div>
    </div>
  );
}

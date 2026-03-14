import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  CaretDown,
  FloppyDisk as Save,
  Flask as FlaskConical,
  Plus,
  Trash,
  X,
} from "@phosphor-icons/react";
import { getDefaultModelDescriptor } from "../../../../shared/modelRegistry";
import type {
  AgentIdentity,
  AutomationDraftConfirmationRequirement,
  AutomationDraftIssue,
  AutomationIngressStatus,
  AutomationRuleDraft,
  AutomationTrigger,
  TestSuiteDefinition,
} from "../../../../shared/types";
import { ModelSelector } from "../../missions/ModelSelector";
import { WorkerPermissionsEditor } from "../../missions/WorkerPermissionsEditor";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { getAutomationsBridge, INPUT_CLS, INPUT_STYLE } from "../shared";

const DEFAULT_AUTOMATION_MODEL_ID =
  getDefaultModelDescriptor("unified")?.id
  ?? getDefaultModelDescriptor("claude")?.id
  ?? "anthropic/claude-sonnet-4-6";

const DEFAULT_DISPLAY_MODEL = {
  orchestratorModel: {
    modelId: DEFAULT_AUTOMATION_MODEL_ID,
    thinkingLevel: "medium" as const,
  },
};

const DEFAULT_TOOL_SELECTION: AutomationRuleDraft["toolPalette"] = ["repo", "memory", "mission"];
const DEFAULT_CONTEXT_SELECTION: AutomationRuleDraft["contextSources"] = [{ type: "project-memory" }, { type: "procedures" }];

const MODE_OPTIONS: Array<{
  value: AutomationRuleDraft["mode"];
  label: string;
  description: string;
}> = [
  {
    value: "review",
    label: "Review and summarize",
    description: "Inspect changes or events and explain what matters.",
  },
  {
    value: "fix",
    label: "Try a fix",
    description: "Make a targeted change when the prompt asks for action.",
  },
  {
    value: "monitor",
    label: "Monitor and alert",
    description: "Watch for issues and open the right follow-up when something trips.",
  },
];

const REVIEW_PROFILE_OPTIONS: Array<{
  value: AutomationRuleDraft["reviewProfile"];
  label: string;
  description: string;
}> = [
  { value: "quick", label: "Quick scan", description: "Fast, lightweight pass." },
  { value: "incremental", label: "Recent changes", description: "Focus on what changed most recently." },
  { value: "full", label: "Full pass", description: "Thorough review of the full scope." },
  { value: "security", label: "Security focused", description: "Bias toward security and safety issues." },
  { value: "release-risk", label: "Release risk", description: "Look for launch blockers and rollout risk." },
  { value: "cross-repo-contract", label: "Cross-repo compatibility", description: "Check integration points across repos or systems." },
];

const EXECUTOR_OPTIONS: Array<{
  value: AutomationRuleDraft["executor"]["mode"];
  label: string;
  description: string;
}> = [
  {
    value: "automation-bot",
    label: "ADE automation bot",
    description: "Runs directly without picking a specific teammate worker.",
  },
  {
    value: "employee",
    label: "Specific worker",
    description: "Always send it to the same worker.",
  },
  {
    value: "cto-route",
    label: "Auto-pick a worker",
    description: "Let ADE route the task to the best worker for the job.",
  },
  {
    value: "night-shift",
    label: "Night shift queue",
    description: "Queue it for overnight review instead of running it immediately.",
  },
];

const DISPOSITION_OPTIONS: Array<{
  value: AutomationRuleDraft["outputs"]["disposition"];
  label: string;
  description: string;
}> = [
  { value: "comment-only", label: "Leave a summary", description: "Keep it lightweight and write the result back as a summary only." },
  { value: "open-task", label: "Open a task", description: "Create a follow-up task when the run finds something actionable." },
  { value: "open-lane", label: "Open a lane", description: "Spin up a lane when the work needs its own workspace." },
  { value: "prepare-patch", label: "Prepare a patch", description: "Generate a patch or code change for review." },
  { value: "open-pr-draft", label: "Open a draft PR", description: "Turn the result into a draft pull request when appropriate." },
  { value: "queue-overnight", label: "Queue for night shift", description: "Send the result into the overnight queue for later review." },
];

const VERIFICATION_MODE_OPTIONS: Array<{
  value: NonNullable<AutomationRuleDraft["verification"]["mode"]>;
  label: string;
  description: string;
}> = [
  { value: "intervention", label: "Ask me before publish", description: "Pause so you can approve the final publish step." },
  { value: "dry-run", label: "Dry run only", description: "Never publish automatically. Just show what would have happened." },
];

const TOOL_OPTIONS: Array<{
  value: AutomationRuleDraft["toolPalette"][number];
  label: string;
  description: string;
}> = [
  { value: "repo", label: "Repository files", description: "Read the codebase and local files." },
  { value: "git", label: "Git history", description: "Look at commits, diffs, and branches." },
  { value: "tests", label: "Test suites", description: "Inspect and run configured tests." },
  { value: "github", label: "GitHub", description: "Use PRs, issues, and repo metadata." },
  { value: "linear", label: "Linear", description: "Read and update Linear work items." },
  { value: "browser", label: "Browser tools", description: "Open pages, inspect UI, and automate browser steps." },
  { value: "memory", label: "Saved memory", description: "Use ADE memory and prior run context." },
  { value: "mission", label: "Mission runtime", description: "Use ADE mission and orchestration helpers." },
];

const CONTEXT_OPTIONS: Array<{
  value: AutomationRuleDraft["contextSources"][number]["type"];
  label: string;
  description: string;
}> = [
  { value: "project-memory", label: "Project memory", description: "Pull in the project’s saved memory." },
  { value: "automation-memory", label: "This automation’s history", description: "Reuse what this automation learned before." },
  { value: "worker-memory", label: "Worker memory", description: "Use memory attached to a routed worker." },
  { value: "procedures", label: "Procedures and runbooks", description: "Include saved operating procedures." },
  { value: "skills", label: "Skills", description: "Include installed skills and workflows." },
  { value: "linked-doc", label: "Linked docs", description: "Attach docs referenced by the automation." },
  { value: "linked-repo", label: "Linked repos", description: "Attach extra repos referenced by the automation." },
  { value: "path-rules", label: "Path-specific rules", description: "Apply path-based instructions and guardrails." },
];

const TRIGGER_OPTIONS: Array<{
  value: AutomationTrigger["type"];
  label: string;
  description: string;
}> = [
  { value: "manual", label: "Manual only", description: "Only runs when you click Run now." },
  { value: "session-end", label: "When I end a session", description: "Runs after you end a session in ADE." },
  { value: "schedule", label: "On a schedule", description: "Runs on a recurring schedule." },
  { value: "git.commit", label: "When a commit is created", description: "Runs after a commit is created in the repo." },
  { value: "git.push", label: "When ADE pushes", description: "Runs when ADE performs a push. Terminal pushes outside ADE may not trigger this directly yet." },
  { value: "git.pr_opened", label: "When a PR opens", description: "Runs when a pull request is opened." },
  { value: "git.pr_updated", label: "When a PR changes", description: "Runs when a pull request is updated." },
  { value: "git.pr_merged", label: "When a PR merges", description: "Runs when a pull request is merged." },
  { value: "git.pr_closed", label: "When a PR closes", description: "Runs when a pull request closes without merging." },
  { value: "file.change", label: "When files change locally", description: "Runs when matching files change on disk." },
  { value: "lane.created", label: "When a lane is created", description: "Runs when ADE creates a lane." },
  { value: "lane.archived", label: "When a lane is archived", description: "Runs when ADE archives a lane." },
  { value: "linear.issue_created", label: "When a Linear issue is created", description: "Runs when a new Linear issue appears." },
  { value: "linear.issue_updated", label: "When a Linear issue changes", description: "Runs when a Linear issue is updated." },
  { value: "linear.issue_assigned", label: "When a Linear issue is assigned", description: "Runs when assignment changes on a Linear issue." },
  { value: "linear.issue_status_changed", label: "When a Linear issue changes status", description: "Runs when a Linear issue moves between states." },
  { value: "github-webhook", label: "From a GitHub webhook", description: "Runs from GitHub relay webhook deliveries." },
  { value: "webhook", label: "From a custom webhook", description: "Runs from the local webhook listener." },
  { value: "commit", label: "On commit (legacy)", description: "Older commit trigger kept for compatibility with existing rules." },
];

const SCHEDULE_PRESETS = [
  { label: "Weekdays at 9:00 AM", cron: "0 9 * * 1-5" },
  { label: "Daily at 10:00 AM", cron: "0 10 * * *" },
  { label: "Fridays at 4:00 PM", cron: "0 16 * * 5" },
  { label: "Mondays at 8:30 AM", cron: "30 8 * * 1" },
];

const BRANCH_TRIGGER_TYPES = new Set<AutomationTrigger["type"]>([
  "commit",
  "git.commit",
  "git.push",
  "git.pr_opened",
  "git.pr_updated",
  "git.pr_closed",
  "github-webhook",
  "webhook",
]);

const GIT_FILTER_TRIGGER_TYPES = new Set<AutomationTrigger["type"]>([
  "commit",
  "git.commit",
  "git.push",
  "git.pr_opened",
  "git.pr_updated",
  "git.pr_merged",
  "git.pr_closed",
  "github-webhook",
  "webhook",
]);

const PR_STYLE_TRIGGER_TYPES = new Set<AutomationTrigger["type"]>([
  "git.pr_opened",
  "git.pr_updated",
  "git.pr_merged",
  "git.pr_closed",
  "github-webhook",
]);

const WEBHOOK_TRIGGER_TYPES = new Set<AutomationTrigger["type"]>(["github-webhook", "webhook"]);

const LINEAR_TRIGGER_TYPES = new Set<AutomationTrigger["type"]>([
  "linear.issue_created",
  "linear.issue_updated",
  "linear.issue_assigned",
  "linear.issue_status_changed",
]);

const LANE_TRIGGER_TYPES = new Set<AutomationTrigger["type"]>(["lane.created", "lane.archived"]);

function createTrigger(type: AutomationTrigger["type"] = "manual"): AutomationTrigger {
  return sanitizeTriggerForType({ type }, type);
}

function sanitizeTriggerForType(trigger: AutomationTrigger, type: AutomationTrigger["type"]): AutomationTrigger {
  const next: AutomationTrigger = { type };

  if (type === "schedule") {
    if (trigger.cron) next.cron = trigger.cron;
    return next;
  }

  if (BRANCH_TRIGGER_TYPES.has(type) && trigger.branch) {
    next.branch = trigger.branch;
  }

  if (type === "git.pr_merged") {
    if (trigger.targetBranch) next.targetBranch = trigger.targetBranch;
    else if (trigger.branch) next.targetBranch = trigger.branch;
  }

  if (GIT_FILTER_TRIGGER_TYPES.has(type)) {
    if (trigger.author) next.author = trigger.author;
    if (trigger.labels?.length) next.labels = [...trigger.labels];
    if (trigger.paths?.length) next.paths = [...trigger.paths];
    if (trigger.keywords?.length) next.keywords = [...trigger.keywords];
    if (trigger.draftState) next.draftState = trigger.draftState;
  }

  if (type === "file.change") {
    if (trigger.paths?.length) next.paths = [...trigger.paths];
    if (trigger.keywords?.length) next.keywords = [...trigger.keywords];
  }

  if (LANE_TRIGGER_TYPES.has(type)) {
    if (trigger.namePattern) next.namePattern = trigger.namePattern;
    if (trigger.keywords?.length) next.keywords = [...trigger.keywords];
  }

  if (LINEAR_TRIGGER_TYPES.has(type)) {
    if (trigger.project) next.project = trigger.project;
    if (trigger.team) next.team = trigger.team;
    if (trigger.assignee) next.assignee = trigger.assignee;
    if (trigger.stateTransition) next.stateTransition = trigger.stateTransition;
    if (trigger.changedFields?.length) next.changedFields = [...trigger.changedFields];
    if (trigger.labels?.length) next.labels = [...trigger.labels];
    if (trigger.keywords?.length) next.keywords = [...trigger.keywords];
  }

  if (WEBHOOK_TRIGGER_TYPES.has(type)) {
    if (trigger.event) next.event = trigger.event;
    if (trigger.secretRef) next.secretRef = trigger.secretRef;
  }

  if (trigger.activeHours) next.activeHours = trigger.activeHours;
  return next;
}

function joinList(values: string[] | undefined | null): string {
  return Array.isArray(values) ? values.join(", ") : "";
}

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function hasSameEntries(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function getTriggerMeta(type: AutomationTrigger["type"]) {
  return TRIGGER_OPTIONS.find((option) => option.value === type) ?? TRIGGER_OPTIONS[0]!;
}

function selectedSchedulePreset(cron?: string): string {
  return SCHEDULE_PRESETS.find((preset) => preset.cron === cron)?.cron ?? "";
}

function IssueList({ issues }: { issues: AutomationDraftIssue[] }) {
  if (!issues.length) return null;
  return (
    <div className="space-y-2">
      {issues.map((issue, index) => (
        <div
          key={`${issue.path}-${index}`}
          className={cn("rounded px-3 py-2 text-xs", issue.level === "error" ? "text-red-200" : "text-amber-200")}
          style={{ background: issue.level === "error" ? "rgba(239,68,68,0.10)" : "rgba(245,158,11,0.10)" }}
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
    <div className="space-y-2 rounded-lg p-3 shadow-card" style={{ background: "#181423", border: "1px solid #2D2840" }}>
      <div className="text-xs font-semibold text-[#FAFAFA]">Before saving</div>
      <div className="space-y-2">
        {required.map((requirement) => (
          <label key={requirement.key} className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              checked={accepted.has(requirement.key)}
              onChange={(event) => onToggle(requirement.key, event.target.checked)}
              className="mt-0.5 accent-[#A78BFA]"
            />
            <div className="min-w-0">
              <div className={cn("font-semibold", requirement.severity === "danger" ? "text-red-200" : "text-amber-200")}>
                {requirement.title}
              </div>
              <div className="text-[#8B8B9A]">{requirement.message}</div>
            </div>
          </label>
        ))}
      </div>
    </div>
  );
}

function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-xl p-4" style={{ background: "#181423", border: "1px solid #2D2840" }}>
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-[#FAFAFA]" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
          {title}
        </h3>
        {description ? <p className="text-xs leading-5 text-[#8B8B9A]">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

function AdvancedPanel({
  title,
  description,
  children,
  defaultOpen = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details
      className="rounded-lg"
      style={{ background: "#14111D", border: "1px solid #1E1B26" }}
      {...(defaultOpen ? { open: true } : {})}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2">
        <div className="space-y-0.5">
          <div className="text-xs font-semibold text-[#FAFAFA]">{title}</div>
          {description ? <div className="text-[11px] leading-5 text-[#8B8B9A]">{description}</div> : null}
        </div>
        <CaretDown size={12} className="shrink-0 text-[#71717A]" />
      </summary>
      <div className="space-y-3 px-3 pb-3 pt-1">{children}</div>
    </details>
  );
}

function ToggleCard({
  checked,
  onChange,
  title,
  description,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  title: string;
  description: string;
}) {
  return (
    <label
      className="flex cursor-pointer items-start gap-3 rounded-lg p-3"
      style={{ background: "#14111D", border: checked ? "1px solid rgba(167,139,250,0.6)" : "1px solid #1E1B26" }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 accent-[#A78BFA]"
      />
      <div className="space-y-1">
        <div className="text-xs font-semibold text-[#FAFAFA]">{title}</div>
        <div className="text-[11px] leading-5 text-[#8B8B9A]">{description}</div>
      </div>
    </label>
  );
}

function HelperText({ children }: { children: ReactNode }) {
  return <div className="text-[11px] leading-5 text-[#8B8B9A]">{children}</div>;
}

export function RuleEditorPanel({
  draft,
  setDraft,
  suites,
  issues,
  requiredConfirmations,
  acceptedConfirmations,
  setAcceptedConfirmations,
  saving,
  onSave,
  onSimulate,
  onClose,
}: {
  draft: AutomationRuleDraft;
  setDraft: (next: AutomationRuleDraft) => void;
  suites: TestSuiteDefinition[];
  issues: AutomationDraftIssue[];
  requiredConfirmations: AutomationDraftConfirmationRequirement[];
  acceptedConfirmations: Set<string>;
  setAcceptedConfirmations: (next: Set<string>) => void;
  saving: boolean;
  onSave: () => void;
  onSimulate: () => void;
  onClose: () => void;
}) {
  const triggers = draft.triggers.length ? draft.triggers : [createTrigger()];
  const legacyActions = draft.legacyActions ?? [];
  const [agents, setAgents] = useState<AgentIdentity[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [ingressStatus, setIngressStatus] = useState<AutomationIngressStatus | null>(null);
  const [ingressLoading, setIngressLoading] = useState(false);

  const automationsBridge = getAutomationsBridge();
  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === draft.executor.targetId) ?? null,
    [agents, draft.executor.targetId],
  );
  const displayedModelConfig = useMemo(
    () => draft.modelConfig ?? DEFAULT_DISPLAY_MODEL,
    [draft.modelConfig],
  );
  const hasWebhookTrigger = triggers.some((trigger) => WEBHOOK_TRIGGER_TYPES.has(trigger.type));
  const selectedMode = MODE_OPTIONS.find((option) => option.value === draft.mode) ?? MODE_OPTIONS[0]!;
  const selectedProfile = REVIEW_PROFILE_OPTIONS.find((option) => option.value === draft.reviewProfile) ?? REVIEW_PROFILE_OPTIONS[0]!;
  const selectedExecutor = EXECUTOR_OPTIONS.find((option) => option.value === draft.executor.mode) ?? EXECUTOR_OPTIONS[0]!;
  const selectedDisposition = DISPOSITION_OPTIONS.find((option) => option.value === draft.outputs.disposition) ?? DISPOSITION_OPTIONS[0]!;

  const customToolSelection = useMemo(() => {
    const normalized = [...draft.toolPalette].sort();
    const defaults = [...DEFAULT_TOOL_SELECTION].sort();
    return !hasSameEntries(normalized, defaults);
  }, [draft.toolPalette]);

  const customContextSelection = useMemo(() => {
    const normalized = draft.contextSources.map((source) => source.type).sort();
    const defaults = DEFAULT_CONTEXT_SELECTION.map((source) => source.type).sort();
    return !hasSameEntries(normalized, defaults);
  }, [draft.contextSources]);

  const hasCustomPermissions = useMemo(() => {
    const providers = draft.permissionConfig?.providers;
    const external = draft.permissionConfig?.externalMcp;
    return Boolean(
      providers?.claude
      || providers?.codex
      || providers?.unified
      || providers?.codexSandbox
      || providers?.allowedTools?.length
      || providers?.writablePaths?.length
      || external?.enabled,
    );
  }, [draft.permissionConfig]);

  const updateTriggers = (nextTriggers: AutomationTrigger[]) => {
    const normalized = nextTriggers.length ? nextTriggers : [createTrigger()];
    setDraft({
      ...draft,
      trigger: normalized[0]!,
      triggers: normalized,
    });
  };

  const updateTriggerAt = (index: number, patch: Partial<AutomationTrigger>) => {
    const current = triggers[index] ?? createTrigger();
    const nextTriggers = [...triggers];
    nextTriggers[index] = { ...current, ...patch };
    updateTriggers(nextTriggers);
  };

  const setTriggerTypeAt = (index: number, type: AutomationTrigger["type"]) => {
    const current = triggers[index] ?? createTrigger();
    const nextTriggers = [...triggers];
    nextTriggers[index] = sanitizeTriggerForType(current, type);
    updateTriggers(nextTriggers);
  };

  const addTrigger = () => {
    updateTriggers([...triggers, createTrigger("schedule")]);
  };

  const removeTrigger = (index: number) => {
    updateTriggers(triggers.filter((_trigger, currentIndex) => currentIndex !== index));
  };

  const updateExecutor = (patch: Partial<AutomationRuleDraft["executor"]>) => {
    setDraft({ ...draft, executor: { ...draft.executor, ...patch } });
  };

  const updateModelConfig = (patch: Partial<NonNullable<AutomationRuleDraft["modelConfig"]>>) => {
    const current = draft.modelConfig ?? DEFAULT_DISPLAY_MODEL;
    setDraft({
      ...draft,
      modelConfig: {
        ...current,
        ...patch,
        orchestratorModel: {
          ...current.orchestratorModel,
          ...(patch.orchestratorModel ?? {}),
        },
      },
    });
  };

  const updateLegacyAction = (index: number, patch: Record<string, unknown>) => {
    const next = [...legacyActions];
    next[index] = { ...(next[index] as Record<string, unknown>), ...patch } as any;
    setDraft({ ...draft, actions: next, legacyActions: next });
  };

  const addLegacyAction = (type: string) => {
    const next = [...legacyActions];
    if (type === "run-tests") next.push({ type: "run-tests", suite: suites[0]?.id ?? "" } as any);
    else if (type === "run-command") next.push({ type: "run-command", command: "" } as any);
    else next.push({ type } as any);
    setDraft({ ...draft, actions: next, legacyActions: next });
  };

  const removeLegacyAction = (index: number) => {
    const next = legacyActions.filter((_action, currentIndex) => currentIndex !== index);
    setDraft({ ...draft, actions: next, legacyActions: next });
  };

  useEffect(() => {
    if (!(draft.executor.mode === "employee" || draft.executor.mode === "cto-route")) {
      return;
    }
    if (!window.ade?.cto?.listAgents) {
      setAgents([]);
      return;
    }
    let cancelled = false;
    setAgentsLoading(true);
    window.ade.cto
      .listAgents({})
      .then((next) => {
        if (!cancelled) setAgents(next);
      })
      .catch(() => {
        if (!cancelled) setAgents([]);
      })
      .finally(() => {
        if (!cancelled) setAgentsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [draft.executor.mode]);

  useEffect(() => {
    if (!hasWebhookTrigger || !automationsBridge.getIngressStatus) {
      setIngressStatus(null);
      return;
    }
    let cancelled = false;
    setIngressLoading(true);
    automationsBridge
      .getIngressStatus()
      .then((next) => {
        if (!cancelled) setIngressStatus(next);
      })
      .catch(() => {
        if (!cancelled) setIngressStatus(null);
      })
      .finally(() => {
        if (!cancelled) setIngressLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [automationsBridge, hasWebhookTrigger]);

  return (
    <div className="flex h-full flex-col" style={{ background: "#14111D" }}>
      <div className="flex shrink-0 items-center justify-between px-4 py-3" style={{ borderBottom: "1px solid #2D2840" }}>
        <div className="min-w-0">
          <div className="text-[14px] font-bold tracking-[-0.3px] text-[#FAFAFA]" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
            {draft.id ? "Edit automation" : "Create automation"}
          </div>
          <div className="mt-0.5 text-xs text-[#8B8B9A]">
            Keep the main path simple: define the task, choose when it runs, then save.
          </div>
          {draft.id ? <div className="mt-1 font-mono text-[9px] text-[#71717A]">{draft.id}</div> : null}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={onSimulate}>
            <FlaskConical size={12} weight="regular" />
            Preview run
          </Button>
          <Button size="sm" variant="primary" disabled={saving} onClick={onSave}>
            <Save size={12} weight="regular" />
            Save
          </Button>
          <button type="button" onClick={onClose} className="p-1 text-[#71717A] transition-colors hover:text-[#FAFAFA]">
            <X size={14} weight="regular" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <IssueList issues={issues} />

        <SectionCard
          title="Basics"
          description="Start with a clear name and a short note for the automation list."
        >
          <div className="grid grid-cols-[1fr_auto] items-end gap-3">
            <label className="space-y-1">
              <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">Name</div>
              <input
                className={INPUT_CLS}
                style={INPUT_STYLE}
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder="Weekly engineering summary"
              />
            </label>
            <label className="flex h-8 items-center gap-2 rounded-lg px-3 text-[10px] font-mono uppercase tracking-[1px] text-[#D4D4D8]" style={{ background: "#14111D", border: "1px solid #1E1B26" }}>
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                className="accent-[#A78BFA]"
              />
              Active
            </label>
          </div>

          <label className="space-y-1 block">
            <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">List note</div>
            <input
              className={INPUT_CLS}
              style={INPUT_STYLE}
              value={draft.description ?? ""}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              placeholder="Optional note shown in the automation list"
            />
          </label>
        </SectionCard>

        <SectionCard
          title="Task"
          description="Tell ADE what kind of job this is and what you want in the result."
        >
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="space-y-1">
              <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">Job type</div>
              <select
                className={INPUT_CLS}
                style={INPUT_STYLE}
                value={draft.mode}
                onChange={(event) => setDraft({ ...draft, mode: event.target.value as AutomationRuleDraft["mode"] })}
              >
                {MODE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <HelperText>{selectedMode.description}</HelperText>
            </label>

            <label className="space-y-1">
              <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">Depth</div>
              <select
                className={INPUT_CLS}
                style={INPUT_STYLE}
                value={draft.reviewProfile}
                onChange={(event) => setDraft({ ...draft, reviewProfile: event.target.value as AutomationRuleDraft["reviewProfile"] })}
              >
                {REVIEW_PROFILE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <HelperText>{selectedProfile.description}</HelperText>
            </label>
          </div>

          <label className="space-y-1 block">
            <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">Prompt</div>
            <textarea
              className="min-h-[140px] w-full p-3 text-xs text-[#FAFAFA] placeholder:text-[#71717A50]"
              style={INPUT_STYLE}
              value={draft.prompt ?? ""}
              onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
              placeholder="Explain what this automation should do, what evidence it should use, and what kind of output you want."
            />
            <HelperText>
              Write this the same way you would brief a teammate. Put schedule and workspace details in the trigger and runner sections instead of the prompt.
            </HelperText>
          </label>
        </SectionCard>

        <SectionCard
          title="When it runs"
          description="Use one trigger for the common case. Add more only if this exact automation should react to multiple events."
        >
          <div className="flex items-center justify-between gap-3">
            <HelperText>
              Start simple: manual, schedule, or one repo event is usually enough.
            </HelperText>
            <Button size="sm" variant="outline" onClick={addTrigger}>
              <Plus size={12} weight="regular" />
              Add another trigger
            </Button>
          </div>

          <div className="space-y-3">
            {triggers.map((trigger, index) => {
              const triggerMeta = getTriggerMeta(trigger.type);
              const hasGitAdvanced =
                Boolean(trigger.author)
                || Boolean(trigger.labels?.length)
                || Boolean(trigger.paths?.length)
                || Boolean(trigger.keywords?.length)
                || Boolean(trigger.secretRef)
                || Boolean(trigger.draftState && trigger.draftState !== "any");
              const hasLinearAdvanced =
                Boolean(trigger.stateTransition)
                || Boolean(trigger.changedFields?.length)
                || Boolean(trigger.labels?.length)
                || Boolean(trigger.keywords?.length);
              const hasSimpleAdvanced = Boolean(trigger.keywords?.length);
              const customSchedule = trigger.type === "schedule" && trigger.cron && !selectedSchedulePreset(trigger.cron);

              return (
                <div
                  key={`${trigger.type}-${index}`}
                  className="space-y-3 rounded-xl p-4"
                  style={{ background: "#14111D", border: "1px solid #1E1B26" }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="text-sm font-semibold text-[#FAFAFA]">Trigger {index + 1}</div>
                      <div className="text-xs leading-5 text-[#8B8B9A]">{triggerMeta.description}</div>
                    </div>
                    {triggers.length > 1 ? (
                      <Button size="sm" variant="ghost" onClick={() => removeTrigger(index)}>
                        <Trash size={12} weight="regular" />
                        Remove
                      </Button>
                    ) : null}
                  </div>

                  <label className="space-y-1 block">
                    <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">When this happens</div>
                    <select
                      className={INPUT_CLS}
                      style={INPUT_STYLE}
                      value={trigger.type}
                      onChange={(event) => setTriggerTypeAt(index, event.target.value as AutomationTrigger["type"])}
                    >
                      {TRIGGER_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  {trigger.type === "schedule" ? (
                    <div className="space-y-3">
                      <label className="space-y-1 block">
                        <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">Preset schedule</div>
                        <select
                          className={INPUT_CLS}
                          style={INPUT_STYLE}
                          value={selectedSchedulePreset(trigger.cron)}
                          onChange={(event) => updateTriggerAt(index, { cron: event.target.value || undefined })}
                        >
                          <option value="">Custom schedule</option>
                          {SCHEDULE_PRESETS.map((preset) => (
                            <option key={preset.cron} value={preset.cron}>
                              {preset.label}
                            </option>
                          ))}
                        </select>
                      </label>

                      <AdvancedPanel
                        title="Custom cron"
                        description="Only use this if the presets do not fit."
                        defaultOpen={Boolean(customSchedule)}
                      >
                        <label className="space-y-1 block">
                          <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">Cron expression</div>
                          <input
                            className={INPUT_CLS}
                            style={INPUT_STYLE}
                            value={trigger.cron ?? ""}
                            onChange={(event) => updateTriggerAt(index, { cron: event.target.value })}
                            placeholder="0 9 * * 1-5"
                          />
                        </label>
                      </AdvancedPanel>
                    </div>
                  ) : null}

                  {BRANCH_TRIGGER_TYPES.has(trigger.type) ? (
                    <label className="space-y-1 block">
                      <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">
                        {trigger.type.startsWith("git.pr_") ? "Source branch" : "Branch"}
                      </div>
                      <input
                        className={INPUT_CLS}
                        style={INPUT_STYLE}
                        value={trigger.branch ?? ""}
                        onChange={(event) => updateTriggerAt(index, { branch: event.target.value })}
                        placeholder={trigger.type.startsWith("git.pr_") ? "feat/*" : "main"}
                      />
                    </label>
                  ) : null}

                  {trigger.type === "git.pr_merged" ? (
                    <label className="space-y-1 block">
                      <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">Target branch</div>
                      <input
                        className={INPUT_CLS}
                        style={INPUT_STYLE}
                        value={trigger.targetBranch ?? ""}
                        onChange={(event) => updateTriggerAt(index, { targetBranch: event.target.value })}
                        placeholder="main"
                      />
                    </label>
                  ) : null}

                  {WEBHOOK_TRIGGER_TYPES.has(trigger.type) ? (
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      <label className="space-y-1">
                        <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">Event name</div>
                        <input
                          className={INPUT_CLS}
                          style={INPUT_STYLE}
                          value={trigger.event ?? ""}
                          onChange={(event) => updateTriggerAt(index, { event: event.target.value })}
                          placeholder={trigger.type === "github-webhook" ? "pull_request" : "push"}
                        />
                      </label>
                    </div>
                  ) : null}

                  {trigger.type === "file.change" ? (
                    <label className="space-y-1 block">
                      <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">Watch these paths</div>
                      <input
                        className={INPUT_CLS}
                        style={INPUT_STYLE}
                        value={joinList(trigger.paths)}
                        onChange={(event) => updateTriggerAt(index, { paths: parseList(event.target.value) })}
                        placeholder="apps/desktop/**, docs/**"
                      />
                    </label>
                  ) : null}

                  {LANE_TRIGGER_TYPES.has(trigger.type) ? (
                    <label className="space-y-1 block">
                      <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">Lane name pattern</div>
                      <input
                        className={INPUT_CLS}
                        style={INPUT_STYLE}
                        value={trigger.namePattern ?? ""}
                        onChange={(event) => updateTriggerAt(index, { namePattern: event.target.value })}
                        placeholder="release-*"
                      />
                    </label>
                  ) : null}

                  {LINEAR_TRIGGER_TYPES.has(trigger.type) ? (
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                      <label className="space-y-1">
                        <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">Project</div>
                        <input
                          className={INPUT_CLS}
                          style={INPUT_STYLE}
                          value={trigger.project ?? ""}
                          onChange={(event) => updateTriggerAt(index, { project: event.target.value })}
                          placeholder="acme-platform"
                        />
                      </label>
                      <label className="space-y-1">
                        <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">Team</div>
                        <input
                          className={INPUT_CLS}
                          style={INPUT_STYLE}
                          value={trigger.team ?? ""}
                          onChange={(event) => updateTriggerAt(index, { team: event.target.value })}
                          placeholder="ENG"
                        />
                      </label>
                      <label className="space-y-1">
                        <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">Assignee</div>
                        <input
                          className={INPUT_CLS}
                          style={INPUT_STYLE}
                          value={trigger.assignee ?? ""}
                          onChange={(event) => updateTriggerAt(index, { assignee: event.target.value })}
                          placeholder="CTO"
                        />
                      </label>
                    </div>
                  ) : null}

                  {GIT_FILTER_TRIGGER_TYPES.has(trigger.type) ? (
                    <AdvancedPanel
                      title="More git filters"
                      description="Only add filters if this should run on a narrower slice of activity."
                      defaultOpen={hasGitAdvanced}
                    >
                      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                        <label className="space-y-1">
                          <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">Author</div>
                          <input
                            className={INPUT_CLS}
                            style={INPUT_STYLE}
                            value={trigger.author ?? ""}
                            onChange={(event) => updateTriggerAt(index, { author: event.target.value })}
                            placeholder="octocat"
                          />
                        </label>

                        {(PR_STYLE_TRIGGER_TYPES.has(trigger.type) || trigger.type === "github-webhook") ? (
                          <label className="space-y-1">
                            <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">PR state</div>
                            <select
                              className={INPUT_CLS}
                              style={INPUT_STYLE}
                              value={trigger.draftState ?? "any"}
                              onChange={(event) => updateTriggerAt(index, { draftState: event.target.value as AutomationTrigger["draftState"] })}
                            >
                              <option value="any">Any</option>
                              <option value="draft">Draft only</option>
                              <option value="ready">Ready only</option>
                            </select>
                          </label>
                        ) : null}

                        <label className="space-y-1">
                          <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">Labels</div>
                          <input
                            className={INPUT_CLS}
                            style={INPUT_STYLE}
                            value={joinList(trigger.labels)}
                            onChange={(event) => updateTriggerAt(index, { labels: parseList(event.target.value) })}
                            placeholder="backend, urgent"
                          />
                        </label>
                        <label className="space-y-1">
                          <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">Changed paths</div>
                          <input
                            className={INPUT_CLS}
                            style={INPUT_STYLE}
                            value={joinList(trigger.paths)}
                            onChange={(event) => updateTriggerAt(index, { paths: parseList(event.target.value) })}
                            placeholder="apps/desktop/**, docs/**"
                          />
                        </label>
                        <label className="space-y-1 md:col-span-2">
                          <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">Keywords</div>
                          <input
                            className={INPUT_CLS}
                            style={INPUT_STYLE}
                            value={joinList(trigger.keywords)}
                            onChange={(event) => updateTriggerAt(index, { keywords: parseList(event.target.value) })}
                            placeholder="release note, regression, urgent"
                          />
                        </label>
                        {WEBHOOK_TRIGGER_TYPES.has(trigger.type) ? (
                          <label className="space-y-1 md:col-span-2">
                            <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">Secret reference</div>
                            <input
                              className={INPUT_CLS}
                              style={INPUT_STYLE}
                              value={trigger.secretRef ?? ""}
                              onChange={(event) => updateTriggerAt(index, { secretRef: event.target.value })}
                              placeholder="automations.webhooks.github"
                            />
                          </label>
                        ) : null}
                      </div>
                    </AdvancedPanel>
                  ) : null}

                  {(trigger.type === "file.change" || LANE_TRIGGER_TYPES.has(trigger.type)) ? (
                    <AdvancedPanel
                      title="Keyword filters"
                      description="Use keywords only if the trigger should react to specific terms."
                      defaultOpen={hasSimpleAdvanced}
                    >
                      <label className="space-y-1 block">
                        <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">Keywords</div>
                        <input
                          className={INPUT_CLS}
                          style={INPUT_STYLE}
                          value={joinList(trigger.keywords)}
                          onChange={(event) => updateTriggerAt(index, { keywords: parseList(event.target.value) })}
                          placeholder="release, cleanup, urgent"
                        />
                      </label>
                    </AdvancedPanel>
                  ) : null}

                  {LINEAR_TRIGGER_TYPES.has(trigger.type) ? (
                    <AdvancedPanel
                      title="More Linear filters"
                      description="Narrow this down when the automation should react to a specific workflow."
                      defaultOpen={hasLinearAdvanced}
                    >
                      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                        <label className="space-y-1">
                          <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">Status transition</div>
                          <input
                            className={INPUT_CLS}
                            style={INPUT_STYLE}
                            value={trigger.stateTransition ?? ""}
                            onChange={(event) => updateTriggerAt(index, { stateTransition: event.target.value })}
                            placeholder="Todo->In Progress"
                          />
                        </label>
                        <label className="space-y-1">
                          <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">Changed fields</div>
                          <input
                            className={INPUT_CLS}
                            style={INPUT_STYLE}
                            value={joinList(trigger.changedFields)}
                            onChange={(event) => updateTriggerAt(index, { changedFields: parseList(event.target.value) })}
                            placeholder="state, assignee, labels"
                          />
                        </label>
                        <label className="space-y-1">
                          <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">Labels</div>
                          <input
                            className={INPUT_CLS}
                            style={INPUT_STYLE}
                            value={joinList(trigger.labels)}
                            onChange={(event) => updateTriggerAt(index, { labels: parseList(event.target.value) })}
                            placeholder="bug, customer"
                          />
                        </label>
                        <label className="space-y-1">
                          <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">Keywords</div>
                          <input
                            className={INPUT_CLS}
                            style={INPUT_STYLE}
                            value={joinList(trigger.keywords)}
                            onChange={(event) => updateTriggerAt(index, { keywords: parseList(event.target.value) })}
                            placeholder="incident, regression"
                          />
                        </label>
                      </div>
                    </AdvancedPanel>
                  ) : null}
                </div>
              );
            })}
          </div>

          {hasWebhookTrigger ? (
            <AdvancedPanel
              title="Webhook status"
              description={ingressLoading ? "Checking runtime status..." : "Helpful when you use webhook-based triggers."}
            >
              {ingressStatus ? (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <div className="rounded-lg px-3 py-2" style={{ background: "#0B0A0F", border: "1px solid #1E1B26" }}>
                    <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">GitHub relay</div>
                    <div className="mt-1 text-xs text-[#FAFAFA]">{ingressStatus.githubRelay.status}</div>
                    <div className="mt-1 text-[11px] leading-5 text-[#8B8B9A]">
                      {ingressStatus.githubRelay.remoteProjectId ?? "No remote project connected"}
                    </div>
                  </div>
                  <div className="rounded-lg px-3 py-2" style={{ background: "#0B0A0F", border: "1px solid #1E1B26" }}>
                    <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">Local webhook</div>
                    <div className="mt-1 text-xs text-[#FAFAFA]">{ingressStatus.localWebhook.status}</div>
                    <div className="mt-1 text-[11px] leading-5 text-[#8B8B9A]">
                      {ingressStatus.localWebhook.url ?? "Listener unavailable"}
                    </div>
                  </div>
                </div>
              ) : (
                <HelperText>
                  {automationsBridge.getIngressStatus
                    ? "Waiting for the runtime to report webhook status."
                    : "Webhook status appears once the runtime bridge is available."}
                </HelperText>
              )}
            </AdvancedPanel>
          ) : null}
        </SectionCard>

        <SectionCard
          title="Runner"
          description="Choose who runs the automation, then pick the same model control used everywhere else in ADE."
        >
          <div className="space-y-3">
            <label className="space-y-1 block">
              <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">Runner</div>
              <select
                className={INPUT_CLS}
                style={INPUT_STYLE}
                value={draft.executor.mode}
                onChange={(event) => updateExecutor({ mode: event.target.value as AutomationRuleDraft["executor"]["mode"] })}
              >
                {EXECUTOR_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <HelperText>{selectedExecutor.description}</HelperText>
            </label>

            {(draft.executor.mode === "employee" || draft.executor.mode === "cto-route") ? (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <label className="space-y-1">
                  <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">
                    {draft.executor.mode === "employee" ? "Worker" : "Preferred worker"}
                  </div>
                  <select
                    className={INPUT_CLS}
                    style={INPUT_STYLE}
                    value={draft.executor.targetId ?? ""}
                    onChange={(event) => updateExecutor({ targetId: event.target.value || null })}
                  >
                    <option value="">
                      {agentsLoading
                        ? "Loading workers..."
                        : draft.executor.mode === "employee"
                          ? "Select a worker"
                          : "Let ADE choose"}
                    </option>
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name} ({agent.role})
                      </option>
                    ))}
                  </select>
                </label>

                {draft.executor.mode === "cto-route" ? (
                  <label className="space-y-1">
                    <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">Needs these skills</div>
                    <input
                      className={INPUT_CLS}
                      style={INPUT_STYLE}
                      value={joinList(draft.executor.routingHints?.requiredCapabilities)}
                      onChange={(event) =>
                        updateExecutor({
                          routingHints: {
                            ...draft.executor.routingHints,
                            requiredCapabilities: parseList(event.target.value),
                          },
                        })
                      }
                      placeholder="frontend, review, release"
                    />
                  </label>
                ) : (
                  <div className="rounded-lg px-3 py-2 text-[11px] leading-5 text-[#8B8B9A]" style={{ background: "#14111D", border: "1px solid #1E1B26" }}>
                    ADE will keep sending recurring runs to the same worker for continuity.
                  </div>
                )}
              </div>
            ) : null}

            {selectedAgent ? (
              <div className="rounded-lg px-3 py-2 text-[11px] leading-5 text-[#8B8B9A]" style={{ background: "#14111D", border: "1px solid #1E1B26" }}>
                {selectedAgent.title ?? selectedAgent.role} · {selectedAgent.status} · capabilities {selectedAgent.capabilities.join(", ") || "none listed"}
              </div>
            ) : null}

            <div className="space-y-1">
              <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">Model</div>
              <div className="rounded-lg p-3" style={{ background: "#14111D", border: "1px solid #1E1B26" }}>
                <ModelSelector
                  value={displayedModelConfig.orchestratorModel}
                  onChange={(config) => updateModelConfig({ orchestratorModel: config })}
                />
              </div>
              <HelperText>
                This is the same model picker used elsewhere in ADE. Reasoning lives inside the picker instead of a separate automation-only field.
              </HelperText>
            </div>

            <AdvancedPanel
              title="Permissions and filesystem access"
              description="Same permission controls as the rest of ADE. Leave this alone unless you need tighter or broader access."
              defaultOpen={hasCustomPermissions}
            >
              <WorkerPermissionsEditor
                orchestratorModelId={displayedModelConfig.orchestratorModel.modelId}
                phases={[]}
                permissionConfig={draft.permissionConfig ?? {}}
                onPermissionChange={(next) => setDraft({ ...draft, permissionConfig: next })}
                title="Permissions and filesystem access"
                description="These are shared ADE controls, not a custom automation-only permission system."
                showExternalMcp={false}
              />
            </AdvancedPanel>
          </div>
        </SectionCard>

        <SectionCard
          title="Result handling"
          description="Choose what ADE should do with the result after the run finishes."
        >
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="space-y-1">
              <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">After it runs</div>
              <select
                className={INPUT_CLS}
                style={INPUT_STYLE}
                value={draft.outputs.disposition}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    outputs: {
                      ...draft.outputs,
                      disposition: event.target.value as AutomationRuleDraft["outputs"]["disposition"],
                    },
                  })
                }
              >
                {DISPOSITION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <HelperText>{selectedDisposition.description}</HelperText>
            </label>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <ToggleCard
              checked={Boolean(draft.outputs.createArtifact)}
              onChange={(checked) => setDraft({ ...draft, outputs: { ...draft.outputs, createArtifact: checked } })}
              title="Save a report or patch in run history"
              description="Turn this off only if you want a lightweight result with no saved artifact."
            />
            <ToggleCard
              checked={Boolean(draft.verification.verifyBeforePublish)}
              onChange={(checked) => setDraft({ ...draft, verification: { ...draft.verification, verifyBeforePublish: checked } })}
              title="Pause for review before publish"
              description="Use this when ADE may post, patch, or publish something you want to approve first."
            />
          </div>

          {draft.verification.verifyBeforePublish ? (
            <label className="space-y-1 block">
              <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">Review behavior</div>
              <select
                className={INPUT_CLS}
                style={INPUT_STYLE}
                value={draft.verification.mode ?? "intervention"}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    verification: {
                      ...draft.verification,
                      mode: event.target.value as AutomationRuleDraft["verification"]["mode"],
                    },
                  })
                }
              >
                {VERIFICATION_MODE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <HelperText>
                {(VERIFICATION_MODE_OPTIONS.find((option) => option.value === (draft.verification.mode ?? "intervention")) ?? VERIFICATION_MODE_OPTIONS[0]!).description}
              </HelperText>
            </label>
          ) : null}
        </SectionCard>

        <SectionCard
          title="Advanced"
          description="Most automations can ignore this. Open it only when you need extra context, extra tool access, or older compatibility behavior."
        >
          <div className="space-y-3">
            <AdvancedPanel
              title="Extra tools"
              description="Defaults usually work. Add or remove tool access only when the automation needs something specific."
              defaultOpen={customToolSelection}
            >
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {TOOL_OPTIONS.map((tool) => {
                  const active = draft.toolPalette.includes(tool.value);
                  return (
                    <label
                      key={tool.value}
                      className="flex items-start gap-3 rounded-lg p-3"
                      style={{ background: "#0B0A0F", border: active ? "1px solid rgba(167,139,250,0.6)" : "1px solid #1E1B26" }}
                    >
                      <input
                        type="checkbox"
                        checked={active}
                        onChange={(event) => {
                          const next = event.target.checked
                            ? [...draft.toolPalette, tool.value]
                            : draft.toolPalette.filter((value) => value !== tool.value);
                          setDraft({ ...draft, toolPalette: [...new Set(next)] });
                        }}
                        className="mt-1 accent-[#A78BFA]"
                      />
                      <div className="space-y-1">
                        <div className="text-xs font-semibold text-[#FAFAFA]">{tool.label}</div>
                        <div className="text-[11px] leading-5 text-[#8B8B9A]">{tool.description}</div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </AdvancedPanel>

            <AdvancedPanel
              title="Extra context"
              description="These sources help ADE reason better, but they also make the setup heavier. Only turn on what the prompt really needs."
              defaultOpen={customContextSelection}
            >
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {CONTEXT_OPTIONS.map((option) => {
                  const active = draft.contextSources.some((source) => source.type === option.value);
                  return (
                    <label
                      key={option.value}
                      className="flex items-start gap-3 rounded-lg p-3"
                      style={{ background: "#0B0A0F", border: active ? "1px solid rgba(167,139,250,0.6)" : "1px solid #1E1B26" }}
                    >
                      <input
                        type="checkbox"
                        checked={active}
                        onChange={(event) => {
                          const next = event.target.checked
                            ? [...draft.contextSources, { type: option.value }]
                            : draft.contextSources.filter((source) => source.type !== option.value);
                          setDraft({ ...draft, contextSources: next });
                        }}
                        className="mt-1 accent-[#A78BFA]"
                      />
                      <div className="space-y-1">
                        <div className="text-xs font-semibold text-[#FAFAFA]">{option.label}</div>
                        <div className="text-[11px] leading-5 text-[#8B8B9A]">{option.description}</div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </AdvancedPanel>

            <AdvancedPanel
              title="Legacy follow-up actions"
              description="Older rules can still chain test or shell actions here. New rules usually leave this empty."
              defaultOpen={legacyActions.length > 0}
            >
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <HelperText>Only use this for backwards compatibility with older rule flows.</HelperText>
                  <select
                    className="h-7 px-2 font-mono text-[9px] text-[#FAFAFA]"
                    style={INPUT_STYLE}
                    value=""
                    onChange={(event) => {
                      if (event.target.value) addLegacyAction(event.target.value);
                      event.currentTarget.value = "";
                    }}
                  >
                    <option value="">Add legacy action...</option>
                    <option value="predict-conflicts">Predict conflicts</option>
                    <option value="run-tests">Run tests</option>
                    <option value="run-command">Run command</option>
                  </select>
                </div>

                {legacyActions.map((action: any, index) => (
                  <div key={`${action.type}-${index}`} className="space-y-2 rounded-lg p-3" style={{ background: "#0B0A0F", border: "1px solid #1E1B26" }}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-xs font-semibold text-[#FAFAFA]">{action.type}</div>
                      <Button size="sm" variant="ghost" onClick={() => removeLegacyAction(index)}>
                        Remove
                      </Button>
                    </div>

                    {action.type === "run-command" ? (
                      <textarea
                        className="min-h-[72px] w-full p-2 text-xs font-mono text-[#FAFAFA]"
                        style={INPUT_STYLE}
                        value={action.command ?? ""}
                        onChange={(event) => updateLegacyAction(index, { command: event.target.value })}
                        placeholder="npm test"
                      />
                    ) : null}

                    {action.type === "run-tests" ? (
                      <select
                        className={INPUT_CLS}
                        style={INPUT_STYLE}
                        value={action.suite ?? ""}
                        onChange={(event) => updateLegacyAction(index, { suite: event.target.value })}
                      >
                        <option value="">Select suite</option>
                        {suites.map((suite) => (
                          <option key={suite.id} value={suite.id}>
                            {suite.name || suite.id}
                          </option>
                        ))}
                      </select>
                    ) : null}
                  </div>
                ))}
              </div>
            </AdvancedPanel>
          </div>
        </SectionCard>

        <ConfirmationsChecklist
          required={requiredConfirmations}
          accepted={acceptedConfirmations}
          onToggle={(key, checked) => {
            const next = new Set(acceptedConfirmations);
            if (checked) next.add(key);
            else next.delete(key);
            setAcceptedConfirmations(next);
          }}
        />
      </div>
    </div>
  );
}

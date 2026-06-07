import { useEffect, useMemo, useRef } from "react";
import {
  Calendar,
  CheckCircle,
  Cpu,
  FileText,
  Flag,
  FloppyDisk,
  Flask,
  GitBranch,
  GithubLogo,
  Lightning,
  ListChecks,
  Sparkle,
  Tag,
  TreeStructure,
  Warning,
  WebhooksLogo,
} from "@phosphor-icons/react";
import type { ElementType } from "react";
import type {
  AutomationAction,
  AutomationDraftConfirmationRequirement,
  AutomationDraftIssue,
  AutomationIngressStatus,
  AutomationLaneMode,
  AutomationLaneNamePreset,
  AutomationRuleDraft,
  AutomationTrigger,
  TestSuiteDefinition,
} from "../../../../shared/types";
import { isWebhookGatewayTriggerType } from "../../../../shared/types";
import { Button } from "../../ui/Button";
import { Chip } from "../../ui/Chip";
import { cn } from "../../ui/cn";
import { cardCls, inputCls, labelCls, selectCls, textareaCls } from "../designTokens";
import { GitHubTriggerFilters } from "../GitHubTriggerFilters";
import { LinearTriggerFilters } from "../LinearTriggerFilters";
import { ActionList } from "../ActionList";
import type { ActionRowValue } from "../ActionRow";
import { INPUT_CLS, INPUT_STYLE } from "../shared";

type TriggerFamily =
  | "manual"
  | "schedule"
  | "github"
  | "linear"
  | "local-git"
  | "file-change"
  | "lane"
  | "session"
  | "webhook";

const TRIGGER_FAMILIES: Array<{
  value: TriggerFamily;
  label: string;
  icon: ElementType;
  accent: string;
  hint: string;
}> = [
  { value: "github", label: "GitHub", icon: GithubLogo, accent: "#A78BFA", hint: "Pull requests, issues, comments" },
  { value: "linear", label: "Linear", icon: Tag, accent: "#5E6AD2", hint: "Issues, status changes" },
  { value: "schedule", label: "Schedule", icon: Calendar, accent: "#22D3EE", hint: "Cron — runs on a clock" },
  { value: "local-git", label: "Local git", icon: GitBranch, accent: "#F59E0B", hint: "Commits, pushes" },
  { value: "file-change", label: "File change", icon: FileText, accent: "#34D399", hint: "Watches paths in the repo" },
  { value: "lane", label: "Lane", icon: TreeStructure, accent: "#7DD3FC", hint: "Lane lifecycle events" },
  { value: "session", label: "Session", icon: Cpu, accent: "#94A3B8", hint: "Agent session ends" },
  { value: "webhook", label: "Webhook", icon: WebhooksLogo, accent: "#F472B6", hint: "External events" },
  { value: "manual", label: "Manual", icon: Lightning, accent: "#FACC15", hint: "Run on click only" },
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
    { value: "linear.issue_labeled", label: "Issue labeled" },
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
    { value: "github-webhook", label: "GitHub event" },
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

const LANE_NAME_PRESETS: Array<{
  value: AutomationLaneNamePreset;
  label: string;
  template: string;
  helpEvent: "issue" | "pr" | "any";
}> = [
  { value: "issue-title", label: "Use issue title", template: "{{trigger.issue.title}}", helpEvent: "issue" },
  { value: "issue-num-title", label: "Issue #N – Title", template: "#{{trigger.issue.number}} – {{trigger.issue.title}}", helpEvent: "issue" },
  { value: "pr-title-author", label: "PR title – Author", template: "{{trigger.pr.title}} – {{trigger.pr.author}}", helpEvent: "pr" },
  { value: "custom", label: "Custom template…", template: "", helpEvent: "any" },
];

type DraftLaneMode = AutomationLaneMode | (string & {});

function presetTemplate(preset: AutomationLaneNamePreset, customTemplate: string | undefined): string {
  if (preset === "custom") return customTemplate ?? "";
  return LANE_NAME_PRESETS.find((p) => p.value === preset)?.template ?? "";
}

function triggerSampleContext(trigger: AutomationTrigger): {
  issue?: { number: number; title: string; author: string; url: string; body: string };
  pr?: { number: number; title: string; author: string; url: string };
} {
  const t = trigger.type;
  if (t.startsWith("github.issue") || t.startsWith("linear.issue")) {
    return {
      issue: {
        number: 427,
        title: "Fix login bug on Safari",
        author: "octocat",
        url: "https://github.com/example/repo/issues/427",
        body: "Repro: open site in Safari 17, sign in...",
      },
    };
  }
  if (t.startsWith("github.pr")) {
    return {
      pr: {
        number: 314,
        title: "Add caching to image pipeline",
        author: "octocat",
        url: "https://github.com/example/repo/pull/314",
      },
    };
  }
  return {};
}

// Editor-only resolver. Real `{{trigger.*}}` resolution happens server-side via
// `resolvePlaceholders` — this is just a live preview so the user sees what
// their template will look like.
function previewResolve(
  template: string,
  sample: Record<string, unknown>,
): { resolved: string; missing: string[] } {
  const missing: string[] = [];
  const resolved = template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const segments = path.split(".");
    if (segments[0] !== "trigger") {
      missing.push(path);
      return `<missing ${path}>`;
    }
    let cursor: unknown = sample;
    for (let i = 1; i < segments.length; i++) {
      if (cursor && typeof cursor === "object" && segments[i]! in (cursor as Record<string, unknown>)) {
        cursor = (cursor as Record<string, unknown>)[segments[i]!];
      } else {
        missing.push(path);
        return `<missing ${path}>`;
      }
    }
    return String(cursor ?? "");
  });
  return { resolved, missing };
}

function smartDefaultsForTrigger(type: AutomationTrigger["type"]): {
  laneMode: AutomationLaneMode;
  preset: AutomationLaneNamePreset | undefined;
} {
  if (type === "github.issue_opened" || type === "linear.issue_created") {
    return { laneMode: "create", preset: "issue-title" };
  }
  if (type === "github.pr_opened") {
    return { laneMode: "create", preset: "pr-title-author" };
  }
  return { laneMode: "reuse", preset: undefined };
}

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

function readLaneMode(draft: AutomationRuleDraft): DraftLaneMode {
  const raw = (draft.execution as { laneMode?: unknown } | undefined)?.laneMode;
  return typeof raw === "string" && raw.trim() ? (raw.trim() as DraftLaneMode) : "reuse";
}

function isRequireLaneAtRunTimeMode(mode: DraftLaneMode | null | undefined): boolean {
  return mode === "require-on-trigger" || mode === "provided" || mode === "prompt-at-run";
}

function humanizeLaneMode(mode: string): string {
  return mode
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
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

// --- draft <-> ActionRow[] bridge ---

type ActionRowRuntimeOptions = Pick<ActionRowValue, "targetLaneId" | "condition" | "continueOnFailure" | "timeoutMs" | "retry">;
type AutomationActionRuntimeOptions = Pick<AutomationAction, "targetLaneId" | "condition" | "continueOnFailure" | "timeoutMs" | "retry">;

function actionRuntimeOptions(action: AutomationAction): Partial<ActionRowRuntimeOptions> {
  return {
    ...(action.targetLaneId ? { targetLaneId: action.targetLaneId } : {}),
    ...(action.condition ? { condition: action.condition } : {}),
    ...(typeof action.continueOnFailure === "boolean" ? { continueOnFailure: action.continueOnFailure } : {}),
    ...(Number.isFinite(action.timeoutMs) ? { timeoutMs: action.timeoutMs } : {}),
    ...(Number.isFinite(action.retry) ? { retry: action.retry } : {}),
  };
}

function rowRuntimeOptions(row: ActionRowValue): Partial<AutomationActionRuntimeOptions> {
  return {
    ...(row.targetLaneId ? { targetLaneId: row.targetLaneId } : {}),
    ...(row.condition?.trim() ? { condition: row.condition.trim() } : {}),
    ...(row.continueOnFailure ? { continueOnFailure: true } : {}),
    ...(Number.isFinite(row.timeoutMs) ? { timeoutMs: row.timeoutMs } : {}),
    ...(Number.isFinite(row.retry) ? { retry: row.retry } : {}),
  };
}

function rowHasRuntimeOptions(row: ActionRowValue): boolean {
  return Boolean(
    row.targetLaneId
      || row.condition?.trim()
      || row.continueOnFailure
      || Number.isFinite(row.timeoutMs)
      || Number.isFinite(row.retry),
  );
}

function stripActionTargetLaneId<T extends { targetLaneId?: string | null }>(action: T): Omit<T, "targetLaneId"> {
  const { targetLaneId: _targetLaneId, ...rest } = action;
  return rest;
}

function stripActionTargetLaneIdsFromDraft(draft: AutomationRuleDraft): AutomationRuleDraft {
  const execution = draft.execution ? { ...draft.execution } : undefined;
  if (execution) delete execution.targetLaneId;
  if (execution?.kind === "built-in") {
    execution.builtIn = {
      actions: (execution.builtIn?.actions ?? []).map((action) => stripActionTargetLaneId(action) as AutomationAction),
    };
  }
  return {
    ...draft,
    ...(execution ? { execution } : {}),
    actions: draft.actions.map((action) => stripActionTargetLaneId(action) as AutomationRuleDraft["actions"][number]),
    legacyActions: draft.legacyActions?.map((action) => stripActionTargetLaneId(action) as AutomationRuleDraft["actions"][number]),
  };
}

function draftToActionRows(draft: AutomationRuleDraft): ActionRowValue[] {
  const rows: ActionRowValue[] = [];
  const execution = draft.execution;
  if (execution?.kind === "agent-session") {
    rows.push({
      kind: "agent-session",
      prompt: draft.prompt ?? "",
      sessionTitle: execution.session?.title ?? "",
      fastMode: execution.session?.fastMode === true,
    });
  } else if (execution?.kind === "built-in") {
    for (const action of execution.builtIn?.actions ?? []) {
      if (action.type === "create-lane") {
        rows.push({
          kind: "create-lane",
          laneNameTemplate: action.laneNameTemplate ?? "",
          laneDescriptionTemplate: action.laneDescriptionTemplate ?? "",
          parentLaneId: action.parentLaneId ?? null,
          ...actionRuntimeOptions(action),
        });
      } else if (action.type === "run-tests") {
        rows.push({ kind: "run-tests", suiteId: action.suiteId ?? "", ...actionRuntimeOptions(action) });
      } else if (action.type === "run-command") {
        rows.push({ kind: "run-command", command: action.command ?? "", cwd: action.cwd ?? "", ...actionRuntimeOptions(action) });
      } else if (action.type === "predict-conflicts") {
        rows.push({ kind: "predict-conflicts", ...actionRuntimeOptions(action) });
      } else if (action.type === "ade-action") {
        rows.push({ kind: "ade-action", adeAction: action.adeAction ?? { domain: "", action: "" }, ...actionRuntimeOptions(action) });
      } else if (action.type === "agent-session") {
        rows.push({
          kind: "agent-session",
          prompt: action.prompt ?? "",
          sessionTitle: action.sessionTitle ?? "",
          modelConfig: action.modelConfig,
          fastMode: action.fastMode === true,
          permissionConfig: action.permissionConfig,
          ...actionRuntimeOptions(action),
        });
      }
    }
  }
  return rows;
}

function applyActionRowsToDraft(draft: AutomationRuleDraft, rows: ActionRowValue[]): AutomationRuleDraft {
  const rowsForSave = isRequireLaneAtRunTimeMode(readLaneMode(draft))
    ? rows.map((row) => stripActionTargetLaneId(row) as ActionRowValue)
    : rows;
  const soloAgent = rowsForSave.length === 1 && rowsForSave[0]!.kind === "agent-session" && !rowHasRuntimeOptions(rowsForSave[0]!);

  if (soloAgent) {
    const first = rowsForSave[0]!;
    const previousSession = draft.execution?.kind === "agent-session"
      ? draft.execution.session ?? {}
      : {};
    const previousSessionWithoutFastMode = { ...previousSession };
    delete previousSessionWithoutFastMode.fastMode;
    return {
      ...draft,
      execution: {
        ...(draft.execution ?? { kind: "agent-session" }),
        kind: "agent-session",
        session: {
          ...previousSessionWithoutFastMode,
          title: first.sessionTitle || null,
          ...(first.fastMode === true ? { fastMode: true } : {}),
        },
      },
      ...(first.modelConfig ? { modelConfig: first.modelConfig } : {}),
      ...(first.permissionConfig ? { permissionConfig: first.permissionConfig } : {}),
      prompt: first.prompt ?? "",
      actions: [],
      legacyActions: [],
    };
  }

  const builtInActions: AutomationAction[] = rowsForSave.map((row) => rowToAutomationAction(row));
  const legacyDraftActions: AutomationRuleDraft["actions"] = builtInActions
    .map((action) => automationActionToDraftAction(action))
    .filter((entry): entry is AutomationRuleDraft["actions"][number] => entry != null);

  return {
    ...draft,
    execution: {
      ...(draft.execution ?? { kind: "built-in" }),
      kind: "built-in",
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
        ...rowRuntimeOptions(row),
        ...(row.laneNameTemplate ? { laneNameTemplate: row.laneNameTemplate } : {}),
        ...(row.laneDescriptionTemplate ? { laneDescriptionTemplate: row.laneDescriptionTemplate } : {}),
        ...(row.parentLaneId ? { parentLaneId: row.parentLaneId } : {}),
      };
    case "run-tests":
      return { type: "run-tests", ...rowRuntimeOptions(row), suiteId: row.suiteId ?? "" };
    case "run-command":
      return {
        type: "run-command",
        ...rowRuntimeOptions(row),
        command: row.command ?? "",
        ...(row.cwd ? { cwd: row.cwd } : {}),
      };
    case "predict-conflicts":
      return { type: "predict-conflicts", ...rowRuntimeOptions(row) };
    case "ade-action":
      return {
        type: "ade-action",
        ...rowRuntimeOptions(row),
        adeAction: row.adeAction ?? { domain: "", action: "" },
      };
    case "agent-session":
      return {
        type: "agent-session",
        ...rowRuntimeOptions(row),
        ...(row.modelConfig ? { modelConfig: row.modelConfig } : {}),
        ...(row.fastMode === true ? { fastMode: true } : {}),
        ...(row.permissionConfig ? { permissionConfig: row.permissionConfig } : {}),
        ...(row.prompt ? { prompt: row.prompt } : {}),
        ...(row.sessionTitle ? { sessionTitle: row.sessionTitle } : {}),
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
        ...rowRuntimeOptions(actionToRow(action)),
        ...(action.laneNameTemplate ? { laneNameTemplate: action.laneNameTemplate } : {}),
        ...(action.laneDescriptionTemplate ? { laneDescriptionTemplate: action.laneDescriptionTemplate } : {}),
        ...(action.parentLaneId ? { parentLaneId: action.parentLaneId } : {}),
      };
    case "run-tests":
      return { type: "run-tests", ...rowRuntimeOptions(actionToRow(action)), suite: action.suiteId ?? "" };
    case "run-command":
      return {
        type: "run-command",
        ...rowRuntimeOptions(actionToRow(action)),
        command: action.command ?? "",
        ...(action.cwd ? { cwd: action.cwd } : {}),
      };
    case "predict-conflicts":
      return { type: "predict-conflicts", ...rowRuntimeOptions(actionToRow(action)) };
    case "ade-action":
      return {
        type: "ade-action",
        ...rowRuntimeOptions(actionToRow(action)),
        adeAction: action.adeAction ?? { domain: "", action: "" },
      };
    case "agent-session":
      return {
        type: "agent-session",
        ...rowRuntimeOptions(actionToRow(action)),
        ...(action.modelConfig ? { modelConfig: action.modelConfig } : {}),
        ...(action.fastMode === true ? { fastMode: true } : {}),
        ...(action.permissionConfig ? { permissionConfig: action.permissionConfig } : {}),
        ...(action.prompt ? { prompt: action.prompt } : {}),
        ...(action.sessionTitle ? { sessionTitle: action.sessionTitle } : {}),
      };
    case "lane-setup":
      // Synthetic action emitted by the runtime when execution.laneMode is
      // "create"; never authored by the user, so it has no draft form.
      return null;
  }
}

function actionToRow(action: AutomationAction): ActionRowValue {
  return { kind: action.type === "lane-setup" ? "predict-conflicts" : action.type, ...actionRuntimeOptions(action) } as ActionRowValue;
}

// --- component ---

export function RuleEditorPanel({
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
  saving,
  simulating = false,
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
  saving: boolean;
  simulating?: boolean;
}) {
  const primaryTrigger = ensurePrimaryTrigger(draft);
  const triggerFamily = triggerFamilyForType(primaryTrigger.type);
  const needsWebhookGateway = isWebhookGatewayTriggerType(primaryTrigger.type);
  const webhookGateway = ingressStatus?.webhookGateway ?? null;
  const webhookGatewayReady = webhookGateway?.ready === true;
  const triggerOptions = TRIGGER_OPTIONS[triggerFamily];
  const triggerMeta =
    TRIGGER_FAMILIES.find((family) => family.value === triggerFamily) ?? TRIGGER_FAMILIES[0]!;

  const actionRows = useMemo(() => draftToActionRows(draft), [draft]);

  // laneMode resolution: missing → "reuse" (server-side migration handles
  // legacy create-lane-as-first-action collapse).
  const laneMode = readLaneMode(draft);
  const lanePreset: AutomationLaneNamePreset = draft.execution?.laneNamePreset ?? "issue-title";
  const laneCustomTemplate = draft.execution?.laneNameTemplate ?? "";
  const laneTargetLaneId = draft.execution?.targetLaneId ?? null;

  // Tracks whether the user has manually edited the lane mode/preset. Smart
  // defaults only fire on trigger event change while this stays false.
  const laneDirtyRef = useRef(false);

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

  const patchExecution = (
    patch: Partial<{
      laneMode: DraftLaneMode;
      targetLaneId: string | null;
      laneNamePreset: AutomationLaneNamePreset;
      laneNameTemplate: string;
    }>,
  ) => {
    const current = draft.execution ?? { kind: "agent-session" as const };
    const next = { ...current };
    if (patch.laneMode !== undefined) (next as { laneMode?: string }).laneMode = patch.laneMode;
    if (patch.laneNamePreset !== undefined) next.laneNamePreset = patch.laneNamePreset;
    if (patch.laneNameTemplate !== undefined) next.laneNameTemplate = patch.laneNameTemplate;
    if (patch.targetLaneId !== undefined) {
      if (patch.targetLaneId == null) delete next.targetLaneId;
      else next.targetLaneId = patch.targetLaneId;
    }
    const nextDraft = { ...draft, execution: next };
    setDraft(isRequireLaneAtRunTimeMode(next.laneMode) ? stripActionTargetLaneIdsFromDraft(nextDraft) : nextDraft);
  };
  // Smart defaults: when the trigger event changes and the user hasn't yet
  // manually adjusted lane mode/preset, snap to a sensible default. We key on
  // the trigger type so switching from "Issue opened" to "Issue closed"
  // doesn't auto-reset a user choice they're happy with.
  const lastTriggerTypeRef = useRef<AutomationTrigger["type"]>(primaryTrigger.type);
  useEffect(() => {
    if (lastTriggerTypeRef.current === primaryTrigger.type) return;
    lastTriggerTypeRef.current = primaryTrigger.type;
    if (laneDirtyRef.current) return;
    const defaults = smartDefaultsForTrigger(primaryTrigger.type);
    patchExecution({
      laneMode: defaults.laneMode,
      ...(defaults.preset !== undefined ? { laneNamePreset: defaults.preset } : {}),
    });
    // patchExecution closes over draft; intentionally narrowing deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryTrigger.type]);

  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");
  const successNotes = simulationNotes ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Sticky top bar */}
      <div className="shrink-0 border-b border-white/[0.10] bg-[#111C2B]/92 px-5 py-3 backdrop-blur">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[15px] font-semibold text-[#F5FAFF]">
              <Flag size={14} weight="fill" style={{ color: triggerMeta.accent }} />
              {draft.id ? "Edit automation" : "New automation"}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <AccentBadge accent={triggerMeta.accent}>{triggerLabel(primaryTrigger)}</AccentBadge>
              <Chip className="text-[9px]">
                {actionRows.length} step{actionRows.length === 1 ? "" : "s"}
              </Chip>
              <AccentBadge accent={draft.enabled ? "#34D399" : "#7E8A9A"}>
                {draft.enabled ? "enabled" : "disabled"}
              </AccentBadge>
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

      {/* Body — one readable setup flow, not competing scroll columns. */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-[#101826]">
        <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-4 px-5 py-5">
            {errors.length ? <IssueList title="Errors" issues={errors} tone="error" /> : null}
            {warnings.length ? <IssueList title="Notes" issues={warnings} tone="warning" /> : null}
            {successNotes.length ? <SuccessNotice notes={successNotes} /> : null}
            <ConfirmationsChecklist
              required={requiredConfirmations}
              accepted={acceptedConfirmations}
              onToggle={onToggleConfirmation}
            />

            {/* Identity */}
            <Section icon={Tag} accent="#7DD3FC" title="Identity" hint="Name and describe this rule">
              <div className="space-y-3">
                <input
                  className={INPUT_CLS}
                  style={INPUT_STYLE}
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  placeholder="e.g. Triage new GitHub issues"
                />
                <textarea
                  className={cn(textareaCls, "min-h-[76px] text-[12px] leading-relaxed")}
                  value={draft.description ?? ""}
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                  placeholder="What this rule is for"
                />
                <Toggle
                  label="Enabled"
                  hint={draft.enabled ? "Rule will run when its trigger fires" : "Rule is paused"}
                  checked={draft.enabled}
                  onChange={(next) => setDraft({ ...draft, enabled: next })}
                />
              </div>
            </Section>

            {/* Trigger */}
            <Section icon={triggerMeta.icon} accent={triggerMeta.accent} title="Trigger" hint={triggerMeta.hint}>
              <div className="space-y-3">
                <div className="grid grid-cols-3 gap-1.5">
                  {TRIGGER_FAMILIES.map((family) => {
                    const Icon = family.icon;
                    const active = family.value === triggerFamily;
                    return (
                      <button
                        key={family.value}
                        type="button"
                        onClick={() => setTriggerFamily(family.value)}
                        className={cn(
                          "flex flex-col items-center gap-1 rounded-lg border px-2 py-2 text-[10px] font-semibold transition-colors",
                          active
                            ? "text-[#F5FAFF]"
                            : "border-white/[0.12] bg-[#152235] text-[#B9C7DA] hover:border-white/[0.20] hover:text-[#F8FAFC]",
                        )}
                        style={
                          active
                            ? { borderColor: `${family.accent}66`, background: `${family.accent}1a` }
                            : undefined
                        }
                        title={family.hint}
                      >
                        <Icon size={14} weight={active ? "fill" : "regular"} style={{ color: family.accent }} />
                        {family.label}
                      </button>
                    );
                  })}
                </div>

                {triggerOptions.length > 1 ? (
                  <label className="block space-y-1">
                    <SmallLabel>Event</SmallLabel>
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
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}

                {needsWebhookGateway ? <WebhookGatewayCallout ready={webhookGatewayReady} status={webhookGateway} /> : null}

                <div className="rounded-lg border border-white/[0.12] bg-[#111C2B] p-2.5">
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
                    <div className="text-[11px] text-[#B9C7DA]">Runs after any agent session ends.</div>
                  ) : triggerFamily === "webhook" ? (
                    <WebhookFields trigger={primaryTrigger} onPatch={patchTrigger} />
                  ) : (
                    <div className="text-[11px] text-[#B9C7DA]">Runs only when you click Run now.</div>
                  )}
                </div>
              </div>
            </Section>

            {/* Execution — how this rule resolves a lane per run */}
            <Section icon={GitBranch} accent="#2DD4BF" title="Execution" hint="How runs land in lanes">
              <div className="space-y-3">
                <LaneModeControl
                  laneMode={laneMode}
                  targetLaneId={laneTargetLaneId}
                  lanes={lanes}
                  onChange={(patch) => {
                    laneDirtyRef.current = true;
                    patchExecution(patch);
                  }}
                />
                {laneMode === "create" ? (
                  <LaneCreatePanel
                    preset={lanePreset}
                    customTemplate={laneCustomTemplate}
                    trigger={primaryTrigger}
                    onChange={(patch) => {
                      laneDirtyRef.current = true;
                      patchExecution(patch);
                    }}
                  />
                ) : null}
              </div>
            </Section>

          <Section
            icon={ListChecks}
            accent="#22D3EE"
            title="Workflow steps"
            hint={`${actionRows.length} step${actionRows.length === 1 ? "" : "s"} — runs top to bottom`}
            dense
          >
            <ActionList
              actions={actionRows}
              lanes={lanes}
              suites={suites}
              onChange={setActionRows}
            />
          </Section>
        </div>
      </div>
    </div>
  );
}

// --- helpers ---

function LaneModeControl({
  laneMode,
  targetLaneId,
  lanes,
  onChange,
}: {
  laneMode: DraftLaneMode;
  targetLaneId: string | null;
  lanes: Array<{ id: string; name: string }>;
  onChange: (patch: { laneMode?: DraftLaneMode; targetLaneId?: string | null }) => void;
}) {
  const knownMode = laneMode === "create"
    || laneMode === "reuse"
    || laneMode === "provided"
    || laneMode === "prompt-at-run"
    || laneMode === "require-on-trigger";
  const selectValue = laneMode === "create"
    ? "create"
    : laneMode === "provided" || laneMode === "prompt-at-run" || laneMode === "require-on-trigger"
      ? "require-on-trigger"
      : laneMode === "reuse"
        ? `reuse:${targetLaneId ?? ""}`
        : `unknown:${laneMode}`;
  const sortedLanes = useMemo(() => [...lanes].sort((a, b) => a.name.localeCompare(b.name)), [lanes]);

  return (
    <label className="block space-y-1.5">
      <div className={labelCls}>Lane</div>
      <select
        className={selectCls}
        value={selectValue}
        onChange={(event) => {
          const v = event.target.value;
          if (v === "create") {
            onChange({ laneMode: "create", targetLaneId: null });
            return;
          }
          if (v === "require-on-trigger") {
            onChange({ laneMode: "require-on-trigger", targetLaneId: null });
            return;
          }
          if (v === "reuse:") {
            onChange({ laneMode: "reuse", targetLaneId: null });
            return;
          }
          if (v.startsWith("reuse:")) {
            onChange({ laneMode: "reuse", targetLaneId: v.slice("reuse:".length) });
          }
        }}
      >
        <option value="create">Create new lane per run</option>
        <option value="require-on-trigger">Require lane at run time</option>
        <option value="__sep__" disabled>──────</option>
        <option value="reuse:">Reuse primary lane</option>
        {sortedLanes.map((lane) => (
          <option key={lane.id} value={`reuse:${lane.id}`}>{lane.name}</option>
        ))}
        {!knownMode ? (
          <option value={`unknown:${laneMode}`} disabled>
            Backend mode: {humanizeLaneMode(laneMode)}
          </option>
        ) : null}
      </select>
    </label>
  );
}

function LaneCreatePanel({
  preset,
  customTemplate,
  trigger,
  onChange,
}: {
  preset: AutomationLaneNamePreset;
  customTemplate: string;
  trigger: AutomationTrigger;
  onChange: (patch: { laneNamePreset?: AutomationLaneNamePreset; laneNameTemplate?: string }) => void;
}) {
  const sample = useMemo(() => triggerSampleContext(trigger), [trigger]);
  const triggerKind: "issue" | "pr" | "any" = sample.issue ? "issue" : sample.pr ? "pr" : "any";
  const template = presetTemplate(preset, customTemplate);
  const preview = useMemo(
    () => previewResolve(template, sample as Record<string, unknown>),
    [template, sample],
  );

  // Surface a warning when the active preset references a field the trigger
  // cannot supply (e.g. issue-title with a PR trigger). Editor-side only —
  // server-side resolution will throw at runtime if the user saves anyway.
  const presetMeta = LANE_NAME_PRESETS.find((p) => p.value === preset);
  const presetMismatch =
    preset !== "custom"
    && presetMeta?.helpEvent !== "any"
    && presetMeta?.helpEvent !== triggerKind
    && triggerKind !== "any";

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-[#2DD4BF]/25 bg-[#111C2B] p-3">
      <div className="flex items-center gap-2 text-[11px] text-[#9BE7D8]">
        <Sparkle size={12} weight="fill" />
        <span className="font-medium">A fresh lane is created for every run.</span>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="block space-y-1.5">
          <div className={labelCls}>Naming</div>
          <select
            className={selectCls}
            value={preset}
            onChange={(event) => onChange({ laneNamePreset: event.target.value as AutomationLaneNamePreset })}
          >
            {LANE_NAME_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </label>

        {preset === "custom" ? (
          <label className="block space-y-1.5">
            <div className={labelCls}>Template</div>
            <input
              className={inputCls}
              value={customTemplate}
              onChange={(event) => onChange({ laneNameTemplate: event.target.value })}
              placeholder="{{trigger.issue.author}}/{{trigger.issue.title}}"
            />
          </label>
        ) : null}
      </div>

      <div className="rounded-md border border-white/[0.12] bg-[#152235] px-3 py-2">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.08em] text-[#AFC0D4]">
          <GitBranch size={10} weight="regular" />
          <span>Preview</span>
        </div>
        <div className="mt-1 break-all font-mono text-[11px] text-[#F8FAFC]">
          {preview.resolved.trim() || (
            <span className="text-[#94A3B8]">(empty — pick a preset or enter a template)</span>
          )}
        </div>
      </div>

      {presetMismatch ? (
        <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-[11px] text-warning">
          <Warning size={12} weight="regular" className="mt-0.5 shrink-0" />
          <span>
            This preset reads a {presetMeta?.helpEvent === "issue" ? "GitHub / Linear issue" : "GitHub PR"} field, but the selected trigger doesn't supply one. The run will fail unless you switch presets.
          </span>
        </div>
      ) : null}

      <p className="text-[11px] leading-relaxed text-[#AFC0D4]">
        Lane names auto-disambiguate by appending the issue / PR number if a duplicate exists.
      </p>
    </div>
  );
}

function WebhookGatewayCallout({
  ready,
  status,
}: {
  ready: boolean;
  status: AutomationIngressStatus["webhookGateway"] | null;
}) {
  const label = ready ? "Webhook gateway online" : "Webhook gateway required";
  const detail = ready
    ? status?.publicUrl
      ? `Events will arrive through ${status.publicUrl}.`
      : "Events can reach this ADE runtime."
    : status?.tailscale.available
      ? "Internal builds can start ingress from the ADE CLI before enabling this trigger."
      : "Internal builds need Tailscale available before ADE CLI ingress can expose this runtime.";
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-3 rounded-lg border px-3 py-2.5",
        ready
          ? "border-emerald-300/25 bg-emerald-300/10 text-emerald-100"
          : "border-amber-300/25 bg-amber-300/10 text-amber-100",
      )}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-[12px] font-semibold">
          {ready ? <CheckCircle size={13} weight="fill" /> : <Warning size={13} weight="regular" />}
          {label}
        </div>
        <div className="mt-1 break-words text-[11px] leading-relaxed opacity-90">{detail}</div>
      </div>
    </div>
  );
}

function Section({
  icon: Icon,
  accent,
  title,
  hint,
  children,
  dense,
  fill,
}: {
  icon: ElementType;
  accent: string;
  title: string;
  hint?: string;
  children: React.ReactNode;
  dense?: boolean;
  fill?: boolean;
}) {
  return (
    <section
      className={cn(
        "overflow-hidden rounded-xl border border-white/[0.12] bg-[#162235] shadow-[0_18px_45px_rgba(0,0,0,0.18)]",
        fill ? "flex min-h-0 flex-1 flex-col" : "",
      )}
    >
      <div className="flex items-center gap-2 border-b border-white/[0.10] bg-[#1B2A40] px-4 py-3">
        <div
          className="flex h-7 w-7 items-center justify-center rounded-md"
          style={{ background: `${accent}1f`, color: accent, boxShadow: `inset 0 0 0 1px ${accent}33` }}
        >
          <Icon size={14} weight="fill" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-[#F8FAFC]">{title}</div>
          {hint ? <div className="text-[11px] text-[#AFC0D4]">{hint}</div> : null}
        </div>
      </div>
      <div className={cn(dense ? "p-3" : "p-4", fill && "min-h-0 flex-1 overflow-visible")}>
        {children}
      </div>
    </section>
  );
}

function SmallLabel({ children }: { children: React.ReactNode }) {
  return <span className="text-[10px] uppercase tracking-[1px] text-[#8FA1B8]">{children}</span>;
}

function AccentBadge({ accent, children }: { accent: string; children: React.ReactNode }) {
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[1px] rounded"
      style={{ color: accent, background: `${accent}1a`, border: `1px solid ${accent}55` }}
    >
      {children}
    </span>
  );
}

function SuccessNotice({ notes }: { notes: string[] }) {
  return (
    <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-100">
      <div className="flex items-center gap-1.5 font-semibold">
        <CheckCircle size={13} weight="fill" />
        Simulation ready
      </div>
      <ul className="mt-1 space-y-0.5">
        {notes.map((note, index) => (
          <li key={`${note}-${index}`}>{note}</li>
        ))}
      </ul>
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-white/[0.12] bg-[#152235] px-3 py-2 text-[12px] text-[#E6EEF8] hover:border-white/[0.20]">
      <span className="min-w-0 flex-1">
        <span className="block">{label}</span>
        {hint ? <span className="block text-[10px] text-[#AFC0D4]">{hint}</span> : null}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-3.5 w-3.5 accent-[#7DD3FC]"
      />
    </label>
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
        "rounded-xl px-3 py-2 text-[11px]",
        tone === "error"
          ? "border border-red-500/30 bg-red-500/10 text-red-200"
          : "border border-amber-500/25 bg-amber-500/10 text-amber-200",
      )}
    >
      <div className="font-semibold">{title}</div>
      <ul className="mt-1 space-y-0.5">
        {issues.map((issue, index) => (
          <li key={`${issue.path}-${index}`}>
            <span className="font-mono text-[10px] text-fg/80">{issue.path}</span>: {issue.message}
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
    <div className={cardCls}>
      <div className="text-xs font-semibold text-fg">Confirm before saving</div>
      <div className="mt-2 space-y-2">
        {required.map((requirement) => (
          <label key={requirement.key} className="flex items-start gap-2 text-[11px] text-fg/80">
            <input
              type="checkbox"
              checked={accepted.has(requirement.key)}
              onChange={(event) => onToggle(requirement.key, event.target.checked)}
              className="mt-0.5 accent-accent"
            />
            <span>
              <span className={cn("font-semibold", requirement.severity === "danger" ? "text-error" : "text-warning")}>
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
    <div className="space-y-2">
      <label className="block space-y-1">
        <SmallLabel>Preset</SmallLabel>
        <select
          className={selectCls}
          value={selectedPreset}
          onChange={(event) => onPatch({ cron: event.target.value || trigger.cron || "" })}
        >
          <option value="">Custom</option>
          {SCHEDULE_PRESETS.map((preset) => (
            <option key={preset.cron} value={preset.cron}>
              {preset.label}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1">
        <SmallLabel>Cron expression</SmallLabel>
        <input
          className={inputCls}
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
    <label className="block space-y-1">
      <SmallLabel>Branch</SmallLabel>
      <input
        className={inputCls}
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
    <label className="block space-y-1">
      <SmallLabel>Paths (comma separated globs)</SmallLabel>
      <input
        className={inputCls}
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
    <label className="block space-y-1">
      <SmallLabel>Name pattern</SmallLabel>
      <input
        className={inputCls}
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
      <label className="block space-y-1">
        <SmallLabel>Event name</SmallLabel>
        <input
          className={inputCls}
          value={trigger.event ?? ""}
          onChange={(event) => onPatch({ event: event.target.value })}
          placeholder="pull_request"
        />
      </label>
      <label className="block space-y-1">
        <SmallLabel>Secret ref</SmallLabel>
        <input
          className={inputCls}
          value={trigger.secretRef ?? ""}
          onChange={(event) => onPatch({ secretRef: event.target.value })}
          placeholder="github-webhook"
        />
      </label>
    </div>
  );
}

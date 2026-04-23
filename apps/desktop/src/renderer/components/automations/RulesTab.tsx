import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowClockwise,
  BookOpen,
  ClockCounterClockwise,
  PencilSimple,
  Play,
  Plus,
  Trash,
} from "@phosphor-icons/react";
import { motion } from "motion/react";
import { getDefaultModelDescriptor } from "../../../shared/modelRegistry";
import type {
  AutomationDraftConfirmationRequirement,
  AutomationDraftIssue,
  AutomationRuleDraft,
  AutomationRuleSummary,
  LaneSummary,
  TestSuiteDefinition,
} from "../../../shared/types";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { cn } from "../ui/cn";
import { formatDate, statusToneAutomation as statusTone } from "../../lib/format";
import { CARD_STYLE, extractError, INPUT_CLS, INPUT_STYLE } from "./shared";
import { RuleEditorPanel } from "./components/RuleEditorPanel";
import { RuleHistoryPanel } from "./RuleHistoryPanel";
import { CtoInfoChip, EmptyStateHint } from "./EmptyStateHint";

const DEFAULT_MODEL_ID =
  getDefaultModelDescriptor("opencode")?.id
  ?? getDefaultModelDescriptor("claude")?.id
  ?? "anthropic/claude-sonnet-4-6";

function createBlankDraft(): AutomationRuleDraft {
  return {
    name: "",
    description: "",
    enabled: true,
    mode: "review",
    triggers: [{ type: "manual" }],
    trigger: { type: "manual" },
    execution: { kind: "agent-session", session: {} },
    executor: { mode: "automation-bot" },
    modelConfig: {
      orchestratorModel: { modelId: DEFAULT_MODEL_ID, thinkingLevel: "medium" },
    },
    permissionConfig: {
      providers: {
        claude: "full-auto",
        codex: "default",
        opencode: "full-auto",
        codexSandbox: "workspace-write",
      },
    },
    prompt: "",
    reviewProfile: "quick",
    toolPalette: ["repo", "git", "memory", "mission"],
    contextSources: [{ type: "project-memory" }, { type: "procedures" }],
    memory: { mode: "automation-plus-project" },
    guardrails: { maxDurationMin: 20 },
    outputs: { disposition: "comment-only", createArtifact: true },
    verification: { verifyBeforePublish: false, mode: "intervention" },
    billingCode: "auto:new-automation",
    actions: [],
    legacyActions: [],
  };
}

function toDraftFromRule(rule: AutomationRuleSummary): AutomationRuleDraft {
  const builtInActions = rule.execution?.kind === "built-in"
    ? rule.execution.builtIn?.actions ?? []
    : [];
  const draftActions = builtInActions.map((action) => {
    if (action.type === "run-tests") {
      return { type: action.type, suite: action.suiteId ?? "" } as any;
    }
    if (action.type === "run-command") {
      return { type: action.type, command: action.command ?? "", ...(action.cwd ? { cwd: action.cwd } : {}) } as any;
    }
    if (action.type === "ade-action") {
      return {
        type: action.type,
        adeAction: action.adeAction
          ? {
              domain: action.adeAction.domain ?? "",
              action: action.adeAction.action ?? "",
              ...(action.adeAction.args !== undefined ? { args: action.adeAction.args } : {}),
              ...(action.adeAction.resolvers ? { resolvers: action.adeAction.resolvers } : {}),
            }
          : { domain: "", action: "" },
      } as any;
    }
    if (action.type === "agent-session") {
      return {
        type: action.type,
        ...(action.prompt ? { prompt: action.prompt } : {}),
        ...(action.sessionTitle ? { sessionTitle: action.sessionTitle } : {}),
      } as any;
    }
    return { type: action.type } as any;
  });
  return {
    id: rule.id,
    name: rule.name,
    description: rule.description ?? "",
    enabled: rule.enabled,
    mode: rule.mode,
    triggers: rule.triggers.map((trigger) => ({ ...trigger })),
    trigger: rule.trigger ? { ...rule.trigger } : { ...(rule.triggers[0] ?? { type: "manual" }) },
    execution: rule.execution ? structuredClone(rule.execution) : undefined,
    executor: { mode: "automation-bot" },
    modelConfig: rule.modelConfig ? structuredClone(rule.modelConfig) : undefined,
    permissionConfig: rule.permissionConfig ? structuredClone(rule.permissionConfig) : undefined,
    templateId: rule.templateId,
    prompt: rule.prompt ?? "",
    reviewProfile: rule.reviewProfile,
    toolPalette: [...rule.toolPalette],
    contextSources: rule.contextSources.map((source) => ({ ...source })),
    memory: { ...rule.memory },
    guardrails: { ...rule.guardrails },
    outputs: { ...rule.outputs },
    verification: { ...rule.verification },
    billingCode: rule.billingCode,
    actions: draftActions as any,
    legacyActions: draftActions as any,
  };
}

function primaryTriggerLabel(rule: AutomationRuleSummary): string {
  const trigger = rule.triggers[0] ?? rule.trigger;
  if (!trigger) return "manual";
  if (trigger.type === "schedule") return trigger.cron?.trim() ? `schedule · ${trigger.cron}` : "schedule";
  if (trigger.type === "git.pr_merged" && trigger.targetBranch?.trim()) return `${trigger.type} · ${trigger.targetBranch.trim()}`;
  if (trigger.branch?.trim()) return `${trigger.type} · ${trigger.branch.trim()}`;
  if (trigger.team?.trim()) return `${trigger.type} · ${trigger.team.trim()}`;
  if (trigger.project?.trim()) return `${trigger.type} · ${trigger.project.trim()}`;
  return trigger.type;
}

function executionLabel(rule: AutomationRuleSummary): string {
  if (rule.execution?.kind === "mission") return "Mission";
  if (rule.execution?.kind === "built-in") return "Built-in";
  return "Agent session";
}

function modeSummary(rule: AutomationRuleSummary): string {
  return [rule.mode, rule.reviewProfile, rule.modelConfig?.orchestratorModel.modelId ?? null].filter(Boolean).join(" · ");
}

function RuleListRow({
  rule,
  selected,
  onSelect,
  onToggle,
  onOpenHistory,
  onRunNow,
  onDelete,
}: {
  rule: AutomationRuleSummary;
  selected: boolean;
  onSelect: () => void;
  onToggle: (enabled: boolean) => void;
  onOpenHistory: () => void;
  onRunNow: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "group w-full cursor-pointer rounded-xl border px-3 py-3 text-left transition-colors focus:outline-none focus:ring-1 focus:ring-[#7DD3FC]/45",
        selected
          ? "border-[#7DD3FC]/35 bg-[#13263A]"
          : "border-white/[0.08] bg-black/15 hover:border-white/[0.14]",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="truncate text-sm font-semibold text-[#F5FAFF]">{rule.name}</div>
            <Chip className={cn("text-[9px]", statusTone(rule.running ? "running" : rule.lastRunStatus))}>
              {rule.running ? "running" : rule.lastRunStatus ?? "idle"}
            </Chip>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Chip className="text-[9px]">{primaryTriggerLabel(rule)}</Chip>
            <Chip className="text-[9px]">{executionLabel(rule)}</Chip>
          </div>
          <div className="mt-2 text-[11px] text-[#94A7BD]">{modeSummary(rule)}</div>
          <div className="mt-1 text-[11px] text-[#7E8A9A]">
            Next {formatDate(rule.nextRunAt, "on demand")} · Last {formatDate(rule.lastRunAt, "never")}
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          <label className="flex items-center gap-1 text-[10px] uppercase tracking-[1px] text-[#8FA1B8]">
            <input
              type="checkbox"
              checked={rule.enabled}
              onChange={(event) => {
                event.stopPropagation();
                onToggle(event.target.checked);
              }}
              onClick={(event) => event.stopPropagation()}
              className="accent-[#7DD3FC]"
            />
            {rule.enabled ? "on" : "off"}
          </label>
          <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onOpenHistory();
              }}
              className="rounded p-1 text-[#8FA1B8] transition-colors hover:text-[#F5FAFF]"
              title="Open history"
            >
              <ClockCounterClockwise size={13} weight="regular" />
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onRunNow();
              }}
              className="rounded p-1 text-[#8FA1B8] transition-colors hover:text-[#F5FAFF]"
              title="Run now"
            >
              <Play size={13} weight="regular" />
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onDelete();
              }}
              className="rounded p-1 text-[#8FA1B8] transition-colors hover:text-red-200"
              title="Delete"
            >
              <Trash size={13} weight="regular" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

type DetailView = "editor" | "history";

export function RulesTab({
  pendingDraft,
  onDraftConsumed,
  onOpenTemplates,
  missionsEnabled,
}: {
  pendingDraft: AutomationRuleDraft | null;
  onDraftConsumed: () => void;
  onOpenTemplates: () => void;
  missionsEnabled: boolean;
}) {
  const [detailView, setDetailView] = useState<DetailView>("editor");
  const [rules, setRules] = useState<AutomationRuleSummary[]>([]);
  const [lanes, setLanes] = useState<LaneSummary[]>([]);
  const [suites, setSuites] = useState<TestSuiteDefinition[]>([]);
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AutomationRuleDraft | null>(null);
  const [issues, setIssues] = useState<AutomationDraftIssue[]>([]);
  const [requiredConfirmations, setRequiredConfirmations] = useState<AutomationDraftConfirmationRequirement[]>([]);
  const [acceptedConfirmations, setAcceptedConfirmations] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [simulating, setSimulating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configTrustRequired, setConfigTrustRequired] = useState(false);
  const loadRef = useRef<(() => Promise<void>) | null>(null);
  // Snapshot of the last-saved (or last-loaded-from-rule) draft, used to detect
  // unsaved edits when the user navigates away from the editor.
  const savedSnapshotRef = useRef<string | null>(null);
  const isDirty = useMemo(() => {
    if (!draft) return false;
    if (savedSnapshotRef.current == null) return false;
    return JSON.stringify(draft) !== savedSnapshotRef.current;
    // savedSnapshotRef is a ref so linter can't track it; draft is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const confirmDiscardIfDirty = useCallback((): boolean => {
    if (!isDirty) return true;
    const ok = window.confirm("You have unsaved changes. Discard them and continue?");
    if (ok && savedSnapshotRef.current != null) {
      try {
        setDraft(JSON.parse(savedSnapshotRef.current) as AutomationRuleDraft);
        setIssues([]);
      } catch {
        // Snapshot was malformed — leave the draft as-is rather than crashing.
      }
    }
    return ok;
  }, [isDirty]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextRules, nextSuites, nextLanes, snapshot] = await Promise.all([
        window.ade.automations.list(),
        window.ade.tests.listSuites(),
        window.ade.lanes.list({ includeArchived: false, includeStatus: false }),
        window.ade.projectConfig.get(),
      ]);
      setRules(nextRules);
      setSuites(nextSuites);
      setLanes(nextLanes);
      setConfigTrustRequired(Boolean(snapshot.trust.requiresSharedTrust));
      setSelectedRuleId((current) => {
        if (current && nextRules.some((rule) => rule.id === current)) return current;
        return nextRules[0]?.id ?? null;
      });
    } catch (err) {
      setError(extractError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  loadRef.current = refresh;

  useEffect(() => {
    void refresh();
    const unsubscribe = window.ade.automations.onEvent(() => {
      void loadRef.current?.();
    });
    return () => {
      try {
        unsubscribe();
      } catch {
        // ignore
      }
    };
  }, [refresh]);

  useEffect(() => {
    if (!pendingDraft) return;
    setSelectedRuleId(null);
    setDraft(pendingDraft);
    // A template-seeded draft counts as a new unsaved rule — null snapshot so
    // isDirty stays false until the user edits.
    savedSnapshotRef.current = JSON.stringify(pendingDraft);
    setIssues([]);
    setRequiredConfirmations([]);
    setAcceptedConfirmations(new Set());
    onDraftConsumed();
  }, [onDraftConsumed, pendingDraft]);

  useEffect(() => {
    if (selectedRuleId == null) return;
    const selected = rules.find((rule) => rule.id === selectedRuleId);
    if (!selected) return;
    const nextDraft = toDraftFromRule(selected);
    setDraft(nextDraft);
    savedSnapshotRef.current = JSON.stringify(nextDraft);
    setIssues([]);
    setRequiredConfirmations([]);
    setAcceptedConfirmations(new Set());
  }, [rules, selectedRuleId]);

  const filteredRules = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return rules;
    return rules.filter((rule) => {
      return [
        rule.name,
        rule.id,
        primaryTriggerLabel(rule),
        executionLabel(rule),
        rule.mode,
        rule.reviewProfile,
      ].some((value) => value.toLowerCase().includes(query));
    });
  }, [rules, search]);

  const validateDraft = useCallback(async (nextDraft: AutomationRuleDraft) => {
    const result = await window.ade.automations.validateDraft({
      draft: nextDraft,
      confirmations: [...acceptedConfirmations],
    });
    setIssues(result.issues);
    setRequiredConfirmations(result.requiredConfirmations);
    return result;
  }, [acceptedConfirmations]);

  const saveDraft = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const validation = await validateDraft(draft);
      if (!validation.ok) return;
      const saved = await window.ade.automations.saveDraft({
        draft,
        confirmations: [...acceptedConfirmations],
      });
      setRules(saved.rules);
      setSelectedRuleId(saved.rule.id);
      const nextSelected = saved.rules.find((rule) => rule.id === saved.rule.id) ?? null;
      const nextDraft = nextSelected ? toDraftFromRule(nextSelected) : createBlankDraft();
      setDraft(nextDraft);
      savedSnapshotRef.current = JSON.stringify(nextDraft);
      setIssues([]);
    } catch (err) {
      setError(extractError(err));
    } finally {
      setSaving(false);
    }
  }, [acceptedConfirmations, draft, validateDraft]);

  const simulateDraft = useCallback(async () => {
    if (!draft) return;
    setSimulating(true);
    setError(null);
    try {
      const result = await window.ade.automations.simulate({ draft });
      setIssues(result.issues);
      if (!result.issues.length) {
        setIssues([
          {
            level: "warning",
            path: "simulate",
            message: result.notes.join(" · ") || "Simulation completed with no blocking issues.",
          },
        ]);
      }
    } catch (err) {
      setError(extractError(err));
    } finally {
      setSimulating(false);
    }
  }, [draft]);

  const createRule = () => {
    if (!confirmDiscardIfDirty()) return;
    setSelectedRuleId(null);
    const blank = createBlankDraft();
    setDraft(blank);
    savedSnapshotRef.current = JSON.stringify(blank);
    setIssues([]);
    setRequiredConfirmations([]);
    setAcceptedConfirmations(new Set());
    setDetailView("editor");
  };

  const runRuleNow = useCallback(async (ruleId: string) => {
    setError(null);
    try {
      await window.ade.automations.triggerManually({ id: ruleId });
      await refresh();
    } catch (err) {
      setError(extractError(err));
    }
  }, [refresh]);

  const deleteRule = useCallback(async (ruleId: string) => {
    setError(null);
    try {
      const next = await window.ade.automations.deleteRule({ id: ruleId });
      setRules(next);
      setSelectedRuleId(next[0]?.id ?? null);
      if (!next.length) {
        setDraft(createBlankDraft());
      }
    } catch (err) {
      setError(extractError(err));
    }
  }, []);

  const selectedRule = selectedRuleId ? rules.find((rule) => rule.id === selectedRuleId) ?? null : null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.18 }}
      className="flex h-full min-h-0"
    >
      <div className="flex min-h-0 w-[360px] shrink-0 flex-col border-r border-white/[0.06] bg-black/10">
        <div className="shrink-0 border-b border-white/[0.06] px-4 py-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[15px] font-semibold text-[#F5FAFF]">Rules</div>
              <div className="mt-1 text-sm text-[#93A4B8]">
                Build time-based or action-based automations. This screen only covers rules, execution, and history.
              </div>
            </div>
            <Button size="sm" variant="outline" disabled={loading} onClick={() => void refresh()}>
              <ArrowClockwise size={12} weight="regular" className={cn(loading && "animate-spin")} />
              Refresh
            </Button>
          </div>

          <div className="mt-4 flex items-center gap-2">
            <Button size="sm" variant="primary" data-tour="automations.createTrigger" onClick={createRule}>
              <Plus size={12} weight="regular" />
              New
            </Button>
            <Button size="sm" variant="outline" onClick={onOpenTemplates}>
              <BookOpen size={12} weight="regular" />
              Templates
            </Button>
            <CtoInfoChip />
          </div>

          <input
            className={cn(INPUT_CLS, "mt-4")}
            style={INPUT_STYLE}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search rules"
          />
        </div>

        {configTrustRequired ? (
          <div className="shrink-0 border-b border-amber-500/20 bg-amber-500/10 px-4 py-3 text-xs text-amber-100">
            Shared project config is untrusted. Confirm trust before ADE can run shared automation rules.
          </div>
        ) : null}

        {error ? (
          <div className="shrink-0 border-b border-red-500/20 bg-red-500/10 px-4 py-3 text-xs text-red-200">
            {error}
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {filteredRules.length === 0 ? (
            <EmptyStateHint />
          ) : (
            <div className="space-y-3">
              {filteredRules.map((rule) => (
                <RuleListRow
                  key={rule.id}
                  rule={rule}
                  selected={rule.id === selectedRuleId}
                  onSelect={() => {
                    if (rule.id !== selectedRuleId && !confirmDiscardIfDirty()) return;
                    setSelectedRuleId(rule.id);
                    setDetailView("editor");
                  }}
                  onOpenHistory={() => {
                    if (!confirmDiscardIfDirty()) return;
                    setSelectedRuleId(rule.id);
                    setDetailView("history");
                  }}
                  onToggle={(enabled) => {
                    window.ade.automations.toggle({ id: rule.id, enabled }).then(setRules).catch((err) => setError(extractError(err)));
                  }}
                  onRunNow={() => void runRuleNow(rule.id)}
                  onDelete={() => void deleteRule(rule.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {selectedRule ? (
          <div
            className="shrink-0 flex items-center gap-0 border-b border-white/[0.06] bg-white/[0.02] px-3"
            style={{ minHeight: 36 }}
          >
            <DetailTab
              active={detailView === "editor"}
              label="Editor"
              icon={PencilSimple}
              onClick={() => setDetailView("editor")}
            />
            <DetailTab
              active={detailView === "history"}
              label="History"
              icon={ClockCounterClockwise}
              onClick={() => {
                if (confirmDiscardIfDirty()) setDetailView("history");
              }}
            />
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-hidden">
          {detailView === "history" && selectedRule ? (
            <RuleHistoryPanel automationId={selectedRule.id} ruleName={selectedRule.name} />
          ) : draft ? (
            <RuleEditorPanel
              draft={draft}
              setDraft={setDraft}
              lanes={lanes.map((lane) => ({ id: lane.id, name: lane.name }))}
              suites={suites}
              missionsEnabled={missionsEnabled}
              issues={issues}
              requiredConfirmations={requiredConfirmations}
              acceptedConfirmations={acceptedConfirmations}
              onToggleConfirmation={(key, checked) => {
                setAcceptedConfirmations((current) => {
                  const next = new Set(current);
                  if (checked) next.add(key);
                  else next.delete(key);
                  return next;
                });
              }}
              onSave={() => void saveDraft()}
              onSimulate={() => void simulateDraft()}
              saving={saving}
              simulating={simulating}
            />
          ) : (
            <div className="flex h-full items-center justify-center px-6">
              <div className="max-w-md rounded-2xl p-6 text-center" style={CARD_STYLE}>
                <div className="text-[17px] font-semibold text-[#F5FAFF]">Create an automation</div>
                <div className="mt-2 text-sm leading-relaxed text-[#93A4B8]">
                  Start with a schedule or a product event, then tell ADE whether it should run a built-in task, send a prompt to an automation chat thread, or launch a mission.
                </div>
                <div className="mt-4 flex justify-center gap-2">
                  <Button size="sm" variant="primary" onClick={createRule}>
                    <Plus size={12} weight="regular" />
                    New rule
                  </Button>
                  <Button size="sm" variant="outline" onClick={onOpenTemplates}>
                    <BookOpen size={12} weight="regular" />
                    Browse templates
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}

function DetailTab({
  active,
  label,
  icon: Icon,
  onClick,
}: {
  active: boolean;
  label: string;
  icon: React.ElementType;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold transition-colors border-b-2",
        active
          ? "border-b-[#7DD3FC] text-[#F5FAFF]"
          : "border-b-transparent text-[#8FA1B8] hover:text-[#F5FAFF]",
      )}
    >
      <Icon size={12} weight={active ? "bold" : "regular"} />
      {label}
    </button>
  );
}

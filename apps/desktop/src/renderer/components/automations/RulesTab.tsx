import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowClockwise,
  ClockCounterClockwise,
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
import { EmptyState } from "../ui/EmptyState";
import { cn } from "../ui/cn";
import { formatDate, statusToneAutomation as statusTone } from "../../lib/format";
import { CARD_STYLE, extractError, INPUT_CLS, INPUT_STYLE } from "./shared";
import { RuleEditorPanel } from "./components/RuleEditorPanel";

const DEFAULT_MODEL_ID =
  getDefaultModelDescriptor("unified")?.id
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
        codex: "full-auto",
        unified: "full-auto",
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
    : (rule.legacy?.actions ?? rule.actions ?? []);
  const draftActions = builtInActions.map((action) => {
    if (action.type === "run-tests") {
      return { type: action.type, suite: action.suiteId ?? "" } as any;
    }
    if (action.type === "run-command") {
      return { type: action.type, command: action.command ?? "", ...(action.cwd ? { cwd: action.cwd } : {}) } as any;
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
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "group w-full rounded-xl border px-3 py-3 text-left transition-colors",
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
    </button>
  );
}

type RulesTabHistorySelection = {
  automationId?: string | null;
  runId?: string | null;
};

export function RulesTab({
  pendingDraft,
  onDraftConsumed,
  onOpenHistory,
}: {
  pendingDraft: AutomationRuleDraft | null;
  onDraftConsumed: () => void;
  onOpenHistory: (selection: RulesTabHistorySelection) => void;
}) {
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
    setIssues([]);
    setRequiredConfirmations([]);
    setAcceptedConfirmations(new Set());
    onDraftConsumed();
  }, [onDraftConsumed, pendingDraft]);

  useEffect(() => {
    if (selectedRuleId == null) return;
    const selected = rules.find((rule) => rule.id === selectedRuleId);
    if (!selected) return;
    setDraft(toDraftFromRule(selected));
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
      setDraft(nextSelected ? toDraftFromRule(nextSelected) : createBlankDraft());
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
    setSelectedRuleId(null);
    setDraft(createBlankDraft());
    setIssues([]);
    setRequiredConfirmations([]);
    setAcceptedConfirmations(new Set());
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

          <div className="mt-4 flex gap-2">
            <Button size="sm" variant="primary" onClick={createRule}>
              <Plus size={12} weight="regular" />
              New rule
            </Button>
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
            <EmptyState
              title="No rules yet"
              description="Create your first automation rule or start from a template."
            />
          ) : (
            <div className="space-y-3">
              {filteredRules.map((rule) => (
                <RuleListRow
                  key={rule.id}
                  rule={rule}
                  selected={rule.id === selectedRuleId}
                  onSelect={() => setSelectedRuleId(rule.id)}
                  onOpenHistory={() => onOpenHistory({ automationId: rule.id })}
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

      <div className="min-h-0 flex-1 overflow-hidden">
        {draft ? (
          <RuleEditorPanel
            draft={draft}
            setDraft={setDraft}
            lanes={lanes.map((lane) => ({ id: lane.id, name: lane.name }))}
            suites={suites}
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
        ) : selectedRule ? null : (
          <div className="flex h-full items-center justify-center px-6">
            <div className="max-w-md rounded-2xl p-6 text-center" style={CARD_STYLE}>
              <div className="text-[17px] font-semibold text-[#F5FAFF]">Create an automation</div>
              <div className="mt-2 text-sm leading-relaxed text-[#93A4B8]">
                Start with a schedule or a product event, then tell ADE whether it should run a built-in task, send a prompt to an automation chat thread, or launch a mission.
              </div>
              <Button size="sm" variant="primary" className="mt-4" onClick={createRule}>
                <Plus size={12} weight="regular" />
                New rule
              </Button>
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}

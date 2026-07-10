import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { ClockCounterClockwise, PencilSimple, Play } from "@phosphor-icons/react";
import { getDefaultModelDescriptor } from "../../../shared/modelRegistry";
import type {
  AutomationDraftConfirmationRequirement,
  AutomationDraftIssue,
  AutomationIngressStatus,
  AutomationRuleDraft,
  AutomationRuleSummary,
  LaneSummary,
  TestSuiteDefinition,
} from "../../../shared/types";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { extractError } from "./shared";
import { inputCls } from "./designTokens";
import { buildRuleSentence } from "./automationCopy";
import { actionToDraftAction } from "./builder/draftBridge";
import { RuleList } from "./list/RuleList";
import { RuleBuilder } from "./builder/RuleBuilder";
import { RuleHistory } from "./history/RuleHistory";

const DEFAULT_MODEL_ID =
  getDefaultModelDescriptor("opencode")?.id
  ?? getDefaultModelDescriptor("claude")?.id
  ?? "anthropic/claude-sonnet-5";

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
    modelConfig: { modelId: DEFAULT_MODEL_ID, thinkingLevel: "medium" },
    prompt: "",
    reviewProfile: "quick",
    toolPalette: ["repo", "git"],
    contextSources: [],
    guardrails: { maxDurationMin: 20 },
    outputs: { disposition: "comment-only", createArtifact: true },
    verification: { verifyBeforePublish: false, mode: "intervention" },
    billingCode: "auto:new-automation",
    actions: [],
    legacyActions: [],
  };
}

function toDraftFromRule(rule: AutomationRuleSummary): AutomationRuleDraft {
  const builtInActions = rule.execution?.kind === "built-in" ? rule.execution.builtIn?.actions ?? [] : [];
  // The normalizer rebuilds the chain from draft.actions, so it must carry the
  // draft-union shape (e.g. run-tests `suite`), not the runtime shape.
  const draftActions = builtInActions
    .map(actionToDraftAction)
    .filter((action): action is NonNullable<typeof action> => action != null);
  return {
    id: rule.id,
    name: rule.name,
    description: rule.description ?? "",
    enabled: rule.enabled,
    mode: rule.mode,
    triggers: rule.triggers.map((t) => ({ ...t })),
    trigger: rule.trigger ? { ...rule.trigger } : { ...(rule.triggers[0] ?? { type: "manual" }) },
    execution: rule.execution ? structuredClone(rule.execution) : undefined,
    executor: { mode: "automation-bot" },
    modelConfig: rule.modelConfig ? structuredClone(rule.modelConfig) : undefined,
    permissionConfig: rule.permissionConfig ? structuredClone(rule.permissionConfig) : undefined,
    templateId: rule.templateId,
    prompt: rule.prompt ?? "",
    reviewProfile: rule.reviewProfile,
    toolPalette: [...rule.toolPalette],
    contextSources: rule.contextSources.map((s) => ({ ...s })),
    guardrails: { ...rule.guardrails },
    outputs: { ...rule.outputs },
    verification: { ...rule.verification },
    billingCode: rule.billingCode,
    actions: draftActions,
    legacyActions: draftActions,
  };
}

function ruleMatchesSearch(rule: AutomationRuleSummary, query: string): boolean {
  const sentence = buildRuleSentence(rule);
  return [rule.name, rule.id, sentence.trigger, ...sentence.steps, rule.mode]
    .some((v) => v.toLowerCase().includes(query));
}

type DetailView = "builder" | "history";

export function AutomationsWorkspace({
  active = true,
  pendingDraft,
  onDraftConsumed,
  onOpenTemplates,
}: {
  active?: boolean;
  pendingDraft: AutomationRuleDraft | null;
  onDraftConsumed: () => void;
  onOpenTemplates: () => void;
}) {
  const [detailView, setDetailView] = useState<DetailView>("builder");
  const [rules, setRules] = useState<AutomationRuleSummary[]>([]);
  const [lanes, setLanes] = useState<LaneSummary[]>([]);
  const [suites, setSuites] = useState<TestSuiteDefinition[]>([]);
  const [ingressStatus, setIngressStatus] = useState<AutomationIngressStatus | null>(null);
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AutomationRuleDraft | null>(null);
  const [issues, setIssues] = useState<AutomationDraftIssue[]>([]);
  const [simulationNotes, setSimulationNotes] = useState<string[]>([]);
  const [requiredConfirmations, setRequiredConfirmations] = useState<AutomationDraftConfirmationRequirement[]>([]);
  const [acceptedConfirmations, setAcceptedConfirmations] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [simulating, setSimulating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualRunRule, setManualRunRule] = useState<AutomationRuleSummary | null>(null);
  const [manualRunLaneId, setManualRunLaneId] = useState<string>("");
  const [manualRunPending, setManualRunPending] = useState(false);
  const manualRunPendingRef = useRef(false);
  const [running, setRunning] = useState(false);
  const [configTrustRequired, setConfigTrustRequired] = useState(false);
  const loadRef = useRef<(() => Promise<void>) | null>(null);
  const savedSnapshotRef = useRef<string | null>(null);

  const isDirty = useMemo(() => {
    if (!draft || savedSnapshotRef.current == null) return false;
    return JSON.stringify(draft) !== savedSnapshotRef.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const confirmDiscardIfDirty = useCallback((): boolean => {
    if (!isDirty) return true;
    const ok = window.confirm("You have unsaved changes. Discard them and continue?");
    if (ok && savedSnapshotRef.current != null) {
      try {
        setDraft(JSON.parse(savedSnapshotRef.current) as AutomationRuleDraft);
        setIssues([]);
        setSimulationNotes([]);
      } catch {
        // Malformed snapshot — leave draft as-is.
      }
    }
    return ok;
  }, [isDirty]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextRules, nextSuites, nextLanes, nextIngress, snapshot] = await Promise.all([
        window.ade.automations.list(),
        window.ade.tests.listSuites(),
        window.ade.lanes.list({ includeArchived: false, includeStatus: false }),
        window.ade.automations.getIngressStatus(),
        window.ade.projectConfig.get(),
      ]);
      setRules(nextRules);
      setSuites(nextSuites);
      setLanes(nextLanes);
      setIngressStatus(nextIngress);
      setConfigTrustRequired(Boolean(snapshot.trust.requiresSharedTrust));
      setSelectedRuleId((current) => {
        if (current && nextRules.some((r) => r.id === current)) return current;
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
    if (!active) return;
    void refresh();
    const unsubscribe = window.ade.automations.onEvent(() => void loadRef.current?.());
    return () => {
      try {
        unsubscribe();
      } catch {
        // ignore
      }
    };
  }, [active, refresh]);

  // Seed a template-provided draft.
  useEffect(() => {
    if (!active || !pendingDraft) return;
    setSelectedRuleId(null);
    setDraft(pendingDraft);
    savedSnapshotRef.current = JSON.stringify(pendingDraft);
    setIssues([]);
    setSimulationNotes([]);
    setRequiredConfirmations([]);
    setAcceptedConfirmations(new Set());
    setDetailView("builder");
    onDraftConsumed();
  }, [active, onDraftConsumed, pendingDraft]);

  // Load the selected rule into the draft. `rules` refreshes on every
  // runs/ingress event, so an unrelated refresh must never clobber edits:
  // reload only while the draft matches its saved snapshot.
  const isDirtyRef = useRef(false);
  useEffect(() => {
    isDirtyRef.current = isDirty;
  }, [isDirty]);
  useEffect(() => {
    if (selectedRuleId == null) return;
    if (isDirtyRef.current) return;
    const selected = rules.find((r) => r.id === selectedRuleId);
    if (!selected) return;
    const nextDraft = toDraftFromRule(selected);
    const serialized = JSON.stringify(nextDraft);
    if (savedSnapshotRef.current === serialized) return;
    setDraft(nextDraft);
    savedSnapshotRef.current = serialized;
    setIssues([]);
    setSimulationNotes([]);
    setRequiredConfirmations([]);
    setAcceptedConfirmations(new Set());
  }, [rules, selectedRuleId]);

  const filteredRules = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return rules;
    return rules.filter((rule) => ruleMatchesSearch(rule, query));
  }, [rules, search]);

  const validateDraft = useCallback(
    async (nextDraft: AutomationRuleDraft) => {
      const result = await window.ade.automations.validateDraft({
        draft: nextDraft,
        confirmations: [...acceptedConfirmations],
      });
      setIssues(result.issues);
      setSimulationNotes([]);
      setRequiredConfirmations(result.requiredConfirmations);
      return result;
    },
    [acceptedConfirmations],
  );

  const saveDraft = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const validation = await validateDraft(draft);
      if (!validation.ok) return;
      const saved = await window.ade.automations.saveDraft({ draft, confirmations: [...acceptedConfirmations] });
      setRules(saved.rules);
      setSelectedRuleId(saved.rule.id);
      const nextSelected = saved.rules.find((r) => r.id === saved.rule.id) ?? null;
      const nextDraft = nextSelected ? toDraftFromRule(nextSelected) : createBlankDraft();
      setDraft(nextDraft);
      savedSnapshotRef.current = JSON.stringify(nextDraft);
      setIssues([]);
      setSimulationNotes([]);
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
      setSimulationNotes(
        result.issues.length ? [] : result.notes.length ? result.notes : ["Dry run completed with no blocking issues."],
      );
    } catch (err) {
      setError(extractError(err));
    } finally {
      setSimulating(false);
    }
  }, [draft]);

  const createRule = useCallback(() => {
    if (!confirmDiscardIfDirty()) return;
    setSelectedRuleId(null);
    const blank = createBlankDraft();
    setDraft(blank);
    savedSnapshotRef.current = JSON.stringify(blank);
    setIssues([]);
    setSimulationNotes([]);
    setRequiredConfirmations([]);
    setAcceptedConfirmations(new Set());
    setDetailView("builder");
  }, [confirmDiscardIfDirty]);

  const runRuleNow = useCallback(
    async (ruleId: string, laneId?: string | null) => {
      if (manualRunPendingRef.current) return;
      manualRunPendingRef.current = true;
      setManualRunPending(true);
      setRunning(true);
      setError(null);
      try {
        await window.ade.automations.triggerManually({ id: ruleId, ...(laneId ? { laneId } : {}) });
        setManualRunRule(null);
        setManualRunLaneId("");
        await refresh();
      } catch (err) {
        setError(extractError(err));
      } finally {
        manualRunPendingRef.current = false;
        setManualRunPending(false);
        setRunning(false);
      }
    },
    [refresh],
  );

  const beginRunRule = useCallback(
    (rule: AutomationRuleSummary) => {
      if (rule.execution?.laneMode === "require-on-trigger") {
        setManualRunRule(rule);
        setManualRunLaneId(lanes[0]?.id ?? "");
        return;
      }
      void runRuleNow(rule.id);
    },
    [lanes, runRuleNow],
  );

  const deleteRule = useCallback(async (ruleId: string) => {
    setError(null);
    try {
      const next = await window.ade.automations.deleteRule({ id: ruleId });
      setRules(next);
      setSelectedRuleId(next[0]?.id ?? null);
      if (!next.length) setDraft(createBlankDraft());
    } catch (err) {
      setError(extractError(err));
    }
  }, []);

  const confirmTrust = useCallback(async () => {
    setError(null);
    try {
      await window.ade.projectConfig.confirmTrust();
      await refresh();
    } catch (err) {
      setError(extractError(err));
    }
  }, [refresh]);

  const selectedRule = selectedRuleId ? rules.find((r) => r.id === selectedRuleId) ?? null : null;
  const delivery = ingressStatus?.delivery ?? null;
  // Computed on the UNFILTERED rules so a search can't hide the trust recovery CTA.
  const sharedTrustBlocked = configTrustRequired && rules.some((rule) => rule.source !== "local");

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }} className="flex h-full min-h-0">
      <RuleList
        rules={filteredRules}
        selectedRuleId={selectedRuleId}
        search={search}
        loading={loading}
        error={error}
        configTrustRequired={sharedTrustBlocked}
        ingressStatus={ingressStatus}
        delivery={delivery}
        onSearch={setSearch}
        onSelect={(id) => {
          if (id !== selectedRuleId && !confirmDiscardIfDirty()) return;
          setSelectedRuleId(id);
          setDetailView("builder");
        }}
        onToggle={(id, enabled) => {
          window.ade.automations
            .toggle({ id, enabled })
            .then(setRules)
            .catch((err) => setError(extractError(err)));
        }}
        onRunNow={beginRunRule}
        onOpenHistory={(id) => {
          if (!confirmDiscardIfDirty()) return;
          setSelectedRuleId(id);
          setDetailView("history");
        }}
        onDelete={(id) => void deleteRule(id)}
        onNew={createRule}
        onOpenTemplates={() => {
          if (confirmDiscardIfDirty()) onOpenTemplates();
        }}
        onUseTemplate={(templateDraft) => {
          if (!confirmDiscardIfDirty()) return;
          setSelectedRuleId(null);
          const seeded = { ...templateDraft } as AutomationRuleDraft;
          setDraft(seeded);
          savedSnapshotRef.current = JSON.stringify(seeded);
          setIssues([]);
          setSimulationNotes([]);
          setRequiredConfirmations([]);
          setAcceptedConfirmations(new Set());
          setDetailView("builder");
        }}
        onRefresh={() => void refresh()}
        onConfirmTrust={() => void confirmTrust()}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {selectedRule ? (
          <div className="flex shrink-0 items-center gap-0 border-b border-white/[0.06] bg-white/[0.01] px-3" style={{ minHeight: 34 }}>
            <DetailTab active={detailView === "builder"} label="Builder" icon={PencilSimple} onClick={() => setDetailView("builder")} />
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
            <RuleHistory automationId={selectedRule.id} ruleName={selectedRule.name} />
          ) : draft ? (
            <RuleBuilder
              draft={draft}
              setDraft={setDraft}
              lanes={lanes.map((l) => ({ id: l.id, name: l.name }))}
              suites={suites}
              ingressStatus={ingressStatus}
              issues={issues}
              simulationNotes={simulationNotes}
              requiredConfirmations={requiredConfirmations}
              acceptedConfirmations={acceptedConfirmations}
              onToggleConfirmation={(key, checked) =>
                setAcceptedConfirmations((current) => {
                  const next = new Set(current);
                  if (checked) next.add(key);
                  else next.delete(key);
                  return next;
                })
              }
              onSave={() => void saveDraft()}
              onSimulate={() => void simulateDraft()}
              onRunNow={selectedRule ? () => beginRunRule(selectedRule) : undefined}
              onIngressChanged={() => void refresh()}
              saving={saving}
              simulating={simulating}
              running={running}
              dirty={isDirty}
            />
          ) : (
            <EmptyDetail onNew={createRule} onOpenTemplates={onOpenTemplates} />
          )}
        </div>
      </div>

      {manualRunRule ? (
        <ManualRunModal
          rule={manualRunRule}
          lanes={lanes}
          laneId={manualRunLaneId}
          pending={manualRunPending}
          onLaneId={setManualRunLaneId}
          onCancel={() => {
            setManualRunRule(null);
            setManualRunLaneId("");
          }}
          onRun={() => void runRuleNow(manualRunRule.id, manualRunLaneId)}
        />
      ) : null}
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
        "flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-[11px] font-semibold transition-colors",
        active ? "border-b-accent text-fg" : "border-b-transparent text-muted-fg/60 hover:text-fg",
      )}
    >
      <Icon size={12} weight={active ? "bold" : "regular"} />
      {label}
    </button>
  );
}

function EmptyDetail({ onNew, onOpenTemplates }: { onNew: () => void; onOpenTemplates: () => void }) {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="max-w-md rounded-xl border border-white/[0.07] bg-white/[0.03] p-6 text-center shadow-card">
        <div className="text-[16px] font-semibold text-fg">Build an automation</div>
        <div className="mt-2 text-sm leading-relaxed text-muted-fg/70">
          Pick a trigger and a workflow, then let ADE run it — on a schedule or when a product event fires.
        </div>
        <div className="mt-4 flex justify-center gap-2">
          <Button size="sm" variant="primary" onClick={onNew}>
            New automation
          </Button>
          <Button size="sm" variant="outline" onClick={onOpenTemplates}>
            Browse templates
          </Button>
        </div>
      </div>
    </div>
  );
}

function ManualRunModal({
  rule,
  lanes,
  laneId,
  pending,
  onLaneId,
  onCancel,
  onRun,
}: {
  rule: AutomationRuleSummary;
  lanes: LaneSummary[];
  laneId: string;
  pending: boolean;
  onLaneId: (id: string) => void;
  onCancel: () => void;
  onRun: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-4">
      <div className="w-full max-w-md rounded-xl border border-white/[0.08] bg-surface-overlay p-4 shadow-float">
        <div className="text-sm font-semibold text-fg">Choose a lane for this run</div>
        <div className="mt-1 text-xs leading-relaxed text-muted-fg/70">{rule.name} requires a lane when triggered.</div>
        <label className="mt-4 block space-y-1.5">
          <span className="text-[10px] uppercase tracking-[0.1em] text-muted-fg/60">Lane</span>
          <select className={inputCls} value={laneId} onChange={(e) => onLaneId(e.target.value)}>
            {lanes.map((lane) => (
              <option key={lane.id} value={lane.id}>
                {lane.name}
              </option>
            ))}
          </select>
        </label>
        {!lanes.length ? (
          <div className="mt-3 rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
            No active lanes are available. Switch the rule to create a lane per run, or create a lane from the Work tab.
          </div>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" disabled={!laneId || pending} onClick={onRun}>
            <Play size={12} weight="fill" />
            Run
          </Button>
        </div>
      </div>
    </div>
  );
}

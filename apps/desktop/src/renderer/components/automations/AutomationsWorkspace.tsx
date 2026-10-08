import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { useSearchParams } from "react-router-dom";
import { ClockCounterClockwise, PencilSimple, Play } from "@phosphor-icons/react";
import { getAppDefaultModelDescriptor, getDefaultModelDescriptor } from "../../../shared/modelRegistry";
import type {
  AiSettingsStatus,
  AutomationDraftConfirmationRequirement,
  AutomationDraftIssue,
  AutomationIngressStatus,
  AutomationRuleDraft,
  AutomationRuleSummary,
  LaneSummary,
  OpenProjectBinding,
  TestSuiteDefinition,
} from "../../../shared/types";
import { Button } from "../ui/Button";
import { confirmDialog } from "../ui/dialog/confirm";
import { Dialog } from "../ui/dialog";
import { Banner } from "../ui/notice/Banner";
import { cn } from "../ui/cn";
import { extractError } from "./shared";
import { inputCls } from "./designTokens";
import { buildRuleSentence } from "./automationCopy";
import { actionToDraftAction } from "./builder/draftBridge";
import { RuleList } from "./list/RuleList";
import { ProjectSidebarSlot, useHasProjectSidebar } from "../app/projectSidebar/ProjectSidebarSlot";
import { RuleBuilder } from "./builder/RuleBuilder";
import { RuleHistory } from "./history/RuleHistory";
import { TemplateGallery } from "./templates/TemplateGallery";
import { RuleMachineField } from "./builder/RuleMachineField";
import { machineRuleKey, useAutomationMachines, type MachineRule } from "./useAutomationMachines";
import type { LaneMachine } from "../../state/laneMachineRouting";
import { onMachine } from "../../state/projectMachines";
import { parseMachineScopedId } from "../../state/foreignMachineReads";
import { selectActiveProjectRoot, useAppStore } from "../../state/appStore";
import { clearStoredAutomationDraft, loadStoredAutomationDraft, storeAutomationDraft } from "./automationDraftStore";

const CHOOSE_MACHINE_HINT = "Choose the machine this automation runs on.";

/** Read on use: the app-wide default can move with model-manifest.json. */
const defaultModelId = (): string =>
  getAppDefaultModelDescriptor()?.id
  ?? getDefaultModelDescriptor("opencode")?.id
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
    modelConfig: { modelId: defaultModelId(), thinkingLevel: "medium" },
    prompt: "",
    reviewProfile: "quick",
    toolPalette: ["repo", "git"],
    contextSources: [],
    guardrails: {},
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

export async function readCursorCloudConnectionForAutomation(
  getStatus: () => Promise<AiSettingsStatus>,
): Promise<boolean> {
  try {
    const status = await getStatus();
    return status?.providerConnections?.cursor?.authAvailable === true;
  } catch {
    // A stale or unavailable AI bridge must not prevent unrelated automation
    // data from loading; it only means the Cursor trigger is unavailable.
    return false;
  }
}

/** "3:42 PM" today, else "Oct 7, 3:42 PM". */
function formatRestoredDraftTime(iso: string): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "earlier";
  const sameDay = at.toDateString() === new Date().toDateString();
  return at.toLocaleString(undefined, sameDay
    ? { hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function AutomationsWorkspace({
  active = true,
  pendingDraft,
  onDraftConsumed,
  onOpenTemplates,
  templatesOpen = false,
  onCloseTemplates,
}: {
  active?: boolean;
  pendingDraft: AutomationRuleDraft | null;
  onDraftConsumed: () => void;
  onOpenTemplates: () => void;
  /** The template gallery fills the main area; the rule list stays put. */
  templatesOpen?: boolean;
  onCloseTemplates?: () => void;
}) {
  const [detailView, setDetailView] = useState<DetailView>("builder");
  const [rules, setRules] = useState<AutomationRuleSummary[]>([]);
  const [lanes, setLanes] = useState<LaneSummary[]>([]);
  const [suites, setSuites] = useState<TestSuiteDefinition[]>([]);
  const [ingressStatus, setIngressStatus] = useState<AutomationIngressStatus | null>(null);
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
  // True while a new, unsaved draft is open. "Nothing selected" is also the
  // first-load state, where a refresh picks the first rule; without this, the
  // next background refresh (automation events fire often) replaced a new
  // draft with that rule a moment after New automation was pressed.
  const draftingNewRef = useRef(false);
  useEffect(() => {
    if (selectedRuleId) draftingNewRef.current = false;
  }, [selectedRuleId]);
  // `?rule=<id>` (from Settings → Linear → ADE agent) opens that rule once it loads.
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedRuleId = searchParams.get("rule");
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
  const [cursorCloudConnected, setCursorCloudConnected] = useState(false);
  const loadRef = useRef<(() => Promise<void>) | null>(null);
  const savedSnapshotRef = useRef<string | null>(null);
  const projectRoot = useAppStore(selectActiveProjectRoot);
  /** True once the first rule list has loaded, so a stored draft can find its rule. */
  const [rulesLoadedOnce, setRulesLoadedOnce] = useState(false);
  /** Set once the stored draft was restored or found absent; persisting waits for it. */
  const draftRestoreDoneRef = useRef(false);
  /** When the restored draft was last edited; shown until it is saved or discarded. */
  const [restoredDraftAt, setRestoredDraftAt] = useState<string | null>(null);

  // ── Machines ────────────────────────────────────────────────
  const {
    machines,
    boundMachine,
    entryByKey,
    entryByRule,
    entries,
    machineOfRule,
    foreignRuleKeyState,
    blockedReason,
    commitMachineRules,
    lanesForMachine,
    loads: foreignLoads,
    refreshForeign,
    refreshMachine,
  } = useAutomationMachines({ active, rules, setRules, lanes });
  /**
   * The machine the open draft belongs to; null = the tab's machine. Captured
   * as the full machine (with its pin) so a save always goes to the machine the
   * draft was opened on, even if the union momentarily drops it.
   */
  const [draftTarget, setDraftTarget] = useState<LaneMachine | null>(null);
  /**
   * False while a new draft has no machine yet: the "Runs on" field is empty
   * and Save is blocked. The machine is always chosen, never defaulted.
   */
  const [draftMachineChosen, setDraftMachineChosen] = useState(true);
  /**
   * Where the selected saved rule lives today. A different `draftTarget` means
   * Save moves it. Null for a new draft; a null machine is the tab's own.
   */
  const [draftOrigin, setDraftOrigin] = useState<{ machine: LaneMachine | null } | null>(null);
  const loadedRuleKeyRef = useRef<string | null>(null);
  const [draftMachineSuites, setDraftMachineSuites] = useState<TestSuiteDefinition[] | null>(null);
  const [draftMachineIngress, setDraftMachineIngress] = useState<AutomationIngressStatus | null>(null);
  /** Bumped to re-read the draft machine's suites and ingress status. */
  const [draftMachineReadNonce, setDraftMachineReadNonce] = useState(0);

  const allRules = useMemo(() => entries.map((entry) => entry.rule), [entries]);
  const ruleKeyOf = useCallback(
    (rule: AutomationRuleSummary) => entryByRule.get(rule)?.key ?? rule.id,
    [entryByRule],
  );
  const foreignRuleKeyStateRef = useRef(foreignRuleKeyState);
  foreignRuleKeyStateRef.current = foreignRuleKeyState;

  // A saved rule pointed at another machine is an unsaved change (a move).
  const draftMoving = Boolean(draftOrigin && (draftOrigin.machine?.machineId ?? null) !== (draftTarget?.machineId ?? null));
  const isDirty = useMemo(() => {
    if (!draft || savedSnapshotRef.current == null) return false;
    return draftMoving || JSON.stringify(draft) !== savedSnapshotRef.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, draftMoving]);

  const confirmDiscardIfDirty = useCallback(async (): Promise<boolean> => {
    if (!isDirty) return true;
    const ok = await confirmDialog({
      title: "You have unsaved changes.",
      message: "Discard them and continue?",
      confirmLabel: "Discard",
      destructive: true,
    });
    // Discarding a pending move puts the rule back on its machine.
    if (ok && draftOrigin) setDraftTarget(draftOrigin.machine);
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
  }, [draftOrigin, isDirty]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextRules, nextSuites, nextLanes, nextIngress, _projectConfig, aiStatus] = await Promise.all([
        window.ade.automations.list(),
        window.ade.tests.listSuites(),
        window.ade.lanes.list({ includeArchived: false, includeStatus: false }),
        window.ade.automations.getIngressStatus(),
        window.ade.projectConfig.get(),
        Promise.resolve()
          .then(() => readCursorCloudConnectionForAutomation(() => window.ade.ai.getStatus())),
      ]);
      setRules(nextRules);
      setSuites(nextSuites);
      setLanes(nextLanes);
      setIngressStatus(nextIngress);
      setCursorCloudConnected(aiStatus);
      setRulesLoadedOnce(true);
      setSelectedRuleId((current) => {
        // A rule on another machine stays selected while that machine can still
        // list it; this refresh only speaks for the tab's own rules.
        if (current && (nextRules.some((r) => r.id === current) || foreignRuleKeyStateRef.current(current) !== "gone")) {
          return current;
        }
        if (!current && draftingNewRef.current) return null;
        return nextRules[0]?.id ?? null;
      });
    } catch (err) {
      setCursorCloudConnected(false);
      setError(extractError(err));
    } finally {
      setLoading(false);
    }
  }, []);
  loadRef.current = refresh;

  // A selected rule on another machine falls back only once that machine has
  // answered without it, or has left.
  useEffect(() => {
    if (!selectedRuleId || rules.some((rule) => rule.id === selectedRuleId)) return;
    if (!parseMachineScopedId(selectedRuleId) || foreignRuleKeyState(selectedRuleId) !== "gone") return;
    setSelectedRuleId(rules[0]?.id ?? null);
  }, [foreignRuleKeyState, rules, selectedRuleId]);

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

  /**
   * A new draft names its machine in the recipe ("Runs on"), not in a popup.
   * It starts unchosen unless exactly one machine can take it.
   */
  const machinesRef = useRef(machines);
  machinesRef.current = machines;
  const startNewDraftMachine = useCallback(() => {
    draftingNewRef.current = true;
    const eligible = machinesRef.current.filter((machine) => machine.online);
    const only = eligible.length === 1 ? eligible[0]! : null;
    loadedRuleKeyRef.current = null;
    setDraftOrigin(null);
    setDraftTarget(only && !only.isActiveBinding ? only : null);
    setDraftMachineChosen(Boolean(only));
  }, []);

  // Seed a template-provided draft (templates, natural-language drafts).
  useEffect(() => {
    if (!active || !pendingDraft) return;
    const seeded = pendingDraft;
    onDraftConsumed();
    setSelectedRuleId(null);
    startNewDraftMachine();
    setDraft(seeded);
    savedSnapshotRef.current = JSON.stringify(seeded);
    setIssues([]);
    setSimulationNotes([]);
    setRequiredConfirmations([]);
    setAcceptedConfirmations(new Set());
    setDetailView("builder");
  }, [active, onDraftConsumed, pendingDraft, startNewDraftMachine]);

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
    const selectedEntry = entryByKey.get(selectedRuleId);
    if (!selectedEntry) return;
    // The machine is set when a rule is opened, not on every refresh: a
    // pending move (the "Runs on" field changed) must survive a list refresh.
    if (loadedRuleKeyRef.current !== selectedRuleId) {
      loadedRuleKeyRef.current = selectedRuleId;
      const nextTarget = selectedEntry.machine.isActiveBinding ? null : selectedEntry.machine;
      setDraftTarget(nextTarget);
      setDraftOrigin({ machine: nextTarget });
      setDraftMachineChosen(true);
    }
    const nextDraft = toDraftFromRule(selectedEntry.rule);
    const serialized = JSON.stringify(nextDraft);
    if (savedSnapshotRef.current === serialized) return;
    setDraft(nextDraft);
    savedSnapshotRef.current = serialized;
    setIssues([]);
    setSimulationNotes([]);
    setRequiredConfirmations([]);
    setAcceptedConfirmations(new Set());
  }, [entryByKey, selectedRuleId]);

  useEffect(() => {
    if (!requestedRuleId || entryByKey.size === 0) return;
    const key = [...entryByKey.keys()].find((candidate) => candidate === requestedRuleId || candidate.endsWith(`::${requestedRuleId}`));
    // The rule may live on a machine whose rules are still loading; wait for it.
    if (!key && Object.values(foreignLoads).some((load) => load.status === "loading")) return;
    const next = new URLSearchParams(searchParams);
    next.delete("rule");
    setSearchParams(next, { replace: true });
    if (!key || key === selectedRuleId) return;
    void (async () => {
      if (isDirtyRef.current && !(await confirmDiscardIfDirty())) return;
      setSelectedRuleId(key);
    })();
  }, [confirmDiscardIfDirty, entryByKey, foreignLoads, requestedRuleId, searchParams, selectedRuleId, setSearchParams]);

  // Bring back an unsaved draft from an earlier visit (another tab, a restart).
  // A live edit in this session always wins over the stored copy.
  useEffect(() => {
    if (!active || draftRestoreDoneRef.current || !projectRoot || !rulesLoadedOnce) return;
    const stored = loadStoredAutomationDraft(projectRoot);
    if (!stored || isDirtyRef.current) {
      draftRestoreDoneRef.current = true;
      return;
    }
    const storedTarget = stored.targetMachineId
      ? machines.find((machine) => machine.machineId === stored.targetMachineId) ?? null
      : null;
    if (stored.ruleKey) {
      const entry = entryByKey.get(stored.ruleKey);
      if (!entry) {
        // The rule may live on a machine whose rules are still loading.
        if (Object.values(foreignLoads).some((load) => load.status === "loading")) return;
        // The rule is gone; its draft has nothing to save into.
        clearStoredAutomationDraft(projectRoot);
        draftRestoreDoneRef.current = true;
        return;
      }
      const origin = entry.machine.isActiveBinding ? null : entry.machine;
      loadedRuleKeyRef.current = stored.ruleKey;
      setDraftOrigin({ machine: origin });
      setDraftTarget(stored.targetMachineId ? storedTarget ?? origin : null);
      setDraftMachineChosen(true);
      setSelectedRuleId(stored.ruleKey);
    } else {
      draftingNewRef.current = true;
      loadedRuleKeyRef.current = null;
      setDraftOrigin(null);
      setSelectedRuleId(null);
      setDraftTarget(storedTarget && !storedTarget.isActiveBinding ? storedTarget : null);
      // A machine that has gone since asks to be chosen again.
      setDraftMachineChosen(stored.machineChosen && (!stored.targetMachineId || Boolean(storedTarget)));
    }
    savedSnapshotRef.current = stored.savedSnapshot;
    setDraft(stored.draft);
    setIssues([]);
    setSimulationNotes([]);
    setRequiredConfirmations([]);
    setAcceptedConfirmations(new Set());
    setDetailView("builder");
    setRestoredDraftAt(stored.savedAt);
    draftRestoreDoneRef.current = true;
  }, [active, entryByKey, foreignLoads, machines, projectRoot, rulesLoadedOnce]);

  // Keep the stored copy in step with the draft: written on every unsaved
  // change, removed once the draft matches its saved rule (Save, Discard).
  useEffect(() => {
    if (!draftRestoreDoneRef.current) return;
    if (!draft || !isDirty || savedSnapshotRef.current == null) {
      clearStoredAutomationDraft(projectRoot);
      setRestoredDraftAt(null);
      return;
    }
    storeAutomationDraft(projectRoot, {
      draft,
      savedSnapshot: savedSnapshotRef.current,
      ruleKey: selectedRuleId,
      targetMachineId: draftTarget?.machineId ?? null,
      machineChosen: draftMachineChosen,
    });
  }, [draft, draftMachineChosen, draftTarget, isDirty, projectRoot, selectedRuleId]);

  // The draft's machine supplies its own suites and ingress status; the tab
  // machine's would describe the wrong checkout.
  const draftPin: OpenProjectBinding | null = draftTarget?.pin ?? null;
  useEffect(() => {
    setDraftMachineSuites(null);
    setDraftMachineIngress(null);
    if (!active || !draftTarget?.pin || !draftTarget.online) return;
    let cancelled = false;
    const target = draftTarget;
    void onMachine(window.ade.tests.listSuites(target.pin), target)
      .then((next) => { if (!cancelled) setDraftMachineSuites(next); })
      .catch(() => { if (!cancelled) setDraftMachineSuites([]); });
    void onMachine(window.ade.automations.getIngressStatus(target.pin), target)
      .then((next) => { if (!cancelled) setDraftMachineIngress(next); })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [active, draftMachineReadNonce, draftTarget]);

  const filteredRules = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return allRules;
    return allRules.filter((rule) => ruleMatchesSearch(rule, query));
  }, [allRules, search]);

  const validateDraft = useCallback(
    async (nextDraft: AutomationRuleDraft) => {
      const result = await onMachine(window.ade.automations.validateDraft({
        draft: nextDraft,
        confirmations: [...acceptedConfirmations],
      }, draftPin), draftTarget);
      setIssues(result.issues);
      setSimulationNotes([]);
      setRequiredConfirmations(result.requiredConfirmations);
      return result;
    },
    [acceptedConfirmations, draftPin, draftTarget],
  );

  const moveRule = useCallback(async (
    ruleDraft: AutomationRuleDraft & { id: string },
    from: LaneMachine | null,
    to: LaneMachine | null,
  ) => {
    const fromName = from?.machineName ?? boundMachine?.machineName ?? "this machine";
    const toName = to?.machineName ?? boundMachine?.machineName ?? "this machine";
    const blockedFrom = blockedReason(from);
    if (blockedFrom) {
      setError(`Can't move it: ${blockedFrom}.`);
      return;
    }
    const ok = await confirmDialog({
      title: `Move "${ruleDraft.name || "this automation"}" to ${toName}?`,
      message: [
        `It is created on ${toName} (paused), removed from ${fromName}, then turned back on.`,
        `Its run history stays on ${fromName}.`,
      ].join("\n\n"),
      confirmLabel: "Move",
    });
    if (!ok) return;
    setSaving(true);
    setError(null);
    try {
      const validation = await validateDraft(ruleDraft);
      if (!validation.ok) return;
      // 1. A paused copy on the new machine: never two live copies at once.
      const { id: oldId, ...rest } = ruleDraft;
      const created = await onMachine(
        window.ade.automations.saveDraft(
          { draft: { ...rest, enabled: false }, confirmations: [...acceptedConfirmations] },
          to?.pin ?? null,
        ),
        to,
      );
      commitMachineRules(to, created.rules);
      // 2. Remove the original. On failure the original keeps running and the
      //    copy stays paused, so nothing runs twice.
      try {
        const remaining = await onMachine(
          window.ade.automations.deleteRule({ id: oldId }, from?.pin ?? null),
          from,
        );
        commitMachineRules(from, remaining);
      } catch (err) {
        setError(`Created a paused copy on ${toName}, but couldn't remove it from ${fromName} (${extractError(err)}). The original is still active; delete one of them.`);
        return;
      }
      // 3. Turn the moved rule back on if it was on.
      let finalRules = created.rules;
      if (ruleDraft.enabled) {
        try {
          finalRules = await onMachine(
            window.ade.automations.toggle({ id: created.rule.id, enabled: true }, to?.pin ?? null),
            to,
          );
          commitMachineRules(to, finalRules);
        } catch (err) {
          setError(`Moved to ${toName}, but it is paused: ${extractError(err)}`);
        }
      }
      const nextKey = to ? machineRuleKey(to, created.rule.id) : created.rule.id;
      loadedRuleKeyRef.current = nextKey;
      setDraftOrigin({ machine: to });
      setSelectedRuleId(nextKey);
      const nextSelected = finalRules.find((r) => r.id === created.rule.id) ?? null;
      const nextDraft = nextSelected ? toDraftFromRule(nextSelected) : { ...ruleDraft, id: created.rule.id };
      setDraft(nextDraft);
      savedSnapshotRef.current = JSON.stringify(nextDraft);
      setIssues([]);
      setSimulationNotes([]);
    } catch (err) {
      setError(extractError(err));
    } finally {
      setSaving(false);
    }
  }, [acceptedConfirmations, blockedReason, boundMachine?.machineName, commitMachineRules, validateDraft]);

  const saveDraft = useCallback(async () => {
    if (!draft) return;
    if (!draftMachineChosen) {
      setError(CHOOSE_MACHINE_HINT);
      return;
    }
    const blocked = blockedReason(draftTarget);
    if (blocked) {
      setError(blocked);
      return;
    }
    if (draftMoving && draft.id && draftOrigin) {
      await moveRule(draft as AutomationRuleDraft & { id: string }, draftOrigin.machine, draftTarget);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const validation = await validateDraft(draft);
      if (!validation.ok) return;
      const target = draftTarget;
      const saved = await onMachine(
        window.ade.automations.saveDraft({ draft, confirmations: [...acceptedConfirmations] }, target?.pin ?? null),
        target,
      );
      commitMachineRules(target, saved.rules);
      setSelectedRuleId(target ? machineRuleKey(target, saved.rule.id) : saved.rule.id);
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
  }, [acceptedConfirmations, blockedReason, commitMachineRules, draft, draftMachineChosen, draftMoving, draftOrigin, draftTarget, moveRule, validateDraft]);

  const simulateDraft = useCallback(async () => {
    if (!draft) return;
    setSimulating(true);
    setError(null);
    try {
      if (!draftMachineChosen) throw new Error(CHOOSE_MACHINE_HINT);
      const blocked = blockedReason(draftTarget);
      if (blocked) throw new Error(blocked);
      const result = await onMachine(window.ade.automations.simulate({ draft }, draftPin), draftTarget);
      setIssues(result.issues);
      setSimulationNotes(
        result.issues.length ? [] : result.notes.length ? result.notes : ["Dry run completed with no blocking issues."],
      );
    } catch (err) {
      setError(extractError(err));
    } finally {
      setSimulating(false);
    }
  }, [blockedReason, draft, draftMachineChosen, draftPin, draftTarget]);

  const createRule = useCallback(async () => {
    if (!(await confirmDiscardIfDirty())) return;
    setSelectedRuleId(null);
    startNewDraftMachine();
    const blank = createBlankDraft();
    setDraft(blank);
    savedSnapshotRef.current = JSON.stringify(blank);
    setIssues([]);
    setSimulationNotes([]);
    setRequiredConfirmations([]);
    setAcceptedConfirmations(new Set());
    setDetailView("builder");
  }, [confirmDiscardIfDirty, startNewDraftMachine]);

  const runRuleNow = useCallback(
    async (entry: MachineRule, laneId?: string | null) => {
      if (manualRunPendingRef.current) return;
      const blocked = blockedReason(entry.machine);
      if (blocked) {
        setError(blocked);
        return;
      }
      manualRunPendingRef.current = true;
      setManualRunPending(true);
      setRunning(true);
      setError(null);
      try {
        await onMachine(
          window.ade.automations.triggerManually(
            { id: entry.rule.id, ...(laneId ? { laneId } : {}) },
            entry.machine.pin,
          ),
          entry.machine,
        );
        setManualRunRule(null);
        setManualRunLaneId("");
        if (entry.machine.pin) refreshMachine(entry.machine.machineId);
        else await refresh();
      } catch (err) {
        setError(extractError(err));
      } finally {
        manualRunPendingRef.current = false;
        setManualRunPending(false);
        setRunning(false);
      }
    },
    [blockedReason, refresh, refreshMachine],
  );

  const beginRunRule = useCallback(
    (rule: AutomationRuleSummary) => {
      const entry = entryByRule.get(rule);
      if (!entry) return;
      const blocked = blockedReason(entry.machine);
      if (blocked) {
        setError(blocked);
        return;
      }
      if (rule.execution?.laneMode === "require-on-trigger") {
        setManualRunRule(rule);
        setManualRunLaneId(lanesForMachine(entry.machine)[0]?.id ?? "");
        return;
      }
      void runRuleNow(entry);
    },
    [blockedReason, entryByRule, lanesForMachine, runRuleNow],
  );

  const deleteRule = useCallback(async (key: string) => {
    const entry = entryByKey.get(key);
    if (!entry) return;
    const blocked = blockedReason(entry.machine);
    if (blocked) {
      setError(blocked);
      return;
    }
    setError(null);
    try {
      const next = await onMachine(
        window.ade.automations.deleteRule({ id: entry.rule.id }, entry.machine.pin),
        entry.machine,
      );
      commitMachineRules(entry.machine, next);
      setSelectedRuleId(next[0] ? machineRuleKey(entry.machine, next[0].id) : null);
      if (!next.length) setDraft(createBlankDraft());
    } catch (err) {
      setError(extractError(err));
    }
  }, [blockedReason, commitMachineRules, entryByKey]);

  const toggleRule = useCallback((key: string, enabled: boolean) => {
    const entry = entryByKey.get(key);
    if (!entry) return;
    const blocked = blockedReason(entry.machine);
    if (blocked) {
      setError(blocked);
      return;
    }
    onMachine(window.ade.automations.toggle({ id: entry.rule.id, enabled }, entry.machine.pin), entry.machine)
      .then((next) => commitMachineRules(entry.machine, next))
      .catch((err) => setError(extractError(err)));
  }, [blockedReason, commitMachineRules, entryByKey]);

  const hasProjectSidebar = useHasProjectSidebar();
  const selectedEntry = selectedRuleId ? entryByKey.get(selectedRuleId) ?? null : null;
  const selectedRule = selectedEntry?.rule ?? null;
  const delivery = ingressStatus?.delivery ?? null;
  const manualRunEntry = manualRunRule ? entryByRule.get(manualRunRule) ?? null : null;
  const builderLanes = lanesForMachine(draftTarget);
  const builderSuites = draftTarget?.pin ? draftMachineSuites ?? [] : suites;
  const builderIngress = draftTarget?.pin ? draftMachineIngress : ingressStatus;
  const draftMachineBlocked = blockedReason(draftTarget);
  const machineNotes = Object.keys(foreignLoads).length > 0 ? (
    <div
      className="flex shrink-0 flex-wrap gap-x-3 gap-y-0.5 border-b border-fg/[0.04] px-3 py-1 text-[10.5px] text-muted-fg/50"
      data-testid="automations-machine-notes"
    >
      {Object.entries(foreignLoads).map(([key, load]) => (
        <span key={key} title={load.message ?? undefined}>
          {load.status === "loading"
            ? `Loading ${load.machineName}…`
            : load.status === "offline"
              ? `${load.machineName} is offline`
              : `Couldn't reach ${load.machineName}`}
        </span>
      ))}
    </div>
  ) : null;

  // The workspace stays mounted behind the template gallery, so an unsaved
  // draft survives a visit there; only picking a template replaces it.
  const applyTemplate = async (templateDraft: Omit<AutomationRuleDraft, "id">) => {
    if (!(await confirmDiscardIfDirty())) return;
    setSelectedRuleId(null);
    startNewDraftMachine();
    const seeded = { ...templateDraft } as AutomationRuleDraft;
    setDraft(seeded);
    savedSnapshotRef.current = JSON.stringify(seeded);
    setIssues([]);
    setSimulationNotes([]);
    setRequiredConfirmations([]);
    setAcceptedConfirmations(new Set());
    setDetailView("builder");
    onCloseTemplates?.();
  };

  // The list lives in the project sidebar; without one (hosted web client,
  // tests) it keeps its own column on the left.
  const ruleList = (
    <RuleList
      rules={filteredRules}
      selectedRuleId={selectedRuleId}
      search={search}
      loading={loading}
      error={error}
      ingressStatus={ingressStatus}
      delivery={delivery}
      onSearch={setSearch}
      onSelect={async (id) => {
        if (id !== selectedRuleId && !(await confirmDiscardIfDirty())) return;
        setSelectedRuleId(id);
        setDetailView("builder");
        onCloseTemplates?.();
      }}
      onToggle={toggleRule}
      onRunNow={beginRunRule}
      onOpenHistory={async (id) => {
        if (!(await confirmDiscardIfDirty())) return;
        setSelectedRuleId(id);
        setDetailView("history");
        onCloseTemplates?.();
      }}
      onDelete={(id) => void deleteRule(id)}
      onNew={() => {
        createRule();
        onCloseTemplates?.();
      }}
      onOpenTemplates={async () => {
        if (await confirmDiscardIfDirty()) onOpenTemplates();
      }}
      onUseTemplate={applyTemplate}
      onRefresh={() => {
        void refresh();
        refreshForeign();
      }}
      ruleKey={ruleKeyOf}
      machineOf={machineOfRule}
      machineNotes={machineNotes}
    />
  );

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }} className="flex h-full min-h-0">
      {hasProjectSidebar ? (
        <ProjectSidebarSlot active={active}>{ruleList}</ProjectSidebarSlot>
      ) : (
        <div className="flex min-h-0 w-[340px] shrink-0 flex-col border-r border-fg/[0.06] bg-fg/[0.01]">
          {ruleList}
        </div>
      )}

      {templatesOpen ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="automations-templates-page">
          <TemplateGallery onUseTemplate={applyTemplate} onBack={onCloseTemplates} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {selectedRule ? (
            <div className="flex shrink-0 items-center gap-0 border-b border-fg/[0.06] bg-fg/[0.01] px-3" style={{ minHeight: 34 }}>
              <DetailTab active={detailView === "builder"} label="Builder" icon={PencilSimple} onClick={() => setDetailView("builder")} />
              <DetailTab
                active={detailView === "history"}
                label="History"
                icon={ClockCounterClockwise}
                onClick={async () => {
                  if (await confirmDiscardIfDirty()) setDetailView("history");
                }}
              />
            </div>
          ) : null}

          {draft && detailView === "builder" && restoredDraftAt ? (
            <Banner
              layout="inline"
              testId="automation-draft-restored"
              style={{ margin: "8px 16px 0" }}
              model={{
                id: "automation-draft-restored",
                tone: "info",
                title: `Restored your unsaved changes from ${formatRestoredDraftTime(restoredDraftAt)}.`,
                detail: "Save to keep them.",
                actions: [{ label: "Discard", onClick: () => void confirmDiscardIfDirty() }],
              }}
            />
          ) : null}
          {draft && detailView === "builder" && draftMachineChosen && draftMachineBlocked ? (
            <Banner
              layout="inline"
              testId="automation-draft-machine"
              style={{ margin: "8px 16px 0" }}
              model={{ id: "automation-draft-machine", tone: "warning", title: draftMachineBlocked }}
            />
          ) : null}
          <div className="min-h-0 flex-1 overflow-hidden">
            {detailView === "history" && selectedRule ? (
              <RuleHistory
                key={selectedEntry?.key ?? selectedRule.id}
                automationId={selectedRule.id}
                ruleName={selectedRule.name}
                pin={selectedEntry?.machine.pin ?? null}
                machineName={selectedEntry?.machine.machineName ?? null}
                offlineMessage={blockedReason(selectedEntry?.machine ?? null)}
              />
            ) : draft ? (
              <RuleBuilder
                draft={draft}
                setDraft={setDraft}
                lanes={builderLanes.map((l) => ({ id: l.id, name: l.name }))}
                suites={builderSuites}
                ingressStatus={builderIngress}
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
                onIngressChanged={() => {
                  // The draft's machine owns its ingress status.
                  if (draftTarget?.pin) setDraftMachineReadNonce((n) => n + 1);
                  else void refresh();
                }}
                runtimePin={draftPin}
                machineField={
                  <RuleMachineField
                    machines={machines}
                    valueMachineId={draftMachineChosen ? (draftTarget?.machineId ?? boundMachine?.machineId ?? null) : null}
                    savedMachineId={draftOrigin ? (draftOrigin.machine?.machineId ?? boundMachine?.machineId ?? null) : null}
                    disabled={saving}
                    onChange={(machineId) => {
                      const next = machines.find((machine) => machine.machineId === machineId);
                      if (!next) return;
                      setDraftTarget(next.isActiveBinding ? null : next);
                      setDraftMachineChosen(true);
                      setError(null);
                    }}
                  />
                }
                saveBlockedReason={draftMachineChosen ? null : CHOOSE_MACHINE_HINT}
                cursorCloudConnected={cursorCloudConnected}
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
      )}

      {manualRunRule ? (
        <ManualRunModal
          rule={manualRunRule}
          lanes={lanesForMachine(manualRunEntry?.machine ?? null)}
          laneId={manualRunLaneId}
          pending={manualRunPending}
          onLaneId={setManualRunLaneId}
          onCancel={() => {
            setManualRunRule(null);
            setManualRunLaneId("");
          }}
          onRun={() => {
            if (manualRunEntry) void runRuleNow(manualRunEntry, manualRunLaneId);
          }}
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
      <div className="max-w-md rounded-xl border border-fg/[0.07] bg-fg/[0.03] p-6 text-center shadow-card">
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
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title="Choose a lane for this run"
      description={`${rule.name} requires a lane when triggered.`}
      width={448}
      actions={[
        { label: "Cancel", variant: "secondary", onClick: onCancel },
        {
          label: "Run",
          variant: "solid",
          icon: <Play size={12} weight="fill" />,
          disabled: !laneId || pending,
          onClick: onRun,
        },
      ]}
    >
      <label className="block space-y-1.5">
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
        <Banner
          model={{
            id: "automation-no-active-lanes",
            tone: "warning",
            title: "No active lanes are available. Switch the rule to create a lane per run, or create a lane from the Work tab.",
          }}
          layout="inline"
          style={{ marginTop: 12 }}
        />
      ) : null}
    </Dialog>
  );
}

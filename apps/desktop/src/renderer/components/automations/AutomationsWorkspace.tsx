import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { useSearchParams } from "react-router-dom";
import { ClockCounterClockwise, CloudArrowDown, PencilSimple, Play, Trash } from "@phosphor-icons/react";
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
import { showToast } from "../app/toast/toastStore";
import { cn } from "../ui/cn";
import { extractError } from "./shared";
import { inputCls } from "./designTokens";
import { buildRuleSentence } from "./automationCopy";
import { actionToDraftAction } from "./builder/draftBridge";
import { RuleList } from "./list/RuleList";
import { ProjectSidebarSlot, useHasProjectSidebar } from "../app/projectSidebar/ProjectSidebarSlot";
import { RuleBuilder } from "./builder/RuleBuilder";
import { TestRunDialog, type TestKind } from "./builder/TestRunControls";
import { RuleHistory } from "./history/RuleHistory";
import { TemplateGallery } from "./templates/TemplateGallery";
import { RuleMachineField } from "./builder/RuleMachineField";
import { machineRuleKey, ruleListKey, useAutomationMachines, type MachineRule } from "./useAutomationMachines";
import { followsAccount, ruleElsewhereReason, ruleSyncLine } from "./ruleSync";
import { AUTOMATION_HOME_HANDOVER_MINUTES, isAdeCloudHome } from "../../../shared/automationHome";
import { automationCloudHomeProblem } from "../../../shared/automationCloud";
import { useAdeCloudEnabled } from "../../state/cloudAccess";
import type { LaneMachine } from "../../state/laneMachineRouting";
import { onMachine } from "../../state/projectMachines";
import { parseMachineScopedId } from "../../state/foreignMachineReads";
import { useAdeCloudLaneComputers } from "../../state/adeCloudLaneIndex";
import { isAdeCloudLaneComputer } from "../lanes/laneMachines";
import { selectActiveProjectRoot, useAppStore } from "../../state/appStore";
import { useActiveRepositoryTab, useTabCopyPin } from "../../state/repositoryScope";
import {
  automationDraftScope,
  clearStoredAutomationDraft,
  loadStoredAutomationDraft,
} from "./automationDraftStore";
import { useAutomationDraftPersistence } from "./useAutomationDraftPersistence";
import { automationFeaturesNeedingNewerAde, explainAutomationActionError } from "../../../shared/automationFeatureVersions";
import {
  AutomationFeatureGateContext,
  automationFeatureLabel,
  buildAutomationFeatureGate,
  useAutomationMachineSupport,
} from "./automationFeatureGate";
import { automationRunLaneNeed } from "../../../shared/automationRunLane";
import { BRAND } from "../../../shared/brand";

const CHOOSE_MACHINE_HINT = "Choose the machine this automation runs on.";
/** Zero machines: no computer with this project is online, so nothing is read or sent. */
const NO_COMPUTER_ONLINE = "No computer with this project is online.";

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

/** An error in plain words: an older ADE's missing step names the machine and the release that has it. */
function explainError(err: unknown, machineName?: string | null): string {
  const message = extractError(err);
  return explainAutomationActionError(message, machineName) ?? message;
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
  // `&run=<id>` (a notification's "This run's history") opens that run in History.
  const requestedRunId = searchParams.get("run");
  /** The run a link opened, shown in that rule's History until the view changes. */
  const [linkedRun, setLinkedRun] = useState<{ ruleKey: string; runId: string } | null>(null);
  const [draft, setDraft] = useState<AutomationRuleDraft | null>(null);
  const [issues, setIssues] = useState<AutomationDraftIssue[]>([]);
  const [requiredConfirmations, setRequiredConfirmations] = useState<AutomationDraftConfirmationRequirement[]>([]);
  const [acceptedConfirmations, setAcceptedConfirmations] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualRunRule, setManualRunRule] = useState<AutomationRuleSummary | null>(null);
  const [manualRunLaneId, setManualRunLaneId] = useState<string>("");
  const [manualRunPending, setManualRunPending] = useState(false);
  const manualRunPendingRef = useRef(false);
  const [running, setRunning] = useState(false);
  /** The open Test dialog's kind; null when it is closed. */
  const [testKind, setTestKind] = useState<TestKind | null>(null);
  const [cursorCloudConnected, setCursorCloudConnected] = useState(false);
  const loadRef = useRef<(() => Promise<void>) | null>(null);
  const savedSnapshotRef = useRef<string | null>(null);
  const projectRoot = useAppStore(selectActiveProjectRoot);
  // The draft belongs to the repository, not to the copy the tab is bound to,
  // so it survives the tab moving to another copy.
  const repositoryTab = useActiveRepositoryTab();
  const draftScope = useMemo(() => automationDraftScope(repositoryTab, projectRoot), [projectRoot, repositoryTab]);
  /** True once the first rule list has loaded, so a stored draft can find its rule. */
  const [rulesLoadedOnce, setRulesLoadedOnce] = useState(false);
  /** Set once the stored draft was restored or found absent; persisting waits for it. */
  const draftRestoreDoneRef = useRef(false);

  // ── Machines ────────────────────────────────────────────────
  const {
    machines,
    boundMachine,
    machineListsAccountRule,
    machineAccountRule,
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
   * The tab machine's copy: where the rules, lanes and suites shown as "this
   * tab's" are read, and where a call for a null machine goes. Null when no
   * computer with this project is online; nothing is read then.
   */
  const tabPin = useTabCopyPin();
  const tabPinRef = useRef(tabPin);
  tabPinRef.current = tabPin;
  /** The pin of a machine, or of the tab's machine for null. Throws when there is none. */
  const machinePin = useCallback((machine: LaneMachine | null): OpenProjectBinding => {
    const pin = machine ? machine.pin : tabPinRef.current;
    if (!pin) throw new Error(NO_COMPUTER_ONLINE);
    return pin;
  }, []);
  /**
   * The machine the open draft belongs to; null = the tab's machine. Captured
   * as the full machine (with its pin) so a save always goes to the machine the
   * draft was opened on, even if the union momentarily drops it.
   */
  const [draftTarget, setDraftTarget] = useState<LaneMachine | null>(null);
  /**
   * The machines "Runs on" offers. A rule's run makes its lane on the machine,
   * so a lane's own ADE Cloud computer (one lane per computer) is left out,
   * except the machine a saved rule already runs on or the draft holds.
   */
  const { computers: adeCloudLaneComputers } = useAdeCloudLaneComputers();
  const ruleMachineChoices = useMemo(
    () => machines.filter((machine) =>
      machine.machineId === draftTarget?.machineId
      || !isAdeCloudLaneComputer({ hostname: machine.hostname, machineKey: machine.machineId }, adeCloudLaneComputers)),
    [adeCloudLaneComputers, draftTarget?.machineId, machines],
  );
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
  /**
   * True once "Runs on" was picked for a rule that follows the account whose
   * home this window cannot reach: any pick, even the machine the rule was
   * read from, is then a change of home.
   */
  const [draftRehomeChosen, setDraftRehomeChosen] = useState(false);
  /** "Runs on: ADE Cloud" was picked (C9): Save makes ADE Cloud the rule's home. */
  const [draftCloudChosen, setDraftCloudChosen] = useState(false);
  const adeCloudEnabled = useAdeCloudEnabled();
  const loadedRuleKeyRef = useRef<string | null>(null);
  /**
   * The machine the loaded rule was read from. A rule that follows the
   * account keeps one key on every machine, and its entry moves to its home
   * when the home answers after the others; "Runs on" then follows it.
   */
  const loadedRuleMachineRef = useRef<string | null>(null);
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
  const draftMoving = Boolean(draftOrigin && (
    draftRehomeChosen || (draftOrigin.machine?.machineId ?? null) !== (draftTarget?.machineId ?? null)
  ));
  const isDirty = useMemo(() => {
    if (!draft || savedSnapshotRef.current == null) return false;
    return draftMoving || draftCloudChosen || JSON.stringify(draft) !== savedSnapshotRef.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, draftMoving, draftCloudChosen]);

  const confirmDiscardIfDirty = useCallback(async (): Promise<boolean> => {
    if (!isDirty) return true;
    const ok = await confirmDialog({
      title: "You have unsaved changes.",
      message: "Discard them and continue?",
      confirmLabel: "Discard",
      destructive: true,
    });
    // Discarding a pending move puts the rule back on its machine.
    if (ok && draftOrigin) {
      setDraftTarget(draftOrigin.machine);
      setDraftRehomeChosen(false);
    }
    if (ok) setDraftCloudChosen(false);
    if (ok && savedSnapshotRef.current != null) {
      try {
        setDraft(JSON.parse(savedSnapshotRef.current) as AutomationRuleDraft);
        setIssues([]);
      } catch {
        // Malformed snapshot — leave draft as-is.
      }
    }
    return ok;
  }, [draftOrigin, isDirty]);

  const refresh = useCallback(async () => {
    const pin = tabPinRef.current;
    if (!pin) {
      // No computer with this project is online: show the empty state, call nothing.
      setRules([]);
      setSuites([]);
      setLanes([]);
      setIngressStatus(null);
      setCursorCloudConnected(false);
      setError(null);
      setLoading(false);
      setRulesLoadedOnce(true);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [nextRules, nextSuites, nextLanes, nextIngress, _projectConfig, aiStatus] = await Promise.all([
        window.ade.automations.list(pin),
        window.ade.tests.listSuites(pin),
        window.ade.lanes.list({ includeArchived: false, includeStatus: false }, pin),
        window.ade.automations.getIngressStatus(pin),
        window.ade.projectConfig.get(pin),
        Promise.resolve()
          .then(() => readCursorCloudConnectionForAutomation(() => window.ade.ai.getStatus(undefined, pin))),
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
      setError(explainError(err));
    } finally {
      setLoading(false);
    }
  }, []);
  loadRef.current = refresh;

  // The relay and the webhook gateway report their state on every poll, so
  // "ingress-updated" comes several times a minute. It changes only the
  // ingress status: read that alone, and keep the old object when nothing in
  // it changed, so the page does not reload its rules on each poll.
  const refreshIngress = useCallback(async () => {
    const pin = tabPinRef.current;
    if (!pin) return;
    try {
      const next = await window.ade.automations.getIngressStatus(pin);
      if (tabPinRef.current?.key !== pin.key) return;
      setIngressStatus((current) => (current && JSON.stringify(current) === JSON.stringify(next) ? current : next));
    } catch {
      // The next full refresh reads it again.
    }
  }, []);
  const refreshIngressRef = useRef(refreshIngress);
  refreshIngressRef.current = refreshIngress;

  // A selected rule on another machine falls back only once that machine has
  // answered without it, or has left.
  useEffect(() => {
    if (!selectedRuleId || rules.some((rule) => rule.id === selectedRuleId)) return;
    if (!parseMachineScopedId(selectedRuleId) || foreignRuleKeyState(selectedRuleId) !== "gone") return;
    setSelectedRuleId(rules[0]?.id ?? null);
  }, [foreignRuleKeyState, rules, selectedRuleId]);

  // The tab machine's events refresh its rules. Other machines' rules come
  // from the shared foreign-read loop, so they add no event pump here.
  useEffect(() => {
    if (!active) return;
    void refresh();
    const pin = tabPinRef.current;
    if (!pin) return;
    const unsubscribe = window.ade.automations.onEvent((event) => {
      if (event.type === "ingress-updated") void refreshIngressRef.current();
      else void loadRef.current?.();
    }, pin);
    return () => {
      try {
        unsubscribe();
      } catch {
        // ignore
      }
    };
  }, [active, refresh, tabPin?.key]);

  /**
   * A new draft names its machine in the recipe ("Runs on"), not in a popup.
   * It starts unchosen unless exactly one machine can take it.
   */
  const machinesRef = useRef(ruleMachineChoices);
  machinesRef.current = ruleMachineChoices;
  const startNewDraftMachine = useCallback(() => {
    draftingNewRef.current = true;
    const eligible = machinesRef.current.filter((machine) => machine.online);
    const only = eligible.length === 1 ? eligible[0]! : null;
    loadedRuleKeyRef.current = null;
    setDraftOrigin(null);
    setDraftRehomeChosen(false);
    setDraftCloudChosen(false);
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
    // The machine is set when a rule is opened (or its entry moves to its
    // home), not on every refresh: a pending move (the "Runs on" field
    // changed) makes the draft dirty, and the guard above keeps it.
    if (loadedRuleKeyRef.current !== selectedRuleId || loadedRuleMachineRef.current !== selectedEntry.machine.machineId) {
      loadedRuleKeyRef.current = selectedRuleId;
      loadedRuleMachineRef.current = selectedEntry.machine.machineId;
      const nextTarget = selectedEntry.machine.isActiveBinding ? null : selectedEntry.machine;
      setDraftTarget(nextTarget);
      setDraftOrigin({ machine: nextTarget });
      setDraftRehomeChosen(false);
      setDraftCloudChosen(false);
      setDraftMachineChosen(true);
    }
    const nextDraft = toDraftFromRule(selectedEntry.rule);
    const serialized = JSON.stringify(nextDraft);
    if (savedSnapshotRef.current === serialized) return;
    setDraft(nextDraft);
    savedSnapshotRef.current = serialized;
    setIssues([]);
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
    next.delete("run");
    setSearchParams(next, { replace: true });
    if (!key) return;
    const opensRule = key !== selectedRuleId;
    // Opening the rule, or its History, leaves the builder: ask first, as the
    // History tab does.
    if (!opensRule && !requestedRunId) return;
    void (async () => {
      if (isDirtyRef.current && !(await confirmDiscardIfDirty())) return;
      if (opensRule) setSelectedRuleId(key);
      if (!requestedRunId) return;
      setLinkedRun({ ruleKey: key, runId: requestedRunId });
      setDetailView("history");
    })();
  }, [confirmDiscardIfDirty, entryByKey, foreignLoads, requestedRuleId, requestedRunId, searchParams, selectedRuleId, setSearchParams]);

  const draftRuleEntry = selectedRuleId ? entryByKey.get(selectedRuleId) ?? null : null;
  const { restoredDraftAt, noteRestored: noteDraftRestored } = useAutomationDraftPersistence({
    scope: draftScope,
    restoreDoneRef: draftRestoreDoneRef,
    draft,
    isDirty,
    savedSnapshotRef,
    ruleKey: selectedRuleId,
    ruleId: draftRuleEntry?.rule.id ?? null,
    ruleMachineId: draftRuleEntry?.machine.machineId ?? null,
    // By id even for the tab's own machine: another checkout may restore it.
    targetMachineId: (draftTarget ?? machines.find((machine) => machine.isActiveBinding))?.machineId ?? null,
    machineChosen: draftMachineChosen,
    cloudChosen: draftCloudChosen,
    rehomeChosen: draftRehomeChosen,
  });

  const linkedRunId = linkedRun && linkedRun.ruleKey === selectedRuleId ? linkedRun.runId : null;
  // The linked run is shown once; History opened again later starts on the newest run.
  useEffect(() => {
    if (detailView !== "history") setLinkedRun(null);
  }, [detailView]);

  // Bring back an unsaved draft from an earlier visit (another tab, a restart).
  // A live edit in this session always wins over the stored copy, and a link
  // being opened goes first: the draft comes back once its run is left.
  useEffect(() => {
    if (!active || draftRestoreDoneRef.current || !draftScope || !rulesLoadedOnce) return;
    if (requestedRuleId || linkedRun) return;
    const stored = loadStoredAutomationDraft(draftScope);
    if (!stored || isDirtyRef.current) {
      draftRestoreDoneRef.current = true;
      return;
    }
    const storedTarget = stored.targetMachineId
      ? machines.find((machine) => machine.machineId === stored.targetMachineId) ?? null
      : null;
    if (stored.ruleKey) {
      // The rule by its id and machine first: the list key differs between
      // checkouts. Older records have only the key.
      const byIdentity = stored.ruleId
        ? [...entryByKey].find(([, candidate]) => candidate.rule.id === stored.ruleId
          && (!stored.ruleMachineId || candidate.machine.machineId === stored.ruleMachineId))
        : undefined;
      const ruleKey = byIdentity?.[0] ?? stored.ruleKey;
      const entry = byIdentity?.[1] ?? entryByKey.get(stored.ruleKey);
      if (!entry) {
        // The rule may live on a machine whose rules are still loading.
        if (Object.values(foreignLoads).some((load) => load.status === "loading")) return;
        // The rule is gone; its draft has nothing to save into.
        clearStoredAutomationDraft(draftScope);
        draftRestoreDoneRef.current = true;
        return;
      }
      const origin = entry.machine.isActiveBinding ? null : entry.machine;
      loadedRuleKeyRef.current = ruleKey;
      setDraftOrigin({ machine: origin });
      // Null is the tab's own machine; a target that has gone stays on the rule's.
      setDraftTarget(!stored.targetMachineId ? null : storedTarget ? (storedTarget.isActiveBinding ? null : storedTarget) : origin);
      setDraftMachineChosen(true);
      setDraftRehomeChosen(stored.rehomeChosen);
      setDraftCloudChosen(stored.cloudChosen);
      setSelectedRuleId(ruleKey);
    } else {
      draftingNewRef.current = true;
      loadedRuleKeyRef.current = null;
      setDraftOrigin(null);
      setSelectedRuleId(null);
      setDraftRehomeChosen(false);
      setDraftCloudChosen(stored.cloudChosen);
      setDraftTarget(storedTarget && !storedTarget.isActiveBinding ? storedTarget : null);
      // A machine that has gone since asks to be chosen again.
      setDraftMachineChosen(stored.machineChosen && (!stored.targetMachineId || Boolean(storedTarget)));
    }
    savedSnapshotRef.current = stored.savedSnapshot;
    setDraft(stored.draft);
    setIssues([]);
    setRequiredConfirmations([]);
    setAcceptedConfirmations(new Set());
    setDetailView("builder");
    noteDraftRestored(stored);
    draftRestoreDoneRef.current = true;
  }, [active, draftScope, entryByKey, foreignLoads, linkedRun, machines, noteDraftRestored, requestedRuleId, rulesLoadedOnce]);


  // The draft's machine supplies its own suites and ingress status; the tab
  // machine's would describe the wrong checkout.
  const draftPin: OpenProjectBinding | null = draftTarget ? draftTarget.pin : tabPin;
  // The tab's own copy has a pin too; its suites and ingress are the ones this
  // page already reads.
  const draftForeignTarget = draftTarget && !draftTarget.isActiveBinding ? draftTarget : null;
  useEffect(() => {
    setDraftMachineSuites(null);
    setDraftMachineIngress(null);
    const targetPin = draftForeignTarget?.pin ?? null;
    if (!active || !draftForeignTarget || !targetPin || !draftForeignTarget.online) return;
    let cancelled = false;
    const target = draftForeignTarget;
    void onMachine(window.ade.tests.listSuites(targetPin), target)
      .then((next) => { if (!cancelled) setDraftMachineSuites(next); })
      .catch(() => { if (!cancelled) setDraftMachineSuites([]); });
    void onMachine(window.ade.automations.getIngressStatus(targetPin), target)
      .then((next) => { if (!cancelled) setDraftMachineIngress(next); })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [active, draftMachineReadNonce, draftForeignTarget]);

  const filteredRules = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return allRules;
    return allRules.filter((rule) => ruleMatchesSearch(rule, query));
  }, [allRules, search]);

  const validateDraft = useCallback(
    async (nextDraft: AutomationRuleDraft) => {
      if (!draftPin) throw new Error(NO_COMPUTER_ONLINE);
      const result = await onMachine(window.ade.automations.validateDraft({
        draft: nextDraft,
        confirmations: [...acceptedConfirmations],
      }, draftPin), draftTarget);
      setIssues(result.issues);
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
    // A rule that follows the account is already on every machine that lists
    // it; moving it only changes which one runs it. Machines that do not list
    // it (an older ADE, another account) take a copy the old way below.
    const savedRule = selectedRuleId ? entryByKey.get(selectedRuleId)?.rule ?? null : null;
    const toMachine = to ?? boundMachine;
    if (savedRule && followsAccount(savedRule) && toMachine && machineListsAccountRule(toMachine, ruleDraft.id)) {
      const ok = await confirmDialog({
        title: `Run "${ruleDraft.name || "this automation"}" on ${toName}?`,
        message: [
          `${toName} starts it ${AUTOMATION_HOME_HANDOVER_MINUTES} minutes after you save, once ${savedRule.home?.name ?? fromName} has surely stopped, so the two never run it at once. Run now works right away, and every computer still shows the rule.`,
          `Its run history stays on ${savedRule.home?.name ?? fromName}.`,
        ].join("\n\n"),
        confirmLabel: "Change",
      });
      if (!ok) return;
      setSaving(true);
      setError(null);
      try {
        const validation = await validateDraft(ruleDraft);
        if (!validation.ok) return;
        // Saved through the new home as "this computer", so it names its own
        // checkout; the new home waits past the old home's lease
        // (`homeStartsAt`), so they never overlap. When only "Runs on"
        // changed, the new home's own copy goes back, so the save writes the
        // home alone and cannot undo a newer edit that computer already has.
        const contentEdited = JSON.stringify(ruleDraft) !== savedSnapshotRef.current;
        const targetCopy = contentEdited ? null : machineAccountRule(toMachine, ruleDraft.id);
        const draftToSave = targetCopy ? toDraftFromRule(targetCopy) : ruleDraft;
        const saved = await onMachine(
          window.ade.automations.saveDraft(
            { draft: { ...draftToSave, home: "this-computer" }, confirmations: [...acceptedConfirmations] },
            machinePin(to),
          ),
          to,
        );
        commitMachineRules(to, saved.rules);
        refreshForeign();
        loadedRuleKeyRef.current = ruleDraft.id;
        setDraftOrigin({ machine: to });
        setDraftRehomeChosen(false);
        setSelectedRuleId(ruleDraft.id);
        const nextSelected = saved.rules.find((r) => r.id === ruleDraft.id) ?? null;
        const nextDraft = nextSelected ? toDraftFromRule(nextSelected) : ruleDraft;
        setDraft(nextDraft);
        savedSnapshotRef.current = JSON.stringify(nextDraft);
        setIssues([]);
      } catch (err) {
        setError(explainError(err));
      } finally {
        setSaving(false);
      }
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
          machinePin(to),
        ),
        to,
      );
      commitMachineRules(to, created.rules);
      // 2. Remove the original. On failure the original keeps running and the
      //    copy stays paused, so nothing runs twice.
      try {
        const remaining = await onMachine(
          window.ade.automations.deleteRule({ id: oldId }, machinePin(from)),
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
            window.ade.automations.toggle({ id: created.rule.id, enabled: true }, machinePin(to)),
            to,
          );
          commitMachineRules(to, finalRules);
        } catch (err) {
          setError(`Moved to ${toName}, but it is paused: ${extractError(err)}`);
        }
      }
      const createdSummary = finalRules.find((r) => r.id === created.rule.id);
      const nextKey = createdSummary && followsAccount(createdSummary)
        ? created.rule.id
        : to ? machineRuleKey(to, created.rule.id) : created.rule.id;
      loadedRuleKeyRef.current = nextKey;
      setDraftOrigin({ machine: to });
      setSelectedRuleId(nextKey);
      const nextSelected = finalRules.find((r) => r.id === created.rule.id) ?? null;
      const nextDraft = nextSelected ? toDraftFromRule(nextSelected) : { ...ruleDraft, id: created.rule.id };
      setDraft(nextDraft);
      savedSnapshotRef.current = JSON.stringify(nextDraft);
      setIssues([]);
    } catch (err) {
      setError(explainError(err));
    } finally {
      setSaving(false);
    }
  }, [acceptedConfirmations, blockedReason, boundMachine, commitMachineRules, entryByKey, machineAccountRule, machineListsAccountRule, machinePin, refreshForeign, selectedRuleId, validateDraft]);

  // The machine the draft runs on, and what its ADE can run. This window's
  // own machine runs this build; ADE Cloud as the home is ADE Cloud's to run.
  const ruleMachine = draftTarget ?? machines.find((machine) => machine.isActiveBinding) ?? null;
  const ruleRunsOnAdeCloud = draftCloudChosen
    || (!draftRehomeChosen && isAdeCloudHome((selectedRuleId ? entryByKey.get(selectedRuleId)?.rule : null)?.home));
  const ruleMachineSupport = useAutomationMachineSupport(ruleRunsOnAdeCloud ? null : ruleMachine);
  const ruleMachineName = ruleMachine?.machineName ?? null;
  const needsNewerAde = useMemo(
    () => automationFeaturesNeedingNewerAde(draft, ruleMachineSupport, automationFeatureLabel),
    [draft, ruleMachineSupport],
  );
  const featureGate = useMemo(
    () => buildAutomationFeatureGate(ruleMachineSupport, ruleMachineName),
    [ruleMachineName, ruleMachineSupport],
  );

  const saveDraft = useCallback(async () => {
    if (!draft) return;
    // A rule its machine cannot run is saved only when the person says so
    // (an update is on its way); otherwise it would fail on its first run.
    if (needsNewerAde.length > 0) {
      const machineName = ruleMachineName ?? "The machine that runs this rule";
      // A machine that lists what it runs refuses to save an ADE action step
      // it lacks, so there is nothing to save anyway.
      const refused = ruleMachineSupport?.capabilities
        ? needsNewerAde.filter((feature) => feature.key.startsWith("adeAction:"))
        : [];
      if (refused.length > 0) {
        setError(`${machineName} can't run ${refused.map((feature) => feature.label).join(", ")}. Update ${BRAND.NAME} there, or remove the step.`);
        return;
      }
      const ok = await confirmDialog({
        title: `${machineName} can't run this rule yet.`,
        message: `It needs a newer ${BRAND.NAME} for ${needsNewerAde.map((feature) => feature.label).join(", ")}. Until ${BRAND.NAME} there is updated, the rule fails when it runs.`,
        confirmLabel: "Save anyway",
      });
      if (!ok) return;
    }
    // ADE Cloud as the home: saved through this draft's machine, which hands it to ADE Cloud's server.
    if (draftCloudChosen) {
      setSaving(true);
      setError(null);
      try {
        const validation = await validateDraft(draft);
        if (!validation.ok) return;
        const target = draftTarget;
        if (!draftPin) throw new Error(NO_COMPUTER_ONLINE);
        const saved = await onMachine(
          window.ade.automations.saveDraft({ draft: { ...draft, home: "ade-cloud" }, confirmations: [...acceptedConfirmations] }, draftPin),
          target,
        );
        commitMachineRules(target, saved.rules);
        refreshForeign();
        setDraftCloudChosen(false);
        setDraftRehomeChosen(false);
        setDraftMachineChosen(true);
        setSelectedRuleId(saved.rule.id);
        const nextSelected = saved.rules.find((r) => r.id === saved.rule.id) ?? null;
        const nextDraft = nextSelected ? toDraftFromRule(nextSelected) : draft;
        setDraft(nextDraft);
        savedSnapshotRef.current = JSON.stringify(nextDraft);
        setIssues([]);
      } catch (err) {
        setError(explainError(err, ruleMachineName));
      } finally {
        setSaving(false);
      }
      return;
    }
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
        window.ade.automations.saveDraft({ draft, confirmations: [...acceptedConfirmations] }, machinePin(target)),
        target,
      );
      commitMachineRules(target, saved.rules);
      const nextSelected = saved.rules.find((r) => r.id === saved.rule.id) ?? null;
      // A rule that follows the account shows on the other machines too.
      if (nextSelected && followsAccount(nextSelected)) refreshForeign();
      setSelectedRuleId(nextSelected && followsAccount(nextSelected)
        ? saved.rule.id
        : target ? machineRuleKey(target, saved.rule.id) : saved.rule.id);
      const nextDraft = nextSelected ? toDraftFromRule(nextSelected) : createBlankDraft();
      setDraft(nextDraft);
      savedSnapshotRef.current = JSON.stringify(nextDraft);
      setIssues([]);
    } catch (err) {
      setError(explainError(err, ruleMachineName));
    } finally {
      setSaving(false);
    }
  }, [acceptedConfirmations, blockedReason, commitMachineRules, draft, draftCloudChosen, draftMachineChosen, draftMoving, draftOrigin, draftPin, draftTarget, machinePin, moveRule, needsNewerAde, refreshForeign, ruleMachineName, ruleMachineSupport, validateDraft]);

  const createRule = useCallback(async () => {
    if (!(await confirmDiscardIfDirty())) return;
    setSelectedRuleId(null);
    startNewDraftMachine();
    const blank = createBlankDraft();
    setDraft(blank);
    savedSnapshotRef.current = JSON.stringify(blank);
    setIssues([]);
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
        const run = await onMachine(
          window.ade.automations.triggerManually(
            { id: entry.rule.id, ...(laneId ? { laneId } : {}) },
            machinePin(entry.machine),
          ),
          entry.machine,
        );
        // ADE Cloud answers a refusal (agent limits, the storm stop, one already waiting) as the run, not an error.
        if (run.triggerMetadata?.runsOn === "ade-cloud" && (run.status === "failed" || run.status === "cancelled")) {
          showToast({
            tone: "warning",
            title: run.status === "failed" ? `"${entry.rule.name}" didn't start on ${BRAND.CLOUD_NAME}` : `"${entry.rule.name}" was skipped on ${BRAND.CLOUD_NAME}`,
            message: run.errorMessage ?? `${BRAND.CLOUD_NAME} didn't start this run.`,
            report: false,
          });
        }
        setManualRunRule(null);
        setManualRunLaneId("");
        if (!entry.machine.isActiveBinding) refreshMachine(entry.machine.machineId);
        else await refresh();
      } catch (err) {
        setError(explainError(err, entry.machine.machineName));
      } finally {
        manualRunPendingRef.current = false;
        setManualRunPending(false);
        setRunning(false);
      }
    },
    [blockedReason, machinePin, refresh, refreshMachine],
  );

  const beginRunRule = useCallback(
    (rule: AutomationRuleSummary) => {
      const entry = entryByRule.get(rule);
      if (!entry) return;
      const blocked = blockedReason(entry.machine) ?? ruleElsewhereReason(entry.rule);
      if (blocked) {
        setError(blocked);
        return;
      }
      const laneNeed = automationRunLaneNeed(rule);
      if (laneNeed !== "none") {
        setManualRunRule(rule);
        // Never preselect the lane a run will delete.
        setManualRunLaneId(laneNeed === "lane-to-delete" ? "" : lanesForMachine(entry.machine)[0]?.id ?? "");
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
        window.ade.automations.deleteRule({ id: entry.rule.id }, machinePin(entry.machine)),
        entry.machine,
      );
      commitMachineRules(entry.machine, next);
      // Deleted on every machine when it followed the account.
      if (followsAccount(entry.rule)) refreshForeign();
      setSelectedRuleId(next[0] ? ruleListKey(entry.machine, next[0]) : null);
      if (!next.length) setDraft(createBlankDraft());
    } catch (err) {
      setError(explainError(err));
    }
  }, [blockedReason, commitMachineRules, entryByKey, machinePin, refreshForeign]);

  const toggleRule = useCallback((key: string, enabled: boolean) => {
    const entry = entryByKey.get(key);
    if (!entry) return;
    const blocked = blockedReason(entry.machine);
    if (blocked) {
      setError(blocked);
      return;
    }
    Promise.resolve()
      .then(() => onMachine(window.ade.automations.toggle({ id: entry.rule.id, enabled }, machinePin(entry.machine)), entry.machine))
      .then((next) => commitMachineRules(entry.machine, next))
      .catch((err) => setError(explainError(err)));
  }, [blockedReason, commitMachineRules, entryByKey, machinePin]);

  const hasProjectSidebar = useHasProjectSidebar();
  const selectedEntry = selectedRuleId ? entryByKey.get(selectedRuleId) ?? null : null;
  const selectedRule = selectedEntry?.rule ?? null;
  const delivery = ingressStatus?.delivery ?? null;
  const manualRunEntry = manualRunRule ? entryByRule.get(manualRunRule) ?? null : null;
  const builderLanes = lanesForMachine(draftTarget);
  const builderSuites = draftForeignTarget?.pin ? draftMachineSuites ?? [] : suites;
  const builderIngress = draftForeignTarget?.pin ? draftMachineIngress : ingressStatus;
  const draftMachineBlocked = blockedReason(draftTarget);
  const noComputerOnline = !tabPin && !machines.some((machine) => machine.online && machine.pin);
  const machineNotes = Object.keys(foreignLoads).length > 0 || noComputerOnline ? (
    <div
      className="flex shrink-0 flex-wrap gap-x-3 gap-y-0.5 border-b border-fg/[0.04] px-3 py-1 text-[10.5px] text-muted-fg/50"
      data-testid="automations-machine-notes"
    >
      {noComputerOnline ? <span>{NO_COMPUTER_ONLINE}</span> : null}
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
          {draft && detailView === "builder" && needsNewerAde.length > 0 && ruleMachine ? (
            <Banner
              layout="inline"
              testId="automation-needs-newer-ade"
              style={{ margin: "8px 16px 0" }}
              model={{
                id: "automation-needs-newer-ade",
                tone: "warning",
                title: ruleMachine.brainVersion
                  ? `${ruleMachine.machineName} runs ${BRAND.NAME} ${ruleMachine.brainVersion}, which is too old for this rule.`
                  : `The ${BRAND.NAME} on ${ruleMachine.machineName} is too old for this rule.`,
                detail: `Update ${BRAND.NAME} on ${ruleMachine.machineName} to use ${needsNewerAde
                  .map((feature) => (feature.minVersion ? `${feature.label} (${BRAND.NAME} ${feature.minVersion})` : feature.label))
                  .join(", ")}. Until then the rule cannot run there.`,
              }}
            />
          ) : null}
          {draft && detailView === "builder" && selectedRule?.needsNewerAde ? (
            <Banner
              layout="inline"
              testId="automation-rule-newer-ade"
              style={{ margin: "8px 16px 0" }}
              model={{
                id: "automation-rule-newer-ade",
                tone: "warning",
                icon: <CloudArrowDown size={16} weight="duotone" />,
                title: `Made with a newer ${BRAND.NAME}`,
                detail: `This ${BRAND.NAME} can't read all of it, so it's view-only here and left as it is in your account. Update ${BRAND.NAME} to edit or run it.`,
              }}
            />
          ) : null}
          {draft && detailView === "builder" && !draftMoving && selectedRule?.homeGaps?.length ? (
            <Banner
              layout="inline"
              testId="automation-home-gaps"
              style={{ margin: "8px 16px 0" }}
              model={{
                id: "automation-home-gaps",
                tone: "warning",
                title: "This computer is missing something this automation needs",
                detail: (
                  <ul className="mt-0.5 space-y-0.5">
                    {selectedRule.homeGaps.map((gap) => <li key={gap}>{gap}</li>)}
                  </ul>
                ),
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
                key={`${selectedEntry?.key ?? selectedRule.id}::${linkedRunId ?? ""}`}
                automationId={selectedRule.id}
                initialRunId={linkedRunId}
                ruleName={selectedRule.name}
                pin={selectedEntry?.machine.pin ?? null}
                isActiveBinding={selectedEntry?.machine.isActiveBinding ?? true}
                machineName={selectedEntry?.machine.machineName ?? null}
                offlineMessage={blockedReason(selectedEntry?.machine ?? null)}
              />
            ) : draft ? (
              <AutomationFeatureGateContext.Provider value={featureGate}>
              <RuleBuilder
                draft={draft}
                setDraft={setDraft}
                lanes={builderLanes.map((l) => ({ id: l.id, name: l.name }))}
                suites={builderSuites}
                ingressStatus={builderIngress}
                issues={issues}
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
                onTest={(kind) => setTestKind(kind)}
                testBlockedReason={
                  !selectedRule
                    ? "Save this automation to test it."
                    : selectedRule.needsNewerAde
                      ? `Made with a newer ${BRAND.NAME}. Update ${BRAND.NAME} on this computer to test it.`
                      : needsNewerAde.length > 0
                        ? `${ruleMachineName ?? "The machine that runs this rule"} can't run this rule yet. Update ${BRAND.NAME} there to test it.`
                        : null
                }
                onRunNow={selectedRule ? () => beginRunRule(selectedRule) : undefined}
                runBlockedReason={selectedRule ? ruleElsewhereReason(selectedRule) : null}
                onIngressChanged={() => {
                  // The draft's machine owns its ingress status.
                  if (draftForeignTarget?.pin) setDraftMachineReadNonce((n) => n + 1);
                  else void refresh();
                }}
                runtimePin={draftPin}
                machineField={
                  <RuleMachineField
                    machines={ruleMachineChoices}
                    valueMachineId={draftMachineChosen ? (draftTarget?.machineId ?? boundMachine?.machineId ?? null) : null}
                    savedMachineId={draftOrigin ? (draftOrigin.machine?.machineId ?? boundMachine?.machineId ?? null) : null}
                    followsAccount={Boolean(selectedRule && followsAccount(selectedRule))}
                    unreachableHomeName={
                      selectedRule && followsAccount(selectedRule) && selectedRule.runsHere === false && !draftRehomeChosen && !isAdeCloudHome(selectedRule.home)
                        ? selectedRule.home?.name ?? null
                        : null
                    }
                    cloudHome={selectedRule && !followsAccount(selectedRule) ? null : {
                      available: adeCloudEnabled,
                      chosen: draftCloudChosen || (!draftRehomeChosen && isAdeCloudHome(selectedRule?.home)),
                      problem: automationCloudHomeProblem({ scope: draft.scope, triggers: draft.triggers, execution: draft.execution, prompt: draft.prompt, oneShot: draft.oneShot, maxRuns: draft.maxRuns }),
                      state: draftCloudChosen ? null : selectedRule?.cloud ?? null,
                      onChoose: () => {
                        setDraftCloudChosen(!isAdeCloudHome(selectedRule?.home) || draftRehomeChosen);
                        setDraftRehomeChosen(false);
                        setDraftMachineChosen(true);
                        setError(null);
                      },
                    }}
                    homeName={selectedRule && followsAccount(selectedRule) ? selectedRule.home?.name ?? null : null}
                    rehoming={draftRehomeChosen}
                    sync={selectedRule && !draftMoving ? ruleSyncLine(selectedRule) : null}
                    disabled={saving}
                    onChange={(machineId) => {
                      const next = machines.find((machine) => machine.machineId === machineId);
                      if (!next) return;
                      if (selectedRule && followsAccount(selectedRule) && selectedRule.runsHere === false) setDraftRehomeChosen(true);
                      setDraftCloudChosen(false);
                      setDraftTarget(next.isActiveBinding ? null : next);
                      setDraftMachineChosen(true);
                      setError(null);
                    }}
                  />
                }
                saveBlockedReason={
                  selectedRule?.needsNewerAde
                    ? `Made with a newer ${BRAND.NAME}. Update ${BRAND.NAME} on this computer to change it.`
                    : draftMachineChosen || draftRehomeChosen || Boolean(selectedRule && followsAccount(selectedRule))
                      ? null
                      : CHOOSE_MACHINE_HINT
                }
                cursorCloudConnected={cursorCloudConnected}
                saving={saving}
                running={running}
                dirty={isDirty}
              />
              </AutomationFeatureGateContext.Provider>
            ) : (
              <EmptyDetail onNew={createRule} onOpenTemplates={onOpenTemplates} />
            )}
          </div>
        </div>
      )}

      {testKind && selectedEntry ? (
        <TestRunDialog
          open
          kind={testKind}
          ruleId={selectedEntry.rule.id}
          ruleName={selectedEntry.rule.name}
          trigger={selectedEntry.rule.triggers[0] ?? selectedEntry.rule.trigger ?? { type: "manual" }}
          laneMode={selectedEntry.rule.execution?.laneMode ?? null}
          pin={selectedEntry.machine.pin}
          saveFirstReason={isDirty
            ? "Save your changes first. A test runs the saved automation."
            : blockedReason(selectedEntry.machine)}
          onClose={() => setTestKind(null)}
          onStarted={() => {
            setTestKind(null);
            setDetailView("history");
            if (!selectedEntry.machine.isActiveBinding) refreshMachine(selectedEntry.machine.machineId);
            else void refresh();
          }}
        />
      ) : null}

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
          Pick a trigger and a workflow, then let {BRAND.NAME} run it — on a schedule or when a product event fires.
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
  const deletes = automationRunLaneNeed(rule) === "lane-to-delete";
  // The primary lane is the project checkout; it is never a lane to delete.
  const choices = deletes ? lanes.filter((lane) => lane.laneType !== "primary") : lanes;
  // Steps that delete a lane the rule names run too; the confirmation says so.
  const alsoDeletes = deletes
    ? (rule.execution?.builtIn?.actions ?? [])
      .filter((action) => action.type === "delete-lane" && action.targetLaneId?.trim())
      .map((action) => lanes.find((lane) => lane.id === action.targetLaneId)?.name ?? action.targetLaneId!)
    : [];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={deletes ? "Choose the lane to delete" : "Choose a lane for this run"}
      tone={deletes ? "error" : "neutral"}
      description={deletes
        ? `${rule.name} deletes the lane its trigger names. Run by hand, it deletes the lane you pick here${
          alsoDeletes.length ? `, and also ${alsoDeletes.join(", ")}` : ""
        }.`
        : `${rule.name} requires a lane when triggered.`}
      width={448}
      actions={[
        { label: "Cancel", variant: "secondary", onClick: onCancel },
        {
          label: deletes ? "Delete lane" : "Run",
          variant: "solid",
          icon: deletes ? <Trash size={12} weight="fill" /> : <Play size={12} weight="fill" />,
          disabled: !laneId || pending,
          onClick: onRun,
        },
      ]}
    >
      <label className="block space-y-1.5">
        <span className="text-[10px] uppercase tracking-[0.1em] text-muted-fg/60">Lane</span>
        <select className={inputCls} value={laneId} onChange={(e) => onLaneId(e.target.value)}>
          {deletes ? <option value="">Choose a lane</option> : null}
          {choices.map((lane) => (
            <option key={lane.id} value={lane.id}>
              {lane.name}
            </option>
          ))}
        </select>
      </label>
      {!choices.length ? (
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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
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
import {
  machineChipForTarget,
  offlineMessage,
  targetByKey,
  useProjectMachineTargets,
  withMachineTimeout,
  type ProjectMachineTarget,
} from "../history/projectMachines";
import { RuleMachineField } from "./builder/RuleMachineField";
import type { RuleMachineView } from "./list/RuleList";

/**
 * One rule on one machine. Rules come from every machine that holds the
 * project; a rule id is only unique on its own machine, so the list key is
 * machine-qualified for every machine but the tab's own (whose keys stay the
 * bare rule id, as before).
 */
type MachineRule = {
  key: string;
  rule: AutomationRuleSummary;
  target: ProjectMachineTarget;
};

type ForeignRuleLoad = {
  machineName: string;
  status: "loading" | "offline" | "error";
  message: string | null;
};

function machineRuleKey(target: ProjectMachineTarget, ruleId: string): string {
  return target.isActive ? ruleId : `${target.key}::${ruleId}`;
}

/** Pinned calls are timed out; the tab machine keeps its existing path. */
function onMachine<T>(promise: Promise<T>, target: ProjectMachineTarget | null): Promise<T> {
  return target?.pin ? withMachineTimeout(promise, target.machineName) : promise;
}

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

  // ── Machines ────────────────────────────────────────────────
  const machineTargets = useProjectMachineTargets(active);
  const boundTarget = machineTargets[0] ?? null;
  const [foreignRules, setForeignRules] = useState<Record<string, AutomationRuleSummary[]>>({});
  const [foreignLoads, setForeignLoads] = useState<Record<string, ForeignRuleLoad>>({});
  /**
   * The machine the open draft belongs to; null = the tab's machine. Captured
   * as the full target (with its pin) so a save always goes to the machine the
   * draft was opened on, even if the union momentarily drops it.
   */
  const [draftTarget, setDraftTarget] = useState<ProjectMachineTarget | null>(null);
  /**
   * False while a new draft has no machine yet: the "Runs on" field is empty
   * and Save is blocked. The machine is always chosen, never defaulted.
   */
  const [draftMachineChosen, setDraftMachineChosen] = useState(true);
  /**
   * Where the selected saved rule lives today. A different `draftTarget` means
   * Save moves it. Null for a new draft; `undefined` key = the tab's machine.
   */
  const [draftOrigin, setDraftOrigin] = useState<{ target: ProjectMachineTarget | null } | null>(null);
  const loadedRuleKeyRef = useRef<string | null>(null);
  const [draftMachineSuites, setDraftMachineSuites] = useState<TestSuiteDefinition[] | null>(null);
  const [draftMachineIngress, setDraftMachineIngress] = useState<AutomationIngressStatus | null>(null);
  /** Bumped to re-read the draft machine's suites and ingress status. */
  const [draftMachineReadNonce, setDraftMachineReadNonce] = useState(0);
  const foreignReadSeqRef = useRef(new Map<string, number>());

  const entries = useMemo<MachineRule[]>(() => {
    const next: MachineRule[] = [];
    for (const target of machineTargets) {
      const machineRules = target.isActive ? rules : foreignRules[target.key] ?? [];
      for (const rule of machineRules) {
        next.push({ key: machineRuleKey(target, rule.id), rule, target });
      }
    }
    return next;
  }, [foreignRules, machineTargets, rules]);
  const entryByKey = useMemo(() => new Map(entries.map((entry) => [entry.key, entry])), [entries]);
  const entryByRule = useMemo(() => {
    const map = new WeakMap<AutomationRuleSummary, MachineRule>();
    for (const entry of entries) map.set(entry.rule, entry);
    return map;
  }, [entries]);
  const allRules = useMemo(() => entries.map((entry) => entry.rule), [entries]);
  const ruleKeyOf = useCallback(
    (rule: AutomationRuleSummary) => entryByRule.get(rule)?.key ?? rule.id,
    [entryByRule],
  );
  const machineOfRule = useCallback((rule: AutomationRuleSummary): RuleMachineView | null => {
    const entry = entryByRule.get(rule);
    if (!entry) return null;
    return {
      chip: machineChipForTarget(entry.target, machineTargets),
      offlineMessage: entry.target.online ? null : offlineMessage(entry.target),
      isBound: entry.target.isActive,
    };
  }, [entryByRule, machineTargets]);

  /** The live state of a machine, by key; a captured target may be stale. */
  const liveTarget = useCallback(
    (target: ProjectMachineTarget | null) => (target ? targetByKey(machineTargets, target.key) ?? target : null),
    [machineTargets],
  );
  /** Why an action on this machine can't run right now, or null. */
  const blockedReason = useCallback((target: ProjectMachineTarget | null): string | null => {
    const live = liveTarget(target);
    return live && !live.online ? offlineMessage(live) : null;
  }, [liveTarget]);

  /** Store one machine's rules as returned by a call that ran there. */
  const commitMachineRules = useCallback((target: ProjectMachineTarget | null, next: AutomationRuleSummary[]) => {
    if (!target || target.isActive || !target.pin) {
      setRules(next);
      return;
    }
    setForeignRules((current) => ({ ...current, [target.key]: next }));
  }, []);

  // A saved rule pointed at another machine is an unsaved change (a move).
  const draftMoving = Boolean(draftOrigin && (draftOrigin.target?.key ?? null) !== (draftTarget?.key ?? null));
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
    if (ok && draftOrigin) setDraftTarget(draftOrigin.target);
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
      const [nextRules, nextSuites, nextLanes, nextIngress, snapshot, aiStatus] = await Promise.all([
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
      setSelectedRuleId((current) => {
        // A selection on another machine is that machine's business; this
        // refresh only speaks for the tab's own rules.
        if (current && (current.includes("::") || nextRules.some((r) => r.id === current))) return current;
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

  /**
   * Read every other machine's rules. Each machine lands on its own, timed out;
   * none of them gates the tab machine's list. An offline machine keeps its
   * last-reported rules (dimmed) and is not queried.
   */
  const foreignTargets = useMemo(() => machineTargets.filter((target) => !target.isActive), [machineTargets]);
  const foreignTargetsRef = useRef(foreignTargets);
  foreignTargetsRef.current = foreignTargets;
  const refreshForeign = useCallback(() => {
    const targets = foreignTargetsRef.current;
    const keys = new Set(targets.map((target) => target.key));
    setForeignRules((current) => {
      const kept = Object.fromEntries(Object.entries(current).filter(([key]) => keys.has(key)));
      return Object.keys(kept).length === Object.keys(current).length ? current : kept;
    });
    setForeignLoads((current) => {
      const next: Record<string, ForeignRuleLoad> = {};
      for (const target of targets) {
        if (!target.online) {
          next[target.key] = { machineName: target.machineName, status: "offline", message: offlineMessage(target) };
        } else if (current[target.key] && current[target.key]!.status !== "offline") {
          next[target.key] = current[target.key]!;
        }
      }
      return next;
    });
    for (const target of targets) {
      if (!target.online || !target.pin) continue;
      const seq = (foreignReadSeqRef.current.get(target.key) ?? 0) + 1;
      foreignReadSeqRef.current.set(target.key, seq);
      setForeignLoads((current) => current[target.key]
        ? current
        : { ...current, [target.key]: { machineName: target.machineName, status: "loading", message: null } });
      void withMachineTimeout(window.ade.automations.list(target.pin), target.machineName)
        .then((next) => {
          if (foreignReadSeqRef.current.get(target.key) !== seq) return;
          setForeignRules((current) => ({ ...current, [target.key]: Array.isArray(next) ? next : [] }));
          setForeignLoads((current) => {
            if (!current[target.key]) return current;
            const rest = { ...current };
            delete rest[target.key];
            return rest;
          });
        })
        .catch((err) => {
          if (foreignReadSeqRef.current.get(target.key) !== seq) return;
          setForeignLoads((current) => ({
            ...current,
            [target.key]: { machineName: target.machineName, status: "error", message: extractError(err) },
          }));
        });
    }
  }, []);

  // Membership and reachability, not lane churn, decide when to re-read.
  const foreignSignature = foreignTargets
    .map((target) => `${target.key}\u0000${target.online ? 1 : 0}`)
    .join("\u0001");
  useEffect(() => {
    if (!active) return;
    refreshForeign();
  }, [active, foreignSignature, refreshForeign]);

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
  const machineTargetsRef = useRef(machineTargets);
  machineTargetsRef.current = machineTargets;
  const startNewDraftMachine = useCallback(() => {
    const eligible = machineTargetsRef.current.filter((target) => target.online && (target.isActive || target.pin));
    const only = eligible.length === 1 ? eligible[0]! : null;
    loadedRuleKeyRef.current = null;
    setDraftOrigin(null);
    setDraftTarget(only && !only.isActive ? only : null);
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
      const nextTarget = selectedEntry.target.isActive ? null : selectedEntry.target;
      setDraftTarget(nextTarget);
      setDraftOrigin({ target: nextTarget });
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
    from: ProjectMachineTarget | null,
    to: ProjectMachineTarget | null,
  ) => {
    const fromName = from?.machineName ?? boundTarget?.machineName ?? "this machine";
    const toName = to?.machineName ?? boundTarget?.machineName ?? "this machine";
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
      setDraftOrigin({ target: to });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acceptedConfirmations, blockedReason, boundTarget?.machineName, commitMachineRules, validateDraft]);

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
      await moveRule(draft as AutomationRuleDraft & { id: string }, draftOrigin.target, draftTarget);
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
      const blocked = blockedReason(entry.target);
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
            entry.target.pin,
          ),
          entry.target,
        );
        setManualRunRule(null);
        setManualRunLaneId("");
        if (entry.target.pin) refreshForeign();
        else await refresh();
      } catch (err) {
        setError(extractError(err));
      } finally {
        manualRunPendingRef.current = false;
        setManualRunPending(false);
        setRunning(false);
      }
    },
    [blockedReason, refresh, refreshForeign],
  );

  /** A machine's lanes for picking a run target: the tab's own list, or the union's. */
  const lanesForTarget = useCallback(
    (target: ProjectMachineTarget | null): LaneSummary[] =>
      !target || target.isActive ? lanes : target.lanes.filter((lane) => !lane.archivedAt),
    [lanes],
  );

  const beginRunRule = useCallback(
    (rule: AutomationRuleSummary) => {
      const entry = entryByRule.get(rule);
      if (!entry) return;
      const blocked = blockedReason(entry.target);
      if (blocked) {
        setError(blocked);
        return;
      }
      if (rule.execution?.laneMode === "require-on-trigger") {
        setManualRunRule(rule);
        setManualRunLaneId(lanesForTarget(entry.target)[0]?.id ?? "");
        return;
      }
      void runRuleNow(entry);
    },
    [blockedReason, entryByRule, lanesForTarget, runRuleNow],
  );

  const deleteRule = useCallback(async (key: string) => {
    const entry = entryByKey.get(key);
    if (!entry) return;
    const blocked = blockedReason(entry.target);
    if (blocked) {
      setError(blocked);
      return;
    }
    setError(null);
    try {
      const next = await onMachine(
        window.ade.automations.deleteRule({ id: entry.rule.id }, entry.target.pin),
        entry.target,
      );
      commitMachineRules(entry.target, next);
      setSelectedRuleId(next[0] ? machineRuleKey(entry.target, next[0].id) : null);
      if (!next.length) setDraft(createBlankDraft());
    } catch (err) {
      setError(extractError(err));
    }
  }, [blockedReason, commitMachineRules, entryByKey]);

  const toggleRule = useCallback((key: string, enabled: boolean) => {
    const entry = entryByKey.get(key);
    if (!entry) return;
    const blocked = blockedReason(entry.target);
    if (blocked) {
      setError(blocked);
      return;
    }
    onMachine(window.ade.automations.toggle({ id: entry.rule.id, enabled }, entry.target.pin), entry.target)
      .then((next) => commitMachineRules(entry.target, next))
      .catch((err) => setError(extractError(err)));
  }, [blockedReason, commitMachineRules, entryByKey]);

  const hasProjectSidebar = useHasProjectSidebar();
  const selectedEntry = selectedRuleId ? entryByKey.get(selectedRuleId) ?? null : null;
  const selectedRule = selectedEntry?.rule ?? null;
  const delivery = ingressStatus?.delivery ?? null;
  const manualRunEntry = manualRunRule ? entryByRule.get(manualRunRule) ?? null : null;
  const builderLanes = lanesForTarget(draftTarget);
  const builderSuites = draftTarget?.pin ? draftMachineSuites ?? [] : suites;
  const builderIngress = draftTarget?.pin ? draftMachineIngress : ingressStatus;
  const draftMachineBlocked = blockedReason(draftTarget);
  const machineNotes = Object.keys(foreignLoads).length > 0 ? (
    <div
      className="flex shrink-0 flex-wrap gap-x-3 gap-y-0.5 border-b border-white/[0.04] px-3 py-1 text-[10.5px] text-muted-fg/50"
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
        <div className="flex min-h-0 w-[340px] shrink-0 flex-col border-r border-white/[0.06] bg-white/[0.01]">
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
            <div className="flex shrink-0 items-center gap-0 border-b border-white/[0.06] bg-white/[0.01] px-3" style={{ minHeight: 34 }}>
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

          {draft && detailView === "builder" && draftMachineChosen && draftMachineBlocked ? (
            <div
              className="flex shrink-0 items-center gap-1.5 border-b border-white/[0.06] px-4 py-1.5 text-[11px] text-amber-300/80"
              data-testid="automation-draft-machine"
            >
              {draftMachineBlocked}
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-hidden">
            {detailView === "history" && selectedRule ? (
              <RuleHistory
                key={selectedEntry?.key ?? selectedRule.id}
                automationId={selectedRule.id}
                ruleName={selectedRule.name}
                pin={selectedEntry?.target.pin ?? null}
                machineName={selectedEntry?.target.machineName ?? null}
                offlineMessage={blockedReason(selectedEntry?.target ?? null)}
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
                    targets={machineTargets}
                    valueKey={draftMachineChosen ? (draftTarget?.key ?? boundTarget?.key ?? null) : null}
                    savedKey={draftOrigin ? (draftOrigin.target?.key ?? boundTarget?.key ?? null) : null}
                    disabled={saving}
                    onChange={(key) => {
                      const next = targetByKey(machineTargets, key);
                      if (!next) return;
                      setDraftTarget(next.isActive ? null : next);
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
          lanes={lanesForTarget(manualRunEntry?.target ?? null)}
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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowsLeftRight, CaretDown, CaretRight, X } from "@phosphor-icons/react";
import type {
  AutomationAction,
  AutomationRule,
  AutomationRuleDraft,
  AutomationRuleSummary,
  AutomationTriggerType,
  LaneSummary,
  OpenProjectBinding,
  TerminalSessionSummary,
} from "../../../shared/types";
import { resolveModelDescriptor } from "../../../shared/modelRegistry";
import { deriveConfiguredModelIds } from "../../lib/modelOptions";
import { useAppStore } from "../../state/appStore";
import { resolveModelDescriptorWithRuntimeCatalog } from "../shared/ModelPicker/modelCatalog";
import { ModelPicker } from "../shared/ModelPicker/ModelPicker";
import { ReasoningEffortPicker } from "../shared/ModelPicker/ReasoningEffortPicker";
import { cn } from "../ui/cn";
import { getFocusableElements } from "../ui/dialogFocus";
import { LaneCombobox, type LaneComboboxLane } from "./LaneCombobox";
import { saveAutoHandoffRules } from "./sessionLifecycleActions";

/**
 * "Auto handoff" — the chat-menu front door to the automation platform.
 *
 * One rule per condition, NOT one rule with three triggers. Both the planner
 * (`normalizeDraft` slices `triggers` to one with a warning) and the runtime
 * (`normalizeRuntimeRule` stores `triggers: [primary]`) collapse a rule to a
 * single trigger, so a three-condition rule would silently lose two thirds of
 * what the user asked for. Rule ids are derived from the scope + condition so
 * re-saving upserts the same rows instead of piling up duplicates, and a
 * condition the user switched OFF is deleted rather than left firing.
 */

export type AutoHandoffConditionKey = "limit" | "failure" | "ended";

export const AUTO_HANDOFF_CONDITIONS: ReadonlyArray<{
  key: AutoHandoffConditionKey;
  triggerType: AutomationTriggerType;
  /** Chip copy, lower case because it sits inside a sentence. */
  label: string;
  /** Rule-name fragment; this one is read on its own in the Automations list. */
  ruleLabel: string;
  hint: string;
}> = [
  {
    key: "limit",
    triggerType: "session.limit_reached",
    label: "usage limit",
    ruleLabel: "usage limit",
    hint: "The provider's usage window closed mid-chat.",
  },
  {
    key: "failure",
    triggerType: "session.failed",
    label: "API failure",
    ruleLabel: "API failure",
    hint: "The provider or the runtime failed the turn.",
  },
  {
    key: "ended",
    triggerType: "session.ended_without_pr",
    label: "chat ends",
    ruleLabel: "chat ends",
    hint: "The chat ended without opening a PR.",
  },
];

const CONDITION_BY_TRIGGER = new Map<string, AutoHandoffConditionKey>(
  AUTO_HANDOFF_CONDITIONS.map((condition) => [condition.triggerType, condition.key]),
);

/**
 * The lane a handoff goes to. One table, read by the radio group, the sentence
 * summary and the payload builder alike, so the UI vocabulary and the wire
 * vocabulary (`AutomationAction.targetLaneMode`) cannot drift apart.
 *
 * `"new"` deliberately sends no `laneNameTemplate`: with none, the service names
 * the lane from the rule's `scope.sessionTitle` — the chat title this menu
 * already stores — which is a better default than any template invented here.
 */
export const AUTO_HANDOFF_LANE_TARGETS = [
  { value: "same", label: "this lane", sentence: "this lane" },
  { value: "new", label: "a new lane", sentence: "a new lane" },
  { value: "explicit", label: "choose a lane…", sentence: "another lane" },
] as const;

export type AutoHandoffLaneTarget = (typeof AUTO_HANDOFF_LANE_TARGETS)[number]["value"];

/**
 * The one mapping from form state to the action's lane fields. `targetLaneId`
 * is written for `"explicit"` and nowhere else — sending it alongside `"same"`
 * or `"new"` would store a lane the runtime never reads.
 */
export function handoffLaneFields(form: Pick<AutoHandoffForm, "laneTarget" | "targetLaneId">): {
  targetLaneMode: AutoHandoffLaneTarget;
  targetLaneId?: string;
} {
  if (form.laneTarget === "explicit") {
    return { targetLaneMode: "explicit", targetLaneId: form.targetLaneId.trim() };
  }
  return { targetLaneMode: form.laneTarget };
}

/**
 * Matches `ONE_SHOT_DEFAULT_MAX_RUNS` in `automationService`: an unconfigured
 * one-shot rule is already capped at three there, so a field defaulting to 1
 * would show the user a number the runtime does not use.
 */
export const AUTO_HANDOFF_DEFAULT_RETRIES = 3;

export type AutoHandoffForm = {
  conditions: Record<AutoHandoffConditionKey, boolean>;
  targetModelId: string;
  reasoningEffort: string | null;
  prompt: string;
  mode: "fork" | "brief";
  laneTarget: AutoHandoffLaneTarget;
  /** Read only when `laneTarget` is `"explicit"`. */
  targetLaneId: string;
  /** Attempt cap written to the rule as `maxRuns`. */
  retries: number;
};

function slugForRuleId(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.length ? slug : "chat";
}

/**
 * Deterministic id so a second Save upserts the same rule (`saveDraft` keys on
 * a supplied id) instead of appending `-2`, `-3`, … forever.
 */
export function autoHandoffRuleId(
  scope: { sessionId: string } | null,
  condition: AutoHandoffConditionKey,
): string {
  return `auto-handoff-${scope ? slugForRuleId(scope.sessionId) : "all"}-${condition}`;
}

function ruleActions(rule: AutomationRule): AutomationAction[] {
  const fromExecution = rule.execution?.kind === "built-in" ? rule.execution.builtIn?.actions : undefined;
  if (fromExecution?.length) return fromExecution;
  if (rule.legacy?.actions?.length) return rule.legacy.actions;
  return rule.actions ?? [];
}

function handoffActionOf(rule: AutomationRule): AutomationAction | null {
  return ruleActions(rule).find((action) => action.type === "handoff") ?? null;
}

/**
 * The rules this chat's menu owns. Scope is the identity — a rule the CTO or
 * the user scoped to this chat for some other purpose has no handoff action and
 * must not be swept up by "Remove auto handoff".
 */
export function selectAutoHandoffRulesForSession(
  rules: readonly AutomationRuleSummary[] | null | undefined,
  sessionId: string,
): AutomationRuleSummary[] {
  if (!rules?.length || !sessionId) return [];
  return rules.filter((rule) => rule.scope?.sessionId === sessionId && handoffActionOf(rule) != null);
}

/** Rebuilds the form from the rules already saved for this chat. */
export function formFromRules(
  rules: readonly AutomationRuleSummary[],
  fallback: AutoHandoffForm,
): AutoHandoffForm {
  if (!rules.length) return fallback;
  const conditions: Record<AutoHandoffConditionKey, boolean> = {
    limit: false,
    failure: false,
    ended: false,
  };
  for (const rule of rules) {
    for (const trigger of rule.triggers ?? []) {
      const key = CONDITION_BY_TRIGGER.get(trigger.type);
      if (key) conditions[key] = true;
    }
  }
  const action = rules.map(handoffActionOf).find(Boolean) ?? null;
  const maxRuns = rules.map((rule) => rule.maxRuns).find((value) => typeof value === "number");
  return {
    conditions,
    targetModelId: action?.targetModelId ?? fallback.targetModelId,
    reasoningEffort: action?.reasoningEffort ?? fallback.reasoningEffort,
    prompt: action?.promptTemplate ?? "",
    mode: action?.handoffMode === "brief" ? "brief" : "fork",
    laneTarget: action?.targetLaneMode === "new" || action?.targetLaneMode === "explicit"
      ? action.targetLaneMode
      : "same",
    targetLaneId: action?.targetLaneId ?? "",
    retries: typeof maxRuns === "number" ? maxRuns : fallback.retries,
  };
}

export function autoHandoffFormIsValid(form: AutoHandoffForm): boolean {
  if (!form.targetModelId) return false;
  if (!AUTO_HANDOFF_CONDITIONS.some((c) => form.conditions[c.key])) return false;
  // "explicit" with no lane is rejected by the service with an exact message;
  // the user must never be able to reach that state from here.
  if (form.laneTarget === "explicit" && !form.targetLaneId.trim()) return false;
  return true;
}

/**
 * One `AutomationRuleDraft` per selected condition, shaped for the existing
 * `automations.saveDraft` path. `scope` present ⇒ this chat only, one-shot;
 * `scope` absent ⇒ the same automation for every chat.
 */
export function buildAutoHandoffDrafts(args: {
  form: AutoHandoffForm;
  session: Pick<TerminalSessionSummary, "id" | "title">;
  scoped: boolean;
}): AutomationRuleDraft[] {
  const { form, session, scoped } = args;
  const scope = scoped ? { sessionId: session.id, sessionTitle: session.title } : null;
  const prompt = form.prompt.trim();
  const maxRuns = Number.isFinite(form.retries) ? Math.max(1, Math.min(5, Math.floor(form.retries))) : 1;

  return AUTO_HANDOFF_CONDITIONS.filter((condition) => form.conditions[condition.key]).map((condition) => {
    const id = autoHandoffRuleId(scope, condition.key);
    const trigger = {
      type: condition.triggerType,
      ...(scope ? { sessionId: scope.sessionId } : {}),
    };
    const action: AutomationRuleDraft["actions"][number] = {
      type: "handoff",
      handoffMode: form.mode,
      targetModelId: form.targetModelId,
      ...handoffLaneFields(form),
      ...(prompt ? { promptTemplate: prompt } : {}),
      ...(form.reasoningEffort
        ? { reasoningEffort: form.reasoningEffort as NonNullable<AutomationAction["reasoningEffort"]> }
        : {}),
    };
    return {
      id,
      name: scope
        ? `Auto handoff · ${condition.ruleLabel} · ${session.title}`
        : `Auto handoff · ${condition.ruleLabel} · every chat`,
      description: scope
        ? `Created from the chat menu for "${session.title}".`
        : "Created from a chat menu and applied to every chat.",
      enabled: true,
      origin: "chat-menu",
      ...(scope ? { scope, oneShot: true } : {}),
      maxRuns,
      mode: "review",
      triggers: [trigger],
      trigger,
      executor: { mode: "automation-bot" },
      reviewProfile: "quick",
      toolPalette: ["repo"],
      contextSources: [],
      guardrails: {},
      outputs: { disposition: "comment-only", createArtifact: true },
      verification: { verifyBeforePublish: false },
      billingCode: `auto:${id}`,
      actions: [action],
    } satisfies AutomationRuleDraft;
  });
}

/** Ids this chat owns that the new drafts no longer cover, so they get deleted. */
export function staleAutoHandoffRuleIds(args: {
  drafts: readonly AutomationRuleDraft[];
  existing: readonly AutomationRuleSummary[];
  scope: { sessionId: string } | null;
}): string[] {
  const keep = new Set(args.drafts.map((draft) => draft.id).filter(Boolean) as string[]);
  const candidates = new Set<string>(args.existing.map((rule) => rule.id));
  for (const condition of AUTO_HANDOFF_CONDITIONS) {
    candidates.add(autoHandoffRuleId(args.scope, condition.key));
  }
  return [...candidates].filter((id) => !keep.has(id));
}

/* ── UI ─────────────────────────────────────────────────────────────────── */

const FIELD_LABEL_CLASS = "text-[10px] font-medium uppercase tracking-[0.13em] text-muted-fg";

function FocusTrapDialog({
  labelledBy,
  onClose,
  onSubmit,
  children,
}: {
  labelledBy: string;
  onClose: () => void;
  onSubmit: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLElement | null>(null);

  const focusables = useCallback((): HTMLElement[] => {
    const root = ref.current;
    if (!root) return [];
    return getFocusableElements(root);
  }, []);

  // Escape and Enter are bound at the window, not the panel: clicking any of the
  // dialog's plain text leaves focus on <body>, and a panel-level handler would
  // then never see the key at all.
  const handlersRef = useRef({ onClose, onSubmit });
  handlersRef.current = { onClose, onSubmit };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        handlersRef.current.onClose();
        return;
      }
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      // A textarea owns Enter (the prompt is multi-line), and so does any
      // control that already answers it — buttons, links, selects, pickers.
      const tag = (event.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === "textarea" || tag === "button" || tag === "a" || tag === "select") return;
      event.preventDefault();
      handlersRef.current.onSubmit();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  return (
    <section
      ref={(node) => { ref.current = node; }}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      className="grid max-h-[min(720px,calc(100vh-32px))] w-[min(640px,calc(100vw-32px))] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-2xl border border-border/70 bg-surface-overlay text-fg shadow-float"
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const nodes = focusables();
        if (nodes.length === 0) return;
        const first = nodes[0]!;
        const last = nodes[nodes.length - 1]!;
        const active = document.activeElement as HTMLElement | null;
        if (event.shiftKey && (active === first || !ref.current?.contains(active))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      {children}
    </section>
  );
}

export type AutoHandoffModalProps = {
  session: TerminalSessionSummary;
  binding?: OpenProjectBinding | null;
  /** Rules already scoped to this chat, read by the menu before it opened. */
  existingRules: readonly AutomationRuleSummary[];
  onClose: () => void;
};

export function AutoHandoffModal({ session, binding = null, existingRules, onClose }: AutoHandoffModalProps) {
  const storeLanes = useAppStore((state) => state.lanes) as LaneSummary[] | undefined;
  const [availableModelIds, setAvailableModelIds] = useState<string[]>([]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const firstControlRef = useRef<HTMLButtonElement | null>(null);

  // The default target is the first configured model that is NOT what this chat
  // already runs: handing a chat back to the model that just hit its own limit
  // is the one choice that cannot help.
  const [form, setForm] = useState<AutoHandoffForm>(() => formFromRules(existingRules, {
    conditions: { limit: true, failure: false, ended: false },
    targetModelId: "",
    reasoningEffort: null,
    prompt: "",
    mode: "fork",
    laneTarget: "same",
    targetLaneId: "",
    retries: AUTO_HANDOFF_DEFAULT_RETRIES,
  }));

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const status = await window.ade?.ai?.getStatus?.();
        if (cancelled) return;
        // Every provider is a legal handoff target. Live-redirect support is a
        // CTO constraint, not a handoff one, so the list is never narrowed here.
        setAvailableModelIds(deriveConfiguredModelIds(status ?? null));
      } catch {
        if (!cancelled) setAvailableModelIds([]);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (form.targetModelId) return;
    const preferred = availableModelIds.find((id) => id !== session.modelId) ?? availableModelIds[0];
    if (preferred) setForm((current) => (current.targetModelId ? current : { ...current, targetModelId: preferred }));
  }, [availableModelIds, form.targetModelId, session.modelId]);

  useEffect(() => {
    firstControlRef.current?.focus();
  }, []);

  const conditionsChosen = AUTO_HANDOFF_CONDITIONS.some((condition) => form.conditions[condition.key]);
  const valid = autoHandoffFormIsValid(form);
  const targetLabel = useMemo(
    () => (form.targetModelId ? resolveModelDescriptor(form.targetModelId)?.displayName ?? form.targetModelId : "the new model"),
    [form.targetModelId],
  );
  const laneOptions = useMemo<LaneComboboxLane[]>(
    () => (storeLanes ?? [])
      .filter((lane) => lane.id !== session.laneId)
      .map((lane) => ({ id: lane.id, name: lane.name, color: lane.color, branchRef: lane.branchRef })),
    [storeLanes, session.laneId],
  );
  const laneSentence = useMemo(() => {
    if (form.laneTarget === "explicit") {
      const chosen = laneOptions.find((lane) => lane.id === form.targetLaneId);
      return chosen?.name ?? "another lane";
    }
    return AUTO_HANDOFF_LANE_TARGETS.find((target) => target.value === form.laneTarget)!.sentence;
  }, [form.laneTarget, form.targetLaneId, laneOptions]);
  // Same source of truth the picker itself uses, so the word and the control
  // can never disagree about whether there is anything to choose.
  const targetHasReasoningTiers = useMemo(
    () => (resolveModelDescriptorWithRuntimeCatalog(form.targetModelId, binding?.key)?.reasoningTiers?.length ?? 0) > 0,
    [binding?.key, form.targetModelId],
  );

  const setCondition = (key: AutoHandoffConditionKey, next: boolean) => {
    setForm((current) => ({ ...current, conditions: { ...current.conditions, [key]: next } }));
  };

  const save = useCallback(async (scoped: boolean) => {
    if (!autoHandoffFormIsValid(form) || saving) return;
    const drafts = buildAutoHandoffDrafts({ form, session, scoped });
    const scope = scoped ? { sessionId: session.id } : null;
    const stale = staleAutoHandoffRuleIds({
      drafts,
      existing: scoped ? existingRules : [],
      scope,
    });
    setSaving(true);
    const ok = await saveAutoHandoffRules({ drafts, staleRuleIds: stale, sessionId: session.id });
    setSaving(false);
    if (ok) onClose();
  }, [existingRules, form, onClose, saving, session]);

  const body = (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <FocusTrapDialog
        labelledBy="auto-handoff-title"
        onClose={onClose}
        onSubmit={() => { void save(true); }}
      >
        <header className="flex items-start justify-between gap-4 border-b border-border/60 px-5 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-[color:color-mix(in_srgb,var(--color-accent)_30%,transparent)] bg-[color:color-mix(in_srgb,var(--color-accent)_14%,transparent)] text-accent">
              <ArrowsLeftRight size={18} weight="duotone" />
            </div>
            <div className="min-w-0">
              <h2 id="auto-handoff-title" className="font-sans text-[14px] font-semibold text-fg/92">
                Auto handoff
              </h2>
              <p className="mt-1 truncate text-[11px] leading-4 text-muted-fg" title={session.title}>
                {session.title}
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close auto handoff"
            onClick={onClose}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-fg transition-colors hover:bg-[color:color-mix(in_srgb,var(--color-fg)_8%,transparent)] hover:text-fg/85"
          >
            <X size={15} />
          </button>
        </header>

        <div className="min-h-0 overflow-y-auto px-5 py-4">
          {/* The sentence. One card, read left to right, not a form grid. */}
          <div className="rounded-xl border border-border/60 bg-[color:color-mix(in_srgb,var(--color-fg)_3%,transparent)] px-4 py-3.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-[12px] leading-6 text-fg/70">
              <span>When</span>
              {AUTO_HANDOFF_CONDITIONS.map((condition, index) => {
                const active = form.conditions[condition.key];
                return (
                  <button
                    key={condition.key}
                    ref={index === 0 ? firstControlRef : undefined}
                    type="button"
                    role="switch"
                    aria-checked={active}
                    title={condition.hint}
                    onClick={() => setCondition(condition.key, !active)}
                    className={cn(
                      "inline-flex h-7 items-center rounded-md border px-2.5 font-sans text-[11.5px] font-medium transition-colors",
                      active
                        ? "border-[color:color-mix(in_srgb,var(--color-accent)_46%,transparent)] bg-[color:color-mix(in_srgb,var(--color-accent)_18%,transparent)] text-fg"
                        : "border-border/60 text-muted-fg hover:border-border hover:text-fg/80",
                    )}
                  >
                    {condition.label}
                  </button>
                );
              })}
              {/* Each verb travels with its own control: `whitespace-nowrap`
                  groups keep "then fork in [lane]" from breaking across lines at
                  the card's narrowest width. */}
              <span className="inline-flex items-center gap-2 whitespace-nowrap">
                <span>then</span>
                <span className="font-medium text-fg/88">{form.mode === "fork" ? "fork" : "brief"}</span>
                <span>in</span>
                {/* The sentence states the destination; the controls for it live
                    in Details, so there is exactly one lane control on the card.
                    Clicking the phrase opens the fold that owns it. */}
                <button
                  type="button"
                  aria-label={`Handoff lane: ${laneSentence}`}
                  onClick={() => setDetailsOpen(true)}
                  className="font-medium text-fg/88 underline decoration-dotted decoration-border underline-offset-4 transition-colors hover:decoration-accent"
                >
                  {laneSentence}
                </button>
              </span>
              <span className="inline-flex items-center gap-2 whitespace-nowrap">
                <span>using</span>
                <ModelPicker
                  value={form.targetModelId}
                  onChange={(modelId) => setForm((current) => ({ ...current, targetModelId: modelId }))}
                  surfaceKey="work-auto-handoff"
                  availableModelIds={availableModelIds}
                  runtimePin={binding}
                  compact
                />
              </span>
              {/* The word and the control appear together or not at all: the
                  picker renders nothing for a model with no reasoning tiers (and
                  for no model at all), which used to leave "effort" dangling at
                  the end of the sentence. */}
              {targetHasReasoningTiers ? (
                <span className="inline-flex items-center gap-2 whitespace-nowrap">
                  <span>effort</span>
                  <ReasoningEffortPicker
                    modelId={form.targetModelId}
                    reasoningEffort={form.reasoningEffort}
                    onChange={(effort) => setForm((current) => ({ ...current, reasoningEffort: effort }))}
                    catalogScopeKey={binding?.key}
                    compact
                  />
                </span>
              ) : null}
            </div>
            {/* The honest fork-fit line. ADE only learns how many turns actually
                travelled once the fork runs (`truncatedTurnCount` comes back
                from `handoffSession`), so no count is promised up front. */}
            {form.mode === "fork" ? (
              <p className="mt-2.5 text-[10.5px] leading-4 text-muted-fg">
                This fork replays the whole conversation into {targetLabel}. Oldest turns drop only if the transcript
                exceeds its context window or provider input limit.
              </p>
            ) : (
              <p className="mt-2.5 text-[10.5px] leading-4 text-muted-fg">
                A brief summarizes this chat for {targetLabel} and starts it fresh.
              </p>
            )}
            {!conditionsChosen ? (
              <p role="alert" className="mt-2.5 text-[10.5px] leading-4 text-[color:var(--color-error)]">
                Pick at least one thing to hand off on.
              </p>
            ) : null}
          </div>

          <div className="mt-4">
            <label htmlFor="auto-handoff-prompt" className={FIELD_LABEL_CLASS}>Prompt</label>
            <textarea
              id="auto-handoff-prompt"
              value={form.prompt}
              rows={3}
              onChange={(event) => setForm((current) => ({ ...current, prompt: event.target.value }))}
              placeholder="What the new chat should do first. {{trigger.session.modelId}}, {{trigger.session.provider}}, {{trigger.session.resetAt}} and the other {{trigger.session.*}} placeholders are filled in when it runs."
              className="mt-1.5 w-full resize-y rounded-lg border border-border/60 bg-[color:color-mix(in_srgb,var(--color-fg)_3%,transparent)] px-3 py-2 text-[12px] leading-5 text-fg/88 outline-none placeholder:text-muted-fg/70 focus:border-accent"
            />
          </div>

          <div className="mt-4 rounded-lg border border-border/60">
            <button
              type="button"
              aria-expanded={detailsOpen}
              onClick={() => setDetailsOpen((open) => !open)}
              className="flex w-full items-center gap-1.5 rounded-lg px-3 py-2 text-left text-[11.5px] font-medium text-fg/75 transition-colors hover:bg-[color:color-mix(in_srgb,var(--color-fg)_5%,transparent)]"
            >
              {detailsOpen ? <CaretDown size={12} /> : <CaretRight size={12} />}
              Details
            </button>
            {detailsOpen ? (
              <div className="space-y-3.5 border-t border-border/50 px-3 py-3">
                <div>
                  <div className={FIELD_LABEL_CLASS}>How it carries over</div>
                  <div className="mt-1.5 inline-flex rounded-lg border border-border/60 p-0.5">
                    {(["fork", "brief"] as const).map((mode) => {
                      const active = form.mode === mode;
                      // Half of the coupling. Fork RESOLVES the conflict rather
                      // than being disabled by it: a disabled Fork would dead-end
                      // anyone who picked another lane first, and would make this
                      // direction of the coupling unreachable. The lane group
                      // owns the other half and forces Brief.
                      const pullsLaneBack = mode === "fork" && form.laneTarget !== "same";
                      return (
                        <button
                          key={mode}
                          type="button"
                          aria-pressed={active}
                          title={pullsLaneBack
                            ? "A fork has to stay in the chat's own lane, so this moves it back to this lane"
                            : undefined}
                          onClick={() => setForm((current) => ({
                            ...current,
                            mode,
                            // Picking Fork moves the destination back with it,
                            // so the two controls can never disagree.
                            ...(mode === "fork" ? { laneTarget: "same" as const, targetLaneId: "" } : {}),
                          }))}
                          className={cn(
                            "rounded-md px-3 py-1 font-sans text-[11px] font-semibold transition-colors",
                            active
                              ? "bg-[color:color-mix(in_srgb,var(--color-accent)_18%,transparent)] text-fg"
                              : "text-muted-fg hover:text-fg/80",
                          )}
                        >
                          {mode === "fork" ? "Fork" : "Brief"}
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-1.5 text-[10.5px] leading-4 text-muted-fg">
                    A fork carries the conversation itself; a brief carries a summary and can go to another lane.
                  </p>
                </div>
                <div>
                  <div className={FIELD_LABEL_CLASS}>Where it goes</div>
                  <div
                    role="radiogroup"
                    aria-label="Where it goes"
                    className="mt-1.5 inline-flex rounded-lg border border-border/60 p-0.5"
                  >
                    {AUTO_HANDOFF_LANE_TARGETS.map((target) => {
                      const active = form.laneTarget === target.value;
                      return (
                        <button
                          key={target.value}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          onClick={() => setForm((current) => ({
                            ...current,
                            laneTarget: target.value,
                            ...(target.value === "same" ? { targetLaneId: "" } : {}),
                            // Only a brief can move: the service rejects any
                            // other lane mode on a fork with an exact message.
                            mode: target.value === "same" ? current.mode : "brief",
                          }))}
                          className={cn(
                            "rounded-md px-3 py-1 font-sans text-[11px] font-semibold transition-colors",
                            active
                              ? "bg-[color:color-mix(in_srgb,var(--color-accent)_18%,transparent)] text-fg"
                              : "text-muted-fg hover:text-fg/80",
                          )}
                        >
                          {target.label}
                        </button>
                      );
                    })}
                  </div>
                  {form.laneTarget === "explicit" ? (
                    <div className="mt-2">
                      <LaneCombobox
                        aria-label="Handoff lane"
                        lanes={laneOptions}
                        value={form.targetLaneId}
                        placeholder="Select lane…"
                        compact
                        onChange={(laneId) => setForm((current) => ({ ...current, targetLaneId: laneId }))}
                      />
                      {form.targetLaneId.trim() ? null : (
                        <p role="alert" className="mt-1.5 text-[10.5px] leading-4 text-[color:var(--color-error)]">
                          Pick the lane to hand off into.
                        </p>
                      )}
                    </div>
                  ) : null}
                  <p className="mt-1.5 text-[10.5px] leading-4 text-muted-fg">
                    A new lane is created when the handoff runs and named after this chat. Only a brief can leave
                    this chat&rsquo;s lane.
                  </p>
                </div>
                <div>
                  <label htmlFor="auto-handoff-retries" className={FIELD_LABEL_CLASS}>Retries</label>
                  <div className="mt-1.5 flex items-center gap-2">
                    <input
                      id="auto-handoff-retries"
                      type="number"
                      min={1}
                      max={5}
                      value={form.retries}
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        setForm((current) => ({
                          ...current,
                          retries: Number.isFinite(next) ? Math.max(1, Math.min(5, Math.floor(next))) : 1,
                        }));
                      }}
                      className="h-7 w-16 rounded-md border border-border/60 bg-[color:color-mix(in_srgb,var(--color-fg)_4%,transparent)] px-2 text-[11.5px] text-fg/85 outline-none focus:border-accent"
                    />
                    <span className="text-[10.5px] leading-4 text-muted-fg">
                      How many times this may hand off before it retires itself.
                    </span>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-border/60 px-5 py-3.5">
          <div className="min-w-0 text-[10.5px] text-muted-fg">
            Applies to this chat only ·{" "}
            <button
              type="button"
              disabled={!valid || saving}
              onClick={() => { void save(false); }}
              className="font-semibold text-accent underline decoration-[color:color-mix(in_srgb,var(--color-accent)_40%,transparent)] underline-offset-2 hover:decoration-accent disabled:cursor-not-allowed disabled:opacity-40"
            >
              Make it a rule for all →
            </button>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-8 items-center rounded-md border border-border/60 px-3 text-[11px] font-semibold text-muted-fg transition-colors hover:text-fg/85"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!valid || saving}
              onClick={() => { void save(true); }}
              className="inline-flex h-8 items-center rounded-md border border-[color:color-mix(in_srgb,var(--color-accent)_40%,transparent)] bg-[color:color-mix(in_srgb,var(--color-accent)_18%,transparent)] px-3 text-[11px] font-semibold text-fg transition-colors hover:bg-[color:color-mix(in_srgb,var(--color-accent)_26%,transparent)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </footer>
      </FocusTrapDialog>
    </div>
  );

  return typeof document === "undefined" ? body : createPortal(body, document.body);
}

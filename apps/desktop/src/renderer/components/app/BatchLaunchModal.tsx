import React, { useCallback, useEffect, useMemo, useState } from "react";
import { CaretDown, CaretRight, ChatCircleDots, GitBranch, Rocket, Terminal, WarningCircle } from "@phosphor-icons/react";
import * as Popover from "@radix-ui/react-popover";
import type { AgentChatPermissionMode, LaneLinearIssue, LaneSummary } from "../../../shared/types";
import { linearIssueBranchName } from "../../../shared/linearIssueBranch";
import {
  getDefaultModelDescriptor,
  getModelById,
  resolveProviderGroupForModel,
  type ModelDescriptor,
} from "../../../shared/modelRegistry";
import {
  batchLaunchSupportsFastMode,
  defaultKickoffPrompt,
  findIssueConflicts,
  type BatchLaunchIssueConfig,
  type BatchLaunchSessionType,
} from "../../lib/linearBatchLaunch";
import { LaneDialogShell } from "../lanes/LaneDialogShell";
import { LinearPriorityIcon, LinearStateIcon, LINEAR_BRAND } from "../lanes/linearBrand";
import { LaneCombobox } from "../terminals/LaneCombobox";
import { ModelPicker } from "../shared/ModelPicker/ModelPicker";
import { ReasoningEffortPicker } from "../shared/ModelPicker/ReasoningEffortPicker";
import { resolveModelDescriptorWithRuntimeCatalog } from "../shared/ModelPicker/modelCatalog";
import { useModelRecents } from "../shared/ModelPicker/useModelRecents";
import { useReasoningByFamily } from "../shared/ModelPicker/useReasoningByFamily";
import { getPermissionOptions, safetyColors, type PermissionOption } from "../shared/permissionOptions";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";

function resolveModelDescriptor(modelId: string): ModelDescriptor | undefined {
  return resolveModelDescriptorWithRuntimeCatalog(modelId) ?? getModelById(modelId);
}

/**
 * Permission options narrowed to the choices the launch surface exposes
 * (mirrors the old single-issue resolver). Keeps Claude/Codex provider-aware
 * while emitting a single unified `permissionMode`.
 */
function launchPermissionOptions(modelId: string): PermissionOption[] {
  const descriptor = resolveModelDescriptor(modelId);
  const family = descriptor?.family ?? "opencode";
  const providerGroup = descriptor ? resolveProviderGroupForModel(descriptor) : "opencode";
  const options = getPermissionOptions({ family, isCliWrapped: descriptor?.isCliWrapped ?? false });
  if (providerGroup === "codex") {
    return options.filter((o) => o.value === "default" || o.value === "plan" || o.value === "full-auto");
  }
  return options.filter(
    (o) => o.value === "default" || o.value === "edit" || o.value === "plan" || o.value === "full-auto",
  );
}

/**
 * Compact permission dropdown — same popover style as the model/reasoning
 * pickers so the launch row stays consistent with the new-chat composer.
 */
function PermissionPicker({
  modelId,
  value,
  onChange,
}: {
  modelId: string;
  value: AgentChatPermissionMode | null;
  onChange: (next: AgentChatPermissionMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const options = launchPermissionOptions(modelId);
  if (!options.length) return null;
  const active = (value && options.find((o) => o.value === value)) ?? options[0]!;
  const activeColors = safetyColors(active.safety);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          title="Permission mode"
          className={cn(
            "inline-flex h-6 shrink-0 items-center gap-1 rounded-md border px-2 text-[10.5px] font-medium leading-none transition-colors",
            "border-white/[0.08] bg-white/[0.02] text-fg/80 hover:border-white/[0.16] hover:text-fg",
          )}
        >
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", activeColors.activeBg)} />
          {active.label}
          <CaretDown size={9} weight="bold" className="text-muted-fg/50" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          avoidCollisions
          className="z-[100] outline-none"
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <div
            className="flex min-w-[220px] flex-col overflow-hidden rounded-lg border border-white/[0.08] bg-[#13111A]/95 p-1 shadow-[0_18px_48px_rgba(0,0,0,0.55)] backdrop-blur-md"
            role="radiogroup"
            aria-label="Permission mode"
          >
            <div className="px-2 py-1 text-[9px] font-semibold uppercase tracking-wide text-muted-fg/55">
              Permission
            </div>
            {options.map((option) => {
              const colors = safetyColors(option.safety);
              const isActive = active.value === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={isActive}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors duration-150",
                    isActive ? "bg-white/[0.06]" : "hover:bg-white/[0.04]",
                  )}
                >
                  <span className="flex items-center gap-1.5 text-[11px] font-medium leading-none text-fg/90">
                    <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", colors.activeBg)} />
                    {option.label}
                  </span>
                  <span className="text-[9.5px] leading-tight text-muted-fg/55">{option.shortDesc}</span>
                </button>
              );
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

type PerIssueState = BatchLaunchIssueConfig & {
  /** When false the issue is excluded from the launch (skipped via the conflict guard). */
  include: boolean;
  /** "new" creates a lane per issue; "existing" launches into `existingLaneId`. */
  laneTarget: "new" | "existing";
};

const DEFAULT_PROMPT_STORAGE_PREFIX = "ade.linear.batchLaunch.defaultPrompt.v1:";

function defaultPromptStorageKey(projectRoot: string | null | undefined): string | null {
  const root = projectRoot?.trim();
  return root ? `${DEFAULT_PROMPT_STORAGE_PREFIX}${root}` : null;
}

function safeLoadDefaultPrompt(projectRoot: string | null | undefined): string | null {
  const key = defaultPromptStorageKey(projectRoot);
  if (!key || typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(key);
    return value && value.trim().length > 0 ? value : null;
  } catch {
    return null;
  }
}

function safeSaveDefaultPrompt(projectRoot: string | null | undefined, prompt: string): void {
  const key = defaultPromptStorageKey(projectRoot);
  if (!key || typeof window === "undefined") return;
  try {
    const value = prompt.trim();
    if (!value) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, prompt);
  } catch {
    // Best effort only; failing to persist a prompt should never block launch.
  }
}

function makeInitialConfig(defaultModelId: string, kickoffPrompt: string): PerIssueState {
  return {
    modelId: defaultModelId,
    reasoningEffort: null,
    codexFastMode: false,
    // Seed the kickoff prompt with the default so the textarea is editable
    // in-place (rather than only showing it as a placeholder).
    kickoffPrompt,
    branchOverride: "",
    sessionType: "chat",
    permissionMode: null,
    existingLaneId: null,
    include: true,
    laneTarget: "new",
  };
}

/** Compact two-option Chat/CLI toggle reused by the Default row and per-issue rows. */
function SessionTypeToggle({
  value,
  onChange,
}: {
  value: BatchLaunchSessionType;
  onChange: (next: BatchLaunchSessionType) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Session type"
      className="inline-flex h-6 shrink-0 items-center rounded-md border border-white/[0.08] bg-white/[0.02] p-0.5"
    >
      {([
        { key: "chat", label: "Chat", Icon: ChatCircleDots },
        { key: "cli", label: "CLI", Icon: Terminal },
      ] as const).map(({ key, label, Icon }) => {
        const active = value === key;
        return (
          <button
            key={key}
            type="button"
            aria-pressed={active}
            title={key === "chat" ? "In-app chat agent" : "Terminal CLI agent"}
            onClick={() => onChange(key)}
            className={cn(
              "inline-flex h-5 items-center gap-1 rounded px-1.5 text-[10.5px] font-medium leading-none transition-colors",
              active ? "bg-white/[0.1] text-fg" : "text-muted-fg/60 hover:text-fg/85",
            )}
          >
            <Icon size={11} weight={active ? "fill" : "regular"} />
            {label}
          </button>
        );
      })}
    </div>
  );
}

export type BatchLaunchSubmit = {
  issue: LaneLinearIssue;
  config: BatchLaunchIssueConfig;
};

export function BatchLaunchModal({
  open,
  projectRoot,
  issues,
  lanes,
  laneOnly = false,
  onOpenChange,
  onLaunch,
}: {
  open: boolean;
  projectRoot?: string | null;
  issues: LaneLinearIssue[];
  lanes: LaneSummary[];
  /** When true, only create lanes (no agent kickoff) — hides the model pickers. */
  laneOnly?: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fires once, synchronously closing the modal; the orchestrator runs after. */
  onLaunch: (entries: BatchLaunchSubmit[]) => void;
}) {
  const { recents } = useModelRecents();
  const defaultModelId = useMemo(
    () =>
      recents[0]
      ?? getDefaultModelDescriptor("claude")?.id
      ?? getDefaultModelDescriptor("opencode")?.id
      ?? "",
    [recents],
  );

  const [defaultModel, setDefaultModel] = useState("");
  const [defaultEffort, setDefaultEffort] = useState<string | null>(null);
  const [defaultFast, setDefaultFast] = useState(false);
  const [defaultSessionType, setDefaultSessionType] = useState<BatchLaunchSessionType>("chat");
  const [defaultPermission, setDefaultPermission] = useState<AgentChatPermissionMode | null>(null);
  const [projectDefaultPrompt, setProjectDefaultPrompt] = useState<string | null>(null);
  const [perIssue, setPerIssue] = useState<Record<string, PerIssueState>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const conflicts = useMemo(() => findIssueConflicts(issues, lanes), [issues, lanes]);
  // Existing-lane targets exclude the primary lane (parity with the old resolver).
  const selectableLanes = useMemo(
    () => lanes.filter((lane) => lane.laneType !== "primary"),
    [lanes],
  );

  // Seed config when the modal opens (or the issue set changes while open).
  // New rows inherit the LIVE Default row (model / Chat↔CLI / reasoning / fast /
  // permission), not hardcoded chat defaults — otherwise reopening (which clears
  // perIssue below) would silently launch rows that disagree with the Default
  // control the user still sees.
  useEffect(() => {
    if (!open) return;
    const savedPrompt = safeLoadDefaultPrompt(projectRoot);
    const kickoffPrompt = savedPrompt ?? defaultKickoffPrompt();
    const seedModel = defaultModel || defaultModelId;
    setProjectDefaultPrompt(savedPrompt);
    setDefaultModel(seedModel);
    setPerIssue((current) => {
      const next: Record<string, PerIssueState> = {};
      for (const issue of issues) {
        next[issue.id] = current[issue.id] ?? {
          ...makeInitialConfig(seedModel, kickoffPrompt),
          sessionType: defaultSessionType,
          reasoningEffort: defaultEffort,
          codexFastMode: defaultFast,
          permissionMode: defaultPermission,
        };
      }
      return next;
    });
  }, [
    open,
    projectRoot,
    issues,
    defaultModelId,
    defaultModel,
    defaultSessionType,
    defaultEffort,
    defaultFast,
    defaultPermission,
  ]);

  useEffect(() => {
    if (open) return;
    setPerIssue({});
    setExpanded({});
  }, [open]);

  const patchIssue = useCallback((issueId: string, patch: Partial<PerIssueState>) => {
    setPerIssue((current) => ({
      ...current,
      [issueId]: { ...current[issueId], ...patch },
    }));
  }, []);

  const { getReasoningForFamily } = useReasoningByFamily();

  // Resolve the reasoning effort the picker is actually DISPLAYING for a row.
  // The shared ReasoningEffortPicker shows a family-remembered default when the
  // explicit value is null, so the submitted value must match what the user sees
  // (otherwise null is sent and the runtime falls back to "medium").
  const resolveDisplayedReasoning = useCallback(
    (explicit: string | null, modelId: string): string | null => {
      if (explicit) return explicit;
      const desc = resolveModelDescriptorWithRuntimeCatalog(modelId) ?? getModelById(modelId);
      return desc?.family ? getReasoningForFamily(desc.family) : null;
    },
    [getReasoningForFamily],
  );

  // The Default row is a LIVE default (parity with the work-tab composer's single
  // model/permission/chat-cli control): changing a default value immediately
  // applies it to every issue row. Users can still override an individual row.
  const applyDefaultField = useCallback(
    <K extends keyof PerIssueState>(key: K, value: PerIssueState[K]) => {
      setPerIssue((current) => {
        let changed = false;
        const next: Record<string, PerIssueState> = {};
        for (const [id, state] of Object.entries(current)) {
          if (state[key] !== value) {
            next[id] = { ...state, [key]: value };
            changed = true;
          } else {
            next[id] = state;
          }
        }
        return changed ? next : current;
      });
    },
    [],
  );

  const applyDefaultToAll = useCallback(() => {
    if (!defaultModel.trim()) return;
    setPerIssue((current) => {
      const next: Record<string, PerIssueState> = {};
      for (const [id, state] of Object.entries(current)) {
        next[id] = {
          ...state,
          modelId: defaultModel,
          reasoningEffort: defaultEffort,
          codexFastMode: defaultFast,
          sessionType: defaultSessionType,
          permissionMode: defaultPermission,
        };
      }
      return next;
    });
  }, [defaultModel, defaultEffort, defaultFast, defaultSessionType, defaultPermission]);

  // Copy one issue's kickoff prompt onto every other included issue.
  const applyPromptToAll = useCallback((sourcePrompt: string) => {
    setPerIssue((current) => {
      const next: Record<string, PerIssueState> = {};
      for (const [id, state] of Object.entries(current)) {
        next[id] = { ...state, kickoffPrompt: sourcePrompt };
      }
      return next;
    });
  }, []);

  const savePromptAsDefault = useCallback((prompt: string) => {
    safeSaveDefaultPrompt(projectRoot, prompt);
    setProjectDefaultPrompt(prompt.trim() ? prompt : null);
  }, [projectRoot]);

  const includedIssues = useMemo(
    () => issues.filter((issue) => perIssue[issue.id]?.include !== false),
    [issues, perIssue],
  );

  const handleLaunch = useCallback(() => {
    const entries: BatchLaunchSubmit[] = [];
    for (const issue of issues) {
      const state = perIssue[issue.id];
      if (!state || state.include === false) continue;
      if (!laneOnly && !state.modelId.trim()) continue;
      const { include: _include, laneTarget, ...config } = state;
      // An existing-lane target only takes effect when a lane is actually
      // selected; otherwise fall back to creating a new lane.
      const existingLaneId =
        !laneOnly && laneTarget === "existing" ? state.existingLaneId?.trim() || null : null;
      if (!laneOnly && laneTarget === "existing" && !existingLaneId) continue;
      // Submit the reasoning the picker is actually DISPLAYING (it shows a
      // family-remembered default when the explicit value is null), so the agent
      // launches with the effort the user sees — not null → runtime "medium".
      const reasoningEffort = resolveDisplayedReasoning(config.reasoningEffort, config.modelId);
      entries.push({ issue, config: { ...config, reasoningEffort, existingLaneId, laneOnly } });
    }
    if (!entries.length) return;
    onLaunch(entries);
  }, [issues, perIssue, onLaunch, laneOnly, resolveDisplayedReasoning]);

  if (!issues.length) return null;

  const conflictCount = includedIssues.filter((issue) => conflicts.has(issue.id)).length;
  const launchCount = includedIssues.length;

  return (
    <LaneDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={
        laneOnly
          ? `Create ${launchCount} ${launchCount === 1 ? "lane" : "lanes"}`
          : `Launch ${launchCount} ${launchCount === 1 ? "lane" : "lanes"} + ${launchCount === 1 ? "agent" : "agents"}`
      }
      description={
        laneOnly
          ? "A lane per issue, with the issue linked. Start agents from Work whenever you are ready."
          : "Each issue gets its own lane and an agent kicked off with that issue's context. The Default row drives every issue — override an individual one below if you need to."
      }
      icon={Rocket}
      widthClassName="w-[min(680px,calc(100vw-24px))]"
    >
      {/* Default row */}
      {!laneOnly ? (
        <div
          className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2.5"
          style={{ borderColor: LINEAR_BRAND.borderSubtle, background: LINEAR_BRAND.surface }}
        >
          <span className="text-[11px] font-semibold text-fg/80">Default</span>
          <SessionTypeToggle
            value={defaultSessionType}
            onChange={(next) => { setDefaultSessionType(next); applyDefaultField("sessionType", next); }}
          />
          <ModelPicker
            value={defaultModel}
            onChange={(next) => { setDefaultModel(next); applyDefaultField("modelId", next); }}
            surfaceKey="batch-launch-default"
            compact
            fastModeActive={defaultFast}
            onFastModeToggle={(next) => { setDefaultFast(next); applyDefaultField("codexFastMode", next); }}
            fastModeSupported={batchLaunchSupportsFastMode(defaultModel)}
          />
          <ReasoningEffortPicker
            modelId={defaultModel}
            reasoningEffort={defaultEffort}
            onChange={(next) => { setDefaultEffort(next); applyDefaultField("reasoningEffort", next); }}
            compact
          />
          <PermissionPicker
            modelId={defaultModel}
            value={defaultPermission}
            onChange={(next) => { setDefaultPermission(next); applyDefaultField("permissionMode", next); }}
          />
          <button
            type="button"
            disabled={!defaultModel.trim()}
            onClick={applyDefaultToAll}
            title="Reset every issue to these defaults"
            className="ml-auto inline-flex h-6 items-center rounded-md border border-white/[0.1] bg-white/[0.04] px-2 text-[10.5px] font-medium text-fg/75 transition-colors hover:border-white/[0.18] hover:bg-white/[0.08] hover:text-fg disabled:cursor-not-allowed disabled:opacity-45"
          >
            Reset all
          </button>
        </div>
      ) : null}

      {/* Per-issue rows */}
      <div className="mt-3 max-h-[46vh] space-y-1.5 overflow-y-auto pr-0.5">
        {issues.map((issue) => {
          const state = perIssue[issue.id];
          if (!state) return null;
          const conflict = conflicts.get(issue.id);
          const isExpanded = expanded[issue.id] === true;
          const skipped = state.include === false;
          const branch = state.branchOverride.trim() || linearIssueBranchName(issue);
          const promptSavedAsDefault =
            state.kickoffPrompt.trim().length > 0 && projectDefaultPrompt === state.kickoffPrompt;
          return (
            <div
              key={issue.id}
              className={cn(
                "rounded-lg border border-white/[0.07] bg-white/[0.02] transition-opacity",
                skipped && "opacity-45",
              )}
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-2.5 py-2">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <button
                    type="button"
                    aria-label={isExpanded ? "Collapse" : "Expand"}
                    onClick={() => setExpanded((current) => ({ ...current, [issue.id]: !isExpanded }))}
                    className="grid h-5 w-5 shrink-0 place-items-center rounded text-muted-fg/55 transition-colors hover:bg-white/[0.06] hover:text-fg/80"
                  >
                    <CaretRight
                      size={12}
                      weight="bold"
                      className={cn("transition-transform duration-150", isExpanded && "rotate-90")}
                    />
                  </button>
                  <LinearPriorityIcon priority={issue.priority} size={11} />
                  <LinearStateIcon stateType={issue.stateType} size={11} />
                  <span className="shrink-0 rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-fg/80">
                    {issue.identifier}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-fg/85" title={issue.title}>
                    {issue.title}
                  </span>
                  {conflict ? (
                    <span
                      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-400/25 bg-amber-400/[0.08] px-1.5 py-0.5 text-[9.5px] font-medium text-amber-100/90"
                      title={
                        conflict.reason === "session"
                          ? `A session in lane "${conflict.laneName}" already attaches this issue`
                          : `Lane "${conflict.laneName}" already attaches this issue`
                      }
                    >
                      <WarningCircle size={11} weight="fill" />
                      {conflict.reason === "session" ? "Has agent" : "Has lane"}
                    </span>
                  ) : null}
                </div>
                {!skipped && !laneOnly ? (
                  <div className="flex flex-wrap items-center justify-end gap-1.5">
                    <SessionTypeToggle
                      value={state.sessionType ?? "chat"}
                      onChange={(next) => patchIssue(issue.id, { sessionType: next })}
                    />
                    <ModelPicker
                      value={state.modelId}
                      onChange={(modelId) => patchIssue(issue.id, { modelId })}
                      surfaceKey={`batch-launch-${issue.id}`}
                      compact
                      fastModeActive={state.codexFastMode}
                      onFastModeToggle={(next) => patchIssue(issue.id, { codexFastMode: next })}
                      fastModeSupported={batchLaunchSupportsFastMode(state.modelId)}
                    />
                    <ReasoningEffortPicker
                      modelId={state.modelId}
                      reasoningEffort={state.reasoningEffort}
                      onChange={(effort) => patchIssue(issue.id, { reasoningEffort: effort })}
                      compact
                    />
                    <PermissionPicker
                      modelId={state.modelId}
                      value={state.permissionMode ?? null}
                      onChange={(mode) => patchIssue(issue.id, { permissionMode: mode })}
                    />
                  </div>
                ) : null}
                {conflict ? (
                  <button
                    type="button"
                    onClick={() => patchIssue(issue.id, { include: skipped })}
                    className="shrink-0 rounded-md border border-white/[0.1] px-1.5 py-0.5 text-[10px] font-medium text-muted-fg/70 transition-colors hover:border-white/[0.2] hover:text-fg/90"
                  >
                    {skipped ? "Launch anyway" : "Skip"}
                  </button>
                ) : null}
              </div>

              {isExpanded && !skipped ? (
                <div className="space-y-2 border-t border-white/[0.05] px-2.5 py-2.5">
                  {!laneOnly ? (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-fg/55">
                          Kickoff prompt
                        </span>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => savePromptAsDefault(state.kickoffPrompt)}
                            disabled={!projectRoot?.trim() || !state.kickoffPrompt.trim()}
                            className="inline-flex h-5 items-center rounded-md border border-white/[0.1] bg-white/[0.04] px-2 text-[10px] font-medium text-fg/70 transition-colors hover:border-white/[0.18] hover:bg-white/[0.08] hover:text-fg disabled:cursor-not-allowed disabled:opacity-45"
                            title={
                              projectRoot?.trim()
                                ? "Use this prompt as the default for future Linear launches in this project"
                                : "Open a project to save a default prompt"
                            }
                          >
                            {promptSavedAsDefault ? "Default saved" : "Save default"}
                          </button>
                          {issues.length > 1 ? (
                          <button
                            type="button"
                            onClick={() => applyPromptToAll(state.kickoffPrompt)}
                            className="inline-flex h-5 items-center rounded-md border border-white/[0.1] bg-white/[0.04] px-2 text-[10px] font-medium text-fg/70 transition-colors hover:border-white/[0.18] hover:bg-white/[0.08] hover:text-fg"
                            title="Use this prompt for every issue"
                          >
                            Apply to all
                          </button>
                          ) : null}
                        </div>
                      </div>
                      <textarea
                        value={state.kickoffPrompt}
                        onChange={(event) => patchIssue(issue.id, { kickoffPrompt: event.target.value })}
                        rows={3}
                        className="w-full resize-y rounded-md border border-white/[0.08] bg-black/25 px-2.5 py-2 text-[11.5px] leading-relaxed text-fg/90 placeholder:text-muted-fg/40 focus:border-white/[0.18] focus:outline-none"
                      />
                    </div>
                  ) : null}

                  {/* Lane target: a fresh lane per issue, or launch into an existing lane. */}
                  {!laneOnly ? (
                    <div className="space-y-1">
                      <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-fg/55">
                        Lane
                      </span>
                      <div className="flex flex-wrap items-center gap-2">
                        <div
                          role="group"
                          aria-label="Lane target"
                          className="inline-flex h-7 shrink-0 items-center rounded-md border border-white/[0.08] bg-white/[0.02] p-0.5"
                        >
                          {([
                            { key: "new", label: "New lane" },
                            { key: "existing", label: "Existing lane" },
                          ] as const).map(({ key, label }) => {
                            const active = (state.laneTarget ?? "new") === key;
                            const disabled = key === "existing" && selectableLanes.length === 0;
                            return (
                              <button
                                key={key}
                                type="button"
                                aria-pressed={active}
                                disabled={disabled}
                                title={disabled ? "No existing lanes available yet" : undefined}
                                onClick={() => patchIssue(issue.id, { laneTarget: key })}
                                className={cn(
                                  "inline-flex h-6 items-center rounded px-2 text-[10.5px] font-medium leading-none transition-colors",
                                  active ? "bg-white/[0.1] text-fg" : "text-muted-fg/60 hover:text-fg/85",
                                  disabled && "cursor-not-allowed opacity-40 hover:text-muted-fg/60",
                                )}
                              >
                                {label}
                              </button>
                            );
                          })}
                        </div>
                        {(state.laneTarget ?? "new") === "existing" ? (
                          selectableLanes.length > 0 ? (
                            <div className="min-w-[180px] flex-1">
                              <LaneCombobox
                                lanes={selectableLanes}
                                value={state.existingLaneId ?? ""}
                                onChange={(laneId) => patchIssue(issue.id, { existingLaneId: laneId })}
                                fullWidth
                                aria-label="Select lane"
                              />
                            </div>
                          ) : (
                            <span className="text-[10.5px] text-amber-100/75">
                              No lanes available — create a new one.
                            </span>
                          )
                        ) : null}
                      </div>
                    </div>
                  ) : null}

                  {/* Branch override only applies when creating a new lane. */}
                  {laneOnly || (state.laneTarget ?? "new") === "new" ? (
                    <label className="block space-y-1">
                      <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-fg/55">
                        Branch
                      </span>
                      <div className="flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-black/25 px-2.5">
                        <GitBranch size={12} className="shrink-0 text-muted-fg/50" />
                        <input
                          value={state.branchOverride}
                          onChange={(event) => patchIssue(issue.id, { branchOverride: event.target.value })}
                          placeholder={branch}
                          className="h-8 w-full bg-transparent font-mono text-[11px] text-fg/85 placeholder:text-muted-fg/40 focus:outline-none"
                        />
                      </div>
                    </label>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {conflictCount > 0 ? (
        <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-100/75">
          <WarningCircle size={13} weight="fill" className="mt-0.5 shrink-0 text-amber-300/80" />
          {conflictCount} {conflictCount === 1 ? "issue is already being worked on" : "issues are already being worked on"} (lane or agent attached). Skip them or launch fresh anyway.
        </p>
      ) : null}

      <div className="mt-4 flex items-center justify-end gap-2 border-t border-white/[0.06] pt-4">
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="button" variant="primary" disabled={launchCount === 0} onClick={handleLaunch}>
          <Rocket size={13} weight="fill" />
          {laneOnly ? "Create" : "Launch"} {launchCount} {launchCount === 1 ? "lane" : "lanes"}
        </Button>
      </div>
    </LaneDialogShell>
  );
}

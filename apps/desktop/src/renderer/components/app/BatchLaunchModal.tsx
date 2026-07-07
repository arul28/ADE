import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaretRight, GitBranch, Rocket, WarningCircle } from "@phosphor-icons/react";
import type { LaneLinearIssue, LaneSummary } from "../../../shared/types";
import { linearIssueBranchName } from "../../../shared/linearIssueBranch";
import {
  getDefaultModelDescriptor,
} from "../../../shared/modelRegistry";
import {
  defaultKickoffPrompt,
  findIssueConflicts,
  type BatchLaunchIssueConfig,
} from "../../lib/linearBatchLaunch";
import type { NativeControlState } from "../../lib/draftLaunchJobs";
import { defaultNativeControls } from "../../lib/nativeLaunchControls";
import { LaneDialogShell } from "../lanes/LaneDialogShell";
import { LinearPriorityIcon, LinearStateIcon, LINEAR_BRAND } from "../lanes/linearBrand";
import { LaneCombobox } from "../terminals/LaneCombobox";
import {
  SessionLaunchModelControls,
  type SessionLaunchModelConfig,
} from "../shared/SessionLaunchModelControls";
import { useModelRecents } from "../shared/ModelPicker/useModelRecents";
import { useReasoningByFamily } from "../shared/ModelPicker/useReasoningByFamily";
import { resolveModelDescriptorWithRuntimeCatalog } from "../shared/ModelPicker/modelCatalog";
import { getModelById } from "../../../shared/modelRegistry";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";

type PerIssueState = BatchLaunchIssueConfig & {
  /** When false the issue is excluded from the launch (skipped via the conflict guard). */
  include: boolean;
  /** "new" creates a lane per issue; "existing" launches into `existingLaneId`. */
  laneTarget: "new" | "existing";
  nativeControls: NativeControlState;
};

const DEFAULT_PROMPT_STORAGE_PREFIX = "ade.linear.batchLaunch.defaultPrompt.v1:";

function batchLaunchNativeDefaults(): NativeControlState {
  const controls = defaultNativeControls("persistent_identity");
  return {
    ...controls,
    cursorConfigValues: { ...controls.cursorConfigValues },
  };
}

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
    window.localStorage.setItem(key, value);
  } catch {
    // Best effort only; failing to persist a prompt should never block launch.
  }
}

async function loadProjectDefaultPrompt(projectRoot: string | null | undefined): Promise<string | null> {
  const localFallback = safeLoadDefaultPrompt(projectRoot);
  if (!projectRoot?.trim() || typeof window === "undefined" || !window.ade?.projectConfig?.get) {
    return localFallback;
  }
  try {
    const snapshot = await window.ade.projectConfig.get();
    const prompt = snapshot.effective.ui?.linearBatchLaunchDefaultPrompt?.trim();
    return prompt || localFallback;
  } catch {
    return localFallback;
  }
}

async function persistProjectDefaultPrompt(projectRoot: string | null | undefined, prompt: string): Promise<void> {
  const value = prompt.trim();
  safeSaveDefaultPrompt(projectRoot, value);
  if (!projectRoot?.trim() || typeof window === "undefined" || !window.ade?.projectConfig?.get || !window.ade?.projectConfig?.save) {
    return;
  }
  const snapshot = await window.ade.projectConfig.get();
  const nextUi = { ...(snapshot.local.ui ?? {}) };
  if (value) {
    nextUi.linearBatchLaunchDefaultPrompt = value;
  } else {
    delete nextUi.linearBatchLaunchDefaultPrompt;
  }
  const nextLocal = { ...snapshot.local };
  if (Object.keys(nextUi).length > 0) {
    nextLocal.ui = nextUi;
  } else {
    delete nextLocal.ui;
  }
  await window.ade.projectConfig.save({ shared: snapshot.shared, local: nextLocal });
}

function makeInitialConfig(defaultModelId: string, kickoffPrompt: string): PerIssueState {
  return {
    modelId: defaultModelId,
    reasoningEffort: null,
    fastMode: false,
    kickoffPrompt,
    branchOverride: "",
    sessionType: "chat",
    permissionMode: null,
    existingLaneId: null,
    include: true,
    laneTarget: "new",
    nativeControls: batchLaunchNativeDefaults(),
  };
}

function toLaunchModelConfig(state: PerIssueState): SessionLaunchModelConfig {
  return {
    modelId: state.modelId,
    reasoningEffort: state.reasoningEffort,
    fastMode: state.fastMode,
    sessionType: state.sessionType ?? "chat",
    nativeControls: state.nativeControls,
  };
}

function patchFromLaunchModelConfig(
  state: PerIssueState,
  patch: Partial<SessionLaunchModelConfig>,
): PerIssueState {
  return {
    ...state,
    ...(patch.modelId !== undefined ? { modelId: patch.modelId } : {}),
    ...(patch.reasoningEffort !== undefined ? { reasoningEffort: patch.reasoningEffort } : {}),
    ...(patch.fastMode !== undefined ? { fastMode: patch.fastMode } : {}),
    ...(patch.sessionType !== undefined ? { sessionType: patch.sessionType } : {}),
    ...(patch.nativeControls !== undefined ? { nativeControls: patch.nativeControls } : {}),
  };
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

  const [defaultConfig, setDefaultConfig] = useState<SessionLaunchModelConfig>(() => ({
    modelId: "",
    reasoningEffort: null,
    fastMode: false,
    sessionType: "chat",
    nativeControls: batchLaunchNativeDefaults(),
  }));
  const [projectDefaultPrompt, setProjectDefaultPrompt] = useState<string | null>(null);
  const [perIssue, setPerIssue] = useState<Record<string, PerIssueState>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const seedKeyRef = useRef<string | null>(null);

  const multiIssue = issues.length > 1;
  const issueSeedKey = useMemo(() => issues.map((issue) => issue.id).join("\0"), [issues]);
  const conflicts = useMemo(() => findIssueConflicts(issues, lanes), [issues, lanes]);
  const selectableLanes = useMemo(
    () => lanes.filter((lane) => lane.laneType !== "primary"),
    [lanes],
  );

  useEffect(() => {
    if (!open) return;
    const seedKey = `${projectRoot ?? ""}\0${issueSeedKey}`;
    if (seedKeyRef.current === seedKey) return;
    const initialSeed = seedKeyRef.current == null;
    seedKeyRef.current = seedKey;

    const fallbackPrompt = safeLoadDefaultPrompt(projectRoot);
    const kickoffPrompt = fallbackPrompt ?? defaultKickoffPrompt();
    const seedModel = defaultModelId;
    setProjectDefaultPrompt(fallbackPrompt);
    const seededDefaults = batchLaunchNativeDefaults();
    const seededConfig: SessionLaunchModelConfig = {
      modelId: seedModel,
      reasoningEffort: null,
      fastMode: false,
      sessionType: "chat",
      nativeControls: seededDefaults,
    };
    if (initialSeed) {
      setDefaultConfig(seededConfig);
    }
    const rowConfig = initialSeed ? seededConfig : defaultConfig;
    setPerIssue((current) => {
      const next: Record<string, PerIssueState> = {};
      for (const issue of issues) {
        next[issue.id] = current[issue.id] ?? {
          ...makeInitialConfig(rowConfig.modelId || seedModel, kickoffPrompt),
          sessionType: rowConfig.sessionType,
          reasoningEffort: rowConfig.reasoningEffort,
          fastMode: rowConfig.fastMode,
          nativeControls: {
            ...rowConfig.nativeControls,
            cursorConfigValues: { ...rowConfig.nativeControls.cursorConfigValues },
          },
        };
      }
      return next;
    });
    if (initialSeed && issues.length === 1) {
      setExpanded({ [issues[0]!.id]: true });
    }
  }, [open, projectRoot, issueSeedKey, issues, defaultModelId, defaultConfig]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const fallbackPrompt = safeLoadDefaultPrompt(projectRoot);
    const initialPrompt = fallbackPrompt ?? defaultKickoffPrompt();

    void loadProjectDefaultPrompt(projectRoot).then((savedPrompt) => {
      if (cancelled) return;
      setProjectDefaultPrompt(savedPrompt);
      if (!savedPrompt || savedPrompt === initialPrompt) return;
      setPerIssue((current) => {
        let changed = false;
        const next: Record<string, PerIssueState> = {};
        for (const [id, state] of Object.entries(current)) {
          if (state.kickoffPrompt === initialPrompt || (fallbackPrompt != null && state.kickoffPrompt === fallbackPrompt)) {
            next[id] = { ...state, kickoffPrompt: savedPrompt };
            changed = true;
          } else {
            next[id] = state;
          }
        }
        return changed ? next : current;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [open, projectRoot]);

  useEffect(() => {
    if (open) return;
    setPerIssue({});
    setExpanded({});
    seedKeyRef.current = null;
  }, [open]);

  const patchIssue = useCallback((issueId: string, patch: Partial<PerIssueState>) => {
    setPerIssue((current) => ({
      ...current,
      [issueId]: { ...current[issueId], ...patch },
    }));
  }, []);

  const { getReasoningForFamily } = useReasoningByFamily();

  const resolveDisplayedReasoning = useCallback(
    (explicit: string | null, modelId: string): string | null => {
      if (explicit) return explicit;
      const desc = resolveModelDescriptorWithRuntimeCatalog(modelId) ?? getModelById(modelId);
      return desc?.family ? getReasoningForFamily(desc.family) : null;
    },
    [getReasoningForFamily],
  );

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

  const applyDefaultConfigToAll = useCallback((config: SessionLaunchModelConfig) => {
    setPerIssue((current) => {
      const next: Record<string, PerIssueState> = {};
      for (const [id, state] of Object.entries(current)) {
        next[id] = patchFromLaunchModelConfig(state, config);
      }
      return next;
    });
  }, []);

  const handleDefaultConfigChange = useCallback((patch: Partial<SessionLaunchModelConfig>) => {
    setDefaultConfig((current) => {
      const next = { ...current, ...patch };
      applyDefaultConfigToAll(next);
      if (patch.modelId !== undefined) applyDefaultField("modelId", patch.modelId);
      if (patch.reasoningEffort !== undefined) applyDefaultField("reasoningEffort", patch.reasoningEffort);
      if (patch.fastMode !== undefined) applyDefaultField("fastMode", patch.fastMode);
      if (patch.sessionType !== undefined) applyDefaultField("sessionType", patch.sessionType);
      if (patch.nativeControls !== undefined) applyDefaultField("nativeControls", patch.nativeControls);
      return next;
    });
  }, [applyDefaultConfigToAll, applyDefaultField]);

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
    const value = prompt.trim();
    setProjectDefaultPrompt(value || null);
    void persistProjectDefaultPrompt(projectRoot, value).catch(() => {});
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
      const effectiveConfig = multiIssue
        ? state
        : patchFromLaunchModelConfig(state, defaultConfig);
      if (!laneOnly && !effectiveConfig.modelId.trim()) continue;
      const { include: _include, laneTarget, nativeControls, ...config } = effectiveConfig;
      const existingLaneId =
        !laneOnly && laneTarget === "existing" ? state.existingLaneId?.trim() || null : null;
      if (!laneOnly && laneTarget === "existing" && !existingLaneId) continue;
      const reasoningEffort = resolveDisplayedReasoning(config.reasoningEffort, config.modelId);
      entries.push({
        issue,
        config: {
          ...config,
          reasoningEffort,
          existingLaneId,
          laneOnly,
          nativeControls,
        },
      });
    }
    if (!entries.length) return;
    onLaunch(entries);
  }, [issues, perIssue, onLaunch, laneOnly, resolveDisplayedReasoning, multiIssue, defaultConfig]);

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
          : multiIssue
            ? "Each issue gets its own lane and agent. The Default row drives every issue — override an individual one below if you need to."
            : "Configure the lane, branch, and kickoff prompt. Model settings below apply to this launch."
      }
      icon={Rocket}
      widthClassName="w-[min(960px,calc(100vw-32px))]"
    >
      {!laneOnly ? (
        <div
          className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-3"
          style={{ borderColor: LINEAR_BRAND.borderSubtle, background: LINEAR_BRAND.surface }}
        >
          {multiIssue ? (
            <span className="mr-1 text-[11px] font-semibold text-fg/80">Default</span>
          ) : null}
          <SessionLaunchModelControls
            config={defaultConfig}
            onChange={handleDefaultConfigChange}
            surfaceKey="batch-launch-default"
          />
          {multiIssue ? (
            <button
              type="button"
              disabled={!defaultConfig.modelId.trim()}
              onClick={() => applyDefaultConfigToAll(defaultConfig)}
              title="Reset every issue to these defaults"
              className="ml-auto inline-flex h-6 items-center rounded-md border border-white/[0.1] bg-white/[0.04] px-2 text-[10.5px] font-medium text-fg/75 transition-colors hover:border-white/[0.18] hover:bg-white/[0.08] hover:text-fg disabled:cursor-not-allowed disabled:opacity-45"
            >
              Reset all
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="mt-3 max-h-[58vh] space-y-2 overflow-y-auto pr-0.5">
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
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3 py-2.5">
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
                {!skipped && !laneOnly && multiIssue ? (
                  <SessionLaunchModelControls
                    config={toLaunchModelConfig(state)}
                    onChange={(patch) => patchIssue(issue.id, patchFromLaunchModelConfig(state, patch))}
                    surfaceKey={`batch-launch-${issue.id}`}
                  />
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
                <div className="space-y-3 border-t border-white/[0.05] px-3 py-3">
                  {!laneOnly ? (
                    <div className="space-y-1.5">
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
                          {multiIssue ? (
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
                        rows={5}
                        className="w-full resize-y rounded-md border border-white/[0.08] bg-black/25 px-3 py-2.5 text-[12px] leading-relaxed text-fg/90 placeholder:text-muted-fg/40 focus:border-white/[0.18] focus:outline-none"
                      />
                    </div>
                  ) : null}

                  {!laneOnly ? (
                    <div className="space-y-1.5">
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
                                  "inline-flex h-6 items-center rounded px-2.5 text-[10.5px] font-medium leading-none transition-colors",
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
                            <div className="min-w-[220px] flex-1">
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

                  {laneOnly || (state.laneTarget ?? "new") === "new" ? (
                    <label className="block space-y-1.5">
                      <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-fg/55">
                        Branch
                      </span>
                      <div className="flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-black/25 px-3">
                        <GitBranch size={12} className="shrink-0 text-muted-fg/50" />
                        <input
                          value={state.branchOverride}
                          onChange={(event) => patchIssue(issue.id, { branchOverride: event.target.value })}
                          placeholder={branch}
                          className="h-9 w-full bg-transparent font-mono text-[11.5px] text-fg/85 placeholder:text-muted-fg/40 focus:outline-none"
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

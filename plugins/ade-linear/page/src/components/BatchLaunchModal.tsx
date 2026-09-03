import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CaretRight,
  ChatCircleDots,
  GitBranch,
  Lightning,
  Rocket,
  Terminal,
  WarningCircle,
} from "@phosphor-icons/react";
import {
  Button,
  cn,
  LinearPriorityIcon,
  LinearStateIcon,
  LINEAR_BRAND,
} from "@ade-dev/ui";
import { LaneDialogShell } from "@ade-dev/ui/dialog";
import { LaneCombobox } from "@ade-dev/ui/lanes";

import { bridge } from "../bridge";
import { getCapabilities, getChatModels } from "../host/actions";
import { linearIssueBranchName } from "../lib/linearIssueBranch";
import {
  defaultKickoffPrompt,
  findIssueConflicts,
  type BatchLaunchIssueConfig,
  type BatchLaunchSessionType,
} from "../lib/linearBatchLaunch";
import type { LaneLinearIssue, PageCapabilities, PageChatModel, PageLane } from "../types";

type PerIssueState = BatchLaunchIssueConfig & {
  /** When false the issue is excluded from the launch (skipped via the conflict guard). */
  include: boolean;
  /** "new" creates a lane per issue; "existing" launches into `existingLaneId`. */
  laneTarget: "new" | "existing";
};

/**
 * The default-prompt store.
 *
 * The compiled modal kept this in `localStorage` under
 * `ade.linear.batchLaunch.defaultPrompt.v1:<root>` with a project-config
 * mirror through `window.ade.projectConfig`. A guest's partition is
 * non-persistent and there is no project-config verb on the bridge, so the
 * prompt lives in the plugin's own `ui-state` collection, keyed the same way.
 * `host/uiState.ts` is not used for it: that module exposes only `filters` and
 * `selection` keys, and is owned by the browser.
 */
const DEFAULT_PROMPT_COLLECTION = "ui-state";
const DEFAULT_PROMPT_STORAGE_PREFIX = "ade.linear.batchLaunch.defaultPrompt.v1:";

/**
 * Trigger chrome for the launch pills, copied verbatim from the app's
 * `PERMISSION_TRIGGER_CLASS` so the page's pills are pixel-identical to the
 * compiled ones. The app exports it from `components/shared/PermissionModePicker`,
 * which a page cannot import.
 */
const PERMISSION_TRIGGER_CLASS = cn(
  "ade-chat-composer-permission-trigger",
  "inline-flex h-6 min-w-0 shrink-0 items-center justify-start gap-1 rounded-md border px-1.5",
  "font-sans text-[length:calc(var(--chat-font-size,14px)*9/14)] leading-none transition-colors duration-150",
  "border-white/[0.06] bg-white/[0.03] text-fg/80",
  "hover:border-violet-400/20 hover:bg-violet-500/[0.06] hover:text-fg",
);

const COMPOSER_TOOLBAR_PICKER_TRIGGER = "max-w-[min(9.5rem,34vw)] shrink min-w-0";
const COMPOSER_MODEL_TRIGGER = "max-w-[min(9.5rem,34vw)] shrink min-w-[4.5rem]";

function defaultPromptStorageKey(projectRoot: string | null | undefined): string | null {
  const root = projectRoot?.trim();
  return root ? `${DEFAULT_PROMPT_STORAGE_PREFIX}${root}` : null;
}

async function loadProjectDefaultPrompt(projectRoot: string | null | undefined): Promise<string | null> {
  const key = defaultPromptStorageKey(projectRoot);
  const api = bridge();
  if (!key || !api) return null;
  try {
    const stored = await api.collections.get(DEFAULT_PROMPT_COLLECTION, key);
    return typeof stored === "string" && stored.trim().length > 0 ? stored : null;
  } catch {
    return null;
  }
}

async function persistProjectDefaultPrompt(
  projectRoot: string | null | undefined,
  prompt: string,
): Promise<void> {
  const key = defaultPromptStorageKey(projectRoot);
  const api = bridge();
  if (!key || !api) return;
  try {
    // An empty string reads back as "nothing chosen": the page bridge has no
    // `collections.delete`, deliberately.
    await api.collections.put(DEFAULT_PROMPT_COLLECTION, key, prompt.trim());
  } catch {
    // Best effort only; failing to persist a prompt should never block launch.
  }
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
  };
}

export type SessionLaunchModelConfig = {
  modelId: string;
  reasoningEffort: string | null;
  fastMode: boolean;
  sessionType: BatchLaunchSessionType;
  /**
   * The permission the launch carries, as `AgentChatPermissionMode`.
   *
   * One string, and deliberately so: the compiled control held a whole
   * `NativeControlState` — Claude's interaction mode, Codex's approval policy
   * and sandbox pair, Cursor's mode id, Droid's autonomy flag — and collapsed
   * it to this on the way out. The native fields behind each option are the
   * renderer control's own internals and are not a page's to set, so the page
   * offers the same CHOICES and sends the same value.
   *
   * Null means "whatever the provider defaults to", which is what an untouched
   * pill has always meant.
   */
  permissionMode: string | null;
};

function toLaunchModelConfig(state: PerIssueState): SessionLaunchModelConfig {
  return {
    modelId: state.modelId,
    reasoningEffort: state.reasoningEffort,
    fastMode: state.fastMode,
    sessionType: state.sessionType ?? "chat",
    permissionMode: state.permissionMode ?? null,
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
    ...(patch.permissionMode !== undefined ? { permissionMode: patch.permissionMode } : {}),
  };
}

function SessionTypeToggle({
  value,
  onChange,
  disabled = false,
}: {
  value: BatchLaunchSessionType;
  onChange: (next: BatchLaunchSessionType) => void;
  disabled?: boolean;
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
            disabled={disabled}
            title={key === "chat" ? "In-app chat agent" : "Terminal CLI agent"}
            onClick={() => onChange(key)}
            className={cn(
              "inline-flex h-5 items-center gap-1 rounded px-1.5 text-[10.5px] font-medium leading-none transition-colors",
              active ? "bg-white/[0.1] text-fg" : "text-muted-fg/60 hover:text-fg/85",
              disabled && "cursor-not-allowed opacity-45",
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

/**
 * The provider-native permission pill.
 *
 * A port of `LaunchNativePermissionControls`. The compiled control drew a
 * different shape per provider — a popover menu for Claude and for Codex, a
 * labelled select for Cursor, Droid and OpenCode — over five literal option
 * lists in `renderer/lib/nativeLaunchControls.ts`, which a page cannot import.
 *
 * The OPTIONS come from `pageCapabilities`, which is ADE's own answer rather
 * than a table this plugin keeps: `sdk.chat.capabilities()` restates those five
 * lists for exactly this, with a test on ADE's side pinning the two together.
 * The value the reader picks is the provider's NATIVE one and is stored as
 * such — the launch puts it in the field `permissionField` names, so nothing
 * here translates it into ADE's unified vocabulary and nothing can get that
 * translation wrong.
 *
 * What differs from the compiled control is the shape: one select for every
 * provider, wearing the compiled trigger chrome, rather than a menu for two of
 * them and a select for three. The menu carried per-option detail sentences,
 * which live on the option's `title` here.
 *
 * A provider the capabilities do not name draws nothing at all — which is what
 * the compiled control did for a model whose provider group it could not
 * resolve.
 */
function PermissionModePicker({
  provider,
  capabilities,
  value,
  onChange,
  disabled = false,
}: {
  provider: string;
  capabilities: PageCapabilities | null;
  value: string | null;
  onChange: (permissionMode: string | null) => void;
  disabled?: boolean;
}) {
  const entry = capabilities?.providers.find((row) => row.provider === provider) ?? null;
  if (!entry || entry.permissionModes.length === 0) return null;
  return (
    <label className={cn(PERMISSION_TRIGGER_CLASS, COMPOSER_TOOLBAR_PICKER_TRIGGER)} title="Permissions">
      <select
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || null)}
        aria-label="Permissions"
        className="min-w-0 flex-1 truncate bg-transparent font-medium outline-none disabled:opacity-45"
      >
        {/* "Whatever the provider starts on" is a real choice and the one an
            untouched pill has always made, so it is an option rather than a
            hole the reader cannot get back to. */}
        <option value="">Default</option>
        {entry.permissionModes.map((mode) => (
          <option key={mode.value} value={mode.value} title={mode.detail ?? undefined}>
            {mode.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The launch pill row.
 *
 * A port of `components/shared/SessionLaunchModelControls`, with the session
 * toggle kept verbatim and the pickers rebuilt as native selects wearing the
 * compiled trigger chrome. Everything the compiled row could offer is offered:
 *
 *  - The MODEL list is `getChatModels()`, which now carries each model's
 *    provider group, its fast-tier support and its own reasoning ladder. What
 *    did not move is `ModelPicker` itself — a Radix popover with recents,
 *    grouping and per-provider icons — so this is a select over the same list.
 *  - FAST MODE is drawn only for a model that has a `fast` service tier, which
 *    is the same question `modelSupportsFastMode` asked of the registry.
 *  - REASONING EFFORT is the model's own tiers rather than a fixed
 *    none/low/medium/high ladder, and a model with no tiers draws no control —
 *    exactly as `ReasoningEffortPicker` behaved.
 *  - PERMISSIONS is `PermissionModePicker` above.
 */
function SessionLaunchModelControls({
  config,
  onChange,
  models,
  capabilities,
  disabled = false,
  showSessionType = true,
}: {
  config: SessionLaunchModelConfig;
  onChange: (patch: Partial<SessionLaunchModelConfig>) => void;
  models: PageChatModel[];
  capabilities: PageCapabilities | null;
  disabled?: boolean;
  showSessionType?: boolean;
}) {
  const model = models.find((row) => row.id === config.modelId) ?? null;
  const efforts = model?.reasoningEfforts ?? [];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {showSessionType ? (
        <SessionTypeToggle
          value={config.sessionType}
          onChange={(sessionType) => onChange({ sessionType })}
          disabled={disabled}
        />
      ) : null}
      <label className={cn(PERMISSION_TRIGGER_CLASS, COMPOSER_MODEL_TRIGGER)} title="Model">
        <select
          value={config.modelId}
          disabled={disabled || models.length === 0}
          onChange={(event) => {
            const nextId = event.target.value;
            const next = models.find((row) => row.id === nextId) ?? null;
            onChange({
              modelId: nextId,
              // A model with no fast tier REFUSES `fastMode: true` rather than
              // ignoring it, and a reasoning rung the new model does not offer
              // would be sent and refused. Both are cleared with the model that
              // carried them.
              ...(next?.fastMode ? {} : { fastMode: false }),
              ...(next?.reasoningEfforts.some((tier) => tier.effort === config.reasoningEffort)
                ? {}
                : { reasoningEffort: null }),
              // The permission vocabularies are native and differ per provider,
              // so a value chosen for a Claude model is not one a Droid model
              // offers — and it would go in a different launch field besides.
              ...(next?.provider === model?.provider ? {} : { permissionMode: null }),
            });
          }}
          aria-label="Model"
          className="min-w-0 flex-1 truncate bg-transparent font-medium outline-none disabled:opacity-45"
        >
          {config.modelId && !models.some((row) => row.id === config.modelId) ? (
            <option value={config.modelId}>{config.modelId}</option>
          ) : null}
          {models.length === 0 ? <option value="">No models</option> : null}
          {models.map((row) => (
            <option key={row.id} value={row.id}>{row.label}</option>
          ))}
        </select>
      </label>
      {efforts.length > 0 ? (
        <label className={cn(PERMISSION_TRIGGER_CLASS, COMPOSER_TOOLBAR_PICKER_TRIGGER)} title="Reasoning effort">
          <select
            value={config.reasoningEffort ?? ""}
            disabled={disabled}
            onChange={(event) => onChange({ reasoningEffort: event.target.value || null })}
            aria-label="Reasoning effort"
            className="min-w-0 flex-1 truncate bg-transparent font-medium capitalize outline-none disabled:opacity-45"
          >
            {/* The sentinel the child's `chosenReasoningEffort` reads as "send
                nothing", so the model's own default stands. */}
            <option value="">Default</option>
            {efforts.map((tier) => (
              <option key={tier.effort} value={tier.effort}>{tier.label}</option>
            ))}
          </select>
        </label>
      ) : null}
      {model?.fastMode ? (
        <button
          type="button"
          role="switch"
          aria-checked={config.fastMode}
          disabled={disabled}
          title="Run this launch on the provider's fast service tier"
          onClick={() => onChange({ fastMode: !config.fastMode })}
          className={cn(
            PERMISSION_TRIGGER_CLASS,
            "shrink-0 gap-1",
            config.fastMode && "border-violet-400/30 bg-violet-500/[0.08] text-fg",
          )}
        >
          <Lightning size={10} weight={config.fastMode ? "fill" : "regular"} />
          Fast
        </button>
      ) : null}
      <PermissionModePicker
        provider={model?.provider ?? ""}
        capabilities={capabilities}
        value={config.permissionMode}
        onChange={(permissionMode) => onChange({ permissionMode })}
        disabled={disabled}
      />
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
  lanes: PageLane[];
  /** When true, only create lanes (no agent kickoff) — hides the model pickers. */
  laneOnly?: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fires once, synchronously closing the modal; the orchestrator runs after. */
  onLaunch: (entries: BatchLaunchSubmit[]) => void;
}) {
  const [models, setModels] = useState<PageChatModel[]>([]);
  const [capabilities, setCapabilities] = useState<PageCapabilities | null>(null);
  // The compiled modal seeded from `useModelRecents()` and fell back to
  // `getDefaultModelDescriptor("claude"|"opencode")`. Neither exists here, so
  // the host catalog's own order decides, preferring a Claude row the way the
  // registry default did.
  const defaultModelId = useMemo(
    () =>
      models.find((model) => model.provider === "claude")?.id
      ?? models.find((model) => model.provider === "opencode")?.id
      ?? models[0]?.id
      ?? "",
    [models],
  );

  const [defaultConfig, setDefaultConfig] = useState<SessionLaunchModelConfig>(() => ({
    modelId: "",
    reasoningEffort: null,
    fastMode: false,
    sessionType: "chat",
    permissionMode: null,
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
    let cancelled = false;
    void getChatModels()
      .then((rows) => {
        if (!cancelled) setModels(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      });
    // Null on a refusal, not an empty table: `PermissionModePicker` draws
    // nothing for a provider it cannot name, and a form with no permission pill
    // is better than one offering values the launch would be refused for.
    void getCapabilities()
      .then((answer) => {
        if (!cancelled) setCapabilities(answer ?? null);
      })
      .catch(() => {
        if (!cancelled) setCapabilities(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const seedKey = `${projectRoot ?? ""}\0${issueSeedKey}`;
    if (seedKeyRef.current === seedKey) return;
    const initialSeed = seedKeyRef.current == null;
    seedKeyRef.current = seedKey;

    const kickoffPrompt = projectDefaultPrompt ?? defaultKickoffPrompt();
    const seedModel = defaultModelId;
    const seededConfig: SessionLaunchModelConfig = {
      modelId: seedModel,
      reasoningEffort: null,
      fastMode: false,
      sessionType: "chat",
      permissionMode: null,
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
          permissionMode: rowConfig.permissionMode,
        };
      }
      return next;
    });
    if (initialSeed && issues.length === 1) {
      setExpanded({ [issues[0]!.id]: true });
    }
  }, [open, projectRoot, issueSeedKey, issues, defaultModelId, defaultConfig, projectDefaultPrompt]);

  // A model catalog that lands after the seed still fills an empty picker,
  // exactly as the compiled recents did.
  useEffect(() => {
    if (!open || !defaultModelId) return;
    setDefaultConfig((current) => (current.modelId ? current : { ...current, modelId: defaultModelId }));
    setPerIssue((current) => {
      let changed = false;
      const next: Record<string, PerIssueState> = {};
      for (const [id, state] of Object.entries(current)) {
        if (!state.modelId) {
          next[id] = { ...state, modelId: defaultModelId };
          changed = true;
        } else {
          next[id] = state;
        }
      }
      return changed ? next : current;
    });
  }, [defaultModelId, open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const initialPrompt = defaultKickoffPrompt();

    void loadProjectDefaultPrompt(projectRoot).then((savedPrompt) => {
      if (cancelled) return;
      setProjectDefaultPrompt(savedPrompt);
      if (!savedPrompt || savedPrompt === initialPrompt) return;
      setPerIssue((current) => {
        let changed = false;
        const next: Record<string, PerIssueState> = {};
        for (const [id, state] of Object.entries(current)) {
          if (state.kickoffPrompt === initialPrompt) {
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
      [issueId]: { ...current[issueId]!, ...patch },
    }));
  }, []);

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
      if (patch.permissionMode !== undefined) applyDefaultField("permissionMode", patch.permissionMode);
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
      const { include: _include, laneTarget, ...config } = effectiveConfig;
      const existingLaneId =
        !laneOnly && laneTarget === "existing" ? state.existingLaneId?.trim() || null : null;
      if (!laneOnly && laneTarget === "existing" && !existingLaneId) continue;
      entries.push({
        issue,
        config: {
          ...config,
          existingLaneId,
          laneOnly,
        },
      });
    }
    if (!entries.length) return;
    onLaunch(entries);
  }, [issues, perIssue, onLaunch, laneOnly, multiIssue, defaultConfig]);

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
            models={models}
            capabilities={capabilities}
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
                      title={[
                        conflict.reason === "session"
                          ? `A session in lane "${conflict.laneName}" already attaches this issue`
                          : `Lane "${conflict.laneName}" already attaches this issue`,
                        // Where, when the host says. The reader's next question
                        // after "already being worked on" is which worktree, and
                        // a lane summary that withholds the path leaves the
                        // sentence as it was rather than trailing an em dash.
                        conflict.lanePath,
                      ].filter(Boolean).join(" — ")}
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
                    models={models}
                    capabilities={capabilities}
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
                              {/*
                                The compiled row's own `LaneCombobox`, now in the
                                kit — the same 671 lines, the same search box,
                                the same keyboard model, the same lane marks and
                                branch labels. It was a native select here for
                                one build, because the page had no combobox
                                primitive to reach for.

                                `fullWidth` because this cell is the field, and
                                the free-standing form is the one caller the
                                trigger's own max-width was written for.
                              */}
                              <LaneCombobox
                                lanes={selectableLanes.map((lane) => ({
                                  id: lane.id,
                                  name: lane.name,
                                  branchRef: lane.branch,
                                }))}
                                value={state.existingLaneId ?? ""}
                                onChange={(laneId) => patchIssue(issue.id, { existingLaneId: laneId || null })}
                                placeholder="Select a lane…"
                                aria-label="Select lane"
                                fullWidth
                                compact
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

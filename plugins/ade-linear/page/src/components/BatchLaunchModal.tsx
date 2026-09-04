import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CaretDown,
  CaretRight,
  ChatCircleDots,
  ClipboardText,
  GitBranch,
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

import { bridge } from "../bridge";
import {
  hasPicker,
  pickLane,
  pickModel,
  pickPermissionMode,
  pickReasoningEffort,
  pickerRectFromClick,
} from "../host/ui";
import { linearIssueBranchName } from "../lib/linearIssueBranch";
import {
  defaultKickoffPrompt,
  findIssueConflicts,
  type BatchLaunchIssueConfig,
  type BatchLaunchSessionType,
} from "../lib/linearBatchLaunch";
import {
  readLaunchPromptClipboardSetting,
  writeLaunchPromptClipboardSetting,
} from "./launchPromptClipboard";
import type { LaneLinearIssue, PageLane } from "../types";

type PerIssueState = BatchLaunchIssueConfig & SessionLaunchModelConfig & {
  /** When false the issue is excluded from the launch (skipped via the conflict guard). */
  include: boolean;
  /** "new" creates a lane per issue; "existing" launches into `existingLaneId`. */
  laneTarget: "new" | "existing";
  /** The chosen lane's own name, for the chip. Null when none is chosen. */
  existingLaneLabel: string | null;
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

function makeInitialConfig(kickoffPrompt: string): PerIssueState {
  return {
    ...EMPTY_MODEL_CONFIG,
    kickoffPrompt,
    branchOverride: "",
    existingLaneId: null,
    existingLaneLabel: null,
    include: true,
    laneTarget: "new",
  };
}

/**
 * Nothing chosen yet.
 *
 * The form used to seed a MODEL — the first Claude row in the host catalog,
 * else the first OpenCode one — because it drew the list itself and a select
 * with no value is a select showing a blank row. The host's picker has its own
 * default and its own recents, so seeding one here would be this plugin
 * choosing for a reader ADE is about to ask.
 */
const EMPTY_MODEL_CONFIG = {
  modelId: "",
  modelLabel: null,
  provider: null,
  providerLabel: null,
  reasoningEffort: null,
  reasoningEffortLabel: null,
  fastMode: false,
  sessionType: "chat",
  permissionMode: null,
  permissionModeLabel: null,
} satisfies SessionLaunchModelConfig;

/**
 * What the launch form holds, and what it prints.
 *
 * Every choice is a PAIR: the id the launch carries, and the host picker's own
 * label for it. They are separate because a launch argument is a provider's own
 * spelling (`acceptEdits`, `claude-opus-5`) and a chip that printed those would
 * be reading the reader an identifier. Nothing here derives one from the other:
 * the label is whatever the host said when the reader chose, so a model ADE
 * renamed reads as ADE renamed it.
 *
 * A null label means nothing has been chosen, which the chip draws as its
 * placeholder — for the permission and the reasoning rung that placeholder is
 * "Default", because "whatever the provider starts on" is a real choice and the
 * one an untouched pill has always made.
 */
export type SessionLaunchModelConfig = {
  modelId: string;
  modelLabel: string | null;
  /** The provider the model belongs to, as the host's picker named it. */
  provider: string | null;
  providerLabel: string | null;
  reasoningEffort: string | null;
  reasoningEffortLabel: string | null;
  fastMode: boolean;
  sessionType: BatchLaunchSessionType;
  /**
   * The permission the launch carries, in the provider's NATIVE vocabulary.
   *
   * One string, and deliberately so: the compiled control held a whole
   * `NativeControlState` — Claude's interaction mode, Codex's approval policy
   * and sandbox pair, Cursor's mode id, Droid's autonomy flag — and collapsed
   * it to this on the way out. The native fields behind each option are the
   * renderer control's own internals and are not a page's to set.
   *
   * Null means "whatever the provider defaults to", which is what an untouched
   * pill has always meant.
   */
  permissionMode: string | null;
  permissionModeLabel: string | null;
};

function toLaunchModelConfig(state: PerIssueState): SessionLaunchModelConfig {
  return {
    modelId: state.modelId,
    modelLabel: state.modelLabel ?? null,
    provider: state.provider ?? null,
    providerLabel: state.providerLabel ?? null,
    reasoningEffort: state.reasoningEffort,
    reasoningEffortLabel: state.reasoningEffortLabel ?? null,
    fastMode: state.fastMode,
    sessionType: state.sessionType ?? "chat",
    permissionMode: state.permissionMode ?? null,
    permissionModeLabel: state.permissionModeLabel ?? null,
  };
}

/**
 * Apply a model-row patch to one issue's state.
 *
 * Spread rather than field by field: every key of `SessionLaunchModelConfig` is
 * also a key of `PerIssueState`, and a hand-written list of ten of them is a
 * list that silently drops the eleventh — which is exactly how a chosen
 * provider or a chip's label would go missing on the row the reader edited.
 */
function patchFromLaunchModelConfig(
  state: PerIssueState,
  patch: Partial<SessionLaunchModelConfig>,
): PerIssueState {
  return { ...state, ...patch };
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
 * One picker chip.
 *
 * The page draws no list of its own any more. A chip prints the current choice
 * and opens the HOST's picker, which is the app's own popover over the page —
 * so the model list, the lane list, a provider's permission vocabulary and a
 * model's reasoning ladder are ADE's own controls rather than five selects this
 * plugin keeps in step by hand. The trigger chrome is the compiled composer's
 * (`PERMISSION_TRIGGER_CLASS`), so the chips sit where the pills sat.
 *
 * A host that answers no picker verb draws the chip DISABLED with a sentence
 * rather than falling back to a select: one control shape, and a reader who can
 * see why it will not open.
 */
function PickerChip({
  label,
  value,
  placeholder,
  onPress,
  available,
  disabled = false,
  widthClass = COMPOSER_TOOLBAR_PICKER_TRIGGER,
}: {
  label: string;
  value: string | null;
  placeholder: string;
  onPress: (event: React.MouseEvent<HTMLButtonElement>) => void;
  available: boolean;
  disabled?: boolean;
  widthClass?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled || !available}
      title={available ? label : `${label} is not available in this window.`}
      onClick={onPress}
      className={cn(PERMISSION_TRIGGER_CLASS, widthClass, "gap-1")}
    >
      <span className={cn("min-w-0 flex-1 truncate text-left font-medium", value ? undefined : "text-muted-fg/60")}>
        {value ?? placeholder}
      </span>
      <CaretDown size={9} weight="bold" className="shrink-0 opacity-60" />
    </button>
  );
}

/**
 * The launch pill row.
 *
 * A port of `components/shared/SessionLaunchModelControls`: session type, then
 * ADE's own model picker (fast lives inside it), then reasoning, then
 * permission. There is no separate Provider chip and no Fast toggle — those
 * were the controls that made launches pick Cursor-plus-Grok and fly the
 * picker to the webview's top-left corner.
 *
 * Dismissing a picker leaves the value alone, which is why every handler writes
 * state only for a non-null answer.
 */
function SessionLaunchModelControls({
  config,
  onChange,
  disabled = false,
  showSessionType = true,
}: {
  config: SessionLaunchModelConfig;
  onChange: (patch: Partial<SessionLaunchModelConfig>) => void;
  disabled?: boolean;
  showSessionType?: boolean;
}) {
  const provider = config.provider;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {showSessionType ? (
        <SessionTypeToggle
          value={config.sessionType}
          onChange={(sessionType) => onChange({ sessionType })}
          disabled={disabled}
        />
      ) : null}
      <PickerChip
        label="Model"
        value={config.modelLabel}
        placeholder="Model"
        widthClass={COMPOSER_MODEL_TRIGGER}
        available={hasPicker("pickModel")}
        disabled={disabled}
        onPress={(event) => void (async () => {
          const chosen = await pickModel({
            value: config.modelId || null,
            rect: pickerRectFromClick(event),
          });
          if (!chosen) return;
          const nextProvider = chosen.provider ?? provider;
          onChange({
            modelId: chosen.id,
            modelLabel: chosen.label,
            ...(nextProvider ? { provider: nextProvider, providerLabel: nextProvider } : {}),
            fastMode: chosen.fastMode === true,
            reasoningEffort: chosen.defaultReasoningEffort ?? null,
            reasoningEffortLabel: chosen.defaultReasoningEffortLabel ?? null,
            permissionMode: nextProvider === provider
              ? config.permissionMode
              : chosen.defaultPermissionMode ?? null,
            permissionModeLabel: nextProvider === provider
              ? config.permissionModeLabel
              : chosen.defaultPermissionLabel ?? null,
          });
        })()}
      />
      <PickerChip
        label="Reasoning effort"
        value={config.reasoningEffortLabel}
        placeholder="Default"
        available={hasPicker("pickReasoningEffort") && Boolean(config.modelId)}
        disabled={disabled}
        onPress={(event) => void (async () => {
          const chosen = await pickReasoningEffort(
            provider ?? "",
            config.modelId,
            config.reasoningEffort,
            pickerRectFromClick(event),
          );
          if (!chosen) return;
          onChange({ reasoningEffort: chosen.id || null, reasoningEffortLabel: chosen.id ? chosen.label : null });
        })()}
      />
      <PickerChip
        label="Permissions"
        value={config.permissionModeLabel}
        placeholder="Default"
        available={hasPicker("pickPermissionMode") && Boolean(provider)}
        disabled={disabled}
        onPress={(event) => void (async () => {
          const chosen = await pickPermissionMode(
            provider ?? "",
            config.permissionMode,
            pickerRectFromClick(event),
          );
          if (!chosen) return;
          onChange({ permissionMode: chosen.id || null, permissionModeLabel: chosen.id ? chosen.label : null });
        })()}
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
  const [defaultConfig, setDefaultConfig] = useState<SessionLaunchModelConfig>(() => ({ ...EMPTY_MODEL_CONFIG }));
  const [projectDefaultPrompt, setProjectDefaultPrompt] = useState<string | null>(null);
  /**
   * Whether the launch copies its kickoff prompt to the clipboard.
   *
   * The plugin's own `launchPromptClipboard` setting, drawn HERE rather than in
   * the settings section: the only prompt it copies is the one in the box below
   * it, and a switch two screens from the act it governs is a switch nobody
   * finds. `null` while the read is in flight, so the toggle does not flip from
   * off to on under the reader's cursor.
   */
  const [clipboardEnabled, setClipboardEnabled] = useState<boolean | null>(null);
  const [perIssue, setPerIssue] = useState<Record<string, PerIssueState>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const seedKeyRef = useRef<string | null>(null);

  const multiIssue = issues.length > 1;
  const issueSeedKey = useMemo(() => issues.map((issue) => issue.id).join("\0"), [issues]);
  const conflicts = useMemo(() => findIssueConflicts(issues, lanes), [issues, lanes]);
  /**
   * Whether "Existing lane" is a real option here.
   *
   * The primary lane is excluded, as the compiled picker excluded it: an agent
   * launched onto the project's own trunk has no branch of its own to work on.
   * `lanes` is still read for this and for the duplicate guard above, even
   * though the picker itself is the host's now.
   */
  const hasSelectableLane = useMemo(
    () => lanes.some((lane) => lane.laneType !== "primary"),
    [lanes],
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void readLaunchPromptClipboardSetting().then((enabled) => {
      if (!cancelled) setClipboardEnabled(enabled);
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
    const seededConfig: SessionLaunchModelConfig = { ...EMPTY_MODEL_CONFIG };
    if (initialSeed) {
      setDefaultConfig(seededConfig);
    }
    const rowConfig = initialSeed ? seededConfig : defaultConfig;
    setPerIssue((current) => {
      const next: Record<string, PerIssueState> = {};
      for (const issue of issues) {
        next[issue.id] = current[issue.id] ?? {
          ...makeInitialConfig(kickoffPrompt),
          ...rowConfig,
        };
      }
      return next;
    });
    if (initialSeed && issues.length === 1) {
      setExpanded({ [issues[0]!.id]: true });
    }
  }, [open, projectRoot, issueSeedKey, issues, defaultConfig, projectDefaultPrompt]);

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

  const applyDefaultConfigToAll = useCallback((config: SessionLaunchModelConfig) => {
    setPerIssue((current) => {
      const next: Record<string, PerIssueState> = {};
      for (const [id, state] of Object.entries(current)) {
        next[id] = patchFromLaunchModelConfig(state, config);
      }
      return next;
    });
  }, []);

  // One write, not one per field. `applyDefaultConfigToAll` spreads the whole
  // config onto every row, so the five per-field calls that used to follow it
  // were a second list of the same keys — the list that silently dropped the
  // sixth the day a field was added.
  const handleDefaultConfigChange = useCallback((patch: Partial<SessionLaunchModelConfig>) => {
    setDefaultConfig((current) => {
      const next = { ...current, ...patch };
      applyDefaultConfigToAll(next);
      return next;
    });
  }, [applyDefaultConfigToAll]);

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
      // The chip LABELS stay in the form. They are what a picker said, for the
      // reader to read; the launch carries ids, and passing a display string
      // into a launch argument is how a label ends up in a provider's request.
      const {
        include: _include,
        laneTarget,
        existingLaneLabel: _laneLabel,
        modelLabel: _modelLabel,
        providerLabel: _providerLabel,
        reasoningEffortLabel: _effortLabel,
        permissionModeLabel: _permissionLabel,
        ...config
      } = effectiveConfig;
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
  /**
   * Every included issue has a model, and a lane to launch into.
   *
   * The form used to seed a model from the host catalog, so a launch could
   * never be missing one. The host's picker owns that default now and the form
   * starts empty, which means "press Launch and nothing happens" is a state
   * that can exist — so the button says why instead of skipping the row in
   * `handleLaunch` where nobody can see it.
   */
  const missingChoice = !laneOnly && includedIssues.some((issue) => {
    const state = perIssue[issue.id];
    if (!state) return true;
    const effective = multiIssue ? state : patchFromLaunchModelConfig(state, defaultConfig);
    if (!effective.modelId.trim()) return true;
    return (state.laneTarget ?? "new") === "existing" && !state.existingLaneId?.trim();
  });

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
                          <button
                            type="button"
                            role="switch"
                            aria-checked={clipboardEnabled === true}
                            aria-label="Copy the launch prompt to the clipboard"
                            disabled={clipboardEnabled === null}
                            onClick={() => {
                              const next = clipboardEnabled !== true;
                              setClipboardEnabled(next);
                              void writeLaunchPromptClipboardSetting(next);
                            }}
                            title="Copy this prompt to the clipboard when the launch starts"
                            className={cn(
                              "inline-flex h-5 items-center gap-1 rounded-md border px-2 text-[10px] font-medium transition-colors",
                              clipboardEnabled
                                ? "border-violet-400/30 bg-violet-500/[0.08] text-fg"
                                : "border-white/[0.1] bg-white/[0.04] text-fg/70 hover:border-white/[0.18] hover:bg-white/[0.08] hover:text-fg",
                              "disabled:cursor-not-allowed disabled:opacity-45",
                            )}
                          >
                            <ClipboardText size={10} weight={clipboardEnabled ? "fill" : "regular"} />
                            Copy on launch
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
                            const disabled = key === "existing" && !hasSelectableLane;
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
                          /*
                            The HOST's lane picker, not a copy of it.

                            The page drew the kit's `LaneCombobox` over
                            `pageLanes` here, which was the app's own 671 lines
                            of markup fed by a list this plugin fetched. The app
                            opens that picker itself now, over its own lanes,
                            and answers the choice — so the two can no longer
                            disagree about which lanes exist or what a lane is
                            called.
                          */
                          <PickerChip
                            label="Lane"
                            value={state.existingLaneLabel}
                            placeholder="Select a lane…"
                            widthClass="min-w-[220px] flex-1"
                            available={hasPicker("pickLane")}
                            onPress={(event) => void (async () => {
                              const chosen = await pickLane(state.existingLaneId, pickerRectFromClick(event));
                              if (!chosen) return;
                              patchIssue(issue.id, {
                                existingLaneId: chosen.id || null,
                                existingLaneLabel: chosen.id ? chosen.label : null,
                              });
                            })()}
                          />
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
        <Button
          type="button"
          variant="primary"
          disabled={launchCount === 0 || missingChoice}
          title={missingChoice ? "Pick a model, and a lane for every issue set to an existing one." : undefined}
          onClick={handleLaunch}
        >
          <Rocket size={13} weight="fill" />
          {laneOnly ? "Create" : "Launch"} {launchCount} {launchCount === 1 ? "lane" : "lanes"}
        </Button>
      </div>
    </LaneDialogShell>
  );
}

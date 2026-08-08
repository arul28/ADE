import {
  getDefaultModelDescriptor,
  getModelById,
  getRuntimeModelRefForDescriptor,
  listModelDescriptorsForProvider,
  modelSupportsFastMode,
  resolveCursorCliModelVariant,
  resolveProviderGroupForModel,
  type ModelDescriptor,
  type ModelProviderGroup,
} from "../../../desktop/src/shared/modelRegistry";
import { CURSOR_AVAILABLE_MODE_IDS, CURSOR_MODE_LABELS } from "../../../desktop/src/shared/cursorModes";
import type {
  AgentChatModelCatalogRefreshProvider,
  AgentChatModelInfo,
  AgentChatPermissionMode,
} from "../../../desktop/src/shared/types/chat";
import { DEFAULT_CODEX_REASONING_EFFORT, type CliTerminalProvider } from "./adeApi";
import { theme } from "./theme";
import type { AdeCodeInterfaceMode, AdeCodeModelState, AdeCodeProvider, SetupPaneRow, SetupPaneRowKind } from "./types";
import { normalizeProvider, providerLabel } from "./providerMetadata";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
export const CODEX_PRESETS = ["default", "edit", "plan", "full-auto", "config-toml"] as const;
export const CLAUDE_PERMISSION_OPTIONS = ["default", "auto", "plan", "acceptEdits", "bypassPermissions"] as const;
export const OPENCODE_PERMISSION_OPTIONS = ["plan", "edit", "full-auto", "config-toml"] as const;
export const DROID_PERMISSION_OPTIONS = ["read-only", "auto-low", "auto-medium", "auto-high", "agi"] as const;

export type CodexPreset = (typeof CODEX_PRESETS)[number];

export function initialModelState(draftKind: AdeCodeInterfaceMode = "chat"): AdeCodeModelState {
  const descriptor = getDefaultModelDescriptor("codex");
  return {
    provider: "codex",
    interfaceMode: draftKind,
    model: descriptor?.providerModelId ?? "gpt-5.6-sol",
    modelId: descriptor?.id ?? null,
    displayName: descriptor?.displayName ?? "GPT-5.6 Sol",
    reasoningEffort: descriptor?.defaultReasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT,
    fastMode: false,
    permissionMode: "default",
    interactionMode: "default",
    claudePermissionMode: "default",
    codexApprovalPolicy: "on-request",
    codexSandbox: "workspace-write",
    codexConfigSource: "flags",
    opencodePermissionMode: "edit",
    droidPermissionMode: "auto-low",
    cursorModeId: "agent",
    cursorAvailableModeIds: [],
    cursorConfigValues: {},
  };
}

export function runtimeProviderForUiProvider(provider: AdeCodeProvider): ModelProviderGroup {
  return provider === "ollama" || provider === "lmstudio" ? "opencode" : provider;
}

/**
 * Pi and OpenCode-backed providers share ADE's four tool-permission modes.
 * The persisted field is still named `opencodePermissionMode` for IPC/session
 * compatibility, so keep that legacy detail behind one provider-level helper.
 */
export function usesToolPermissionModes(provider: AdeCodeProvider): boolean {
  return provider === "pi" || runtimeProviderForUiProvider(provider) === "opencode";
}

/**
 * The provider CLI a modelState provider launches as, or null when it has no
 * tracked CLI (Ollama / LM Studio are OpenCode-backed chat only). Gates the
 * Interface=CLI launch path.
 */
export function cliProviderForModelStateProvider(provider: AdeCodeProvider): CliTerminalProvider | null {
  return provider === "claude" || provider === "codex" || provider === "cursor" || provider === "droid" || provider === "opencode" || provider === "pi"
    ? provider
    : null;
}

function firstReasoningEffortForModel(model: AgentChatModelInfo | null | undefined, provider: AdeCodeProvider): string | null {
  const modelId = `${model?.modelId ?? ""} ${model?.id ?? ""} ${model?.displayName ?? ""}`.toLowerCase();
  const efforts = model?.reasoningEfforts
    ?.map((entry) => entry.effort)
    .filter(Boolean) ?? [];
  const advertisedDefault = model?.defaultReasoningEffort?.trim().toLowerCase() ?? null;
  if (modelId.includes("fable") && efforts.includes("high")) return "high";
  if (advertisedDefault && efforts.includes(advertisedDefault)) return advertisedDefault;
  if (efforts.includes(DEFAULT_CODEX_REASONING_EFFORT)) return DEFAULT_CODEX_REASONING_EFFORT;
  if (efforts.length) return efforts[0] ?? null;
  const descriptor = model?.modelId || model?.id ? getModelById(model.modelId ?? model.id) : undefined;
  const descriptorEfforts = descriptor?.reasoningTiers ?? [];
  const descriptorId = `${descriptor?.id ?? ""} ${descriptor?.providerModelId ?? ""} ${descriptor?.displayName ?? ""}`.toLowerCase();
  if (descriptorId.includes("fable") && descriptorEfforts.includes("high")) return "high";
  if (descriptor?.defaultReasoningEffort && descriptorEfforts.includes(descriptor.defaultReasoningEffort)) {
    return descriptor.defaultReasoningEffort;
  }
  if (descriptorEfforts.includes(DEFAULT_CODEX_REASONING_EFFORT)) return DEFAULT_CODEX_REASONING_EFFORT;
  if (descriptorEfforts.length) return descriptorEfforts[0] ?? null;
  return provider === "codex" ? DEFAULT_CODEX_REASONING_EFFORT : null;
}

export function modelStatePatchForModel(provider: AdeCodeProvider, model: AgentChatModelInfo): Pick<AdeCodeModelState, "provider" | "model" | "modelId" | "displayName" | "reasoningEffort"> {
  const modelId = model.modelId ?? model.id;
  const descriptor = getModelById(modelId);
  const resolvedProvider = descriptor ? normalizeProvider(resolveProviderGroupForModel(descriptor)) : provider;
  const runtimeProvider = runtimeProviderForUiProvider(resolvedProvider);
  return {
    provider: resolvedProvider,
    model: descriptor ? getRuntimeModelRefForDescriptor(descriptor, runtimeProvider) : model.id,
    modelId,
    displayName: model.displayName,
    reasoningEffort: firstReasoningEffortForModel(model, resolvedProvider),
  };
}

export function modelInfoSupportsFastMode(model: AgentChatModelInfo | null | undefined): boolean {
  const descriptor = model?.modelId || model?.id ? getModelById(model.modelId ?? model.id) : undefined;
  return Boolean(model?.serviceTiers?.some((tier) => tier.trim().toLowerCase() === "fast"))
    || modelSupportsFastMode(descriptor);
}

function cursorDescriptorForModelInfo(model: AgentChatModelInfo | null | undefined): ModelDescriptor | undefined {
  const modelId = model?.modelId ?? model?.id;
  return modelId ? getModelById(modelId) : undefined;
}

function cursorAvailabilityForModel(
  model: AgentChatModelInfo | null | undefined,
  descriptor = cursorDescriptorForModelInfo(model),
): { cli: boolean; sdk: boolean } | null {
  return model?.cursorAvailability ?? descriptor?.cursorAvailability ?? null;
}

export function cursorModelAvailableForInterface(
  model: AgentChatModelInfo | null | undefined,
  interfaceMode: AdeCodeInterfaceMode,
): boolean {
  const descriptor = cursorDescriptorForModelInfo(model);
  if (descriptor?.family !== "cursor" && model?.family !== "cursor") return true;
  const availability = cursorAvailabilityForModel(model, descriptor);
  if (!availability) return false;
  return interfaceMode === "cli" ? availability.cli === true : availability.sdk === true;
}

export function cursorSourceForInterfaceMode(interfaceMode: AdeCodeInterfaceMode): "sdk" | "cli" {
  return interfaceMode === "cli" ? "cli" : "sdk";
}

export function providerModelsCacheKey(provider: AdeCodeProvider, interfaceMode: AdeCodeInterfaceMode): string {
  return provider === "cursor" ? `cursor:${cursorSourceForInterfaceMode(interfaceMode)}` : provider;
}

export function modelCatalogRefreshCacheKey(
  provider: AgentChatModelCatalogRefreshProvider,
  cursorSource?: "sdk" | "cli",
): string {
  return provider === "cursor" ? `cursor:${cursorSource ?? "sdk"}` : provider;
}

export function fallbackModelStatePatch(provider: AdeCodeProvider): Pick<AdeCodeModelState, "provider" | "model" | "modelId" | "displayName" | "reasoningEffort"> {
  const registryProvider = provider === "ollama" || provider === "lmstudio" ? "opencode" : provider;
  const descriptor = getDefaultModelDescriptor(registryProvider)
    ?? listModelDescriptorsForProvider(registryProvider)[0]
    ?? getDefaultModelDescriptor("codex");
  return {
    provider,
    model: descriptor ? getRuntimeModelRefForDescriptor(descriptor, registryProvider) : "gpt-5.6-sol",
    modelId: descriptor?.id ?? null,
    displayName: descriptor?.displayName ?? providerLabel(provider),
    reasoningEffort: descriptor?.id.includes("fable") && descriptor.reasoningTiers?.includes("high")
      ? "high"
      : descriptor?.defaultReasoningEffort
        ?? descriptor?.reasoningTiers?.[0]
        ?? (provider === "codex" ? DEFAULT_CODEX_REASONING_EFFORT : null),
  };
}

export function registryModelsForProvider(provider: AdeCodeProvider): AgentChatModelInfo[] {
  if (provider === "ollama" || provider === "lmstudio") return [];
  return listModelDescriptorsForProvider(provider).map((descriptor) => ({
    id: descriptor.id,
    modelId: descriptor.id,
    displayName: descriptor.displayName,
    isDefault: descriptor.id === getDefaultModelDescriptor(provider)?.id,
    reasoningEfforts: descriptor.reasoningTiers?.map((effort) => ({ effort, description: effort })),
    defaultReasoningEffort: descriptor.defaultReasoningEffort ?? null,
    ...(descriptor.serviceTiers?.length ? { serviceTiers: descriptor.serviceTiers } : {}),
    ...(descriptor.cursorAvailability ? { cursorAvailability: descriptor.cursorAvailability } : {}),
    ...(descriptor.cursorCliVariants?.length ? { cursorCliVariants: descriptor.cursorCliVariants } : {}),
  }));
}

function compatibleCursorModelForInterface(
  models: readonly AgentChatModelInfo[],
  interfaceMode: AdeCodeInterfaceMode,
): AgentChatModelInfo | null {
  const compatible = models.filter((model) => cursorModelAvailableForInterface(model, interfaceMode));
  return compatible.find((model) => model.isDefault) ?? compatible[0] ?? null;
}

function modelInfoMatchesModelState(model: AgentChatModelInfo, state: AdeCodeModelState): boolean {
  const selected = (state.modelId ?? state.model).trim().toLowerCase();
  if (!selected) return false;
  return [model.id, model.modelId, ...(model.aliases ?? [])]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.trim().toLowerCase() === selected);
}

export function reconcileCursorModelStateForInterface(
  state: AdeCodeModelState,
  interfaceMode: AdeCodeInterfaceMode,
  models: readonly AgentChatModelInfo[],
): AdeCodeModelState {
  if (state.provider !== "cursor") return { ...state, interfaceMode };
  const currentModel = models.find((model) => modelInfoMatchesModelState(model, state)) ?? null;
  const descriptor = state.modelId ? getModelById(state.modelId) : undefined;
  const availability = cursorAvailabilityForModel(currentModel, descriptor);
  const currentAllowed = availability
    ? (interfaceMode === "cli" ? availability.cli === true : availability.sdk === true)
    : false;
  if (currentAllowed && descriptor?.family === "cursor") {
    const supportsFast = modelSupportsFastMode(descriptor);
    return {
      ...state,
      interfaceMode,
      model: interfaceMode === "cli"
        ? resolveCursorCliModelVariant(descriptor, {
            reasoningEffort: state.reasoningEffort,
            fastMode: supportsFast && state.fastMode,
          })
        : getRuntimeModelRefForDescriptor(descriptor, "cursor"),
      fastMode: supportsFast ? state.fastMode : false,
    };
  }
  if (currentAllowed) return { ...state, interfaceMode };
  const fallback = compatibleCursorModelForInterface(models, interfaceMode);
  if (!fallback) {
    return {
      ...state,
      interfaceMode,
      model: "",
      modelId: null,
      displayName: providerLabel("cursor"),
      reasoningEffort: null,
      fastMode: false,
    };
  }
  const patch = modelStatePatchForModel("cursor", fallback);
  const fallbackDescriptor = patch.modelId ? getModelById(patch.modelId) : undefined;
  const launchDescriptor = fallbackDescriptor?.family === "cursor" && fallback.cursorCliVariants?.length
    ? { ...fallbackDescriptor, cursorCliVariants: fallback.cursorCliVariants }
    : fallbackDescriptor;
  const supportsFast = modelInfoSupportsFastMode(fallback);
  return {
    ...state,
    ...patch,
    interfaceMode,
    model: interfaceMode === "cli" && launchDescriptor?.family === "cursor"
      ? resolveCursorCliModelVariant(launchDescriptor, {
          reasoningEffort: patch.reasoningEffort,
          fastMode: supportsFast && state.fastMode,
        })
      : patch.model,
    fastMode: supportsFast ? state.fastMode : false,
  };
}

export function resolveCursorCliModelForLaunch(
  state: AdeCodeModelState,
  models: readonly AgentChatModelInfo[] = [],
): string {
  const modelId = (state.modelId ?? state.model).trim();
  if (!modelId) throw new Error("Choose a Cursor CLI model before launching a CLI session.");
  const modelInfo = models.find((model) => modelInfoMatchesModelState(model, state)) ?? null;
  const descriptor = getModelById(modelId);
  const availability = cursorAvailabilityForModel(modelInfo, descriptor);
  if (!availability?.cli) {
    throw new Error("This Cursor model is available for chat only. Choose a Cursor CLI model for a CLI session.");
  }
  if (descriptor?.family === "cursor") {
    const launchDescriptor = modelInfo?.cursorCliVariants?.length
      ? { ...descriptor, cursorCliVariants: modelInfo.cursorCliVariants }
      : descriptor;
    const supportsFast = modelSupportsFastMode(launchDescriptor);
    return resolveCursorCliModelVariant(launchDescriptor, {
      reasoningEffort: state.reasoningEffort,
      fastMode: supportsFast && state.fastMode,
    });
  }
  return modelId.toLowerCase().startsWith("cursor/") ? modelId.slice("cursor/".length) : modelId;
}

export function modelReasoningEfforts(modelState: AdeCodeModelState, models: AgentChatModelInfo[]): string[] {
  const model = models.find((entry) => entry.id === modelState.modelId || entry.modelId === modelState.modelId);
  const fromModel = model?.reasoningEfforts?.map((entry) => entry.effort).filter(Boolean) ?? [];
  const descriptor = modelState.modelId ? getModelById(modelState.modelId) : undefined;
  if (fromModel.length) return fromModel;
  if (descriptor?.reasoningTiers?.length) return descriptor.reasoningTiers;
  return modelState.provider === "codex" ? EFFORTS : [];
}

export function reasoningEffortDisplayLabel(
  effort: string | null | undefined,
  modelState: Pick<AdeCodeModelState, "provider" | "model" | "modelId">,
): string | null {
  if (!effort) return null;
  const isGpt56CodexModel = modelState.provider === "codex"
    && /gpt-5\.6-(?:sol|terra|luna)/i.test(`${modelState.modelId ?? ""} ${modelState.model}`);
  if (!isGpt56CodexModel) return effort;
  if (effort === "low") return "Light";
  if (effort === "medium") return "Medium";
  if (effort === "high") return "High";
  if (effort === "xhigh") return "Extra High";
  if (effort === "max") return "Max";
  if (effort === "ultra") return "Ultra";
  return effort;
}

export function resolveCodexPreset(modelState: AdeCodeModelState): CodexPreset | "custom" {
  if (modelState.codexConfigSource === "config-toml") return "config-toml";
  if (modelState.codexApprovalPolicy === "never" && modelState.codexSandbox === "danger-full-access") return "full-auto";
  if (modelState.codexApprovalPolicy === "untrusted" && modelState.codexSandbox === "workspace-write") return "edit";
  if (
    (modelState.codexApprovalPolicy === "on-request" || modelState.codexApprovalPolicy === "untrusted")
    && modelState.codexSandbox === "read-only"
  ) return "plan";
  if (
    (modelState.codexApprovalPolicy === "on-request" || modelState.codexApprovalPolicy === "on-failure" || modelState.codexApprovalPolicy === "untrusted")
    && modelState.codexSandbox === "workspace-write"
  ) return "default";
  return "custom";
}

export function codexApprovalSandboxLabel(modelState: Pick<AdeCodeModelState, "codexApprovalPolicy" | "codexSandbox">): string {
  return `${modelState.codexApprovalPolicy} · ${modelState.codexSandbox}`;
}

export function codexPresetPatch(preset: CodexPreset): Pick<AdeCodeModelState, "codexApprovalPolicy" | "codexSandbox" | "codexConfigSource" | "permissionMode"> {
  if (preset === "full-auto") {
    return {
      codexApprovalPolicy: "never",
      codexSandbox: "danger-full-access",
      codexConfigSource: "flags",
      permissionMode: "full-auto",
    };
  }
  if (preset === "plan") {
    return {
      codexApprovalPolicy: "on-request",
      codexSandbox: "read-only",
      codexConfigSource: "flags",
      permissionMode: "plan",
    };
  }
  if (preset === "edit") {
    return {
      codexApprovalPolicy: "untrusted",
      codexSandbox: "workspace-write",
      codexConfigSource: "flags",
      permissionMode: "edit",
    };
  }
  if (preset === "config-toml") {
    return {
      codexApprovalPolicy: "on-request",
      codexSandbox: "workspace-write",
      codexConfigSource: "config-toml",
      permissionMode: "config-toml",
    };
  }
  return {
    codexApprovalPolicy: "on-request",
    codexSandbox: "workspace-write",
    codexConfigSource: "flags",
    permissionMode: "default",
  };
}

export function droidPermissionToLegacy(mode: AdeCodeModelState["droidPermissionMode"]): AgentChatPermissionMode {
  if (mode === "read-only") return "plan";
  if (mode === "agi") return "plan";
  if (mode === "auto-low") return "edit";
  if (mode === "auto-medium") return "default";
  return "full-auto";
}

function cursorModeLabel(modeId: string | null | undefined): string {
  const normalized = modeId?.trim().toLowerCase() || "agent";
  return CURSOR_MODE_LABELS[normalized] ?? normalized;
}

export function cursorModeIdsForState(modelState: Pick<AdeCodeModelState, "cursorAvailableModeIds">): string[] {
  const snapshotIds = modelState.cursorAvailableModeIds
    .map((modeId) => modeId.trim())
    .filter(Boolean);
  return snapshotIds.length ? snapshotIds : [...CURSOR_AVAILABLE_MODE_IDS];
}

export function permissionSummary(modelState: AdeCodeModelState): string {
  if (modelState.provider === "codex") return resolveCodexPreset(modelState);
  if (modelState.provider === "claude") {
    if (modelState.interactionMode === "plan" || modelState.claudePermissionMode === "plan") return "plan";
    if (modelState.claudePermissionMode === "auto") return "auto";
    if (modelState.claudePermissionMode === "acceptEdits") return "accept edits";
    if (modelState.claudePermissionMode === "bypassPermissions") return "bypass";
    return "default";
  }
  if (usesToolPermissionModes(modelState.provider)) return modelState.opencodePermissionMode;
  if (modelState.provider === "droid") return modelState.droidPermissionMode;
  return cursorModeLabel(modelState.cursorModeId);
}

const MODE_DESCRIPTIONS: Record<string, string> = {
  plan: "read-only deliberation",
  default: "ask before acting",
  auto: "auto-approve safe actions",
  "accept edits": "auto-approve file edits",
  bypass: "skip permission checks",
  "full-auto": "no approvals required",
  edit: "edit-mode operations",
  agent: "agent-driven actions",
  ask: "confirm each action",
  "read-only": "no edits or execution",
  "auto-low": "low-autonomy ops",
  "auto-medium": "medium-autonomy ops",
  "auto-high": "high-autonomy ops",
  agi: "orchestrator mission",
  "config-toml": "config-defined mode",
};

export function modeDescription(summary: string): string {
  return MODE_DESCRIPTIONS[summary] ?? "permission mode";
}

export function modeAccentColor(summary: string): string {
  if (summary === "plan" || summary === "read-only" || summary === "agi") return theme.color.planMode;
  if (summary === "bypass" || summary === "full-auto" || summary === "auto-high") return theme.color.warning;
  return theme.color.accent;
}

function permissionOptionsDetail(modelState: AdeCodeModelState): string {
  if (modelState.provider === "codex") return CODEX_PRESETS.join(" · ");
  if (modelState.provider === "claude") return "default · plan · auto · bypass";
  if (usesToolPermissionModes(modelState.provider)) return OPENCODE_PERMISSION_OPTIONS.join(" · ");
  if (modelState.provider === "droid") return DROID_PERMISSION_OPTIONS.join(" · ");
  return cursorModeIdsForState(modelState).map((modeId) => cursorModeLabel(modeId)).join(" · ");
}

export function applyProviderPermissionMode(modelState: AdeCodeModelState): Partial<AdeCodeModelState> {
  if (modelState.provider === "codex") {
    const preset = resolveCodexPreset(modelState);
    return { permissionMode: preset === "custom" ? modelState.permissionMode : preset };
  }
  if (modelState.provider === "claude") {
    if (modelState.interactionMode === "plan" || modelState.claudePermissionMode === "plan") {
      return { permissionMode: "plan", interactionMode: "plan", claudePermissionMode: "plan" };
    }
    if (modelState.claudePermissionMode === "auto") return { permissionMode: "auto", interactionMode: "default" };
    if (modelState.claudePermissionMode === "acceptEdits") return { permissionMode: "edit", interactionMode: "default" };
    if (modelState.claudePermissionMode === "bypassPermissions") return { permissionMode: "full-auto", interactionMode: "default" };
    return { permissionMode: "default", interactionMode: "default" };
  }
  if (usesToolPermissionModes(modelState.provider)) return { permissionMode: modelState.opencodePermissionMode };
  if (modelState.provider === "droid") return { permissionMode: droidPermissionToLegacy(modelState.droidPermissionMode) };
  if (modelState.provider === "cursor") {
    if (modelState.cursorModeId === "plan") return { permissionMode: "plan" };
    if (modelState.cursorModeId === "ask") return { permissionMode: "edit" };
    if (modelState.cursorModeId === "full-auto") return { permissionMode: "full-auto" };
    return { permissionMode: "default" };
  }
  return {};
}

export function buildSetupRows(args: {
  modelState: AdeCodeModelState;
  models: AgentChatModelInfo[];
  includeRefresh: boolean;
  includeApply: boolean;
  includeImportSession?: boolean;
  importSessionEnabled?: boolean;
  importSessionDetail?: string | null;
  outputStyle?: string | null;
  outputStyleEditable?: boolean;
  /** Draft/next-chat interface (Chat = SDK chat, CLI = tracked terminal). */
  interfaceMode: AdeCodeInterfaceMode;
  /** False once a session exists — interface is fixed by the session type. */
  interfaceEditable: boolean;
}): SetupPaneRow[] {
  const efforts = modelReasoningEfforts(args.modelState, args.models);
  const descriptor = args.modelState.modelId ? getModelById(args.modelState.modelId) : undefined;
  const activeModel = args.models.find((entry) => entry.id === args.modelState.modelId || entry.modelId === args.modelState.modelId);
  const fastSupported =
    Boolean(activeModel?.serviceTiers?.some((tier) => tier.trim().toLowerCase() === "fast"))
    || modelSupportsFastMode(descriptor);
  const rows: SetupPaneRow[] = [
    {
      kind: "provider",
      label: "Provider",
      value: providerLabel(args.modelState.provider),
      cyclable: true,
    },
    {
      kind: "interface",
      label: "Interface",
      value: args.interfaceMode === "cli" ? "CLI" : "Chat",
      detail: args.interfaceEditable
        ? "Chat · CLI"
        : args.interfaceMode === "cli"
          ? "tracked CLI session"
          : "ADE chat",
      disabled: !args.interfaceEditable,
      cyclable: args.interfaceEditable,
    },
    ...(args.includeImportSession
      ? [{
          kind: "import-session" as const,
          label: "Import session",
          value: args.importSessionEnabled === false ? "unavailable" : "open",
          detail: args.importSessionDetail ?? "external CLI history",
          disabled: args.importSessionEnabled === false,
        }]
      : []),
    {
      kind: "model",
      label: "Model",
      value: args.modelState.displayName,
      detail: args.models.length ? `${args.models.length} available` : "using registry default",
      cyclable: true,
    },
    {
      kind: "reasoning",
      label: "Reasoning",
      value: reasoningEffortDisplayLabel(args.modelState.reasoningEffort, args.modelState) ?? "none",
      detail: args.modelState.reasoningEffort === "ultra"
        ? "multi-agent · can use limits faster"
        : efforts.length
          ? efforts.map((effort) => reasoningEffortDisplayLabel(effort, args.modelState) ?? effort).join(", ")
          : "not exposed by this model",
      disabled: !efforts.length,
      cyclable: true,
    },
    {
      kind: "permission",
      label: "Permissions",
      value: permissionSummary(args.modelState),
      detail: permissionOptionsDetail(args.modelState),
      cyclable: true,
    },
  ];
  rows.push({
    kind: "codex-fast",
    label: "Fast mode",
    value: fastSupported && args.modelState.fastMode ? "on" : "off",
    detail: "on · off",
    disabled: !fastSupported,
    cyclable: true,
  });
  if (args.modelState.provider === "claude") {
    rows.push({
      kind: "output-style",
      label: "Output style",
      value: args.outputStyle?.trim() || "default",
      detail: args.outputStyleEditable === false
        ? "active Claude chat only"
        : "default · concise · verbose",
      disabled: args.outputStyleEditable === false,
      cyclable: true,
    });
  }
  if (args.includeRefresh) {
    rows.push({
      kind: "refresh-status",
      label: "Refresh status",
      value: "run",
      detail: "checks provider auth/runtime state",
    });
  }
  if (args.includeApply) {
    rows.push({
      kind: "apply",
      label: "Confirm",
      value: "ready",
      detail: "returns focus to the chat composer",
    });
  }
  return rows;
}

export function defaultSetupSelectionIndex(rows: SetupPaneRow[]): number {
  const applyIndex = rows.findIndex((row) => row.kind === "apply");
  return applyIndex >= 0 ? applyIndex : 0;
}

export function defaultModelPickerSelectionIndex(rows: SetupPaneRow[]): number {
  const modelIndex = rows.findIndex((row) => row.kind === "model" && !row.disabled);
  if (modelIndex >= 0) return modelIndex;
  const reasoningIndex = rows.findIndex((row) => row.kind === "reasoning" && !row.disabled);
  if (reasoningIndex >= 0) return reasoningIndex;
  return defaultSetupSelectionIndex(rows);
}

export function setupSelectionIndexForKind(rows: SetupPaneRow[], preferredKind: SetupPaneRowKind | null | undefined): number {
  if (preferredKind) {
    const preferredIndex = rows.findIndex((row) => row.kind === preferredKind);
    if (preferredIndex >= 0) return preferredIndex;
  }
  return defaultModelPickerSelectionIndex(rows);
}

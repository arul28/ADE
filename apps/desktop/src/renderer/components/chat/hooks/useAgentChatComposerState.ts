import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChatDraft } from "./useChatDraft";
import {
  createDefaultComputerUsePolicy,
  type AgentChatClaudePermissionMode,
  type AgentChatCodexApprovalPolicy,
  type AgentChatCodexConfigSource,
  type AgentChatCodexSandbox,
  type AgentChatEventEnvelope,
  type AgentChatExecutionMode,
  type AgentChatFileRef,
  type AgentChatSessionSummary,
  type AgentChatUnifiedPermissionMode,
  type AiProviderConnectionStatus,
  type ChatSurfaceProfile,
  type ComputerUsePolicy,
} from "../../../../shared/types";
import {
  getModelById,
  isModelProviderGroup,
  MODEL_REGISTRY,
  resolveModelIdForProvider,
} from "../../../../shared/modelRegistry";
import { deriveConfiguredModelIds } from "../../../lib/modelOptions";

// ── Constants ───────────────────────────────────────────────────────

const LAST_MODEL_ID_KEY = "ade.chat.lastModelId";
const LAST_REASONING_KEY_PREFIX = "ade.chat.lastReasoningEffort";
const LEGACY_PROVIDER_KEY = "ade.chat.lastProvider";
const LEGACY_MODEL_KEY_PREFIX = "ade.chat.lastModel";

// ── Local helpers ───────────────────────────────────────────────────

export type NativeControlState = {
  claudePermissionMode: AgentChatClaudePermissionMode;
  codexApprovalPolicy: AgentChatCodexApprovalPolicy;
  codexSandbox: AgentChatCodexSandbox;
  codexConfigSource: AgentChatCodexConfigSource;
  unifiedPermissionMode: AgentChatUnifiedPermissionMode;
};

export function defaultNativeControls(profile: ChatSurfaceProfile): NativeControlState {
  if (profile === "persistent_identity") {
    return {
      claudePermissionMode: "bypassPermissions",
      codexApprovalPolicy: "never",
      codexSandbox: "danger-full-access",
      codexConfigSource: "flags",
      unifiedPermissionMode: "full-auto",
    };
  }
  return {
    claudePermissionMode: "default",
    codexApprovalPolicy: "on-request",
    codexSandbox: "workspace-write",
    codexConfigSource: "flags",
    unifiedPermissionMode: "edit",
  };
}

export function summarizeNativeControls(
  provider: AgentChatSessionSummary["provider"] | "claude" | "codex" | "unified",
  controls: NativeControlState,
): Pick<
  AgentChatSessionSummary,
  "claudePermissionMode" | "codexApprovalPolicy" | "codexSandbox" | "codexConfigSource" | "unifiedPermissionMode"
> {
  if (provider === "claude") {
    return {
      claudePermissionMode: controls.claudePermissionMode,
    };
  }
  if (provider === "codex") {
    return {
      codexApprovalPolicy: controls.codexApprovalPolicy,
      codexSandbox: controls.codexSandbox,
      codexConfigSource: controls.codexConfigSource,
    };
  }
  return {
    unifiedPermissionMode: controls.unifiedPermissionMode,
  };
}

function migrateOldPrefs(): string | null {
  try {
    const oldProvider = window.localStorage.getItem(LEGACY_PROVIDER_KEY);
    const oldModel = oldProvider ? window.localStorage.getItem(`${LEGACY_MODEL_KEY_PREFIX}:${oldProvider}`) : null;
    if (oldProvider && oldModel) {
      const provider = oldProvider === "codex" || oldProvider === "claude" || oldProvider === "unified"
        ? oldProvider
        : undefined;
      const matchId = resolveModelIdForProvider(oldModel, provider);
      const match = matchId ? getModelById(matchId) : undefined;
      if (match) {
        window.localStorage.setItem(LAST_MODEL_ID_KEY, match.id);
        window.localStorage.removeItem(LEGACY_PROVIDER_KEY);
        window.localStorage.removeItem(`${LEGACY_MODEL_KEY_PREFIX}:codex`);
        window.localStorage.removeItem(`${LEGACY_MODEL_KEY_PREFIX}:claude`);
        return match.id;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

export function readLastUsedModelId(): string | null {
  try {
    const raw = window.localStorage.getItem(LAST_MODEL_ID_KEY);
    if (raw && raw.trim().length) return raw.trim();
  } catch {
    // ignore
  }
  return migrateOldPrefs();
}

export function writeLastUsedModelId(modelId: string) {
  try {
    window.localStorage.setItem(LAST_MODEL_ID_KEY, modelId);
  } catch {
    // ignore
  }
}

export function readLastUsedReasoningEffort(args: {
  laneId: string | null;
  modelId: string;
}): string | null {
  if (!args.laneId) return null;
  try {
    const raw = window.localStorage.getItem(`${LAST_REASONING_KEY_PREFIX}:${args.laneId}:${args.modelId}`);
    return raw && raw.trim().length ? raw.trim() : null;
  } catch {
    return null;
  }
}

export function writeLastUsedReasoningEffort(args: {
  laneId: string | null;
  modelId: string;
  effort: string | null;
}) {
  if (!args.laneId || !args.modelId.trim().length) return;
  try {
    const key = `${LAST_REASONING_KEY_PREFIX}:${args.laneId}:${args.modelId}`;
    if (!args.effort || !args.effort.trim().length) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, args.effort.trim());
  } catch {
    // ignore
  }
}

export function selectReasoningEffort(args: {
  tiers: string[];
  preferred: string | null;
}): string | null {
  if (!args.tiers.length) return null;
  if (args.preferred && args.tiers.includes(args.preferred)) {
    return args.preferred;
  }
  return args.tiers.includes("medium") ? "medium" : args.tiers[0]!;
}

function resolveRegistryModelId(
  value: string | null | undefined,
  provider?: "codex" | "claude" | "unified",
): string | null {
  return resolveModelIdForProvider(value, provider) ?? null;
}

function resolveCliRegistryModelId(provider: "codex" | "claude", value: string | null | undefined): string | null {
  return resolveModelIdForProvider(value, provider) ?? null;
}

// ── Hook ────────────────────────────────────────────────────────────

export interface UseAgentChatComposerStateArgs {
  surfaceProfile: ChatSurfaceProfile;
  selectedSession: AgentChatSessionSummary | null;
  selectedSessionId: string | null;
  selectedSessionModelId: string | null;
  selectedEvents: AgentChatEventEnvelope[];
  laneId: string | null;
  availableModelIdsOverride?: string[];
}

export interface UseAgentChatComposerStateReturn {
  modelId: string;
  setModelId: React.Dispatch<React.SetStateAction<string>>;
  reasoningEffort: string | null;
  setReasoningEffort: React.Dispatch<React.SetStateAction<string | null>>;
  executionMode: AgentChatExecutionMode;
  setExecutionMode: React.Dispatch<React.SetStateAction<AgentChatExecutionMode>>;
  claudePermissionMode: AgentChatClaudePermissionMode;
  setClaudePermissionMode: React.Dispatch<React.SetStateAction<AgentChatClaudePermissionMode>>;
  codexApprovalPolicy: AgentChatCodexApprovalPolicy;
  setCodexApprovalPolicy: React.Dispatch<React.SetStateAction<AgentChatCodexApprovalPolicy>>;
  codexSandbox: AgentChatCodexSandbox;
  setCodexSandbox: React.Dispatch<React.SetStateAction<AgentChatCodexSandbox>>;
  codexConfigSource: AgentChatCodexConfigSource;
  setCodexConfigSource: React.Dispatch<React.SetStateAction<AgentChatCodexConfigSource>>;
  unifiedPermissionMode: AgentChatUnifiedPermissionMode;
  setUnifiedPermissionMode: React.Dispatch<React.SetStateAction<AgentChatUnifiedPermissionMode>>;
  computerUsePolicy: ComputerUsePolicy;
  setComputerUsePolicy: React.Dispatch<React.SetStateAction<ComputerUsePolicy>>;
  attachments: AgentChatFileRef[];
  setAttachments: React.Dispatch<React.SetStateAction<AgentChatFileRef[]>>;
  draft: string;
  setDraft: (text: string) => void;
  clearDraft: () => void;
  includeProjectDocs: boolean;
  setIncludeProjectDocs: React.Dispatch<React.SetStateAction<boolean>>;
  sendOnEnter: boolean;
  setSendOnEnter: React.Dispatch<React.SetStateAction<boolean>>;
  sdkSlashCommands: import("../../../../shared/types").AgentChatSlashCommand[];
  setSdkSlashCommands: React.Dispatch<React.SetStateAction<import("../../../../shared/types").AgentChatSlashCommand[]>>;
  promptSuggestion: string | null;
  setPromptSuggestion: React.Dispatch<React.SetStateAction<string | null>>;
  availableModelIds: string[];
  setAvailableModelIds: React.Dispatch<React.SetStateAction<string[]>>;
  providerConnections: {
    claude: AiProviderConnectionStatus | null;
    codex: AiProviderConnectionStatus | null;
  } | null;
  preferencesReady: boolean;
  setPreferencesReady: React.Dispatch<React.SetStateAction<boolean>>;
  initialNativeControls: NativeControlState;
  currentNativeControls: NativeControlState;
  syncComposerToSession: (session: AgentChatSessionSummary | null) => void;
  refreshAvailableModels: () => Promise<string[]>;
  refreshProviderConnections: () => Promise<void>;
  buildNativeControlPayload: (provider: "claude" | "codex" | "unified") => ReturnType<typeof summarizeNativeControls>;
}

export function useAgentChatComposerState({
  surfaceProfile,
  selectedSession,
  selectedSessionId,
  selectedSessionModelId,
  selectedEvents,
  laneId,
  availableModelIdsOverride,
}: UseAgentChatComposerStateArgs): UseAgentChatComposerStateReturn {
  const initialNativeControls = useMemo(() => defaultNativeControls(surfaceProfile), [surfaceProfile]);

  const [modelId, setModelId] = useState<string>("");
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(null);
  const [executionMode, setExecutionMode] = useState<AgentChatExecutionMode>("focused");
  const [availableModelIds, setAvailableModelIds] = useState<string[]>([]);
  const [claudePermissionMode, setClaudePermissionMode] = useState<AgentChatClaudePermissionMode>(initialNativeControls.claudePermissionMode);
  const [codexApprovalPolicy, setCodexApprovalPolicy] = useState<AgentChatCodexApprovalPolicy>(initialNativeControls.codexApprovalPolicy);
  const [codexSandbox, setCodexSandbox] = useState<AgentChatCodexSandbox>(initialNativeControls.codexSandbox);
  const [codexConfigSource, setCodexConfigSource] = useState<AgentChatCodexConfigSource>(initialNativeControls.codexConfigSource);
  const [unifiedPermissionMode, setUnifiedPermissionMode] = useState<AgentChatUnifiedPermissionMode>(initialNativeControls.unifiedPermissionMode);
  const [computerUsePolicy, setComputerUsePolicy] = useState<ComputerUsePolicy>(createDefaultComputerUsePolicy());
  const [providerConnections, setProviderConnections] = useState<{
    claude: AiProviderConnectionStatus | null;
    codex: AiProviderConnectionStatus | null;
  } | null>(null);
  const [attachments, setAttachments] = useState<AgentChatFileRef[]>([]);
  const [includeProjectDocs, setIncludeProjectDocs] = useState(false);
  const [sdkSlashCommands, setSdkSlashCommands] = useState<import("../../../../shared/types").AgentChatSlashCommand[]>([]);
  const [sendOnEnter, setSendOnEnter] = useState(true);
  const { draft, setDraft, clearDraft } = useChatDraft({ sessionId: selectedSessionId, laneId, modelId });
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [promptSuggestion, setPromptSuggestion] = useState<string | null>(null);

  // ── syncComposerToSession ─────────────────────────────────────────

  const syncComposerToSession = useCallback((session: AgentChatSessionSummary | null) => {
    if (!session) {
      setClaudePermissionMode(initialNativeControls.claudePermissionMode);
      setCodexApprovalPolicy(initialNativeControls.codexApprovalPolicy);
      setCodexSandbox(initialNativeControls.codexSandbox);
      setCodexConfigSource(initialNativeControls.codexConfigSource);
      setUnifiedPermissionMode(initialNativeControls.unifiedPermissionMode);
      return;
    }
    const nextModelId = session.modelId
      ?? resolveRegistryModelId(session.model, isModelProviderGroup(session.provider) ? session.provider : undefined);
    if (nextModelId) {
      setModelId(nextModelId);
    }
    setReasoningEffort(session.reasoningEffort ?? null);
    setExecutionMode(session.executionMode ?? "focused");
    setClaudePermissionMode(session.claudePermissionMode ?? initialNativeControls.claudePermissionMode);
    setCodexApprovalPolicy(session.codexApprovalPolicy ?? initialNativeControls.codexApprovalPolicy);
    setCodexSandbox(session.codexSandbox ?? initialNativeControls.codexSandbox);
    setCodexConfigSource(session.codexConfigSource ?? initialNativeControls.codexConfigSource);
    setUnifiedPermissionMode(session.unifiedPermissionMode ?? initialNativeControls.unifiedPermissionMode);
    setComputerUsePolicy(session.computerUse ?? createDefaultComputerUsePolicy());
  }, [initialNativeControls]);

  // ── refreshAvailableModels ────────────────────────────────────────

  const refreshAvailableModels = useCallback(async () => {
    try {
      const status = await window.ade.ai.getStatus();
      const available = deriveConfiguredModelIds(status);
      setAvailableModelIds(available);
      return available;
    } catch {
      // Fall back to direct model discovery probes below.
    }

    try {
      const [codexModels, claudeModels, unifiedModels] = await Promise.all([
        window.ade.agentChat.models({ provider: "codex" }).catch(() => []),
        window.ade.agentChat.models({ provider: "claude" }).catch(() => []),
        window.ade.agentChat.models({ provider: "unified" }).catch(() => []),
      ]);
      const available = new Set<string>();

      for (const model of codexModels) {
        const resolved = resolveCliRegistryModelId("codex", model.id);
        if (resolved) available.add(resolved);
      }
      for (const model of claudeModels) {
        const resolved = resolveCliRegistryModelId("claude", model.id);
        if (resolved) available.add(resolved);
      }
      for (const model of unifiedModels) {
        const resolved = resolveRegistryModelId(model.id, "unified");
        if (resolved) available.add(resolved);
      }

      const ordered = MODEL_REGISTRY.filter((model) => !model.deprecated && available.has(model.id)).map((model) => model.id);
      setAvailableModelIds(ordered);
      return ordered;
    } catch {
      setAvailableModelIds([]);
      return [];
    }
  }, []);

  // ── refreshProviderConnections ────────────────────────────────────

  const refreshProviderConnections = useCallback(async () => {
    try {
      const status = await window.ade.ai.getStatus();
      setProviderConnections({
        claude: status.providerConnections?.claude ?? null,
        codex: status.providerConnections?.codex ?? null,
      });
    } catch {
      setProviderConnections(null);
    }
  }, []);

  // ── currentNativeControls ─────────────────────────────────────────

  const currentNativeControls = useMemo<NativeControlState>(() => ({
    claudePermissionMode,
    codexApprovalPolicy,
    codexSandbox,
    codexConfigSource,
    unifiedPermissionMode,
  }), [
    claudePermissionMode,
    codexApprovalPolicy,
    codexSandbox,
    codexConfigSource,
    unifiedPermissionMode,
  ]);

  const buildNativeControlPayload = useCallback((provider: "claude" | "codex" | "unified") => {
    return summarizeNativeControls(provider, currentNativeControls);
  }, [currentNativeControls]);

  // ── Provider connection refresh on session / turn changes ─────────

  useEffect(() => {
    void refreshProviderConnections();
  }, [refreshProviderConnections, selectedSession?.provider]);

  return {
    modelId,
    setModelId,
    reasoningEffort,
    setReasoningEffort,
    executionMode,
    setExecutionMode,
    claudePermissionMode,
    setClaudePermissionMode,
    codexApprovalPolicy,
    setCodexApprovalPolicy,
    codexSandbox,
    setCodexSandbox,
    codexConfigSource,
    setCodexConfigSource,
    unifiedPermissionMode,
    setUnifiedPermissionMode,
    computerUsePolicy,
    setComputerUsePolicy,
    attachments,
    setAttachments,
    draft,
    setDraft,
    clearDraft,
    includeProjectDocs,
    setIncludeProjectDocs,
    sendOnEnter,
    setSendOnEnter,
    sdkSlashCommands,
    setSdkSlashCommands,
    promptSuggestion,
    setPromptSuggestion,
    availableModelIds,
    setAvailableModelIds,
    providerConnections,
    preferencesReady,
    setPreferencesReady,
    initialNativeControls,
    currentNativeControls,
    syncComposerToSession,
    refreshAvailableModels,
    refreshProviderConnections,
    buildNativeControlPayload,
  };
}

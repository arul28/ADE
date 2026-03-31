import { create } from "zustand";
import type {
  AgentChatClaudePermissionMode,
  AgentChatCodexApprovalPolicy,
  AgentChatCodexConfigSource,
  AgentChatCodexSandbox,
  AgentChatExecutionMode,
  AgentChatFileRef,
  AgentChatInteractionMode,
  AgentChatUnifiedPermissionMode,
  ComputerUsePolicy,
} from "../../shared/types";

const NEW_SESSION_KEY = "\0new";
const SEP = "\0";

export interface ComposerDraftSnapshot {
  draft: string;
  modelId: string;
  reasoningEffort: string | null;
  executionMode: AgentChatExecutionMode;
  interactionMode: AgentChatInteractionMode;
  claudePermissionMode: AgentChatClaudePermissionMode;
  codexApprovalPolicy: AgentChatCodexApprovalPolicy;
  codexSandbox: AgentChatCodexSandbox;
  codexConfigSource: AgentChatCodexConfigSource;
  unifiedPermissionMode: AgentChatUnifiedPermissionMode;
  computerUsePolicy: ComputerUsePolicy;
  attachments: AgentChatFileRef[];
  includeProjectDocs: boolean;
  sendOnEnter: boolean;
}

function snapshotKey(laneId: string, sessionId: string | null): string {
  return `${laneId}${SEP}${sessionId ?? NEW_SESSION_KEY}`;
}

interface ChatDraftState {
  snapshots: Record<string, ComposerDraftSnapshot>;
  draftsPerSession: Record<string, Record<string, string>>;

  saveSnapshot: (laneId: string, sessionId: string | null, snapshot: ComposerDraftSnapshot) => void;
  getSnapshot: (laneId: string, sessionId: string | null) => ComposerDraftSnapshot | undefined;
  clearSnapshot: (laneId: string, sessionId: string | null) => void;

  saveDraftsMap: (laneId: string, map: Map<string | null, string>) => void;
  getDraftsMap: (laneId: string) => Map<string | null, string>;
}

export const useChatDraftStore = create<ChatDraftState>((set, get) => ({
  snapshots: {},
  draftsPerSession: {},

  saveSnapshot: (laneId, sessionId, snapshot) => {
    const key = snapshotKey(laneId, sessionId);
    set((state) => ({ snapshots: { ...state.snapshots, [key]: snapshot } }));
  },

  getSnapshot: (laneId, sessionId) => {
    return get().snapshots[snapshotKey(laneId, sessionId)];
  },

  clearSnapshot: (laneId, sessionId) => {
    const key = snapshotKey(laneId, sessionId);
    set((state) => {
      const { [key]: _, ...rest } = state.snapshots;
      return { snapshots: rest };
    });
  },

  saveDraftsMap: (laneId, map) => {
    const serialized: Record<string, string> = {};
    for (const [k, v] of map.entries()) {
      serialized[k ?? NEW_SESSION_KEY] = v;
    }
    set((state) => ({ draftsPerSession: { ...state.draftsPerSession, [laneId]: serialized } }));
  },

  getDraftsMap: (laneId) => {
    const serialized = get().draftsPerSession[laneId];
    if (!serialized) return new Map();
    const map = new Map<string | null, string>();
    for (const [k, v] of Object.entries(serialized)) {
      map.set(k === NEW_SESSION_KEY ? null : k, v);
    }
    return map;
  },
}));

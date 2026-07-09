import type {
  AgentChatClaudePermissionMode,
  AgentChatCodexApprovalPolicy,
  AgentChatCodexConfigSource,
  AgentChatCodexSandbox,
  AgentChatDroidPermissionMode,
  AgentChatInteractionMode,
  AgentChatOpenCodePermissionMode,
  AgentChatPermissionMode,
  AgentChatProvider,
  ChatSurfaceProfile,
} from "../../shared/types";
import { CURSOR_AVAILABLE_MODE_IDS } from "../../shared/cursorModes";
import {
  getModelById,
  resolveProviderGroupForModel,
  type ModelDescriptor,
} from "../../shared/modelRegistry";
import type { NativeControlState } from "./draftLaunchJobs";
import { resolveModelDescriptorWithRuntimeCatalog } from "../components/shared/ModelPicker/modelCatalog";

type ChatRuntimeProviderKey = "claude" | "codex" | "cursor" | "droid" | "opencode";
type CliProvider = ChatRuntimeProviderKey;

export function defaultNativeControls(profile: ChatSurfaceProfile = "standard"): NativeControlState {
  if (profile === "persistent_identity") {
    return {
      interactionMode: "default",
      claudePermissionMode: "bypassPermissions",
      codexApprovalPolicy: "never",
      codexSandbox: "danger-full-access",
      codexConfigSource: "flags",
      opencodePermissionMode: "full-auto",
      droidPermissionMode: "auto-high",
      cursorModeId: "full-auto",
      cursorConfigValues: {},
    };
  }
  return {
    interactionMode: "default",
    claudePermissionMode: "default",
    codexApprovalPolicy: "on-request",
    codexSandbox: "workspace-write",
    codexConfigSource: "flags",
    opencodePermissionMode: "edit",
    droidPermissionMode: "auto-low",
    cursorModeId: "agent",
    cursorConfigValues: {},
  };
}

function resolveDescriptor(modelId: string): ModelDescriptor | undefined {
  return resolveModelDescriptorWithRuntimeCatalog(modelId) ?? getModelById(modelId);
}

export function resolveChatRuntimeProvider(modelId: string): ChatRuntimeProviderKey {
  const desc = resolveDescriptor(modelId);
  return desc ? resolveProviderGroupForModel(desc) : "opencode";
}

function droidPermissionModeToLegacyPermissionMode(mode: AgentChatDroidPermissionMode): AgentChatPermissionMode {
  if (mode === "read-only") return "plan";
  if (mode === "agi") return "plan";
  if (mode === "auto-low") return "edit";
  if (mode === "auto-medium") return "default";
  return "full-auto";
}

export function summarizeNativeControls(
  provider: AgentChatProvider | ChatRuntimeProviderKey,
  controls: NativeControlState,
): Pick<
  import("../../shared/types").AgentChatSessionSummary,
  | "interactionMode"
  | "claudePermissionMode"
  | "codexApprovalPolicy"
  | "codexSandbox"
  | "codexConfigSource"
  | "opencodePermissionMode"
  | "droidPermissionMode"
  | "permissionMode"
  | "cursorModeId"
> {
  if (provider === "claude") {
    let permissionMode: AgentChatPermissionMode;
    if (controls.interactionMode === "plan") {
      permissionMode = "plan";
    } else if (controls.claudePermissionMode === "bypassPermissions") {
      permissionMode = "full-auto";
    } else if (controls.claudePermissionMode === "acceptEdits") {
      permissionMode = "edit";
    } else {
      permissionMode = controls.claudePermissionMode;
    }
    return {
      interactionMode: controls.interactionMode,
      claudePermissionMode: controls.claudePermissionMode,
      permissionMode,
    };
  }
  if (provider === "codex") {
    let permissionMode: AgentChatPermissionMode | undefined;
    if (controls.codexConfigSource === "config-toml") {
      permissionMode = "config-toml";
    } else if (controls.codexApprovalPolicy === "never" && controls.codexSandbox === "danger-full-access") {
      permissionMode = "full-auto";
    } else if (controls.codexApprovalPolicy === "untrusted" && controls.codexSandbox === "workspace-write") {
      permissionMode = "edit";
    } else if (
      (controls.codexApprovalPolicy === "on-request" || controls.codexApprovalPolicy === "on-failure")
      && controls.codexSandbox === "workspace-write"
    ) {
      permissionMode = "default";
    } else if (
      (controls.codexApprovalPolicy === "on-request" || controls.codexApprovalPolicy === "untrusted")
      && controls.codexSandbox === "read-only"
    ) {
      permissionMode = "plan";
    }
    return {
      codexApprovalPolicy: controls.codexApprovalPolicy,
      codexSandbox: controls.codexSandbox,
      codexConfigSource: controls.codexConfigSource,
      ...(permissionMode ? { permissionMode } : {}),
    };
  }
  if (provider === "cursor") {
    const modeId = controls.cursorModeId?.trim().toLowerCase() ?? "";
    let permissionMode: AgentChatPermissionMode = "default";
    if (modeId.includes("full") || modeId.includes("auto")) permissionMode = "full-auto";
    else if (modeId.includes("plan")) permissionMode = "plan";
    else if (modeId.includes("ask")) permissionMode = "edit";
    return {
      cursorModeId: controls.cursorModeId,
      permissionMode,
    };
  }
  if (provider === "droid") {
    return {
      droidPermissionMode: controls.droidPermissionMode,
      permissionMode: droidPermissionModeToLegacyPermissionMode(controls.droidPermissionMode),
    };
  }
  return {
    opencodePermissionMode: controls.opencodePermissionMode,
    permissionMode: controls.opencodePermissionMode,
  };
}

export function buildChatLaunchNativePayload(
  modelId: string,
  controls: NativeControlState,
): ReturnType<typeof summarizeNativeControls> & { cursorConfigValues?: NativeControlState["cursorConfigValues"] } {
  const provider = resolveChatRuntimeProvider(modelId);
  return {
    ...summarizeNativeControls(provider, controls),
    ...(provider === "cursor" ? { cursorConfigValues: controls.cursorConfigValues } : {}),
  };
}

export function cliPermissionModeFromNativeControls(
  modelId: string,
  controls: NativeControlState,
): AgentChatPermissionMode {
  const provider = resolveChatRuntimeProvider(modelId) as CliProvider;
  return summarizeNativeControls(provider, controls).permissionMode ?? "default";
}

export function applyUnifiedPermissionToNativeControls(
  modelId: string,
  mode: AgentChatPermissionMode,
  current: NativeControlState,
): NativeControlState {
  const provider = resolveChatRuntimeProvider(modelId);
  const next = { ...current, cursorConfigValues: { ...current.cursorConfigValues } };

  if (provider === "claude") {
    if (mode === "plan") {
      return { ...next, interactionMode: "plan", claudePermissionMode: "plan" };
    }
    const claudePermissionMode: AgentChatClaudePermissionMode =
      mode === "full-auto"
        ? "bypassPermissions"
        : mode === "edit"
          ? "acceptEdits"
          : "default";
    return { ...next, interactionMode: "default", claudePermissionMode };
  }

  if (provider === "codex") {
    if (mode === "config-toml") {
      return { ...next, codexConfigSource: "config-toml" };
    }
    if (mode === "full-auto") {
      return {
        ...next,
        codexApprovalPolicy: "never",
        codexSandbox: "danger-full-access",
        codexConfigSource: "flags",
      };
    }
    if (mode === "edit") {
      return {
        ...next,
        codexApprovalPolicy: "untrusted",
        codexSandbox: "workspace-write",
        codexConfigSource: "flags",
      };
    }
    if (mode === "plan") {
      return {
        ...next,
        codexApprovalPolicy: "on-request",
        codexSandbox: "read-only",
        codexConfigSource: "flags",
      };
    }
    return {
      ...next,
      codexApprovalPolicy: "on-request",
      codexSandbox: "workspace-write",
      codexConfigSource: "flags",
    };
  }

  if (provider === "cursor") {
    const cursorModeId =
      mode === "plan"
        ? "plan"
        : mode === "full-auto"
          ? "full-auto"
          : mode === "edit"
            ? "ask"
            : "agent";
    return { ...next, cursorModeId };
  }

  if (provider === "droid") {
    const droidPermissionMode: AgentChatDroidPermissionMode =
      mode === "plan"
        ? "read-only"
        : mode === "edit"
          ? "auto-low"
          : mode === "default"
            ? "auto-medium"
            : "auto-high";
    return { ...next, droidPermissionMode };
  }

  const opencodePermissionMode: AgentChatOpenCodePermissionMode =
    mode === "plan"
      ? "plan"
      : mode === "full-auto"
        ? "full-auto"
        : mode === "config-toml"
          ? "config-toml"
          : "edit";
  return { ...next, opencodePermissionMode };
}

export function readUnifiedPermissionFromNativeControls(
  modelId: string,
  controls: NativeControlState,
): AgentChatPermissionMode {
  const provider = resolveChatRuntimeProvider(modelId);
  return summarizeNativeControls(provider, controls).permissionMode ?? "default";
}

export function defaultUnifiedPermissionForModel(modelId: string): AgentChatPermissionMode {
  const defaults = defaultNativeControls();
  return readUnifiedPermissionFromNativeControls(modelId, defaults);
}

export function cursorModeChoices(): string[] {
  return [...CURSOR_AVAILABLE_MODE_IDS];
}

export function cursorModeLabel(modeId: string): string {
  switch (modeId) {
    case "agent": return "Agent";
    case "ask": return "Ask";
    case "plan": return "Plan";
    case "full-auto": return "Full auto";
    default: return modeId;
  }
}

export function codexPresetFromControls(controls: NativeControlState): "default" | "edit" | "plan" | "full-auto" | "config-toml" | "custom" {
  if (controls.codexConfigSource === "config-toml") return "config-toml";
  if (controls.codexApprovalPolicy === "untrusted" && controls.codexSandbox === "workspace-write") return "edit";
  if (
    (controls.codexApprovalPolicy === "on-request" || controls.codexApprovalPolicy === "on-failure")
    && controls.codexSandbox === "workspace-write"
  ) return "default";
  if (
    (controls.codexApprovalPolicy === "on-request" || controls.codexApprovalPolicy === "untrusted")
    && controls.codexSandbox === "read-only"
  ) return "plan";
  if (controls.codexApprovalPolicy === "never" && controls.codexSandbox === "danger-full-access") return "full-auto";
  return "custom";
}

export function applyCodexPresetToControls(
  preset: "default" | "edit" | "plan" | "full-auto" | "config-toml",
  current: NativeControlState,
): NativeControlState {
  const policies: Record<
    Exclude<typeof preset, "config-toml">,
    Pick<NativeControlState, "codexApprovalPolicy" | "codexSandbox" | "codexConfigSource">
  > = {
    default: { codexApprovalPolicy: "on-request", codexSandbox: "workspace-write", codexConfigSource: "flags" },
    edit: { codexApprovalPolicy: "untrusted", codexSandbox: "workspace-write", codexConfigSource: "flags" },
    plan: { codexApprovalPolicy: "on-request", codexSandbox: "read-only", codexConfigSource: "flags" },
    "full-auto": { codexApprovalPolicy: "never", codexSandbox: "danger-full-access", codexConfigSource: "flags" },
  };
  if (preset === "config-toml") {
    return { ...current, codexConfigSource: "config-toml" };
  }
  return { ...current, ...policies[preset] };
}

export type ClaudePermissionOption = {
  value: AgentChatClaudePermissionMode;
  label: string;
  detail: string;
};

export const CLAUDE_PERMISSION_OPTIONS: ClaudePermissionOption[] = [
  { value: "default", label: "Manual", detail: "Claude asks before edits, Bash, and other sensitive tools." },
  { value: "auto", label: "Auto", detail: "Claude judges each tool call." },
  { value: "acceptEdits", label: "Accept edits", detail: "File edits are auto-approved; higher-risk actions still prompt." },
  { value: "plan", label: "Plan mode", detail: "Read-only Claude turns for analysis and implementation planning." },
  { value: "bypassPermissions", label: "Bypass", detail: "Skip every Claude permission prompt for this chat." },
];

export const CODEX_PERMISSION_PRESETS = [
  { value: "default" as const, label: "Default", detail: "Ask on request with workspace write sandbox." },
  { value: "edit" as const, label: "Edit", detail: "Untrusted approval with workspace write sandbox." },
  { value: "plan" as const, label: "Plan", detail: "Read-only sandbox for planning." },
  { value: "full-auto" as const, label: "Full auto", detail: "No approval prompts with full sandbox access." },
];

export const OPENCODE_PERMISSION_OPTIONS: Array<{ value: AgentChatOpenCodePermissionMode; label: string }> = [
  { value: "plan", label: "Plan" },
  { value: "edit", label: "Edit" },
  { value: "full-auto", label: "Full auto" },
  { value: "config-toml", label: "Config" },
];

export const DROID_PERMISSION_OPTIONS: Array<{ value: AgentChatDroidPermissionMode; label: string; detail: string }> = [
  { value: "read-only", label: "Read-only", detail: "No auto flag. Droid stays in read-only mode." },
  { value: "auto-low", label: "Auto low", detail: "Passes --auto low for safe file edits." },
  { value: "auto-medium", label: "Auto medium", detail: "Passes --auto medium for local development operations." },
  { value: "auto-high", label: "Auto high", detail: "Passes --auto high for broader automation." },
];

export function claudeSelectionMode(controls: NativeControlState): AgentChatClaudePermissionMode {
  return controls.interactionMode === "plan" ? "plan" : controls.claudePermissionMode;
}

export function applyClaudePermissionSelection(
  mode: AgentChatClaudePermissionMode,
  current: NativeControlState,
): NativeControlState {
  if (mode === "plan") {
    return { ...current, interactionMode: "plan", claudePermissionMode: "plan" };
  }
  return { ...current, interactionMode: "default", claudePermissionMode: mode };
}

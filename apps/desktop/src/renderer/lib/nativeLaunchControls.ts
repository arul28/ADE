import type {
  AgentChatClaudePermissionMode,
  AgentChatOpenCodePermissionMode,
  AgentChatPermissionMode,
  AgentChatProvider,
} from "../../shared/types";
import {
  AGENT_CHAT_DROID_PERMISSION_MODE_OPTIONS,
  AGENT_CHAT_MUSE_PERMISSION_MODE_DETAILS,
  AGENT_CHAT_MUSE_PERMISSION_MODE_VALUES,
  DEFAULT_MUSE_PERMISSION_MODE,
  droidPermissionModeFromLegacyPermissionMode,
  legacyPermissionModeFromDroidPermissionMode,
  type AgentChatMusePermissionMode,
} from "../../shared/types/chat";
import {
  legacyPermissionModeFromMusePermissionMode,
  musePermissionModeFromLegacyPermissionMode,
} from "../../shared/modelPermissions";
import {
  CURSOR_AVAILABLE_MODE_IDS,
  formatCursorModeLabel,
  legacyPermissionModeToCursorModeId,
} from "../../shared/cursorModes";
import {
  getModelById,
  resolveProviderGroupForModel,
  type ModelDescriptor,
} from "../../shared/modelRegistry";
import type { NativeControlState } from "./draftLaunchJobs";
import { resolveModelDescriptorWithRuntimeCatalog } from "../components/shared/ModelPicker/modelCatalog";

type ChatRuntimeProviderKey =
  | "claude"
  | "codex"
  | "muse"
  | "cursor"
  | "droid"
  | "opencode"
  | "pi"
  | "qwen"
  | "kimi"
  | "grok"
  | "copilot"
  | "devin"
  | "antigravity";
type CliProvider = ChatRuntimeProviderKey;

/**
 * What a new chat starts on when nothing is remembered for its lane: every
 * provider's most permissive mode (Claude bypass, Codex never-ask with full
 * access, Droid auto-high, Copilot/OpenCode/Pi/ACP full-auto, Muse allow-all,
 * Cursor full-auto). That is how almost everyone runs agents in ADE, so the
 * default says so; the composer's picker still offers every narrower level,
 * and a lane's last choice still wins over this.
 */
export function defaultNativeControls(): NativeControlState {
  return {
    interactionMode: "default",
    claudePermissionMode: "bypassPermissions",
    codexApprovalPolicy: "never",
    codexSandbox: "danger-full-access",
    codexConfigSource: "flags",
    opencodePermissionMode: "full-auto",
    droidPermissionMode: "auto-high",
    copilotPermissionMode: "full-auto",
    musePermissionMode: "allowAll",
    cursorModeId: "full-auto",
    cursorConfigValues: {},
  };
}

/**
 * Ask before changing anything, on every provider. Only for launches whose
 * own copy promises that (the Settings health fixes, the project-move check);
 * every other chat starts on `defaultNativeControls`.
 */
export function askFirstNativeControls(): NativeControlState {
  return {
    interactionMode: "default",
    claudePermissionMode: "default",
    codexApprovalPolicy: "on-request",
    codexSandbox: "workspace-write",
    codexConfigSource: "flags",
    opencodePermissionMode: "edit",
    droidPermissionMode: "auto-low",
    musePermissionMode: DEFAULT_MUSE_PERMISSION_MODE,
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
  | "copilotPermissionMode"
  | "copilotContextTier"
  | "copilotAutoTier"
  | "musePermissionMode"
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
      permissionMode: legacyPermissionModeFromDroidPermissionMode(controls.droidPermissionMode),
    };
  }
  if (provider === "muse") {
    // Plan mode is `denyUnmatched` plus ADE's plan guidance, so a chat in plan
    // reports `plan` whatever its stored approval mode is.
    return {
      interactionMode: controls.interactionMode,
      musePermissionMode: controls.musePermissionMode,
      permissionMode: controls.interactionMode === "plan"
        ? "plan"
        : legacyPermissionModeFromMusePermissionMode(controls.musePermissionMode),
    };
  }
  if (provider === "copilot") {
    const copilotMode = controls.copilotPermissionMode ?? "ask";
    return {
      copilotPermissionMode: copilotMode,
      permissionMode: copilotMode === "plan" ? "plan"
        : copilotMode === "full-auto" ? "full-auto"
          : copilotMode === "auto-edit" || copilotMode === "assisted" ? "edit"
            : "default",
      copilotContextTier: controls.copilotContextTier ?? "default",
      copilotAutoTier: controls.copilotAutoTier ?? null,
    };
  }
  // Pi's native permission field IS `permissionMode` — it has no provider
  // sibling, and the main process deletes `opencodePermissionMode` from a Pi
  // session. Falling through to the OpenCode tail therefore reported whatever
  // that absent field defaulted to, and writing it back silently downgraded a
  // full-auto Pi chat to edit on the first composer interaction.
  if (provider === "pi") {
    return { permissionMode: controls.opencodePermissionMode };
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
    const cursorModeId = legacyPermissionModeToCursorModeId(mode) ?? "agent";
    return { ...next, cursorModeId };
  }

  if (provider === "droid") {
    const droidPermissionMode = droidPermissionModeFromLegacyPermissionMode(mode) ?? "auto-high";
    return { ...next, droidPermissionMode };
  }

  if (provider === "copilot") {
    const copilotPermissionMode: NonNullable<NativeControlState["copilotPermissionMode"]> =
      mode === "plan" ? "plan" : mode === "edit" ? "auto-edit" : mode === "full-auto" ? "full-auto" : "ask";
    return { ...next, copilotPermissionMode };
  }

  if (provider === "muse") {
    const musePermissionMode = musePermissionModeFromLegacyPermissionMode(mode) ?? DEFAULT_MUSE_PERMISSION_MODE;
    return { ...next, interactionMode: mode === "plan" ? "plan" : "default", musePermissionMode };
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
  return formatCursorModeLabel(modeId);
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

export const DROID_PERMISSION_OPTIONS = AGENT_CHAT_DROID_PERMISSION_MODE_OPTIONS;

export const MUSE_PERMISSION_OPTIONS: Array<{ value: AgentChatMusePermissionMode; label: string; detail: string }> =
  AGENT_CHAT_MUSE_PERMISSION_MODE_VALUES.map((value) => ({ value, ...AGENT_CHAT_MUSE_PERMISSION_MODE_DETAILS[value] }));

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

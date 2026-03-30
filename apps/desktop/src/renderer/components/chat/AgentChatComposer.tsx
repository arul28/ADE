import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { At, Image, Paperclip, Square, X, PaperPlaneTilt, Cube, BookOpen } from "@phosphor-icons/react";
import {
  inferAttachmentType,
  type AgentChatApprovalDecision,
  type AgentChatClaudePermissionMode,
  type AgentChatCodexApprovalPolicy,
  type AgentChatCodexConfigSource,
  type AgentChatCodexSandbox,
  type AgentChatExecutionMode,
  type AgentChatFileRef,
  type AgentChatInteractionMode,
  type AgentChatSlashCommand,
  type AgentChatUnifiedPermissionMode,
  type ComputerUseOwnerSnapshot,
  type ChatSurfaceMode,
  type ComputerUsePolicy,
  type PendingInputRequest,
} from "../../../shared/types";
import { getModelById } from "../../../shared/modelRegistry";
import { cn } from "../ui/cn";
import { UnifiedModelSelector } from "../shared/UnifiedModelSelector";
import { getPermissionOptions, safetyColors } from "../shared/permissionOptions";
import { ChatAttachmentTray } from "./ChatAttachmentTray";
import { ChatComposerShell } from "./ChatComposerShell";
import { ChatStatusGlyph } from "./chatStatusVisuals";
import { ChatSubagentStrip } from "./ChatSubagentStrip";
import type { ChatSubagentSnapshot } from "./chatExecutionSummary";

const MAX_TEMP_ATTACHMENT_BYTES = 10 * 1024 * 1024;

type ExecutionModeOption = {
  value: AgentChatExecutionMode;
  label: string;
  summary: string;
  helper: string;
  accent: string;
};

type SlashCommandEntry = {
  command: string;
  label: string;
  description: string;
  argumentHint?: string;
  source: "sdk" | "local";
};

/** Local-only commands that are always available regardless of provider. */
const LOCAL_SLASH_COMMANDS: SlashCommandEntry[] = [
  { command: "/clear", label: "Clear", description: "Clear chat history", source: "local" },
];

/** Well-known defaults shown before the SDK session is initialized. */
const CLAUDE_DEFAULT_COMMANDS: SlashCommandEntry[] = [];

const CODEX_DEFAULT_COMMANDS: SlashCommandEntry[] = [
  { command: "/review", label: "Review", description: "Review uncommitted changes", source: "sdk" },
  { command: "/help", label: "Help", description: "Show available commands", source: "sdk" },
];

const DEFAULT_COMMANDS_BY_FAMILY: Record<string, SlashCommandEntry[]> = {
  anthropic: CLAUDE_DEFAULT_COMMANDS,
  openai: CODEX_DEFAULT_COMMANDS,
};

/** Build the effective slash command list by merging SDK-provided commands with local ones. */
function buildSlashCommands(sdkCommands: AgentChatSlashCommand[], modelFamily?: string): SlashCommandEntry[] {
  const result: SlashCommandEntry[] = [];
  const seen = new Set<string>();

  // SDK commands first -- they take priority
  for (const cmd of sdkCommands) {
    const name = cmd.name.startsWith("/") ? cmd.name : `/${cmd.name}`;
    if (seen.has(name)) continue;
    seen.add(name);
    result.push({
      command: name,
      label: name.slice(1).charAt(0).toUpperCase() + name.slice(2),
      description: cmd.description || `Run ${name}`,
      argumentHint: cmd.argumentHint,
      source: cmd.source,
    });
  }

  // If no SDK commands loaded yet, show well-known defaults for the provider
  if (sdkCommands.length === 0) {
    const defaults = (modelFamily ? DEFAULT_COMMANDS_BY_FAMILY[modelFamily] : undefined) ?? [];
    for (const cmd of defaults) {
      if (!seen.has(cmd.command)) {
        seen.add(cmd.command);
        result.push(cmd);
      }
    }
  }

  // Local commands that aren't already provided by SDK
  for (const cmd of LOCAL_SLASH_COMMANDS) {
    if (!seen.has(cmd.command)) {
      result.push(cmd);
    }
  }

  return result;
}

const CLAUDE_MODE_OPTIONS: Array<{ value: AgentChatClaudePermissionMode; label: string; detail: string; safety: "safe" | "semi-auto" | "danger" }> = [
  { value: "default", label: "Default", detail: "Claude uses the normal approval flow for reads, edits, and tools.", safety: "safe" },
  { value: "plan", label: "Plan", detail: "Read-only Claude turns for analysis and implementation planning.", safety: "safe" },
  { value: "acceptEdits", label: "Accept edits", detail: "File edits are auto-approved; higher-risk actions still prompt.", safety: "semi-auto" },
  { value: "bypassPermissions", label: "Bypass", detail: "Skip Claude permission prompts for this chat.", safety: "danger" },
];

type CodexPermissionPreset = "plan" | "edit" | "full-auto" | "custom";

function resolveCodexPermissionPreset(args: {
  codexApprovalPolicy?: AgentChatCodexApprovalPolicy;
  codexSandbox?: AgentChatCodexSandbox;
  codexConfigSource?: AgentChatCodexConfigSource;
}): CodexPermissionPreset {
  if (args.codexConfigSource === "config-toml") return "custom";
  if (args.codexApprovalPolicy === "untrusted" && args.codexSandbox === "read-only") return "plan";
  if (args.codexApprovalPolicy === "on-failure" && args.codexSandbox === "workspace-write") return "edit";
  if (args.codexApprovalPolicy === "never" && args.codexSandbox === "danger-full-access") return "full-auto";
  return "custom";
}

const UNIFIED_PERMISSION_OPTIONS: Array<{ value: AgentChatUnifiedPermissionMode; label: string }> = [
  { value: "plan", label: "Plan" },
  { value: "edit", label: "Edit" },
  { value: "full-auto", label: "Full auto" },
];



export function AgentChatComposer({
  surfaceMode = "standard",
  sdkSlashCommands = [],
  modelId,
  availableModelIds,
  reasoningEffort,
  draft,
  attachments,
  pendingInput,
  turnActive,
  sendOnEnter,
  busy,
  sessionProvider,
  interactionMode,
  claudePermissionMode,
  codexApprovalPolicy,
  codexSandbox,
  codexConfigSource,
  unifiedPermissionMode,
  executionMode,
  computerUsePolicy,
  computerUseSnapshot,
  proofOpen = false,
  proofArtifactCount = 0,
  executionModeOptions = [],
  modelSelectionLocked = false,
  permissionModeLocked = false,
  messagePlaceholder,
  onModelChange,
  onReasoningEffortChange,
  onDraftChange,
  onClearDraft,
  onSubmit,
  onInterrupt,
  onApproval,
  onAddAttachment,
  onRemoveAttachment,
  onSearchAttachments,
  onExecutionModeChange,
  onInteractionModeChange,
  onClaudeModeChange,
  onClaudePermissionModeChange,
  onCodexPresetChange,
  onCodexApprovalPolicyChange,
  onCodexSandboxChange,
  onCodexConfigSourceChange,
  onUnifiedPermissionModeChange,
  includeProjectDocs,
  onIncludeProjectDocsChange,
  onComputerUsePolicyChange,
  onToggleProof,
  onClearEvents,
  promptSuggestion,
  subagentSnapshots = [],
  chatHasMessages = false,
}: {
  surfaceMode?: ChatSurfaceMode;
  sdkSlashCommands?: AgentChatSlashCommand[];
  modelId: string;
  availableModelIds?: string[];
  reasoningEffort: string | null;
  draft: string;
  attachments: AgentChatFileRef[];
  pendingInput: PendingInputRequest | null;
  turnActive: boolean;
  sendOnEnter: boolean;
  busy: boolean;
  sessionProvider?: string;
  interactionMode?: AgentChatInteractionMode | null;
  claudePermissionMode?: AgentChatClaudePermissionMode;
  codexApprovalPolicy?: AgentChatCodexApprovalPolicy;
  codexSandbox?: AgentChatCodexSandbox;
  codexConfigSource?: AgentChatCodexConfigSource;
  unifiedPermissionMode?: AgentChatUnifiedPermissionMode;
  executionMode?: AgentChatExecutionMode | null;
  computerUsePolicy: ComputerUsePolicy;
  computerUseSnapshot?: ComputerUseOwnerSnapshot | null;
  proofOpen?: boolean;
  proofArtifactCount?: number;
  executionModeOptions?: ExecutionModeOption[];
  modelSelectionLocked?: boolean;
  permissionModeLocked?: boolean;
  messagePlaceholder?: string;
  onModelChange: (modelId: string) => void;
  onReasoningEffortChange: (reasoningEffort: string | null) => void;
  onDraftChange: (value: string) => void;
  onClearDraft?: () => void;
  onSubmit: () => void;
  onInterrupt: () => void;
  onApproval: (decision: AgentChatApprovalDecision) => void;
  onAddAttachment: (attachment: AgentChatFileRef) => void;
  onRemoveAttachment: (path: string) => void;
  onSearchAttachments: (query: string) => Promise<AgentChatFileRef[]>;
  onExecutionModeChange?: (mode: AgentChatExecutionMode) => void;
  onInteractionModeChange?: (mode: AgentChatInteractionMode) => void;
  onClaudeModeChange?: (mode: AgentChatClaudePermissionMode) => void;
  onClaudePermissionModeChange?: (mode: AgentChatClaudePermissionMode) => void;
  onCodexPresetChange?: (next: {
    codexApprovalPolicy: AgentChatCodexApprovalPolicy;
    codexSandbox: AgentChatCodexSandbox;
    codexConfigSource: AgentChatCodexConfigSource;
  }) => void;
  onCodexApprovalPolicyChange?: (policy: AgentChatCodexApprovalPolicy) => void;
  onCodexSandboxChange?: (sandbox: AgentChatCodexSandbox) => void;
  onCodexConfigSourceChange?: (source: AgentChatCodexConfigSource) => void;
  onUnifiedPermissionModeChange?: (mode: AgentChatUnifiedPermissionMode) => void;
  includeProjectDocs?: boolean;
  onIncludeProjectDocsChange?: (checked: boolean) => void;
  onComputerUsePolicyChange: (policy: ComputerUsePolicy) => void;
  onToggleProof?: () => void;
  onClearEvents?: () => void;
  promptSuggestion?: string | null;
  subagentSnapshots?: ChatSubagentSnapshot[];
  chatHasMessages?: boolean;
}) {
  const [attachmentPickerOpen, setAttachmentPickerOpen] = useState(false);
  const [attachmentQuery, setAttachmentQuery] = useState("");
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [attachmentResults, setAttachmentResults] = useState<AgentChatFileRef[]>([]);
  const [attachmentCursor, setAttachmentCursor] = useState(0);
  const [attachError, setAttachError] = useState<string | null>(null);

  const [slashPickerOpen, setSlashPickerOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashCursor, setSlashCursor] = useState(0);
  const [hoveredClaudeMode, setHoveredClaudeMode] = useState<AgentChatClaudePermissionMode | null>(null);
  const [hoveredCodexPreset, setHoveredCodexPreset] = useState<"plan" | "edit" | "full-auto" | null>(null);

  const [dragActive, setDragActive] = useState(false);

  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileAddInProgressRef = useRef(false);
  const canAttach = !turnActive;

  const attachedPaths = useMemo(() => new Set(attachments.map((a) => a.path)), [attachments]);
  const selectedModel = useMemo(() => getModelById(modelId), [modelId]);

  const effectiveSlashCommands = useMemo(
    () => buildSlashCommands(sdkSlashCommands, selectedModel?.family),
    [sdkSlashCommands, selectedModel?.family],
  );

  const filteredSlashCommands = useMemo(() => {
    if (!slashQuery.length) return effectiveSlashCommands;
    const q = slashQuery.toLowerCase();
    return effectiveSlashCommands.filter(
      (cmd) =>
        cmd.command.toLowerCase().includes(q) ||
        cmd.label.toLowerCase().includes(q) ||
        cmd.description.toLowerCase().includes(q)
    );
  }, [slashQuery, effectiveSlashCommands]);

  /* ── Attachment picker effects ── */
  useEffect(() => {
    if (!attachmentPickerOpen) {
      setAttachmentBusy(false);
      setAttachmentQuery("");
      setAttachmentResults([]);
      setAttachmentCursor(0);
      return;
    }
    const timeout = window.setTimeout(() => attachmentInputRef.current?.focus(), 0);
    return () => window.clearTimeout(timeout);
  }, [attachmentPickerOpen]);

  useEffect(() => {
    if (!attachmentPickerOpen) return;
    const query = attachmentQuery.trim();
    if (!query.length) {
      setAttachmentBusy(false);
      setAttachmentResults([]);
      setAttachmentCursor(0);
      return;
    }
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      setAttachmentBusy(true);
      onSearchAttachments(query)
        .then((results) => {
          if (cancelled) return;
          setAttachmentResults(results.filter((r) => !attachedPaths.has(r.path)));
          setAttachmentCursor(0);
        })
        .catch(() => { if (!cancelled) setAttachmentResults([]); })
        .finally(() => { if (!cancelled) setAttachmentBusy(false); });
    }, 120);
    return () => { cancelled = true; window.clearTimeout(timeout); };
  }, [attachmentPickerOpen, attachmentQuery, attachedPaths, onSearchAttachments]);

  const selectAttachment = (attachment: AgentChatFileRef) => {
    setAttachError(null);
    onAddAttachment(attachment);
    setAttachmentPickerOpen(false);
  };

  const addFileAttachments = async (files: FileList | null | undefined) => {
    if (!canAttach || !files?.length) return;
    if (fileAddInProgressRef.current) return;
    fileAddInProgressRef.current = true;
    setAttachError(null);
    try {
      for (const file of Array.from(files)) {
        const fileWithPath = file as File & { path?: string };
        const hasRealPath = typeof fileWithPath.path === "string" && fileWithPath.path.trim().length > 0;

        if (hasRealPath) {
          const filePath = fileWithPath.path!;
          onAddAttachment({ path: filePath, type: inferAttachmentType(filePath, file.type) });
          continue;
        }

        if (file.size > MAX_TEMP_ATTACHMENT_BYTES) {
          setAttachError(
            `File "${file.name || "clipboard"}" is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum allowed size is 10 MB.`,
          );
          continue;
        }

        try {
          const buf = await file.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let binary = "";
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          const base64 = btoa(binary);
          const { path: tempPath } = await window.ade.agentChat.saveTempAttachment({
            data: base64,
            filename: file.name || "clipboard.png",
          });
          onAddAttachment({ path: tempPath, type: inferAttachmentType(tempPath, file.type) });
        } catch {
          setAttachError(`Unable to attach "${file.name || "clipboard"}".`);
        }
      }
    } finally {
      fileAddInProgressRef.current = false;
    }
  };

  const handleSlashSelect = (cmd: SlashCommandEntry) => {
    setSlashPickerOpen(false);
    setSlashQuery("");
    // Local-only commands handled client-side
    if (cmd.command === "/clear" && onClearEvents) { onClearEvents(); onDraftChange(""); return; }
    // SDK and all other commands: set as draft text to be sent to the agent
    const hint = cmd.argumentHint ? ` ` : " ";
    onDraftChange(`${cmd.command}${hint}`);
  };

  const nativeControlsDisabled = permissionModeLocked;
  const claudeSelectionMode = claudePermissionMode === "plan" || interactionMode === "plan"
    ? "plan"
    : claudePermissionMode ?? "default";
  const codexPreset = resolveCodexPermissionPreset({
    codexApprovalPolicy,
    codexSandbox,
    codexConfigSource,
  });
  const codexPresetOptions = useMemo(
    () => getPermissionOptions({ family: "openai", isCliWrapped: true })
      .filter((option) => option.value === "plan" || option.value === "edit" || option.value === "full-auto"),
    [],
  );
  const applyCodexPreset = useCallback((preset: Exclude<CodexPermissionPreset, "custom">) => {
    const next = preset === "plan"
      ? {
          codexApprovalPolicy: "untrusted" as const,
          codexSandbox: "read-only" as const,
          codexConfigSource: "flags" as const,
        }
      : preset === "edit"
        ? {
            codexApprovalPolicy: "on-failure" as const,
            codexSandbox: "workspace-write" as const,
            codexConfigSource: "flags" as const,
          }
        : {
            codexApprovalPolicy: "never" as const,
            codexSandbox: "danger-full-access" as const,
            codexConfigSource: "flags" as const,
          };

    if (onCodexPresetChange) {
      onCodexPresetChange(next);
      return;
    }
    onCodexConfigSourceChange?.(next.codexConfigSource);
    onCodexApprovalPolicyChange?.(next.codexApprovalPolicy);
    onCodexSandboxChange?.(next.codexSandbox);
  }, [
    onCodexApprovalPolicyChange,
    onCodexConfigSourceChange,
    onCodexPresetChange,
    onCodexSandboxChange,
  ]);
  const claudeControlDetail = useMemo(() => {
    if (sessionProvider !== "claude") return null;
    const option = CLAUDE_MODE_OPTIONS.find((item) => item.value === (hoveredClaudeMode ?? claudeSelectionMode));
    return option?.detail ?? null;
  }, [claudeSelectionMode, hoveredClaudeMode, sessionProvider]);
  const codexCustomSummary = useMemo(() => {
    if (sessionProvider !== "codex" || codexPreset !== "custom") return null;
    if (codexConfigSource === "config-toml") {
      return "Custom Codex mode: config.toml controls approval and sandbox.";
    }
    const approvalLabel = {
      "untrusted": "Plan",
      "on-request": "On request",
      "on-failure": "Guarded edit",
      "never": "Full auto",
    }[codexApprovalPolicy ?? "on-request"];
    const sandboxLabel = {
      "read-only": "Read only",
      "workspace-write": "Workspace write",
      "danger-full-access": "Danger full access",
    }[codexSandbox ?? "workspace-write"];
    return `Custom Codex mode: ${codexConfigSource === "flags" ? "ADE flags" : "config.toml"} · ${approvalLabel} · ${sandboxLabel}`;
  }, [codexApprovalPolicy, codexConfigSource, codexPreset, codexSandbox, sessionProvider]);
  const codexControlDetail = useMemo(() => {
    if (sessionProvider !== "codex") return null;
    if (hoveredCodexPreset) {
      return codexPresetOptions.find((option) => option.value === hoveredCodexPreset)?.detail ?? null;
    }
    if (codexPreset === "custom") {
      return codexCustomSummary;
    }
    return codexPresetOptions.find((option) => option.value === codexPreset)?.detail ?? null;
  }, [codexCustomSummary, codexPreset, codexPresetOptions, hoveredCodexPreset, sessionProvider]);
  const nativeControlPanel = useMemo(() => {
    const renderButtonGroup = <T extends string,>(
      label: string,
      value: T | undefined,
      options: Array<{ value: T; label: string; detail: string; safety?: "safe" | "semi-auto" | "danger" }>,
      onChange: ((value: T) => void) | undefined,
      disabled = false,
      onHoverChange?: (value: T | null) => void,
    ) => (
      <div className="flex items-center gap-2 rounded-md border border-white/[0.06] bg-[#1a1a22] px-2.5 py-1.5">
        <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted-fg/45">{label}</span>
        <div className="flex items-center gap-px rounded-md border border-white/[0.06] bg-[#14141b] p-0.5">
          {options.map((option) => {
            const active = value === option.value;
            const colors = option.safety ? safetyColors(option.safety) : null;
            return (
              <button
                key={option.value}
                type="button"
                className={cn(
                  "rounded-[8px] px-2.5 py-1.5 font-mono text-[9px] font-bold uppercase tracking-wider transition-colors",
                  active
                    ? (colors ? `${colors.activeBg} text-fg/80` : "bg-white/[0.08] text-fg/80")
                    : "text-muted-fg/35 hover:text-muted-fg/60",
                  disabled ? "cursor-not-allowed opacity-50" : "",
                )}
                disabled={disabled || !onChange}
                onClick={() => onChange?.(option.value)}
                onMouseEnter={() => onHoverChange?.(option.value)}
                onMouseLeave={() => onHoverChange?.(null)}
                onFocus={() => onHoverChange?.(option.value)}
                onBlur={() => onHoverChange?.(null)}
                title={option.detail}
                aria-pressed={active}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>
    );

    if (sessionProvider === "claude") {
      return (
        <div className="flex flex-wrap items-start gap-2">
          {renderButtonGroup("Claude", claudeSelectionMode, CLAUDE_MODE_OPTIONS, (mode) => {
            if (onClaudeModeChange) {
              onClaudeModeChange(mode);
              return;
            }
            if (mode === "plan") {
              onInteractionModeChange?.("plan");
              onClaudePermissionModeChange?.("plan");
              return;
            }
            onInteractionModeChange?.("default");
            onClaudePermissionModeChange?.(mode);
          }, nativeControlsDisabled, setHoveredClaudeMode)}
        </div>
      );
    }

    if (sessionProvider === "codex") {
      return (
        <div className="flex flex-wrap items-start gap-2">
          <div className="flex items-center gap-px rounded-md border border-white/[0.06] bg-[#1a1a22] p-0.5">
            {codexPresetOptions.map((option) => {
              const active = codexPreset === option.value;
              const colors = safetyColors(option.safety);
              return (
                <button
                  key={option.value}
                  type="button"
                  className={cn(
                    "rounded-[8px] px-2.5 py-1.5 font-mono text-[9px] font-bold uppercase tracking-wider transition-colors",
                    active ? `${colors.activeBg} text-fg/80` : "text-muted-fg/35 hover:text-muted-fg/60",
                    nativeControlsDisabled ? "cursor-not-allowed opacity-50" : "",
                  )}
                  disabled={nativeControlsDisabled}
                  onClick={() => applyCodexPreset(option.value as Exclude<CodexPermissionPreset, "custom">)}
                  onMouseEnter={() => setHoveredCodexPreset(option.value as Exclude<CodexPermissionPreset, "custom">)}
                  onMouseLeave={() => setHoveredCodexPreset(null)}
                  onFocus={() => setHoveredCodexPreset(option.value as Exclude<CodexPermissionPreset, "custom">)}
                  onBlur={() => setHoveredCodexPreset(null)}
                  title={option.detail}
                  aria-pressed={active}
                >
                  {option.label}
                </button>
              );
            })}
            <div
              className={cn(
                "rounded-[8px] px-2.5 py-1.5 font-mono text-[9px] font-bold uppercase tracking-wider",
                codexPreset === "custom" ? "bg-white/[0.06] text-fg/80" : "text-muted-fg/35",
              )}
              title={codexCustomSummary ?? "Custom Codex approval/sandbox combination"}
            >
              Custom
            </div>
          </div>
        </div>
      );
    }

    return (
      <label className="flex items-center gap-2 rounded-md border border-white/[0.06] bg-[#1a1a22] px-2.5 py-1.5">
        <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted-fg/45">ADE</span>
        <select
          value={unifiedPermissionMode}
          disabled={nativeControlsDisabled || !onUnifiedPermissionModeChange}
          onChange={(event) => onUnifiedPermissionModeChange?.(event.target.value as AgentChatUnifiedPermissionMode)}
          className="min-w-0 bg-transparent font-sans text-[11px] text-fg/82 outline-none disabled:cursor-not-allowed disabled:text-muted-fg/35"
        >
          {UNIFIED_PERMISSION_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }, [
    claudeSelectionMode,
    claudePermissionMode,
    applyCodexPreset,
    codexPreset,
    codexPresetOptions,
    codexCustomSummary,
    codexConfigSource,
    hoveredClaudeMode,
    hoveredCodexPreset,
    nativeControlsDisabled,
    onClaudeModeChange,
    onClaudePermissionModeChange,
    onInteractionModeChange,
    onUnifiedPermissionModeChange,
    sessionProvider,
    unifiedPermissionMode,
  ]);
  /* ── Keyboard handler for textarea ── */
  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const commandModified = event.metaKey || event.ctrlKey;

    /* Slash picker keyboard */
    if (slashPickerOpen) {
      if (event.key === "Escape") { event.preventDefault(); setSlashPickerOpen(false); setSlashQuery(""); return; }
      if (event.key === "ArrowDown") { event.preventDefault(); setSlashCursor((v) => Math.min(v + 1, Math.max(filteredSlashCommands.length - 1, 0))); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); setSlashCursor((v) => Math.max(v - 1, 0)); return; }
      if (event.key === "Enter" || event.key === "Tab") {
        const cmd = filteredSlashCommands[slashCursor];
        if (cmd) { event.preventDefault(); handleSlashSelect(cmd); return; }
      }
    }

    /* Trigger pickers — let "/" be typed so onChange can filter */
    if (event.key === "/" && draft.length === 0 && !commandModified && !event.altKey) {
      setSlashPickerOpen(true);
      setSlashQuery("");
      setSlashCursor(0);
      // Don't preventDefault — the "/" will appear in the textarea and onChange will
      // see val.startsWith("/"), keeping the picker open and enabling type-to-filter.
    }
    if (event.key === "@" && !commandModified && !event.altKey) {
      if (!canAttach) return;
      event.preventDefault();
      setAttachmentPickerOpen(true);
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      if (attachmentPickerOpen) { setAttachmentPickerOpen(false); return; }
      if (pendingInput) { onApproval("cancel"); return; }
      if (draft.length) { onDraftChange(""); }
      return;
    }

    if (event.key === "." && commandModified && turnActive) { event.preventDefault(); onInterrupt(); return; }

    /* Tab to accept prompt suggestion */
    if (event.key === "Tab" && !event.shiftKey && !commandModified && promptSuggestion && !draft.length && !turnActive) {
      event.preventDefault();
      onDraftChange(promptSuggestion);
      return;
    }

    if (event.key !== "Enter" || event.shiftKey) return;
    const commandEnter = commandModified;
    const shouldSend = sendOnEnter ? !commandEnter : commandEnter;
    if (!shouldSend) return;
    event.preventDefault();
    if (busy || !modelId || !draft.trim().length) return;
    onSubmit();
  };

  const openUploadPicker = () => {
    if (!canAttach) return;
    uploadInputRef.current?.click();
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!canAttach || !event.clipboardData.files.length) return;
    event.preventDefault();
    void addFileAttachments(event.clipboardData.files);
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!canAttach || !event.dataTransfer.files.length) return;
    event.preventDefault();
    setDragActive(true);
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragActive(false);
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!canAttach || !event.dataTransfer.files.length) return;
    event.preventDefault();
    setDragActive(false);
    void addFileAttachments(event.dataTransfer.files);
  };

  return (
    <>
      <ChatComposerShell
      mode={surfaceMode}
      className="m-3 mt-0 rounded-[var(--chat-radius-shell)]"
      pendingBanner={pendingInput ? (
        pendingInput.kind === "plan_approval" ? (
          <div className="px-4 py-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-[var(--chat-radius-pill)] border border-violet-400/20 bg-violet-500/10">
                <ChatStatusGlyph status="waiting" size={11} />
              </span>
              <span className="font-mono text-[9px] font-bold uppercase tracking-widest text-violet-200">
                Plan Approval · {pendingInput.source}
              </span>
            </div>
            <div className="mb-2 max-h-48 overflow-y-auto font-mono text-[11px] leading-relaxed text-fg/68 whitespace-pre-wrap">
              {pendingInput.description ?? pendingInput.questions[0]?.question ?? "The agent has prepared a plan."}
            </div>
            <div className="flex items-center gap-1.5">
              <button type="button" className="rounded-[var(--chat-radius-pill)] border border-emerald-400/30 bg-emerald-500/12 px-3 py-1 font-mono text-[9px] font-bold uppercase tracking-wider text-emerald-200/80 transition-colors hover:bg-emerald-500/20" onClick={() => onApproval("accept")}>Approve &amp; Implement</button>
              <button type="button" className="rounded-[var(--chat-radius-pill)] border border-border/20 px-3 py-1 font-mono text-[9px] font-bold uppercase tracking-wider text-fg/40 transition-colors hover:bg-border/10" onClick={() => onApproval("decline")}>Reject &amp; Revise</button>
            </div>
          </div>
        ) : (
          <div className="px-4 py-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-[var(--chat-radius-pill)] border border-amber-400/20 bg-amber-500/10">
                <ChatStatusGlyph status="waiting" size={11} />
              </span>
              <span className="font-mono text-[9px] font-bold uppercase tracking-widest text-amber-200">
                {pendingInput.kind === "approval" || pendingInput.kind === "permissions" ? "Approval" : "Input needed"} · {pendingInput.source}
              </span>
            </div>
            <div className="mb-2 font-mono text-[11px] leading-relaxed text-fg/68">
              {pendingInput.description ?? pendingInput.questions[0]?.question ?? "The agent is waiting for input."}
            </div>
            {pendingInput.kind === "approval" || pendingInput.kind === "permissions" ? (
              <div className="flex items-center gap-1.5">
                <button type="button" className="rounded-[var(--chat-radius-pill)] border border-accent/30 bg-accent/12 px-3 py-1 font-mono text-[9px] font-bold uppercase tracking-wider text-fg/80 transition-colors hover:bg-accent/20" onClick={() => onApproval("accept")}>Accept</button>
                <button type="button" className="rounded-[var(--chat-radius-pill)] border border-border/20 px-3 py-1 font-mono text-[9px] font-bold uppercase tracking-wider text-fg/50 transition-colors hover:bg-border/10" onClick={() => onApproval("accept_for_session")}>Accept all</button>
                <button type="button" className="rounded-[var(--chat-radius-pill)] border border-border/20 px-3 py-1 font-mono text-[9px] font-bold uppercase tracking-wider text-fg/40 transition-colors hover:bg-border/10" onClick={() => onApproval("decline")}>Decline</button>
              </div>
            ) : (
              <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-amber-200/60">
                Open the question modal to answer and continue.
              </div>
            )}
          </div>
        )
      ) : undefined}
      trays={
        attachments.length || subagentSnapshots.length || attachError ? (
          <div className="space-y-2 px-1 py-2">
            {attachError ? (
              <div className="flex items-center gap-1.5 px-3">
                <span className="text-[10px] text-red-300/75">{attachError}</span>
                <button
                  type="button"
                  aria-label="Dismiss error"
                  className="shrink-0 rounded p-0.5 text-red-300/60 hover:text-red-200/80 transition-colors"
                  onClick={() => setAttachError(null)}
                >
                  <X size={10} weight="bold" />
                </button>
              </div>
            ) : null}
            {subagentSnapshots.length ? (
              <ChatSubagentStrip
                snapshots={subagentSnapshots}
                placement="composer"
                onInterruptTurn={turnActive ? onInterrupt : undefined}
              />
            ) : null}
            <ChatAttachmentTray
              attachments={attachments}
              mode={surfaceMode}
              onRemove={onRemoveAttachment}
              className="px-3 py-0"
            />
          </div>
        ) : undefined
      }
      pickerLayer={
        <>
          <input
            ref={uploadInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              void addFileAttachments(event.target.files);
              event.currentTarget.value = "";
            }}
          />
          {slashPickerOpen && filteredSlashCommands.length > 0 ? (
            <div className="absolute bottom-full left-3 z-10 mb-3 w-80 rounded-[var(--chat-radius-card)] border border-white/[0.06] bg-card/95 shadow-[var(--chat-composer-shadow)] backdrop-blur-xl">
              <div className="border-b border-white/[0.04] px-3 py-2 font-mono text-[9px] font-bold uppercase tracking-widest text-muted-fg/35">
                Commands
              </div>
              <div className="max-h-52 overflow-auto py-1">
                {filteredSlashCommands.map((cmd, index) => (
                  <button
                    key={cmd.command}
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-3 px-3 py-2 text-left font-mono text-[10px]",
                      index === slashCursor ? "bg-accent/10 text-fg" : "text-fg/55 hover:bg-border/6",
                    )}
                    onMouseEnter={() => setSlashCursor(index)}
                    onClick={() => handleSlashSelect(cmd)}
                  >
                    <span className="w-16 shrink-0 text-accent/70">{cmd.command}</span>
                    <span className="flex-1 truncate text-fg/45">{cmd.description}</span>
                    {cmd.source === "sdk" ? (
                      <span className="shrink-0 rounded-sm bg-violet-500/10 px-1 py-px text-[8px] text-violet-300/60">sdk</span>
                    ) : null}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {attachmentPickerOpen ? (
            <div className="absolute bottom-full left-3 z-10 mb-3 w-80 rounded-[var(--chat-radius-card)] border border-white/[0.06] bg-card/95 shadow-[var(--chat-composer-shadow)] backdrop-blur-xl">
              <div className="flex items-center gap-2 border-b border-white/[0.04] px-3 py-2">
                <At size={11} weight="bold" className="text-muted-fg/30" />
                <input
                  ref={attachmentInputRef}
                  value={attachmentQuery}
                  onChange={(e) => setAttachmentQuery(e.target.value)}
                  placeholder="Search files..."
                  className="h-5 flex-1 bg-transparent font-mono text-[11px] text-fg/80 outline-none placeholder:text-muted-fg/25"
                  onKeyDown={(event) => {
                    if (event.key === "Escape") { event.preventDefault(); setAttachmentPickerOpen(false); return; }
                    if (event.key === "ArrowDown") { event.preventDefault(); setAttachmentCursor((v) => Math.min(v + 1, Math.max(attachmentResults.length - 1, 0))); return; }
                    if (event.key === "ArrowUp") { event.preventDefault(); setAttachmentCursor((v) => Math.max(v - 1, 0)); return; }
                    if (event.key === "Enter") {
                      const candidate = attachmentResults[attachmentCursor];
                      if (candidate) { event.preventDefault(); selectAttachment(candidate); }
                    }
                  }}
                />
              </div>
              <div className="max-h-40 overflow-auto py-1">
                {!attachmentQuery.trim().length ? (
                  <div className="px-3 py-2 font-mono text-[10px] text-muted-fg/25">Type to search files...</div>
                ) : attachmentBusy ? (
                  <div className="px-3 py-2 font-mono text-[10px] text-muted-fg/25">Searching...</div>
                ) : attachmentResults.length ? (
                  attachmentResults.map((result, index) => (
                    <button
                      key={result.path}
                      type="button"
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-2 text-left font-mono text-[10px] text-fg/60",
                        index === attachmentCursor ? "bg-accent/10 text-fg/85" : "hover:bg-border/6",
                      )}
                      onMouseEnter={() => setAttachmentCursor(index)}
                      onClick={() => selectAttachment(result)}
                    >
                      {result.type === "image" ? <Image size={11} weight="bold" className="text-muted-fg/40" /> : <At size={11} weight="bold" className="text-muted-fg/25" />}
                      <span className="truncate">{result.path}</span>
                    </button>
                  ))
                ) : (
                  <div className="px-3 py-2 font-mono text-[10px] text-muted-fg/25">No matching files.</div>
                )}
              </div>
            </div>
          ) : null}
        </>
      }
      footer={
        <div className="space-y-2 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
              {nativeControlPanel}
            </div>

            <div className="min-w-0 shrink">
              <UnifiedModelSelector
                value={modelId}
                onChange={onModelChange}
                availableModelIds={availableModelIds}
                disabled={modelSelectionLocked}
                showReasoning
                reasoningEffort={reasoningEffort}
                onReasoningEffortChange={onReasoningEffortChange}
              />
            </div>
          </div>
          {claudeControlDetail ? (
            <div className="px-1 text-[10px] leading-5 text-muted-fg/40">
              {claudeControlDetail}
            </div>
          ) : null}
          {codexControlDetail ? (
            <div className="px-1 text-[10px] leading-5 text-muted-fg/40">
              {codexControlDetail}
            </div>
          ) : null}

          <div className="flex items-center gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              <button
                type="button"
                className="rounded-md px-2 py-1 font-sans text-[10px] text-muted-fg/22 transition-colors hover:bg-white/5 hover:text-muted-fg/55"
                disabled={!canAttach}
                onClick={() => canAttach && setAttachmentPickerOpen((o) => !o)}
                title="Attach files or images (@)"
              >
                @
              </button>
              <button
                type="button"
                className="rounded-md px-1.5 py-1 text-muted-fg/22 transition-colors hover:bg-white/5 hover:text-muted-fg/55"
                disabled={!canAttach}
                onClick={openUploadPicker}
                title="Upload file from disk"
              >
                <Paperclip size={12} />
              </button>
              <button
                type="button"
                className="rounded-md px-2 py-1 font-sans text-[10px] text-muted-fg/22 transition-colors hover:bg-white/5 hover:text-muted-fg/55"
                onClick={() => { const d = textareaRef.current?.value ?? ""; if (!d.length) { onDraftChange("/"); } setSlashPickerOpen(true); setSlashQuery(d.startsWith("/") ? d.slice(1) : ""); setSlashCursor(0); textareaRef.current?.focus(); }}
                title="Commands (/)"
              >
                /
              </button>
            </div>

            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              {/* Proof drawer toggle */}
              {onToggleProof ? (
                <button
                  type="button"
                  className={cn(
                    "relative inline-flex h-7 items-center gap-1 rounded-md border px-2 font-sans text-[10px] font-medium transition-colors",
                    proofOpen
                      ? "border-emerald-400/22 bg-emerald-500/10 text-emerald-200/80"
                      : "border-white/[0.06] bg-white/[0.02] text-muted-fg/40 hover:border-white/[0.12] hover:text-fg/68",
                  )}
                  onClick={onToggleProof}
                  title={proofOpen ? "Close proof drawer" : "Open proof drawer"}
                  aria-pressed={proofOpen}
                >
                  <Cube size={12} weight={proofOpen ? "fill" : "regular"} />
                  {proofArtifactCount > 0 ? (
                    <span className="inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-emerald-500/20 px-1 font-mono text-[8px] font-bold text-emerald-200/90">
                      {proofArtifactCount}
                    </span>
                  ) : null}
                </button>
              ) : null}

              {/* Include context toggle -- only before first message */}
              {!chatHasMessages && onIncludeProjectDocsChange ? (
                <button
                  type="button"
                  className={cn(
                    "inline-flex h-7 items-center gap-1 rounded-md border px-2 font-sans text-[10px] font-medium transition-colors",
                    includeProjectDocs
                      ? "border-accent/22 bg-accent/10 text-accent"
                      : "border-white/[0.06] bg-white/[0.02] text-muted-fg/40 hover:border-white/[0.12] hover:text-fg/68",
                  )}
                  onClick={() => onIncludeProjectDocsChange(!includeProjectDocs)}
                  title="Include project context (PRD + architecture) with first message"
                  aria-pressed={!!includeProjectDocs}
                >
                  <BookOpen size={12} weight={includeProjectDocs ? "fill" : "regular"} />
                  <span>Context</span>
                </button>
              ) : null}

              {turnActive ? (
                <>
                  {draft.trim().length > 0 && onClearDraft ? (
                    <button
                      type="button"
                      className="inline-flex h-7 items-center justify-center rounded-md border border-white/[0.06] px-2 font-sans text-[10px] text-muted-fg/45 transition-all hover:bg-white/[0.04] hover:text-fg/72"
                      onClick={onClearDraft}
                      title="Clear draft only"
                    >
                      Clear
                    </button>
                  ) : null}
                  {draft.trim().length > 0 ? (
                    <button
                      type="button"
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[color:color-mix(in_srgb,var(--chat-accent)_28%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_12%,transparent)] text-[var(--chat-accent)] transition-all hover:bg-[color:color-mix(in_srgb,var(--chat-accent)_18%,transparent)]"
                      onClick={onSubmit}
                      title="Send steer message"
                    >
                      <PaperPlaneTilt size={11} weight="fill" />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-red-500/20 bg-red-500/[0.06] text-red-400/70 transition-all hover:border-red-500/35 hover:bg-red-500/12 hover:text-red-400"
                    title="Stop the active turn only (Cmd+.)"
                    onClick={onInterrupt}
                  >
                    <Square size={10} weight="fill" />
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className={cn(
                    "inline-flex h-7 items-center justify-center rounded-md border px-3 transition-all",
                    busy || !draft.trim().length || !modelId
                      ? "border-white/[0.04] text-muted-fg/12"
                      : "border-[color:color-mix(in_srgb,var(--chat-accent)_28%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_12%,transparent)] text-[var(--chat-accent)] hover:bg-[color:color-mix(in_srgb,var(--chat-accent)_20%,transparent)]",
                  )}
                  disabled={busy || !draft.trim().length || !modelId}
                  onClick={onSubmit}
                  title={!modelId ? "Select a model first" : "Send"}
                >
                  <PaperPlaneTilt size={11} weight="fill" />
                  <span className="ml-1 font-sans text-[10px]">Send</span>
                </button>
              )}
            </div>
          </div>
        </div>
      }
    >
      <div
        className="relative"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {dragActive ? (
          <div className="pointer-events-none absolute inset-0 z-[1] flex items-center justify-center bg-[color:color-mix(in_srgb,var(--chat-accent)_12%,rgba(5,5,8,0.58))] backdrop-blur-sm">
            <div className="rounded-[var(--chat-radius-card)] border border-[color:color-mix(in_srgb,var(--chat-accent)_32%,transparent)] bg-card/92 px-5 py-4 text-center shadow-[var(--chat-composer-shadow)]">
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--chat-accent)]">Drop files to attach</div>
              <div className="mt-1 text-[12px] text-fg/74">Images and files will be added to this turn.</div>
            </div>
          </div>
        ) : null}

        <div className="relative">
          {/* Ghost suggestion overlay */}
          {promptSuggestion && !draft.length && !turnActive ? (
            <div
              className="pointer-events-none absolute inset-0 flex items-start px-4 py-3"
              aria-hidden="true"
            >
              <span className="text-[13px] leading-[1.6] text-fg/18 italic">
                {promptSuggestion}
                <span className="ml-2 inline-flex items-center rounded border border-white/[0.06] bg-white/[0.03] px-1 py-px font-mono text-[9px] not-italic text-fg/20">
                  Tab
                </span>
              </span>
            </div>
          ) : null}
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => {
              const val = event.target.value;
              onDraftChange(val);
              if (slashPickerOpen && !val.startsWith("/")) { setSlashPickerOpen(false); setSlashQuery(""); }
              if (val.startsWith("/")) { setSlashQuery(val.slice(1)); setSlashCursor(0); }
            }}
            className={cn(
              "min-h-[40px] max-h-[40vh] w-full resize-none bg-transparent px-4 py-3 text-[13px] leading-[1.6] text-fg/88 outline-none transition-colors placeholder:text-muted-fg/25",
              dragActive ? "opacity-30" : "",
            )}
            placeholder={turnActive ? "Steer the active turn..." : (promptSuggestion ? "" : (messagePlaceholder ?? "Message the assistant..."))}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
          />
        </div>
      </div>
      </ChatComposerShell>
    </>
  );
}

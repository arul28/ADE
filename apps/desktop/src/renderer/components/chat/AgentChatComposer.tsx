import { useEffect, useMemo, useRef, useState } from "react";
import { At, Image, Paperclip, Square, X, Hash, PaperPlaneTilt, Lightning } from "@phosphor-icons/react";
import {
  inferAttachmentType,
  type AgentChatApprovalDecision,
  type AgentChatExecutionMode,
  type AgentChatFileRef,
  type AgentChatPermissionMode,
  type AgentChatSlashCommand,
  type ChatSurfaceProfile,
  type ChatSurfaceMode,
  type ComputerUsePolicy,
  type ContextPackOption,
} from "../../../shared/types";
import { getModelById } from "../../../shared/modelRegistry";
import { cn } from "../ui/cn";
import { UnifiedModelSelector } from "../shared/UnifiedModelSelector";
import {
  getPermissionOptions,
  safetyBadgeLabel,
  safetyColors,
  type PermissionOption,
} from "../shared/permissionOptions";
import { ChatAttachmentTray } from "./ChatAttachmentTray";
import { ChatComposerShell } from "./ChatComposerShell";

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
const CLAUDE_DEFAULT_COMMANDS: SlashCommandEntry[] = [
  { command: "/compact", label: "Compact", description: "Compact conversation context", source: "sdk" },
  { command: "/review", label: "Review", description: "Review code changes", source: "sdk" },
  { command: "/help", label: "Help", description: "Show available commands", source: "sdk" },
  { command: "/model", label: "Model", description: "Switch model", source: "sdk" },
  { command: "/permissions", label: "Permissions", description: "View or manage permissions", source: "sdk" },
  { command: "/cost", label: "Cost", description: "Show token usage and cost", source: "sdk" },
  { command: "/memory", label: "Memory", description: "Edit CLAUDE.md files", source: "sdk" },
  { command: "/status", label: "Status", description: "Show session status", source: "sdk" },
];

const CODEX_DEFAULT_COMMANDS: SlashCommandEntry[] = [
  { command: "/review", label: "Review", description: "Review uncommitted changes", source: "sdk" },
  { command: "/help", label: "Help", description: "Show available commands", source: "sdk" },
];

/** Build the effective slash command list by merging SDK-provided commands with local ones. */
function buildSlashCommands(sdkCommands: AgentChatSlashCommand[], modelFamily?: string): SlashCommandEntry[] {
  const result: SlashCommandEntry[] = [];
  const seen = new Set<string>();

  // SDK commands first — they take priority
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
    const defaults = modelFamily === "anthropic" ? CLAUDE_DEFAULT_COMMANDS
      : modelFamily === "openai" ? CODEX_DEFAULT_COMMANDS
      : [];
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

/* ── Permission hover pane ── */
function PermissionHoverPane({ opt }: { opt: PermissionOption }) {
  const colors = safetyColors(opt.safety);
  const badgeLabel = safetyBadgeLabel(opt.safety);

  return (
    <div
      className={cn(
        "pointer-events-none absolute z-50 w-[260px]",
        "rounded-xl border border-white/[0.08] bg-card shadow-[var(--shadow-float)]",
        "border-l-2",
        colors.border
      )}
      style={{ bottom: "calc(100% + 8px)", left: "50%", transform: "translateX(-50%)" }}
    >
      <div className="flex items-center gap-2 border-b border-white/[0.04] px-3 py-2">
        <span className="font-sans text-[11px] font-bold uppercase tracking-wider text-fg/85">{opt.label}</span>
        <span className={cn("ml-auto font-sans text-[9px] font-bold uppercase tracking-widest", colors.badge)}>{badgeLabel}</span>
      </div>
      <div className="space-y-2.5 px-3 py-2.5">
        <p className="font-sans text-[11px] leading-[1.5] text-fg/65">{opt.detail}</p>
        {opt.allows.length > 0 && (
          <div className="space-y-1">
            {opt.allows.map((item) => (
              <div key={item} className="flex items-start gap-1.5">
                <span className="mt-0.5 h-1.5 w-1.5 flex-shrink-0 bg-emerald-400/70" />
                <span className="font-mono text-[10px] text-emerald-400/80">{item}</span>
              </div>
            ))}
          </div>
        )}
        {opt.gates && opt.gates.length > 0 && (
          <div className="space-y-1">
            {opt.gates.map((item) => (
              <div key={item} className="flex items-start gap-1.5">
                <span className="mt-0.5 h-1.5 w-1.5 flex-shrink-0 bg-amber-400/70" />
                <span className="font-mono text-[10px] text-amber-400/70">{item}</span>
              </div>
            ))}
          </div>
        )}
        {opt.blocks && opt.blocks.length > 0 && (
          <div className="space-y-1">
            {opt.blocks.map((item) => (
              <div key={item} className="flex items-start gap-1.5">
                <span className="mt-0.5 h-1.5 w-1.5 flex-shrink-0 bg-red-400/70" />
                <span className="font-mono text-[10px] text-red-400/70">{item}</span>
              </div>
            ))}
          </div>
        )}
        {opt.warning && (
          <div className="rounded-md border border-red-500/20 bg-red-500/[0.08] px-2 py-1.5">
            <span className="font-sans text-[10px] leading-[1.4] text-red-400/80">{opt.warning}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function AgentChatComposer({
  surfaceMode = "standard",
  surfaceProfile = "standard",
  sdkSlashCommands = [],
  modelId,
  availableModelIds,
  reasoningEffort,
  draft,
  attachments,
  pendingApproval,
  turnActive,
  sendOnEnter,
  busy,
  selectedContextPacks,
  laneId,
  permissionMode,
  sessionProvider,
  sessionIsCliWrapped,
  executionMode,
  computerUsePolicy,
  executionModeOptions = [],
  modelSelectionLocked = false,
  permissionModeLocked = false,
  onModelChange,
  onReasoningEffortChange,
  onDraftChange,
  onSubmit,
  onInterrupt,
  onApproval,
  onAddAttachment,
  onRemoveAttachment,
  onSearchAttachments,
  onContextPacksChange,
  onExecutionModeChange,
  onPermissionModeChange,
  onComputerUsePolicyChange,
  onClearEvents
}: {
  surfaceMode?: ChatSurfaceMode;
  surfaceProfile?: ChatSurfaceProfile;
  sdkSlashCommands?: AgentChatSlashCommand[];
  modelId: string;
  availableModelIds?: string[];
  reasoningEffort: string | null;
  draft: string;
  attachments: AgentChatFileRef[];
  pendingApproval: {
    itemId: string;
    description: string;
    kind: "command" | "file_change" | "tool_call";
  } | null;
  turnActive: boolean;
  sendOnEnter: boolean;
  busy: boolean;
  selectedContextPacks: ContextPackOption[];
  laneId?: string;
  permissionMode?: AgentChatPermissionMode;
  sessionProvider?: string;
  sessionIsCliWrapped?: boolean;
  executionMode?: AgentChatExecutionMode | null;
  computerUsePolicy: ComputerUsePolicy;
  executionModeOptions?: ExecutionModeOption[];
  modelSelectionLocked?: boolean;
  permissionModeLocked?: boolean;
  onModelChange: (modelId: string) => void;
  onReasoningEffortChange: (reasoningEffort: string | null) => void;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
  onInterrupt: () => void;
  onApproval: (decision: AgentChatApprovalDecision) => void;
  onAddAttachment: (attachment: AgentChatFileRef) => void;
  onRemoveAttachment: (path: string) => void;
  onSearchAttachments: (query: string) => Promise<AgentChatFileRef[]>;
  onContextPacksChange: (packs: ContextPackOption[]) => void;
  onExecutionModeChange?: (mode: AgentChatExecutionMode) => void;
  onPermissionModeChange?: (mode: AgentChatPermissionMode) => void;
  onComputerUsePolicyChange: (policy: ComputerUsePolicy) => void;
  onClearEvents?: () => void;
}) {
  const isPersistentIdentitySurface = surfaceProfile === "persistent_identity";
  const [attachmentPickerOpen, setAttachmentPickerOpen] = useState(false);
  const [attachmentQuery, setAttachmentQuery] = useState("");
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [attachmentResults, setAttachmentResults] = useState<AgentChatFileRef[]>([]);
  const [attachmentCursor, setAttachmentCursor] = useState(0);

  const [slashPickerOpen, setSlashPickerOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashCursor, setSlashCursor] = useState(0);

  const [contextPickerOpen, setContextPickerOpen] = useState(false);
  const [contextPacks, setContextPacks] = useState<ContextPackOption[]>([]);
  const [contextCursor, setContextCursor] = useState(0);

  const [hoveredMode, setHoveredMode] = useState<AgentChatPermissionMode | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
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

  /* ── Context pack picker ── */
  useEffect(() => {
    if (!contextPickerOpen) { setContextCursor(0); return; }
    if (!laneId) return;
    let cancelled = false;
    window.ade.agentChat
      .listContextPacks({ laneId })
      .then((packs) => { if (!cancelled) { setContextPacks(packs); setContextCursor(0); } })
      .catch(() => { if (!cancelled) setContextPacks([]); });
    return () => { cancelled = true; };
  }, [contextPickerOpen, laneId]);

  const selectAttachment = (attachment: AgentChatFileRef) => {
    onAddAttachment(attachment);
    setAttachmentPickerOpen(false);
  };

  const addFileAttachments = async (files: FileList | null | undefined) => {
    if (!canAttach || !files?.length) return;
    for (const file of Array.from(files)) {
      const fileWithPath = file as File & { path?: string };
      const hasRealPath = typeof fileWithPath.path === "string" && fileWithPath.path.trim().length > 0;

      if (hasRealPath) {
        // File from filesystem (drag-drop from Finder, native picker)
        const filePath = fileWithPath.path!;
        onAddAttachment({ path: filePath, type: inferAttachmentType(filePath, file.type) });
      } else {
        // Clipboard paste or browser drag — no filesystem path.
        // Read the blob, save to a temp file via IPC, then attach.
        try {
          const buf = await file.arrayBuffer();
          const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
          const { path: tempPath } = await window.ade.agentChat.saveTempAttachment({
            data: base64,
            filename: file.name || "clipboard.png",
          });
          onAddAttachment({ path: tempPath, type: inferAttachmentType(tempPath, file.type) });
        } catch {
          // Silently skip files that can't be saved
        }
      }
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

  const packMatches = (a: ContextPackOption, b: ContextPackOption) =>
    a.scope === b.scope && a.featureKey === b.featureKey && a.missionId === b.missionId;

  const toggleContextPack = (pack: ContextPackOption) => {
    const isSelected = selectedContextPacks.some((p) => packMatches(p, pack));
    if (isSelected) {
      onContextPacksChange(selectedContextPacks.filter((p) => !packMatches(p, pack)));
    } else {
      onContextPacksChange([...selectedContextPacks, pack]);
    }
  };

  const removeContextPack = (pack: ContextPackOption) => {
    onContextPacksChange(selectedContextPacks.filter((p) => !packMatches(p, pack)));
  };

  const permissionOptions = getPermissionOptions({
    family: selectedModel?.family ?? sessionProvider ?? "unified",
    isCliWrapped: sessionIsCliWrapped ?? false,
    profile: surfaceProfile,
  });
  const showAdvancedComputerUseControls = !isPersistentIdentitySurface;

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

    /* Context picker keyboard */
    if (contextPickerOpen) {
      if (event.key === "Escape") { event.preventDefault(); setContextPickerOpen(false); return; }
      if (event.key === "ArrowDown") { event.preventDefault(); setContextCursor((v) => Math.min(v + 1, Math.max(contextPacks.length - 1, 0))); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); setContextCursor((v) => Math.max(v - 1, 0)); return; }
      if (event.key === "Enter") {
        const pack = contextPacks[contextCursor];
        if (pack && pack.available) { event.preventDefault(); toggleContextPack(pack); return; }
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
    if (event.key === "#" && !commandModified && !event.altKey) {
      event.preventDefault();
      setContextPickerOpen(true);
      setContextCursor(0);
      return;
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
      if (pendingApproval) { onApproval("cancel"); return; }
      if (draft.length) { onDraftChange(""); }
      return;
    }

    if (event.key === "." && commandModified && turnActive) { event.preventDefault(); onInterrupt(); return; }

    if (event.key !== "Enter" || event.shiftKey) return;
    const commandEnter = commandModified;
    const shouldSend = sendOnEnter ? !commandEnter : commandEnter;
    if (!shouldSend) return;
    event.preventDefault();
    if (busy || !modelId) return;
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
    <ChatComposerShell
      mode={surfaceMode}
      className="m-3 mt-0 rounded-[var(--chat-radius-shell)]"
      pendingBanner={pendingApproval ? (
        <div className="px-4 py-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-[var(--chat-radius-pill)] border border-amber-400/20 bg-amber-500/10">
              <Lightning size={11} weight="bold" className="text-amber-300" />
            </span>
            <span className="font-mono text-[9px] font-bold uppercase tracking-widest text-amber-200">Approval · {pendingApproval.kind}</span>
          </div>
          <div className="mb-2 font-mono text-[11px] leading-relaxed text-fg/68">{pendingApproval.description}</div>
          <div className="flex items-center gap-1.5">
            <button type="button" className="rounded-[var(--chat-radius-pill)] border border-accent/30 bg-accent/12 px-3 py-1 font-mono text-[9px] font-bold uppercase tracking-wider text-fg/80 transition-colors hover:bg-accent/20" onClick={() => onApproval("accept")}>Accept</button>
            <button type="button" className="rounded-[var(--chat-radius-pill)] border border-border/20 px-3 py-1 font-mono text-[9px] font-bold uppercase tracking-wider text-fg/50 transition-colors hover:bg-border/10" onClick={() => onApproval("accept_for_session")}>Accept All</button>
            <button type="button" className="rounded-[var(--chat-radius-pill)] border border-border/20 px-3 py-1 font-mono text-[9px] font-bold uppercase tracking-wider text-fg/40 transition-colors hover:bg-border/10" onClick={() => onApproval("decline")}>Decline</button>
          </div>
        </div>
      ) : undefined}
      trays={
        attachments.length || selectedContextPacks.length ? (
          <div className="space-y-2 px-1 py-2">
            <ChatAttachmentTray
              attachments={attachments}
              mode={surfaceMode}
              onRemove={onRemoveAttachment}
              className="px-3 py-0"
            />
            {selectedContextPacks.length ? (
              <div className="flex flex-wrap items-center gap-1.5 px-4 pb-1">
                {selectedContextPacks.map((pack) => (
                  <span key={`${pack.scope}:${pack.featureKey ?? ""}:${pack.missionId ?? ""}`} className="inline-flex items-center gap-1 rounded-[var(--chat-radius-pill)] border border-violet-500/18 bg-violet-500/10 px-2 py-1 font-mono text-[9px] text-fg/65">
                    <Hash size={9} weight="bold" className="text-violet-300" />
                    <span className="max-w-[180px] truncate">{pack.label}</span>
                    <button type="button" className="ml-0.5 text-fg/30 hover:text-fg/70" title={`Remove ${pack.label}`} onClick={() => removeContextPack(pack)}>
                      <X size={8} weight="bold" />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
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

          {contextPickerOpen ? (
            <div className="absolute bottom-full left-3 z-10 mb-3 w-80 rounded-[var(--chat-radius-card)] border border-white/[0.06] bg-card/95 shadow-[var(--chat-composer-shadow)] backdrop-blur-xl">
              <div className="border-b border-white/[0.04] px-3 py-2 font-mono text-[9px] font-bold uppercase tracking-widest text-muted-fg/35">
                Context Packs
              </div>
              <div className="max-h-52 overflow-auto py-1">
                {contextPacks.length ? (
                  contextPacks.map((pack, index) => {
                    const isSelected = selectedContextPacks.some((p) => packMatches(p, pack));
                    return (
                      <button
                        key={`${pack.scope}:${pack.featureKey ?? ""}:${pack.missionId ?? ""}`}
                        type="button"
                        className={cn(
                          "flex w-full items-center gap-3 px-3 py-2 text-left font-mono text-[10px]",
                          index === contextCursor ? "bg-accent/10" : "hover:bg-border/6",
                          !pack.available && "opacity-30",
                        )}
                        disabled={!pack.available}
                        onMouseEnter={() => setContextCursor(index)}
                        onClick={() => toggleContextPack(pack)}
                      >
                        <span className={cn(
                          "flex h-4 w-4 items-center justify-center rounded-[var(--chat-radius-pill)] border text-[9px]",
                          isSelected ? "border-violet-400/40 bg-violet-500/12 text-violet-300" : "border-border/20 text-transparent",
                        )}>
                          {isSelected ? "\u2713" : ""}
                        </span>
                        <div className="flex-1">
                          <div className="text-fg/72">{pack.label}</div>
                          <div className="text-[9px] text-muted-fg/30">{pack.description}</div>
                        </div>
                      </button>
                    );
                  })
                ) : (
                  <div className="px-3 py-2 font-mono text-[10px] text-muted-fg/30">No context packs available.</div>
                )}
              </div>
              <div className="border-t border-white/[0.04] px-3 py-2">
                <button type="button" className="font-mono text-[10px] text-accent/60 hover:text-accent" onClick={() => setContextPickerOpen(false)}>Done</button>
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
        <div className="space-y-1.5 px-3 py-2">
          {/* Row 1: Control groups — permissions, CU, execution mode */}
          <div className="flex flex-wrap items-center gap-1.5 overflow-x-auto scrollbar-none">
            {!isPersistentIdentitySurface && executionModeOptions.length > 0 && onExecutionModeChange ? (
              <div className="flex shrink-0 items-center gap-px rounded-md border border-white/[0.06] bg-white/[0.02]">
                {executionModeOptions.map((option) => {
                  const isActive = executionMode === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      className={cn(
                        "rounded-md px-2 py-1 font-sans text-[10px] font-medium transition-colors",
                        isActive
                          ? "text-fg/80"
                          : "text-muted-fg/28 hover:text-fg/55",
                      )}
                      style={isActive ? {
                        borderColor: `${option.accent}44`,
                        background: `${option.accent}18`,
                      } : undefined}
                      onClick={() => onExecutionModeChange(option.value)}
                      title={option.helper}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            ) : null}

            {permissionMode && onPermissionModeChange && permissionOptions.length > 0 && !permissionModeLocked ? (
              <div className="relative flex shrink-0 items-center gap-px rounded-md border border-white/[0.06] bg-white/[0.02]">
                {permissionOptions.map((opt) => {
                  const isActive = permissionMode === opt.value;
                  const isHovered = hoveredMode === opt.value;
                  const colors = safetyColors(opt.safety);
                  return (
                    <div key={opt.value} className="relative">
                      <button
                        type="button"
                        className={cn(
                          "rounded-md px-2 py-1 font-sans text-[10px] font-medium transition-colors",
                          isActive ? `${colors.activeBg} text-fg/80` : "text-muted-fg/25 hover:text-muted-fg/50",
                        )}
                        onClick={() => onPermissionModeChange(opt.value)}
                        onMouseEnter={() => {
                          if (!isPersistentIdentitySurface) setHoveredMode(opt.value);
                        }}
                        onMouseLeave={() => setHoveredMode(null)}
                        title={opt.shortDesc}
                      >
                        {opt.label}
                      </button>
                      {isHovered && !isPersistentIdentitySurface ? <PermissionHoverPane opt={opt} /> : null}
                    </div>
                  );
                })}
              </div>
            ) : null}

            <div className="flex shrink-0 items-center gap-px rounded-md border border-white/[0.06] bg-white/[0.02] px-0.5 py-0.5">
              {isPersistentIdentitySurface ? (
                <span className="px-1.5 font-sans text-[10px] font-medium text-muted-fg/50">
                  CU
                </span>
              ) : null}
              {(["off", "auto", "enabled"] as const).map((mode) => {
                const isActive = computerUsePolicy.mode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    className={cn(
                      "rounded-md px-1.5 py-1 font-sans text-[10px] font-medium transition-colors",
                      isActive
                        ? "bg-sky-500/10 text-sky-300"
                        : "text-muted-fg/25 hover:text-muted-fg/50",
                    )}
                    onClick={() => onComputerUsePolicyChange({ ...computerUsePolicy, mode })}
                    title="Computer-use policy for this chat session"
                  >
                    {showAdvancedComputerUseControls
                      ? (mode === "enabled" ? "CU On" : mode === "off" ? "CU Off" : "CU Auto")
                      : (mode === "enabled" ? "On" : mode === "off" ? "Off" : "Auto")}
                  </button>
                );
              })}
              {showAdvancedComputerUseControls ? (
                <>
                  <button
                    type="button"
                    className={cn(
                      "rounded-md px-1.5 py-1 font-sans text-[10px] font-medium transition-colors",
                      computerUsePolicy.allowLocalFallback ? "text-amber-300" : "text-muted-fg/25 hover:text-muted-fg/50",
                    )}
                    onClick={() => onComputerUsePolicyChange({
                      ...computerUsePolicy,
                      allowLocalFallback: !computerUsePolicy.allowLocalFallback,
                    })}
                    title="Allow ADE local fallback"
                  >
                    Fallback
                  </button>
                  <button
                    type="button"
                    className={cn(
                      "rounded-md px-1.5 py-1 font-sans text-[10px] font-medium transition-colors",
                      computerUsePolicy.retainArtifacts ? "text-emerald-300" : "text-muted-fg/25 hover:text-muted-fg/50",
                    )}
                    onClick={() => onComputerUsePolicyChange({
                      ...computerUsePolicy,
                      retainArtifacts: !computerUsePolicy.retainArtifacts,
                    })}
                    title="Retain computer-use proof artifacts"
                  >
                    Proof
                  </button>
                </>
              ) : null}
            </div>
          </div>

          {/* Row 2: Model selector + actions */}
          <div className="flex items-center gap-2">
            <div className="min-w-0 shrink">
              <UnifiedModelSelector
                value={modelId}
                onChange={onModelChange}
                availableModelIds={availableModelIds}
                disabled={modelSelectionLocked}
                showReasoning={!isPersistentIdentitySurface}
                reasoningEffort={reasoningEffort}
                onReasoningEffortChange={onReasoningEffortChange}
              />
            </div>

            <div className="ml-auto flex shrink-0 items-center gap-1">
              <button
                type="button"
                className="rounded-md px-2 py-1 font-sans text-[10px] text-muted-fg/22 transition-colors hover:bg-white/5 hover:text-muted-fg/55"
                disabled={!canAttach}
                onClick={() => canAttach && setAttachmentPickerOpen((o) => !o)}
                title="Attach files or images (@)"
              >@</button>
              <button
                type="button"
                className="rounded-md px-1.5 py-1 text-muted-fg/22 transition-colors hover:bg-white/5 hover:text-muted-fg/55"
                disabled={!canAttach}
                onClick={openUploadPicker}
                title="Upload file from disk"
              ><Paperclip size={12} /></button>
              <button
                type="button"
                className="rounded-md px-2 py-1 font-sans text-[10px] text-muted-fg/22 transition-colors hover:bg-white/5 hover:text-muted-fg/55"
                onClick={() => setContextPickerOpen((o) => !o)}
                title="Context packs (#)"
              >#</button>
              <button
                type="button"
                className="rounded-md px-2 py-1 font-sans text-[10px] text-muted-fg/22 transition-colors hover:bg-white/5 hover:text-muted-fg/55"
                onClick={() => { onDraftChange("/"); setSlashPickerOpen(true); setSlashQuery(""); setSlashCursor(0); textareaRef.current?.focus(); }}
                title="Commands (/)"
              >/</button>

              {turnActive ? (
                <>
                  {draft.trim().length > 0 && (
                    <button
                      type="button"
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[color:color-mix(in_srgb,var(--chat-accent)_28%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_12%,transparent)] text-[var(--chat-accent)] transition-all hover:bg-[color:color-mix(in_srgb,var(--chat-accent)_18%,transparent)]"
                      onClick={onSubmit}
                      title="Steer"
                    >
                      <PaperPlaneTilt size={11} weight="fill" />
                    </button>
                  )}
                  <button
                    type="button"
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-red-500/20 bg-red-500/[0.06] text-red-400/70 transition-all hover:border-red-500/35 hover:bg-red-500/12 hover:text-red-400"
                    title="Interrupt (Cmd+.)"
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

        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => {
            const val = event.target.value;
            onDraftChange(val);
            if (slashPickerOpen && !val.startsWith("/")) { setSlashPickerOpen(false); setSlashQuery(""); }
            if (slashPickerOpen && val.startsWith("/")) { setSlashQuery(val.slice(1)); setSlashCursor(0); }
          }}
          className={cn(
            "min-h-[40px] max-h-[160px] w-full resize-none bg-transparent px-4 py-3 text-[13px] leading-[1.6] text-fg/88 outline-none transition-colors placeholder:text-muted-fg/25",
            dragActive ? "opacity-30" : "",
          )}
          placeholder={turnActive ? "Steer the active turn..." : "Message the agent..."}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
        />
      </div>
    </ChatComposerShell>
  );
}

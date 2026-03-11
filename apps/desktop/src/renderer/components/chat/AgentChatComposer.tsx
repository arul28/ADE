import { useEffect, useMemo, useRef, useState } from "react";
import { At, Image, Square, X, Hash, PaperPlaneTilt, Lightning } from "@phosphor-icons/react";
import type {
  AgentChatApprovalDecision,
  AgentChatExecutionMode,
  AgentChatFileRef,
  AgentChatPermissionMode,
  ContextPackOption
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

type ExecutionModeOption = {
  value: AgentChatExecutionMode;
  label: string;
  summary: string;
  helper: string;
  accent: string;
};

const SLASH_COMMANDS = [
  { command: "/plan", label: "Plan", description: "Create a development plan", category: "Generate" },
  { command: "/review", label: "Review", description: "Review code changes", category: "Generate" },
  { command: "/help", label: "Help", description: "Show available commands", category: "Info" },
  { command: "/clear", label: "Clear", description: "Clear chat history", category: "Action" },
  { command: "/model", label: "Model", description: "Change the model", category: "Settings" },
  { command: "/effort", label: "Effort", description: "Change reasoning effort", category: "Settings" }
];

/* ── Permission hover pane ── */
function PermissionHoverPane({ opt }: { opt: PermissionOption }) {
  const colors = safetyColors(opt.safety);
  const badgeLabel = safetyBadgeLabel(opt.safety);

  return (
    <div
      className={cn(
        "pointer-events-none absolute z-50 w-[260px]",
        "border border-border/20 bg-surface-overlay/95 shadow-[var(--shadow-float)]",
        "border-l-2",
        colors.border
      )}
      style={{ bottom: "calc(100% + 8px)", left: "50%", transform: "translateX(-50%)" }}
    >
      <div className="flex items-center gap-2 border-b border-border/12 px-3 py-2">
        <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-fg/85">{opt.label}</span>
        <span className={cn("ml-auto font-mono text-[9px] font-bold uppercase tracking-widest", colors.badge)}>{badgeLabel}</span>
      </div>
      <div className="space-y-2.5 px-3 py-2.5">
        <p className="font-mono text-[11px] leading-[1.5] text-fg/65">{opt.detail}</p>
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
          <div className="border border-red-500/20 bg-red-500/[0.08] px-2 py-1.5">
            <span className="font-mono text-[10px] leading-[1.4] text-red-400/80">{opt.warning}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function AgentChatComposer({
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
  executionModeOptions = [],
  modelSelectionLocked = false,
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
  onClearEvents
}: {
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
  executionModeOptions?: ExecutionModeOption[];
  modelSelectionLocked?: boolean;
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
  onClearEvents?: () => void;
}) {
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

  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const canAttach = !turnActive;

  const attachedPaths = useMemo(() => new Set(attachments.map((a) => a.path)), [attachments]);
  const selectedModel = useMemo(() => getModelById(modelId), [modelId]);

  const filteredSlashCommands = useMemo(() => {
    if (!slashQuery.length) return SLASH_COMMANDS;
    const q = slashQuery.toLowerCase();
    return SLASH_COMMANDS.filter(
      (cmd) =>
        cmd.command.toLowerCase().includes(q) ||
        cmd.label.toLowerCase().includes(q) ||
        cmd.description.toLowerCase().includes(q)
    );
  }, [slashQuery]);

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

  const handleSlashSelect = (cmd: (typeof SLASH_COMMANDS)[number]) => {
    setSlashPickerOpen(false);
    setSlashQuery("");
    if (cmd.command === "/clear" && onClearEvents) { onClearEvents(); onDraftChange(""); return; }
    if (cmd.command === "/plan" || cmd.command === "/review") { onDraftChange(`${cmd.command} ${draft}`); return; }
    onDraftChange(`${cmd.command} `);
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
  });

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

    /* Trigger pickers */
    if (event.key === "/" && draft.length === 0 && !commandModified && !event.altKey) {
      event.preventDefault();
      window.setTimeout(() => { setSlashPickerOpen(true); setSlashQuery(""); setSlashCursor(0); }, 0);
      return;
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
    onSubmit();
  };

  return (
    <div className="border-t border-border/15 bg-card/60">
      {/* ── Pending approval banner ── */}
      {pendingApproval ? (
        <div className="border-b border-amber-500/15 bg-amber-500/[0.04] px-4 py-2.5">
          <div className="mb-1.5 flex items-center gap-2">
            <Lightning size={11} weight="bold" className="text-amber-400" />
            <span className="font-mono text-[9px] font-bold uppercase tracking-widest text-fg/70">Approval · {pendingApproval.kind}</span>
          </div>
          <div className="mb-2 font-mono text-[11px] leading-relaxed text-fg/60">{pendingApproval.description}</div>
          <div className="flex items-center gap-1.5">
            <button type="button" className="border border-accent/30 bg-accent/10 px-3 py-1 font-mono text-[9px] font-bold uppercase tracking-wider text-fg/80 transition-colors hover:bg-accent/20" onClick={() => onApproval("accept")}>Accept</button>
            <button type="button" className="border border-border/20 px-3 py-1 font-mono text-[9px] font-bold uppercase tracking-wider text-fg/50 transition-colors hover:bg-border/10" onClick={() => onApproval("accept_for_session")}>Accept All</button>
            <button type="button" className="border border-border/20 px-3 py-1 font-mono text-[9px] font-bold uppercase tracking-wider text-fg/40 transition-colors hover:bg-border/10" onClick={() => onApproval("decline")}>Decline</button>
          </div>
        </div>
      ) : null}

      {/* ── Attached files ── */}
      {attachments.length ? (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border/8 px-4 py-1.5">
          {attachments.map((attachment) => (
            <span key={attachment.path} className="inline-flex items-center gap-1 border border-border/15 px-2 py-0.5 font-mono text-[9px] text-fg/60">
              {attachment.type === "image" ? <Image size={9} weight="bold" /> : <At size={9} weight="bold" />}
              <span className="max-w-[180px] truncate">{attachment.path}</span>
              <button type="button" className="ml-0.5 text-fg/30 hover:text-fg/70" title={`Remove ${attachment.path}`} onClick={() => onRemoveAttachment(attachment.path)}>
                <X size={8} weight="bold" />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {/* ── Context packs ── */}
      {selectedContextPacks.length ? (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border/8 px-4 py-1.5">
          {selectedContextPacks.map((pack) => (
            <span key={`${pack.scope}:${pack.featureKey ?? ""}:${pack.missionId ?? ""}`} className="inline-flex items-center gap-1 border border-violet-500/15 px-2 py-0.5 font-mono text-[9px] text-fg/60">
              <Hash size={9} weight="bold" className="text-violet-400/50" />
              <span className="max-w-[160px] truncate">{pack.label}</span>
              <button type="button" className="ml-0.5 text-fg/30 hover:text-fg/70" title={`Remove ${pack.label}`} onClick={() => removeContextPack(pack)}>
                <X size={8} weight="bold" />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {/* ── Pickers (positioned above input) ── */}
      <div className="relative">
        {/* Slash command picker */}
        {slashPickerOpen && filteredSlashCommands.length > 0 ? (
          <div className="absolute bottom-full left-0 z-10 w-72 border border-border/15 bg-card shadow-[var(--shadow-float)]">
            <div className="border-b border-border/8 px-3 py-1.5 font-mono text-[9px] font-bold uppercase tracking-widest text-muted-fg/30">
              Commands
            </div>
            <div className="max-h-52 overflow-auto py-1">
              {filteredSlashCommands.map((cmd, index) => (
                <button
                  key={cmd.command}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-3 px-3 py-1.5 text-left font-mono text-[10px]",
                    index === slashCursor ? "bg-accent/8 text-fg" : "text-fg/50 hover:bg-border/6"
                  )}
                  onMouseEnter={() => setSlashCursor(index)}
                  onClick={() => handleSlashSelect(cmd)}
                >
                  <span className="w-14 text-accent/60">{cmd.command}</span>
                  <span className="flex-1 text-fg/40">{cmd.description}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {/* Context pack picker */}
        {contextPickerOpen ? (
          <div className="absolute bottom-full left-0 z-10 w-80 border border-border/15 bg-card shadow-[var(--shadow-float)]">
            <div className="border-b border-border/8 px-3 py-1.5 font-mono text-[9px] font-bold uppercase tracking-widest text-muted-fg/30">
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
                        "flex w-full items-center gap-3 px-3 py-1.5 text-left font-mono text-[10px]",
                        index === contextCursor ? "bg-accent/8" : "hover:bg-border/6",
                        !pack.available && "opacity-30"
                      )}
                      disabled={!pack.available}
                      onMouseEnter={() => setContextCursor(index)}
                      onClick={() => toggleContextPack(pack)}
                    >
                      <span className={cn(
                        "flex h-3.5 w-3.5 items-center justify-center border text-[9px]",
                        isSelected ? "border-violet-400/40 bg-violet-500/12 text-violet-300" : "border-border/20 text-transparent"
                      )}>
                        {isSelected ? "\u2713" : ""}
                      </span>
                      <div className="flex-1">
                        <div className="text-fg/70">{pack.label}</div>
                        <div className="text-[9px] text-muted-fg/30">{pack.description}</div>
                      </div>
                    </button>
                  );
                })
              ) : (
                <div className="px-3 py-2 font-mono text-[10px] text-muted-fg/30">No context packs available.</div>
              )}
            </div>
            <div className="border-t border-border/8 px-3 py-1.5">
              <button type="button" className="font-mono text-[10px] text-accent/50 hover:text-accent" onClick={() => setContextPickerOpen(false)}>Done</button>
            </div>
          </div>
        ) : null}

        {/* Attachment picker */}
        {attachmentPickerOpen ? (
          <div className="absolute bottom-full left-0 z-10 w-80 border border-border/15 bg-card shadow-[var(--shadow-float)]">
            <div className="flex items-center gap-2 border-b border-border/8 px-3 py-2">
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
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[10px] text-fg/60",
                      index === attachmentCursor ? "bg-accent/8 text-fg/80" : "hover:bg-border/6"
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

        {/* ── Textarea + send ── */}
        <div className="flex items-end gap-2 px-3 py-2">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => {
              const val = event.target.value;
              onDraftChange(val);
              if (slashPickerOpen && !val.startsWith("/")) { setSlashPickerOpen(false); setSlashQuery(""); }
              if (slashPickerOpen && val.startsWith("/")) { setSlashQuery(val.slice(1)); setSlashCursor(0); }
            }}
            className="min-h-[56px] max-h-[180px] flex-1 resize-none border border-border/12 bg-surface-recessed/50 px-3 py-2.5 font-mono text-[12px] leading-[1.65] text-fg/80 outline-none transition-colors placeholder:text-muted-fg/20 focus:border-accent/25"
            placeholder={turnActive ? "Steer the active turn..." : "Message the agent..."}
            onKeyDown={handleKeyDown}
          />
          <div className="flex items-center gap-1.5 pb-0.5">
            {turnActive ? (
              <>
                <button
                  type="button"
                  className={cn(
                    "flex h-8 items-center justify-center border px-2 transition-all",
                    !draft.trim().length
                      ? "border-border/8 text-muted-fg/12"
                      : "border-accent/25 bg-accent/8 text-accent/60 hover:bg-accent/15 hover:text-accent"
                  )}
                  disabled={!draft.trim().length}
                  onClick={onSubmit}
                  title="Steer"
                >
                  <PaperPlaneTilt size={11} weight="fill" />
                </button>
                <button
                  type="button"
                  className="group relative flex h-8 w-8 items-center justify-center border border-red-500/25 bg-red-500/8 text-red-400/70 transition-all hover:border-red-500/40 hover:bg-red-500/15 hover:text-red-400"
                  title="Interrupt (Cmd+.)"
                  onClick={onInterrupt}
                >
                  <Square size={11} weight="fill" />
                  <span className="absolute inset-0 animate-pulse border border-red-500/15" />
                </button>
              </>
            ) : (
              <button
                type="button"
                className={cn(
                  "flex h-8 w-8 items-center justify-center border transition-all",
                  busy || !draft.trim().length
                    ? "border-border/8 text-muted-fg/12"
                    : "border-accent/30 bg-accent/10 text-accent/70 hover:bg-accent/20 hover:text-accent"
                )}
                disabled={busy || !draft.trim().length}
                onClick={onSubmit}
                title="Send"
              >
                {busy ? (
                  <div className="flex items-center gap-0.5">
                    <span className="h-1 w-1 animate-bounce bg-accent/60 [animation-delay:0ms]" />
                    <span className="h-1 w-1 animate-bounce bg-accent/60 [animation-delay:100ms]" />
                    <span className="h-1 w-1 animate-bounce bg-accent/60 [animation-delay:200ms]" />
                  </div>
                ) : (
                  <PaperPlaneTilt size={13} weight="fill" />
                )}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── Toolbar ── */}
      <div className="flex items-center gap-2 border-t border-border/8 px-3 py-1">
              <UnifiedModelSelector
                value={modelId}
                onChange={onModelChange}
                availableModelIds={availableModelIds}
                disabled={modelSelectionLocked}
                showReasoning
                reasoningEffort={reasoningEffort}
                onReasoningEffortChange={onReasoningEffortChange}
              />

        {/* Permission mode */}
        {permissionMode && onPermissionModeChange && permissionOptions.length > 0 ? (
          <div className="relative flex items-center gap-px border border-border/10 bg-surface-recessed/40">
            {permissionOptions.map((opt) => {
              const isActive = permissionMode === opt.value;
              const isHovered = hoveredMode === opt.value;
              const colors = safetyColors(opt.safety);
              return (
                <div key={opt.value} className="relative">
                  <button
                    type="button"
                    className={cn(
                      "px-2 py-0.5 font-mono text-[8px] font-bold uppercase tracking-wider transition-colors",
                      isActive ? colors.activeBg + " text-fg/80" : "text-muted-fg/25 hover:text-muted-fg/50"
                    )}
                    onClick={() => onPermissionModeChange(opt.value)}
                    onMouseEnter={() => setHoveredMode(opt.value)}
                    onMouseLeave={() => setHoveredMode(null)}
                    title={opt.shortDesc}
                  >
                    {opt.label}
                  </button>
                  {isHovered ? <PermissionHoverPane opt={opt} /> : null}
                </div>
              );
            })}
          </div>
        ) : null}

        {/* Quick-action triggers (keep for tests + discoverability) */}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            className="px-1 py-0.5 font-mono text-[8px] text-muted-fg/20 transition-colors hover:text-muted-fg/50"
            disabled={!canAttach}
            onClick={() => canAttach && setAttachmentPickerOpen((o) => !o)}
            title="Attach files or images (@)"
          >@</button>
          <button
            type="button"
            className="px-1 py-0.5 font-mono text-[8px] text-muted-fg/20 transition-colors hover:text-muted-fg/50"
            onClick={() => setContextPickerOpen((o) => !o)}
            title="Context packs (#)"
          >#</button>
          <button
            type="button"
            className="px-1 py-0.5 font-mono text-[8px] text-muted-fg/20 transition-colors hover:text-muted-fg/50"
            onClick={() => { setSlashPickerOpen(true); setSlashQuery(""); setSlashCursor(0); }}
            title="Commands (/)"
          >/</button>
          <span className="ml-1 font-mono text-[8px] text-muted-fg/15">
            {sendOnEnter ? "Enter sends" : "⌘↵ sends"}
          </span>
        </div>
      </div>
    </div>
  );
}

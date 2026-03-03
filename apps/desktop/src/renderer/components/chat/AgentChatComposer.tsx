import { useEffect, useMemo, useRef, useState } from "react";
import { At, Image, Pause, Square, X, Hash, PaperPlaneTilt, Lightning } from "@phosphor-icons/react";
import type {
  AgentChatApprovalDecision,
  AgentChatFileRef,
  AgentChatPermissionMode,
  ContextPackOption
} from "../../../shared/types";
import { getModelById } from "../../../shared/modelRegistry";
import { cn } from "../ui/cn";
import { UnifiedModelSelector } from "../shared/UnifiedModelSelector";

const SLASH_COMMANDS = [
  { command: "/plan", label: "Plan", description: "Create a development plan", category: "Generate" },
  { command: "/review", label: "Review", description: "Review code changes", category: "Generate" },
  { command: "/help", label: "Help", description: "Show available commands", category: "Info" },
  { command: "/clear", label: "Clear", description: "Clear chat history", category: "Action" },
  { command: "/model", label: "Model", description: "Change the model", category: "Settings" },
  { command: "/effort", label: "Effort", description: "Change reasoning effort", category: "Settings" }
];

type PermissionOption = {
  value: AgentChatPermissionMode;
  label: string;
};

function getPermissionOptions(opts: {
  provider: string;
  isCliWrapped: boolean;
}): PermissionOption[] {
  if (opts.provider === "claude" && opts.isCliWrapped) {
    return [
      { value: "plan", label: "Plan" },
      { value: "edit", label: "Edits" },
      { value: "full-auto", label: "Auto" },
    ];
  }
  if (opts.provider === "codex") {
    return [
      { value: "plan", label: "Default" },
      { value: "full-auto", label: "Auto" },
    ];
  }
  return [
    { value: "plan", label: "Plan" },
    { value: "edit", label: "Edit" },
    { value: "full-auto", label: "Auto" },
  ];
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

  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const canAttach = !turnActive;

  const attachedPaths = useMemo(() => new Set(attachments.map((attachment) => attachment.path)), [attachments]);
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
    const timeout = window.setTimeout(() => {
      attachmentInputRef.current?.focus();
    }, 0);
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
          setAttachmentResults(results.filter((result) => !attachedPaths.has(result.path)));
          setAttachmentCursor(0);
        })
        .catch(() => {
          if (cancelled) return;
          setAttachmentResults([]);
        })
        .finally(() => {
          if (!cancelled) setAttachmentBusy(false);
        });
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [attachmentPickerOpen, attachmentQuery, attachedPaths, onSearchAttachments]);

  /* ── Context pack picker ── */
  useEffect(() => {
    if (!contextPickerOpen) {
      setContextCursor(0);
      return;
    }
    if (!laneId) return;

    let cancelled = false;
    window.ade.agentChat
      .listContextPacks({ laneId })
      .then((packs) => {
        if (!cancelled) {
          setContextPacks(packs);
          setContextCursor(0);
        }
      })
      .catch(() => {
        if (!cancelled) setContextPacks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [contextPickerOpen, laneId]);

  const selectAttachment = (attachment: AgentChatFileRef) => {
    onAddAttachment(attachment);
    setAttachmentPickerOpen(false);
  };

  const handleSlashSelect = (cmd: (typeof SLASH_COMMANDS)[number]) => {
    setSlashPickerOpen(false);
    setSlashQuery("");

    if (cmd.command === "/clear" && onClearEvents) {
      onClearEvents();
      onDraftChange("");
      return;
    }
    if (cmd.command === "/plan" || cmd.command === "/review") {
      onDraftChange(`${cmd.command} ${draft}`);
      return;
    }
    onDraftChange(`${cmd.command} `);
  };

  const toggleContextPack = (pack: ContextPackOption) => {
    const isSelected = selectedContextPacks.some(
      (p) => p.scope === pack.scope && p.featureKey === pack.featureKey && p.missionId === pack.missionId
    );
    if (isSelected) {
      onContextPacksChange(
        selectedContextPacks.filter(
          (p) => !(p.scope === pack.scope && p.featureKey === pack.featureKey && p.missionId === pack.missionId)
        )
      );
    } else {
      onContextPacksChange([...selectedContextPacks, pack]);
    }
  };

  const removeContextPack = (pack: ContextPackOption) => {
    onContextPacksChange(
      selectedContextPacks.filter(
        (p) => !(p.scope === pack.scope && p.featureKey === pack.featureKey && p.missionId === pack.missionId)
      )
    );
  };

  const permissionOptions = getPermissionOptions({
    provider: sessionProvider ?? "unified",
    isCliWrapped: sessionIsCliWrapped ?? false,
  });

  return (
    <div className="border-t border-border/10 bg-gradient-to-b from-surface/60 to-surface/40">
      {/* ── Pending approval banner ── */}
      {pendingApproval ? (
        <div className="border-b border-amber-500/10 bg-gradient-to-r from-amber-500/[0.05] to-transparent px-4 py-3">
          <div className="mb-1 flex items-center gap-2">
            <Lightning size={12} weight="bold" className="text-amber-500" />
            <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-fg/80">Approval · {pendingApproval.kind}</span>
          </div>
          <div className="mb-2.5 text-[12px] text-fg/70">{pendingApproval.description}</div>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              className="border border-accent/40 bg-accent/15 px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-fg transition-colors hover:bg-accent/25"
              onClick={() => onApproval("accept")}
            >
              Accept
            </button>
            <button
              type="button"
              className="border border-accent/20 px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-fg/70 transition-colors hover:bg-accent/10"
              onClick={() => onApproval("accept_for_session")}
            >
              Accept All
            </button>
            <button
              type="button"
              className="border border-border/25 px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-fg/50 transition-colors hover:bg-border/15"
              onClick={() => onApproval("decline")}
            >
              Decline
            </button>
          </div>
        </div>
      ) : null}

      {/* ── Attachments bar ── */}
      {attachments.length ? (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border/12 px-4 py-2">
          <At size={11} weight="bold" className="text-accent/40" />
          {attachments.map((attachment) => (
            <span key={attachment.path} className="inline-flex items-center gap-1 border border-accent/15 bg-accent/[0.04] px-2 py-0.5 font-mono text-[10px] text-fg/70">
              {attachment.type === "image" ? <Image size={10} weight="bold" /> : <At size={10} weight="bold" />}
              <span className="max-w-[200px] truncate">{attachment.path}</span>
              <button
                type="button"
                className="ml-0.5 text-fg/40 transition-colors hover:text-fg/80"
                title={`Remove ${attachment.path}`}
                onClick={() => onRemoveAttachment(attachment.path)}
              >
                <X size={10} weight="bold" />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {/* ── Context packs bar ── */}
      {selectedContextPacks.length ? (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border/12 px-4 py-2">
          <Hash size={11} weight="bold" className="text-violet-400/40" />
          {selectedContextPacks.map((pack) => (
            <span key={`${pack.scope}:${pack.featureKey ?? ""}:${pack.missionId ?? ""}`} className="inline-flex items-center gap-1 border border-violet-500/15 bg-violet-500/[0.04] px-2 py-0.5 font-mono text-[10px] text-fg/70">
              <span className="max-w-[180px] truncate">{pack.label}</span>
              <button
                type="button"
                className="ml-0.5 text-muted-fg/40 transition-colors hover:text-fg/80"
                title={`Remove ${pack.label}`}
                onClick={() => removeContextPack(pack)}
              >
                <X size={10} weight="bold" />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {/* ── Attachment picker dropdown ── */}
      {attachmentPickerOpen ? (
        <div className="border-b border-border/10 bg-surface-recessed/80">
          <div className="flex items-center gap-2 border-b border-border/10 px-4 py-2">
            <At size={12} weight="bold" className="text-accent/40" />
            <input
              ref={attachmentInputRef}
              value={attachmentQuery}
              onChange={(event) => setAttachmentQuery(event.target.value)}
              placeholder="Search files..."
              className="h-6 flex-1 bg-transparent font-mono text-[11px] text-fg/80 outline-none placeholder:text-muted-fg/30"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setAttachmentPickerOpen(false);
                  return;
                }
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setAttachmentCursor((value) => Math.min(value + 1, Math.max(attachmentResults.length - 1, 0)));
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setAttachmentCursor((value) => Math.max(value - 1, 0));
                  return;
                }
                if (event.key === "Enter") {
                  const candidate = attachmentResults[attachmentCursor];
                  if (!candidate) return;
                  event.preventDefault();
                  selectAttachment(candidate);
                }
              }}
            />
          </div>
          <div className="max-h-40 overflow-auto py-1">
            {!attachmentQuery.trim().length ? (
              <div className="px-4 py-2 font-mono text-[10px] text-muted-fg/30">Type to search files...</div>
            ) : attachmentBusy ? (
              <div className="px-4 py-2 font-mono text-[10px] text-muted-fg/30">Searching...</div>
            ) : attachmentResults.length ? (
              attachmentResults.map((result, index) => (
                <button
                  key={result.path}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 px-4 py-1.5 text-left font-mono text-[10px] text-fg/70",
                    index === attachmentCursor ? "bg-accent/10 text-fg/90" : "hover:bg-border/8"
                  )}
                  onMouseEnter={() => setAttachmentCursor(index)}
                  onClick={() => selectAttachment(result)}
                >
                  {result.type === "image" ? <Image size={12} weight="bold" className="text-accent/50" /> : <At size={12} weight="bold" className="text-muted-fg/30" />}
                  <span className="truncate">{result.path}</span>
                </button>
              ))
            ) : (
              <div className="px-4 py-2 font-mono text-[10px] text-muted-fg/30">No matching files.</div>
            )}
          </div>
        </div>
      ) : null}

      {/* ── Main input area ── */}
      <div className="relative">
        {/* Slash command picker */}
        {slashPickerOpen && filteredSlashCommands.length > 0 ? (
          <div className="absolute bottom-full left-0 z-10 mb-0 w-72 border border-border/15 bg-[#0F0D14]/98 shadow-[0_-8px_32px_-8px_rgba(0,0,0,0.7)]">
            <div className="border-b border-border/8 px-3 py-1.5 font-mono text-[9px] font-bold uppercase tracking-[2px] text-muted-fg/25">
              Commands
            </div>
            <div className="max-h-52 overflow-auto py-1">
              {filteredSlashCommands.map((cmd, index) => (
                <button
                  key={cmd.command}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-3 px-3 py-1.5 text-left font-mono text-[10px]",
                    index === slashCursor ? "bg-accent/10 text-fg" : "text-fg/60 hover:bg-border/8"
                  )}
                  onMouseEnter={() => setSlashCursor(index)}
                  onClick={() => handleSlashSelect(cmd)}
                >
                  <span className="w-14 text-accent/70">{cmd.command}</span>
                  <span className="flex-1 text-fg/50">{cmd.description}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {/* Context pack picker */}
        {contextPickerOpen ? (
          <div className="absolute bottom-full left-0 z-10 mb-0 w-80 border border-border/15 bg-[#0F0D14]/98 shadow-[0_-8px_32px_-8px_rgba(0,0,0,0.7)]">
            <div className="border-b border-border/8 px-3 py-1.5 font-mono text-[9px] font-bold uppercase tracking-[2px] text-muted-fg/25">
              Context Packs
            </div>
            <div className="max-h-52 overflow-auto py-1">
              {contextPacks.length ? (
                contextPacks.map((pack, index) => {
                  const isSelected = selectedContextPacks.some(
                    (p) => p.scope === pack.scope && p.featureKey === pack.featureKey && p.missionId === pack.missionId
                  );
                  return (
                    <button
                      key={`${pack.scope}:${pack.featureKey ?? ""}:${pack.missionId ?? ""}`}
                      type="button"
                      className={cn(
                        "flex w-full items-center gap-3 px-3 py-1.5 text-left font-mono text-[10px]",
                        index === contextCursor ? "bg-accent/10" : "hover:bg-border/8",
                        !pack.available && "opacity-30"
                      )}
                      disabled={!pack.available}
                      onMouseEnter={() => setContextCursor(index)}
                      onClick={() => toggleContextPack(pack)}
                    >
                      <span className={cn(
                        "flex h-3.5 w-3.5 items-center justify-center border text-[9px]",
                        isSelected ? "border-violet-400/50 bg-violet-500/15 text-violet-300" : "border-border/25 text-transparent"
                      )}>
                        {isSelected ? "\u2713" : ""}
                      </span>
                      <div className="flex-1">
                        <div className="text-fg/75">{pack.label}</div>
                        <div className="text-[9px] text-muted-fg/35">{pack.description}</div>
                      </div>
                    </button>
                  );
                })
              ) : (
                <div className="px-3 py-2 font-mono text-[10px] text-muted-fg/30">No context packs available.</div>
              )}
            </div>
            <div className="border-t border-border/12 px-3 py-1.5">
              <button
                type="button"
                className="font-mono text-[10px] text-accent/50 hover:text-accent"
                onClick={() => setContextPickerOpen(false)}
              >
                Done
              </button>
            </div>
          </div>
        ) : null}

        {/* Textarea + send */}
        <div className="flex items-end">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => {
              const val = event.target.value;
              onDraftChange(val);

              if (slashPickerOpen && !val.startsWith("/")) {
                setSlashPickerOpen(false);
                setSlashQuery("");
              }
              if (slashPickerOpen && val.startsWith("/")) {
                setSlashQuery(val.slice(1));
                setSlashCursor(0);
              }
            }}
            className={cn(
              "min-h-[56px] max-h-[200px] flex-1 resize-none bg-transparent px-4 py-3 font-mono text-[12px] leading-[1.6] text-fg/85",
              "outline-none placeholder:text-muted-fg/25"
            )}
            placeholder={turnActive ? "Steer the active turn..." : "Message the agent..."}
            onKeyDown={(event) => {
              const commandModified = event.metaKey || event.ctrlKey;

              /* Slash picker keyboard */
              if (slashPickerOpen) {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setSlashPickerOpen(false);
                  setSlashQuery("");
                  return;
                }
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setSlashCursor((v) => Math.min(v + 1, Math.max(filteredSlashCommands.length - 1, 0)));
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setSlashCursor((v) => Math.max(v - 1, 0));
                  return;
                }
                if (event.key === "Enter") {
                  const cmd = filteredSlashCommands[slashCursor];
                  if (cmd) {
                    event.preventDefault();
                    handleSlashSelect(cmd);
                    return;
                  }
                }
                if (event.key === "Tab") {
                  const cmd = filteredSlashCommands[slashCursor];
                  if (cmd) {
                    event.preventDefault();
                    handleSlashSelect(cmd);
                    return;
                  }
                }
              }

              /* Context picker keyboard */
              if (contextPickerOpen) {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setContextPickerOpen(false);
                  return;
                }
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setContextCursor((v) => Math.min(v + 1, Math.max(contextPacks.length - 1, 0)));
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setContextCursor((v) => Math.max(v - 1, 0));
                  return;
                }
                if (event.key === "Enter") {
                  const pack = contextPacks[contextCursor];
                  if (pack && pack.available) {
                    event.preventDefault();
                    toggleContextPack(pack);
                    return;
                  }
                }
              }

              /* Trigger slash picker */
              if (event.key === "/" && draft.length === 0 && !commandModified && !event.altKey) {
                event.preventDefault();
                window.setTimeout(() => {
                  setSlashPickerOpen(true);
                  setSlashQuery("");
                  setSlashCursor(0);
                }, 0);
                return;
              }

              /* Trigger context picker */
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
                if (attachmentPickerOpen) {
                  setAttachmentPickerOpen(false);
                  return;
                }
                if (pendingApproval) {
                  onApproval("cancel");
                  return;
                }
                if (draft.length) {
                  onDraftChange("");
                }
                return;
              }

              if (event.key === "." && commandModified && turnActive) {
                event.preventDefault();
                onInterrupt();
                return;
              }

              if (event.key !== "Enter" || event.shiftKey) return;
              const commandEnter = commandModified;
              const shouldSend = sendOnEnter ? !commandEnter : commandEnter;
              if (!shouldSend) return;
              event.preventDefault();
              onSubmit();
            }}
          />

          <div className="flex items-center gap-1 px-2 pb-3">
            {turnActive ? (
              <button
                type="button"
                className="flex h-8 w-8 items-center justify-center border border-red-500/25 bg-red-500/[0.06] text-red-400/70 transition-colors hover:bg-red-500/15 hover:text-red-400"
                title="Interrupt (Cmd+.)"
                onClick={onInterrupt}
              >
                <Square size={14} weight="fill" />
              </button>
            ) : null}

            <button
              type="button"
              className={cn(
                "flex h-8 w-8 items-center justify-center border transition-all",
                busy || !draft.trim().length
                  ? "border-border/15 text-muted-fg/20"
                  : "border-accent/30 bg-accent/10 text-accent hover:bg-accent/20"
              )}
              disabled={busy || !draft.trim().length}
              onClick={onSubmit}
              title={turnActive ? "Steer" : "Send"}
            >
              {busy ? (
                <Pause size={14} weight="fill" />
              ) : (
                <PaperPlaneTilt size={14} weight="fill" />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* ── Toolbar row ── */}
      <div className="flex flex-wrap items-center gap-2 border-t border-border/12 px-3 py-1.5">
        {/* Model selector — compact pill with color dot */}
        <div className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-1.5 w-1.5 flex-shrink-0"
            style={{ backgroundColor: selectedModel?.color ?? "#A78BFA" }}
          />
          <UnifiedModelSelector
            value={modelId}
            onChange={onModelChange}
            availableModelIds={availableModelIds}
            showReasoning
            reasoningEffort={reasoningEffort}
            onReasoningEffortChange={onReasoningEffortChange}
          />
        </div>

        {/* Permission mode */}
        {permissionMode && onPermissionModeChange ? (
          <div className="inline-flex border border-border/15">
            {permissionOptions.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={cn(
                  "px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider transition-colors",
                  permissionMode === opt.value
                    ? "bg-accent/15 text-accent"
                    : "text-muted-fg/30 hover:text-muted-fg/60"
                )}
                onClick={() => onPermissionModeChange(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        ) : null}

        {/* Quick actions + send hint */}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            className={cn(
              "px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider transition-colors",
              canAttach ? "text-muted-fg/30 hover:text-accent/60" : "text-muted-fg/15"
            )}
            disabled={!canAttach}
            onClick={() => canAttach && setAttachmentPickerOpen((open) => !open)}
            title="Attach files (@)"
          >
            @
          </button>
          <button
            type="button"
            className="px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-muted-fg/30 transition-colors hover:text-accent/60"
            onClick={() => setContextPickerOpen((open) => !open)}
            title="Context packs (#)"
          >
            #
          </button>
          <span className="text-border/15">|</span>
          <span className="font-mono text-[9px] text-muted-fg/20">
            {sendOnEnter ? "⏎ send" : "⌘⏎ send"}
          </span>
          {turnActive ? (
            <>
              <span className="text-border/15">|</span>
              <span className="font-mono text-[9px] text-muted-fg/20">⌘. stop</span>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

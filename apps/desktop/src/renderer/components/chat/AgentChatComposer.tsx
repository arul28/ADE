import React, { useEffect, useMemo, useRef, useState } from "react";
import { At, Image, Pause, Play, Square, X, Hash } from "@phosphor-icons/react";
import type {
  AgentChatApprovalDecision,
  AgentChatFileRef,
  ContextPackOption
} from "../../../shared/types";
import { getModelById } from "../../../shared/modelRegistry";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { cn } from "../ui/cn";
import { Kbd } from "../ui/Kbd";
import { UnifiedModelSelector } from "../shared/UnifiedModelSelector";

const SLASH_COMMANDS = [
  { command: "/plan", label: "Plan", description: "Create a development plan", category: "Generate" },
  { command: "/review", label: "Review", description: "Review code changes", category: "Generate" },
  { command: "/help", label: "Help", description: "Show available commands", category: "Info" },
  { command: "/clear", label: "Clear", description: "Clear chat history", category: "Action" },
  { command: "/model", label: "Model", description: "Change the model", category: "Settings" },
  { command: "/effort", label: "Effort", description: "Change reasoning effort", category: "Settings" }
];

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
  const reasoningTiers = selectedModel?.reasoningTiers ?? [];

  /* ── Slash command filtering ── */
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

  /* ── Context pack picker: fetch packs on open ── */
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
    // For /model, /effort, /help — insert as text
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

  return (
    <div className="rounded-lg border border-border/40 bg-card/70 p-2.5 shadow-[0_1px_0_rgba(255,255,255,0.03)]">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <label className="inline-flex items-center gap-1 text-xs text-muted-fg">
          Model
          <UnifiedModelSelector
            value={modelId}
            onChange={onModelChange}
            availableModelIds={availableModelIds}
            showReasoning
            reasoningEffort={reasoningEffort}
            onReasoningEffortChange={onReasoningEffortChange}
          />
        </label>

        {turnActive ? (
          <Chip className="bg-accent/20 text-[11px] text-fg/90">
            <Play size={12} weight="regular" className="mr-1" />
            Steering active turn
          </Chip>
        ) : null}

        <Button
          size="sm"
          variant={attachmentPickerOpen ? "primary" : "outline"}
          className="h-7 px-2 text-[11px]"
          disabled={!canAttach}
          onClick={() => {
            if (!canAttach) return;
            setAttachmentPickerOpen((open) => !open);
          }}
          title={canAttach ? "Attach files to the next message" : "Attachments are disabled while steering"}
        >
          <At size={14} weight="regular" />
          Attach
        </Button>
      </div>

      {selectedModel ? (
        <div className="mb-2 rounded border border-border/30 bg-bg/40 px-2 py-1 text-[11px] text-muted-fg">
          <span className="inline-block h-2 w-2 rounded-full mr-1" style={{ backgroundColor: selectedModel.color }} />
          <span className="font-medium text-fg/80">{selectedModel.displayName}</span>
          <span className="ml-1">{selectedModel.family} &middot; {selectedModel.contextWindow.toLocaleString()} ctx</span>
          {reasoningEffort && reasoningTiers.length > 0 ? <span className="ml-1">&middot; reasoning: {reasoningEffort}</span> : null}
        </div>
      ) : null}

      {pendingApproval ? (
        <div className="mb-2 rounded border border-amber-400/35 bg-amber-500/10 px-2 py-1.5 text-[11px]">
          <div className="font-semibold text-fg/90">Approval pending · {pendingApproval.kind}</div>
          <div className="mt-0.5 text-fg/80">{pendingApproval.description}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            <Button size="sm" className="h-6 px-2 text-[11px]" onClick={() => onApproval("accept")}>Accept</Button>
            <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => onApproval("accept_for_session")}>Accept Session</Button>
            <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => onApproval("decline")}>Decline</Button>
            <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => onApproval("cancel")}>Dismiss</Button>
          </div>
        </div>
      ) : null}

      {attachments.length ? (
        <div className="mb-2 flex flex-wrap items-center gap-1.5 rounded border border-border/30 bg-bg/40 px-2 py-1.5">
          {attachments.map((attachment) => (
            <Chip key={attachment.path} className="flex items-center gap-1 bg-accent/15 text-[11px] text-fg">
              {attachment.type === "image" ? <Image size={12} weight="regular" /> : <At size={12} weight="regular" />}
              <span className="max-w-[220px] truncate">{attachment.path}</span>
              <button
                type="button"
                className="inline-flex items-center rounded p-0.5 text-fg/70 hover:bg-muted/40 hover:text-fg"
                title={`Remove ${attachment.path}`}
                onClick={() => onRemoveAttachment(attachment.path)}
              >
                <X size={12} weight="regular" />
              </button>
            </Chip>
          ))}
        </div>
      ) : null}

      {selectedContextPacks.length ? (
        <div className="mb-2 flex flex-wrap items-center gap-1.5 rounded border border-violet-500/20 bg-violet-500/[0.04] px-2 py-1.5">
          <Hash size={12} weight="regular" className="text-violet-400/60" />
          {selectedContextPacks.map((pack) => (
            <Chip key={`${pack.scope}:${pack.featureKey ?? ""}:${pack.missionId ?? ""}`} className="flex items-center gap-1 bg-violet-500/15 text-[11px] text-fg/80">
              <span className="max-w-[200px] truncate">{pack.label}</span>
              <button
                type="button"
                className="inline-flex items-center rounded p-0.5 text-muted-fg/70 hover:bg-muted/40 hover:text-fg"
                title={`Remove ${pack.label}`}
                onClick={() => removeContextPack(pack)}
              >
                <X size={12} weight="regular" />
              </button>
            </Chip>
          ))}
        </div>
      ) : null}

      {attachmentPickerOpen ? (
        <div className="mb-2 rounded border border-border/40 bg-bg/60">
          <div className="flex items-center gap-2 border-b border-border/30 px-2 py-1.5">
            <At size={14} weight="regular" className="text-muted-fg" />
            <input
              ref={attachmentInputRef}
              value={attachmentQuery}
              onChange={(event) => setAttachmentQuery(event.target.value)}
              placeholder="Search files in this lane..."
              className="h-7 flex-1 rounded border border-border/30 bg-bg/60 px-2 text-xs outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/30"
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
          <div className="max-h-44 overflow-auto px-1 py-1">
            {!attachmentQuery.trim().length ? (
              <div className="px-2 py-1.5 text-[11px] text-muted-fg">Type to fuzzy-search files.</div>
            ) : attachmentBusy ? (
              <div className="px-2 py-1.5 text-[11px] text-muted-fg">Searching...</div>
            ) : attachmentResults.length ? (
              attachmentResults.map((result, index) => (
                <button
                  key={result.path}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] text-fg/90",
                    index === attachmentCursor ? "bg-accent/20 text-fg" : "hover:bg-border/20"
                  )}
                  onMouseEnter={() => setAttachmentCursor(index)}
                  onClick={() => selectAttachment(result)}
                >
                  {result.type === "image" ? <Image size={14} weight="regular" className="text-accent/80" /> : <At size={14} weight="regular" className="text-muted-fg" />}
                  <span className="truncate">{result.path}</span>
                </button>
              ))
            ) : (
              <div className="px-2 py-1.5 text-[11px] text-muted-fg">No matching files.</div>
            )}
          </div>
        </div>
      ) : null}

      <div className="relative">
        {/* ── Slash command picker ── */}
        {slashPickerOpen && filteredSlashCommands.length > 0 ? (
          <div className="absolute bottom-full left-0 z-10 mb-1 w-72 rounded-lg border border-border/40 bg-bg/95 shadow-lg shadow-black/20 backdrop-blur-sm">
            <div className="border-b border-border/20 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-widest text-muted-fg/60">
              Commands
            </div>
            <div className="max-h-52 overflow-auto py-1">
              {filteredSlashCommands.map((cmd, index) => (
                <button
                  key={cmd.command}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-3 px-3 py-1.5 text-left text-[11px]",
                    index === slashCursor ? "bg-accent/20 text-fg" : "text-fg/80 hover:bg-border/15"
                  )}
                  onMouseEnter={() => setSlashCursor(index)}
                  onClick={() => handleSlashSelect(cmd)}
                >
                  <span className="w-16 font-mono text-accent/80">{cmd.command}</span>
                  <span className="flex-1 text-fg/70">{cmd.description}</span>
                  <span className="text-[11px] text-muted-fg/50">{cmd.category}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {/* ── Context pack picker ── */}
        {contextPickerOpen ? (
          <div className="absolute bottom-full left-0 z-10 mb-1 w-80 rounded-lg border border-border/40 bg-bg/95 shadow-lg shadow-black/20 backdrop-blur-sm">
            <div className="border-b border-border/20 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-widest text-muted-fg/60">
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
                        "flex w-full items-center gap-3 px-3 py-1.5 text-left text-[11px]",
                        index === contextCursor ? "bg-accent/20" : "hover:bg-border/15",
                        !pack.available && "opacity-40"
                      )}
                      disabled={!pack.available}
                      onMouseEnter={() => setContextCursor(index)}
                      onClick={() => {
                        toggleContextPack(pack);
                      }}
                    >
                      <span className={cn(
                        "flex h-4 w-4 items-center justify-center rounded border text-[11px]",
                        isSelected ? "border-violet-400/60 bg-violet-500/20 text-violet-300" : "border-border/40 text-transparent"
                      )}>
                        {isSelected ? "\u2713" : ""}
                      </span>
                      <div className="flex-1">
                        <div className="font-medium text-fg/85">{pack.label}</div>
                        <div className="text-[11px] text-muted-fg/60">{pack.description}</div>
                      </div>
                      <span className="text-[11px] text-muted-fg/40">{pack.scope}</span>
                    </button>
                  );
                })
              ) : (
                <div className="px-3 py-2 text-[11px] text-muted-fg">No context packs available.</div>
              )}
            </div>
            <div className="border-t border-border/20 px-3 py-1.5">
              <button
                type="button"
                className="text-[11px] text-accent/70 hover:text-accent"
                onClick={() => setContextPickerOpen(false)}
              >
                Done
              </button>
            </div>
          </div>
        ) : null}

        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => {
              const val = event.target.value;
              onDraftChange(val);

              // Close slash picker when draft no longer starts with /
              if (slashPickerOpen && !val.startsWith("/")) {
                setSlashPickerOpen(false);
                setSlashQuery("");
              }
              // Update slash query while picker is open
              if (slashPickerOpen && val.startsWith("/")) {
                setSlashQuery(val.slice(1));
                setSlashCursor(0);
              }
            }}
            className={cn(
              "min-h-[64px] flex-1 resize-y rounded border border-border/40 bg-bg/70 px-2 py-1.5 text-xs leading-relaxed",
              "outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/30"
            )}
            placeholder={turnActive ? "Steer the active turn..." : "Ask the AI agent to work in this lane..."}
            onKeyDown={(event) => {
              const commandModified = event.metaKey || event.ctrlKey;

              /* ── Slash picker keyboard handling ── */
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

              /* ── Context picker keyboard handling ── */
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

              /* ── Trigger slash picker on / at start of empty draft ── */
              if (event.key === "/" && draft.length === 0 && !commandModified && !event.altKey) {
                // Let the character enter, then open picker on next tick
                window.setTimeout(() => {
                  setSlashPickerOpen(true);
                  setSlashQuery("");
                  setSlashCursor(0);
                }, 0);
                return;
              }

              /* ── Trigger context pack picker on # ── */
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

          {turnActive ? (
            <Button
              variant="outline"
              className="h-9"
              title="Interrupt active turn"
              onClick={onInterrupt}
            >
              <Square size={14} weight="regular" />
              Stop
            </Button>
          ) : null}

          <Button className="h-9" disabled={busy || !draft.trim().length} onClick={onSubmit}>
            {busy ? (
              <>
                <Pause size={14} weight="regular" />
                Sending
              </>
            ) : turnActive ? (
              <>
                <Play size={14} weight="regular" />
                Steer
              </>
            ) : (
              <>
                <Play size={14} weight="regular" />
                Send
              </>
            )}
          </Button>
        </div>
      </div>

      <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-fg/70">
        <span className="inline-flex items-center gap-1"><Kbd className="px-1 py-0 text-[9px]">@</Kbd> files</span>
        <span className="text-border/40">|</span>
        <span className="inline-flex items-center gap-1"><Kbd className="px-1 py-0 text-[9px]">/</Kbd> commands</span>
        <span className="text-border/40">|</span>
        <span className="inline-flex items-center gap-1"><Kbd className="px-1 py-0 text-[9px]">#</Kbd> context</span>
        <span className="text-border/40">—</span>
        <span>
          {sendOnEnter ? (
            <>
              <Kbd className="px-1 py-0 text-[9px]">Enter</Kbd> send, <Kbd className="px-1 py-0 text-[9px]">Shift+Enter</Kbd> newline
            </>
          ) : (
            <>
              <Kbd className="px-1 py-0 text-[9px]">Cmd+Enter</Kbd> send, <Kbd className="px-1 py-0 text-[9px]">Enter</Kbd> newline
            </>
          )}
        </span>
        {turnActive ? (
          <>
            <span className="text-border/40">|</span>
            <span><Kbd className="px-1 py-0 text-[9px]">Cmd+.</Kbd> interrupt</span>
          </>
        ) : null}
      </div>
    </div>
  );
}

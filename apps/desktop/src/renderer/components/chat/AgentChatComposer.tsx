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

// Safety level drives colors for the active button tint and the hover pane left border
type SafetyLevel = "safe" | "semi-auto" | "full-auto" | "danger" | "custom";

type PermissionOption = {
  value: AgentChatPermissionMode;
  label: string;
  shortDesc: string;       // 1-line summary shown in button tooltip
  detail: string;          // 2-3 line expanded explanation
  allows: string[];        // green checkmarks
  gates?: string[];        // yellow "requires approval" items
  blocks?: string[];       // red "blocked" items
  warning?: string;        // red warning box if dangerous
  safety: SafetyLevel;
};

function getPermissionOptions(opts: {
  family: string;
  isCliWrapped: boolean;
}): PermissionOption[] {
  // Claude CLI models (anthropic)
  if (opts.isCliWrapped && opts.family === "anthropic") {
    return [
      {
        value: "default",
        label: "Default",
        shortDesc: "Prompts before each tool type on first use",
        detail: "Standard behavior. Read operations are free; writes, edits, and Bash commands require your approval on first use per session.",
        allows: ["File reads", "Grep / Glob / LS", "Plan generation"],
        gates: ["File writes & edits", "Bash commands", "WebFetch / WebSearch", "Subagent (Task) spawning"],
        safety: "safe",
      },
      {
        value: "edit",
        label: "Accept Edits",
        shortDesc: "File ops auto-approved; shell still gates",
        detail: "Read, Write, Edit, and MultiEdit are auto-approved for the session. Bash, WebFetch, and Task spawning still require manual approval on first invocation.",
        allows: ["File reads", "File writes & edits", "Grep / Glob / LS"],
        gates: ["Bash commands", "WebFetch / WebSearch", "Subagent (Task) spawning"],
        safety: "semi-auto",
      },
      {
        value: "plan",
        label: "Plan",
        shortDesc: "Read-only — no writes or shell execution",
        detail: "Analysis-only mode. Claude can read files, search the codebase, and produce an implementation plan — but cannot write, edit, or execute any commands.",
        allows: ["Read", "Grep", "Glob", "LS"],
        blocks: ["Write", "Edit", "Bash", "WebFetch", "Task"],
        safety: "safe",
      },
      {
        value: "full-auto",
        label: "Bypass",
        shortDesc: "All permission checks disabled",
        detail: "Every tool across all 16 Claude Code tools runs without prompting. No interruptions. Designed for containerized or fully sandboxed CI environments.",
        allows: ["All 16 tools \u2014 unrestricted"],
        warning: "\u26a0 Only safe in containers, VMs, or sandboxed environments where actions can be reverted.",
        safety: "danger",
      },
    ];
  }

  // Codex CLI (openai)
  if (opts.isCliWrapped && opts.family === "openai") {
    return [
      {
        value: "plan",
        label: "Default",
        shortDesc: "Propose-only \u2014 approval required for everything",
        detail: "Read-only sandbox with untrusted approval policy. Codex explores and proposes; every shell command and file patch requires your go-ahead before it runs.",
        allows: ["File exploration", "Code search", "Plan generation"],
        gates: ["All shell commands (shell tool)", "All file patches (apply_patch)", "All plan updates (update_plan)"],
        safety: "safe",
      },
      {
        value: "full-auto",
        label: "Full Auto",
        shortDesc: "Unrestricted \u2014 skips all approval prompts",
        detail: "Danger-full-access sandbox, approval policy: never. Codex runs shell commands and applies patches without interruption. No filesystem or network restrictions.",
        allows: ["shell \u2014 unrestricted", "apply_patch \u2014 unrestricted", "Network access"],
        warning: "\u26a0 Removes all sandboxing. Only safe in trusted, isolated environments.",
        safety: "danger",
      },
      {
        value: "config-toml",
        label: "Custom",
        shortDesc: "No flags passed \u2014 uses your codex.toml",
        detail: "No --approval-policy or --sandbox flags are passed to the Codex runtime. Your project codex.toml (or ~/.codex/config.toml) fully controls sandbox and approval behavior.",
        allows: ["Determined by codex.toml"],
        gates: [],
        safety: "custom",
      },
    ];
  }

  // API and local models
  return [
    {
      value: "plan",
      label: "Supervised",
      shortDesc: "Agent requests approval before any file edits or commands",
      detail: "Safest mode for API/local models \u2014 every modification requires your go-ahead before execution.",
      allows: ["File reads", "Code search", "Plan generation"],
      gates: ["File writes & edits", "Bash commands", "Web access", "Agent spawning"],
      safety: "safe",
    },
    {
      value: "edit",
      label: "Auto-Edit",
      shortDesc: "File reads and edits auto-approved; commands need approval",
      detail: "Agent modifies files autonomously but pauses for shell commands, web fetches, and subagent spawning.",
      allows: ["File reads", "File writes & edits", "Code search"],
      gates: ["Bash commands", "Web access", "Agent spawning"],
      safety: "semi-auto",
    },
    {
      value: "full-auto",
      label: "Full Auto",
      shortDesc: "Fully autonomous across all operations \u2014 no interruptions",
      detail: "Agent proceeds without prompting across reads, edits, commands, and web. Recommended only in sandboxed environments.",
      allows: ["Everything"],
      warning: "\u26a0 Only use in isolated/containerized environments.",
      safety: "danger",
    },
  ];
}

// Returns the safety-level badge label
function safetyBadgeLabel(safety: SafetyLevel): string {
  switch (safety) {
    case "safe": return "SAFE";
    case "semi-auto": return "SEMI-AUTO";
    case "full-auto": return "FULL-AUTO";
    case "danger": return "DANGER";
    case "custom": return "CUSTOM";
  }
}

// Returns Tailwind color classes keyed on safety level
function safetyColors(safety: SafetyLevel) {
  switch (safety) {
    case "safe":
      return {
        border: "border-l-emerald-500/60",
        badge: "text-emerald-400/70",
        activeBg: "bg-accent/15 ring-1 ring-accent/25",
      };
    case "semi-auto":
      return {
        border: "border-l-amber-400/60",
        badge: "text-amber-400/70",
        activeBg: "bg-amber-500/10 ring-1 ring-amber-400/20",
      };
    case "full-auto":
      return {
        border: "border-l-red-400/60",
        badge: "text-red-400/70",
        activeBg: "bg-red-500/8 ring-1 ring-red-500/20",
      };
    case "danger":
      return {
        border: "border-l-red-500/70",
        badge: "text-red-400/80",
        activeBg: "bg-red-500/8 ring-1 ring-red-500/20",
      };
    case "custom":
      return {
        border: "border-l-violet-500/60",
        badge: "text-violet-400/70",
        activeBg: "bg-accent/15 ring-1 ring-accent/25",
      };
  }
}

// Rich hover pane rendered above the button
function PermissionHoverPane({ opt }: { opt: PermissionOption }) {
  const colors = safetyColors(opt.safety);
  const badgeLabel = safetyBadgeLabel(opt.safety);

  return (
    <div
      className={cn(
        "pointer-events-none absolute z-50 w-[260px]",
        "border border-violet-500/20 bg-[#0D0B13]",
        "border-l-2",
        colors.border
      )}
      style={{
        bottom: "calc(100% + 8px)",
        left: "50%",
        transform: "translateX(-50%)",
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-violet-500/10 px-3 py-2">
        <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-fg/85">
          {opt.label}
        </span>
        <span className={cn("ml-auto font-mono text-[9px] font-bold uppercase tracking-widest", colors.badge)}>
          {badgeLabel}
        </span>
      </div>

      {/* Body */}
      <div className="space-y-2.5 px-3 py-2.5">
        {/* Detail */}
        <p className="font-mono text-[11px] leading-[1.5] text-fg/65">
          {opt.detail}
        </p>

        {/* Allows */}
        {opt.allows.length > 0 && (
          <div className="space-y-1">
            {opt.allows.map((item) => (
              <div key={item} className="flex items-start gap-1.5">
                <span className="mt-0.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-emerald-400/70" />
                <span className="font-mono text-[10px] text-emerald-400/80">{item}</span>
              </div>
            ))}
          </div>
        )}

        {/* Gates */}
        {opt.gates && opt.gates.length > 0 && (
          <div className="space-y-1">
            {opt.gates.map((item) => (
              <div key={item} className="flex items-start gap-1.5">
                <span className="mt-0.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-amber-400/70" />
                <span className="font-mono text-[10px] text-amber-400/70">{item}</span>
              </div>
            ))}
          </div>
        )}

        {/* Blocks */}
        {opt.blocks && opt.blocks.length > 0 && (
          <div className="space-y-1">
            {opt.blocks.map((item) => (
              <div key={item} className="flex items-start gap-1.5">
                <span className="mt-0.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-red-400/70" />
                <span className="font-mono text-[10px] text-red-400/70">{item}</span>
              </div>
            ))}
          </div>
        )}

        {/* Warning */}
        {opt.warning && (
          <div className="border border-red-500/20 bg-red-500/[0.08] px-2 py-1.5">
            <span className="font-mono text-[10px] leading-[1.4] text-red-400/80">{opt.warning}</span>
          </div>
        )}
      </div>

      {/* Arrow pointing down */}
      <div
        className="absolute left-1/2 top-full -translate-x-1/2 border-[5px] border-transparent border-t-violet-500/20"
        style={{ borderTopColor: "rgba(139, 92, 246, 0.20)" }}
      />
      {/* Arrow inner fill */}
      <div
        className="absolute left-1/2 top-full -translate-x-1/2"
        style={{
          borderLeft: "4px solid transparent",
          borderRight: "4px solid transparent",
          borderTop: "4px solid #0D0B13",
          marginTop: "-1px",
        }}
      />
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

  const [hoveredMode, setHoveredMode] = useState<AgentChatPermissionMode | null>(null);

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
    family: selectedModel?.family ?? sessionProvider ?? "unified",
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
        {/* Model selector */}
        <UnifiedModelSelector
          value={modelId}
          onChange={onModelChange}
          availableModelIds={availableModelIds}
          showReasoning
          reasoningEffort={reasoningEffort}
          onReasoningEffortChange={onReasoningEffortChange}
        />

        {/* Permission mode */}
        {permissionMode && onPermissionModeChange && permissionOptions.length > 0 ? (
          <div className="relative inline-flex items-center gap-0.5">
            {permissionOptions.map((opt) => {
              const isActive = permissionMode === opt.value;
              const isHovered = hoveredMode === opt.value;
              const colors = safetyColors(opt.safety);
              return (
                <div key={opt.value} className="relative">
                  <button
                    type="button"
                    className={cn(
                      "inline-flex items-center gap-1 px-2.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider transition-all",
                      isActive
                        ? colors.activeBg + " text-fg/85"
                        : "text-muted-fg/30 hover:bg-border/10 hover:text-muted-fg/60"
                    )}
                    onClick={() => onPermissionModeChange(opt.value)}
                    onMouseEnter={() => setHoveredMode(opt.value)}
                    onMouseLeave={() => setHoveredMode(null)}
                    title={opt.shortDesc}
                  >
                    {opt.label}
                  </button>

                  {/* Rich hover pane */}
                  {isHovered ? <PermissionHoverPane opt={opt} /> : null}
                </div>
              );
            })}
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
            {sendOnEnter ? "\u23ce send" : "\u2318\u23ce send"}
          </span>
          {turnActive ? (
            <>
              <span className="text-border/15">|</span>
              <span className="font-mono text-[9px] text-muted-fg/20">\u2318. stop</span>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

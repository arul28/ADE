import { useEffect, useMemo, useRef, useState } from "react";
import { At, Image, Paperclip, Square, X, Hash, PaperPlaneTilt, Lightning } from "@phosphor-icons/react";
import {
  inferAttachmentType,
  type AgentChatApprovalDecision,
  type AgentChatExecutionMode,
  type AgentChatFileRef,
  type AgentChatPermissionMode,
  type AgentChatSlashCommand,
  type ComputerUseOwnerSnapshot,
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
const CLAUDE_DEFAULT_COMMANDS: SlashCommandEntry[] = [];

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

function ComputerUseSettingsModal({
  open,
  policy,
  snapshot,
  onClose,
  onChange,
  onOpenProof,
}: {
  open: boolean;
  policy: ComputerUsePolicy;
  snapshot: ComputerUseOwnerSnapshot | null;
  onClose: () => void;
  onChange: (policy: ComputerUsePolicy) => void;
  onOpenProof: () => void;
}) {
  if (!open) return null;

  const computerUseAllowed = policy.mode !== "off";
  const activeBackend = snapshot?.activeBackend?.name ?? (policy.allowLocalFallback ? "Fallback allowed" : "No fallback");
  const artifactCount = snapshot?.artifacts.length ?? 0;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-[radial-gradient(circle_at_top,rgba(56,189,248,0.1),rgba(7,10,18,0.88))] px-4 backdrop-blur-md"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-2xl overflow-hidden rounded-[28px] border border-white/[0.08] bg-[linear-gradient(180deg,rgba(15,21,34,0.96),rgba(10,13,22,0.94))] shadow-[0_28px_110px_-36px_rgba(0,0,0,0.82)]">
        <div className="border-b border-white/[0.05] bg-[linear-gradient(90deg,rgba(56,189,248,0.12),transparent)] px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="font-sans text-[15px] font-semibold tracking-tight text-fg/88">Computer use</div>
              <div className="max-w-[44rem] text-[12px] leading-6 text-fg/58">
                Let the agent inspect or control a connected browser or desktop runtime for this chat. If you want it to keep checking a site while it edits, tell it to re-validate after each meaningful change.
              </div>
            </div>
            <button
              type="button"
              className="rounded-[var(--chat-radius-pill)] border border-white/[0.08] bg-white/[0.03] px-3 py-1 font-sans text-[11px] font-medium text-fg/60 transition-colors hover:text-fg/85"
              onClick={onClose}
              title="Close computer-use settings"
            >
              Close
            </button>
          </div>
        </div>

        <div className="space-y-4 px-5 py-5">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1.25fr)_minmax(0,0.9fr)]">
            <div className="rounded-[22px] border border-white/[0.06] bg-white/[0.03] p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="font-sans text-[11px] font-medium uppercase tracking-[0.16em] text-sky-200/60">Access</div>
                  <div className="mt-1 text-[13px] text-fg/82">
                    {computerUseAllowed
                      ? "Connected tools may be used when the task calls for them."
                      : "The agent will stay text-only for this chat."}
                  </div>
                </div>
                <button
                  type="button"
                  className={cn(
                    "rounded-[var(--chat-radius-pill)] border px-3 py-1.5 font-sans text-[11px] font-medium transition-colors",
                    computerUseAllowed
                      ? "border-sky-400/28 bg-sky-500/12 text-sky-200"
                      : "border-white/[0.08] bg-white/[0.03] text-muted-fg/50 hover:text-fg/72",
                  )}
                  onClick={() => onChange({ ...policy, mode: computerUseAllowed ? "off" : "enabled" })}
                  title="Allow the agent to use connected browser or desktop tooling in this chat"
                >
                  {computerUseAllowed ? "Allowed" : "Blocked"}
                </button>
              </div>

              <div className="mt-4 grid gap-2 sm:grid-cols-3">
                <div className="rounded-[18px] border border-white/[0.05] bg-black/10 px-3 py-2">
                  <div className="font-sans text-[10px] uppercase tracking-[0.16em] text-muted-fg/32">Backend</div>
                  <div className="mt-1 text-[12px] text-fg/78">{activeBackend}</div>
                </div>
                <div className="rounded-[18px] border border-white/[0.05] bg-black/10 px-3 py-2">
                  <div className="font-sans text-[10px] uppercase tracking-[0.16em] text-muted-fg/32">Proof</div>
                  <div className="mt-1 text-[12px] text-fg/78">{policy.retainArtifacts ? "Retained" : "Not retained"}</div>
                </div>
                <div className="rounded-[18px] border border-white/[0.05] bg-black/10 px-3 py-2">
                  <div className="font-sans text-[10px] uppercase tracking-[0.16em] text-muted-fg/32">Artifacts</div>
                  <div className="mt-1 text-[12px] text-fg/78">{artifactCount}</div>
                </div>
              </div>
            </div>

            <div className="rounded-[22px] border border-white/[0.06] bg-[linear-gradient(180deg,rgba(18,24,37,0.95),rgba(11,14,23,0.95))] p-4">
              <div className="font-sans text-[11px] font-medium uppercase tracking-[0.16em] text-emerald-200/58">How to use it</div>
              <div className="mt-3 space-y-2 text-[12px] leading-6 text-fg/62">
                <div>Ask directly: “Open `http://localhost:3000`, check desktop and mobile, and keep proof.”</div>
                <div>For ongoing validation, say “re-check after every major UI change.”</div>
                <div>The proof drawer keeps screenshots, traces, logs, and verification output for this chat.</div>
              </div>
              <button
                type="button"
                className="mt-4 rounded-[var(--chat-radius-pill)] border border-emerald-400/20 bg-emerald-500/10 px-3 py-1.5 font-sans text-[11px] font-medium text-emerald-200/85 transition-colors hover:bg-emerald-500/14"
                onClick={onOpenProof}
                title="Open the proof drawer for this chat"
              >
                Open proof drawer
              </button>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <button
              type="button"
              className={cn(
                "rounded-[22px] border px-4 py-3 text-left transition-colors",
                policy.retainArtifacts
                  ? "border-emerald-400/20 bg-emerald-500/10"
                  : "border-white/[0.06] bg-white/[0.03] hover:border-white/[0.1]",
              )}
              onClick={() => onChange({ ...policy, retainArtifacts: !policy.retainArtifacts })}
              title="Retain screenshots, traces, logs, and other proof artifacts for this chat"
            >
              <div className="font-sans text-[12px] font-medium text-fg/84">Retain proof</div>
              <div className="mt-1 text-[11px] leading-5 text-fg/56">
                {policy.retainArtifacts
                  ? "Artifacts stay attached to this chat so you can inspect them in the proof drawer."
                  : "Artifacts are not explicitly retained for review after the tool run finishes."}
              </div>
            </button>

            <button
              type="button"
              className={cn(
                "rounded-[22px] border px-4 py-3 text-left transition-colors",
                policy.allowLocalFallback
                  ? "border-amber-400/20 bg-amber-500/10"
                  : "border-white/[0.06] bg-white/[0.03] hover:border-white/[0.1]",
              )}
              onClick={() => onChange({ ...policy, allowLocalFallback: !policy.allowLocalFallback })}
              title="Allow ADE's local fallback tools if an external computer-use backend is unavailable"
            >
              <div className="font-sans text-[12px] font-medium text-fg/84">Allow local fallback</div>
              <div className="mt-1 text-[11px] leading-5 text-fg/56">
                {policy.allowLocalFallback
                  ? "ADE may fall back to its local runtime when a connected backend is missing or unavailable."
                  : "The chat must rely on connected external tooling only."}
              </div>
            </button>
          </div>

          {snapshot?.summary ? (
            <div className="rounded-[20px] border border-white/[0.05] bg-black/10 px-4 py-3 text-[11px] leading-6 text-fg/56">
              {snapshot.summary}
            </div>
          ) : null}
        </div>
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
  onSubmit,
  onInterrupt,
  onApproval,
  onAddAttachment,
  onRemoveAttachment,
  onSearchAttachments,
  onContextPacksChange,
  onExecutionModeChange,
  onPermissionModeChange,
  includeProjectDocs,
  onIncludeProjectDocsChange,
  onComputerUsePolicyChange,
  onToggleProof,
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
  onSubmit: () => void;
  onInterrupt: () => void;
  onApproval: (decision: AgentChatApprovalDecision) => void;
  onAddAttachment: (attachment: AgentChatFileRef) => void;
  onRemoveAttachment: (path: string) => void;
  onSearchAttachments: (query: string) => Promise<AgentChatFileRef[]>;
  onContextPacksChange: (packs: ContextPackOption[]) => void;
  onExecutionModeChange?: (mode: AgentChatExecutionMode) => void;
  onPermissionModeChange?: (mode: AgentChatPermissionMode) => void;
  includeProjectDocs?: boolean;
  onIncludeProjectDocsChange?: (checked: boolean) => void;
  onComputerUsePolicyChange: (policy: ComputerUsePolicy) => void;
  onToggleProof?: () => void;
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
  const [computerUseModalOpen, setComputerUseModalOpen] = useState(false);

  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const canAttach = !turnActive;

  const attachedPaths = useMemo(() => new Set(attachments.map((a) => a.path)), [attachments]);
  const selectedModel = useMemo(() => getModelById(modelId), [modelId]);
  const computerUseAllowed = computerUsePolicy.mode !== "off";
  const proofButtonLabel = proofArtifactCount > 0 ? `Proof ${proofArtifactCount}` : "Proof";

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
    if (!computerUseModalOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setComputerUseModalOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [computerUseModalOpen]);

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
    <>
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

            <div className="flex shrink-0 items-center gap-1.5">
              <div className="flex items-center rounded-md border border-white/[0.06] bg-white/[0.02]">
                <button
                  type="button"
                  className={cn(
                    "rounded-l-md px-2.5 py-1 font-sans text-[10px] font-medium transition-colors",
                    computerUseAllowed
                      ? "bg-sky-500/12 text-sky-200"
                      : "text-muted-fg/32 hover:text-fg/62",
                  )}
                  onClick={() => onComputerUsePolicyChange({
                    ...computerUsePolicy,
                    mode: computerUseAllowed ? "off" : "enabled",
                  })}
                  title="Allow the agent to use connected browser or desktop tools in this chat"
                >
                  {computerUseAllowed ? "Computer use on" : "Computer use off"}
                </button>
                <button
                  type="button"
                  className="rounded-r-md border-l border-white/[0.06] px-2 py-1 font-sans text-[10px] font-medium text-muted-fg/38 transition-colors hover:text-fg/70"
                  onClick={() => setComputerUseModalOpen(true)}
                  title="Open computer-use settings for this chat"
                >
                  Details
                </button>
              </div>

              <button
                type="button"
                className={cn(
                  "rounded-md border px-2.5 py-1 font-sans text-[10px] font-medium transition-colors",
                  proofOpen
                    ? "border-emerald-400/22 bg-emerald-500/12 text-emerald-200"
                    : computerUsePolicy.retainArtifacts
                      ? "border-white/[0.06] bg-white/[0.02] text-fg/64 hover:text-fg/82"
                      : "border-white/[0.06] bg-white/[0.02] text-muted-fg/32 hover:text-fg/62",
                )}
                onClick={() => onToggleProof?.()}
                title="Open the proof drawer to inspect retained screenshots, traces, logs, and other computer-use artifacts"
              >
                {proofButtonLabel}
              </button>
            </div>

            {!isPersistentIdentitySurface && onIncludeProjectDocsChange && !turnActive ? (
              <button
                type="button"
                className={cn(
                  "flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 font-sans text-[10px] font-medium transition-colors",
                  includeProjectDocs
                    ? "border-accent/25 bg-accent/10 text-accent"
                    : "border-white/[0.06] bg-white/[0.02] text-muted-fg/28 hover:text-muted-fg/50",
                )}
                onClick={() => onIncludeProjectDocsChange(!includeProjectDocs)}
                title="Include project-level context docs (PRD + Architecture) with first message"
              >
                Project Context
              </button>
            ) : null}
          </div>

          {/* Row 2: Model selector + actions */}
          <div className="flex items-center gap-2">
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
          placeholder={turnActive ? "Steer the active turn..." : (messagePlaceholder ?? "Message the agent...")}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
        />
      </div>
      </ChatComposerShell>
      <ComputerUseSettingsModal
        open={computerUseModalOpen}
        policy={computerUsePolicy}
        snapshot={computerUseSnapshot ?? null}
        onClose={() => setComputerUseModalOpen(false)}
        onChange={onComputerUsePolicyChange}
        onOpenProof={() => {
          if (!proofOpen) onToggleProof?.();
          setComputerUseModalOpen(false);
        }}
      />
    </>
  );
}

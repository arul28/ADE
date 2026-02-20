import React, { useEffect, useMemo, useRef, useState } from "react";
import { AtSign, ImageIcon, Pause, Play, Square, X } from "lucide-react";
import type {
  AgentChatApprovalDecision,
  AgentChatFileRef,
  AgentChatModelInfo,
  AgentChatProvider
} from "../../../shared/types";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { cn } from "../ui/cn";

export function AgentChatComposer({
  provider,
  model,
  models,
  draft,
  attachments,
  pendingApproval,
  turnActive,
  sendOnEnter,
  busy,
  onProviderChange,
  onModelChange,
  onDraftChange,
  onSubmit,
  onInterrupt,
  onApproval,
  onAddAttachment,
  onRemoveAttachment,
  onSearchAttachments
}: {
  provider: AgentChatProvider;
  model: string;
  models: AgentChatModelInfo[];
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
  onProviderChange: (provider: AgentChatProvider) => void;
  onModelChange: (model: string) => void;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
  onInterrupt: () => void;
  onApproval: (decision: AgentChatApprovalDecision) => void;
  onAddAttachment: (attachment: AgentChatFileRef) => void;
  onRemoveAttachment: (path: string) => void;
  onSearchAttachments: (query: string) => Promise<AgentChatFileRef[]>;
}) {
  const [attachmentPickerOpen, setAttachmentPickerOpen] = useState(false);
  const [attachmentQuery, setAttachmentQuery] = useState("");
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [attachmentResults, setAttachmentResults] = useState<AgentChatFileRef[]>([]);
  const [attachmentCursor, setAttachmentCursor] = useState(0);

  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const canAttach = !turnActive;

  const attachedPaths = useMemo(() => new Set(attachments.map((attachment) => attachment.path)), [attachments]);

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

  const selectAttachment = (attachment: AgentChatFileRef) => {
    onAddAttachment(attachment);
    setAttachmentPickerOpen(false);
  };

  return (
    <div className="rounded-lg border border-border/40 bg-card/60 p-2">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <label className="inline-flex items-center gap-1 text-xs text-muted-fg">
          Provider
          <select
            value={provider}
            onChange={(event) => onProviderChange(event.target.value as AgentChatProvider)}
            className="h-7 rounded border border-border/40 bg-bg/70 px-2 text-xs"
          >
            <option value="codex">Codex</option>
            <option value="claude">Claude</option>
          </select>
        </label>

        <label className="inline-flex min-w-[220px] flex-1 items-center gap-1 text-xs text-muted-fg">
          Model
          <select
            value={model}
            onChange={(event) => onModelChange(event.target.value)}
            className="h-7 min-w-0 flex-1 rounded border border-border/40 bg-bg/70 px-2 text-xs"
          >
            {models.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.displayName}
              </option>
            ))}
          </select>
        </label>

        {turnActive ? (
          <Chip className="bg-sky-500/20 text-[10px] text-sky-100">
            <Play className="mr-1 h-3 w-3" />
            Steering active turn
          </Chip>
        ) : null}

        <Button
          size="sm"
          variant={attachmentPickerOpen ? "primary" : "outline"}
          className="h-7 px-2 text-[10px]"
          disabled={!canAttach}
          onClick={() => {
            if (!canAttach) return;
            setAttachmentPickerOpen((open) => !open);
          }}
          title={canAttach ? "Attach files to the next message" : "Attachments are disabled while steering"}
        >
          <AtSign className="h-3.5 w-3.5" />
          Attach
        </Button>
      </div>

      {pendingApproval ? (
        <div className="mb-2 rounded border border-amber-400/35 bg-amber-500/10 px-2 py-1.5 text-[11px]">
          <div className="font-semibold text-amber-100">Approval pending · {pendingApproval.kind}</div>
          <div className="mt-0.5 text-amber-50/90">{pendingApproval.description}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            <Button size="sm" className="h-6 px-2 text-[10px]" onClick={() => onApproval("accept")}>Accept</Button>
            <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => onApproval("accept_for_session")}>Accept Session</Button>
            <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => onApproval("decline")}>Decline</Button>
            <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => onApproval("cancel")}>Dismiss</Button>
          </div>
        </div>
      ) : null}

      {attachments.length ? (
        <div className="mb-2 flex flex-wrap items-center gap-1.5 rounded border border-border/30 bg-bg/40 px-2 py-1.5">
          {attachments.map((attachment) => (
            <Chip key={attachment.path} className="flex items-center gap-1 bg-accent/15 text-[10px] text-fg">
              {attachment.type === "image" ? <ImageIcon className="h-3 w-3" /> : <AtSign className="h-3 w-3" />}
              <span className="max-w-[220px] truncate">{attachment.path}</span>
              <button
                type="button"
                className="inline-flex items-center rounded p-0.5 text-fg/70 hover:bg-black/20 hover:text-fg"
                title={`Remove ${attachment.path}`}
                onClick={() => onRemoveAttachment(attachment.path)}
              >
                <X className="h-3 w-3" />
              </button>
            </Chip>
          ))}
        </div>
      ) : null}

      {attachmentPickerOpen ? (
        <div className="mb-2 rounded border border-border/40 bg-bg/60">
          <div className="flex items-center gap-2 border-b border-border/30 px-2 py-1.5">
            <AtSign className="h-3.5 w-3.5 text-muted-fg" />
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
              <div className="px-2 py-1.5 text-[11px] text-muted-fg">Searching…</div>
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
                  {result.type === "image" ? <ImageIcon className="h-3.5 w-3.5 text-cyan-200" /> : <AtSign className="h-3.5 w-3.5 text-muted-fg" />}
                  <span className="truncate">{result.path}</span>
                </button>
              ))
            ) : (
              <div className="px-2 py-1.5 text-[11px] text-muted-fg">No matching files.</div>
            )}
          </div>
        </div>
      ) : null}

      <div className="flex items-end gap-2">
        <textarea
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          className={cn(
            "min-h-[64px] flex-1 resize-y rounded border border-border/40 bg-bg/70 px-2 py-1.5 text-xs leading-relaxed",
            "outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/30"
          )}
          placeholder={turnActive ? "Steer the active turn..." : "Ask Codex or Claude to work in this lane..."}
          onKeyDown={(event) => {
            const commandModified = event.metaKey || event.ctrlKey;

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
            <Square className="h-3.5 w-3.5" />
            Stop
          </Button>
        ) : null}

        <Button className="h-9" disabled={busy || !draft.trim().length} onClick={onSubmit}>
          {busy ? (
            <>
              <Pause className="h-3.5 w-3.5" />
              Sending
            </>
          ) : turnActive ? (
            <>
              <Play className="h-3.5 w-3.5" />
              Steer
            </>
          ) : (
            <>
              <Play className="h-3.5 w-3.5" />
              Send
            </>
          )}
        </Button>
      </div>

      <div className="mt-1 text-[10px] text-muted-fg">
        {sendOnEnter ? "Enter sends · Shift+Enter newline · Cmd/Ctrl+Enter inserts newline" : "Cmd/Ctrl+Enter sends · Enter newline"}
        {turnActive ? " · Cmd/Ctrl+. interrupts" : ""}
        {canAttach ? " · @ opens file picker" : ""}
        {pendingApproval ? " · Esc dismisses approval" : " · Esc clears draft"}
      </div>
    </div>
  );
}

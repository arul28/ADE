import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { PaperPlaneTilt, Paperclip } from "@phosphor-icons/react";
import type { AgentChatFileRef, ChatSurfaceMode } from "../../../shared/types";
import { MONO_FONT, SANS_FONT } from "../lanes/laneDesignTokens";
import { ChatAttachmentTray } from "../chat/ChatAttachmentTray";
import { ChatComposerShell } from "../chat/ChatComposerShell";

export type MentionParticipant = {
  id: string;
  label: string;
  status: "active" | "completed" | "failed";
  role?: string;
};

type MentionInputProps = {
  value: string;
  onChange: (value: string) => void;
  onSend: (message: string, mentions: string[]) => void;
  participants: MentionParticipant[];
  attachments?: AgentChatFileRef[];
  onPickAttachments?: () => void | Promise<void>;
  onRemoveAttachment?: (attachmentPath: string) => void;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  footerHint?: string;
  surfaceMode?: ChatSurfaceMode;
};

const STATUS_DOT_COLOR: Record<string, string> = {
  active: "#22c55e",
  completed: "#6b7280",
  failed: "#ef4444",
};

function parseMentions(text: string): string[] {
  const regex = /@([\w-]+)/g;
  const mentions: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    mentions.push(match[1]);
  }
  return mentions;
}

export function MentionInput({
  value,
  onChange,
  onSend,
  participants,
  attachments = [],
  onPickAttachments,
  onRemoveAttachment,
  placeholder = "Type a message...",
  disabled = false,
  autoFocus = false,
  footerHint = "Press Enter to send. Shift+Enter keeps a newline.",
  surfaceMode = "mission-thread",
}: MentionInputProps) {
  const [showDropdown, setShowDropdown] = useState(false);
  const [dropdownFilter, setDropdownFilter] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [focused, setFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    if (!dropdownFilter) return participants;
    const lower = dropdownFilter.toLowerCase();
    return participants.filter(
      (participant) =>
        participant.label.toLowerCase().includes(lower)
        || participant.id.toLowerCase().includes(lower)
        || (participant.role && participant.role.toLowerCase().includes(lower))
    );
  }, [participants, dropdownFilter]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [filtered.length]);

  const insertMention = useCallback((participant: MentionParticipant) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const cursorPos = textarea.selectionStart;
    const textBefore = value.slice(0, cursorPos);
    const textAfter = value.slice(cursorPos);
    const atIndex = textBefore.lastIndexOf("@");
    if (atIndex === -1) return;

    const before = value.slice(0, atIndex);
    const insertion = `@${participant.id} `;
    const nextValue = before + insertion + textAfter;

    onChange(nextValue);
    setShowDropdown(false);
    setDropdownFilter("");

    requestAnimationFrame(() => {
      if (!textareaRef.current) return;
      textareaRef.current.focus();
      const nextCursor = atIndex + insertion.length;
      textareaRef.current.selectionStart = nextCursor;
      textareaRef.current.selectionEnd = nextCursor;
    });
  }, [onChange, value]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showDropdown && filtered.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((current) => (current + 1) % filtered.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((current) => (current - 1 + filtered.length) % filtered.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        insertMention(filtered[selectedIndex]!);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setShowDropdown(false);
        setDropdownFilter("");
        return;
      }
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!value.trim() || disabled) return;
      onSend(value.trim(), parseMentions(value));
    }
  }, [disabled, filtered, insertMention, onSend, selectedIndex, showDropdown, value]);

  const handleChange = useCallback((event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextValue = event.target.value;
    onChange(nextValue);

    const cursorPos = event.target.selectionStart;
    const textUpToCursor = nextValue.slice(0, cursorPos);
    const lastAtIndex = textUpToCursor.lastIndexOf("@");
    if (lastAtIndex !== -1) {
      const afterAt = textUpToCursor.slice(lastAtIndex + 1);
      if (!/\s/.test(afterAt)) {
        setShowDropdown(true);
        setDropdownFilter(afterAt);
        return;
      }
    }
    setShowDropdown(false);
    setDropdownFilter("");
  }, [onChange]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  }, [value]);

  const canSubmit = value.trim().length > 0 && !disabled;

  return (
    <div
      className="relative"
      style={{
        background: "linear-gradient(180deg, rgba(18,14,28,0.98) 0%, rgba(12,10,18,0.98) 100%)",
        border: focused
          ? "1px solid color-mix(in srgb, var(--chat-accent) 36%, transparent)"
          : "1px solid #272335",
        boxShadow: focused
          ? "0 18px 42px rgba(15, 10, 30, 0.34)"
          : "0 14px 34px rgba(5, 3, 12, 0.24)",
      }}
    >
      {showDropdown && filtered.length > 0 ? (
        <div
          ref={dropdownRef}
          className="absolute bottom-full left-0 right-0 mb-2 max-h-[220px] overflow-y-auto"
          style={{
            background: "rgba(20, 16, 31, 0.98)",
            border: "1px solid #2f2940",
            boxShadow: "0 18px 42px rgba(5, 2, 14, 0.42)",
            zIndex: 50,
          }}
        >
          <div
            className="px-3 py-2"
            style={{
              fontSize: 10,
              fontWeight: 700,
              fontFamily: SANS_FONT,
              textTransform: "uppercase",
              letterSpacing: "1px",
              color: "#71717A",
              borderBottom: "1px solid #2a2535",
            }}
          >
            Participants
          </div>
          {filtered.map((participant, index) => (
            <button
              key={participant.id}
              className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors"
              style={{
                background: index === selectedIndex ? "#A78BFA18" : "transparent",
                color: index === selectedIndex ? "#FAFAFA" : "#A1A1AA",
              }}
              onMouseDown={(event) => {
                event.preventDefault();
                insertMention(participant);
              }}
              onMouseEnter={() => setSelectedIndex(index)}
            >
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: STATUS_DOT_COLOR[participant.status] ?? "#6b7280" }}
              />
              <span className="truncate text-xs font-medium" style={{ fontFamily: MONO_FONT }}>
                @{participant.label}
              </span>
              {participant.role ? (
                <span
                  className="ml-auto shrink-0 text-[9px] uppercase tracking-wider"
                  style={{ color: "#52525B", fontFamily: SANS_FONT }}
                >
                  {participant.role}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      <ChatComposerShell
        mode={surfaceMode}
        className="border-0 bg-transparent shadow-none backdrop-blur-0"
        trays={attachments.length > 0 ? (
          <ChatAttachmentTray
            attachments={attachments}
            mode={surfaceMode}
            onRemove={onRemoveAttachment}
            className="px-4 py-3"
          />
        ) : undefined}
        footer={(
          <div
            className="flex flex-wrap items-center gap-2 px-4 py-3"
            style={{ borderColor: "rgba(54, 46, 74, 0.9)" }}
          >
            {onPickAttachments ? (
              <button
                type="button"
                onClick={() => void onPickAttachments()}
                disabled={disabled}
                className="inline-flex items-center gap-1.5 rounded-[var(--chat-radius-pill)] px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.16em] transition-opacity hover:opacity-90 disabled:opacity-40"
                style={{
                  border: "1px solid color-mix(in srgb, var(--chat-accent) 18%, rgba(255,255,255,0.08))",
                  background: "color-mix(in srgb, var(--chat-accent) 10%, rgba(16,12,24,0.92))",
                  color: "#D4D4D8",
                  fontFamily: MONO_FONT,
                }}
              >
                <Paperclip size={12} weight="bold" />
                Attach
              </button>
            ) : null}

            <span
              className="min-w-0 flex-1 text-[10px] leading-[1.5]"
              style={{ color: "#8A8796", fontFamily: MONO_FONT }}
            >
              {footerHint}
            </span>

            <button
              type="button"
              onClick={() => {
                if (!canSubmit) return;
                onSend(value.trim(), parseMentions(value));
              }}
              disabled={!canSubmit}
              className="shrink-0 flex items-center gap-1.5 rounded-[var(--chat-radius-pill)] px-3 py-2 text-[11px] font-bold uppercase tracking-[0.16em] transition-opacity disabled:opacity-40"
              style={{
                background: "linear-gradient(135deg, color-mix(in srgb, var(--chat-accent) 90%, white 10%) 0%, color-mix(in srgb, var(--chat-accent) 66%, #60A5FA 34%) 100%)",
                color: "#0F0D14",
                fontFamily: MONO_FONT,
                letterSpacing: "1px",
              }}
            >
              <PaperPlaneTilt size={12} weight="regular" />
              Send
            </button>
          </div>
        )}
      >
        <div className="px-4 py-4">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              window.setTimeout(() => setShowDropdown(false), 150);
            }}
            disabled={disabled}
            placeholder={placeholder}
            autoFocus={autoFocus}
            rows={1}
            className="w-full resize-none rounded-[var(--chat-radius-card)] border border-white/8 bg-black/12 px-4 py-3 text-[12px] outline-none transition-colors placeholder:text-white/24 disabled:opacity-50"
            style={{
              fontFamily: MONO_FONT,
              color: "#FAFAFA",
              lineHeight: "1.55",
              minHeight: 60,
              maxHeight: 160,
            }}
          />
        </div>
      </ChatComposerShell>
    </div>
  );
}

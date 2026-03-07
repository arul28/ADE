import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { PaperPlaneTilt } from "@phosphor-icons/react";
import { MONO_FONT, SANS_FONT } from "../lanes/laneDesignTokens";

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
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
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
  placeholder = "Type a message...",
  disabled = false,
  autoFocus = false,
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
      (p) =>
        p.label.toLowerCase().includes(lower) ||
        p.id.toLowerCase().includes(lower) ||
        (p.role && p.role.toLowerCase().includes(lower))
    );
  }, [participants, dropdownFilter]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [filtered.length]);

  const insertMention = useCallback(
    (participant: MentionParticipant) => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      const cursorPos = textarea.selectionStart;
      const textBefore = value.slice(0, cursorPos);
      const textAfter = value.slice(cursorPos);

      // Find the @ that triggered the dropdown
      const atIndex = textBefore.lastIndexOf("@");
      if (atIndex === -1) return;

      const before = value.slice(0, atIndex);
      const insertion = `@${participant.id} `;
      const newValue = before + insertion + textAfter;

      onChange(newValue);
      setShowDropdown(false);
      setDropdownFilter("");

      // Restore focus and cursor position
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.focus();
          const newCursor = atIndex + insertion.length;
          textareaRef.current.selectionStart = newCursor;
          textareaRef.current.selectionEnd = newCursor;
        }
      });
    },
    [value, onChange]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (showDropdown && filtered.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSelectedIndex((prev) => (prev + 1) % filtered.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSelectedIndex((prev) => (prev - 1 + filtered.length) % filtered.length);
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          insertMention(filtered[selectedIndex]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setShowDropdown(false);
          setDropdownFilter("");
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!value.trim() || disabled) return;
        const mentions = parseMentions(value);
        onSend(value.trim(), mentions);
      }
    },
    [showDropdown, filtered, selectedIndex, insertMention, value, disabled, onSend]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      onChange(newValue);

      const cursorPos = e.target.selectionStart;
      const textUpToCursor = newValue.slice(0, cursorPos);

      // Check if we're in an @mention context
      const lastAtIndex = textUpToCursor.lastIndexOf("@");
      if (lastAtIndex !== -1) {
        const afterAt = textUpToCursor.slice(lastAtIndex + 1);
        // Only show dropdown if there's no space after @ (still typing the mention)
        if (!/\s/.test(afterAt)) {
          setShowDropdown(true);
          setDropdownFilter(afterAt);
          return;
        }
      }
      setShowDropdown(false);
      setDropdownFilter("");
    },
    [onChange]
  );

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
  }, [value]);

  // Render highlighted text with @mentions
  const renderHighlightedValue = useMemo(() => {
    if (!value) return null;
    const parts = value.split(/(@[\w-]+)/g);
    return parts.map((part, i) => {
      if (part.startsWith("@")) {
        return (
          <span key={i} style={{ color: "#A78BFA", fontWeight: 600 }}>
            {part}
          </span>
        );
      }
      return <span key={i}>{part}</span>;
    });
  }, [value]);

  return (
    <div className="relative" style={{ background: "#0d0a14" }}>
      {/* Floating dropdown above the input */}
      {showDropdown && filtered.length > 0 && (
        <div
          ref={dropdownRef}
          className="absolute bottom-full left-0 right-0 mb-1 max-h-[200px] overflow-y-auto"
          style={{
            background: "#1a1625",
            border: "1px solid #2a2535",
            zIndex: 50,
          }}
        >
          <div
            className="px-2 py-1"
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
            PARTICIPANTS
          </div>
          {filtered.map((p, i) => (
            <button
              key={p.id}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors"
              style={{
                background: i === selectedIndex ? "#A78BFA18" : "transparent",
                color: i === selectedIndex ? "#FAFAFA" : "#A1A1AA",
              }}
              onMouseDown={(e) => {
                e.preventDefault(); // prevent blur
                insertMention(p);
              }}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              <span
                className="inline-block h-2 w-2 rounded-full shrink-0"
                style={{ backgroundColor: STATUS_DOT_COLOR[p.status] ?? "#6b7280" }}
              />
              <span
                className="truncate text-xs font-medium"
                style={{ fontFamily: MONO_FONT }}
              >
                @{p.label}
              </span>
              {p.role && (
                <span
                  className="ml-auto shrink-0 text-[9px] uppercase tracking-wider"
                  style={{ color: "#52525B", fontFamily: SANS_FONT }}
                >
                  {p.role}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Input area */}
      <div className="flex items-end gap-2 px-3 py-2">
        <div className="relative min-w-0 flex-1">
          {/* Hidden highlighted overlay */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-3 py-1.5 text-xs"
            style={{
              fontFamily: MONO_FONT,
              color: "transparent",
              lineHeight: "1.5",
            }}
          >
            {renderHighlightedValue}
          </div>
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              // Delay hiding dropdown so clicks can register
              setTimeout(() => setShowDropdown(false), 150);
            }}
            disabled={disabled}
            placeholder={placeholder}
            autoFocus={autoFocus}
            rows={1}
            className="w-full resize-none px-3 py-1.5 text-xs outline-none disabled:opacity-50"
            style={{
              background: "#0C0A10",
              border: focused ? "1px solid #A78BFA" : "1px solid #27272A",
              fontFamily: MONO_FONT,
              color: "#FAFAFA",
              borderRadius: 0,
              lineHeight: "1.5",
              minHeight: 32,
              maxHeight: 120,
            }}
          />
        </div>
        <button
          onClick={() => {
            if (!value.trim() || disabled) return;
            const mentions = parseMentions(value);
            onSend(value.trim(), mentions);
          }}
          disabled={disabled || !value.trim()}
          className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider transition-opacity disabled:opacity-40"
          style={{
            background: "#A78BFA",
            color: "#0F0D14",
            fontFamily: MONO_FONT,
            height: 32,
            letterSpacing: "1px",
          }}
        >
          <PaperPlaneTilt size={12} weight="regular" />
          SEND
        </button>
      </div>
    </div>
  );
}

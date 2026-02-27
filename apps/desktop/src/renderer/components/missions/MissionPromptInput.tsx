import React, { useState, useRef, useCallback } from "react";
import { Paperclip } from "@phosphor-icons/react";
import { COLORS, MONO_FONT } from "../lanes/laneDesignTokens";

const FOCUS_BORDER_COLOR = COLORS.accent;

type SlashCommand = {
  command: string;
  description: string;
};

const SLASH_COMMANDS: SlashCommand[] = [
  { command: "/file", description: "Attach file context" },
  { command: "/lane", description: "Reference a lane" },
  { command: "/context", description: "Attach context pack" },
  { command: "/agent", description: "Reference an agent" },
];

type MissionPromptInputProps = {
  value: string;
  onChange: (value: string) => void;
  attachments?: string[];
  onAttachmentsChange?: (attachments: string[]) => void;
  placeholder?: string;
};

export function MissionPromptInput({
  value,
  onChange,
  attachments = [],
  onAttachmentsChange,
  placeholder = "Describe what you want to accomplish...",
}: MissionPromptInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0);
  const [isFocused, setIsFocused] = useState(false);

  const filteredCommands = SLASH_COMMANDS.filter((cmd) =>
    cmd.command.toLowerCase().includes(slashFilter.toLowerCase())
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      onChange(newValue);

      // Check for slash command trigger
      const cursorPos = e.target.selectionStart;
      const textBeforeCursor = newValue.slice(0, cursorPos);
      const lastSlash = textBeforeCursor.lastIndexOf("/");

      if (lastSlash >= 0) {
        const beforeSlash = textBeforeCursor[lastSlash - 1];
        if (lastSlash === 0 || beforeSlash === " " || beforeSlash === "\n") {
          const partial = textBeforeCursor.slice(lastSlash);
          if (!partial.includes(" ")) {
            setShowSlashMenu(true);
            setSlashFilter(partial);
            setSelectedSlashIndex(0);
            return;
          }
        }
      }
      setShowSlashMenu(false);
    },
    [onChange]
  );

  const insertSlashCommand = useCallback(
    (command: string) => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const cursorPos = textarea.selectionStart;
      const textBeforeCursor = value.slice(0, cursorPos);
      const lastSlash = textBeforeCursor.lastIndexOf("/");
      const newValue = value.slice(0, lastSlash) + command + " " + value.slice(cursorPos);
      onChange(newValue);
      setShowSlashMenu(false);
      setTimeout(() => {
        textarea.focus();
        const newPos = lastSlash + command.length + 1;
        textarea.setSelectionRange(newPos, newPos);
      }, 0);
    },
    [value, onChange]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!showSlashMenu) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedSlashIndex((i) => Math.min(i + 1, filteredCommands.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedSlashIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (filteredCommands[selectedSlashIndex]) {
          insertSlashCommand(filteredCommands[selectedSlashIndex].command);
        }
      } else if (e.key === "Escape") {
        setShowSlashMenu(false);
      }
    },
    [showSlashMenu, filteredCommands, selectedSlashIndex, insertSlashCommand]
  );

  const handleAttachFile = useCallback(async () => {
    try {
      const paths = await (window as any).ade?.dialog?.openFile?.({
        multiple: true,
        title: "Attach files to mission",
      });
      if (paths?.length && onAttachmentsChange) {
        onAttachmentsChange([...attachments, ...paths]);
      }
    } catch {
      // dialog cancelled or unavailable
    }
  }, [attachments, onAttachmentsChange]);

  const removeAttachment = useCallback(
    (index: number) => {
      if (onAttachmentsChange) {
        onAttachmentsChange(attachments.filter((_, i) => i !== index));
      }
    },
    [attachments, onAttachmentsChange]
  );

  const inputStyle: React.CSSProperties = {
    background: COLORS.recessedBg,
    border: `1px solid ${isFocused ? FOCUS_BORDER_COLOR : COLORS.outlineBorder}`,
    color: COLORS.textPrimary,
    fontFamily: MONO_FONT,
    borderRadius: 0,
    transition: "border-color 0.2s ease",
  };

  return (
    <div className="space-y-1">
      <div className="relative">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          placeholder={placeholder}
          rows={4}
          className="w-full px-3 py-2 text-xs outline-none resize-none"
          style={inputStyle}
        />

        {/* Slash command autocomplete */}
        {showSlashMenu && filteredCommands.length > 0 && (
          <div
            className="absolute left-0 right-0 z-10 shadow-lg"
            style={{
              bottom: "100%",
              marginBottom: 4,
              background: COLORS.cardBg,
              border: `1px solid ${COLORS.border}`,
            }}
          >
            {filteredCommands.map((cmd, i) => (
              <button
                key={cmd.command}
                type="button"
                className="flex items-center gap-2 w-full px-3 py-1.5 text-left"
                style={{
                  background: i === selectedSlashIndex ? `${COLORS.accent}18` : "transparent",
                  border: "none",
                  cursor: "pointer",
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertSlashCommand(cmd.command);
                }}
              >
                <span
                  style={{
                    fontFamily: MONO_FONT,
                    fontSize: 11,
                    fontWeight: 700,
                    color: COLORS.accent,
                  }}
                >
                  {cmd.command}
                </span>
                <span
                  style={{
                    fontFamily: MONO_FONT,
                    fontSize: 10,
                    color: COLORS.textMuted,
                  }}
                >
                  {cmd.description}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Toolbar */}
        <div
          className="flex items-center gap-1 px-2 py-0.5"
          style={{
            background: COLORS.recessedBg,
            border: `1px solid ${isFocused ? FOCUS_BORDER_COLOR : COLORS.outlineBorder}`,
            borderTop: "none",
            transition: "border-color 0.2s ease",
          }}
        >
          <button
            type="button"
            onClick={handleAttachFile}
            className="p-1 transition-colors"
            style={{ background: "none", border: "none", cursor: "pointer", color: COLORS.textMuted }}
            title="Attach file"
          >
            <Paperclip size={14} weight="bold" />
          </button>
          <span
            style={{
              fontFamily: MONO_FONT,
              fontSize: 9,
              color: COLORS.textDim,
              marginLeft: "auto",
            }}
          >
            Type / for commands
          </span>
        </div>
      </div>

      {/* Attachments */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {attachments.map((path, i) => {
            const filename = path.split("/").pop() ?? path;
            return (
              <span
                key={i}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px]"
                style={{
                  background: `${COLORS.accent}18`,
                  border: `1px solid ${COLORS.accent}30`,
                  color: COLORS.accent,
                  fontFamily: MONO_FONT,
                }}
              >
                {filename}
                <button
                  type="button"
                  onClick={() => removeAttachment(i)}
                  style={{ background: "none", border: "none", cursor: "pointer", color: COLORS.accent }}
                >
                  x
                </button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

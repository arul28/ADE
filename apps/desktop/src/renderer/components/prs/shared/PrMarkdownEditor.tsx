import { useCallback, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import {
  Code,
  CodeBlock,
  Link as LinkIcon,
  ListBullets,
  ListNumbers,
  Quotes,
  TextB,
  TextHOne,
  TextItalic,
} from "@phosphor-icons/react";

import { COLORS, MONO_FONT, SANS_FONT } from "../../lanes/laneDesignTokens";
import { PrMarkdown } from "./PrMarkdown";

type EditorMode = "write" | "preview";

export type ToolbarAction =
  | "bold"
  | "italic"
  | "code"
  | "codeblock"
  | "link"
  | "ul"
  | "ol"
  | "quote"
  | "heading";

export type PrMarkdownEditorProps = {
  value: string;
  onChange: (value: string) => void;
  repoOwner: string;
  repoName: string;
  placeholder?: string;
  disabled?: boolean;
  minHeight?: number;
  maxHeight?: number;
  autoFocus?: boolean;
  ariaLabel?: string;
  /** Extra content rendered on the right of the tab strip (e.g. char count). */
  toolbarTrailing?: ReactNode;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
};

export type Applied = { value: string; selStart: number; selEnd: number };

/** Apply a markdown transform around the current textarea selection. */
export function applyAction(textarea: HTMLTextAreaElement, action: ToolbarAction): Applied {
  const { value } = textarea;
  const start = textarea.selectionStart ?? value.length;
  const end = textarea.selectionEnd ?? value.length;
  const selected = value.slice(start, end);

  const wrap = (before: string, after: string, placeholder: string): Applied => {
    const inner = selected || placeholder;
    const next = value.slice(0, start) + before + inner + after + value.slice(end);
    const selStart = start + before.length;
    return { value: next, selStart, selEnd: selStart + inner.length };
  };

  const linePrefix = (prefix: string | ((index: number) => string)): Applied => {
    // Expand selection to whole lines.
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    const lineEndRaw = value.indexOf("\n", end);
    const lineEnd = lineEndRaw === -1 ? value.length : lineEndRaw;
    const block = value.slice(lineStart, lineEnd);
    const lines = block.split("\n");
    const prefixed = lines
      .map((line, i) => `${typeof prefix === "function" ? prefix(i) : prefix}${line}`)
      .join("\n");
    const next = value.slice(0, lineStart) + prefixed + value.slice(lineEnd);
    return { value: next, selStart: lineStart, selEnd: lineStart + prefixed.length };
  };

  switch (action) {
    case "bold":
      return wrap("**", "**", "bold text");
    case "italic":
      return wrap("_", "_", "italic text");
    case "code":
      return wrap("`", "`", "code");
    case "codeblock":
      return wrap("\n```\n", "\n```\n", "code block");
    case "link": {
      const inner = selected || "text";
      const snippet = `[${inner}](url)`;
      const next = value.slice(0, start) + snippet + value.slice(end);
      // Select the "url" placeholder.
      const urlStart = start + inner.length + 3;
      return { value: next, selStart: urlStart, selEnd: urlStart + 3 };
    }
    case "ul":
      return linePrefix("- ");
    case "ol":
      return linePrefix((i) => `${i + 1}. `);
    case "quote":
      return linePrefix("> ");
    case "heading":
      return linePrefix("## ");
    default:
      return { value, selStart: start, selEnd: end };
  }
}

const TOOLBAR: Array<{ action: ToolbarAction; icon: typeof TextB; title: string }> = [
  { action: "heading", icon: TextHOne, title: "Heading" },
  { action: "bold", icon: TextB, title: "Bold (⌘B)" },
  { action: "italic", icon: TextItalic, title: "Italic (⌘I)" },
  { action: "quote", icon: Quotes, title: "Quote" },
  { action: "code", icon: Code, title: "Inline code" },
  { action: "codeblock", icon: CodeBlock, title: "Code block" },
  { action: "link", icon: LinkIcon, title: "Link" },
  { action: "ul", icon: ListBullets, title: "Bulleted list" },
  { action: "ol", icon: ListNumbers, title: "Numbered list" },
];

const TAB_BTN: CSSProperties = {
  fontFamily: SANS_FONT,
  fontSize: 12,
  fontWeight: 500,
  padding: "4px 10px",
  borderRadius: 6,
  cursor: "pointer",
  border: "none",
  background: "transparent",
};

export function PrMarkdownEditor({
  value,
  onChange,
  repoOwner,
  repoName,
  placeholder = "Leave a comment…",
  disabled = false,
  minHeight = 96,
  maxHeight = 320,
  autoFocus = false,
  ariaLabel = "Markdown editor",
  toolbarTrailing,
  onKeyDown,
}: PrMarkdownEditorProps) {
  const [mode, setMode] = useState<EditorMode>("write");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const runAction = useCallback(
    (action: ToolbarAction) => {
      const ta = textareaRef.current;
      if (!ta || disabled) return;
      const result = applyAction(ta, action);
      onChange(result.value);
      // Restore selection after React re-renders the controlled value.
      requestAnimationFrame(() => {
        const node = textareaRef.current;
        if (!node) return;
        node.focus();
        node.setSelectionRange(result.selStart, result.selEnd);
      });
    },
    [disabled, onChange],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey) {
        const key = event.key.toLowerCase();
        if (key === "b") {
          event.preventDefault();
          runAction("bold");
          return;
        }
        if (key === "i") {
          event.preventDefault();
          runAction("italic");
          return;
        }
      }
      onKeyDown?.(event);
    },
    [onKeyDown, runAction],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Tab strip + toolbar */}
      <div
        className="flex items-center gap-1"
        style={{ borderBottom: `1px solid ${COLORS.border}`, padding: "4px 6px" }}
      >
        <button
          type="button"
          onClick={() => setMode("write")}
          style={{
            ...TAB_BTN,
            color: mode === "write" ? COLORS.textPrimary : COLORS.textMuted,
            background: mode === "write" ? COLORS.hoverBg : "transparent",
          }}
          data-testid="pr-md-editor-write"
        >
          Write
        </button>
        <button
          type="button"
          onClick={() => setMode("preview")}
          style={{
            ...TAB_BTN,
            color: mode === "preview" ? COLORS.textPrimary : COLORS.textMuted,
            background: mode === "preview" ? COLORS.hoverBg : "transparent",
          }}
          data-testid="pr-md-editor-preview"
        >
          Preview
        </button>

        {mode === "write" ? (
          <div className="ml-1 flex items-center gap-0.5">
            {TOOLBAR.map(({ action, icon: Icon, title }) => (
              <button
                key={action}
                type="button"
                title={title}
                aria-label={title}
                disabled={disabled}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => runAction(action)}
                className="inline-flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-white/[0.06]"
                style={{ color: COLORS.textMuted, background: "transparent", border: "none", cursor: "pointer" }}
              >
                <Icon size={14} />
              </button>
            ))}
          </div>
        ) : null}

        {toolbarTrailing ? <div className="ml-auto">{toolbarTrailing}</div> : null}
      </div>

      {/* Body */}
      {mode === "write" ? (
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          autoFocus={autoFocus}
          aria-label={ariaLabel}
          className="w-full flex-1 resize-none bg-transparent outline-none"
          style={{
            minHeight,
            maxHeight,
            padding: "10px 12px",
            fontFamily: SANS_FONT,
            fontSize: 13,
            lineHeight: 1.55,
            color: COLORS.textPrimary,
            opacity: disabled ? 0.6 : 1,
          }}
        />
      ) : (
        <div
          className="w-full flex-1 overflow-y-auto"
          style={{ minHeight, maxHeight, padding: "10px 12px" }}
          data-testid="pr-md-editor-preview-body"
        >
          {value.trim() ? (
            <PrMarkdown repoOwner={repoOwner} repoName={repoName} dense>
              {value}
            </PrMarkdown>
          ) : (
            <span style={{ fontFamily: MONO_FONT, fontSize: 12, color: COLORS.textDim }}>
              Nothing to preview
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export default PrMarkdownEditor;

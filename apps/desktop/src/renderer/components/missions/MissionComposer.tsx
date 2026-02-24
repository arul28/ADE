import React, { useState, useCallback, useRef, useMemo, useEffect } from "react";
import { PaperPlaneTilt } from "@phosphor-icons/react";
import { COLORS, MONO_FONT } from "../lanes/laneDesignTokens";

type MissionComposerProps = {
  stepKeys: string[];
  onSend: (target: string, content: string) => void;
};

export function MissionComposer({ stepKeys, onSend }: MissionComposerProps) {
  const [input, setInput] = useState("");
  const [inputFocused, setInputFocused] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Parse @target from input: "@stepKey rest of message" or just "message" (defaults to coordinator)
  const parsed = useMemo(() => {
    const match = input.match(/^@(\S+)\s+([\s\S]*)/);
    if (match) {
      return { target: match[1], messageContent: match[2], hasTarget: true };
    }
    // Incomplete @mention (no space yet)
    const partialMatch = input.match(/^@(\S+)$/);
    if (partialMatch) {
      return { target: partialMatch[1], messageContent: "", hasTarget: true };
    }
    return { target: "coordinator", messageContent: input, hasTarget: false };
  }, [input]);

  // Tab completion suggestions
  const suggestions = useMemo(() => {
    if (!input.startsWith("@")) return [];
    const partial = input.slice(1).split(/\s/)[0].toLowerCase();
    const options = ["coordinator", "all", ...stepKeys];
    return options
      .filter((k) => k.toLowerCase().startsWith(partial) && k.toLowerCase() !== partial)
      .slice(0, 5);
  }, [input, stepKeys]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Tab" && suggestions.length > 0) {
        e.preventDefault();
        const rest = input.includes(" ") ? input.slice(input.indexOf(" ")) : " ";
        setInput(`@${suggestions[0]}${rest}`);
        setShowSuggestions(false);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!parsed.messageContent.trim()) return;
        onSend(parsed.target, parsed.messageContent.trim());
        setInput("");
      }
    },
    [suggestions, input, parsed, onSend]
  );

  useEffect(() => {
    setShowSuggestions(suggestions.length > 0 && input.startsWith("@") && !input.includes(" "));
  }, [suggestions, input]);

  return (
    <div className="px-4 py-2.5 relative" style={{ borderTop: `1px solid ${COLORS.border}` }}>
      {/* Tab completion suggestions */}
      {showSuggestions && (
        <div
          className="absolute bottom-full left-4 mb-1 py-1"
          style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}
        >
          {suggestions.map((s) => (
            <button
              key={s}
              className="block w-full px-3 py-1 text-left text-xs hover:opacity-80"
              style={{ color: COLORS.textSecondary, fontFamily: MONO_FONT }}
              onMouseDown={(e) => {
                e.preventDefault();
                setInput(`@${s} `);
                setShowSuggestions(false);
                inputRef.current?.focus();
              }}
            >
              @{s}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <span
          className="shrink-0 text-[10px] px-1.5 py-0.5"
          style={{
            background: `${COLORS.accent}18`,
            color: COLORS.accent,
            fontFamily: MONO_FONT,
            border: `1px solid ${COLORS.accent}30`
          }}
        >
          @{parsed.target}
        </span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => setInputFocused(true)}
          onBlur={() => {
            setInputFocused(false);
            // Delay hiding suggestions so click can register
            setTimeout(() => setShowSuggestions(false), 200);
          }}
          placeholder="@agent message... or just type to message coordinator"
          className="h-8 flex-1 px-3 text-xs outline-none"
          style={{
            background: COLORS.recessedBg,
            border: inputFocused ? `1px solid ${COLORS.accent}` : `1px solid ${COLORS.outlineBorder}`,
            fontFamily: MONO_FONT,
            color: COLORS.textPrimary
          }}
        />
        <button
          onClick={() => {
            if (!parsed.messageContent.trim()) return;
            onSend(parsed.target, parsed.messageContent.trim());
            setInput("");
          }}
          disabled={!parsed.messageContent.trim()}
          className="h-8 px-3 flex items-center gap-1.5 text-xs font-semibold disabled:opacity-30 hover:opacity-90 transition-opacity"
          style={{
            background: COLORS.accent,
            color: COLORS.pageBg,
            fontFamily: MONO_FONT
          }}
        >
          <PaperPlaneTilt size={12} weight="regular" />
          SEND
        </button>
      </div>
      <div className="mt-1 text-[9px]" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>
        @coordinator @agent-name @all &mdash; Tab to complete
      </div>
    </div>
  );
}

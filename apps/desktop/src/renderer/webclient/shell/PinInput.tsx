import React, { useEffect, useMemo, useRef, useState } from "react";
import { COLORS, MONO_FONT } from "./shellTokens";

/**
 * Six-cell numeric PIN entry. Mirrors the desktop Sync settings PIN editor so
 * the browser pairing surface feels like the same product: auto-advance,
 * backspace-to-previous, arrow nav, and full-code paste. Calls `onComplete`
 * once six digits are present so the caller can enable submit.
 */
export function PinInput({
  value,
  onChange,
  onComplete,
  disabled,
  autoFocus = true,
}: {
  value: string;
  onChange: (pin: string) => void;
  onComplete?: (pin: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const digits = useMemo(() => {
    const clean = value.replace(/\D/g, "").slice(0, 6);
    return Array.from({ length: 6 }, (_, index) => clean[index] ?? "");
  }, [value]);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const refs = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    if (autoFocus) {
      refs.current[0]?.focus();
      refs.current[0]?.select?.();
    }
  }, [autoFocus]);

  const commit = (next: string[]) => {
    const joined = next.join("");
    onChange(joined);
    if (joined.replace(/\D/g, "").length === 6) onComplete?.(joined);
  };

  const handleChange = (index: number, raw: string) => {
    const digit = raw.replace(/\D/g, "").slice(-1);
    const next = digits.slice();
    next[index] = digit;
    commit(next);
    if (digit && index < 5) {
      refs.current[index + 1]?.focus();
      refs.current[index + 1]?.select?.();
    }
  };

  const handleKeyDown = (index: number, event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Backspace" && !digits[index] && index > 0) {
      event.preventDefault();
      const next = digits.slice();
      next[index - 1] = "";
      commit(next);
      refs.current[index - 1]?.focus();
      return;
    }
    if (event.key === "ArrowLeft" && index > 0) {
      event.preventDefault();
      refs.current[index - 1]?.focus();
    }
    if (event.key === "ArrowRight" && index < 5) {
      event.preventDefault();
      refs.current[index + 1]?.focus();
    }
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (!text) return;
    event.preventDefault();
    const next = Array.from({ length: 6 }, (_, index) => text[index] ?? "");
    commit(next);
    const focusIdx = Math.min(text.length, 5);
    refs.current[focusIdx]?.focus();
    refs.current[focusIdx]?.select?.();
  };

  return (
    <div style={{ display: "flex", gap: 8 }}>
      {digits.map((digit, index) => {
        const filled = Boolean(digit);
        const isFocused = focusedIndex === index;
        return (
          <input
            key={index}
            ref={(el) => { refs.current[index] = el; }}
            value={digit}
            onChange={(event) => handleChange(index, event.target.value)}
            onKeyDown={(event) => handleKeyDown(index, event)}
            onPaste={handlePaste}
            onFocus={() => setFocusedIndex(index)}
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={1}
            disabled={disabled}
            aria-label={`PIN digit ${index + 1}`}
            style={{
              width: 44,
              height: 52,
              textAlign: "center",
              fontFamily: MONO_FONT,
              fontSize: 24,
              fontWeight: 600,
              padding: 0,
              color: COLORS.textPrimary,
              background: filled
                ? "color-mix(in srgb, var(--color-accent) 10%, transparent)"
                : "color-mix(in srgb, var(--color-fg) 6%, transparent)",
              border: `1px solid ${
                isFocused ? COLORS.accent : filled ? COLORS.accentBorder : COLORS.border
              }`,
              borderRadius: 10,
              outline: "none",
              boxShadow: isFocused ? "0 0 0 3px color-mix(in srgb, var(--color-accent) 18%, transparent)" : "none",
              transition: "border-color 120ms ease, box-shadow 120ms ease, background 120ms ease",
            }}
          />
        );
      })}
    </div>
  );
}

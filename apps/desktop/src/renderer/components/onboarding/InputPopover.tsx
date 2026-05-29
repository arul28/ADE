import React, { useEffect, useRef, useState, useCallback } from "react";
import { COLORS, SANS_FONT, MONO_FONT } from "../lanes/laneDesignTokens";
import { Button } from "../ui/Button";

type Props = {
  triggerLabel: string;
  triggerVariant?: "primary" | "outline" | "ghost";
  title: string;
  helpText?: React.ReactNode;
  placeholder: string;
  saveLabel?: string;
  inputType?: "text" | "password";
  onSave: (value: string) => Promise<{ ok: boolean; message?: string }>;
  disabled?: boolean;
  align?: "left" | "right";
};

export function InputPopover({
  triggerLabel,
  triggerVariant = "outline",
  title,
  helpText,
  placeholder,
  saveLabel = "Save",
  inputType = "password",
  onSave,
  disabled = false,
  align = "right",
}: Props) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setError(null);
    setSuccess(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      close();
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open, close]);

  const submit = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await onSave(trimmed);
      if (result.ok) {
        setSuccess(result.message ?? "Saved");
        setValue("");
        window.setTimeout(close, 800);
      } else {
        setError(result.message ?? "Save failed");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [value, onSave, close]);

  return (
    <div ref={anchorRef} style={{ position: "relative", display: "inline-flex" }}>
      <Button
        size="sm"
        variant={triggerVariant}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        {triggerLabel}
      </Button>
      {open ? (
        <div
          ref={popoverRef}
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            ...(align === "right" ? { right: 0 } : { left: 0 }),
            width: 280,
            padding: 12,
            background: COLORS.cardBgSolid,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 10,
            boxShadow: "0 14px 40px rgba(0,0,0,0.45)",
            zIndex: 30,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 600, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
            {title}
          </div>
          {helpText ? (
            <div style={{ marginTop: 6, fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
              {helpText}
            </div>
          ) : null}
          <input
            autoFocus
            type={inputType}
            value={value}
            placeholder={placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !busy && value.trim()) void submit();
            }}
            style={{
              marginTop: 10,
              width: "100%",
              padding: "8px 10px",
              fontSize: 12,
              fontFamily: MONO_FONT,
              background: "rgba(0,0,0,0.35)",
              border: `1px solid ${COLORS.border}`,
              borderRadius: 8,
              color: COLORS.textPrimary,
              outline: "none",
              boxSizing: "border-box",
            }}
          />
          {error ? (
            <div style={{ marginTop: 8, fontSize: 11, fontFamily: SANS_FONT, color: COLORS.danger }}>{error}</div>
          ) : null}
          {success ? (
            <div style={{ marginTop: 8, fontSize: 11, fontFamily: SANS_FONT, color: COLORS.success }}>{success}</div>
          ) : null}
          <div style={{ marginTop: 10, display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button size="sm" variant="ghost" disabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" disabled={busy || !value.trim()} onClick={() => void submit()}>
              {busy ? "Saving..." : saveLabel}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

import React, { useEffect, useRef, useCallback } from "react";
import { COLORS, MONO_FONT, SANS_FONT, primaryButton, outlineButton, dangerButton } from "../lanes/laneDesignTokens";

/* ─── Shared overlay + panel styles ─── */

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 9999,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(0,0,0,0.70)",
};

const panelStyle: React.CSSProperties = {
  width: 420,
  maxWidth: "90vw",
  background: COLORS.cardBg,
  border: `1px solid ${COLORS.border}`,
  boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
};

const titleStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  fontFamily: SANS_FONT,
  textTransform: "uppercase",
  letterSpacing: "1px",
  color: COLORS.textPrimary,
};

const bodyTextStyle: React.CSSProperties = {
  fontSize: 12,
  fontFamily: MONO_FONT,
  color: COLORS.textSecondary,
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
};

const footerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  padding: "12px 16px",
  borderTop: `1px solid ${COLORS.border}`,
};

/* ─── ConfirmDialog ─── */

export interface ConfirmDialogState {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
}

export function useConfirmDialog() {
  const [state, setState] = React.useState<ConfirmDialogState | null>(null);
  const resolveRef = React.useRef<((v: boolean) => void) | null>(null);

  const confirmAsync = useCallback(
    (opts: { title: string; message: string; confirmLabel?: string; danger?: boolean }): Promise<boolean> => {
      return new Promise<boolean>((resolve) => {
        resolveRef.current = resolve;
        setState({
          open: true,
          title: opts.title,
          message: opts.message,
          confirmLabel: opts.confirmLabel,
          danger: opts.danger,
          onConfirm: () => {
            resolveRef.current = null;
            setState(null);
            resolve(true);
          },
        });
      });
    },
    []
  );

  const close = useCallback(() => {
    if (resolveRef.current) {
      resolveRef.current(false);
      resolveRef.current = null;
    }
    setState(null);
  }, []);

  return { state, confirmAsync, close };
}

export function ConfirmDialog({
  state,
  onClose,
}: {
  state: ConfirmDialogState | null;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!state?.open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [state?.open, onClose]);

  if (!state?.open) return null;

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div style={overlayStyle} onClick={handleOverlayClick}>
      <div ref={panelRef} style={panelStyle}>
        <div style={{ padding: "14px 16px", borderBottom: `1px solid ${COLORS.border}`, background: COLORS.recessedBg }}>
          <div style={titleStyle}>{state.title}</div>
        </div>
        <div style={{ padding: "16px 16px" }}>
          <div style={bodyTextStyle}>{state.message}</div>
        </div>
        <div style={footerStyle}>
          <button style={outlineButton()} onClick={onClose}>
            CANCEL
          </button>
          <button
            style={state.danger ? dangerButton() : primaryButton()}
            onClick={state.onConfirm}
            autoFocus
          >
            {state.confirmLabel ?? "CONFIRM"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── PromptDialog ─── */

export interface PromptDialogState {
  open: boolean;
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  onConfirm: (value: string) => void;
}

export function usePromptDialog() {
  const [state, setState] = React.useState<PromptDialogState | null>(null);
  const resolveRef = React.useRef<((v: string | null) => void) | null>(null);

  const promptAsync = useCallback(
    (opts: { title: string; message?: string; defaultValue?: string; placeholder?: string; confirmLabel?: string }): Promise<string | null> => {
      return new Promise<string | null>((resolve) => {
        resolveRef.current = resolve;
        setState({
          open: true,
          title: opts.title,
          message: opts.message,
          defaultValue: opts.defaultValue,
          placeholder: opts.placeholder,
          confirmLabel: opts.confirmLabel,
          onConfirm: (value: string) => {
            resolveRef.current = null;
            setState(null);
            resolve(value);
          },
        });
      });
    },
    []
  );

  const close = useCallback(() => {
    if (resolveRef.current) {
      resolveRef.current(null);
      resolveRef.current = null;
    }
    setState(null);
  }, []);

  return { state, promptAsync, close };
}

export function PromptDialog({
  state,
  onClose,
}: {
  state: PromptDialogState | null;
  onClose: () => void;
}) {
  const [value, setValue] = React.useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (state?.open) {
      setValue(state.defaultValue ?? "");
      // Focus on next tick so the input exists in DOM
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [state?.open, state?.defaultValue]);

  useEffect(() => {
    if (!state?.open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [state?.open, onClose]);

  if (!state?.open) return null;

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  const handleSubmit = () => {
    if (value.trim()) {
      state.onConfirm(value);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    height: 32,
    background: COLORS.recessedBg,
    border: `1px solid ${COLORS.outlineBorder}`,
    padding: "0 8px",
    fontSize: 12,
    color: COLORS.textPrimary,
    fontFamily: MONO_FONT,
    borderRadius: 0,
    outline: "none",
  };

  return (
    <div style={overlayStyle} onClick={handleOverlayClick}>
      <div style={panelStyle}>
        <div style={{ padding: "14px 16px", borderBottom: `1px solid ${COLORS.border}`, background: COLORS.recessedBg }}>
          <div style={titleStyle}>{state.title}</div>
        </div>
        <div style={{ padding: "16px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
          {state.message && <div style={bodyTextStyle}>{state.message}</div>}
          <input
            ref={inputRef}
            style={inputStyle}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={state.placeholder}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleSubmit();
              }
            }}
          />
        </div>
        <div style={footerStyle}>
          <button style={outlineButton()} onClick={onClose}>
            CANCEL
          </button>
          <button
            style={primaryButton()}
            onClick={handleSubmit}
            disabled={!value.trim()}
          >
            {state.confirmLabel ?? "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}

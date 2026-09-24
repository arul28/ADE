import React, { useCallback } from "react";
import { ConfirmDialogView, PromptDialogView } from "../ui/dialog/confirm";

/**
 * Hook-driven confirm/prompt dialogs, kept for their existing call sites. They
 * render through the shared dialog shell (`ui/dialog`), so they look and behave
 * exactly like `confirmDialog` / `promptDialog`. New code should call those
 * imperative helpers instead of adding state for a dialog.
 */

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
  if (!state?.open) return null;
  return (
    <ConfirmDialogView
      open
      options={{
        title: state.title,
        message: state.message,
        confirmLabel: state.confirmLabel ?? "Confirm",
        destructive: state.danger,
      }}
      onResult={(confirmed) => {
        if (confirmed) state.onConfirm();
        else onClose();
      }}
    />
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
  if (!state?.open) return null;
  return (
    <PromptDialogView
      open
      options={{
        title: state.title,
        message: state.message,
        defaultValue: state.defaultValue,
        placeholder: state.placeholder,
        confirmLabel: state.confirmLabel ?? "OK",
      }}
      onResult={(value) => {
        if (value === null) onClose();
        else state.onConfirm(value);
      }}
    />
  );
}

import { useState, type ReactNode } from "react";
import { X } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import {
  describeAppleError,
  type AppleErrorAction,
  type AppleErrorDescription,
} from "./appleErrors";

export { describeAppleError };
export type { AppleErrorAction, AppleErrorDescription };

const ACTION_LABEL = {
  start: "Start",
  reconnect: "Reconnect",
  reinstall: "How to fix",
} as const;

/**
 * One line at the top of the pane, and the raw text folded behind `Details`.
 *
 * §6: no toasts, no `String(error)` in JSX, and no sentence longer than twelve
 * words. The mapping owns the words; this owns where they sit. `Details` is a
 * disclosure rather than a second line because the wire text is for the one
 * person in a hundred who is going to paste it into an issue, and it is always
 * the longest thing on screen.
 */
export function AppleDeviceStatusStrip({
  error,
  onAction,
  onDismiss,
}: {
  /** The raw failure. Never rendered; only `describeAppleError` reads it. */
  error: unknown;
  onAction?: ((action: AppleErrorAction) => void) | undefined;
  onDismiss: () => void;
}) {
  const [open, setOpen] = useState(false);
  const described = describeAppleError(error);
  const action = described.action;
  return (
    <StripShell
      tone="error"
      sentence={described.sentence}
      onDismiss={onDismiss}
      detail={open && described.detail ? described.detail : null}
      actions={(
        <>
          {action && onAction ? (
            <StripAction label={ACTION_LABEL[action]} onClick={() => onAction(action)} />
          ) : null}
          {described.detail ? (
            <StripAction
              label="Details"
              expanded={open}
              muted
              onClick={() => setOpen((value) => !value)}
            />
          ) : null}
        </>
      )}
    />
  );
}

/**
 * The two strips §3 asks for that are not failures: "iPhone 17 Pro is off." and
 * "Video stopped." A dead device is a fact about the device, not an error the
 * user caused, so it gets the same one line and the same one button without
 * the red.
 */
export function AppleDeviceNoticeStrip({
  sentence,
  actionLabel,
  onAction,
  onDismiss,
}: {
  sentence: string;
  actionLabel: string;
  onAction: () => void;
  onDismiss?: (() => void) | undefined;
}) {
  return (
    <StripShell
      tone="notice"
      sentence={sentence}
      detail={null}
      onDismiss={onDismiss}
      actions={<StripAction label={actionLabel} onClick={onAction} />}
    />
  );
}

function StripShell({
  tone,
  sentence,
  detail,
  actions,
  onDismiss,
}: {
  tone: "error" | "notice";
  sentence: string;
  detail: string | null;
  actions: ReactNode;
  onDismiss?: (() => void) | undefined;
}) {
  const error = tone === "error";
  return (
    <div
      role="alert"
      data-apple-status-strip={tone}
      className={cn(
        "shrink-0 border-b px-3 py-2 font-sans text-xs",
        error
          ? "border-[var(--color-error)]/25 bg-[var(--color-error)]/8 text-[var(--color-error)]"
          : "border-border bg-surface text-fg/85",
      )}
    >
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 leading-5">{sentence}</p>
        {actions}
        {onDismiss ? (
          <button
            type="button"
            aria-label="Dismiss this message"
            className="shrink-0 rounded p-0.5 opacity-80 hover:opacity-100"
            onClick={onDismiss}
          >
            <X size={12} />
          </button>
        ) : null}
      </div>
      {detail ? (
        <pre className="mt-1.5 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded bg-black/25 p-2 font-mono text-[11px] leading-4">
          {detail}
        </pre>
      ) : null}
    </div>
  );
}

function StripAction({
  label,
  expanded,
  muted,
  onClick,
}: {
  label: string;
  expanded?: boolean;
  muted?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onClick}
      className={cn(
        "shrink-0 rounded px-1.5 py-0.5 font-medium underline-offset-2 hover:underline",
        muted && "opacity-80 hover:opacity-100",
      )}
    >
      {label}
    </button>
  );
}

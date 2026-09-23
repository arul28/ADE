import { useState, type ReactNode } from "react";
import { X } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { Button } from "../ui/Button";
import { PaneTooltip } from "../ui/PaneTooltip";
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
 *
 * A strip may carry ONE quieter second choice after the first — "is off." has
 * two honest answers, turn it back on or pick another device, and a person
 * should not have to find the second one in the rail's overflow menu.
 */
export function AppleDeviceNoticeStrip({
  sentence,
  actionLabel,
  onAction,
  secondaryActionLabel,
  onSecondaryAction,
  onDismiss,
}: {
  sentence: string;
  actionLabel: string;
  onAction: () => void;
  secondaryActionLabel?: string | undefined;
  onSecondaryAction?: (() => void) | undefined;
  onDismiss?: (() => void) | undefined;
}) {
  return (
    <StripShell
      tone="notice"
      sentence={sentence}
      detail={null}
      onDismiss={onDismiss}
      actions={(
        <>
          <StripAction label={actionLabel} onClick={onAction} />
          {secondaryActionLabel && onSecondaryAction ? (
            <StripAction label={secondaryActionLabel} muted onClick={onSecondaryAction} />
          ) : null}
        </>
      )}
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
  /*
   * Rule zero: OPAQUE. Round 2 painted this `bg-[var(--color-error)]/8` over
   * whatever was behind it, which on a live device is a moving picture read
   * through a red film. The error tone is now a `color-mix` INTO the surface,
   * so it is the same red at the same weight over any background and the
   * sentence keeps its contrast.
   */
  return (
    <div
      role="alert"
      data-apple-status-strip={tone}
      className={cn(
        "shrink-0 border-b px-3 py-2 font-sans text-xs",
        error
          ? "border-[color-mix(in_srgb,var(--color-error)_35%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-error)_12%,var(--color-surface))] text-[var(--color-error)]"
          : "border-border bg-surface text-fg/85",
      )}
    >
      {/* Wraps, so a strip with two buttons in a narrow pane moves the buttons
          to a second line instead of squeezing the sentence to nothing. */}
      <div className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1">
        <p className="min-w-0 flex-[1_1_10rem] break-words leading-5">{sentence}</p>
        {actions}
        {onDismiss ? (
          <PaneTooltip label="Dismiss this message" side="bottom">
            <Button
              variant="ghost"
              size="sm"
              aria-label="Dismiss this message"
              className="h-5 shrink-0 px-1"
              onClick={onDismiss}
            >
              <X size={12} aria-hidden="true" />
            </Button>
          </PaneTooltip>
        ) : null}
      </div>
      {detail ? (
        <pre className="mt-1.5 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--color-bg)] p-2 font-mono text-[11px] leading-4">
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
    <Button
      variant="ghost"
      size="sm"
      aria-expanded={expanded}
      onClick={onClick}
      className={cn("h-5 shrink-0 px-1.5 text-current", muted && "opacity-80 hover:opacity-100")}
    >
      {label}
    </Button>
  );
}

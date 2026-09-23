import type { ReactNode } from "react";
import { X } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { Button } from "../ui/Button";
import { PaneTooltip } from "../ui/PaneTooltip";

/**
 * One line at the top of a screen tool's pane: a sentence, its buttons, and an
 * optional block of raw detail under it.
 *
 * Shared by the Apple device pane and the Mac Desktop pane, so a failure or a
 * notice looks the same whichever screen it is about. `marker` carries the
 * caller's own data attributes.
 */
export function ToolStatusStrip({
  tone,
  sentence,
  detail,
  actions,
  onDismiss,
  marker,
}: {
  tone: "error" | "notice";
  sentence: string;
  detail: string | null;
  actions: ReactNode;
  onDismiss?: (() => void) | undefined;
  marker?: Record<`data-${string}`, string>;
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
      {...marker}
      role="alert"
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

export function ToolStatusStripAction({
  label,
  expanded,
  muted,
  disabled,
  onClick,
}: {
  label: string;
  expanded?: boolean;
  muted?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-expanded={expanded}
      disabled={disabled}
      onClick={onClick}
      className={cn("h-5 shrink-0 px-1.5 text-current", muted && "opacity-80 hover:opacity-100")}
    >
      {label}
    </Button>
  );
}

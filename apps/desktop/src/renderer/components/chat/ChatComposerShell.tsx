import type { CSSProperties, ReactNode } from "react";
import type { ChatSurfaceMode } from "../../../shared/types";
import { cn } from "../ui/cn";
import type { ComposerEffortFrame } from "./composerEffortFrame";

export function ChatComposerShell({
  mode,
  glowColor,
  effortFrame,
  voiceBar,
  pendingBanner,
  trays,
  pickerLayer,
  children,
  footer,
  className,
}: {
  mode: ChatSurfaceMode;
  glowColor?: string | null;
  /** The ultrathink rainbow, or the highest thinking level's colour. */
  effortFrame?: ComposerEffortFrame | null;
  /**
   * A live voice conversation's strip, drawn as the composer's own top row.
   * It belongs inside the shell rather than above it: a second box the size of
   * the composer is a second thing to read at the exact moment the user is
   * listening instead of looking.
   */
  voiceBar?: ReactNode;
  pendingBanner?: ReactNode;
  trays?: ReactNode;
  pickerLayer?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "ade-liquid-glass ade-liquid-glass-strong relative w-full min-w-0 max-w-full rounded-[var(--chat-radius-shell)] transition-colors",
        className,
      )}
      style={{
        ...(glowColor ? {
          boxShadow: `0 0 24px -6px ${glowColor}, 0 0 48px -16px ${glowColor}, 0 26px 64px -34px rgba(0,0,0,0.72), 0 0 0 1px color-mix(in srgb, ${glowColor} 30%, color-mix(in srgb, var(--color-fg) 4%, transparent))`,
          borderColor: `color-mix(in srgb, ${glowColor} 30%, transparent)`,
        } : {}),
        ...(effortFrame?.kind === "top" ? { "--effort-frame-rgb": effortFrame.rgb } as CSSProperties : {}),
      }}
      data-chat-composer-mode={mode}
      data-onboarding-anchor="composer-at"
      data-effort-frame={effortFrame
        ? effortFrame.kind === "ultrathink" ? "ultrathink" : effortFrame.ultra ? "ultra" : "top"
        : undefined}
    >
      {effortFrame ? <div aria-hidden className="ade-composer-effort-frame" /> : null}
      <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-[var(--chat-radius-shell)]">
        <div className="absolute left-6 top-0 h-24 w-32 rounded-full bg-[radial-gradient(circle,rgba(255,255,255,0.05)_0%,transparent_72%)] opacity-50 blur-2xl" />
        <div className="absolute bottom-[-3rem] right-[-2rem] h-24 w-36 rounded-full bg-[radial-gradient(circle,var(--chat-liquid-sheen)_0%,transparent_70%)] opacity-50 blur-3xl" />
      </div>
      {voiceBar ? <div className="relative min-w-0 max-w-full border-b border-[color:var(--chat-panel-border)]">{voiceBar}</div> : null}
      {pendingBanner ? <div className="relative min-w-0 max-w-full border-b border-[color:var(--chat-panel-border)]">{pendingBanner}</div> : null}
      {trays ? <div className="relative min-w-0 max-w-full border-b border-[color:var(--chat-panel-border)]">{trays}</div> : null}
      <div className="relative min-w-0 max-w-full">
        {pickerLayer}
        {children}
      </div>
      {footer ? <div className="relative min-w-0 max-w-full">{footer}</div> : null}
    </div>
  );
}

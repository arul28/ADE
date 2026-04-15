import type { ReactNode } from "react";
import type { ChatSurfaceMode } from "../../../shared/types";
import { cn } from "../ui/cn";

export function ChatComposerShell({
  mode,
  glowColor,
  pendingBanner,
  trays,
  pickerLayer,
  children,
  footer,
  className,
}: {
  mode: ChatSurfaceMode;
  glowColor?: string | null;
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
        "ade-liquid-glass ade-liquid-glass-strong relative overflow-hidden rounded-[var(--chat-radius-shell)] transition-colors",
        className,
      )}
      style={glowColor ? {
        boxShadow: `0 0 24px -6px ${glowColor}, 0 0 48px -16px ${glowColor}, 0 26px 64px -34px rgba(0,0,0,0.72), 0 0 0 1px color-mix(in srgb, ${glowColor} 30%, rgba(255,255,255,0.04))`,
        borderColor: `color-mix(in srgb, ${glowColor} 30%, transparent)`,
      } : undefined}
      data-chat-composer-mode={mode}
    >
      <div className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
      <div className="pointer-events-none absolute left-6 top-0 h-24 w-32 rounded-full bg-[radial-gradient(circle,rgba(255,255,255,0.10)_0%,transparent_72%)] opacity-70 blur-2xl" />
      <div className="pointer-events-none absolute bottom-[-3rem] right-[-2rem] h-24 w-36 rounded-full bg-[radial-gradient(circle,var(--chat-liquid-sheen)_0%,transparent_70%)] opacity-80 blur-3xl" />
      {pendingBanner ? <div className="relative border-b border-[color:var(--chat-panel-border)]">{pendingBanner}</div> : null}
      {trays ? <div className="relative border-b border-[color:var(--chat-panel-border)]">{trays}</div> : null}
      <div className="relative">
        {pickerLayer}
        {children}
      </div>
      {footer ? <div className="relative border-t border-[color:var(--chat-panel-border)]">{footer}</div> : null}
    </div>
  );
}

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
        "relative overflow-hidden rounded-[var(--chat-radius-shell)] transition-colors",
        "bg-[#14121F]/90 border border-white/[0.08] shadow-[0_8px_32px_rgba(0,0,0,0.45),0_0_0_1px_rgba(167,139,250,0.06)]",
        className,
      )}
      style={{
        backdropFilter: "blur(24px)",
        WebkitBackdropFilter: "blur(24px)",
        ...(glowColor ? {
          boxShadow: `0 0 24px 2px ${glowColor}, 0 0 48px 4px ${glowColor}, 0 8px 32px rgba(0,0,0,0.45), 0 0 0 1px rgba(167,139,250,0.06)`,
          borderColor: glowColor.replace(/[\d.]+\)$/, "0.3)"),
        } : {}),
      }}
      data-chat-composer-mode={mode}
    >
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

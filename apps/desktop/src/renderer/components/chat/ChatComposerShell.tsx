import type { ReactNode } from "react";
import type { ChatSurfaceMode } from "../../../shared/types";
import { cn } from "../ui/cn";

export function ChatComposerShell({
  mode,
  pendingBanner,
  trays,
  pickerLayer,
  children,
  footer,
  className,
}: {
  mode: ChatSurfaceMode;
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
        className,
      )}
      style={{
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        background: "rgba(30, 30, 40, 0.7)",
        border: "1px solid rgba(255, 255, 255, 0.08)",
        boxShadow: "0 8px 32px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.05)",
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

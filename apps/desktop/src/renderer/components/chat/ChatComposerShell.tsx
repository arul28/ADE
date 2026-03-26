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
        "relative overflow-hidden rounded-[var(--chat-radius-shell)] border border-[color:var(--chat-panel-border)] bg-[var(--chat-panel-bg)] shadow-[var(--chat-composer-shadow)] transition-colors",
        className,
      )}
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

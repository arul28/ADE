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
        "relative border border-white/[0.06] bg-white/[0.03] shadow-[var(--chat-composer-shadow)] backdrop-blur-2xl transition-colors",
        className,
      )}
      data-chat-composer-mode={mode}
    >
      <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit] bg-[radial-gradient(ellipse_at_70%_0%,var(--chat-accent-faint),transparent_60%)] opacity-50" />
      {pendingBanner ? <div className="relative border-b border-white/[0.04]">{pendingBanner}</div> : null}
      {trays ? <div className="relative border-b border-white/[0.04]">{trays}</div> : null}
      <div className="relative">
        {pickerLayer}
        {children}
      </div>
      {footer ? <div className="relative border-t border-white/[0.04]">{footer}</div> : null}
    </div>
  );
}

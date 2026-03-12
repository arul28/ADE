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
        "relative overflow-hidden border border-white/8 bg-[linear-gradient(180deg,rgba(255,255,255,0.06),rgba(255,255,255,0.025))] shadow-[var(--chat-composer-shadow)] backdrop-blur-xl",
        className,
      )}
      data-chat-composer-mode={mode}
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,var(--chat-accent-glow),transparent_42%)] opacity-80" />
      {pendingBanner ? <div className="relative border-b border-white/6">{pendingBanner}</div> : null}
      {trays ? <div className="relative border-b border-white/6">{trays}</div> : null}
      <div className="relative">
        {pickerLayer}
        {children}
      </div>
      {footer ? <div className="relative border-t border-white/6">{footer}</div> : null}
    </div>
  );
}

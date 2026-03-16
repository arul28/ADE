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
        "relative border border-white/[0.06] bg-[#0d0d10] shadow-[0_18px_48px_-30px_rgba(0,0,0,0.78)] transition-colors",
        className,
      )}
      data-chat-composer-mode={mode}
    >
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

import type { ReactNode } from "react";
import type { ChatSurfaceMode } from "../../../shared/types";
import { cn } from "../ui/cn";
import { chatSurfaceVars } from "./chatSurfaceTheme";

export function ChatSurfaceShell({
  mode,
  accentColor,
  header,
  footer,
  children,
  className,
  bodyClassName,
}: {
  mode: ChatSurfaceMode;
  accentColor?: string | null;
  header?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section
      className={cn(
        "relative flex h-full min-h-0 flex-col border border-white/[0.05] bg-[#09090b]",
        className,
      )}
      style={chatSurfaceVars(mode, accentColor)}
    >
      {header ? (
        <div className="relative border-b border-white/[0.05] bg-[#0d0d10]">
          {header}
        </div>
      ) : null}
      <div className={cn("relative min-h-0 flex-1 overflow-hidden bg-[#09090b]", bodyClassName)}>
        {children}
      </div>
      {footer ? (
        <div className="relative border-t border-white/[0.05] bg-[#0d0d10]">
          {footer}
        </div>
      ) : null}
    </section>
  );
}

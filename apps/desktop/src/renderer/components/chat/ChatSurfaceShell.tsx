import type { ReactNode } from "react";
import type { ChatSurfaceMode } from "../../../shared/types";
import { cn } from "../ui/cn";
import { chatSurfaceVars } from "./chatSurfaceTheme";

const MODE_OVERLAYS: Record<ChatSurfaceMode, string> = {
  standard: "none",
  resolver: "radial-gradient(ellipse 80% 50% at 10% 0%, rgba(249,115,22,0.03), transparent 60%)",
  "mission-thread": "radial-gradient(ellipse 80% 50% at 10% 0%, rgba(56,189,248,0.03), transparent 60%)",
  "mission-feed": "radial-gradient(ellipse 80% 50% at 10% 0%, rgba(34,197,94,0.03), transparent 60%)",
};

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
        "relative flex h-full min-h-0 flex-col overflow-hidden bg-card",
        className,
      )}
      style={chatSurfaceVars(mode, accentColor)}
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{ background: MODE_OVERLAYS[mode] }}
      />
      {header ? (
        <div className="relative border-b border-white/[0.04]">
          {header}
        </div>
      ) : null}
      <div className={cn("relative min-h-0 flex-1", bodyClassName)}>
        {children}
      </div>
      {footer ? (
        <div className="relative border-t border-white/[0.04]">
          {footer}
        </div>
      ) : null}
    </section>
  );
}

import type { ReactNode } from "react";
import type { ChatSurfaceMode } from "../../../shared/types";
import { cn } from "../ui/cn";
import { chatSurfaceVars } from "./chatSurfaceTheme";

const MODE_OVERLAYS: Record<ChatSurfaceMode, string> = {
  standard: "radial-gradient(ellipse at 70% 0%, var(--chat-accent-faint), transparent 50%), radial-gradient(ellipse at 30% 100%, rgba(99,102,241,0.04), transparent 50%)",
  resolver: "radial-gradient(ellipse at 70% 0%, rgba(249,115,22,0.08), transparent 50%), radial-gradient(ellipse at 30% 100%, rgba(249,115,22,0.03), transparent 50%)",
  "mission-thread": "radial-gradient(ellipse at 70% 0%, rgba(56,189,248,0.06), transparent 50%), radial-gradient(ellipse at 30% 100%, rgba(56,189,248,0.03), transparent 50%)",
  "mission-feed": "radial-gradient(ellipse at 70% 0%, rgba(34,197,94,0.05), transparent 50%), radial-gradient(ellipse at 30% 100%, rgba(34,197,94,0.03), transparent 50%)",
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
        "relative flex h-full min-h-0 flex-col overflow-hidden bg-card/80 backdrop-blur-2xl",
        className,
      )}
      style={chatSurfaceVars(mode, accentColor)}
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{ background: MODE_OVERLAYS[mode] }}
      />
      {header ? (
        <div className="relative border-b border-white/[0.04] bg-white/[0.02] backdrop-blur-xl">
          {header}
        </div>
      ) : null}
      <div className={cn("relative min-h-0 flex-1", bodyClassName)}>
        {children}
      </div>
      {footer ? (
        <div className="relative border-t border-white/[0.04] bg-white/[0.02] backdrop-blur-xl">
          {footer}
        </div>
      ) : null}
    </section>
  );
}

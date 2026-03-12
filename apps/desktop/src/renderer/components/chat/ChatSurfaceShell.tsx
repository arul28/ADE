import type { ReactNode } from "react";
import type { ChatSurfaceMode } from "../../../shared/types";
import { cn } from "../ui/cn";
import { chatSurfaceVars } from "./chatSurfaceTheme";

const MODE_OVERLAYS: Record<ChatSurfaceMode, string> = {
  standard: "radial-gradient(circle at top right, var(--chat-accent-glow), transparent 38%), linear-gradient(180deg, rgba(255,255,255,0.02), transparent 22%)",
  resolver: "radial-gradient(circle at top right, var(--chat-accent-glow), transparent 36%), linear-gradient(180deg, rgba(249,115,22,0.09), transparent 24%)",
  "mission-thread": "radial-gradient(circle at top right, var(--chat-accent-glow), transparent 40%), linear-gradient(180deg, rgba(56,189,248,0.08), transparent 28%)",
  "mission-feed": "radial-gradient(circle at top right, var(--chat-accent-glow), transparent 40%), linear-gradient(180deg, rgba(34,197,94,0.07), transparent 28%)",
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
        "relative flex h-full min-h-0 flex-col overflow-hidden border border-border/15 bg-card/90 shadow-[var(--chat-shell-shadow)] backdrop-blur-xl",
        className,
      )}
      style={chatSurfaceVars(mode, accentColor)}
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-90"
        style={{ background: MODE_OVERLAYS[mode] }}
      />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[color:color-mix(in_srgb,var(--chat-accent)_46%,transparent)]" />
      {header ? (
        <div className="relative border-b border-border/10 bg-surface/55 backdrop-blur-xl">
          {header}
        </div>
      ) : null}
      <div className={cn("relative min-h-0 flex-1", bodyClassName)}>
        {children}
      </div>
      {footer ? (
        <div className="relative border-t border-border/10 bg-surface/55 backdrop-blur-xl">
          {footer}
        </div>
      ) : null}
    </section>
  );
}

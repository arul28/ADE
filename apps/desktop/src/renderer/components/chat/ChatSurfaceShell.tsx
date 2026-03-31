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
        "relative flex h-full min-h-0 flex-col overflow-hidden rounded-[var(--chat-radius-shell)] border border-[color:var(--chat-panel-border)] bg-[var(--chat-surface-bg)] shadow-[var(--chat-shell-shadow)]",
        className,
      )}
      style={chatSurfaceVars(mode, accentColor)}
    >
      {header ? (
        <div className="relative border-b border-[color:var(--chat-panel-border)] bg-[var(--chat-panel-bg)]/92 backdrop-blur-xl">
          {header}
        </div>
      ) : null}
      <div className={cn("relative min-h-0 flex-1 overflow-hidden bg-[var(--chat-surface-bg)]", bodyClassName)}>
        {children}
      </div>
      {footer ? (
        <div className="relative border-t border-[color:var(--chat-panel-border)] bg-[var(--chat-panel-bg)]/92 backdrop-blur-xl">
          {footer}
        </div>
      ) : null}
    </section>
  );
}

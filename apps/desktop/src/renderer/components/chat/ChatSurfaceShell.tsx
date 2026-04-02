import type { ReactNode, Ref } from "react";
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
  footerClassName,
  containerRef,
}: {
  mode: ChatSurfaceMode;
  accentColor?: string | null;
  header?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  footerClassName?: string;
  containerRef?: Ref<HTMLElement>;
}) {
  return (
    <section
      ref={containerRef}
      className={cn(
        "relative flex h-full min-h-0 flex-col overflow-hidden",
        className,
      )}
      style={{ ...chatSurfaceVars(mode, accentColor), background: "var(--color-bg)" }}
    >
      {header ? (
        <div
          className="relative z-10 mx-3 mt-2 overflow-hidden rounded-[var(--chat-radius-shell)]"
          style={{
            backdropFilter: "blur(20px)",
            WebkitBackdropFilter: "blur(20px)",
            background: "rgba(30, 30, 40, 0.7)",
            border: "1px solid rgba(255, 255, 255, 0.08)",
            boxShadow: "0 4px 16px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.05)",
          }}
        >
          {header}
        </div>
      ) : null}
      <div className={cn("relative min-h-0 flex-1 overflow-hidden", bodyClassName)}>
        {children}
      </div>
      {footer ? (
        <div className={cn("relative px-3 pb-3 pt-2", footerClassName)} style={{ background: "var(--color-bg)" }}>
          {footer}
        </div>
      ) : null}
    </section>
  );
}

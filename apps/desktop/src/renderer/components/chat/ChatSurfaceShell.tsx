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
          className="relative z-10 mx-3 mt-2.5 overflow-visible rounded-[var(--chat-radius-shell)]"
          style={{
            backdropFilter: "blur(30px)",
            WebkitBackdropFilter: "blur(30px)",
            background: "rgba(20, 18, 32, 0.85)",
            border: "1px solid rgba(255, 255, 255, 0.06)",
            boxShadow: "0 8px 32px -8px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(167, 139, 250, 0.04), inset 0 1px 0 rgba(255, 255, 255, 0.04)",
          }}
        >
          {header}
        </div>
      ) : null}
      <div className={cn("relative min-h-0 flex-1 overflow-hidden", bodyClassName)}>
        {children}
      </div>
      {footer ? (
        <div className={cn("relative px-3 pb-2 pt-0", footerClassName)} style={{ background: "var(--color-bg)" }}>
          {footer}
        </div>
      ) : null}
    </section>
  );
}

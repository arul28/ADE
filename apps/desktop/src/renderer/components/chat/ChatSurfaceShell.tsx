import type { CSSProperties, ReactNode, Ref } from "react";
import type { ChatSurfaceMode } from "../../../shared/types";
import { cn } from "../ui/cn";
import { chatSurfaceVars } from "./chatSurfaceTheme";

export type ChatSurfaceShellLayoutVariant = "standard" | "mobile";

export function ChatSurfaceShell({
  mode,
  accentColor,
  layoutVariant = "standard",
  header,
  footer,
  children,
  className,
  bodyClassName,
  footerClassName,
  containerRef,
  extraSurfaceStyle,
}: {
  mode: ChatSurfaceMode;
  accentColor?: string | null;
  layoutVariant?: ChatSurfaceShellLayoutVariant;
  header?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  footerClassName?: string;
  containerRef?: Ref<HTMLElement>;
  /** Merged into the outer section (e.g. chat font size + zoom from settings). */
  extraSurfaceStyle?: CSSProperties;
}) {
  const mobileChrome = layoutVariant === "mobile";

  return (
    <section
      ref={containerRef}
      data-chat-shell-layout={layoutVariant}
      className={cn(
        "relative flex h-full min-h-0 flex-col overflow-hidden",
        className,
      )}
      style={{
        ...chatSurfaceVars(mode, accentColor),
        background: "var(--color-bg)",
        ...extraSurfaceStyle,
      }}
    >
      {header ? (
        <div
          className={cn(
            "relative z-10 overflow-visible rounded-[var(--chat-radius-shell)]",
            mobileChrome
              ? "mx-2 mt-2"
              : "mx-2 mt-2 sm:mx-3 sm:mt-2.5",
          )}
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
        <div
          className={cn(
            "relative px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-0 sm:px-3 sm:pb-2",
            footerClassName,
          )}
          style={{ background: "var(--color-bg)" }}
        >
          {footer}
        </div>
      ) : null}
    </section>
  );
}

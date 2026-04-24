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
  /** Uniform scale for header, transcript, and composer (CSS transform — works in Firefox; `zoom` does not). */
  contentScale = 1,
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
  contentScale?: number;
}) {
  const mobileChrome = layoutVariant === "mobile";
  const scale = Number.isFinite(contentScale) && contentScale > 0 ? contentScale : 1;
  const scaled = Math.abs(scale - 1) > 0.001;
  const scaleWrapperStyle: CSSProperties | undefined = scaled
    ? {
        transform: `scale(${scale})`,
        transformOrigin: "top left",
        width: `${100 / scale}%`,
        height: `${100 / scale}%`,
        minHeight: 0,
      }
    : undefined;

  const inner = (
    <>
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
            background: "var(--chat-panel-bg)",
            border: "1px solid var(--chat-panel-border)",
            boxShadow: "var(--chat-shell-shadow)",
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
    </>
  );

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
      }}
    >
      {scaled ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden" style={scaleWrapperStyle}>
          {inner}
        </div>
      ) : (
        inner
      )}
    </section>
  );
}

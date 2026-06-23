import type { CSSProperties, ReactNode, Ref } from "react";
import type { ChatChromeTint, ChatShellGeometry } from "../../state/appStore";
import type { ChatSurfaceMode } from "../../../shared/types";
import { cn } from "../ui/cn";
import { ChatChromeTintContext } from "./chatAppearance";
import { chatSurfaceVars } from "./chatSurfaceTheme";

export type ChatSurfaceShellLayoutVariant = "standard" | "mobile";

/** Shared padding for chat shell headers (title row, git toolbar, actions). */
export const CHAT_SHELL_HEADER_CLASS = "space-y-1 px-2 py-1";

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
  /** Legacy transform scale — prefer `--chat-font-size` on `[data-chat-appearance-root]` (usually `1`). */
  contentScale = 1,
  chromeTint = "colored",
  shellGeometry = "default",
  /** When true, shell grows with content (e.g. settings live preview) instead of filling a fixed-height parent. */
  autoHeight = false,
  paneReserveLeft = "0px",
  paneReserveRight = "0px",
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
  chromeTint?: ChatChromeTint;
  shellGeometry?: ChatShellGeometry;
  autoHeight?: boolean;
  /** Horizontal space the chat reserves for open floating side panes (CSS length). */
  paneReserveLeft?: string;
  paneReserveRight?: string;
}) {
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
        <div className="ade-chat-shell-header relative z-10 w-full min-w-0 max-w-full overflow-visible rounded-none">
          {header}
        </div>
      ) : null}
      <div
        className={cn(
          autoHeight ? "relative min-w-0 max-w-full flex-none overflow-x-hidden overflow-y-visible" : "relative min-h-0 min-w-0 max-w-full flex-1 overflow-hidden",
          bodyClassName,
        )}
      >
        {children}
      </div>
      {footer ? (
        <div
          className={cn(
            "relative w-full min-w-0 max-w-full overflow-hidden px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-0 sm:px-3 sm:pb-2",
            footerClassName,
          )}
          style={{ background: "var(--chat-canvas-bg)" }}
        >
          {footer}
        </div>
      ) : null}
    </>
  );

  const geometryAttr =
    shellGeometry !== "default"
      ? ({ "data-chat-shell-geometry": shellGeometry } as const)
      : {};

  return (
    <ChatChromeTintContext.Provider value={chromeTint}>
      <section
        ref={containerRef}
        data-chat-shell-layout={layoutVariant}
        data-chat-chrome-tint={chromeTint}
        {...geometryAttr}
        className={cn(
          "relative flex w-full max-w-full flex-col",
          /* autoHeight: grow with transcript (e.g. settings preview) — avoid min-h-0 or the shell can clip when nested in grid/flex. */
          autoHeight ? "h-auto min-h-min overflow-visible" : "min-h-0 h-full min-w-0 overflow-hidden",
          className,
        )}
        style={{
          ...chatSurfaceVars(mode, accentColor, { chromeTint }),
          background: "var(--chat-canvas-bg)",
          ["--chat-pane-reserve-left" as string]: paneReserveLeft,
          ["--chat-pane-reserve-right" as string]: paneReserveRight,
        } as CSSProperties}
      >
        {scaled ? (
          <div className="flex min-h-0 min-w-0 max-w-full flex-1 flex-col overflow-hidden" style={scaleWrapperStyle}>
            {inner}
          </div>
        ) : (
          inner
        )}
      </section>
    </ChatChromeTintContext.Provider>
  );
}

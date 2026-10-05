import { useLayoutEffect, useRef, useState, type CSSProperties, type DragEventHandler, type ReactNode, type Ref } from "react";
import type { ChatChromeTint, ChatShellGeometry } from "../../state/appStore";
import type { ChatSurfaceMode } from "../../../shared/types";
import { cn } from "../ui/cn";
import { ChatChromeTintContext } from "./chatAppearance";
import { chatSurfaceVars } from "./chatSurfaceTheme";
import { ChatComposerOverlayContext, createChatComposerOverlay } from "./chatComposerOverlayInset";

export type ChatSurfaceShellLayoutVariant = "standard" | "mobile";

/** Canonical chat-header gutter; each title rail inside it owns its 32px height. */
export const CHAT_SHELL_HEADER_CLASS = "px-2";

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
  overlayFooter = false,
  containerRef,
  /** Legacy transform scale — prefer `--chat-font-size` on `[data-chat-appearance-root]` (usually `1`). */
  contentScale = 1,
  chromeTint = "colored",
  shellGeometry = "default",
  /** When true, shell grows with content (e.g. settings live preview) instead of filling a fixed-height parent. */
  autoHeight = false,
  paneReserveRight = "0px",
  canvasFill,
  dropOverlay,
  onDragOverCapture,
  onDropCapture,
  onDragOver,
  onDragLeave,
  onDrop,
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
  /**
   * Float the footer over the bottom of the body instead of stacking it below,
   * so the transcript scrolls behind the composer. The body reads the footer's
   * height from `ChatComposerOverlayContext` to keep its last row clear.
   */
  overlayFooter?: boolean;
  containerRef?: Ref<HTMLElement>;
  contentScale?: number;
  chromeTint?: ChatChromeTint;
  shellGeometry?: ChatShellGeometry;
  autoHeight?: boolean;
  /** Horizontal space the chat reserves for open floating side panes (CSS length). */
  paneReserveRight?: string;
  /**
   * Fill behind the transcript. Transparent on the Work new-chat surface so
   * the shared mesh shows through; everywhere else the chat canvas token.
   */
  canvasFill?: string;
  /** Optional whole-surface drag/drop hooks for hosts such as Work Chat. */
  dropOverlay?: ReactNode;
  onDragOverCapture?: DragEventHandler<HTMLElement>;
  onDropCapture?: DragEventHandler<HTMLElement>;
  onDragOver?: DragEventHandler<HTMLElement>;
  onDragLeave?: DragEventHandler<HTMLElement>;
  onDrop?: DragEventHandler<HTMLElement>;
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

  const fill = canvasFill ?? "var(--chat-canvas-bg)";
  const [overlay] = useState(createChatComposerOverlay);
  const footerRef = useRef<HTMLDivElement | null>(null);
  const footerOverlaid = overlayFooter && footer != null;
  useLayoutEffect(() => {
    const el = footerRef.current;
    if (!footerOverlaid || !el) {
      overlay.footer.set(null);
      overlay.inset.set(0);
      return;
    }
    overlay.footer.set(el);
    if (typeof ResizeObserver === "undefined") {
      overlay.inset.set(el.offsetHeight);
      return () => overlay.footer.set(null);
    }
    // The first observation lands before the first paint, so the transcript
    // never paints a frame with its last row under the composer.
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.borderBoxSize?.[0];
      overlay.inset.set(box ? box.blockSize : el.offsetHeight);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      overlay.footer.set(null);
    };
  }, [footerOverlaid, overlay]);
  const inner = (
    <>
      {header ? (
        <div data-chat-shell-header="" className="ade-chat-shell-header relative z-10 w-full min-w-0 max-w-full overflow-visible rounded-none">
          {header}
        </div>
      ) : null}
      <div
        className={cn(
          autoHeight ? "relative min-w-0 max-w-full flex-none overflow-x-hidden overflow-y-visible" : "relative min-h-0 min-w-0 max-w-full flex-1 overflow-hidden",
          bodyClassName,
        )}
      >
        <ChatComposerOverlayContext.Provider value={overlayFooter ? overlay : null}>
          {children}
        </ChatComposerOverlayContext.Provider>
      </div>
      {footer ? (
        <div
          ref={footerRef}
          /*
            The composer, in the layout that renders it as the shell's footer
            rather than inline. Marked so the Work tab's floating live card can
            measure it and sit above it — the card is in another component tree
            and has no other way to find the one thing it must not cover.
          */
          data-work-live-card-avoid=""
          data-chat-composer-overlay={footerOverlaid ? "" : undefined}
          className={cn(
            "w-full min-w-0 max-w-full overflow-hidden px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-0 sm:px-3 sm:pb-2",
            footerOverlaid ? "absolute inset-x-0 bottom-0 z-20" : "relative",
            footerClassName,
          )}
          style={footerOverlaid ? undefined : { background: fill }}
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
          background: fill,
          ["--chat-pane-reserve-right" as string]: paneReserveRight,
        } as CSSProperties}
        onDragOverCapture={onDragOverCapture}
        onDropCapture={onDropCapture}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {scaled ? (
          <div className="flex min-h-0 min-w-0 max-w-full flex-1 flex-col overflow-hidden" style={scaleWrapperStyle}>
            {inner}
          </div>
        ) : (
          inner
        )}
        {dropOverlay ? (
          <div className="pointer-events-none absolute inset-0 z-50">
            {dropOverlay}
          </div>
        ) : null}
      </section>
    </ChatChromeTintContext.Provider>
  );
}

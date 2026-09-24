import * as RadixDialog from "@radix-ui/react-dialog";
import { useCallback, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { NoticeButton, NoticeCloseButton, NoticeIcon, type NoticeAction } from "../notice/NoticeParts";
import type { NoticeTone } from "../notice/noticeTones";
import { PortalContainerContext } from "../portalContainer";
import { Z_LAYERS } from "../zLayers";
import "./dialog.css";

/**
 * ADE's one modal shell. Every centered modal — a confirm, a prompt, a sign-in
 * flow, a preview — renders through this, so there is exactly one scrim, one
 * panel material, one header, one footer and one focus trap (Radix's).
 *
 * Do not hand-roll `fixed inset-0` + `role="dialog"` markup; if this shell is
 * missing something, add a prop here so every dialog gets it.
 *
 * Anatomy: scrim · panel [ header (icon tile · title · description · ×) · body
 * · footer (actions, right-aligned) ]. Pass `hideHeader` for content that draws
 * its own header; the title still names the dialog for assistive tech.
 */

export type DialogSize = "sm" | "md" | "lg";
export type DialogLayer = "dialog" | "nestedDialog";

const SIZE_WIDTH: Record<DialogSize, number> = { sm: 400, md: 520, lg: 720 };

/** The scrim: one tint, one blur, everywhere. */
export const DIALOG_SCRIM_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(6, 5, 10, 0.58)",
  backdropFilter: "blur(6px)",
  WebkitBackdropFilter: "blur(6px)",
};

/** The panel material (the notice card, lifted). */
export const DIALOG_PANEL_SURFACE: CSSProperties = {
  background: "color-mix(in srgb, var(--color-card) 98%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-border) 88%, var(--color-fg) 12%)",
  borderRadius: 14,
  boxShadow: "var(--shadow-float)",
  color: "var(--color-fg)",
  fontFamily: "var(--font-sans)",
};

export type DialogAction = NoticeAction & {
  /** Receives focus when the dialog opens (the default action). */
  autoFocus?: boolean;
};

export type DialogProps = {
  open: boolean;
  /** Called with `false` on Esc, scrim click and the close button. */
  onOpenChange: (open: boolean) => void;
  /** Sentence case. Always required: it names the dialog for assistive tech. */
  title: ReactNode;
  description?: ReactNode;
  /** Tone of the icon tile and of the footer's primary action. */
  tone?: NoticeTone;
  /** Icon tile: `true` for the tone default, a node for a custom glyph. Omitted: no tile. */
  icon?: ReactNode | boolean;
  size?: DialogSize;
  /** Exact width (px number or CSS length); overrides `size`. */
  width?: number | string;
  /** Exact height (CSS length) for dialogs whose body fills the panel. */
  height?: number | string;
  maxHeight?: number | string;
  /** Draw no header; `title` is still rendered for screen readers. */
  hideHeader?: boolean;
  /** Hide the × close button. */
  hideClose?: boolean;
  closeLabel?: string;
  /** Footer actions, right-aligned. First action defaults to `solid`, the rest to `secondary`. */
  actions?: DialogAction[];
  /** Custom footer content; replaces `actions`. */
  footer?: ReactNode;
  /** Content left of the footer actions (a hint, a checkbox). */
  footerStart?: ReactNode;
  /** Pad the body (default true). */
  bodyPadding?: boolean;
  /** Let the body scroll when it overflows (default true). */
  scrollBody?: boolean;
  bodyStyle?: CSSProperties;
  panelStyle?: CSSProperties;
  panelClassName?: string;
  /** When false, Esc and scrim clicks do nothing (e.g. while busy). Default true. */
  dismissible?: boolean;
  /** When false, scrim clicks do nothing but Esc still closes. Default true. */
  closeOnScrimClick?: boolean;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  /** Element to focus on open. Default: the autoFocus action, else the first focusable. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Skip focusing anything on open. */
  preventAutoFocus?: boolean;
  /** Return focus to what was focused before opening. Default true. */
  returnFocus?: boolean;
  /** `nestedDialog` for a dialog raised from inside another dialog. */
  layer?: DialogLayer;
  /** Aria role. `alertdialog` for confirmations. */
  role?: "dialog" | "alertdialog";
  testId?: string;
  /**
   * Stop clicks inside the dialog from bubbling to its React ancestors (React
   * bubbles through portals) — for dialogs mounted inside a clickable row/tab.
   */
  stopClickPropagation?: boolean;
  children?: ReactNode;
};

function cssLength(value: number | string | undefined): string | undefined {
  if (value == null) return undefined;
  return typeof value === "number" ? `${value}px` : value;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  tone = "neutral",
  icon,
  size = "md",
  width,
  height,
  maxHeight,
  hideHeader = false,
  hideClose = false,
  closeLabel = "Close",
  actions,
  footer,
  footerStart,
  bodyPadding = true,
  scrollBody = true,
  bodyStyle,
  panelStyle,
  panelClassName,
  dismissible = true,
  closeOnScrimClick = true,
  onEscapeKeyDown,
  initialFocusRef,
  preventAutoFocus = false,
  returnFocus = true,
  layer = "dialog",
  role = "dialog",
  testId,
  stopClickPropagation = false,
  children,
}: DialogProps): JSX.Element {
  const zIndex = Z_LAYERS[layer];
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Popovers opened inside a modal dialog must portal into it: Radix blocks
  // pointer events and focus everywhere outside the content.
  const [panelEl, setPanelEl] = useState<HTMLDivElement | null>(null);
  const setPanel = useCallback((node: HTMLDivElement | null) => {
    panelRef.current = node;
    setPanelEl(node);
  }, []);
  const footerRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  if (open && openerRef.current === null && typeof document !== "undefined") {
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }

  const handleOpenAutoFocus = useCallback(
    (event: Event) => {
      if (preventAutoFocus) {
        event.preventDefault();
        panelRef.current?.focus();
        return;
      }
      const explicit = initialFocusRef?.current;
      if (explicit) {
        event.preventDefault();
        explicit.focus();
        return;
      }
      const index = actions?.findIndex((action) => action.autoFocus) ?? -1;
      if (index >= 0) {
        const button = footerRef.current?.querySelectorAll<HTMLButtonElement>("button")[index];
        if (button && !button.disabled) {
          event.preventDefault();
          button.focus();
        }
      }
    },
    [actions, initialFocusRef, preventAutoFocus],
  );

  const handleCloseAutoFocus = useCallback(
    (event: Event) => {
      const opener = openerRef.current;
      openerRef.current = null;
      if (!returnFocus) return;
      // Radix returns focus to a Trigger; these dialogs are opened
      // programmatically, so return it to whatever held it before.
      event.preventDefault();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    },
    [returnFocus],
  );

  const resolvedWidth = cssLength(width) ?? `${SIZE_WIDTH[size]}px`;
  const hasFooter = Boolean(footer || footerStart || (actions && actions.length > 0));
  const titleIsText = typeof title === "string";

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="ade-dialog-scrim" style={{ ...DIALOG_SCRIM_STYLE, zIndex }} />
        <RadixDialog.Content
          ref={setPanel}
          role={role}
          aria-modal="true"
          {...(description ? {} : { "aria-describedby": undefined })}
          data-testid={testId}
          className={panelClassName ? `ade-dialog-panel ${panelClassName}` : "ade-dialog-panel"}
          tabIndex={-1}
          style={{
            ...DIALOG_PANEL_SURFACE,
            // Centered the way a UA <dialog> is — inset 0 + auto margins — not
            // with a transform: a transformed panel would become the containing
            // block for the `position: fixed` popovers that portal into it.
            position: "fixed",
            inset: 0,
            margin: "auto",
            zIndex,
            width: `min(${resolvedWidth}, calc(100vw - 32px))`,
            height: cssLength(height) ?? "fit-content",
            maxHeight: cssLength(maxHeight) ?? "calc(100vh - 48px)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            outline: "none",
            ...panelStyle,
          }}
          onClick={stopClickPropagation ? (event) => event.stopPropagation() : undefined}
          onOpenAutoFocus={handleOpenAutoFocus}
          onCloseAutoFocus={handleCloseAutoFocus}
          onEscapeKeyDown={(event) => {
            onEscapeKeyDown?.(event);
            if (!dismissible) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (!dismissible || !closeOnScrimClick) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (!dismissible || !closeOnScrimClick) event.preventDefault();
          }}
        >
          <PortalContainerContext.Provider value={panelEl}>
            {hideHeader ? (
              <RadixDialog.Title className="ade-dialog-sr-only">{title}</RadixDialog.Title>
            ) : (
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 12,
                  padding: "18px 18px 0 20px",
                  flexShrink: 0,
                }}
              >
                {icon ? <NoticeIcon tone={tone} icon={icon === true ? undefined : icon} size="lg" /> : null}
                <div style={{ minWidth: 0, flex: 1, paddingTop: icon ? 1 : 2 }}>
                  <RadixDialog.Title
                    style={{
                      margin: 0,
                      fontSize: 14,
                      fontWeight: 600,
                      lineHeight: "20px",
                      color: "var(--color-fg)",
                      overflowWrap: "anywhere",
                    }}
                  >
                    {title}
                  </RadixDialog.Title>
                  {description ? (
                    <RadixDialog.Description
                      style={{
                        margin: "3px 0 0",
                        fontSize: 12.5,
                        lineHeight: 1.5,
                        color: "var(--color-muted-fg)",
                        whiteSpace: "pre-wrap",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {description}
                    </RadixDialog.Description>
                  ) : null}
                </div>
                {!hideClose ? (
                  <NoticeCloseButton
                    onClick={() => {
                      if (dismissible) onOpenChange(false);
                    }}
                    label={titleIsText ? `${closeLabel} ${title}` : closeLabel}
                    title={closeLabel}
                    size={26}
                  />
                ) : null}
              </div>
            )}
            {hideHeader && description ? (
              <RadixDialog.Description className="ade-dialog-sr-only">{description}</RadixDialog.Description>
            ) : null}
            {children != null ? (
              <div
                className="ade-dialog-body"
                data-scroll-lock-scrollable=""
                style={{
                  flex: height != null ? 1 : "0 1 auto",
                  minHeight: 0,
                  overflowY: scrollBody ? "auto" : "hidden",
                  overflowX: "hidden",
                  padding: bodyPadding ? (hideHeader ? "18px 20px" : "14px 20px 4px") : 0,
                  fontSize: 12.5,
                  lineHeight: 1.5,
                  color: "var(--color-secondary-fg, var(--color-fg))",
                  ...bodyStyle,
                }}
              >
                {children}
              </div>
            ) : null}
            {hasFooter ? (
              <div
                ref={footerRef}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "flex-end",
                  gap: 8,
                  padding: "14px 20px 18px",
                  flexShrink: 0,
                }}
              >
                {footerStart ? <div style={{ marginRight: "auto", minWidth: 0 }}>{footerStart}</div> : null}
                {footer ??
                  actions?.map((action, index) => (
                    <NoticeButton
                      key={`${action.label}-${index}`}
                      action={action}
                      tone={tone}
                      size="md"
                      fallbackVariant={index === 0 ? "solid" : "secondary"}
                    />
                  ))}
              </div>
            ) : !children && !hideHeader ? (
              <div style={{ height: 18, flexShrink: 0 }} />
            ) : null}
          </PortalContainerContext.Provider>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/** Footer actions laid out the dialog way, for dialogs that build a custom `footer`. */
export function DialogActions({
  actions,
  tone = "neutral",
}: {
  actions: DialogAction[];
  tone?: NoticeTone;
}): JSX.Element {
  return (
    <>
      {actions.map((action, index) => (
        <NoticeButton
          key={`${action.label}-${index}`}
          action={action}
          tone={tone}
          size="md"
          fallbackVariant={index === 0 ? "solid" : "secondary"}
        />
      ))}
    </>
  );
}

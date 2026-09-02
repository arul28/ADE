/**
 * The shared shape of a provider catalog.
 *
 * OpenCode and Pi each present ~40 providers the same way — a grid of compact
 * tiles, a search field, and a detail dialog — and the two grew as independent
 * copies that had already drifted apart on type weight. These are the pieces
 * both sections build from, so a change to the pattern lands once.
 */
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CaretRight, CheckCircle, MagnifyingGlass, X } from "@phosphor-icons/react";
import { ProviderLogo } from "../shared/ProviderLogos";
import { COLORS, MONO_FONT, SANS_FONT } from "../lanes/laneDesignTokens";

export function panel(overrides?: React.CSSProperties): React.CSSProperties {
  return {
    border: `1px solid ${COLORS.border}`,
    background: COLORS.recessedBg,
    padding: 12,
    ...overrides,
  };
}

export function ProviderGrid({
  minWidth = 200,
  autoFit = false,
  gap = 8,
  children,
}: {
  minWidth?: number;
  /**
   * `auto-fit` collapses the empty tracks so a short row stretches to fill the
   * width; `auto-fill` keeps them, which is what a dense sub-provider catalog
   * wants. The top-level provider grid is the first case.
   */
  autoFit?: boolean;
  gap?: number;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${autoFit ? "auto-fit" : "auto-fill"}, minmax(min(100%, ${minWidth}px), 1fr))`,
        gap,
      }}
    >
      {children}
    </div>
  );
}

export function ProviderSearchField({
  label,
  value,
  onChange,
}: {
  /** Doubles as the accessible name and the placeholder, so it must name the
   *  harness — both catalogs are on the same page. */
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        border: `1px solid ${COLORS.border}`,
        background: COLORS.cardBg,
        padding: "4px 8px",
        minWidth: 220,
      }}
    >
      <MagnifyingGlass size={12} style={{ color: COLORS.textMuted, flexShrink: 0 }} />
      <input
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={label}
        style={{
          flex: 1,
          minWidth: 0,
          background: "transparent",
          border: "none",
          outline: "none",
          fontSize: 11,
          fontFamily: MONO_FONT,
          color: COLORS.textPrimary,
        }}
      />
    </div>
  );
}

/**
 * One provider in a catalog grid. A real button, because opening a provider is
 * an action — `aria-label` names the harness so two catalogs on one page never
 * present two identically-named controls.
 */
export function ProviderTile({
  id,
  name,
  badge,
  ariaLabel,
  footer,
  logo,
  accentColor,
  padding = 10,
  minHeight = 72,
  wrapName = false,
  onOpen,
}: {
  id: string;
  name: string;
  /** Right-hand status chip; pass an element for a connected tag. */
  badge: React.ReactNode;
  ariaLabel: string;
  footer?: React.ReactNode;
  /** Overrides the generic brand mark — the six first-class providers have their own. */
  logo?: React.ReactNode;
  /** Left status rule, used by the top-level provider grid. */
  accentColor?: string;
  padding?: number;
  minHeight?: number;
  /**
   * Let a long name take a second line instead of clipping to an ellipsis.
   *
   * A dense sub-catalog of forty vendors wants every row the same height, so it
   * clips. The top-level provider grid is the opposite case: there are ten
   * cards, the name is the card's identity, and "GitHub Co…" is a worse tile
   * than a two-line title.
   */
  wrapName?: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={ariaLabel}
      style={{
        ...panel({ padding }),
        ...(accentColor ? { borderLeft: `3px solid ${accentColor}` } : {}),
        display: "flex",
        flexDirection: "column",
        gap: 8,
        textAlign: "left",
        cursor: "pointer",
        width: "100%",
        minHeight,
        background: COLORS.recessedBg,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: 1 }}>
          {logo ?? <ProviderLogo family={id} size={22} />}
          <span
            data-testid={`provider-tile-name-${id}`}
            style={{
              fontSize: 12,
              fontFamily: SANS_FONT,
              color: COLORS.textPrimary,
              minWidth: 0,
              ...(wrapName
                ? { overflowWrap: "anywhere", lineHeight: 1.3 }
                : { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }),
            }}
          >
            {name}
          </span>
        </div>
        {badge}
      </div>
      {footer}
    </button>
  );
}

export function ConnectedTag() {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "3px 8px",
        fontSize: 10,
        fontFamily: MONO_FONT,
        color: COLORS.success,
        background: "color-mix(in srgb, var(--color-success) 14%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-success) 30%, transparent)",
      }}
    >
      <CheckCircle size={12} weight="fill" /> Connected
    </span>
  );
}

/** The uppercase chip a tile shows when it is not connected. */
export function ProviderTileBadge({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: 9,
        fontFamily: MONO_FONT,
        color: COLORS.textMuted,
        textTransform: "uppercase",
        letterSpacing: "0.6px",
      }}
    >
      {children}
    </span>
  );
}

/**
 * A provider card that can be folded down to its header.
 *
 * The arrow belongs to the whole card, not to a band inside it: these sections
 * run to dozens of providers each, and what a user scrolling Settings wants is
 * to put the entire harness away, not to collapse one list within it.
 */
export function CollapsibleProviderCard({
  title,
  summary,
  logo,
  status,
  accentColor,
  defaultOpen = true,
  children,
}: {
  title: string;
  /** The one line that survives collapsing. */
  summary: React.ReactNode;
  logo: React.ReactNode;
  status?: React.ReactNode;
  accentColor: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section style={panel({ borderLeft: `3px solid ${accentColor}`, padding: 14 })}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <button
            type="button"
            onClick={() => setOpen((current) => !current)}
            aria-expanded={open}
            aria-label={`${open ? "Collapse" : "Expand"} ${title}`}
            style={{
              border: "none",
              background: "transparent",
              color: COLORS.textMuted,
              cursor: "pointer",
              padding: 0,
              display: "inline-flex",
              alignItems: "center",
              flexShrink: 0,
            }}
          >
            <CaretRight
              size={14}
              weight="bold"
              style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform 120ms ease" }}
            />
          </button>
          {logo}
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontFamily: SANS_FONT, fontWeight: 700, color: COLORS.textPrimary }}>{title}</div>
            <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.35 }}>{summary}</div>
          </div>
        </div>
        {status}
      </div>
      {open ? children : null}
    </section>
  );
}

/**
 * Modal shell for a provider's own page: overlay, Escape, focus in and back
 * out, and the identifying header. Callers supply only the body.
 */
export function ProviderDetailDialog({
  providerId,
  title,
  subtitle,
  suspended = false,
  onClose,
  children,
}: {
  providerId: string;
  title: string;
  subtitle: React.ReactNode;
  /** A dialog of its own is open on top; yield Escape and focus to it. */
  suspended?: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (suspended) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      // `aria-modal` tells assistive tech the page behind is inert; without a
      // trap, Tab still walks into it, so a keyboard user leaves the dialog
      // with no way back and no idea it is still open.
      if (event.key !== "Tab") return;
      const node = dialogRef.current;
      if (!node) return;
      const focusable = [...node.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => element.offsetParent !== null || element === node);
      const first = focusable[0] ?? node;
      const last = focusable[focusable.length - 1] ?? node;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === node)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, suspended]);

  // Move focus into the dialog so keyboard users aren't acting under the overlay.
  useEffect(() => {
    if (suspended) return;
    const node = dialogRef.current;
    if (!node) return;
    const previous = document.activeElement as HTMLElement | null;
    node.focus();
    return () => {
      previous?.focus?.();
    };
  }, [suspended]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.70)" }}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${title} provider`}
        tabIndex={-1}
        className="w-full max-w-md max-h-[85vh] overflow-y-auto outline-none"
        style={{
          background: COLORS.cardBgSolid,
          border: `1px solid ${COLORS.outlineBorder}`,
          boxShadow: "0 28px 80px -36px rgba(0,0,0,0.82)",
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 16px",
            height: 52,
            borderBottom: `1px solid ${COLORS.border}`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            <ProviderLogo family={providerId} size={24} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontFamily: SANS_FONT, fontWeight: 700, color: COLORS.textPrimary }}>
                {title}
              </div>
              <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textMuted }}>{subtitle}</div>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              border: `1px solid ${COLORS.border}`,
              background: "transparent",
              color: COLORS.textSecondary,
              width: 26,
              height: 26,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
            }}
          >
            <X size={13} weight="bold" />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

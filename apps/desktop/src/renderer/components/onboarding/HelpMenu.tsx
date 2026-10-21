import React, { useCallback, useRef, useState } from "react";
import { Question, ArrowSquareOut, Check } from "@phosphor-icons/react";
import { useAppStore } from "../../state/appStore";
import { openExternalUrl } from "../../lib/openExternal";
import { docs } from "../../onboarding/docsLinks";
import { cn } from "../ui/cn";
import { fgTint } from "../lanes/laneDesignTokens";
import { AnchoredMenu } from "../ui/AnchoredMenu";
import { MENU_SURFACE_CLASS } from "../ui/paneMenuTokens";
import { Z_LAYERS } from "../ui/zLayers";
import { showMeAroundAgain } from "../../onboarding/onboardingProgress";
import { openAdeTips } from "./tips/AdeTipsDialog";
import { openWhatsNew } from "../announcements/AnnouncementsHost";

/**
 * The question-mark menu: docs, ADE Tips, the welcome tour again, and help
 * preferences.
 * `align` picks which edge of the button the menu lines up with; a button near
 * the left edge of the window wants "start" so the menu opens into the window.
 * `side` picks where it opens: under the button, or above it for a button at
 * the bottom of the window (the project sidebar footer).
 */
export function HelpMenu({
  align = "end",
  side = "below",
  className,
  iconSize = 14,
}: {
  align?: "start" | "end";
  side?: "below" | "above";
  className?: string;
  iconSize?: number;
} = {}) {
  const smartTooltipsEnabled = useAppStore((s) => s.smartTooltipsEnabled);
  const setSmartTooltipsEnabled = useAppStore((s) => s.setSmartTooltipsEnabled);

  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => setOpen(false), []);

  const handleOpenDocs = useCallback(() => {
    close();
    openExternalUrl(docs.home);
  }, [close]);

  const handleOpenTips = useCallback(() => {
    close();
    openAdeTips();
  }, [close]);

  const handleOpenWhatsNew = useCallback(() => {
    close();
    openWhatsNew();
  }, [close]);

  // A fresh start: every first-run hint comes back, and the welcome flow shows again.
  const handleShowAround = useCallback(() => {
    close();
    showMeAroundAgain();
  }, [close]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label="Help menu"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Help · ADE Tips, docs, and preferences"
        className={cn(
          "inline-flex items-center justify-center",
          "transition-[background-color,color,border-color,box-shadow] duration-150",
          className,
        )}
        data-state={open ? "open" : undefined}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        style={{
          WebkitAppRegion: "no-drag",
          color: open ? "var(--color-accent)" : undefined,
        } as React.CSSProperties}
      >
        <Question size={iconSize} weight={open ? "fill" : "regular"} />
      </button>

      <AnchoredMenu
        open={open}
        anchorRef={buttonRef}
        onClose={close}
        placement={`${side === "above" ? "top" : "bottom"}-${align}`}
        offset={6}
        zIndex={Z_LAYERS.popover}
        role="menu"
        aria-label="Help"
        className={cn(MENU_SURFACE_CLASS, "ade-help-menu")}
        // The shared menu paint; the help rows keep their own type size.
        style={{ minWidth: 268, fontSize: 12.5 }}
      >
        <MenuItem onClick={handleOpenWhatsNew}>What's new</MenuItem>
        <MenuItem onClick={handleOpenTips}>ADE Tips</MenuItem>
        <MenuItem onClick={handleShowAround}>Show me around again</MenuItem>
        <MenuItem onClick={handleOpenDocs}>
          <span style={{ flex: 1, textAlign: "left" }}>ADE Docs</span>
          <ArrowSquareOut size={11} weight="regular" />
        </MenuItem>

        <MenuDivider />

        <SectionLabel>Help preferences</SectionLabel>
        <CheckboxItem
          checked={smartTooltipsEnabled}
          onToggle={() => setSmartTooltipsEnabled(!smartTooltipsEnabled)}
          label="Show detailed hover tooltips"
          hint="Extra detail appears when you hover a button — what it does and what would happen."
        />
      </AnchoredMenu>
    </>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "6px 10px 2px",
        fontSize: 10.5,
        opacity: 0.6,
        textTransform: "uppercase",
        letterSpacing: 0.5,
      }}
    >
      {children}
    </div>
  );
}

function MenuItem({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="ade-help-menu-item"
      style={{
        alignItems: "center",
        padding: "6px 10px",
        gap: 6,
      }}
    >
      {children}
    </button>
  );
}

function CheckboxItem({
  checked,
  onToggle,
  label,
  hint,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
  hint?: string;
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={onToggle}
      className="ade-help-menu-item"
      style={{
        alignItems: "flex-start",
        gap: 8,
        padding: "7px 10px",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 14,
          height: 14,
          marginTop: 1,
          flex: "0 0 auto",
          borderRadius: 3,
          border: "1px solid rgba(255,255,255,0.24)",
          background: checked ? "var(--color-accent)" : "transparent",
          color: checked ? "var(--color-accent-fg, #0b0a14)" : "transparent",
        }}
      >
        {checked ? <Check size={10} weight="bold" /> : null}
      </span>
      <span style={{ flex: 1 }}>
        <span style={{ display: "block", fontSize: 12.5 }}>{label}</span>
        {hint ? (
          <span
            style={{
              display: "block",
              marginTop: 2,
              fontSize: 11,
              lineHeight: 1.4,
              color: "var(--color-muted-fg, #908FA0)",
            }}
          >
            {hint}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function MenuDivider() {
  return (
    <div
      role="separator"
      style={{
        height: 1,
        margin: "4px 0",
        background: fgTint(8),
      }}
    />
  );
}

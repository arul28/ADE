import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Question, ArrowSquareOut, Check } from "@phosphor-icons/react";
import { useAppStore } from "../../state/appStore";
import { openExternalUrl } from "../../lib/openExternal";
import { docs } from "../../onboarding/docsLinks";
import { cn } from "../ui/cn";
import { ADE_WELCOME_VIDEO_REPLAY_EVENT } from "../../../shared/welcomeVideo";

type MenuPosition = { top: number; right: number } | null;

export function HelpMenu() {
  const smartTooltipsEnabled = useAppStore((s) => s.smartTooltipsEnabled);
  const setSmartTooltipsEnabled = useAppStore((s) => s.setSmartTooltipsEnabled);

  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<MenuPosition>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setPosition(null);
  }, []);

  const openAt = useCallback(() => {
    const el = buttonRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPosition({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    setOpen(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Node)) return;
      if (menuRef.current?.contains(e.target)) return;
      if (buttonRef.current?.contains(e.target)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  const handleOpenDocs = useCallback(() => {
    close();
    openExternalUrl(docs.home);
  }, [close]);

  const handleReplayWelcomeVideo = useCallback(() => {
    close();
    window.dispatchEvent(new Event(ADE_WELCOME_VIDEO_REPLAY_EVENT));
  }, [close]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label="Help menu"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Help · welcome video, docs, and preferences"
        className={cn(
          "ade-shell-control ade-shell-header-utility-btn inline-flex items-center justify-center",
          "transition-[background-color,color,border-color,box-shadow] duration-150",
        )}
        onClick={() => (open ? close() : openAt())}
        style={{
          WebkitAppRegion: "no-drag",
          color: open ? "var(--color-accent)" : undefined,
        } as React.CSSProperties}
      >
        <Question size={14} weight={open ? "fill" : "regular"} />
      </button>

      {open && position
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              aria-label="Help"
              className="ade-help-menu"
              style={{
                position: "fixed",
                top: position.top,
                right: position.right,
                zIndex: 9999,
                minWidth: 268,
                padding: 4,
                borderRadius: 10,
                background: "var(--color-popup-bg, #141022)",
                border: "1px solid rgba(255, 255, 255, 0.12)",
                boxShadow: "0 16px 40px -10px rgba(0,0,0,0.55), 0 0 0 1px rgba(167,139,250,0.05)",
                color: "var(--color-fg, #F0F0F2)",
                fontSize: 12.5,
              }}
            >
              <MenuItem onClick={handleOpenDocs}>
                <span style={{ flex: 1, textAlign: "left" }}>ADE Docs</span>
                <ArrowSquareOut size={11} weight="regular" />
              </MenuItem>
              <MenuItem onClick={handleReplayWelcomeVideo}>Replay Welcome Video</MenuItem>

              <MenuDivider />

              <SectionLabel>Help preferences</SectionLabel>
              <CheckboxItem
                checked={smartTooltipsEnabled}
                onToggle={() => setSmartTooltipsEnabled(!smartTooltipsEnabled)}
                label="Show detailed hover tooltips"
                hint="Extra detail appears when you hover a button — what it does and what would happen."
              />
            </div>,
            document.body,
          )
        : null}
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
        background: "rgba(255,255,255,0.08)",
      }}
    />
  );
}

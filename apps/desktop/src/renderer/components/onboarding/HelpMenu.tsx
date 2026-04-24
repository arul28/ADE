import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Question, ArrowSquareOut, Check } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../../state/appStore";
import { useOnboardingStore } from "../../state/onboardingStore";
import {
  getTour,
  listTours,
  type TourVariant,
} from "../../onboarding/registry";
import { openExternalUrl } from "../../lib/openExternal";
import { docs } from "../../onboarding/docsLinks";
import { cn } from "../ui/cn";

const TOUR_TARGET_WAIT_TIMEOUT_MS = 10_000;
const TOUR_TARGET_POLL_MS = 50;
const FULL_TUTORIAL_ID = "first-journey";

type MenuPosition = { top: number; right: number } | null;

export function HelpMenu() {
  const navigate = useNavigate();
  const smartTooltipsEnabled = useAppStore((s) => s.smartTooltipsEnabled);
  const setSmartTooltipsEnabled = useAppStore((s) => s.setSmartTooltipsEnabled);
  const onboardingEnabled = useAppStore((s) => s.onboardingEnabled);
  const setOnboardingEnabled = useAppStore((s) => s.setOnboardingEnabled);
  const didYouKnowEnabled = useAppStore((s) => s.didYouKnowEnabled);
  const setDidYouKnowEnabled = useAppStore((s) => s.setDidYouKnowEnabled);
  const openWizard = useOnboardingStore((s) => s.openWizard);
  const startTour = useOnboardingStore((s) => s.startTour);
  const progress = useOnboardingStore((s) => s.progress);

  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<MenuPosition>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const pendingTourAbortRef = useRef<AbortController | null>(null);

  const tours = useMemo(() => {
    const byId = new Map<string, ReturnType<typeof listTours>[number]>();
    for (const tour of listTours()) {
      const existing = byId.get(tour.id);
      if (!existing || (existing.steps.length === 0 && tour.steps.length > 0)) {
        byId.set(tour.id, tour);
      }
    }
    return [...byId.values()];
  }, []);
  const fullTutorial = tours.find((tour) => tour.id === FULL_TUTORIAL_ID && tour.steps.length > 0);
  const menuTours = tours.filter((tour) => tour.id !== FULL_TUTORIAL_ID);

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
      const t = e.target as Node | null;
      if (!t) return;
      if (menuRef.current?.contains(t)) return;
      if (buttonRef.current?.contains(t)) return;
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

  useEffect(() => {
    return () => {
      pendingTourAbortRef.current?.abort();
    };
  }, []);

  const handleReplayWizard = useCallback(() => {
    close();
    openWizard();
  }, [close, openWizard]);

  const handleStartTour = useCallback(
    (tourId: string, variant: TourVariant | undefined, route: string) => {
      close();
      pendingTourAbortRef.current?.abort();
      const controller = new AbortController();
      pendingTourAbortRef.current = controller;
      navigate(route);
      void waitForTourFirstTarget(tourId, variant, controller.signal).then((ready) => {
        if (!ready || controller.signal.aborted) return;
        if (pendingTourAbortRef.current === controller) {
          pendingTourAbortRef.current = null;
        }
        void startTour(tourId, variant);
      });
    },
    [close, navigate, startTour],
  );

  const handleOpenGlossary = useCallback(() => {
    close();
    navigate("/glossary");
  }, [close, navigate]);

  const handleOpenDocs = useCallback(() => {
    close();
    openExternalUrl(docs.home);
  }, [close]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-tour="app.helpMenu"
        aria-label="Help menu"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Help · tours, glossary, and preferences"
        className={cn(
          "ade-shell-control inline-flex h-[20px] w-[20px] items-center justify-center",
          "transition-[background-color,color,border-color,box-shadow] duration-150"
        )}
        onClick={() => (open ? close() : openAt())}
        style={{
          WebkitAppRegion: "no-drag",
          color: open ? "var(--color-accent)" : undefined,
        } as React.CSSProperties}
      >
        <Question size={12} weight={open ? "fill" : "regular"} />
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
              <MenuItem
                onClick={
                  fullTutorial
                    ? () => handleStartTour(fullTutorial.id, fullTutorial.variant, fullTutorial.route)
                    : undefined
                }
                disabled={!fullTutorial}
                weight="strong"
              >
                Start Full Tutorial
              </MenuItem>
              <MenuItem onClick={handleReplayWizard}>Replay Welcome Wizard</MenuItem>

              <MenuDivider />

              <SectionLabel>Tours</SectionLabel>
              {menuTours.length === 0 ? (
                <div style={{ padding: "6px 10px", opacity: 0.6 }}>No tours registered yet.</div>
              ) : (
                menuTours.map((tour) => {
                  const isStub = tour.steps.length === 0;
                  const completed = progress?.tours[tour.id]?.completedAt != null;
                  return (
                    <MenuItem
                      key={`${tour.id}:${tour.variant ?? "full"}`}
                      onClick={
                        isStub
                          ? undefined
                          : () => handleStartTour(tour.id, tour.variant, tour.route)
                      }
                      disabled={isStub}
                    >
                      <span style={{ flex: 1, textAlign: "left" }}>{tour.title}</span>
                      {isStub ? (
                        <span
                          style={{
                            fontSize: 10,
                            padding: "1px 6px",
                            borderRadius: 6,
                            background: "rgba(255,255,255,0.06)",
                            color: "var(--color-muted-fg, #908FA0)",
                          }}
                        >
                          Coming soon
                        </span>
                      ) : completed ? (
                        <Check size={12} weight="bold" aria-label="Completed" />
                      ) : null}
                    </MenuItem>
                  );
                })
              )}

              <MenuDivider />

              <MenuItem onClick={handleOpenGlossary}>Open Glossary</MenuItem>
              <MenuItem onClick={handleOpenDocs}>
                <span style={{ flex: 1, textAlign: "left" }}>ADE Docs</span>
                <ArrowSquareOut size={11} weight="regular" />
              </MenuItem>

              <MenuDivider />

              <SectionLabel>Help preferences</SectionLabel>
              <CheckboxItem
                checked={onboardingEnabled}
                onToggle={() => setOnboardingEnabled(!onboardingEnabled)}
                label="Show tours and help chips"
                hint="Welcome wizard, guided tours, and the ‘?’ icons on confusing controls."
              />
              <CheckboxItem
                checked={smartTooltipsEnabled}
                onToggle={() => setSmartTooltipsEnabled(!smartTooltipsEnabled)}
                label="Show detailed hover tooltips"
                hint="Extra detail appears when you hover a button — what it does and what would happen."
              />
              <CheckboxItem
                checked={didYouKnowEnabled}
                onToggle={() => setDidYouKnowEnabled(!didYouKnowEnabled)}
                label="Show ‘Did you know’ hints"
                hint="One gentle tip per session, dismissible."
              />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function waitForTourFirstTarget(
  tourId: string,
  variant: TourVariant | undefined,
  signal: AbortSignal,
): Promise<boolean> {
  const tour = getTour(tourId, variant);
  const firstStep = tour?.steps[0];
  const selector = firstStep?.waitForSelector?.trim() || firstStep?.target?.trim();
  if (!selector) return Promise.resolve(Boolean(firstStep));

  const hasTarget = () => {
    if (signal.aborted) return false;
    try {
      return document.querySelector(selector) != null;
    } catch {
      return false;
    }
  };

  if (hasTarget()) return Promise.resolve(true);

  return new Promise((resolve) => {
    let settled = false;
    let interval: number | undefined;
    let timeout: number | undefined;
    const observer =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver(() => {
            if (hasTarget()) settle(true);
          })
        : null;

    const settle = (ready: boolean) => {
      if (settled) return;
      settled = true;
      if (interval != null) window.clearInterval(interval);
      if (timeout != null) window.clearTimeout(timeout);
      observer?.disconnect();
      signal.removeEventListener("abort", onAbort);
      resolve(ready);
    };

    const onAbort = () => settle(false);
    signal.addEventListener("abort", onAbort, { once: true });
    observer?.observe(document.body, { childList: true, subtree: true });
    interval = window.setInterval(() => {
      if (hasTarget()) settle(true);
    }, TOUR_TARGET_POLL_MS);
    timeout = window.setTimeout(() => settle(hasTarget()), TOUR_TARGET_WAIT_TIMEOUT_MS);
  });
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

type MenuItemProps = {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  weight?: "normal" | "strong";
  /** When true, clicking does not bubble a close to the menu (for checkbox-style items). */
  keepOpen?: boolean;
};

function MenuItem({ children, onClick, disabled, weight = "normal", keepOpen }: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={(e) => {
        if (disabled) return;
        if (keepOpen) e.stopPropagation();
        onClick?.();
      }}
      className="ade-help-menu-item"
      style={{
        display: "flex",
        alignItems: "center",
        width: "100%",
        padding: "6px 10px",
        background: "transparent",
        color: "inherit",
        border: "none",
        borderRadius: 6,
        textAlign: "left",
        font: "inherit",
        fontWeight: weight === "strong" ? 700 : undefined,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
        gap: 6,
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.06)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = "transparent";
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
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className="ade-help-menu-item"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        width: "100%",
        padding: "7px 10px",
        background: "transparent",
        color: "inherit",
        border: "none",
        borderRadius: 6,
        textAlign: "left",
        font: "inherit",
        cursor: "pointer",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.06)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = "transparent";
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

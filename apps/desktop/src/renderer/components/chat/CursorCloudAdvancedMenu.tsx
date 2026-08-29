import { CaretDown, Info } from "@phosphor-icons/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { CursorCloudExistingPr } from "../../lib/cursorCloudUtils";
import { cn } from "../ui/cn";
import { SmartTooltip } from "../ui/SmartTooltip";
import {
  computeLanePopoverPlacement,
  type LanePopoverPlacement,
} from "../terminals/LaneCombobox";
import { CursorCloudSecretsList, isInjectableCloudSecretName } from "./CursorCloudSecretsPicker";

const MENU_WIDTH = 260;

function existingPrLabel(pr: CursorCloudExistingPr): string {
  if (pr.prNumber != null) return `Attach to PR #${pr.prNumber}`;
  return "Attach to existing PR";
}

/**
 * One compact Advanced control for Cursor Cloud draft launches.
 * Holds Open-a-PR / attach-to-existing-PR and Attach ADE secrets so those
 * chips cannot overlap the machine/lane pickers.
 */
export function CursorCloudAdvancedMenu({
  autoCreatePR,
  onAutoCreatePRChange,
  existingPr,
  hideExistingPr,
  availableNames,
  selectedNames,
  remember,
  onSelectedNamesChange,
  onRememberChange,
}: {
  autoCreatePR: boolean;
  onAutoCreatePRChange: (next: boolean) => void;
  existingPr: CursorCloudExistingPr | null;
  /** Auto-create lanes have no branch PR yet. */
  hideExistingPr?: boolean;
  availableNames: string[];
  selectedNames: string[];
  remember: boolean;
  onSelectedNamesChange: (names: string[]) => void;
  onRememberChange: (remember: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<LanePopoverPlacement | null>(null);
  const attachPr = hideExistingPr ? null : existingPr;
  const secretCount = selectedNames.filter(isInjectableCloudSecretName).length;
  const active = Boolean(attachPr) || autoCreatePR || secretCount > 0;

  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setPlacement(computeLanePopoverPlacement({
      trigger: { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      width: { min: MENU_WIDTH, max: MENU_WIDTH },
    }));
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const handleDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", handleDown);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handleDown);
      window.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  return (
    <div className="relative inline-flex shrink-0">
      <SmartTooltip
        forceEnabled
        content={{
          label: "Advanced",
          description: attachPr
            ? "This branch already has a PR, so Cursor will work on it. Optionally attach ADE secrets as env vars."
            : "Open a PR when the run finishes, or attach ADE secrets as cloud env vars.",
        }}
      >
        <button
          ref={triggerRef}
          type="button"
          data-cursor-cloud-advanced
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Advanced"
          onClick={() => setOpen((current) => !current)}
          className={cn(
            "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 font-sans text-[11px] font-medium transition-colors",
            active || open
              ? "border-violet-300/30 bg-violet-500/[0.16] text-violet-100/90"
              : "border-white/[0.07] bg-white/[0.03] text-muted-fg/75 hover:bg-white/[0.06] hover:text-fg/85",
          )}
        >
          Advanced
          <CaretDown
            size={9}
            weight="bold"
            className={cn("shrink-0 transition-transform duration-150", open && "rotate-180")}
            aria-hidden
          />
        </button>
      </SmartTooltip>
      {open && triggerRef.current
        ? createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label="Cursor Cloud advanced"
            data-cursor-cloud-advanced-menu
            className="fixed z-[100] overflow-hidden rounded-xl border border-white/[0.08] bg-[#13111A]/95 p-1.5 shadow-[0_18px_48px_rgba(0,0,0,0.55)] backdrop-blur-md"
            style={{
              width: placement?.width ?? MENU_WIDTH,
              left: placement?.left ?? 0,
              maxHeight: placement?.maxHeight,
              top: placement?.top ?? 0,
              transform: placement?.transform,
            }}
          >
            {attachPr ? (
              <div
                role="menuitem"
                aria-disabled="true"
                className="rounded-lg px-2 py-1.5"
              >
                <p className="font-sans text-[11px] font-medium text-violet-100/90">
                  {existingPrLabel(attachPr)}
                </p>
                <p className="mt-0.5 font-sans text-[10.5px] leading-snug text-muted-fg/70">
                  This branch already has a PR. Cursor will work on it instead of opening another.
                </p>
              </div>
            ) : (
              <label
                className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 font-sans text-[11px] text-fg/90 hover:bg-white/[0.06]"
              >
                <input
                  type="checkbox"
                  role="menuitemcheckbox"
                  aria-checked={autoCreatePR}
                  aria-label="Open a PR"
                  data-cursor-cloud-auto-pr
                  checked={autoCreatePR}
                  onChange={(event) => onAutoCreatePRChange(event.target.checked)}
                  className="h-3 w-3 accent-violet-400"
                />
                <span className="min-w-0 flex-1">Open a PR</span>
                <SmartTooltip
                  forceEnabled
                  content={{
                    label: "Open a PR",
                    description: "When the cloud run finishes, Cursor opens a pull request from this lane's branch. Creation-time only — it cannot be added later. If this branch already has a PR, ADE attaches to that one instead.",
                  }}
                >
                  <span
                    role="img"
                    aria-label="About Open a PR"
                    className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-muted-fg/55 hover:text-fg/80"
                    onClick={(event) => event.preventDefault()}
                  >
                    <Info size={11} weight="bold" aria-hidden />
                  </span>
                </SmartTooltip>
              </label>
            )}
            <div className="my-1.5 border-t border-white/[0.06]" />
            <CursorCloudSecretsList
              availableNames={availableNames}
              selectedNames={selectedNames}
              remember={remember}
              onSelectedNamesChange={onSelectedNamesChange}
              onRememberChange={onRememberChange}
            />
          </div>,
          document.body,
        )
        : null}
    </div>
  );
}

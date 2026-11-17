import React, { useEffect, useId, useRef, useState } from "react";
import { CaretDown, CopySimple } from "@phosphor-icons/react";
import { AnchoredMenu } from "../ui/AnchoredMenu";
import { cn } from "../ui/cn";
import { Banner } from "../ui/notice";
import { MENU_ITEM_CLASS, MENU_SURFACE_CLASS } from "../ui/paneMenuTokens";
import { Z_LAYERS } from "../ui/zLayers";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { ChatMarkdown } from "./chatMarkdown";
import { ProviderLogo } from "../shared/ProviderLogos";
import { pendingInputHeaderLabel } from "../../../shared/pendingInputLabels";

/* ── Types ── */

interface ChatProposedPlanCardProps {
  source: string;
  description: string | null;
  question: string | null;
  disabled: boolean;
  onApprove: () => void;
  onReject: () => void;
  onImplementInNewChat?: () => void;
  planHandoffResponding?: boolean;
  planHandoffError?: string | null;
}

/* ── Component ── */

const PLAN_PRIMARY_BUTTON_CLASS =
  "inline-flex min-h-8 items-center border border-[color:color-mix(in_srgb,var(--chat-accent)_45%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_14%,transparent)] text-[color:color-mix(in_srgb,var(--chat-accent)_82%,var(--color-fg))] transition-colors hover:bg-[color:color-mix(in_srgb,var(--chat-accent)_22%,transparent)] focus-visible:z-10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-fg/80 disabled:pointer-events-none disabled:opacity-40";

const ChatProposedPlanCard = React.memo(function ChatProposedPlanCard({
  source,
  description,
  question,
  disabled,
  onApprove,
  onReject,
  onImplementInNewChat,
  planHandoffResponding = false,
  planHandoffError = null,
}: ChatProposedPlanCardProps) {
  const { copy, copied } = useCopyToClipboard();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const primaryRef = useRef<HTMLButtonElement>(null);
  const caretRef = useRef<HTMLButtonElement>(null);
  const menuItemRef = useRef<HTMLButtonElement>(null);
  const keepPlanningRef = useRef<HTMLButtonElement>(null);
  const showMenu = menuOpen && Boolean(onImplementInNewChat) && !disabled;
  useEffect(() => {
    if (!showMenu) return;
    const frame = requestAnimationFrame(() => menuItemRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [showMenu]);

  const implementInNewChat = () => {
    if (disabled) return;
    setMenuOpen(false);
    caretRef.current?.focus();
    onImplementInNewChat?.();
  };
  const bodyText = description?.trim() || question?.trim() || "The agent has prepared a plan.";
  // Provider-identified header — "{Provider} · Plan ready" — matching the
  // question card. The card chrome inherits the per-provider `--chat-accent`.
  const headerLabel = pendingInputHeaderLabel(source, "plan_approval");

  return (
    <div className="relative overflow-hidden rounded-xl border border-[color:color-mix(in_srgb,var(--chat-accent)_22%,transparent)] bg-(color:--color-popup-bg) p-4">
      <div className="absolute inset-x-0 top-0 h-px bg-[color:color-mix(in_srgb,var(--chat-accent)_30%,transparent)]" />

      <div className="mb-2 flex items-center gap-2">
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-[var(--chat-radius-pill)] border border-[color:color-mix(in_srgb,var(--chat-accent)_22%,transparent)] bg-black/20">
          <ProviderLogo family={source} size={11} />
        </span>
        <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-[color:color-mix(in_srgb,var(--chat-accent)_82%,white_18%)]">
          {headerLabel}
        </span>
      </div>

      {/* Not a clamp: the plan text is whole and nothing is hidden behind a
          disclosure. This card is pinned above the composer, outside the
          transcript’s scroller, so an unbounded body grows the composer shell
          until Implement / Keep planning leave the viewport with no way to
          scroll to them. The cap is generous — ordinary plans never reach it —
          and a long one scrolls in place instead of evicting its own buttons. */}
      <div className="mb-3 max-h-[min(52vh,560px)] overflow-y-auto rounded-lg border border-fg/[0.06] bg-black/15 px-3 py-2 text-[12px] leading-relaxed text-fg/75">
        <ChatMarkdown tone="neutral">{bodyText}</ChatMarkdown>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <div className="inline-flex max-w-full items-stretch">
          <button
            ref={primaryRef}
            type="button"
            disabled={disabled}
            className={cn(
              PLAN_PRIMARY_BUTTON_CLASS,
              "min-w-0 px-3 py-1.5 text-left text-[11px] font-medium",
              onImplementInNewChat ? "rounded-l-lg" : "rounded-lg",
            )}
            onClick={onApprove}
          >
            {onImplementInNewChat ? "Implement here" : "Implement"}
          </button>
          {onImplementInNewChat ? (
            <button
              ref={caretRef}
              type="button"
              aria-label="Implementation options"
              aria-haspopup="menu"
              aria-expanded={showMenu}
              aria-controls={showMenu ? menuId : undefined}
              aria-disabled={disabled}
              title="Implementation options"
              className={cn(
                PLAN_PRIMARY_BUTTON_CLASS,
                "-ml-px min-w-8 shrink-0 justify-center rounded-r-lg aria-disabled:cursor-default aria-disabled:opacity-40",
              )}
              onClick={() => { if (!disabled) setMenuOpen(!showMenu); }}
              onKeyDown={(event) => {
                if (disabled || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
                event.preventDefault();
                if (showMenu) menuItemRef.current?.focus();
                else setMenuOpen(true);
              }}
            >
              <CaretDown size={12} weight="bold" aria-hidden="true" />
            </button>
          ) : null}
        </div>
        {showMenu ? (
          <AnchoredMenu
            id={menuId}
            role="menu"
            aria-label="Implementation options"
            open={showMenu}
            anchorRef={caretRef}
            placement="top-start"
            zIndex={Z_LAYERS.popover}
            className={cn(MENU_SURFACE_CLASS, "max-w-[calc(100vw-16px)]")}
            onClose={() => setMenuOpen(false)}
            onKeyDown={(event) => {
              if (event.key === "Escape" || event.key === "Tab") {
                event.preventDefault();
                event.stopPropagation();
                setMenuOpen(false);
                const tabTarget = event.shiftKey ? primaryRef : keepPlanningRef;
                (event.key === "Escape" ? caretRef : tabTarget).current?.focus();
              } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                menuItemRef.current?.focus();
              }
            }}
          >
            <button
              ref={menuItemRef}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={cn(MENU_ITEM_CLASS, "w-full text-left hover:bg-fg/[0.07] focus-visible:bg-fg/[0.09] focus-visible:text-fg")}
              onClick={implementInNewChat}
            >
              Implement in a new chat
            </button>
          </AnchoredMenu>
        ) : null}
        <button
          ref={keepPlanningRef}
          type="button"
          disabled={disabled}
          className={cn(
            "min-h-8 rounded-lg border border-fg/[0.06] px-3 py-1.5 text-[11px] text-fg/60 transition-colors",
            "hover:bg-fg/[0.04] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-fg/80 disabled:pointer-events-none disabled:opacity-40",
          )}
          onClick={onReject}
        >
          Keep planning
        </button>
        <button
          type="button"
          className="ml-auto flex min-h-7 items-center gap-1 rounded-[var(--chat-radius-pill)] border border-fg/[0.06] px-2 py-1 font-mono text-[9px] uppercase tracking-[0.12em] text-fg/60 transition-colors hover:bg-fg/[0.04] hover:text-fg/80 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-fg/80"
          onClick={() => void copy(bodyText)}
        >
          <CopySimple size={10} weight="bold" aria-hidden="true" />
          {copied ? "Copied" : "Copy plan"}
        </button>
      </div>
      {planHandoffResponding ? (
        <div role="status" className="mt-2 text-xs text-fg/70">
          Starting implementation in a new chat…
        </div>
      ) : null}
      {planHandoffError ? (
        <Banner
          layout="inline"
          style={{ marginTop: 8 }}
          model={{
            id: "plan-handoff-error",
            tone: "error",
            title: "Couldn’t start implementation in a new chat",
            error: planHandoffError,
            actions: onImplementInNewChat
              ? [{ label: "Retry", onClick: implementInNewChat, disabled, busy: planHandoffResponding }]
              : [],
          }}
        />
      ) : null}
    </div>
  );
});

export { ChatProposedPlanCard };
export type { ChatProposedPlanCardProps };

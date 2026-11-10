import { Check, GearSix, Info, Warning } from "@phosphor-icons/react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";

import { formatCloudHoursRate } from "../../../shared/adeCloud";
import type { CloudTier, CloudTierId } from "../../../shared/cloudTiers";
import { CloudSizeIcon } from "../remoteTargets/cloudBrand";
import { cn } from "../ui/cn";
import { MENU_ITEM_CLASS, MENU_SCROLL_CLASS, POPOVER_SURFACE_CLASS } from "../ui/paneMenuTokens";
import { usePortalContainer } from "../ui/portalContainer";
import { SmartTooltip } from "../ui/SmartTooltip";
import { Z_LAYERS } from "../ui/zLayers";
import type { AdeCloudTrayAction, AdeCloudTrayNotice } from "./useAdeCloudDraft";

/** "2 CPU · 4 GB" for a size row. */
function tierShape(tier: CloudTier): string {
  return `${tier.cpu} CPU · ${tier.memoryGb} GB`;
}

/** The size's hours rate from the catalog: "1× hours". */
function tierRate(tier: CloudTier): string {
  return formatCloudHoursRate(tier.multiplierMilli / 1000);
}

/**
 * The size of a new ADE Cloud computer, on the launch shelf beside the lane
 * picker. Icon only: the cloud mark filled a quarter to full. The menu lists
 * the catalog's sizes with their rates, and "Change the default…" saves the
 * size every new ADE Cloud lane starts with.
 *
 * The trigger keeps one element across sizes, so the fill moves in place.
 */
export function CloudSizeButton({
  tiers,
  tierId,
  defaultTier,
  onChoose,
  onSetDefault,
  disabled = false,
}: {
  tiers: readonly CloudTier[];
  tierId: CloudTierId;
  defaultTier: CloudTierId;
  onChoose: (tier: CloudTierId) => void;
  onSetDefault: (tier: CloudTierId) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const portalContainer = usePortalContainer();
  const current = tiers.find((tier) => tier.id === tierId) ?? null;
  const label = current?.label ?? "Small";
  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen} modal={false}>
      <SmartTooltip
        forceEnabled
        content={{
          label: `Computer size: ${label}`,
          description: current
            ? `${tierShape(current)}. Uses ${tierRate(current)} while awake.`
            : "The size of the new ADE Cloud computer.",
        }}
      >
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            data-ade-cloud-size
            aria-label={`Computer size, ${label}`}
            disabled={disabled}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => setOpen((value) => !value)}
            className={cn(
              "inline-flex h-7 w-8 shrink-0 items-center justify-center rounded-md border transition-colors",
              open
                ? "border-fg/[0.12] bg-fg/[0.06]"
                : "border-fg/[0.07] bg-fg/[0.03] hover:bg-fg/[0.06]",
              disabled && "cursor-not-allowed opacity-45",
            )}
          >
            <CloudSizeIcon tier={tierId} size={17} />
          </button>
        </DropdownMenu.Trigger>
      </SmartTooltip>
      <DropdownMenu.Portal container={portalContainer ?? undefined}>
        <DropdownMenu.Content
          aria-label="Computer size"
          className={cn(POPOVER_SURFACE_CLASS, MENU_SCROLL_CLASS, "w-[264px] p-1 font-sans text-[11px] text-fg/82")}
          style={{ zIndex: portalContainer ? Z_LAYERS.dialogPopover : Z_LAYERS.popover }}
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={8}
        >
          <div className="adec-menu-label" aria-hidden>Computer size</div>
          <DropdownMenu.RadioGroup
            value={tierId}
            onValueChange={(value) => {
              const next = tiers.find((tier) => tier.id === value);
              if (next) onChoose(next.id);
            }}
          >
            {tiers.map((tier) => (
              <DropdownMenu.RadioItem
                key={tier.id}
                value={tier.id}
                className={cn(MENU_ITEM_CLASS, "min-h-[30px] items-start gap-[9px] text-[11px]", tier.id === tierId ? "text-fg/90" : "text-fg/70")}
              >
                <span className="mt-[1px]"><CloudSizeIcon tier={tier.id} size={15} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-medium">{tier.label}</span>
                  <span className="block truncate text-[10.5px] text-muted-fg/65">{tierShape(tier)}</span>
                  {tier.type === "vm" ? (
                    <span className="block truncate text-[10.5px] text-muted-fg/65">Android and Docker</span>
                  ) : null}
                </span>
                <span className="mt-[2px] shrink-0 font-mono text-[10.5px] text-muted-fg/70">{tierRate(tier)}</span>
                <span className="mt-[2px] flex w-3 shrink-0 justify-end">
                  <DropdownMenu.ItemIndicator>
                    <Check size={11} weight="bold" className="adec-check" aria-hidden />
                  </DropdownMenu.ItemIndicator>
                </span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Separator className="my-1 h-px bg-fg/[0.06]" />
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className={cn(MENU_ITEM_CLASS, "text-[11px] text-fg/70")}>
              <GearSix size={12} className="shrink-0 text-muted-fg/75" aria-hidden />
              <span className="min-w-0 flex-1 truncate">Change the default…</span>
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal container={portalContainer ?? undefined}>
              <DropdownMenu.SubContent
                aria-label="Default size"
                className={cn(POPOVER_SURFACE_CLASS, "w-[200px] p-1 font-sans text-[11px] text-fg/82")}
                style={{ zIndex: portalContainer ? Z_LAYERS.dialogPopover : Z_LAYERS.popover }}
                sideOffset={6}
                collisionPadding={8}
              >
                <div className="adec-menu-label" aria-hidden>New lanes start</div>
                <DropdownMenu.RadioGroup
                  value={defaultTier}
                  onValueChange={(value) => {
                    const next = tiers.find((tier) => tier.id === value);
                    if (next) onSetDefault(next.id);
                  }}
                >
                  {tiers.map((tier) => (
                    <DropdownMenu.RadioItem
                      key={tier.id}
                      value={tier.id}
                      className={cn(MENU_ITEM_CLASS, "text-[11px]", tier.id === defaultTier ? "text-fg/90" : "text-fg/70")}
                    >
                      <CloudSizeIcon tier={tier.id} size={14} />
                      <span className="min-w-0 flex-1 truncate">{tier.label}</span>
                      <span className="flex w-3 shrink-0 justify-end">
                        <DropdownMenu.ItemIndicator>
                          <Check size={11} weight="bold" className="adec-check" aria-hidden />
                        </DropdownMenu.ItemIndicator>
                      </span>
                    </DropdownMenu.RadioItem>
                  ))}
                </DropdownMenu.RadioGroup>
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** The tray's icon size and flex gap, in px (cloudBrand.css .adec-tray). */
const TRAY_ICON_PX = 14;
const TRAY_GAP_PX = 8;

const TRAY_ACTION_LABEL: Record<AdeCloudTrayAction, string> = {
  upgrade: "Upgrade",
  "free-space": "Free up space",
  settings: "Open settings",
};

/**
 * The label on top of the prompt box while ADE Cloud is picked and Send can't
 * go. The typed text stays in the box; Send is off until the reason goes.
 * Tray and sign-in strip can both show: the tray is nearest the box.
 */
export function AdeCloudTray({
  notice,
  onAction,
}: {
  notice: AdeCloudTrayNotice;
  onAction: (action: AdeCloudTrayAction) => void;
}) {
  const longRef = useRef<HTMLSpanElement | null>(null);
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const moreRef = useRef<HTMLSpanElement | null>(null);
  const [need, setNeed] = useState<string | null>(null);
  const [primaryAction, ...moreActions] = notice.actions;
  const actionsKey = notice.actions.join(" ");
  // The width the long line needs: icon, sentence and every action. Read once
  // per notice; the CSS (cloudBrand.css .adec-tray-long) compares it with the
  // tray's width on every resize. The sentence is kept in em, so a change of
  // the chat text size needs no new read.
  useLayoutEffect(() => {
    const long = longRef.current;
    if (!long) return;
    const longPx = long.scrollWidth;
    const fontPx = Number.parseFloat(getComputedStyle(long).fontSize);
    if (!(longPx > 0) || !(fontPx > 0)) return;
    const restPx = TRAY_ICON_PX + TRAY_GAP_PX
      + (primaryRef.current ? TRAY_GAP_PX + primaryRef.current.offsetWidth : 0)
      + (moreRef.current ? moreRef.current.scrollWidth : 0);
    const next = `calc(${(longPx / fontPx).toFixed(3)}em + ${Math.ceil(restPx) + 1}px)`;
    setNeed((current) => (current === next ? current : next));
  }, [notice.message, actionsKey]);
  const actionButton = (action: AdeCloudTrayAction, primary: boolean) => (
    <button
      key={action}
      ref={primary ? primaryRef : undefined}
      type="button"
      className="adec-tray-action"
      data-primary={primary ? "true" : undefined}
      data-upgrade={action === "upgrade" ? "true" : undefined}
      onClick={() => onAction(action)}
    >
      {TRAY_ACTION_LABEL[action]}
    </button>
  );
  return (
    <div
      className="adec-tray"
      data-tone={notice.tone}
      data-ade-cloud-tray
      role="status"
      style={need ? ({ "--adec-tray-need": need } as CSSProperties) : undefined}
    >
      {notice.tone === "blocked" ? (
        <Warning size={TRAY_ICON_PX} weight="fill" className="adec-tray-icon" aria-hidden />
      ) : (
        <Info size={TRAY_ICON_PX} weight="fill" className="adec-tray-icon" aria-hidden />
      )}
      {/* The sentence while it fits on one line with every action, else its
          short form and only the first action (cloudBrand.css). */}
      <span className="adec-tray-text">
        <span ref={longRef} className="adec-tray-long">{notice.message}</span>
        <span className="adec-tray-short" title={notice.message}>{notice.short}</span>
      </span>
      {primaryAction ? actionButton(primaryAction, true) : null}
      {moreActions.length > 0 ? (
        <span ref={moreRef} className="adec-tray-more">
          {moreActions.map((action) => actionButton(action, false))}
        </span>
      ) : null}
    </div>
  );
}

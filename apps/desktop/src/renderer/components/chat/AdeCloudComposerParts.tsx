import { CaretDown, Check, GearSix, Info, Warning } from "@phosphor-icons/react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { cloudTierFacts, cloudTierHoursLeftLabel, type CloudTier, type CloudTierId } from "../../../shared/cloudTiers";
import type { CloudLaneWithoutComputer } from "../../../shared/cloudLaneLife";
import type { OpenProjectBinding } from "../../../shared/types/core";
import { adeCloudLaneLabel, useAdeCloudLaneForBinding } from "../../state/adeCloudLaneIndex";
import { CloudTierChangeDialog } from "../cloudLane/CloudTierChangeDialog";
import { cloudLaneLifeAvailable } from "../cloudLane/cloudLaneActions";
import { cloudLaneWithoutComputerForBinding, useCloudLanesWithoutComputer } from "../cloudLane/cloudLaneStores";
import { CloudMark, CloudSizeIcon } from "../remoteTargets/cloudBrand";
import { cn } from "../ui/cn";
import { MENU_ITEM_CLASS, MENU_SCROLL_CLASS, POPOVER_SURFACE_CLASS } from "../ui/paneMenuTokens";
import { usePortalContainer } from "../ui/portalContainer";
import { SmartTooltip } from "../ui/SmartTooltip";
import { Z_LAYERS } from "../ui/zLayers";
import type { AdeCloudTrayAction, AdeCloudTrayNotice } from "./useAdeCloudDraft";


/**
 * The size of a new ADE Cloud computer, on the launch shelf beside the lane
 * picker: the size icon (the cloud mark filled a quarter to full) and its
 * name, in the same chip as the machine picker. The menu says, per size, its
 * CPU, memory and disk, what it runs, how fast it uses hours, and how long
 * the hours left last there. A pick that isn't the default offers to make it
 * the default.
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
  hoursLeftMilli = null,
}: {
  tiers: readonly CloudTier[];
  tierId: CloudTierId;
  defaultTier: CloudTierId;
  onChoose: (tier: CloudTierId) => void;
  onSetDefault: (tier: CloudTierId) => void;
  disabled?: boolean;
  /** The account's hours left (plan and earned), for "lasts N h here"; null before the account is read. */
  hoursLeftMilli?: number | null;
}) {
  const [open, setOpen] = useState(false);
  const portalContainer = usePortalContainer();
  const current = tiers.find((tier) => tier.id === tierId) ?? null;
  const label = current?.label ?? "Small";
  const currentFacts = current ? cloudTierFacts(current) : null;
  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen} modal={false}>
      <SmartTooltip
        forceEnabled
        content={{
          label: `Computer size: ${label}`,
          description: current && currentFacts
            ? `${currentFacts.specs.join(", ")}. ${currentFacts.rateLine}.`
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
              "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2",
              "font-sans text-[11px] font-medium transition-colors",
              open
                ? "border-fg/[0.12] bg-fg/[0.06] text-fg/85"
                : "border-fg/[0.07] bg-fg/[0.03] text-muted-fg/75 hover:bg-fg/[0.06] hover:text-fg/85",
              disabled && "cursor-not-allowed opacity-45",
            )}
          >
            <CloudSizeIcon tier={tierId} size={15} />
            <span>{label}</span>
            <CaretDown size={9} weight="bold" className={cn("shrink-0 transition-transform duration-150", open && "rotate-180")} aria-hidden />
          </button>
        </DropdownMenu.Trigger>
      </SmartTooltip>
      <DropdownMenu.Portal container={portalContainer ?? undefined}>
        <DropdownMenu.Content
          aria-label="Computer size"
          className={cn(POPOVER_SURFACE_CLASS, MENU_SCROLL_CLASS, "w-[340px] p-1 font-sans text-[11px] text-fg/82")}
          style={{ zIndex: portalContainer ? Z_LAYERS.dialogPopover : Z_LAYERS.popover }}
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={8}
        >
          <div className="adec-menu-label" aria-hidden>Size of the new computer</div>
          <DropdownMenu.RadioGroup
            value={tierId}
            onValueChange={(value) => {
              const next = tiers.find((tier) => tier.id === value);
              if (next) onChoose(next.id);
            }}
          >
            {tiers.map((tier) => {
              const facts = cloudTierFacts(tier);
              // One line per size (B14-14); what it runs is in the row's hover text.
              const shape = `${tier.cpu} CPU · ${tier.memoryGb} GB${tier.diskMaxGb != null ? ` · ${tier.diskMaxGb} GB disk` : ""}`;
              const runs = facts.full ? `Full computer: ${facts.runs}` : facts.runs;
              return (
                <DropdownMenu.RadioItem
                  key={tier.id}
                  value={tier.id}
                  title={`${tier.label}: ${facts.specs.join(", ")}. ${runs}. ${facts.rateLine}.`}
                  className={cn(MENU_ITEM_CLASS, "min-h-[30px] items-center gap-2 text-[11px]", tier.id === tierId ? "text-fg/90" : "text-fg/70")}
                >
                  <span className="inline-flex h-[16px] w-[16px] shrink-0 items-center justify-center"><CloudSizeIcon tier={tier.id} size={15} /></span>
                  <span className="shrink-0 text-[11.5px] font-medium">{tier.label}</span>
                  {tier.id === defaultTier ? <span className="shrink-0 text-[9.5px] text-muted-fg/55">Default</span> : null}
                  <span className="min-w-0 flex-1 truncate text-[10.5px] tabular-nums text-muted-fg/60">{shape}</span>
                  <span className="shrink-0 text-[11px] font-medium tabular-nums text-fg/80">{facts.rate}×</span>
                  {hoursLeftMilli != null ? (
                    <span className="w-[52px] shrink-0 text-right text-[10px] tabular-nums text-muted-fg/60">{cloudTierHoursLeftLabel(tier, hoursLeftMilli)}</span>
                  ) : null}
                  <span className="flex w-3 shrink-0 justify-end">
                    <DropdownMenu.ItemIndicator>
                      <Check size={11} weight="bold" className="adec-check" aria-hidden />
                    </DropdownMenu.ItemIndicator>
                  </span>
                </DropdownMenu.RadioItem>
              );
            })}
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Separator className="my-1 h-px bg-fg/[0.06]" />
          {tierId !== defaultTier ? (
            <DropdownMenu.Item className={cn(MENU_ITEM_CLASS, "text-[11px] text-fg/75")} onSelect={() => onSetDefault(tierId)}>
              <span className="inline-flex h-[16px] w-[16px] shrink-0 items-center justify-center"><GearSix size={12} className="text-muted-fg/75" aria-hidden /></span>
              <span className="min-w-0 flex-1 truncate">Start every new lane on {label}</span>
            </DropdownMenu.Item>
          ) : (
            <div className="px-2 py-1.5 text-[10.5px] leading-snug text-muted-fg/60">
              Hours count only while the computer is awake. New lanes start on {label}.
            </div>
          )}
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
  github: "Connect GitHub",
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

/** A chat's ADE Cloud lane for the composer's machine chip. */
export type ComposerAdeCloudLane = {
  laneName: string;
  /** The lane computer's ADE Cloud id, once known: the chip then opens the size change. */
  instanceId: string | null;
  /** The lane has no computer now (freed or removed): the next send makes one. */
  noComputer: boolean;
};

/**
 * The ADE Cloud lane a chat's machine binding points at, or null: its lane
 * computer from the index, else (once freed) the shared list of lanes without
 * a computer, which the strip above the prompt box reads too.
 */
function useChatAdeCloudLane(binding: OpenProjectBinding | null | undefined, enabled: boolean) {
  const withComputer = useAdeCloudLaneForBinding(enabled ? binding : null);
  const withoutComputer = useCloudLanesWithoutComputer(
    enabled && !withComputer && binding?.kind === "remote" && cloudLaneLifeAvailable(),
  );
  const without = !withComputer && enabled ? cloudLaneWithoutComputerForBinding(binding, withoutComputer.lanes) : null;
  return { withComputer, without };
}

/**
 * The lane without a computer a chat ran on, or null: a send in that chat
 * makes the lane a new computer and starts a new chat there (the pane).
 */
export function useCloudLaneWithoutComputerForChat(
  binding: OpenProjectBinding | null | undefined,
  enabled: boolean,
): CloudLaneWithoutComputer | null {
  return useChatAdeCloudLane(binding, enabled).without;
}

export function useComposerAdeCloudLane(
  binding: OpenProjectBinding | null | undefined,
  enabled: boolean,
): ComposerAdeCloudLane | null {
  const { withComputer, without } = useChatAdeCloudLane(binding, enabled);
  const laneName = withComputer?.laneName ?? without?.laneName ?? null;
  const instanceId = withComputer?.instanceId ?? null;
  const noComputer = !withComputer && without != null;
  return useMemo(
    () => (laneName ? { laneName, instanceId, noComputer } : null),
    [laneName, instanceId, noComputer],
  );
}

/** The composer's machine chip for a chat on an ADE Cloud lane: the cloud mark, and the size change when it has a computer. */
export function AdeCloudMachineChip({
  machineName,
  lane,
  wrapperClassName,
}: {
  machineName: string;
  lane: ComposerAdeCloudLane;
  wrapperClassName: string;
}) {
  const [sizing, setSizing] = useState(false);
  // A person changes the lane's size here; the change is account level (no pin), by the computer's id.
  const canResize = !lane.noComputer && Boolean(lane.instanceId) && cloudLaneLifeAvailable();
  // The same chip as every other machine: plain text and its icon, no box.
  const chipClass = cn(
    "inline-flex h-6 min-w-0 max-w-full items-center gap-1 overflow-hidden rounded-md px-1",
    "font-sans text-[9px] font-medium text-muted-fg/60",
    canResize && "cursor-pointer transition-colors hover:bg-fg/[0.05] hover:text-fg/85 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/60",
  );
  const chipBody = (
    <>
      <CloudMark size={11} brand />
      {lane.noComputer ? (
        <span className="min-w-0 max-w-40 truncate">{adeCloudLaneLabel(lane.laneName)}</span>
      ) : (
        <span className="min-w-0 max-w-24 truncate">{machineName}</span>
      )}
    </>
  );
  return (
    <>
      <SmartTooltip
        forceEnabled
        wrapperClassName={wrapperClassName}
        content={{
          label: adeCloudLaneLabel(lane.laneName),
          description: lane.noComputer
            ? "This lane has no computer now. ADE makes a new one when you send."
            : canResize
              ? "This chat runs on its lane's own ADE Cloud computer. It wakes when you send. Click to change its size."
              : "This chat runs on its lane's own ADE Cloud computer. It wakes when you send.",
        }}
      >
        {canResize ? (
          <button
            type="button"
            data-chat-composer-machine-chip="ade-cloud"
            aria-label={`Running on ${adeCloudLaneLabel(lane.laneName)}. Change its size`}
            className={chipClass}
            style={{ whiteSpace: "nowrap" }}
            onClick={() => setSizing(true)}
          >
            {chipBody}
          </button>
        ) : (
          <span
            data-chat-composer-machine-chip="ade-cloud"
            aria-label={lane.noComputer
              ? `${adeCloudLaneLabel(lane.laneName)}. It has no computer now`
              : `Running on ${adeCloudLaneLabel(lane.laneName)}`}
            className={chipClass}
            style={{ whiteSpace: "nowrap" }}
          >
            {chipBody}
          </span>
        )}
      </SmartTooltip>
      {sizing && lane.instanceId ? (
        <CloudTierChangeDialog instanceId={lane.instanceId} laneName={lane.laneName} onClose={() => setSizing(false)} />
      ) : null}
    </>
  );
}

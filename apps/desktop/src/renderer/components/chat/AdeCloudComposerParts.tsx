import { AppleLogo, CaretDown, Check, GearSix, Info, SlidersHorizontal, Warning } from "@phosphor-icons/react";
import { useSponsoredCardOnScreen } from "./sponsored/sponsoredOnScreen";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { cloudTierFacts, cloudTierHoursAt, cloudTierUsesHours, type CloudTier, type CloudTierId } from "../../../shared/cloudTiers";
import { CLOUD_CREDIT_WORDS, type CloudUnitWords } from "../../../shared/cloudUnitWords";
import { cloudRateText, cloudTierRateNowMilli, cloudTierRatePair, type CloudAdsView } from "../../../shared/cloudAdPriceWords";
import type { CloudLaneWithoutComputer } from "../../../shared/cloudLaneLife";
import type { OpenProjectBinding } from "../../../shared/types/core";
import { useAdeCloudLaneForBinding } from "../../state/adeCloudLaneIndex";
import { ADE_CLOUD_NAME } from "../../../shared/adeCloudMachine";
import { CloudTierChangeDialog } from "../cloudLane/CloudTierChangeDialog";
import { cloudLaneChangesAvailable, cloudLaneLifeAvailable, cloudLaneMovesAvailable } from "../cloudLane/cloudLaneActions";
import { cloudLaneWithoutComputerForBinding, useCloudLanesWithoutComputer } from "../cloudLane/cloudLaneStores";
import { CloudMark, CloudSizeIcon } from "../remoteTargets/cloudBrand";
import { cn } from "../ui/cn";
import { MENU_ITEM_CLASS, MENU_SCROLL_CLASS, POPOVER_SURFACE_CLASS } from "../ui/paneMenuTokens";
import { usePortalContainer } from "../ui/portalContainer";
import { SmartTooltip } from "../ui/SmartTooltip";
import { Z_LAYERS } from "../ui/zLayers";
import type { AdeCloudTrayAction, AdeCloudTrayNotice } from "./useAdeCloudDraft";
import {
  CloudFreeGithubHold,
  cloudFreeCreditsHoldActions,
  useCloudFreeUnlock,
  type CloudFreeGithubHoldFacts,
} from "../settings/cloudDashboard/CloudFreeGithubNotice";
import { refreshCloudAccount, useCloudAccount } from "../../state/cloudAccountStore";
import { LaneMoveControl } from "../laneMove/LaneMoveControl";
import type { LaneMoveSource } from "../laneMove/laneMoveModel";
import { BRAND } from "../../../shared/brand";
import { capitalizeCloudPhrase } from "../../../shared/adeCloud";
import { CLOUD_MAC_UNSUPPORTED } from "../../../../../account-directory/src/cloud/contract";
import { CLOUD_MAC_NAME, cloudMachineAllows, cloudMacRateText, cloudMacShapeText, cloudMacTimeAt, type CloudComputerOs, type CloudMacOffer } from "../../../shared/cloudMac";


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
  words = CLOUD_CREDIT_WORDS,
  priced = null,
  fullPrice = false,
  macOffer = null,
  os = "linux",
  onChooseOs,
}: {
  tiers: readonly CloudTier[];
  tierId: CloudTierId;
  defaultTier: CloudTierId;
  onChoose: (tier: CloudTierId) => void;
  onSetDefault: (tier: CloudTierId) => void;
  disabled?: boolean;
  /** The account's hours left (plan and earned), for "lasts N h here"; null before the account is read. */
  hoursLeftMilli?: number | null;
  /** The account's words (`cloudUnitWords`). */
  words?: CloudUnitWords;
  /** Pricing v3 (the account has `pricing`): each size's two prices under its row. Null shows today's menu. */
  priced?: { view: CloudAdsView | null } | null;
  /** The start pays the full price whatever the ads (a CLI session): time left counts at it. */
  fullPrice?: boolean;
  /** The DAEX Cloud Mac offer: with it, the menu starts with Linux | Mac and the button says which. */
  macOffer?: CloudMacOffer | null;
  os?: CloudComputerOs;
  onChooseOs?: (os: CloudComputerOs) => void;
}) {
  const [open, setOpen] = useState(false);
  // The ads that price this start's time left: none for a start that pays the full price.
  const startView = fullPrice ? null : priced?.view ?? null;
  const priceOf = (tier: CloudTier) => (priced ? cloudRateText(cloudTierRatePair(tier), priced.view, words) : null);
  const macShown = Boolean(macOffer && onChooseOs);
  const mac = macShown && os === "mac" && macOffer ? macOffer : null;
  const portalContainer = usePortalContainer();
  const idBase = useId();
  const current = tiers.find((tier) => tier.id === tierId) ?? null;
  const label = current?.label ?? "Small";
  const currentFacts = current ? cloudTierFacts(current, words) : null;
  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen} modal={false}>
      <SmartTooltip
        forceEnabled
        content={mac ? {
          label: "Computer: Mac",
          description: `${cloudMacShapeText(mac)}. ${capitalizeCloudPhrase(cloudMacRateText(mac, words, priced?.view ?? null))}. ${mac.keeps}`,
        } : {
          label: macShown ? `Computer: Linux · ${label}` : `Computer size: ${label}`,
          description: current && currentFacts
            ? `${currentFacts.specs.join(", ")}. ${priceOf(current) ?? currentFacts.rateLine}.`
            : `The size of the new ${BRAND.CLOUD_NAME} computer.`,
        }}
      >
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            data-ade-cloud-size
            aria-label={mac ? "Computer, Mac" : macShown ? `Computer, Linux ${label}` : `Computer size, ${label}`}
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
            {mac ? <AppleLogo size={14} weight="fill" aria-hidden /> : <CloudSizeIcon tier={tierId} size={15} />}
            {/* While a Mac is offered the button says what the computer is, not only its size. */}
            <span className="whitespace-nowrap">{mac ? "Mac" : macShown ? `Linux · ${label}` : label}</span>
            <CaretDown size={9} weight="bold" className={cn("shrink-0 transition-transform duration-150", open && "rotate-180")} aria-hidden />
          </button>
        </DropdownMenu.Trigger>
      </SmartTooltip>
      <DropdownMenu.Portal container={portalContainer ?? undefined}>
        <DropdownMenu.Content
          aria-label={macShown ? "Computer" : "Computer size"}
          className={cn(POPOVER_SURFACE_CLASS, MENU_SCROLL_CLASS, "w-[340px] p-1 font-sans text-[11px] text-fg/82")}
          style={{ zIndex: portalContainer ? Z_LAYERS.dialogPopover : Z_LAYERS.popover }}
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={8}
        >
          <div className="adec-menu-label" aria-hidden>{macShown ? "The new computer" : "Size of the new computer"}</div>
          {macShown && macOffer && onChooseOs ? (
            <div role="radiogroup" aria-label="Linux or Mac" className="mx-1 mb-1.5 mt-0.5 grid grid-cols-2 gap-0.5 rounded-md bg-fg/[0.05] p-0.5">
              {(["linux", "mac"] as const).map((choice) => (
                <DropdownMenu.Item
                  key={choice}
                  role="radio"
                  aria-checked={os === choice}
                  data-ade-cloud-os={choice}
                  // The menu stays open: the rows under the switch change with it.
                  onSelect={(event) => {
                    event.preventDefault();
                    onChooseOs(choice);
                  }}
                  className={cn(
                    "flex h-6 cursor-pointer items-center justify-center gap-1 rounded-[5px] text-[11px] font-medium outline-none transition-colors",
                    os === choice ? "bg-card text-fg/90 shadow-sm" : "text-muted-fg/70 hover:text-fg/85 data-[highlighted]:text-fg/85",
                  )}
                >
                  {choice === "mac" ? <AppleLogo size={11} weight="fill" aria-hidden /> : null}
                  {choice === "mac" ? "Mac" : "Linux"}
                </DropdownMenu.Item>
              ))}
            </div>
          ) : null}
          {mac ? (
            <div className="mx-1 mb-1 rounded-md bg-fg/[0.035] px-2.5 py-2" data-ade-cloud-mac-offer>
              <div className="flex items-center gap-2">
                <AppleLogo size={13} weight="fill" className="shrink-0 text-fg/80" aria-hidden />
                <span className="shrink-0 text-[11.5px] font-medium text-fg/90">{mac.label || "Mac"}</span>
                <span className="min-w-0 flex-1 truncate text-[10.5px] tabular-nums text-muted-fg/60">{cloudMacShapeText(mac)}</span>
                {hoursLeftMilli != null ? (
                  <span className="shrink-0 text-right text-[10.5px] font-medium tabular-nums text-fg/80" title={`Your ${words.noun} last ${cloudMacTimeAt(mac, hoursLeftMilli, startView)} on a Mac.`}>
                    {cloudMacTimeAt(mac, hoursLeftMilli, startView)}
                  </span>
                ) : null}
              </div>
              {mac.summary ? <p className="m-0 mt-1.5 text-[10.5px] leading-snug text-muted-fg/70">{mac.summary}</p> : null}
              <p className="m-0 mt-1 text-[10.5px] leading-snug text-muted-fg/70">
                <span className="font-medium text-fg/80">{capitalizeCloudPhrase(cloudMacRateText(mac, words, priced?.view ?? null))}</span>, by the whole minute. {mac.keeps}
              </p>
            </div>
          ) : null}
          {mac ? null : (
          <DropdownMenu.RadioGroup
            value={tierId}
            onValueChange={(value) => {
              const next = tiers.find((tier) => tier.id === value);
              if (next) onChoose(next.id);
            }}
          >
            {tiers.map((tier) => {
              const facts = cloudTierFacts(tier, words);
              // One line per size (B14-14); what it runs is in the row's hover
              // text, and in its description for the keyboard and screen readers.
              const shape = `${tier.cpu} CPU · ${tier.memoryGb} GB`;
              const runs = facts.full ? `Full computer: ${facts.runs}` : facts.runs;
              // Hours as time at this size (Small reads "Unlimited", never a multiplier); a bigger size waits for the account.
              // At the price this start pays now: a size free with ads now (Free's Small) reads "Unlimited" and claims no time.
              const rateNow = { multiplierMilli: cloudTierRateNowMilli(tier, startView) };
              const usesHours = cloudTierUsesHours(rateNow);
              const hoursAt = usesHours && hoursLeftMilli == null ? null : cloudTierHoursAt(rateNow, hoursLeftMilli ?? 0);
              const price = priceOf(tier);
              const about = `${facts.specs.join(", ")}. ${runs}. ${price ?? facts.rateLine}.${usesHours && hoursAt ? ` Your ${words.noun} last ${hoursAt} here.` : ""}`;
              const aboutId = `${idBase}-${tier.id}`;
              return (
                <DropdownMenu.RadioItem
                  key={tier.id}
                  value={tier.id}
                  title={`${tier.label}: ${about}`}
                  aria-label={tier.id === defaultTier ? `${tier.label}, default` : tier.label}
                  aria-describedby={aboutId}
                  className={cn(MENU_ITEM_CLASS, "min-h-[30px] items-center gap-2 text-[11px]", (price || facts.full) && "flex-wrap gap-y-0.5 py-1.5", tier.id === tierId ? "text-fg/90" : "text-fg/70")}
                >
                  <span id={aboutId} className="sr-only">{about}</span>
                  <span className="inline-flex h-[16px] w-[16px] shrink-0 items-center justify-center"><CloudSizeIcon tier={tier.id} size={15} /></span>
                  <span className="shrink-0 text-[11.5px] font-medium">{tier.label}</span>
                  {tier.id === defaultTier ? <span className="shrink-0 text-[9.5px] text-muted-fg/55">Default</span> : null}
                  <span className="min-w-0 flex-1 truncate text-[10.5px] tabular-nums text-muted-fg/60">{shape}</span>
                  {hoursAt ? (
                    <span className="w-[56px] shrink-0 text-right text-[10.5px] font-medium tabular-nums text-fg/80">{hoursAt}</span>
                  ) : null}
                  <span className="flex w-3 shrink-0 justify-end">
                    <DropdownMenu.ItemIndicator>
                      <Check size={11} weight="bold" className="adec-check" aria-hidden />
                    </DropdownMenu.ItemIndicator>
                  </span>
                  {facts.full ? (
                    // What a full computer adds over a size of the same shape (the Settings table's tag, the size finder's words).
                    <span aria-hidden className="flex basis-full items-center gap-1.5 pl-6 text-[10.5px] leading-snug text-muted-fg/75">
                      <span className="kit-tag shrink-0">Full computer</span>
                      <span className="min-w-0 truncate">{facts.runs}</span>
                    </span>
                  ) : null}
                  {price ? (
                    // Pricing v3: both prices, on their own line under the size (the row's first line stays as it was).
                    <span aria-hidden className="basis-full pl-6 text-[10.5px] leading-snug tabular-nums text-muted-fg/75">{price}</span>
                  ) : null}
                </DropdownMenu.RadioItem>
              );
            })}
          </DropdownMenu.RadioGroup>
          )}
          <DropdownMenu.Separator className="my-1 h-px bg-fg/[0.06]" />
          {mac ? (
            <div className="px-2 py-1.5 text-[10.5px] leading-snug text-muted-fg/60">
              New lanes you start begin on a Mac. Agents and automations start on Linux unless they ask for a Mac.
            </div>
          ) : tierId !== defaultTier ? (
            <DropdownMenu.Item className={cn(MENU_ITEM_CLASS, "text-[11px] text-fg/75")} onSelect={() => onSetDefault(tierId)}>
              <span className="inline-flex h-[16px] w-[16px] shrink-0 items-center justify-center"><GearSix size={12} className="text-muted-fg/75" aria-hidden /></span>
              <span className="min-w-0 flex-1 truncate">Start every new lane on {label}</span>
            </DropdownMenu.Item>
          ) : (
            <div className="px-2 py-1.5 text-[10.5px] leading-snug text-muted-fg/60">
              {words.Noun} count only while the computer is awake. New lanes start on {label}.
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

/** Each tray action's button label; the deleted-computer banner offers the same fixes. */
export const TRAY_ACTION_LABEL: Record<AdeCloudTrayAction, string> = {
  upgrade: "Upgrade",
  "free-space": "Free up space",
  settings: "Open settings",
  github: "Connect GitHub",
  "computer-limit": "See your options",
  "mac-stop-read": "Got it",
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
  if (notice.hold) return <AdeCloudGithubHoldTray hold={notice.hold} onAction={onAction} />;
  return <AdeCloudTrayLine notice={notice} onAction={onAction} />;
}

/**
 * A held free plan where ADE Cloud is used: the GitHub rule is why its hours
 * are 0, so the prompt box shows that hold (Settings' look and wording) with
 * its way out, never "out of credits". Send stays off until it lifts.
 */
function AdeCloudGithubHoldTray({ hold, onAction }: { hold: CloudFreeGithubHoldFacts; onAction: (action: AdeCloudTrayAction) => void }) {
  const plusIncludedMilli = useCloudAccount(true)?.catalog?.plans?.plus?.includedMilli ?? null;
  const { busy, addCard } = useCloudFreeUnlock({ purpose: "credits" });
  return (
    <div className="adec-hold-tray" data-ade-cloud-tray data-ade-cloud-hold={hold.reason}>
      <CloudFreeGithubHold
        hold={hold}
        purpose="credits"
        plusIncludedMilli={plusIncludedMilli}
        actions={cloudFreeCreditsHoldActions(hold, {
          addCard: () => void addCard(),
          cardBusy: busy,
          connectGithub: () => onAction("github"),
          seePlans: () => onAction("upgrade"),
          checkAgain: refreshCloudAccount,
        })}
      />
    </div>
  );
}

function AdeCloudTrayLine({
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
  // No ADE upgrade button beside a sponsored card: Settings holds the plan instead.
  const sponsoredOnScreen = useSponsoredCardOnScreen();
  const actions = sponsoredOnScreen && notice.actions.includes("upgrade")
    ? [...new Set(notice.actions.map((action): AdeCloudTrayAction => (action === "upgrade" ? "settings" : action)))]
    : notice.actions;
  const [primaryAction, ...moreActions] = actions;
  const actionsKey = actions.join(" ");
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
  /** Its computer is a DAEX Cloud Mac. */
  mac: boolean;
  /** The server lets its computer change size / move (`unsupported`); a Mac does neither. */
  canChangeSize: boolean;
  canMove: boolean;
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
  const mac = withComputer?.os === "mac";
  // A Mac the launch is still making has no list read yet: the contract's Mac list stands in until it does.
  const refused = withComputer?.unsupported ?? (mac ? CLOUD_MAC_UNSUPPORTED : null);
  const canChangeSize = cloudMachineAllows({ unsupported: refused }, "resize");
  const canMove = cloudMachineAllows({ unsupported: refused }, "move");
  return useMemo(
    () => (laneName ? { laneName, instanceId, noComputer, mac, canChangeSize, canMove } : null),
    [laneName, instanceId, noComputer, mac, canChangeSize, canMove],
  );
}

/**
 * The composer's machine chip for a chat on an ADE Cloud lane: the cloud
 * mark. With a lane to move, it opens "Move this lane to" (and the size
 * change, when the lane has a computer); else it opens the size change alone.
 */
export function AdeCloudMachineChip({
  machineName,
  lane,
  laneMove: laneMoveSource = null,
  wrapperClassName,
}: {
  machineName: string;
  lane: ComposerAdeCloudLane;
  laneMove?: LaneMoveSource | null;
  wrapperClassName: string;
}) {
  const [sizing, setSizing] = useState(false);
  // A person changes the lane's size here; the change is account level (no pin), by the computer's id.
  // ADE Web opens the same picker: a move to the other kind runs on the server there.
  const canResize = !lane.noComputer && lane.canChangeSize && Boolean(lane.instanceId) && (cloudLaneChangesAvailable() || cloudLaneMovesAvailable());
  // A computer the server won't move (a Mac) offers no move.
  const laneMove = lane.canMove ? laneMoveSource : null;
  const computerNoun = lane.mac ? CLOUD_MAC_NAME : `${BRAND.CLOUD_NAME} computer`;
  const wakes = lane.mac ? "It starts when you send." : "It wakes when you send.";
  const pressable = canResize || Boolean(laneMove);
  // The same chip as every other machine: plain text and its icon, no box.
  const chipClass = cn(
    "inline-flex h-6 min-w-0 max-w-full items-center gap-1 overflow-hidden rounded-md px-1",
    "font-sans text-[9px] font-medium text-muted-fg/60",
    pressable && "cursor-pointer transition-colors hover:bg-fg/[0.05] hover:text-fg/85 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/60",
  );
  const chipBody = (
    <>
      <CloudMark size={11} brand />
      {lane.noComputer ? (
        <span className="min-w-0 max-w-40 truncate">{ADE_CLOUD_NAME}</span>
      ) : (
        <span className="min-w-0 max-w-24 truncate">{machineName}</span>
      )}
    </>
  );
  const tooltip = {
    label: ADE_CLOUD_NAME,
    description: lane.noComputer
      ? laneMove
        ? `This lane has no computer now. ${BRAND.NAME} makes a new one when you send. Click to move the lane to one of your computers.`
        : `This lane has no computer now. ${BRAND.NAME} makes a new one when you send.`
      : laneMove
        ? `This chat runs on its lane's own ${computerNoun}. ${wakes} Click to move the lane${canResize ? " or change its size" : ""}.`
        : canResize
          ? `This chat runs on its lane's own ${computerNoun}. ${wakes} Click to change its size.`
          : `This chat runs on its lane's own ${computerNoun}. ${wakes}`,
  };
  const sizeDialog = sizing && lane.instanceId ? (
    <CloudTierChangeDialog instanceId={lane.instanceId} laneName={lane.laneName} onClose={() => setSizing(false)} />
  ) : null;
  if (laneMove) {
    return (
      <>
        <LaneMoveControl
          source={laneMove}
          extras={canResize ? [{ key: "size", label: "Change size…", icon: SlidersHorizontal, onSelect: () => setSizing(true) }] : []}
        >
          {(trigger) => (
            <SmartTooltip forceEnabled wrapperClassName={wrapperClassName} content={tooltip}>
              <button
                ref={trigger.ref}
                type="button"
                data-chat-composer-machine-chip="ade-cloud"
                aria-haspopup="menu"
                aria-expanded={trigger.open}
                aria-label={`Running on ${ADE_CLOUD_NAME}. Move this lane${canResize ? " or change its size" : ""}`}
                className={cn(chipClass, trigger.open && "bg-fg/[0.05] text-fg/85")}
                style={{ whiteSpace: "nowrap" }}
                onClick={trigger.onClick}
              >
                {chipBody}
              </button>
            </SmartTooltip>
          )}
        </LaneMoveControl>
        {sizeDialog}
      </>
    );
  }
  return (
    <>
      <SmartTooltip forceEnabled wrapperClassName={wrapperClassName} content={tooltip}>
        {canResize ? (
          <button
            type="button"
            data-chat-composer-machine-chip="ade-cloud"
            aria-label={`Running on ${ADE_CLOUD_NAME}. Change its size`}
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
              ? `${ADE_CLOUD_NAME}. It has no computer now`
              : `Running on ${ADE_CLOUD_NAME}`}
            className={chipClass}
            style={{ whiteSpace: "nowrap" }}
          >
            {chipBody}
          </span>
        )}
      </SmartTooltip>
      {sizeDialog}
    </>
  );
}

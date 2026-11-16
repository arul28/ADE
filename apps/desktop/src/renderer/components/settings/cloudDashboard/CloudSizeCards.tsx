import { useId, useRef, type KeyboardEvent } from "react";
import { Check } from "@phosphor-icons/react";
import { cloudTierFacts, cloudTierHoursAt, type CloudTier, type CloudTierId } from "../../../../shared/cloudTiers";
import { CloudSizeIcon } from "../../remoteTargets/cloudBrand";
import "./cloudSizeCards.css";

/**
 * The size cards, one per size: how fast it uses hours (big), CPU, memory
 * and how far the disk can grow, "Full computer" where it is one, and the
 * hours left at that size. What it runs is on hover; the desktop screen every
 * size has and the extra-hour price are said once (the Sizes head, the plans'
 * "how it works" panel). The ADE Cloud page picks the default size with
 * them, and the change-size dialog picks a lane's new size (one look for both).
 *
 * A radio group: one Tab stop (the picked card), the arrow keys move and pick.
 * Each card is named by its size; its facts are its description.
 */
export function CloudSizeCards({
  tiers,
  picked,
  onPick,
  leftMilli,
  markId,
  markLabel,
  ariaLabel,
}: {
  tiers: readonly CloudTier[];
  picked: CloudTierId | null;
  onPick: (id: CloudTierId) => void;
  /** The hours left (the plan's and earned ones, `cloudHoursLeftMilli`); null before the account is read, and the line is left out. */
  leftMilli: number | null;
  /** One size gets a tag: the default on the page, the lane's size now in the dialog. */
  markId: CloudTierId | null;
  markLabel: string;
  ariaLabel: string;
}) {
  const idBase = useId();
  const cards = useRef<(HTMLButtonElement | null)[]>([]);
  // The one Tab stop: the picked card, else the first.
  const focusIndex = Math.max(0, tiers.findIndex((tier) => tier.id === picked));
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!tiers.length) return;
    const at = cards.current.findIndex((card) => card === event.target);
    if (at < 0) return;
    let next: number;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (at + 1) % tiers.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (at - 1 + tiers.length) % tiers.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tiers.length - 1;
    else return;
    event.preventDefault();
    cards.current[next]?.focus();
    onPick(tiers[next]!.id);
  };
  return (
    <div className="adecd-sizes-wrap">
      <div className="adecd-sizes" role="radiogroup" aria-label={ariaLabel} onKeyDown={onKeyDown}>
        {tiers.map((tier, index) => {
          const facts = cloudTierFacts(tier);
          const id = `${idBase}-${tier.id}`;
          const marked = tier.id === markId;
          const described = [marked ? `${id}-mark` : null, `${id}-rate`, `${id}-specs`, leftMilli != null ? `${id}-left` : null]
            .filter(Boolean)
            .join(" ");
          return (
            <button
              key={tier.id}
              ref={(card) => { cards.current[index] = card; }}
              type="button"
              role="radio"
              aria-checked={tier.id === picked}
              aria-label={tier.label}
              aria-describedby={described}
              // What it's for, and how fast it uses hours, in words: on hover, not under every card.
              title={`${facts.runs}. ${facts.rateLine}.`}
              tabIndex={index === focusIndex ? 0 : -1}
              className="kit-panel adecd-sizecard"
              onClick={() => onPick(tier.id)}
            >
              <span className="adecd-sizecard-top">
                <CloudSizeIcon tier={tier.id} size={24} />
                <b>{tier.label}</b>
                {marked ? <span id={`${id}-mark`} className="kit-tag adecd-sizecard-pick" data-tone="accent"><Check size={10} weight="bold" />{markLabel}</span> : null}
              </span>
              <span id={`${id}-rate`} className="adecd-sizecard-rate" aria-label={facts.rateLine}>
                <b className="kit-num" data-face="ui">{facts.rate}×</b>
                <span>hours</span>
              </span>
              <span id={`${id}-specs`} className="adecd-sizecard-specs">
                {[`${tier.cpu} CPU`, `${tier.memoryGb} GB memory`, tier.diskMaxGb != null ? `${tier.diskMaxGb} GB disk` : null]
                  .filter(Boolean)
                  .map((fact, at) => <span key={fact}>{at > 0 ? " · " : null}<span className="adecd-sizecard-fact">{fact}</span></span>)}
              </span>
              {facts.full ? <span className="kit-tag adecd-sizecard-full">Full computer</span> : null}
              {leftMilli != null ? (
                <span id={`${id}-left`} className="adecd-sizecard-left">
                  <b className="kit-num" data-face="ui">{cloudTierHoursAt(tier, leftMilli)}</b> left at this size
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

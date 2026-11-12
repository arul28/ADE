import { Check } from "@phosphor-icons/react";
import { cloudTierAgentTimeLabel, cloudTierFacts, type CloudTier, type CloudTierId } from "../../../../shared/cloudTiers";
import { CloudSizeIcon } from "../../remoteTargets/cloudBrand";

/**
 * The size cards, one per size: CPU, memory, how far the disk can grow, the
 * desktop screen, what it runs, how fast it uses hours, and the agent time
 * the hours left buy there. The ADE Cloud page picks the default size with
 * them, and the change-size dialog picks a lane's new size (one look for both).
 */
export function CloudSizeCards({
  tiers,
  picked,
  onPick,
  leftMilli,
  extraHourCents,
  markId,
  markLabel,
  ariaLabel,
}: {
  tiers: readonly CloudTier[];
  picked: CloudTierId | null;
  onPick: (id: CloudTierId) => void;
  leftMilli: number;
  /** The extra-hours price when extra hours are on; null when they aren't available. */
  extraHourCents: number | null;
  /** One size gets a tag: the default on the page, the lane's size now in the dialog. */
  markId: CloudTierId | null;
  markLabel: string;
  ariaLabel: string;
}) {
  return (
    <div className="adecd-sizes" role="radiogroup" aria-label={ariaLabel}>
      {tiers.map((tier) => {
        const facts = cloudTierFacts(tier);
        return (
          <button
            key={tier.id}
            type="button"
            role="radio"
            aria-checked={tier.id === picked}
            className="kit-panel adecd-sizecard"
            onClick={() => onPick(tier.id)}
          >
            <span className="adecd-sizecard-top">
              <CloudSizeIcon tier={tier.id} size={26} />
              <b>{tier.label}</b>
              {tier.id === markId ? <span className="kit-tag adecd-sizecard-pick" data-tone="accent"><Check size={10} weight="bold" />{markLabel}</span> : null}
            </span>
            <span className="adecd-sizecard-specs">
              {facts.specs.map((spec) => <span key={spec}>{spec}</span>)}
            </span>
            <span className="adecd-sizecard-runs">
              {facts.full ? <span className="kit-tag">Full computer</span> : null}
              {facts.runs}
            </span>
            <span className="adecd-sizecard-rate">
              <b className="kit-num" data-face="ui">{facts.rate}×</b>
              <span>{facts.rateLine}</span>
            </span>
            <span className="adecd-sizecard-left">
              <b className="kit-num" data-face="ui">{cloudTierAgentTimeLabel(tier, leftMilli)}</b> left
              {extraHourCents != null ? <>, then <span className="kit-num" data-face="ui">{Math.round(extraHourCents * facts.rate * 100) / 100}¢</span> an hour</> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

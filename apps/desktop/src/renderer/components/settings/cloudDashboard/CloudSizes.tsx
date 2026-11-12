import { useMemo } from "react";
import { Check, Cpu } from "@phosphor-icons/react";
import { cloudCatalogOf, cloudHoursLeftMilli, type CloudAccountState } from "../../../../shared/adeCloud";
import { CLOUD_AWAKE_TIME_LINE, cloudTierAgentTimeLabel, cloudTierFacts, cloudTiers } from "../../../../shared/cloudTiers";
import { pickCloudDefaultTier } from "../../../lib/cloudDefaultTier";
import { useRootAppStore } from "../../../state/appStore";
import { CloudSizeIcon } from "../../remoteTargets/cloudBrand";

/**
 * The four sizes, side by side: CPU, memory, how far the disk can grow, what
 * each runs, how fast it uses hours, and how long the hours left last there.
 * Picking one makes it the size new cloud lanes start on (an account setting).
 */
export function CloudSizes({ account }: { account: CloudAccountState }) {
  const catalog = cloudCatalogOf(account);
  const tiers = useMemo(() => cloudTiers(catalog), [catalog]);
  const defaultTier = useRootAppStore((state) => state.cloudDefaultTier);
  const current = tiers.find((tier) => tier.id === defaultTier) ?? tiers[0] ?? null;
  const leftMilli = cloudHoursLeftMilli(account);
  const extraCents = account.extraHours.available ? catalog.extraHourCents : null;
  return (
    <section id="cloud-sizes" className="kit-card adecd-card" aria-label="Sizes">
      <header className="kit-card-head">
        <Cpu size={14} />
        Sizes
        <span className="adecd-head-note">New cloud lanes start on {current?.label ?? "Small"}. Each lane can change size later.</span>
      </header>
      <div className="kit-card-body">
        <div className="adecd-sizes" role="radiogroup" aria-label="Size for new cloud lanes">
          {tiers.map((tier) => {
            const facts = cloudTierFacts(tier);
            const picked = tier.id === current?.id;
            return (
              <button
                key={tier.id}
                type="button"
                role="radio"
                aria-checked={picked}
                className="kit-panel adecd-sizecard"
                onClick={() => pickCloudDefaultTier(tier.id)}
              >
                <span className="adecd-sizecard-top">
                  <CloudSizeIcon tier={tier.id} size={26} />
                  <b>{tier.label}</b>
                  {picked ? <span className="kit-tag adecd-sizecard-pick" data-tone="accent"><Check size={10} weight="bold" />Default</span> : null}
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
                  {extraCents != null ? <>, then <span className="kit-num" data-face="ui">{Math.round(extraCents * facts.rate * 100) / 100}¢</span> an hour</> : null}
                </span>
              </button>
            );
          })}
        </div>
        <p className="adecd-sizes-note">{CLOUD_AWAKE_TIME_LINE}</p>
      </div>
    </section>
  );
}

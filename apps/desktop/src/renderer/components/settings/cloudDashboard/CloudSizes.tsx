import { useMemo } from "react";
import { Check, Cpu } from "@phosphor-icons/react";
import { cloudCatalogOf, type CloudAccountState } from "../../../../shared/adeCloud";
import { cloudTierFacts, cloudTierHoursLeftLabel, cloudTiers, type CloudTierId } from "../../../../shared/cloudTiers";
import { useRootAppStore } from "../../../state/appStore";
import { CloudSizeIcon } from "../../remoteTargets/cloudBrand";
import { earnedHoursLeftMilli } from "./cloudDashboardModel";

/**
 * The four sizes, side by side: CPU, memory, how far the disk can grow, what
 * each runs, how fast it uses hours, and how long the hours left last there.
 * Picking one makes it the size new cloud lanes start on (an account setting).
 */
export function CloudSizes({ account }: { account: CloudAccountState }) {
  const catalog = cloudCatalogOf(account);
  const tiers = useMemo(() => cloudTiers(catalog), [catalog]);
  const defaultTier = useRootAppStore((state) => state.cloudDefaultTier);
  const setDefaultTier = useRootAppStore((state) => state.setCloudDefaultTier);
  const current = tiers.find((tier) => tier.id === defaultTier) ?? tiers[0] ?? null;
  const leftMilli = account.hours.leftMilli + Math.max(0, earnedHoursLeftMilli(account) ?? 0);
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
                className="adecd-sizecard"
                onClick={() => setDefaultTier(tier.id as CloudTierId)}
              >
                <span className="adecd-sizecard-top">
                  <CloudSizeIcon tier={tier.id} size={26} />
                  <b>{tier.label}</b>
                  {picked ? <span className="adecd-sizecard-pick"><Check size={10} weight="bold" />Default</span> : null}
                </span>
                <span className="adecd-sizecard-specs">
                  {facts.specs.map((spec) => <span key={spec}>{spec}</span>)}
                </span>
                <span className="adecd-sizecard-runs">
                  {facts.full ? <span className="kit-tag">Full computer</span> : null}
                  {facts.runs}
                </span>
                <span className="adecd-sizecard-rate">
                  <b className="kit-num">{facts.rate}×</b>
                  <span>{facts.rateLine}</span>
                </span>
                <span className="adecd-sizecard-left">
                  Your hours last <b className="kit-num">{cloudTierHoursLeftLabel(tier, leftMilli)}</b> here
                  {extraCents != null ? <>, then <span className="kit-num">{Math.round(extraCents * facts.rate * 100) / 100}¢</span> an hour</> : null}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

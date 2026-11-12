import { useMemo } from "react";
import { Cpu } from "@phosphor-icons/react";
import { cloudCatalogOf, cloudHoursLeftMilli, type CloudAccountState } from "../../../../shared/adeCloud";
import { CLOUD_AWAKE_TIME_LINE, cloudTiers } from "../../../../shared/cloudTiers";
import { pickCloudDefaultTier } from "../../../lib/cloudDefaultTier";
import { useRootAppStore } from "../../../state/appStore";
import { CloudSizeCards } from "./CloudSizeCards";

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
        <CloudSizeCards
          tiers={tiers}
          picked={current?.id ?? null}
          onPick={(id) => pickCloudDefaultTier(id)}
          leftMilli={leftMilli}
          extraHourCents={extraCents}
          markId={current?.id ?? null}
          markLabel="Default"
          ariaLabel="Size for new cloud lanes"
        />
        <p className="adecd-sizes-note">{CLOUD_AWAKE_TIME_LINE}</p>
      </div>
    </section>
  );
}

import { useMemo } from "react";
import { Cpu } from "@phosphor-icons/react";
import { cloudCatalogOf, cloudHoursLeftMilli, cloudSmallHoursSentence, type CloudAccountState } from "../../../../shared/adeCloud";
import { cloudTiers } from "../../../../shared/cloudTiers";
import { cloudUnitWords } from "../../../../shared/cloudUnitWords";
import { pickCloudDefaultTier } from "../../../lib/cloudDefaultTier";
import { useRootAppStore } from "../../../state/appStore";
import { CloudSizeCards } from "./CloudSizeCards";

/**
 * The four sizes, side by side: CPU, memory, what each runs, and how long
 * the hours left last there (Small: unlimited, it never uses hours, unless
 * the account's catalog rates it: Free with sponsored cards off).
 * Picking one makes it the size new cloud lanes start on (an account setting).
 */
export function CloudSizes({ account }: { account: CloudAccountState }) {
  const catalog = cloudCatalogOf(account);
  const tiers = useMemo(() => cloudTiers(catalog), [catalog]);
  const defaultTier = useRootAppStore((state) => state.cloudDefaultTier);
  const current = tiers.find((tier) => tier.id === defaultTier) ?? tiers[0] ?? null;
  const leftMilli = cloudHoursLeftMilli(account);
  const words = cloudUnitWords(account);
  return (
    <section id="cloud-sizes" className="kit-card adecd-card" aria-label="Sizes">
      <header className="kit-card-head">
        <Cpu size={14} />
        Sizes
        <span className="adecd-head-note">New cloud lanes start on {current?.label ?? "Small"}; each can change size later. Every size has a desktop screen the agent can use. {cloudSmallHoursSentence(catalog, words)}</span>
      </header>
      <div className="kit-card-body">
        <CloudSizeCards
          tiers={tiers}
          picked={current?.id ?? null}
          onPick={(id) => pickCloudDefaultTier(id)}
          leftMilli={leftMilli}
          markId={current?.id ?? null}
          markLabel="Default"
          ariaLabel="Size for new cloud lanes"
          words={words}
        />
      </div>
    </section>
  );
}

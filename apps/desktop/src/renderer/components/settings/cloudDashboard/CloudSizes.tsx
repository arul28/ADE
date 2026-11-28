import { useMemo } from "react";
import { AppleLogo, Cpu } from "@phosphor-icons/react";
import { cloudMacOfferOf, cloudMacRateText, cloudMacShapeText, cloudMacTimeAt } from "../../../../shared/cloudMac";
import { rootAppStoreApi } from "../../../state/appStore";
import { cloudCatalogOf, cloudHoursLeftMilli, cloudSmallHoursSentence, cloudSmallRateMilli, type CloudAccountState } from "../../../../shared/adeCloud";
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
  // The Small card already says it is unlimited; the note names Small's rate only when it has one.
  const smallNote = cloudSmallRateMilli(catalog) > 0 ? ` ${cloudSmallHoursSentence(catalog, words)}` : "";
  // The DAEX Cloud Mac, only while the catalog offers one: its one shape, and what new lanes a person starts run on.
  const mac = cloudMacOfferOf(account);
  const defaultOs = useRootAppStore((state) => state.cloudDefaultOs);
  const onMac = Boolean(mac) && defaultOs === "mac";
  return (
    <section id="cloud-sizes" className="kit-card adecd-card" aria-label="Sizes">
      <header className="kit-card-head">
        <Cpu size={14} />
        Sizes
        <span className="adecd-head-note">
          {onMac
            ? "New cloud lanes you start begin on a Mac. Agents and automations start on Linux unless they ask for a Mac."
            : `New cloud lanes start on ${current?.label ?? "Small"}; each can change size later. Every size has a desktop screen the agent can use.${smallNote}`}
        </span>
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
        {mac ? (
          <div className="adecd-mac-size" data-picked={onMac || undefined}>
            <AppleLogo size={22} weight="fill" aria-hidden />
            <div className="adecd-mac-size-text">
              <b>Mac</b>
              <span className="kit-num" data-face="ui">{cloudMacShapeText(mac)} · {cloudMacRateText(mac, words)}</span>
              <small>{mac.summary} {mac.keeps}</small>
            </div>
            <div className="adecd-mac-size-side">
              <b className="kit-num" data-face="ui">{cloudMacTimeAt(mac, leftMilli)}</b>
              <span>left on a Mac</span>
              <button
                type="button"
                className="kit-btn"
                data-size="sm"
                aria-pressed={onMac}
                onClick={() => rootAppStoreApi.getState().setCloudDefaultOs(onMac ? "linux" : "mac")}
              >
                {onMac ? `Start new lanes on Linux` : "Start new lanes on a Mac"}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Cpu } from "@phosphor-icons/react";
import { cloudCatalogOf, cloudHoursLeftMilli, type CloudAccountState } from "../../../../shared/adeCloud";
import { cloudTierFacts, cloudTierHoursAt, cloudTiers } from "../../../../shared/cloudTiers";
import { cloudUnitWords } from "../../../../shared/cloudUnitWords";
import { cloudAdsViewOf, cloudPricingOf, cloudTierRatePair, type CloudRatePair } from "../../../../shared/cloudAdPriceWords";
import { pickCloudDefaultTier } from "../../../lib/cloudDefaultTier";
import { useRootAppStore } from "../../../state/appStore";
import { CloudSizeIcon } from "../../remoteTargets/cloudBrand";
import { BRAND } from "../../../../shared/brand";
import "./cloudSizeCards.css";

type Column = "ad" | "full" | "one";

type Row = {
  key: string;
  label: string;
  specs: string;
  title?: string;
  full: boolean;
  pair: CloudRatePair;
  unit: "hour" | "minute";
  /** Time left at the price the person pays now ("54 h", "962 min", "Unlimited"). */
  left: string;
  /** A Linux size new lanes can start on; the iPhone has no radio. */
  pick: boolean;
};

/**
 * Settings › DAEX Cloud's "Sizes and prices": one table, one row a size (and
 * the iPhone, for an account that has it). Its columns: the size new lanes
 * start on (an account setting), the size and what it has, each price, and how
 * long the credits left last at it. The one home of every rate on the page.
 *
 * Under Pricing v3 with ads offered, two price columns: the price the person
 * pays now comes first and bright, under a header that says so; the other
 * stays labelled. Turning the ads switch swaps them with a short highlight
 * and a polite announcement, never a silent reorder. Without ads (or without
 * `pricing`), one price column. Every cell is the account's own catalog.
 *
 * Reads only the account in hand: no read, timer or call of its own.
 */
export function CloudSizes({ account }: { account: CloudAccountState }) {
  const catalog = cloudCatalogOf(account);
  const tiers = useMemo(() => cloudTiers(catalog), [catalog]);
  const defaultTier = useRootAppStore((state) => state.cloudDefaultTier);
  const current = tiers.find((tier) => tier.id === defaultTier) ?? tiers[0] ?? null;
  const leftMilli = cloudHoursLeftMilli(account);
  const words = cloudUnitWords(account);
  const view = cloudPricingOf(account) ? cloudAdsViewOf(account) : null;
  const name = useId();

  const adsLead = view?.available === true && view.on;
  const phone = account.phone?.access === "on" ? catalog.phone ?? null : null;
  const phoneFull = phone?.milliPerMinute ?? (account.phone?.access === "on" ? words.phoneMilliPerMinute : null);
  const rateNow = (pair: CloudRatePair) => (adsLead && pair.adMilli != null ? pair.adMilli : pair.fullMilli);
  const rows: Row[] = [
    ...tiers.map((tier): Row => {
      const pair = cloudTierRatePair(tier);
      const facts = cloudTierFacts(tier, words);
      return {
        key: tier.id,
        label: tier.label,
        specs: [`${tier.cpu} CPU`, `${tier.memoryGb} GB memory`, tier.diskMaxGb != null ? `disk up to ${tier.diskMaxGb} GB` : null].filter(Boolean).join(" · "),
        title: `${facts.runs}.`,
        full: facts.full,
        pair,
        unit: "hour",
        left: cloudTierHoursAt({ multiplierMilli: rateNow(pair) }, leftMilli),
        pick: true,
      };
    }),
    ...(phoneFull != null ? [((): Row => {
      const pair: CloudRatePair = { fullMilli: phoneFull, adMilli: view ? phone?.adMilliPerMinute ?? null : null };
      const rate = rateNow(pair);
      return {
        key: "iphone",
        label: `${BRAND.CLOUD_NAME} iPhone`,
        specs: "One at a time, from your credits",
        full: false,
        pair,
        unit: "minute",
        left: rate > 0 ? `${Math.floor(Math.max(0, leftMilli) / rate).toLocaleString("en-US")} min` : "Unlimited",
        pick: false,
      };
    })()] : []),
  ];
  // Two price columns only where ads are offered and some row's two prices differ.
  const two = view?.available === true && rows.some((row) => row.pair.adMilli != null && row.pair.adMilli !== row.pair.fullMilli);
  const columns: Column[] = two ? (adsLead ? ["ad", "full"] : ["full", "ad"]) : ["one"];
  const lead = columns[0]!;
  // Before Pricing v3, where Free's Small uses credits until something changes: what makes it unlimited again.
  const smallRated = !view && (tiers.find((tier) => tier.id === "small")?.multiplierMilli ?? 0) > 0;
  const legacySmallNote = !smallRated ? null
    : account.sponsored?.smallNeedsLook ? `Opening a ${BRAND.CLOUD_NAME} chat in the US makes Small unlimited again.`
    : account.sponsored?.smallNeedsCards ? "Sponsored cards make Small unlimited."
    : null;

  // The swap is shown, not silent: a highlight on the new lead column and one polite line.
  const previousLead = useRef(lead);
  const [swapped, setSwapped] = useState<{ lead: Column; at: number } | null>(null);
  useEffect(() => {
    if (previousLead.current === lead) return;
    previousLead.current = lead;
    if (lead !== "one") setSwapped({ lead, at: Date.now() });
  }, [lead]);

  const cell = (row: Row, column: Column) => {
    const milli = column === "ad" ? row.pair.adMilli ?? row.pair.fullMilli : column === "full" ? row.pair.fullMilli : rateNow(row.pair);
    return milli > 0 ? `${words.count(milli / 1000)} ${row.unit === "hour" ? "an hour" : "a minute"}` : "Free";
  };
  const head = (column: Column) => (column === "ad" ? "With ads" : column === "full" ? "No ads" : "Price");

  return (
    <section id="cloud-sizes" className="kit-card adecd-card" aria-label="Sizes and prices">
      <header className="kit-card-head">
        <Cpu size={14} />
        Sizes and prices
        <span className="adecd-head-note">New cloud lanes start on the size you pick; each can change size later. Every size has a desktop screen the agent can use.</span>
      </header>
      <div className="kit-card-body" data-flush="true">
        <table className="adecd-sizetable" data-two={two || undefined} data-swap={swapped ? swapped.lead : undefined} key={swapped?.at ?? 0}>
          <thead>
            <tr>
              <th scope="col" className="adecd-sizetable-pick">New lanes</th>
              <th scope="col">Size</th>
              {columns.map((column) => (
                <th key={column} scope="col" className="adecd-sizetable-num" data-lead={column === lead && two ? "" : undefined}>
                  {head(column)}
                  {two && column === lead ? <span className="kit-tag adecd-sizetable-now" data-tone="accent">You pay</span> : null}
                </th>
              ))}
              <th scope="col" className="adecd-sizetable-num">Left at this size</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const picked = row.pick && row.key === current?.id;
              return (
                <tr key={row.key} data-picked={picked || undefined} title={row.title}>
                  <td className="adecd-sizetable-pick">
                    {row.pick ? (
                      <input
                        type="radio"
                        name={name}
                        checked={picked}
                        aria-label={`New cloud lanes start on ${row.label}`}
                        onChange={() => pickCloudDefaultTier(row.key as (typeof tiers)[number]["id"])}
                      />
                    ) : null}
                  </td>
                  <th scope="row">
                    <span className="adecd-sizetable-name">
                      {row.pick ? <CloudSizeIcon tier={row.key as (typeof tiers)[number]["id"]} size={16} /> : null}
                      <b>{row.label}</b>
                      {picked ? <span className="kit-tag" data-tone="accent">Default</span> : null}
                      {row.full ? <span className="kit-tag">Full computer</span> : null}
                    </span>
                    <span className="adecd-sizetable-specs">{row.specs}</span>
                  </th>
                  {columns.map((column) => (
                    <td key={column} className="adecd-sizetable-num kit-num" data-face="ui" data-lead={column === lead && two ? "" : undefined}>{cell(row, column)}</td>
                  ))}
                  <td className="adecd-sizetable-num kit-num" data-face="ui">{row.left}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {legacySmallNote ? <p className="adecd-sizetable-note">{legacySmallNote}</p> : null}
        <p className="sr-only" aria-live="polite">
          {swapped ? (swapped.lead === "ad" ? "Ads are on: the with-ads prices come first." : "Ads are off: the no-ads prices come first.") : ""}
        </p>
      </div>
    </section>
  );
}

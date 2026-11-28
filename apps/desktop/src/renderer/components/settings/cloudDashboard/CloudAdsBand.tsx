import { useState } from "react";
import { ArrowUpRight, Megaphone } from "@phosphor-icons/react";
import { cloudCatalogOf, type CloudAccountState } from "../../../../shared/adeCloud";
import {
  CLOUD_ADS_WORDS,
  cloudAdsSentence,
  cloudAdsViewOf,
  cloudRateText,
  cloudTierRatePair,
} from "../../../../shared/cloudAdPriceWords";
import { cloudTiers } from "../../../../shared/cloudTiers";
import { cloudUnitWords } from "../../../../shared/cloudUnitWords";
import { ipcErrorMessage } from "../../../lib/format";
import { openExternalUrl } from "../../../lib/openExternal";
import { showToast } from "../../app/toast/toastStore";
import { SettingsToggle } from "../primitives/SettingsControls";
import { setCloudAdsOn } from "../../chat/sponsored/cloudAdsAnswer";

/**
 * Settings › DAEX Cloud's one ads switch (Pricing v3), across the hero under
 * the balance: the switch, the sentence the first chat says, and one size's
 * two prices so the effect reads at a glance ("Medium: 8 credits an hour
 * with ads · 10 with no ads"). Off is one click, no dialog; a yes asks a
 * second time only when the server says so (`confirmYes`).
 *
 * Shows only while the account has `pricing` and the person's country has
 * ads (`pricing.ads.available`); elsewhere nothing about ads shows. Account
 * level, no pin. DAEX Free Models keeps its own switch.
 */
export function CloudAdsBand({ account }: { account: CloudAccountState }) {
  const view = cloudAdsViewOf(account);
  const [busy, setBusy] = useState(false);
  if (!view || !view.available) return null;
  const words = cloudUnitWords(account);
  const tiers = cloudTiers(cloudCatalogOf(account));
  // Free: Small is the plan's main offer with ads. Paid: Medium, the size a credit is counted in.
  const example = tiers.find((tier) => tier.id === (view.freePlan ? "small" : "medium") && tier.adMultiplierMilli != null) ?? null;
  // Only a size whose two prices differ shows: at a discount of 0 that is only Free's Small.
  const exampleText = example && example.adMultiplierMilli !== example.multiplierMilli
    ? `${example.label}: ${cloudRateText(cloudTierRatePair(example), view, words)}`
    : null;
  const flip = (on: boolean) => {
    setBusy(true);
    void setCloudAdsOn(on, account)
      .catch((error: unknown) => showToast({ tone: "error", title: "Couldn't change ads", message: ipcErrorMessage(error) || "Try again in a moment." }))
      .finally(() => setBusy(false));
  };
  return (
    <div className="adecd-ads" data-on={view.on || undefined} role="group" aria-label={CLOUD_ADS_WORDS.label}>
      <div className="adecd-ads-switch">
        <span className="adecd-ads-icon" aria-hidden><Megaphone size={15} weight="duotone" /></span>
        <b>{CLOUD_ADS_WORDS.label}</b>
        <SettingsToggle checked={view.on} disabled={busy} label={CLOUD_ADS_WORDS.label} onChange={flip} />
      </div>
      <div className="adecd-ads-body">
        <p className="adecd-ads-sentence">{cloudAdsSentence(view, view.on ? "on" : "ask")}</p>
        {exampleText ? <p className="adecd-ads-example kit-num" data-face="ui">{exampleText}</p> : null}
        <small className="adecd-ads-fine">{CLOUD_ADS_WORDS.whereShown}</small>
        <small className="adecd-ads-fine" data-quiet="">
          {CLOUD_ADS_WORDS.sends}{" "}
          <button type="button" className="adecd-linkish" onClick={() => openExternalUrl("https://ade-app.dev/privacy#sponsored")}>
            {CLOUD_ADS_WORDS.howItWorks}
            <ArrowUpRight size={10} weight="bold" aria-hidden />
          </button>
        </small>
      </div>
    </div>
  );
}

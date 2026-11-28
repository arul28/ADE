import { useState } from "react";
import { ArrowUpRight, Megaphone } from "@phosphor-icons/react";
import type { CloudAccountState } from "../../../../shared/adeCloud";
import { CLOUD_ADS_WORDS, cloudAdsSentence, cloudAdsViewOf } from "../../../../shared/cloudAdPriceWords";
import { ipcErrorMessage } from "../../../lib/format";
import { openExternalUrl } from "../../../lib/openExternal";
import { showToast } from "../../app/toast/toastStore";
import { SettingsToggle } from "../primitives/SettingsControls";
import { setCloudAdsOn } from "../../chat/sponsored/cloudAdsAnswer";

/**
 * Settings › DAEX Cloud's one ads switch (Pricing v3), across the hero under
 * the balance: the switch, the sentence the first chat says, where ads show
 * and what is sent. The prices live in "Sizes and prices" (the swap of its
 * columns shows the switch's effect). Off is one click, no dialog; a yes asks
 * a second time only when the server says so (`confirmYes`).
 *
 * Shows only while the account has `pricing` and the person's country has
 * ads (`pricing.ads.available`); elsewhere nothing about ads shows. Account
 * level, no pin. DAEX Free Models keeps its own switch.
 */
export function CloudAdsBand({ account }: { account: CloudAccountState }) {
  const view = cloudAdsViewOf(account);
  const [busy, setBusy] = useState(false);
  if (!view || !view.available) return null;
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

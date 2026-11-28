import { useState } from "react";
import { Sparkle } from "@phosphor-icons/react";
import type { CloudAccountState } from "../../../../shared/adeCloud";
import { cloudPricingOf } from "../../../../shared/cloudAdPriceWords";
import { BRAND } from "../../../../shared/brand";
import { ipcErrorMessage } from "../../../lib/format";
import { setCloudFreeModelsConsent } from "../../../state/cloudAccountStore";
import { showToast } from "../../app/toast/toastStore";
import { askAdeFreeModelsConsent } from "../../shared/ModelPicker/AdeFreeModelsConsentDialog";
import { SettingsToggle } from "../primitives/SettingsControls";

/**
 * DAEX Free Models' own card, in the page's last region: free models in the
 * model picker, paid for by the ads their chats show. Not the Ads switch in
 * the hero, which sets the price of cloud computers: this one says so, so the
 * two never read as one switch twice. Off stops the models on every device;
 * on opens the consent sheet. Account level, no pin; shows only to an account
 * the server sends `freeModels`. The page reads its account from the machines
 * read, so `onChanged` reads it again after either answer.
 */
export function CloudFreeModelsCard({ account, onChanged }: { account: CloudAccountState; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const freeModels = account.freeModels;
  if (!freeModels) return null;
  const on = freeModels.consent === "granted";
  const flip = (enabled: boolean) => {
    setBusy(true);
    void (enabled ? askAdeFreeModelsConsent() : setCloudFreeModelsConsent("declined"))
      .then(() => onChanged())
      .catch((error: unknown) => showToast({ tone: "error", title: `Couldn't change ${BRAND.NAME} Free Models`, message: ipcErrorMessage(error) || "Try again in a moment." }))
      .finally(() => setBusy(false));
  };
  return (
    <section className="kit-card adecd-card" aria-label={`${BRAND.NAME} Free Models`}>
      <header className="kit-card-head">
        <Sparkle size={14} />
        {BRAND.NAME} Free Models
        <span className="adecd-grow" />
        <SettingsToggle checked={on} disabled={busy} label={`${BRAND.NAME} Free Models`} onChange={flip} />
      </header>
      <div className="kit-card-body">
        <p className="adecd-freemodels-line">
          {on
            ? "On. Free models show in the model picker, on any computer and any plan. Turning this off stops them on every device."
            : "Off. When on, free models show in the model picker, on any computer and any plan."}
        </p>
        <p className="adecd-freemodels-line" data-quiet="">
          {cloudPricingOf(account)
            ? "They are free because each chat that uses one shows ads, also with ads off above. The Ads switch sets the price of cloud computers only."
            : "They are free because each chat that uses one shows ads."}
        </p>
      </div>
    </section>
  );
}

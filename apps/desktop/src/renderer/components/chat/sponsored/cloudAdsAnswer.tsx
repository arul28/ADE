import { Megaphone } from "@phosphor-icons/react";
import type { CloudAccountState } from "../../../../shared/adeCloud";
import { CLOUD_ADS_WORDS } from "../../../../shared/cloudAdPriceWords";
import { cloudAccountGeneration, cloudAccountNow, setCloudSponsoredConsent } from "../../../state/cloudAccountStore";
import { confirmDialog } from "../../ui/dialog";

/**
 * The person's answers to Pricing v3's ads notice and switch, saved on the
 * account server (`PUT /cloud/sponsored/consent` with `noticeSeen`), so one
 * answer holds on every device and the notice never shows twice. Account
 * level, no pin.
 *
 * Off is one click with no dialog, on every plan. A yes asks once more only
 * when the server says the law needs it (`sponsored.confirmYes`).
 */
export async function setCloudAdsOn(on: boolean, account: Pick<CloudAccountState, "sponsored">): Promise<void> {
  // The answer belongs to the account signed in when it was given, not one signed in while a confirm was open.
  const since = cloudAccountGeneration();
  if (!on) {
    await setCloudSponsoredConsent("declined", false, since, true);
    return;
  }
  // The store holds the server's newest answer (a "no" just given there marks `confirmYes` at once);
  // the caller's copy can be a list read older than that no.
  const confirmYes = cloudAccountNow()?.sponsored?.confirmYes === true || account.sponsored?.confirmYes === true;
  if (confirmYes) {
    const ok = await confirmDialog({
      title: CLOUD_ADS_WORDS.confirmTitle,
      message: CLOUD_ADS_WORDS.sends,
      confirmLabel: CLOUD_ADS_WORDS.turnOn,
      cancelLabel: CLOUD_ADS_WORDS.keepOff,
      icon: <Megaphone size={18} weight="duotone" />,
    });
    if (!ok) return;
  }
  await setCloudSponsoredConsent("granted", confirmYes, since, true);
}

/**
 * "Keep ads" on the notice where ads start on: the person was told, which
 * keeps them on. Over an older yes, that yes is sent again with the notice.
 */
export async function keepCloudAds(account: Pick<CloudAccountState, "sponsored">): Promise<void> {
  const since = cloudAccountGeneration();
  const consent = account.sponsored?.consent === "granted" ? "granted" : "notice";
  await setCloudSponsoredConsent(consent, false, since, true);
}

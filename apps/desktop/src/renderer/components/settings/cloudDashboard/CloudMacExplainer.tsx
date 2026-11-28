import { AppleLogo } from "@phosphor-icons/react";
import { CLOUD_MAC_NAME, CLOUD_MAC_START_WORDS, cloudMacOfferOf } from "../../../../shared/cloudMac";
import type { CloudAccountState } from "../../../../shared/adeCloud";
import { rootAppStoreApi, useRootAppStore } from "../../../state/appStore";

/**
 * How a DAEX Cloud Mac works, the one home of these facts on the page: what a
 * stop keeps (the catalog's `keeps`), how soon the next message starts it, and
 * that nothing is charged while it waits for a free Mac. Shown while the
 * account has a Mac lane (`hasMacLane`), until a person presses Got it (a
 * synced account setting). Reads the account state the page already has.
 */
export function CloudMacExplainer({ account, hasMacLane }: { account: CloudAccountState; hasMacLane: boolean }) {
  const read = useRootAppStore((state) => state.cloudMacExplainerRead);
  const offer = cloudMacOfferOf(account);
  if (read || !offer || !hasMacLane) return null;
  return (
    <div className="adecd-mac-explainer">
      <AppleLogo size={16} weight="fill" aria-hidden />
      <p>
        <b>How a {CLOUD_MAC_NAME} works.</b> {offer.keeps} The next message starts a new Mac with the same drive {CLOUD_MAC_START_WORDS}. While it waits for a free Mac, nothing is charged.
      </p>
      <button type="button" className="kit-btn" data-size="xs" onClick={() => rootAppStoreApi.getState().setCloudMacExplainerRead(true)}>Got it</button>
    </div>
  );
}

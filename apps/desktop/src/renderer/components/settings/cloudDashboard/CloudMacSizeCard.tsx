import { AppleLogo } from "@phosphor-icons/react";
import { cloudMacShapeText, cloudMacTimeAt, type CloudMacOffer } from "../../../../shared/cloudMac";
import { rootAppStoreApi } from "../../../state/appStore";

/**
 * The DAEX Cloud Mac beside the four sizes: its one shape, what it is (the
 * catalog's `summary`), the credits left as time on it, and the pick for what
 * new lanes a person starts run on. The rate lives in the rate table
 * (`CloudMacRateRow`) and what a stop keeps in `CloudMacExplainer`, so neither
 * repeats here. Reads only its props; no load of its own.
 */
export function CloudMacSizeCard({ offer, leftMilli, onMac }: { offer: CloudMacOffer; leftMilli: number; onMac: boolean }) {
  return (
    <div className="adecd-mac-size" data-picked={onMac || undefined}>
      <AppleLogo size={22} weight="fill" aria-hidden />
      <div className="adecd-mac-size-text">
        <b>Mac</b>
        <span className="kit-num" data-face="ui">{cloudMacShapeText(offer)}</span>
        <small>{offer.summary}</small>
      </div>
      <div className="adecd-mac-size-side">
        <b className="kit-num" data-face="ui">{cloudMacTimeAt(offer, leftMilli)}</b>
        <span>left on a Mac</span>
        <button
          type="button"
          className="kit-btn"
          data-size="sm"
          aria-pressed={onMac}
          onClick={() => rootAppStoreApi.getState().setCloudDefaultOs(onMac ? "linux" : "mac")}
        >
          {onMac ? "Start new lanes on Linux" : "Start new lanes on a Mac"}
        </button>
      </div>
    </div>
  );
}

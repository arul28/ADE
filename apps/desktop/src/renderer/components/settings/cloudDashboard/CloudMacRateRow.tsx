import { CLOUD_MAC_NAME, cloudMacRateText, type CloudMacOffer } from "../../../../shared/cloudMac";
import type { CloudUnitWords } from "../../../../shared/cloudUnitWords";

/**
 * The Mac's row in the "What uses credits" table, the one home of its rate on
 * the page ("0.5 credits a minute", from the catalog). Reads only its props.
 */
export function CloudMacRateRow({ offer, words }: { offer: CloudMacOffer; words: Pick<CloudUnitWords, "count"> }) {
  return (
    <tr><th scope="row">{CLOUD_MAC_NAME}</th><td className="kit-num">{cloudMacRateText(offer, words)}</td></tr>
  );
}

import { Coins, Info } from "@phosphor-icons/react";
import {
  cloudAdsViewOf,
  cloudComputerPriceOf,
  cloudFullPriceReasonLine,
  cloudPriceNowText,
} from "../../../shared/cloudAdPriceWords";
import { cloudUnitWords } from "../../../shared/cloudUnitWords";
import { useCloudAccount } from "../../state/cloudAccountStore";

/**
 * What one cloud computer costs now (Pricing v3), for any header that knows
 * only the computer's id: a chat's, a CLI session's or a shell's. One line
 * with the price ("8 credits an hour with ads · 10 with no ads"), and under it
 * the reason when the computer is at the full price while ads are on ("Full
 * price: a CLI session runs here"). The server decides both
 * (`pricing.computers[]`); this only reads the account the window already
 * follows. Nothing without Pricing v3 or for a computer the account doesn't
 * price (asleep, or not the account's). Account level, no pin.
 */
export function CloudComputerPriceRow({ instanceId, compact = false }: { instanceId: string | null; compact?: boolean }) {
  const account = useCloudAccount(Boolean(instanceId));
  const price = cloudComputerPriceOf(account, instanceId);
  if (!account || !price) return null;
  const view = cloudAdsViewOf(account);
  const words = cloudUnitWords(account);
  const text = cloudPriceNowText(price, view, words);
  const reason = cloudFullPriceReasonLine(price, view);
  return (
    <div className="flex min-w-0 flex-col gap-0.5 text-[11px] leading-snug text-muted-fg" data-cloud-price={price.now}>
      <span className="flex min-w-0 items-center gap-1.5" title={compact && reason ? `${text}. ${reason}` : undefined}>
        <Coins size={12} className="shrink-0" aria-hidden />
        <span className="kit-num truncate">{text}</span>
      </span>
      {reason && !compact ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <Info size={12} className="shrink-0" aria-hidden />
          <span className="truncate">{reason}</span>
        </span>
      ) : null}
    </div>
  );
}

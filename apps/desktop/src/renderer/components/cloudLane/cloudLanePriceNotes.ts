import { useMemo, useRef } from "react";
import {
  cloudAdsViewOf,
  cloudFullPriceReasonLine,
  cloudPriceNowCompact,
  cloudPriceNowText,
  cloudPricingOf,
} from "../../../shared/cloudAdPriceWords";
import { cloudUnitWords } from "../../../shared/cloudUnitWords";
import { useAdeCloudLaneComputers } from "../../state/adeCloudLaneIndex";
import { useCloudAccount } from "../../state/cloudAccountStore";
import type { CloudLaneRowNote } from "./cloudLanesWithoutComputer";

const NONE: ReadonlyMap<string, CloudLaneRowNote> = new Map();

/**
 * Pricing v3's quiet word on a cloud lane's header in the Work list: what its
 * computer costs now ("8/h with ads", "10/h · Full price"), with the full
 * line and the reason as its tooltip. Awake computers only; nothing without
 * Pricing v3.
 *
 * One map for the whole list, from two stores the list already follows (the
 * account and the lane index): no read, timer or subscription of its own. The
 * map keeps its identity while no note changes, so lane headers don't
 * re-render on an account read that moved nothing.
 */
export function useCloudLanePriceNotes(): ReadonlyMap<string, CloudLaneRowNote> {
  const account = useCloudAccount();
  const { computers } = useAdeCloudLaneComputers();
  const last = useRef<ReadonlyMap<string, CloudLaneRowNote>>(NONE);
  return useMemo(() => {
    const pricing = cloudPricingOf(account);
    if (!pricing) return (last.current = NONE);
    const view = cloudAdsViewOf(account);
    const words = cloudUnitWords(account);
    const byInstance = new Map(pricing.computers.map((entry) => [entry.instanceId, entry]));
    const next = new Map<string, CloudLaneRowNote>();
    for (const computer of computers) {
      if (computer.state !== "running") continue;
      const price = byInstance.get(computer.instanceId);
      if (!price) continue;
      const reason = cloudFullPriceReasonLine(price, view);
      const compact = cloudPriceNowCompact(price, view, words);
      next.set(computer.laneId, {
        label: reason ? `${compact} · Full price` : compact,
        title: [cloudPriceNowText(price, view, words), reason].filter(Boolean).join(". "),
      });
    }
    const previous = last.current;
    const same = previous.size === next.size
      && [...next].every(([laneId, note]) => previous.get(laneId)?.label === note.label && previous.get(laneId)?.title === note.title);
    if (!same) last.current = next.size ? next : NONE;
    return last.current;
  }, [account, computers]);
}

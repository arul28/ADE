import { useMemo } from "react";
import { cloudLaneLaunchStartRefusal } from "../../../shared/cloudLaneLaunch";
import { useAdeCloudDraft } from "../chat/useAdeCloudDraft";

export { ADE_CLOUD_MACHINE_ID } from "../chat/useAdeCloudDraft";

/**
 * ADE Cloud as one choice of where a new lane lives, in every place that makes
 * a lane (the new lane dialog, a lane from a pull request's branch, a Linear
 * batch). It reads only what the composer's Run on menu reads: the account's
 * computers from the one shared list (`useCloudMachines`, while `open`), the
 * catalog's sizes and the saved default size. No read of its own.
 */
export function useAdeCloudLaneTarget(open: boolean, originUrl: string | null) {
  const draft = useAdeCloudDraft({ enabled: open, originUrl });
  // A lane on ADE Cloud clones the project from GitHub: without a GitHub
  // origin the choice is shown, off, with the reason.
  const originProblem = useMemo(
    () => cloudLaneLaunchStartRefusal({
      args: { kind: "lane", mode: "background", launchId: "", prompt: "", cloud: { sizeId: "small" } },
      originUrl,
    })?.message ?? null,
    [originUrl],
  );
  return {
    /** ADE Cloud access is on for this account: the choice is listed. */
    offered: draft.available,
    /** Why ADE Cloud can't be picked here, or null. */
    unavailableReason: originProblem,
    account: draft.account,
    tiers: draft.tiers,
    tierId: draft.tierId,
    defaultTier: draft.defaultTier,
    chooseTier: draft.chooseTier,
    resetTier: draft.resetTier,
    setDefaultTier: draft.setDefaultTier,
    /** The line under the name in a machine list. No plan limits how many computers an account has. */
    detail: "A new computer for each lane",
  };
}

export type AdeCloudLaneTarget = ReturnType<typeof useAdeCloudLaneTarget>;

/**
 * What a machine list needs to show ADE Cloud as one of its rows: listed only
 * when `offered`, off with `unavailableReason`.
 */
export type AdeCloudLaneChoice = {
  selected: boolean;
  unavailableReason: string | null;
  detail: string;
  onSelect: () => void;
};

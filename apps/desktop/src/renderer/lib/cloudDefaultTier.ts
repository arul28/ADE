import type { CloudTierId } from "../../shared/cloudTiers";
import { rootAppStoreApi } from "../state/appStore";

/**
 * The person picks the size new ADE Cloud lanes start on (Settings › ADE
 * Cloud › Sizes, or the composer's "Start every new lane on …"): save it and
 * count the pick. A value synced from another computer goes through the
 * store's setter alone, so a pick is counted once, where it was made.
 */
export function pickCloudDefaultTier(tier: CloudTierId): void {
  const before = rootAppStoreApi.getState().cloudDefaultTier;
  rootAppStoreApi.getState().setCloudDefaultTier(tier);
  const after = rootAppStoreApi.getState().cloudDefaultTier;
  if (after === before) return;
  void window.ade?.analytics?.capture({
    event: "ade_feature_used",
    properties: { feature: "connections", action: "cloud_default_size", outcome: `size_${after}` },
    projectId: null,
  }).catch(() => undefined);
}

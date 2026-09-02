import { modelSupportsFastMode, type ModelDescriptor } from "../../../shared/modelRegistry";

export type DraftModelControls = {
  reasoningEffort: string | null;
  fastMode: boolean;
};

/**
 * Reconciles a draft's thinking level and fast-mode flag to the model the draft
 * now points at.
 *
 * A composer control is only meaningful while the selected model advertises it.
 * The draft keeps `reasoningEffort` and `fastMode` in its own state, so a model
 * change leaves a value behind that the new model never exposes: switching from
 * a Cursor model with thinking levels to `cursor/composer-2.5` (which reports
 * `reasoningEfforts: []`) used to carry `xhigh` into the launch snapshot, and
 * the main process rejected the cloud run. The control is invisible at that
 * point, so the user cannot clear it themselves.
 *
 * The rules mirror what the composer renders:
 * - `ReasoningEffortPicker` reads `descriptor.reasoningTiers`. No tiers means no
 *   picker, so the effort must be null.
 * - A tier the model does not list falls back to the model's advertised default,
 *   and to null when that default is not a real tier either.
 * - A null effort stays null. Null is the composer's "Auto", which every model
 *   accepts, so a model change must not turn it into an explicit tier.
 * - `modelSupportsFastMode` gates the fast toggle on the "fast" service tier.
 *
 * A descriptor that does not resolve leaves both values untouched. A catalog
 * that has not loaded yet is not evidence that a control disappeared, and the
 * main process still fails closed on a value the runtime cannot accept.
 */
export function reconcileDraftModelControls(
  descriptor: ModelDescriptor | null | undefined,
  current: DraftModelControls,
): DraftModelControls {
  if (!descriptor) return current;
  return {
    reasoningEffort: reconcileDraftReasoningEffort(descriptor, current.reasoningEffort),
    fastMode: current.fastMode && modelSupportsFastMode(descriptor),
  };
}

function reconcileDraftReasoningEffort(
  descriptor: ModelDescriptor,
  current: string | null,
): string | null {
  const tiers = descriptor.reasoningTiers ?? [];
  if (!tiers.length) return null;
  const normalizedCurrent = current?.trim().toLowerCase() ?? "";
  if (!normalizedCurrent) return null;
  const matchedTier = tiers.find((tier) => tier.trim().toLowerCase() === normalizedCurrent);
  if (matchedTier) return matchedTier;
  const advertisedDefault = descriptor.defaultReasoningEffort?.trim().toLowerCase() ?? "";
  const matchedDefault = advertisedDefault
    ? tiers.find((tier) => tier.trim().toLowerCase() === advertisedDefault)
    : undefined;
  return matchedDefault ?? null;
}

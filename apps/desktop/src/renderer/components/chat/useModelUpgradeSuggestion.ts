import { useMemo, useSyncExternalStore, type MutableRefObject } from "react";
import { findModelUpgrade, type ModelUpgrade } from "../../../shared/modelSuccessors";
import {
  dismissModelUpgrade,
  isModelUpgradeDismissed,
  modelUpgradeDismissalsVersion,
  subscribeModelUpgradeDismissals,
} from "./modelUpgradeMemory";

export type ModelUpgradeSuggestion = ModelUpgrade & {
  /** Picks the newer version as the person would in the picker. */
  switchTo: () => void;
  /** Turns this pair down on this client (`modelUpgradeMemory.ts`). */
  dismiss: () => void;
};

/**
 * "A newer version is out" for the composer's model (ADE-300,
 * `shared/modelSuccessors.ts`). Only a suggestion: ADE never changes the
 * model itself. Switch on a new chat changes it now; on an open chat it
 * applies with the next message, like any pick in the picker.
 */
export function useModelUpgradeSuggestion(args: {
  modelId: string;
  /** The models the composer can pick on the chat's machine. */
  availableModelIds: readonly string[];
  /** The composer can change its model now (not locked, running or fixed). */
  canSwitch: boolean;
  /** The composer's own pick handler: false when it refuses the model. */
  personModelChangeRef: MutableRefObject<((modelId: string) => boolean) | null>;
}): ModelUpgradeSuggestion | null {
  const { modelId, availableModelIds, canSwitch, personModelChangeRef } = args;
  const dismissals = useSyncExternalStore(subscribeModelUpgradeDismissals, modelUpgradeDismissalsVersion);
  return useMemo(() => {
    if (!canSwitch || !modelId) return null;
    const upgrade = findModelUpgrade(modelId, availableModelIds);
    if (!upgrade || isModelUpgradeDismissed(upgrade)) return null;
    return {
      ...upgrade,
      switchTo: () => { personModelChangeRef.current?.(upgrade.toModelId); },
      dismiss: () => dismissModelUpgrade(upgrade),
    };
    // `dismissals`: a pair turned down here or in another window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableModelIds, canSwitch, dismissals, modelId, personModelChangeRef]);
}

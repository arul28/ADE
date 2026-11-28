import { useCallback, useMemo, useRef, useSyncExternalStore, type MutableRefObject } from "react";
import { findModelUpgrade, type ModelUpgrade } from "../../../shared/modelSuccessors";
import {
  dismissModelUpgrade,
  modelUpgradePairKey,
  readDismissedModelUpgrades,
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
 *
 * `notePicked` is for the composer's own picker and @ menu: an older version
 * chosen there by hand is the person's answer, so its pair is turned down.
 */
export function useModelUpgradeSuggestion(args: {
  modelId: string;
  /** The models the composer can pick on the chat's machine. */
  availableModelIds: readonly string[];
  /** The composer can change its model now (not locked, running or fixed). */
  canSwitch: boolean;
  /** The composer's own pick handler: false when it refuses the model. */
  personModelChangeRef: MutableRefObject<((modelId: string) => boolean) | null>;
}): { suggestion: ModelUpgradeSuggestion | null; notePicked: (modelId: string) => void } {
  const { modelId, availableModelIds, canSwitch, personModelChangeRef } = args;
  const dismissed = useSyncExternalStore(subscribeModelUpgradeDismissals, readDismissedModelUpgrades);
  const availableRef = useRef(availableModelIds);
  availableRef.current = availableModelIds;

  const suggestion = useMemo(() => {
    if (!canSwitch) return null;
    const upgrade = findModelUpgrade(modelId, availableModelIds);
    if (!upgrade || dismissed.includes(modelUpgradePairKey(upgrade))) return null;
    return {
      ...upgrade,
      switchTo: () => { personModelChangeRef.current?.(upgrade.toModelId); },
      dismiss: () => dismissModelUpgrade(upgrade),
    };
  }, [availableModelIds, canSwitch, dismissed, modelId, personModelChangeRef]);

  const notePicked = useCallback((pickedModelId: string) => {
    const upgrade = findModelUpgrade(pickedModelId, availableRef.current);
    if (upgrade) dismissModelUpgrade(upgrade);
  }, []);

  return { suggestion, notePicked };
}

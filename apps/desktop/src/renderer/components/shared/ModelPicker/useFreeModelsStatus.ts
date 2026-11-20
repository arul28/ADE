import { useEffect, useRef, useState } from "react";
import type { AiFreeModelsStatus, OpenProjectBinding } from "../../../../shared/types";
import {
  AI_STATUS_CACHE_UPDATED_EVENT,
  getAiStatusCached,
  peekAiStatusCached,
  type AiStatusCacheUpdatedEventDetail,
} from "../../../lib/aiDiscoveryCache";
import { arePathsEqual } from "../../../lib/pathUtils";
import { selectActiveProjectRoot, useAppStore } from "../../../state/appStore";

/**
 * The free-models block of the AI status on the machine `runtimePin` names
 * (`shared/freeModels.ts`). Reads the shared status cache, so it adds no
 * request of its own beyond the one every picker already shares.
 *
 * Null until the status is known, and for a brain too old to send the block:
 * callers then behave as before (someone is signed in).
 */
export function useFreeModelsStatus(runtimePin: OpenProjectBinding | null): AiFreeModelsStatus | null {
  const projectBindingKey = useAppStore((state) => state.projectBinding?.key ?? null);
  // The status cache keys the tab's own machine without a pin, as
  // `useProviderAuthStatus` does.
  const pin = runtimePin && runtimePin.key !== projectBindingKey ? runtimePin : null;
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? null;
  const activeProjectRoot = useAppStore(selectActiveProjectRoot);
  const projectRoot = pin?.rootPath ?? activeProjectRoot;
  const [freeModels, setFreeModels] = useState<AiFreeModelsStatus | null>(
    () => peekAiStatusCached(projectRoot, pin)?.freeModels ?? null,
  );

  useEffect(() => {
    let active = true;
    const apply = (next: AiFreeModelsStatus | null | undefined) => {
      if (!active) return;
      const value = next ?? null;
      setFreeModels((current) => (
        current?.nothingSignedIn === value?.nothingSignedIn
        && current?.everSignedIn === value?.everSignedIn
        && current?.preferredDefaultModelIds.join() === value?.preferredDefaultModelIds.join()
          ? current
          : value
      ));
    };
    apply(peekAiStatusCached(projectRoot, pinRef.current)?.freeModels);
    const onUpdated = (event: Event) => {
      const updatedRoot = (event as CustomEvent<AiStatusCacheUpdatedEventDetail>).detail?.projectRoot ?? null;
      if (updatedRoot !== (projectRoot ?? null) && !(updatedRoot && projectRoot && arePathsEqual(updatedRoot, projectRoot))) return;
      apply(peekAiStatusCached(projectRoot, pinRef.current)?.freeModels);
    };
    window.addEventListener(AI_STATUS_CACHE_UPDATED_EVENT, onUpdated);
    if (typeof window.ade?.ai?.getStatus === "function") {
      void getAiStatusCached({ projectRoot, pin: pinRef.current })
        .then((status) => apply(status?.freeModels))
        .catch(() => undefined);
    }
    return () => {
      active = false;
      window.removeEventListener(AI_STATUS_CACHE_UPDATED_EVENT, onUpdated);
    };
  }, [pinKey, projectRoot]);

  return freeModels;
}

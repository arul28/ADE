import { useCallback, useEffect, useRef, useState } from "react";
import type { AiFreeModelsStatus, OpenProjectBinding } from "../../../../shared/types";
import {
  AI_STATUS_CACHE_UPDATED_EVENT,
  aiStatusRootMatches,
  aiStatusUpdatedRoot,
  getAiStatusCached,
  statusCachePin,
  peekAiStatusCached,
} from "../../../lib/aiDiscoveryCache";
import { selectActiveProjectRoot, useAppStore } from "../../../state/appStore";

/**
 * The free-models block of the AI status on the machine `runtimePin` names
 * (`shared/freeModels.ts`). Reads the shared status cache, so it adds no
 * request of its own beyond the one every picker already shares.
 *
 * `status` is null until the status is known, and for a brain too old to send
 * the block: callers then behave as before (someone is signed in). `refresh`
 * makes that machine re-read its status (OpenCode just downloaded there) and
 * resolves false when the read failed.
 */
export function useFreeModelsStatus(runtimePin: OpenProjectBinding | null): {
  status: AiFreeModelsStatus | null;
  refresh: () => Promise<boolean>;
} {
  const projectBindingKey = useAppStore((state) => state.projectBinding?.key ?? null);
  // The status cache keys the tab's own machine without a pin, as
  // `useProviderAuthStatus` does.
  const pin = statusCachePin(runtimePin, projectBindingKey);
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
      if (!aiStatusRootMatches(aiStatusUpdatedRoot(event), projectRoot)) return;
      apply(peekAiStatusCached(projectRoot, pinRef.current)?.freeModels);
    };
    window.addEventListener(AI_STATUS_CACHE_UPDATED_EVENT, onUpdated);
    if (typeof window.ade?.ai?.getStatus === "function") {
      void getAiStatusCached({ projectRoot, pin: pinRef.current })
        // The cache, not this reply: a newer read may have finished first.
        .then((status) => apply((peekAiStatusCached(projectRoot, pinRef.current) ?? status)?.freeModels))
        .catch(() => undefined);
    }
    return () => {
      active = false;
      window.removeEventListener(AI_STATUS_CACHE_UPDATED_EVENT, onUpdated);
    };
  }, [pinKey, projectRoot]);

  const refresh = useCallback(
    () => getAiStatusCached({ projectRoot, pin: pinRef.current, force: true }).then(() => true, () => false),
    [projectRoot],
  );

  return { status: freeModels, refresh };
}

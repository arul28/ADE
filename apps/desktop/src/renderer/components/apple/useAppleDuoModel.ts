import { useEffect, useState, type MutableRefObject } from "react";
import type { Group } from "three";
import type { OpenProjectBinding } from "../../../shared/types";

/**
 * Apple's Duo model, loaded once per machine and kept for the window.
 *
 * The bytes come from the Xcode on the machine that owns the simulator
 * (`ios_simulator.getDuoModel`, pinned), so a laptop pinned to a desktop uses
 * the desktop's Xcode. Parsing ~6 MB of USDC is not free, so the prepared
 * model is cached per machine and every body clones it.
 */
const models = new Map<string, Promise<Group | null>>();

function loadFor(key: string, pin: OpenProjectBinding | null): Promise<Group | null> {
  let pending = models.get(key);
  if (!pending) {
    pending = (async () => {
      const result = await window.ade.iosSimulator.getDuoModel(pin);
      if (!result.base64) return null;
      const binary = atob(result.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const { loadDuoModel } = await import("./vendor/serve-sim/duoModel");
      return loadDuoModel(bytes.buffer);
    })().catch(() => {
      // Retry on the next mount rather than caching a failure for the window.
      models.delete(key);
      return null;
    });
    models.set(key, pending);
  }
  return pending;
}

export function useAppleDuoModel({
  enabled,
  pinKey,
  runtimePinRef,
}: {
  enabled: boolean;
  pinKey: string | null;
  runtimePinRef: MutableRefObject<OpenProjectBinding | null>;
}): Group | null {
  const [model, setModel] = useState<Group | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void loadFor(pinKey ?? "local", runtimePinRef.current).then((next) => {
      if (!cancelled) setModel(next);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, pinKey, runtimePinRef]);
  return enabled ? model : null;
}

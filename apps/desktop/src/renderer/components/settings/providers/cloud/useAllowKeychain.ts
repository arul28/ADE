/**
 * "Allow on this computer": copy Antigravity's agy CLI sign-in from this
 * computer's OS keyring (the Keychain, Credential Manager or the keyring).
 * macOS, or a locked Linux keyring, shows its prompt while the call waits (up
 * to 2 min), so the read in flight is kept outside any view: leaving the page
 * and coming back, or the ADE Cloud tile and This computer's page both open,
 * never starts a second one. The button says it is waiting until the call
 * ends; no timer.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { OpenProjectBinding } from "../../../../../shared/types";
import type { RunWrite } from "./signInWrites";

/** One call in flight for each slot (the keyring allow, the GitHub CLI read), outside any view. */
const inFlight = new Map<string, Promise<unknown>>();

/**
 * `run` makes the call (with This computer's pin) and applies its status.
 * `slot` names the long call; the GitHub CLI login uses its own, so the two never block each other.
 */
export function useAllowKeychain(
  run: () => Promise<unknown>,
  slot = "keychain",
): { allowing: boolean; allow: () => void } {
  const [allowing, setAllowing] = useState(() => inFlight.has(slot));
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    // Opened while an earlier view's call still waits: busy until it ends.
    const earlier = inFlight.get(slot);
    if (earlier) {
      void earlier.finally(() => {
        if (mountedRef.current) setAllowing(false);
      });
    }
    return () => {
      mountedRef.current = false;
    };
  }, [slot]);
  const allow = useCallback(() => {
    if (inFlight.has(slot)) return;
    setAllowing(true);
    const call = run();
    inFlight.set(slot, call);
    void call.finally(() => {
      if (inFlight.get(slot) === call) inFlight.delete(slot);
      if (mountedRef.current) setAllowing(false);
    });
  }, [run, slot]);
  return { allowing, allow };
}

/** "Allow on this computer" for Antigravity: the write goes through `runWrite` with This computer's pin. */
export function useAllowAntigravityKeychain(runWrite: RunWrite, accountPin: OpenProjectBinding | null): { allowing: boolean; allow: () => void } {
  const run = useCallback(() => runWrite(
    "allow:antigravity",
    () => window.ade?.providerLogins?.allowKeychain?.({ provider: "antigravity" }, accountPin),
    "ADE couldn't copy the Antigravity sign-in from this computer.",
  ), [accountPin, runWrite]);
  return useAllowKeychain(run);
}

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type {
  IosSimulatorAppearance,
  IosSimulatorContentSize,
  IosSimulatorDeviceSettings,
} from "../../../shared/types/iosSimulator";
import type { OpenProjectBinding } from "../../../shared/types";

/** The rail's Text size menu, in the four names a person recognises. */
export const APPLE_TEXT_SIZES = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Default" },
  { value: "large", label: "Large" },
  { value: "extra-large", label: "Extra large" },
] as const satisfies readonly { value: IosSimulatorContentSize; label: string }[];

export type AppleDeviceAction =
  | { type: "setAppearance"; value: IosSimulatorAppearance }
  | { type: "setTextSize"; value: IosSimulatorContentSize };

export type AppleDeviceControls = {
  /** The last settings the DEVICE confirmed. Never an optimistic guess. */
  settings: IosSimulatorDeviceSettings | null;
  pending: boolean;
  error: unknown;
  clearError: () => void;
  act: (action: AppleDeviceAction) => Promise<void>;
  /** §5: `pending || !detail || !visible`. */
  disabled: boolean;
};

/**
 * One confirmed settings snapshot, and every write serialized behind it.
 *
 * Round 1 toggled the rail's own state and then fired the IPC, so a refused
 * write left a Dark button lit over a light device. Nothing here is drawn from
 * intent: `act` returns the settings the service read BACK off the simulator,
 * and a second click while one is in flight is dropped rather than queued.
 *
 * The generation counter is what makes hiding safe. Hiding invalidates the
 * result, not the command — the helper is still running it — so a reopened
 * pane must not paint a reply to a question it no longer remembers asking.
 */
export function useAppleDeviceControls({
  deviceUdid,
  laneId,
  chatSessionId,
  visible,
  runtimePinRef,
}: {
  deviceUdid: string | null;
  laneId: string | null;
  chatSessionId: string | null;
  visible: boolean;
  runtimePinRef: MutableRefObject<OpenProjectBinding | null>;
}): AppleDeviceControls {
  const [settings, setSettings] = useState<IosSimulatorDeviceSettings | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const busy = useRef(false);
  const generation = useRef(0);

  const clearError = useCallback(() => setError(null), []);

  useEffect(() => {
    const revision = ++generation.current;
    if (!visible || !deviceUdid) {
      setSettings(null);
      return undefined;
    }
    void window.ade.iosSimulator
      .getDeviceSettings({ deviceUdid, laneId, chatSessionId }, runtimePinRef.current)
      .then((next) => {
        if (generation.current !== revision) return;
        setSettings(next);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (generation.current !== revision) return;
        setSettings(null);
        setError(cause);
      });
    return () => {
      // Bumped, not read: leaving this generation behind is what makes a reply
      // to a question the pane no longer remembers asking land nowhere.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current += 1;
    };
  }, [chatSessionId, deviceUdid, laneId, runtimePinRef, visible]);

  const act = useCallback(async (action: AppleDeviceAction) => {
    if (busy.current || !deviceUdid || !visible) return;
    busy.current = true;
    const revision = ++generation.current;
    setPending(true);
    setError(null);
    const target = { deviceUdid, laneId, chatSessionId };
    const pin = runtimePinRef.current;
    try {
      const next = action.type === "setAppearance"
        ? await window.ade.iosSimulator.setAppearance({ ...target, appearance: action.value }, pin)
        : await window.ade.iosSimulator.setContentSize({ ...target, contentSize: action.value }, pin);
      if (generation.current === revision) setSettings(next);
    } catch (cause: unknown) {
      if (generation.current === revision) setError(cause);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }, [chatSessionId, deviceUdid, laneId, runtimePinRef, visible]);

  return {
    settings,
    pending,
    error,
    clearError,
    act,
    disabled: pending || !settings || !visible,
  };
}

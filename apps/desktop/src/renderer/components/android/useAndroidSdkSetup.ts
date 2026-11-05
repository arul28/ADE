import { useCallback, useEffect, useRef, useState } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import type {
  AndroidSdkConsentSurface,
  AndroidSdkInstallState,
  AndroidSdkSetupPlan,
} from "../../../shared/types/androidEmulator";
import { describeAndroidError, type AndroidErrorDescription } from "./androidDeviceState";

/**
 * The setup card's data: the install plan from the lane's machine, the folder
 * and CLI choices, and the install's progress.
 *
 * Progress arrives as `android.sdk.install` events. While an install runs, a
 * state read every few seconds covers a lost event (a relay hiccup); nothing
 * polls while the card is idle.
 */

const RUNNING_STATE_READ_MS = 3_000;

export type AndroidSdkSetup = {
  plan: AndroidSdkSetupPlan | null;
  loading: boolean;
  error: AndroidErrorDescription | null;
  install: AndroidSdkInstallState;
  chosenRoot: string | null;
  includeAndroidCli: boolean;
  /** The last install or "Use mine…" refusal, shown on the card. */
  actionError: AndroidErrorDescription | null;
  starting: boolean;
  setChosenRoot: (root: string | null) => void;
  setIncludeAndroidCli: (on: boolean) => void;
  refresh: () => void;
  startInstall: (acceptedLicenseIds: string[]) => Promise<boolean>;
  cancelInstall: () => void;
  useExistingSdk: (sdkPath: string) => Promise<boolean>;
  clearActionError: () => void;
};

export function useAndroidSdkSetup(
  pin: OpenProjectBinding | null,
  /** Where the person accepts the licences; kept in the consent record. */
  surface: AndroidSdkConsentSurface,
): AndroidSdkSetup {
  const api = window.ade?.androidEmulator ?? null;
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? null;
  const [plan, setPlan] = useState<AndroidSdkSetupPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<AndroidErrorDescription | null>(null);
  const [install, setInstall] = useState<AndroidSdkInstallState>({ state: "idle" });
  const [chosenRoot, setChosenRoot] = useState<string | null>(null);
  const [includeAndroidCli, setIncludeAndroidCli] = useState(false);
  const [actionError, setActionError] = useState<AndroidErrorDescription | null>(null);
  const [starting, setStarting] = useState(false);
  const readSeq = useRef(0);
  const choicesRef = useRef({ chosenRoot, includeAndroidCli });
  choicesRef.current = { chosenRoot, includeAndroidCli };

  const readPlan = useCallback(async () => {
    if (!api) return;
    const seq = ++readSeq.current;
    setLoading(true);
    try {
      const next = await api.getSdkSetupPlan(
        { sdkRoot: choicesRef.current.chosenRoot, includeAndroidCli: choicesRef.current.includeAndroidCli },
        pinRef.current,
      );
      if (seq !== readSeq.current) return;
      setPlan(next);
      setInstall(next.install);
      setError(null);
    } catch (caught) {
      if (seq !== readSeq.current) return;
      setError(describeAndroidError(caught));
    } finally {
      if (seq === readSeq.current) setLoading(false);
    }
  }, [api]);

  // A new machine, a new folder or the CLI box: plan again.
  useEffect(() => {
    void readPlan();
  }, [readPlan, pinKey, chosenRoot, includeAndroidCli]);

  useEffect(() => {
    if (!api) return;
    return api.onEvent((event) => {
      if (event.type !== "android.sdk.install") return;
      setInstall(event.install);
      // A finished, failed or cancelled install changes what is missing.
      if (event.install.state !== "running") void readPlan();
    }, pinRef.current);
  }, [api, pinKey, readPlan]);

  const running = install.state === "running";
  useEffect(() => {
    if (!api || !running) return;
    const timer = window.setInterval(() => {
      void api.getSdkInstallState({}, pinRef.current).then((next) => {
        setInstall(next);
        if (next.state !== "running") void readPlan();
      }).catch(() => {
        // The next event or read answers.
      });
    }, RUNNING_STATE_READ_MS);
    return () => window.clearInterval(timer);
  }, [api, pinKey, running, readPlan]);

  const startInstall = useCallback(async (acceptedLicenseIds: string[]) => {
    if (!api) return false;
    setStarting(true);
    setActionError(null);
    try {
      const next = await api.installSdk(
        { sdkRoot: choicesRef.current.chosenRoot, includeAndroidCli: choicesRef.current.includeAndroidCli, acceptedLicenseIds, surface },
        pinRef.current,
      );
      setInstall(next);
      return true;
    } catch (caught) {
      setActionError(describeAndroidError(caught));
      return false;
    } finally {
      setStarting(false);
    }
  }, [api, surface]);

  const cancelInstall = useCallback(() => {
    if (!api) return;
    void api.cancelSdkInstall({}, pinRef.current).then(setInstall).catch((caught: unknown) => {
      setActionError(describeAndroidError(caught));
    });
  }, [api]);

  const useExistingSdk = useCallback(async (sdkPath: string) => {
    if (!api) return false;
    setActionError(null);
    try {
      await api.setSdkPath({ path: sdkPath }, pinRef.current);
      return true;
    } catch (caught) {
      setActionError(describeAndroidError(caught));
      return false;
    }
  }, [api]);

  return {
    plan,
    loading,
    error,
    install,
    chosenRoot,
    includeAndroidCli,
    actionError,
    starting,
    setChosenRoot,
    setIncludeAndroidCli,
    refresh: () => void readPlan(),
    startInstall,
    cancelInstall,
    useExistingSdk,
    clearActionError: () => setActionError(null),
  };
}

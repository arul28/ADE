import { useEffect, useRef, useState } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";

/**
 * Can the lane's runtime host host a Mac Desktop display?
 *
 * One read per machine, cached for the life of the renderer, and never a
 * poller. The answer is a property of a machine's OS and its driver install —
 * it changes when ADE is updated or a helper is installed, which is a restart
 * either way — so re-asking on an interval would spend an RPC round-trip per
 * tick to learn the same thing.
 *
 * `getStatus` is the one Mac Desktop call that answers on every platform, which
 * is exactly why the capability gate is a read rather than a rejection: a
 * Windows host has to be able to say "no display here" without throwing.
 *
 * Deliberately NOT folded into `useNativeToolSessions`: that hook opens live
 * event subscriptions for three tools, and this needs no subscription at all.
 */

/**
 * The host's answer: whether it can host a display and, when it cannot, its
 * own reason. A driver missing from the install and a Linux host are both
 * "no", and the pane must say which — "isn't a Mac" on a Mac is a lie.
 */
export type MacDesktopSupport = {
  supported: boolean;
  reason: string | null;
  /**
   * The runtime host's platform, from the same `getStatus` read. The Work tool
   * picker uses it to show Windows Desktop in place of Mac Desktop on a
   * Windows host, so it is carried here rather than fetched twice.
   */
  platform: NodeJS.Platform;
};

/**
 * The desktop-tool half of a `WorkToolContext`, from one support read: which
 * lane-screen tool this host has (`hostPlatform`), and whether it can run now.
 * The Work tools pane and the command palette both build theirs here, so they
 * agree about which desktop tool exists.
 */
export function desktopToolContext(support: MacDesktopSupport | null): {
  supportsMacDesktop: boolean | null;
  macDesktopUnsupportedReason: string | null;
  supportsWindowsDesktop: boolean | null;
  windowsDesktopUnsupportedReason: string | null;
  hostPlatform: NodeJS.Platform | null;
} {
  return {
    supportsMacDesktop: support ? support.platform === "darwin" && support.supported : null,
    macDesktopUnsupportedReason: support?.platform === "darwin" ? support.reason : "This lane’s host isn’t a Mac",
    // The same read answers both seats: a Windows host that can host a screen
    // shows Windows Desktop, a Mac host shows Mac Desktop, and only one is
    // available at a time because one platform answers.
    supportsWindowsDesktop: support ? support.platform === "win32" && support.supported : null,
    windowsDesktopUnsupportedReason: support?.platform === "win32" ? support.reason : "This lane's host isn't Windows",
    // Which tools exist on this host at all; `supports*` says whether the ones
    // that exist can run right now.
    hostPlatform: support?.platform ?? null,
  };
}

const cache = new Map<string, MacDesktopSupport>();

/** Test-only reset for the module-level capability cache. */
export function resetMacDesktopSupportCache(): void {
  cache.clear();
}

export function useMacDesktopSupport(args: {
  runtimePin: OpenProjectBinding | null;
  /** The Work route is on screen. Nothing is read otherwise. */
  enabled: boolean;
}): MacDesktopSupport | null {
  // With no pin the call goes to the window's bound project, and one window
  // holds several project tabs on different machines: the answer is cached per
  // binding, or a Mac project's answer would name the tool on a Windows one.
  const boundKey = useAppStore((state) => state.projectBinding?.key ?? "");
  const key = args.runtimePin?.key ?? `bound:${boundKey}`;
  const [supported, setSupported] = useState<MacDesktopSupport | null>(() => cache.get(key) ?? null);
  const pinRef = useRef(args.runtimePin);
  pinRef.current = args.runtimePin;

  useEffect(() => {
    const cached = cache.get(key);
    if (cached !== undefined) {
      setSupported(cached);
      return;
    }
    // A key with no answer yet (a project tab on another machine): the last
    // key's answer is not this one's, so the tools wait for the read.
    setSupported(null);
    if (!args.enabled) return;
    // Optional call, not an assertion. A surface whose `window.ade` predates
    // this namespace — an older packaged shell, a partially stubbed host —
    // must lose the capability answer, not the whole Work pane.
    const api = window.ade?.macDesktop;
    if (!api) return;
    let cancelled = false;
    void api
      .getStatus({}, pinRef.current)
      .then((status) => {
        const answer: MacDesktopSupport = {
          supported: status.supported,
          reason: status.supported ? null : (status.unsupportedReason ?? null),
          platform: status.platform,
        };
        cache.set(key, answer);
        if (!cancelled) setSupported(answer);
      })
      .catch(() => {
        // An unreachable host is not a "no". Leaving it unknown keeps the tool
        // visible, and the panel says what actually went wrong when it is opened.
        if (!cancelled) setSupported(null);
      });
    return () => {
      cancelled = true;
    };
  }, [args.enabled, key]);

  return supported;
}

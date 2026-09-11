import { useEffect, useRef, useState } from "react";
import type {
  AppControlEventPayload,
  AppControlSession,
  BuiltInBrowserEventPayload,
  BuiltInBrowserStatus,
  IosSimulatorEventPayload,
  IosSimulatorSession,
  OpenProjectBinding,
} from "../../../shared/types";
import { workToolAvailability, type WorkToolContext } from "./workTools";

/**
 * The three native tool feeds.
 *
 * The Work tools pane and the floating live-preview card both need to know what
 * the browser, App Control and the simulator are doing — the pane to fill its
 * status lines and activity dots, the card to decide which tool to picture.
 * They used to open the same three subscriptions independently, with two
 * spellings of the capability gate and two definitions of "live".
 *
 * This hook is not the sharing mechanism, it is what gets shared: mount it once
 * and mounting it again opens a second set of subscriptions. `NativeToolFeeds
 * Provider` is the single owner — Work code reads `useNativeToolFeeds()`, never
 * this hook directly.
 *
 * Each feed is one `getStatus` plus one `onEvent` subscription. Nothing here
 * polls, and a tool the capability gate says cannot run here is never asked.
 */

/**
 * Whether the subscription that delivered an event is still the current one.
 *
 * Handed to the extra-handler callbacks so work they kick off asynchronously
 * (a follow-up `getTrace`, say) can be dropped when the feed has since been
 * torn down or re-subscribed — the same `cancelled` flag the effects use, made
 * visible to the consumer instead of duplicated by it.
 */
export type NativeToolFeedScope = { readonly isActive: () => boolean };

/**
 * Whether an App Control session is actually DRIVING an app right now.
 *
 * This used to be "the session has not been stopped", which was true of a
 * launch terminal whose app has not attached yet (`running` with no CDP
 * endpoint) and of one whose app quit out from under us — so the pane painted
 * a green "live" dot beside a context line that read "No app". Attachment is
 * what a green dot claims, so attachment is what it now means: `connected`, or
 * `running` with an endpoint on the other end.
 *
 * The corner card asks a DIFFERENT question ("is this session still around, so
 * should the preview stay up") and answers it in its own source adapter; the
 * two are deliberately not the same rule.
 */
export function isAppControlSessionAttached(session: AppControlSession | null | undefined): boolean {
  if (!session) return false;
  if (session.status === "connected") return true;
  return session.status === "running" && Boolean(session.cdpEndpoint);
}

/**
 * Accept a browser status only if it is actually one.
 *
 * The hosted web client answers `builtInBrowser.getStatus` from a stub that
 * resolves `{ supported: false, available: false, state: "unsupported" }` — no
 * `tabs` — and the adapter casts it into the namespace type, so `tsc` never
 * sees the mismatch. Every consumer here dereferences `status.tabs`, so the
 * payload is checked at the boundary rather than guarded at each of the dozen
 * places that read it.
 */
export function asBuiltInBrowserStatus(value: unknown): BuiltInBrowserStatus | null {
  if (!value || typeof value !== "object") return null;
  return Array.isArray((value as { tabs?: unknown }).tabs) ? (value as BuiltInBrowserStatus) : null;
}

export function useNativeToolSessions(args: {
  /** The surface is on screen. Every feed is torn down when it is not. */
  enabled: boolean;
  /** Capability gate — an unavailable tool is never read from. */
  context: WorkToolContext;
  /** Project root the browser view is collection-scoped to. */
  browserViewRoot: string | null;
  /** Machine the surface is pinned to, or null for this tab's own machine. */
  runtimePin: OpenProjectBinding | null;
  /** True when the pinned machine is not answering; skip every pinned read. */
  offline?: boolean;
  /** Called with the first `getStatus` answer, after it has been accepted. */
  onBrowserStatusSettled?: (status: BuiltInBrowserStatus | null) => void;
  /** Raw feed events, for consumers that need more than the latest status. */
  onBrowserEvent?: (event: BuiltInBrowserEventPayload, scope: NativeToolFeedScope) => void;
  onAppControlEvent?: (event: AppControlEventPayload, scope: NativeToolFeedScope) => void;
  onIosEvent?: (event: IosSimulatorEventPayload, scope: NativeToolFeedScope) => void;
}): {
  browserStatus: BuiltInBrowserStatus | null;
  iosSession: IosSimulatorSession | null;
  appControlSession: AppControlSession | null;
  canBrowser: boolean;
  canIos: boolean;
  canAppControl: boolean;
} {
  const {
    enabled,
    context,
    browserViewRoot,
    runtimePin,
    offline = false,
    onBrowserStatusSettled,
    onBrowserEvent,
    onAppControlEvent,
    onIosEvent,
  } = args;

  const [browserStatus, setBrowserStatus] = useState<BuiltInBrowserStatus | null>(null);
  const [iosSession, setIosSession] = useState<IosSimulatorSession | null>(null);
  const [appControlSession, setAppControlSession] = useState<AppControlSession | null>(null);

  const canBrowser = workToolAvailability("browser", context).available;
  const canIos = workToolAvailability("ios", context).available;
  const canAppControl = workToolAvailability("app-control", context).available;

  const runtimePinKey = runtimePin?.key ?? null;
  const runtimePinRef = useRef(runtimePin);
  runtimePinRef.current = runtimePin;

  // The extra handlers are read through refs so a caller passing an inline
  // closure cannot make the feeds re-subscribe on every render.
  const browserSettledRef = useRef(onBrowserStatusSettled);
  browserSettledRef.current = onBrowserStatusSettled;
  const browserEventRef = useRef(onBrowserEvent);
  browserEventRef.current = onBrowserEvent;
  const appControlEventRef = useRef(onAppControlEvent);
  appControlEventRef.current = onAppControlEvent;
  const iosEventRef = useRef(onIosEvent);
  iosEventRef.current = onIosEvent;

  useEffect(() => {
    if (!enabled || offline || !canBrowser) {
      setBrowserStatus(null);
      return undefined;
    }
    const browser = window.ade?.builtInBrowser;
    if (!browser?.getStatus || !browser.onEvent) return undefined;
    let cancelled = false;
    const scope: NativeToolFeedScope = { isActive: () => !cancelled };
    const projectScope = browserViewRoot ? { projectRoot: browserViewRoot } : {};
    void browser.getStatus(projectScope, runtimePinRef.current)
      .then((status) => {
        if (cancelled) return;
        const next = asBuiltInBrowserStatus(status);
        setBrowserStatus(next);
        browserSettledRef.current?.(next);
      })
      .catch(() => {
        if (!cancelled) setBrowserStatus(null);
      });
    const unsubscribe = browser.onEvent((event) => {
      const next = asBuiltInBrowserStatus((event as { status?: unknown }).status);
      if (next) setBrowserStatus(next);
      browserEventRef.current?.(event, scope);
    }, runtimePinRef.current);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [browserViewRoot, canBrowser, enabled, offline, runtimePinKey]);

  useEffect(() => {
    if (!enabled || offline || !canIos) {
      setIosSession(null);
      return undefined;
    }
    const iosSimulator = window.ade?.iosSimulator;
    if (!iosSimulator?.getStatus || !iosSimulator.onEvent) return undefined;
    let cancelled = false;
    const scope: NativeToolFeedScope = { isActive: () => !cancelled };
    void iosSimulator.getStatus(runtimePinRef.current)
      .then((status) => {
        if (!cancelled) setIosSession(status?.activeSession ?? null);
      })
      .catch(() => {
        if (!cancelled) setIosSession(null);
      });
    const unsubscribe = iosSimulator.onEvent((event) => {
      if (event.type === "session-started" || event.type === "session-updated") {
        setIosSession(event.session ?? null);
      } else if (event.type === "session-released") {
        setIosSession(null);
      }
      iosEventRef.current?.(event, scope);
    }, runtimePinRef.current);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [canIos, enabled, offline, runtimePinKey]);

  useEffect(() => {
    if (!enabled || offline || !canAppControl) {
      setAppControlSession(null);
      return undefined;
    }
    const appControl = window.ade?.appControl;
    if (!appControl?.getStatus || !appControl.onEvent) return undefined;
    let cancelled = false;
    const scope: NativeToolFeedScope = { isActive: () => !cancelled };
    void appControl.getStatus(runtimePinRef.current)
      .then((status) => {
        if (!cancelled) setAppControlSession(status?.activeSession ?? null);
      })
      .catch(() => {
        if (!cancelled) setAppControlSession(null);
      });
    const unsubscribe = appControl.onEvent((event) => {
      if (event.type === "session-started" || event.type === "session-updated") {
        setAppControlSession(event.session ?? null);
      } else if (event.type === "session-stopped") {
        setAppControlSession(null);
      }
      appControlEventRef.current?.(event, scope);
    }, runtimePinRef.current);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [canAppControl, enabled, offline, runtimePinKey]);

  return { browserStatus, iosSession, appControlSession, canBrowser, canIos, canAppControl };
}

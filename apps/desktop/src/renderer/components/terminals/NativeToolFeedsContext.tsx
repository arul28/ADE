import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import type {
  AppControlEventPayload,
  AppControlSession,
  BuiltInBrowserEventPayload,
  BuiltInBrowserStatus,
  IosSimulatorEventPayload,
  IosSimulatorSession,
  OpenProjectBinding,
} from "../../../shared/types";
import { selectActiveProjectRoot, useAppStore } from "../../state/appStore";
import { useMachineEntryForBinding } from "../../state/crossMachineLanes";
import { isMacPlatform } from "../../lib/platform";
import { isWebClientMode } from "../../lib/webClientMode";
import type { WorkToolContext } from "./workTools";
import {
  useNativeToolSessions,
  type NativeToolFeedScope,
} from "./useNativeToolSessions";

/**
 * The one owner of the three native tool feeds.
 *
 * The Work tools pane and the floating live-preview card both need to know what
 * the browser, App Control and the simulator are doing. `useNativeToolSessions`
 * gave them one implementation, but they mounted it once each — six `getStatus`
 * round-trips, six live IPC subscriptions and two copies of the same state, one
 * of which had lost the offline guard the other had. This provider mounts the
 * hook exactly once per Work page and hands the answer down, so the number of
 * subscriptions is a property of the tree rather than of how many consumers
 * happen to be on screen, and `offline` has one value by construction.
 *
 * The extra per-consumer event handlers (`onBrowserEvent` and friends) survive
 * as a fan-out: consumers register a handler set, the provider calls all of them
 * for each event. Registration happens in a LAYOUT effect so a consumer is
 * always subscribed before the provider's own passive effect issues its first
 * `getStatus` — that is what keeps `onBrowserStatusSettled` reaching the card.
 */

export type NativeToolFeedHandlers = {
  /** Called with the first `getStatus` answer, after it has been accepted. */
  onBrowserStatusSettled?: (status: BuiltInBrowserStatus | null) => void;
  onBrowserEvent?: (event: BuiltInBrowserEventPayload, scope: NativeToolFeedScope) => void;
  onAppControlEvent?: (event: AppControlEventPayload, scope: NativeToolFeedScope) => void;
  onIosEvent?: (event: IosSimulatorEventPayload, scope: NativeToolFeedScope) => void;
};

export type NativeToolFeeds = {
  browserStatus: BuiltInBrowserStatus | null;
  iosSession: IosSimulatorSession | null;
  appControlSession: AppControlSession | null;
  canBrowser: boolean;
  canIos: boolean;
  canAppControl: boolean;
  /** Capability gate the feeds were opened under; shared so it cannot diverge. */
  context: WorkToolContext;
  /** Project root the browser view is collection-scoped to. */
  browserViewRoot: string | null;
  /** The pinned machine is not answering; every pinned read is skipped. */
  offline: boolean;
  /** Machine the surface is pinned to, or null for this tab's own machine. */
  pinnedMachineId: string | null;
};

type HandlerRegistry = {
  register: (handlers: { readonly current: NativeToolFeedHandlers }) => () => void;
};

const NativeToolFeedsContext = createContext<NativeToolFeeds | null>(null);
const NativeToolFeedHandlerContext = createContext<HandlerRegistry | null>(null);

/**
 * The feeds, or an explicit failure.
 *
 * Throwing rather than falling back to a private subscription set is the point:
 * a silent fallback is exactly how the two divergent copies appeared.
 */
export function useNativeToolFeeds(): NativeToolFeeds {
  const feeds = useContext(NativeToolFeedsContext);
  if (!feeds) {
    throw new Error("useNativeToolFeeds must be used inside <NativeToolFeedsProvider>");
  }
  return feeds;
}

/**
 * Add this consumer's handlers to the provider's fan-out.
 *
 * The handler object is read through a ref, so a caller passing inline closures
 * cannot make the registration churn — the same rule the hook already applied
 * to its own callback props.
 */
export function useNativeToolFeedHandlers(handlers: NativeToolFeedHandlers): void {
  const registry = useContext(NativeToolFeedHandlerContext);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  useLayoutEffect(() => registry?.register(handlersRef), [registry]);
}

export function NativeToolFeedsProvider({
  active,
  runtimePin,
  children,
}: {
  /** The Work route is on screen. Every feed is torn down when it is not. */
  active: boolean;
  /** Machine the active Work session runs on, or null for this tab's own. */
  runtimePin: OpenProjectBinding | null;
  children: ReactNode;
}) {
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const isRemoteProject = useAppStore((state) => state.projectBinding?.kind === "remote");
  const pinnedMachine = useMachineEntryForBinding(runtimePin);

  // Capability flags, never a platform sniff: the hosted web client renders
  // these same components with stubbed native namespaces.
  const context = useMemo<WorkToolContext>(() => ({
    isRemoteProject,
    supportsIosSimulator: isMacPlatform(),
    isWebClient: isWebClientMode(),
  }), [isRemoteProject]);

  // The browser view is owned by THIS window's main process. A pin on another
  // checkout of this computer still drives that view, just under the pinned
  // checkout's tab collection.
  const browserViewRoot = runtimePin?.kind === "local" ? runtimePin.rootPath : projectRoot;
  // Pinned calls have no local fallback, so a machine that is not answering is
  // never read from — by either consumer, because there is only one value.
  const offline = Boolean(runtimePin) && pinnedMachine?.online === false;

  const subscribersRef = useRef<Set<{ readonly current: NativeToolFeedHandlers }>>(new Set());
  const registry = useMemo<HandlerRegistry>(() => ({
    register(handlers) {
      subscribersRef.current.add(handlers);
      return () => {
        subscribersRef.current.delete(handlers);
      };
    },
  }), []);

  const onBrowserStatusSettled = useCallback((status: BuiltInBrowserStatus | null) => {
    for (const subscriber of subscribersRef.current) subscriber.current.onBrowserStatusSettled?.(status);
  }, []);
  const onBrowserEvent = useCallback((event: BuiltInBrowserEventPayload, scope: NativeToolFeedScope) => {
    for (const subscriber of subscribersRef.current) subscriber.current.onBrowserEvent?.(event, scope);
  }, []);
  const onAppControlEvent = useCallback((event: AppControlEventPayload, scope: NativeToolFeedScope) => {
    for (const subscriber of subscribersRef.current) subscriber.current.onAppControlEvent?.(event, scope);
  }, []);
  const onIosEvent = useCallback((event: IosSimulatorEventPayload, scope: NativeToolFeedScope) => {
    for (const subscriber of subscribersRef.current) subscriber.current.onIosEvent?.(event, scope);
  }, []);

  const {
    browserStatus,
    iosSession,
    appControlSession,
    canBrowser,
    canIos,
    canAppControl,
  } = useNativeToolSessions({
    enabled: active,
    context,
    browserViewRoot,
    runtimePin,
    offline,
    onBrowserStatusSettled,
    onBrowserEvent,
    onAppControlEvent,
    onIosEvent,
  });

  const pinnedMachineId = pinnedMachine?.machineId ?? null;
  // Memoized field by field, not by spreading the hook's return: the hook hands
  // back a fresh object literal every render, and a context value whose identity
  // changes on every parent render re-renders both consumers for nothing.
  const value = useMemo<NativeToolFeeds>(() => ({
    browserStatus,
    iosSession,
    appControlSession,
    canBrowser,
    canIos,
    canAppControl,
    context,
    browserViewRoot,
    offline,
    pinnedMachineId,
  }), [
    appControlSession,
    browserStatus,
    browserViewRoot,
    canAppControl,
    canBrowser,
    canIos,
    context,
    iosSession,
    offline,
    pinnedMachineId,
  ]);

  return (
    <NativeToolFeedHandlerContext.Provider value={registry}>
      <NativeToolFeedsContext.Provider value={value}>
        {children}
      </NativeToolFeedsContext.Provider>
    </NativeToolFeedHandlerContext.Provider>
  );
}

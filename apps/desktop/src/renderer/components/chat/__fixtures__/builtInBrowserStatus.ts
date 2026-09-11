import type {
  BuiltInBrowserStatus,
  BuiltInBrowserTab,
} from "../../../../shared/types/builtInBrowser";

/**
 * One typed `BuiltInBrowserStatus` for every test that needs one.
 *
 * Three suites each carried their own bare object literal with a different
 * subset of the fields, so none of them failed to compile when the IPC contract
 * grew — which is the entire job of the type. These builders are annotated, so
 * a new required field breaks the fixture (one place) instead of silently
 * teaching three tests a shape the main process no longer sends.
 */

export function makeBuiltInBrowserTab(
  overrides: Partial<BuiltInBrowserTab> = {},
): BuiltInBrowserTab {
  return {
    id: "tab-1",
    url: "https://example.test/",
    title: "Example",
    isLaunchpad: false,
    faviconUrl: null,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    ownerLaneId: null,
    ownerChatSessionId: null,
    ownerClaimedAt: null,
    ownerLeaseExpiresAt: null,
    zoomFactor: 1,
    devToolsOpen: false,
    emulation: null,
    networkLogging: false,
    recording: null,
    handoff: null,
    ...overrides,
  };
}

export function makeBuiltInBrowserStatus(
  overrides: Partial<BuiltInBrowserStatus> = {},
): BuiltInBrowserStatus {
  return {
    attached: true,
    partition: "persist:ade-browser",
    storageProfileKey: "global",
    collectionKey: "default",
    collectionProjectRoot: null,
    persistentProfile: true,
    visible: true,
    bounds: { x: 10, y: 20, width: 640, height: 360 },
    activeTabId: "tab-1",
    tabs: [makeBuiltInBrowserTab()],
    url: "https://example.test/",
    title: "Example",
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    isInspecting: false,
    hasSelection: false,
    ownerLaneId: null,
    ownerChatSessionId: null,
    ownerClaimedAt: null,
    ownerLeaseExpiresAt: null,
    ...overrides,
  };
}

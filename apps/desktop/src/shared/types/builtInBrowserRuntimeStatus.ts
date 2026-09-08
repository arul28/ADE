/**
 * The read-only browser snapshot the runtime daemon itself may read.
 *
 * Every other desktop-bridge method requires a per-chat actor capability, minted
 * by Electron for one agent. The daemon holds none: its Work-tools aggregator is
 * not an agent, it is the process that renders the Tools pane for iOS and the
 * hosted web client. Rather than mint a service-wide capability (which would be
 * a token that can drive the browser), the bridge serves this one deliberately
 * narrow shape under bridge authentication alone.
 *
 * What is here is what the Tools pane shows: which tabs exist, who owns them,
 * and whether one is recording or handed off. What is NOT here is everything the
 * capability protects — no cookies, no observation bytes, no network log, no
 * screenshot, no page content, and no way to act on a tab.
 */
export type BuiltInBrowserRuntimeTabStatus = {
  id: string;
  url: string | null;
  title: string | null;
  ownerLaneId: string | null;
  ownerChatSessionId: string | null;
  /** Booleanized: the recording's file path and frame buffer stay in Electron. */
  recording: boolean;
  handoff: {
    reason: string | null;
    previousOwner: {
      laneId: string | null;
      chatSessionId: string | null;
    };
  } | null;
};

export type BuiltInBrowserRuntimeStatus = {
  activeTabId: string | null;
  tabs: BuiltInBrowserRuntimeTabStatus[];
};

/** Bridge method name for {@link BuiltInBrowserRuntimeStatus}. */
export const BUILT_IN_BROWSER_RUNTIME_STATUS_METHOD = "getStatusForRuntime";

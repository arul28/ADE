import { describe, expect, it } from "vitest";
import { unsupportedBuiltInBrowserStatus } from "../misc";

/**
 * The hosted web client treats the browser as a read-only Work tool, so both
 * the tools pane and the live corner card call `getStatus` there and then read
 * `status.tabs`. A `{ supported: false }` object with no `tabs` crashed the
 * whole Work tab on render — and the adapter's `as unknown as` cast meant tsc
 * had nothing to say about it. The shape is the contract; assert it.
 */
describe("unsupportedBuiltInBrowserStatus", () => {
  it("says it is unsupported without lying about the shape", () => {
    const status = unsupportedBuiltInBrowserStatus();
    expect(status.supported).toBe(false);
    expect(status.available).toBe(false);
    expect(status.state).toBe("unsupported");
  });

  it("carries an empty tab list, so a consumer can dereference it", () => {
    const status = unsupportedBuiltInBrowserStatus();
    expect(Array.isArray(status.tabs)).toBe(true);
    expect(status.tabs).toHaveLength(0);
    // The two dereferences that crashed: the corner card's and the tools pane's.
    expect(status.tabs[0]?.id).toBeUndefined();
    expect(status.tabs.find(() => true)).toBeUndefined();
  });

  it("describes an empty browser rather than omitting the fields", () => {
    const status = unsupportedBuiltInBrowserStatus();
    expect(status).toMatchObject({
      attached: false,
      visible: false,
      activeTabId: null,
      url: null,
      title: null,
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      isInspecting: false,
      hasSelection: false,
      ownerLaneId: null,
      ownerChatSessionId: null,
    });
  });
});

/**
 * The panel's wire readers, tested without a browser view.
 *
 * These bodies used to sit inside a 4,500-line component, so the only way to
 * exercise "an older main process omitted `tabs`" was to render the whole pane
 * against a mocked namespace. The interesting cases are all about ABSENCE:
 * every one below is a payload a real main process has sent at some point.
 */
import { describe, expect, it } from "vitest";
import {
  booleanField,
  browserEventMatchesProject,
  errorMessage,
  frameLabel,
  isRecord,
  normalizeContextItem,
  normalizeFrame,
  normalizeScreenshot,
  normalizeStatus,
  normalizeTab,
  normalizeTabHandoff,
  normalizeUrlForNavigation,
  numberField,
  stringField,
  stripDataUrlPrefix,
} from "./browserPanelNormalizers";
import type { BuiltInBrowserStatus } from "./browserPanelTypes";

function status(partial: Partial<BuiltInBrowserStatus> = {}): BuiltInBrowserStatus {
  return {
    supported: true,
    visible: true,
    activeTabId: "tab-1",
    tabs: [],
    url: "https://example.test/",
    title: "Example",
    canGoBack: false,
    canGoForward: false,
    loading: false,
    inspecting: false,
    selectedItem: null,
    ...partial,
  };
}

describe("field readers", () => {
  it("treats blank strings as absent, which is what an unset field looks like on the wire", () => {
    expect(stringField("  ")).toBeNull();
    expect(stringField("")).toBeNull();
    expect(stringField(0)).toBeNull();
    expect(stringField("ok")).toBe("ok");
  });

  it("keeps a non-boolean from silently reading as false", () => {
    expect(booleanField(undefined, true)).toBe(true);
    expect(booleanField("true", true)).toBe(true);
    expect(booleanField(false, true)).toBe(false);
  });

  it("rejects the numbers that are not numbers", () => {
    expect(numberField(Number.NaN)).toBeNull();
    expect(numberField(Number.POSITIVE_INFINITY)).toBeNull();
    expect(numberField("12")).toBeNull();
    expect(numberField(0)).toBe(0);
  });

  it("does not call an array a record", () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord({})).toBe(true);
  });

  it("says what an error said, whatever kind of thing was thrown", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("boom")).toBe("boom");
  });

  it("strips only the data-URL preamble, and tolerates a bare payload", () => {
    expect(stripDataUrlPrefix("data:image/png;base64,AAA")).toBe("AAA");
    expect(stripDataUrlPrefix("AAA")).toBe("AAA");
  });
});

describe("normalizeUrlForNavigation", () => {
  it("refuses the schemes the built-in browser cannot open", () => {
    for (const url of ["about:blank", "file:///etc/passwd", "devtools://x", "data:text/html,x"]) {
      expect(normalizeUrlForNavigation(url).ok).toBe(false);
    }
  });

  it("searches for typed words rather than doing nothing", () => {
    const result = normalizeUrlForNavigation("how to center a div");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url).not.toBe("how to center a div");
  });

  it("passes an http(s) URL through", () => {
    const result = normalizeUrlForNavigation("https://example.test/a");
    expect(result).toEqual({ ok: true, url: "https://example.test/a" });
  });
});

describe("normalizeStatus", () => {
  it("keeps the previous status when the payload is not one at all", () => {
    const previous = status({ url: "https://kept.test/" });
    expect(normalizeStatus(undefined, previous).url).toBe("https://kept.test/");
    expect(normalizeStatus("nope", previous).tabs).toEqual([]);
  });

  it("treats an omitted `tabs` as silence, not as a claim that they closed", () => {
    const previous = normalizeStatus(
      { tabs: [{ id: "tab-1", url: "https://a.test/" }], activeTabId: "tab-1" },
      null,
    );
    expect(previous.tabs).toHaveLength(1);
    const next = normalizeStatus({ loading: true }, previous);
    expect(next.tabs).toHaveLength(1);
  });

  it("clears the omnibox when the payload really does say zero tabs", () => {
    const previous = normalizeStatus(
      { tabs: [{ id: "tab-1", url: "https://a.test/" }], activeTabId: "tab-1" },
      null,
    );
    const next = normalizeStatus({ tabs: [] }, previous);
    expect(next.tabs).toEqual([]);
    expect(next.activeTabId).toBeNull();
    expect(next.url).toBeNull();
    expect(next.canGoBack).toBe(false);
  });

  it("falls back to the first tab when the payload names no active one", () => {
    const next = normalizeStatus({ tabs: [{ id: "tab-9", url: "https://a.test/" }] }, null);
    expect(next.activeTabId).toBe("tab-9");
  });
});

describe("normalizeTab", () => {
  it("needs an id and nothing else", () => {
    expect(normalizeTab({ url: "https://a.test/" })).toBeNull();
    expect(normalizeTab({ id: "tab-1" })?.id).toBe("tab-1");
  });

  it("defaults a missing zoom to 1 rather than 0", () => {
    expect(normalizeTab({ id: "tab-1" })?.zoomFactor).toBe(1);
    expect(normalizeTab({ id: "tab-1", zoomFactor: 1.5 })?.zoomFactor).toBe(1.5);
  });
});

describe("normalizeTabHandoff", () => {
  it("is null without both a reason and a start time", () => {
    expect(normalizeTabHandoff({ reason: "login" })).toBeNull();
    expect(normalizeTabHandoff({ startedAt: "2026-01-01T00:00:00Z" })).toBeNull();
    expect(normalizeTabHandoff(undefined)).toBeNull();
  });

  it("falls back to the start time when no expiry was sent", () => {
    const handoff = normalizeTabHandoff({ reason: "login", startedAt: "2026-01-01T00:00:00Z" });
    expect(handoff?.expiresAt).toBe("2026-01-01T00:00:00Z");
    expect(handoff?.previousOwner).toEqual({ laneId: null, chatSessionId: null });
  });
});

describe("normalizeContextItem / normalizeScreenshot / normalizeFrame", () => {
  it("reads a frame only when every side is a real number", () => {
    expect(normalizeFrame({ x: 1, y: 2, width: 3, height: 4 })).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(normalizeFrame({ x: 1, y: 2, width: 3 })).toBeNull();
    expect(normalizeFrame(null)).toBeNull();
  });

  it("borrows the tab's URL for an item that did not carry one", () => {
    const item = normalizeContextItem({ id: "el-1", selector: "#a" }, status());
    expect(item?.url).toBe("https://example.test/");
  });

  it("is null for a payload that is not a record at all", () => {
    expect(normalizeContextItem(undefined, status())).toBeNull();
    expect(normalizeContextItem("selection", status())).toBeNull();
    expect(normalizeScreenshot(undefined, status())).toBeNull();
  });

  it("gives an item a kind and a timestamp even when the payload carried neither", () => {
    const item = normalizeContextItem({ id: "el-1" }, status());
    expect(item?.kind).toBe("built_in_browser_element");
    expect(typeof item?.selectedAt).toBe("string");
  });

  it("labels a frame in whole pixels", () => {
    expect(frameLabel({ x: 1.4, y: 2.6, width: 30.2, height: 40.8 })).toBe("1, 3 · 30×41");
    expect(frameLabel(null)).toBeNull();
  });
});

describe("browserEventMatchesProject", () => {
  it("accepts an event that names no collection at all — an older main process", () => {
    expect(browserEventMatchesProject({ type: "status" }, "/repo")).toBe(true);
  });

  it("matches a null collection only against the personal-chat scope", () => {
    expect(browserEventMatchesProject({ collectionProjectRoot: null }, null)).toBe(true);
    expect(browserEventMatchesProject({ collectionProjectRoot: null }, "/repo")).toBe(false);
  });

  it("reads the collection out of a nested status when the event does not carry one", () => {
    expect(browserEventMatchesProject({ status: { collectionProjectRoot: "/repo" } }, "/repo")).toBe(true);
    expect(browserEventMatchesProject({ status: { collectionProjectRoot: "/other" } }, "/repo")).toBe(false);
  });
});

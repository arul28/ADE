import { describe, expect, it, vi } from "vitest";

import { applyPluginActionAuthSession } from "./pluginActionAuthSession";

const openExternalUrl = vi.hoisted(() => vi.fn());
const showToast = vi.hoisted(() => vi.fn());

vi.mock("../../lib/openExternal", () => ({
  openExternalUrl: (url: string) => openExternalUrl(url),
  navigateToAppTarget: () => {},
}));

vi.mock("../app/toast/toastStore", () => ({ showToast }));

vi.mock("../../state/appStore", () => ({
  rootAppStoreApi: {
    getState: () => ({
      installedPlugins: [{ pluginId: "ade-linear", displayName: "Linear" }],
    }),
  },
}));

/**
 * The desktop half of the `{authSession}` verb.
 *
 * Every other piece of this seam already existed — the manifest declaration,
 * the host's session table, the stamped presentation, the phone's in-app
 * session — and the desktop read none of it. So a Connect button did nothing on
 * the one machine whose loopback listener the flow redirects to.
 */

/** A presentation shaped the way `stampAuthSessionResult` writes one. */
function stamped(overrides: Record<string, unknown> = {}) {
  return {
    authSession: {
      sessionId: "linear",
      url: "https://linear.app/oauth/authorize?client_id=abc&state=xyz",
      transport: "loopback",
      ...overrides,
    },
  };
}

describe("applyPluginActionAuthSession", () => {
  it("opens the URL the HOST stamped, through the same door openUrl uses", () => {
    openExternalUrl.mockClear();
    showToast.mockClear();

    expect(applyPluginActionAuthSession(
      stamped(),
      { pluginId: "ade-linear", actionId: "connect" },
    )).toBe(true);
    expect(openExternalUrl).toHaveBeenCalledWith(
      "https://linear.app/oauth/authorize?client_id=abc&state=xyz",
    );
    expect(showToast).not.toHaveBeenCalled();
  });

  it("opens an app-transport flow too, which the phone is the one to refuse", () => {
    // The transports differ by which callback the machine can catch, and this
    // machine can catch both: its own loopback listener, and ADE's own scheme.
    openExternalUrl.mockClear();
    expect(applyPluginActionAuthSession(
      stamped({ transport: "app", callbackScheme: "ade" }),
      { pluginId: "ade-linear", actionId: "connect" },
    )).toBe(true);
    expect(openExternalUrl).toHaveBeenCalledTimes(1);
  });

  it("says so when the host dropped the flow, rather than doing nothing", () => {
    // The host REMOVES an `authSession` naming no live flow. To the reader that
    // is a Connect button that appears broken, so the refusal is spoken.
    openExternalUrl.mockClear();
    showToast.mockClear();

    expect(applyPluginActionAuthSession(
      { authSession: { sessionId: "linear" } },
      { pluginId: "ade-linear", actionId: "connect" },
    )).toBe(false);
    expect(openExternalUrl).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledTimes(1);
    const toast = showToast.mock.calls[0]?.[0] as { title: string; tone: string };
    expect(toast.tone).toBe("error");
    expect(toast.title).toContain("Linear");
  });

  it("refuses a URL that is not https, whoever wrote it", () => {
    openExternalUrl.mockClear();
    showToast.mockClear();
    for (const url of ["http://linear.app/oauth", "javascript:alert(1)", "file:///etc/passwd"]) {
      expect(applyPluginActionAuthSession(
        stamped({ url }),
        { pluginId: "ade-linear", actionId: "connect" },
      )).toBe(false);
    }
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("refuses a transport this build does not know", () => {
    openExternalUrl.mockClear();
    expect(applyPluginActionAuthSession(
      stamped({ transport: "carrier-pigeon" }),
      { pluginId: "ade-linear", actionId: "connect" },
    )).toBe(false);
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("stays silent for a result that asked for no sign-in at all", () => {
    openExternalUrl.mockClear();
    showToast.mockClear();
    expect(applyPluginActionAuthSession(
      { message: "Saved." },
      { pluginId: "ade-linear", actionId: "logIt" },
    )).toBe(false);
    expect(showToast).not.toHaveBeenCalled();
  });
});

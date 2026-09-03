/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { parsePluginContributionPayload } from "../../../../shared/plugins/sockets";
import {
  PLUGIN_WEBVIEW_RESIZE_CHANNEL,
  pluginWebviewGuestKey,
  type PluginWebviewUiRequest,
} from "../../../../shared/plugins/webviewBridge";
import type { LaneLinearIssue } from "../../../../shared/types/lanes";
import { rootAppStoreApi } from "../../../state/appStore";
import { PluginDialogSections } from "./PluginDialogSections";
import { handlePluginWebviewUiRequest } from "./pluginWebviewRelay";
import { resetPluginWebviewDialogHandlers } from "./pluginWebviewDialogStore";

/**
 * The `dialog-picker` placement: a plugin's own page inside one of ADE's
 * dialogs, and the one verb that answers the form it is sitting in.
 *
 * This is the gap the Linear acceptance walk named G12. The Create-lane issue
 * chooser and the Create-PR issue reference are PICKERS — a search box over a
 * live list — which is the one thing a vocabulary panel cannot be, so the
 * section that replaces them has to be able to draw a page and the page has to
 * be able to hand back what the reader chose.
 *
 * Its own file rather than an addition to `PluginDialogSections.test.tsx` for
 * the reason that file's sibling states: the contribution stores are
 * module-level and load once per surface, so a fixture that has to differ gets
 * its own file.
 */

vi.mock("../../../lib/pluginRuntimeBridge", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  pluginWebviewRelayBridge: () => null,
}));

const { webClientMode } = vi.hoisted(() => ({ webClientMode: { web: false } }));
vi.mock("../../../lib/webClientMode", () => ({ isWebClientMode: () => webClientMode.web }));

vi.mock("../PluginPanelHost", () => ({
  PluginPanelHost: ({ pluginId, panelId }: { pluginId: string; panelId: string }) => (
    <div data-testid={`panel-${panelId}`}>{`${pluginId}:${panelId}`}</div>
  ),
}));

const GUEST_WEB_CONTENTS_ID = 42;

beforeAll(() => {
  (window as unknown as { ade: unknown }).ade = {
    plugins: {
      list: async () => [
        {
          pluginId: "issues",
          displayName: "Issues",
          enabled: true,
          accent: null,
          icon: null,
          disabledContributions: [],
        },
      ],
      getManifest: async () => ({
        name: "issues",
        version: "1.0.0",
        sockets: [
          // The upgraded section: the same required `panelId`, plus the page.
          {
            socket: "dialog-section",
            surface: "lanes",
            id: "on-create",
            dialog: "create-lane",
            label: "Pick an issue",
            panelId: "picker",
            webviewSurfaceId: "picker-page",
          },
          // The ordinary one, on the other dialog: a panel and nothing else.
          {
            socket: "dialog-section",
            surface: "lanes",
            id: "on-manage",
            dialog: "manage-lane",
            label: "Move this lane",
            panelId: "picker",
          },
        ],
      }),
      listContributions: async () => [],
      invoke: async () => ({}),
      readPanel: async () => null,
    },
  };
});

afterAll(() => {
  delete (window as unknown as { ade?: unknown }).ade;
});

beforeEach(() => {
  webClientMode.web = false;
  resetPluginWebviewDialogHandlers();
  rootAppStoreApi.setState({
    installedPlugins: [
      {
        pluginId: "issues",
        displayName: "Issues",
        version: "1.0.0",
        enabled: true,
        icon: "puzzle",
        accent: "#fff",
        status: "running",
        tabs: [
          {
            id: "picker-page",
            title: "Pick an issue",
            kind: "webview",
            panelId: "picker",
            entryHtml: "dist/index.html",
          },
        ],
        theme: null,
      },
    ],
  } as never);
});

afterEach(() => cleanup());

/** The dialog-section payload keeps the page name beside the panel it upgrades. */
describe("parsePluginContributionPayload", () => {
  it("keeps a webviewSurfaceId on a dialog section", () => {
    expect(parsePluginContributionPayload("dialog-section", {
      dialog: "create-lane",
      panelId: "picker",
      webviewSurfaceId: "picker-page",
    })).toMatchObject({ dialog: "create-lane", panelId: "picker", webviewSurfaceId: "picker-page" });
  });

  it("still requires the panel, whatever page is named", () => {
    expect(parsePluginContributionPayload("dialog-section", {
      dialog: "create-lane",
      webviewSurfaceId: "picker-page",
    })).toBeNull();
  });
});

/** Render the create-lane sections and hand the guest a webContents id. */
async function renderPicker(options: {
  onSelectIssue?: (issue: LaneLinearIssue | null) => boolean;
} = {}) {
  const view = render(
    <PluginDialogSections
      dialog="create-lane"
      onSetField={() => true}
      {...(options.onSelectIssue ? { onSelectIssue: options.onSelectIssue } : {})}
    />,
  );
  await waitFor(() => expect(view.container.querySelector("webview")).toBeTruthy());
  const guest = view.container.querySelector("webview") as HTMLElement & {
    getWebContentsId?: () => number;
  };
  return { view, guest };
}

/**
 * `dom-ready` is what gives a guest its id, and jsdom raises neither the event
 * nor the id — so the test plays the part of Chromium: it stamps the id the
 * host reads and fires the event the host listens for.
 */
function attach(guest: HTMLElement & { getWebContentsId?: () => number }): string {
  guest.getWebContentsId = () => GUEST_WEB_CONTENTS_ID;
  act(() => {
    guest.dispatchEvent(new Event("dom-ready"));
  });
  return pluginWebviewGuestKey(GUEST_WEB_CONTENTS_ID);
}

function submitRequest(guestKey: string, args: Record<string, unknown>): PluginWebviewUiRequest {
  return {
    requestId: "req-1",
    guestKey,
    pluginId: "issues",
    surfaceId: "picker-page",
    placement: "dialog-picker",
    verb: "dialog.submit",
    args,
  };
}

describe("PluginDialogSections with a page", () => {
  it("draws the declared page instead of the panel", async () => {
    const { view } = await renderPicker();
    expect(view.container.querySelectorAll("webview")).toHaveLength(1);
    expect(view.queryByTestId("panel-picker")).toBeNull();
    expect(view.container.querySelector("[data-plugin-webview-placement]")?.getAttribute(
      "data-plugin-webview-placement",
    )).toBe("dialog-picker");
  });

  it("falls back to the panel on a client with no page host", async () => {
    webClientMode.web = true;
    const view = render(<PluginDialogSections dialog="create-lane" onSetField={() => true} />);
    await waitFor(() => expect(view.getByTestId("panel-picker")).toBeTruthy());
    expect(view.container.querySelectorAll("webview")).toHaveLength(0);
  });

  it("grows to the height the page reports and no further", async () => {
    const { view, guest } = await renderPicker();
    const box = guest.closest("section")?.querySelector("div[style*='height']") as HTMLElement;
    const resize = (height: number) => {
      const event = new Event("ipc-message") as Event & { channel?: string; args?: unknown[] };
      event.channel = PLUGIN_WEBVIEW_RESIZE_CHANNEL;
      event.args = [{ height }];
      act(() => {
        guest.dispatchEvent(event);
      });
    };
    resize(380);
    expect(box.style.height).toBe("380px");
    // The bridge's own ceiling, not a second one this host invented.
    resize(99_000);
    expect(box.style.height).toBe("2000px");
    expect(view.container.querySelectorAll("webview")).toHaveLength(1);
  });
});

describe("dialog.submit", () => {
  it("hands the chosen issue to the dialog's own issue state", async () => {
    const chosen: (LaneLinearIssue | null)[] = [];
    const { guest } = await renderPicker({
      onSelectIssue: (issue) => {
        chosen.push(issue);
        return true;
      },
    });
    const guestKey = attach(guest);
    const answer = await handlePluginWebviewUiRequest(submitRequest(guestKey, {
      answer: {
        issue: {
          provider: "linear",
          issueId: "uuid-1",
          identifier: "ADE-148",
          title: "Plugin page tier",
          url: "https://linear.app/ade/issue/ADE-148",
        },
      },
    }));
    expect(answer).toEqual({ ok: true });
    expect(chosen).toHaveLength(1);
    // The five facts the page sent, in the shape the dialog already derives its
    // lane name, its branch and its PR reference from.
    expect(chosen[0]).toMatchObject({
      id: "uuid-1",
      identifier: "ADE-148",
      title: "Plugin page tier",
      url: "https://linear.app/ade/issue/ADE-148",
    });
  });

  it("accepts the flattened envelope as well as the wrapped one", async () => {
    const chosen: (LaneLinearIssue | null)[] = [];
    const { guest } = await renderPicker({
      onSelectIssue: (issue) => {
        chosen.push(issue);
        return true;
      },
    });
    const guestKey = attach(guest);
    const answer = await handlePluginWebviewUiRequest(submitRequest(guestKey, {
      issue: { provider: "linear", issueId: "uuid-2", identifier: "ADE-2", title: "Second" },
    }));
    expect(answer).toEqual({ ok: true });
    expect(chosen[0]).toMatchObject({ identifier: "ADE-2" });
  });

  it("clears the selection on a null issue", async () => {
    const chosen: (LaneLinearIssue | null)[] = [];
    const { guest } = await renderPicker({
      onSelectIssue: (issue) => {
        chosen.push(issue);
        return true;
      },
    });
    const guestKey = attach(guest);
    expect(await handlePluginWebviewUiRequest(submitRequest(guestKey, { answer: { issue: null } })))
      .toEqual({ ok: true });
    expect(chosen).toEqual([null]);
  });

  it("refuses an issue the dialog turned down, and says so", async () => {
    const { guest } = await renderPicker({ onSelectIssue: () => false });
    const guestKey = attach(guest);
    const answer = await handlePluginWebviewUiRequest(submitRequest(guestKey, {
      answer: { issue: { provider: "linear", issueId: "u", identifier: "ADE-3", title: "Third" } },
    }));
    expect(answer.ok).toBe(false);
  });

  it("refuses an issue with no key or title rather than half-filling the form", async () => {
    const chosen: (LaneLinearIssue | null)[] = [];
    const { guest } = await renderPicker({
      onSelectIssue: (issue) => {
        chosen.push(issue);
        return true;
      },
    });
    const guestKey = attach(guest);
    const answer = await handlePluginWebviewUiRequest(submitRequest(guestKey, {
      answer: { issue: { provider: "linear", issueId: "u", identifier: "", title: "" } },
    }));
    expect(answer.ok).toBe(false);
    expect(chosen).toHaveLength(0);
  });

  it("answers a guest no dialog is listening on, never dropping it", async () => {
    const answer = await handlePluginWebviewUiRequest(submitRequest("guest-999", {
      answer: { issue: { provider: "linear", issueId: "u", identifier: "ADE-4", title: "Fourth" } },
    }));
    expect(answer).toEqual({
      ok: false,
      message: "There is no dialog on screen to fill in.",
    });
  });

  it("drops its registration when the guest goes", async () => {
    const { view, guest } = await renderPicker({ onSelectIssue: () => true });
    const guestKey = attach(guest);
    cleanup();
    void view;
    const answer = await handlePluginWebviewUiRequest(submitRequest(guestKey, {
      answer: { issue: { provider: "linear", issueId: "u", identifier: "ADE-5", title: "Fifth" } },
    }));
    expect(answer.ok).toBe(false);
  });
});

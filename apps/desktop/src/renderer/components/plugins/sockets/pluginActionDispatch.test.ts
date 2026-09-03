import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PluginSocketSource } from "./contributionBridge";
import type { PluginContributionRow } from "./contributionBridge";
import type { PluginSurfaceContext } from "../../../../shared/plugins/context";

/**
 * The wiring between a plugin's answer and the place it opens.
 *
 * `pluginNavigateTarget.test.ts` pins the RULE; this pins that the dispatcher
 * reads the live facts off the same caches the UI draws from, and that each of
 * the three outcomes reaches the right host seam — the Work rail reveal, the
 * ordinary navigation target, or a toast that says why neither happened.
 */

const stores = {
  sources: [] as PluginSocketSource[],
  rows: [] as PluginContributionRow[],
};
const registry = { plugins: [] as unknown[], loaded: true };

const navigateToAppTarget = vi.fn();
const revealPluginWorkRailPane = vi.fn();
const openExternalUrl = vi.fn();
const showToast = vi.fn();
const invokePluginSocketAction = vi.fn();

vi.mock("./contributionBridge", async () => {
  const actual = await vi.importActual<typeof import("./contributionBridge")>("./contributionBridge");
  return {
    ...actual,
    invokePluginSocketAction: (...args: unknown[]) => invokePluginSocketAction(...args),
  };
});

vi.mock("./contributionStores", async () => {
  const actual = await vi.importActual<typeof import("./contributionStores")>("./contributionStores");
  return {
    ...actual,
    sourcesStore: { getSnapshot: () => ({ status: "ready", sources: stores.sources }) },
    rowsStoreFor: () => ({ getSnapshot: () => ({ status: "ready", rows: stores.rows }) }),
  };
});

vi.mock("../../../state/appStore", () => ({
  rootAppStoreApi: {
    getState: () => ({ installedPlugins: registry.plugins, pluginsLoaded: registry.loaded }),
  },
}));

vi.mock("../../../lib/openExternal", () => ({
  navigateToAppTarget,
  revealPluginWorkRailPane,
  openExternalUrl,
}));

vi.mock("../../app/toast/toastStore", () => ({ showToast }));

const {
  applyPluginActionNavigation,
  runPluginSocketAction,
  PLUGIN_ACTION_SLOW_NOTICE_MS,
} = await import("./pluginActionDispatch");
const { closePluginPanelPopover, getPluginPanelPopover } = await import("./pluginPanelPopoverStore");

const MANIFEST = {
  name: "hn",
  panels: [{ id: "stories" }],
  sockets: [
    { socket: "work-rail-pane", surface: "work", id: "stories", label: "HN", panelId: "stories" },
  ],
};

function source(manifest: unknown = MANIFEST): PluginSocketSource {
  return {
    pluginId: "hn",
    displayName: "Hacker News",
    enabled: true,
    accent: null,
    icon: null,
    disabledContributions: [],
    manifest,
  };
}

function installedPlugin(overrides: Record<string, unknown> = {}) {
  return {
    pluginId: "hn",
    displayName: "Hacker News",
    version: "1.0.0",
    enabled: true,
    icon: null,
    accent: null,
    status: "running",
    tabs: [{ id: "stories", title: "Hacker News", kind: "tab", panelId: "stories" }],
    theme: null,
    ...overrides,
  };
}

afterEach(() => {
  stores.sources = [];
  stores.rows = [];
  registry.plugins = [];
  registry.loaded = true;
  navigateToAppTarget.mockReset();
  revealPluginWorkRailPane.mockReset();
  openExternalUrl.mockReset();
  showToast.mockReset();
  invokePluginSocketAction.mockReset();
  closePluginPanelPopover();
});

describe("a chat-header press that navigates", () => {
  it("reveals the plugin's Work pane and never leaves the chat", () => {
    stores.sources = [source()];
    registry.plugins = [installedPlugin()];

    const resolution = applyPluginActionNavigation(
      { panelId: "stories" },
      { pluginId: "hn", context: null, socket: "chat-header-action" },
    );

    expect(resolution.kind).toBe("tools-pane");
    expect(revealPluginWorkRailPane).toHaveBeenCalledWith({
      pluginId: "hn",
      panelId: "stories",
      slotId: "plugin:hn:stories",
    });
    expect(navigateToAppTarget).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it("takes the tab route when the plugin declares no Work pane", () => {
    stores.sources = [source({ name: "hn", panels: [{ id: "stories" }], sockets: [] })];
    registry.plugins = [installedPlugin()];

    applyPluginActionNavigation(
      { panelId: "stories" },
      { pluginId: "hn", context: null, socket: "chat-header-action" },
    );

    expect(revealPluginWorkRailPane).not.toHaveBeenCalled();
    expect(navigateToAppTarget).toHaveBeenCalledWith({
      kind: "plugin",
      pluginId: "hn",
      panelId: "stories",
      context: null,
    });
  });
});

describe("a navigation that cannot mount", () => {
  it("says so instead of doing nothing, naming the panel", () => {
    stores.sources = [source()];
    registry.plugins = [installedPlugin()];

    const resolution = applyPluginActionNavigation(
      { panelId: "nosuchpanel" },
      { pluginId: "hn", context: null, socket: "chat-header-action" },
    );

    expect(resolution.kind).toBe("unreachable");
    expect(revealPluginWorkRailPane).not.toHaveBeenCalled();
    expect(navigateToAppTarget).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledTimes(1);
    const toast = showToast.mock.calls[0]?.[0] as { title: string; message: string; tone: string };
    expect(toast.tone).toBe("error");
    expect(toast.title).toContain("Hacker News");
    expect(toast.message).toContain("nosuchpanel");
  });

  it("says so when the plugin was uninstalled between the press and the answer", () => {
    registry.plugins = [];

    applyPluginActionNavigation(
      { panelId: "stories" },
      { pluginId: "hn", context: null, socket: "chat-header-action" },
    );

    expect(showToast).toHaveBeenCalledTimes(1);
    expect(navigateToAppTarget).not.toHaveBeenCalled();
  });

  it("stays silent and routes normally before the registry has resolved", () => {
    // What a chat card pressed during startup looks like: nothing is installed
    // yet as far as the store is concerned. Refusing here would be a lie.
    registry.loaded = false;
    registry.plugins = [];

    applyPluginActionNavigation(
      { panelId: "stories" },
      { pluginId: "hn", context: null, socket: "chat-header-action" },
    );

    expect(showToast).not.toHaveBeenCalled();
    expect(navigateToAppTarget).toHaveBeenCalled();
  });

  it("stays silent and routes normally when no manifest has been read yet", () => {
    // The empty-store case: every surface is unrevealed, so nothing can be
    // judged. Refusing here would break navigation on a cold press.
    registry.plugins = [installedPlugin()];

    applyPluginActionNavigation(
      { panelId: "stories" },
      { pluginId: "hn", context: null, socket: "chat-header-action" },
    );

    expect(showToast).not.toHaveBeenCalled();
    expect(navigateToAppTarget).toHaveBeenCalled();
  });
});

/**
 * The other half of the cold-launch P1: a press that is going to take a while.
 *
 * On a cold launch the plugin host is still coming up in the daemon, so the
 * invoke sits there. The row was drawn, the press was real, and the app said
 * nothing at all — no spinner, no toast — which is indistinguishable from a
 * dead button. A notice on a timer is the smallest honest answer: it only
 * appears when the press has actually been slow, and it says the press landed
 * rather than pretending the action finished.
 */
const ACTION_CONTEXT: PluginSurfaceContext = {
  kind: "session",
  id: "chat-1",
  title: "A chat",
  provider: "claude",
  status: null,
};

describe("a press while the plugin is still starting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("says nothing for a warm plugin that answers straight away", async () => {
    invokePluginSocketAction.mockResolvedValue({});

    await runPluginSocketAction("journal", "logIt", ACTION_CONTEXT);
    vi.advanceTimersByTime(PLUGIN_ACTION_SLOW_NOTICE_MS * 4);

    // The notice is for a press that is still waiting. Toasting after the work
    // is already done would be noise on every button in the app.
    expect(showToast).not.toHaveBeenCalled();
  });

  it("tells the reader the press landed once the wait gets long", async () => {
    invokePluginSocketAction.mockReturnValue(new Promise(() => {}));

    void runPluginSocketAction("journal", "logIt", ACTION_CONTEXT);
    vi.advanceTimersByTime(PLUGIN_ACTION_SLOW_NOTICE_MS);

    expect(showToast).toHaveBeenCalledTimes(1);
    const notice = showToast.mock.calls[0]?.[0] as { title: string; message: string };
    // Named, because a machine with four plugins installed gives the reader no
    // way to tell which one they are waiting on.
    expect(notice.title).toContain("journal");
    expect(notice.title).toContain("is starting");
    expect(notice.message).toContain("as soon as the plugin is ready");
  });

  it("still reports the failure when the slow press finally fails", async () => {
    let fail!: (cause: unknown) => void;
    invokePluginSocketAction.mockReturnValue(new Promise((_resolve, reject) => {
      fail = reject;
    }));

    const settled = runPluginSocketAction("journal", "logIt", ACTION_CONTEXT);
    vi.advanceTimersByTime(PLUGIN_ACTION_SLOW_NOTICE_MS);
    expect(showToast).toHaveBeenCalledTimes(1);

    fail(new Error("the plugin crashed on start"));
    await settled;

    // Clearing the notice on the error path must not clear the error with it:
    // "it is starting" followed by silence is the original bug wearing a hat.
    expect(showToast).toHaveBeenCalledTimes(2);
    const failure = showToast.mock.calls[1]?.[0] as {
      title: string;
      message: string;
      tone: string;
    };
    expect(failure.title).toBe("Plugin action failed");
    expect(failure.message).toContain("the plugin crashed on start");
    expect(failure.tone).toBe("error");
  });
});

/**
 * The `{message}` verb on a socket press.
 *
 * A panel draws this line inline and a socket had no place for it, so desktop
 * and the web client discarded it. The cost was concrete: every `{ok: false,
 * message}` a Cursor Cloud launch answered with — the model-verification
 * refusal above all — reached the armed-Enter path and vanished, and a Send
 * that refused looked exactly like a Send that did nothing.
 */
describe("what the action said about how it went", () => {
  it("draws a refusal as an error toast titled with the plugin's name", async () => {
    registry.plugins = [installedPlugin({ pluginId: "ade-cursor-cloud", displayName: "Cursor Cloud" })];
    invokePluginSocketAction.mockResolvedValue({
      ok: false,
      message: "Cursor Cloud could not verify the selected model settings.",
    });

    await runPluginSocketAction("ade-cursor-cloud", "openLaunch", ACTION_CONTEXT, {
      socket: "composer-action",
      args: { send: true },
    });

    expect(showToast).toHaveBeenCalledTimes(1);
    const toast = showToast.mock.calls[0]?.[0] as { title: string; message: string; tone: string };
    expect(toast.tone).toBe("error");
    expect(toast.title).toContain("Cursor Cloud");
    expect(toast.message).toContain("could not verify the selected model settings");
  });

  it("draws a success message as an ordinary toast", async () => {
    registry.plugins = [installedPlugin({ pluginId: "journal", displayName: "Journal" })];
    invokePluginSocketAction.mockResolvedValue({ message: "Logged it." });

    await runPluginSocketAction("journal", "logIt", ACTION_CONTEXT);

    expect(showToast).toHaveBeenCalledTimes(1);
    const toast = showToast.mock.calls[0]?.[0] as { title: string; message: string; tone: string };
    expect(toast.tone).toBe("info");
    expect(toast.title).toBe("Journal");
    expect(toast.message).toBe("Logged it.");
  });

  it("falls back to the plugin id when the registry has no name for it", async () => {
    invokePluginSocketAction.mockResolvedValue({ ok: false, message: "No API key." });

    await runPluginSocketAction("unknown-plugin", "go", ACTION_CONTEXT);

    const toast = showToast.mock.calls[0]?.[0] as { title: string };
    expect(toast.title).toContain("unknown-plugin");
  });

  it("says nothing when the action answered with no message", async () => {
    invokePluginSocketAction.mockResolvedValue({ ok: true });

    await runPluginSocketAction("journal", "logIt", ACTION_CONTEXT);

    expect(showToast).not.toHaveBeenCalled();
  });
});

/**
 * The third outcome, at the seam the rule hands it to.
 *
 * `pluginNavigateTarget.test.ts` proves the resolution; this proves the
 * dispatcher puts it in the store the popover host draws from, with the rect
 * the press was sampled at.
 */
describe("a press that answers with a popover", () => {
  it("puts the panel in the quick-view store rather than navigating", () => {
    stores.sources = [source()];
    registry.plugins = [installedPlugin()];

    const resolution = applyPluginActionNavigation(
      { panelId: "stories", target: "popover" },
      {
        pluginId: "hn",
        context: null,
        socket: "toolbar-action",
        anchor: { x: 100, y: 20, width: 60, height: 28 },
      },
    );

    expect(resolution.kind).toBe("popover");
    expect(navigateToAppTarget).not.toHaveBeenCalled();
    expect(revealPluginWorkRailPane).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
    expect(getPluginPanelPopover()).toMatchObject({
      pluginId: "hn",
      panelId: "stories",
      anchor: { x: 100, y: 20, width: 60, height: 28 },
    });
  });

  it("centres the card when the press came from no place on screen", () => {
    // A keybinding, a chat-card bridge event, a menu that already closed.
    stores.sources = [source()];
    registry.plugins = [installedPlugin()];

    applyPluginActionNavigation(
      { panelId: "stories", target: "popover" },
      { pluginId: "hn", context: null },
    );
    expect(getPluginPanelPopover()?.anchor).toBeNull();
  });

  it("refuses a popover onto a panel the plugin does not have", () => {
    stores.sources = [source()];
    registry.plugins = [installedPlugin()];

    const resolution = applyPluginActionNavigation(
      { panelId: "ghost", target: "popover" },
      { pluginId: "hn", context: null, socket: "toolbar-action" },
    );

    expect(resolution.kind).toBe("unreachable");
    expect(getPluginPanelPopover()).toBeNull();
    expect(showToast).toHaveBeenCalledTimes(1);
  });
});

/**
 * The socket half of `{authSession}`.
 *
 * The panel half is `PluginPanelHost.test.tsx`. Both are asserted because the
 * verb was dropped on BOTH paths, and one fixed path would have left a Connect
 * button working on a panel and dead on a toolbar.
 */
describe("a press that answers with a sign-in", () => {
  const PRESENTATION = {
    authSession: {
      sessionId: "linear",
      url: "https://linear.app/oauth/authorize?client_id=abc&state=xyz",
      transport: "loopback",
    },
  };

  it("opens the host-stamped URL through the external opener", async () => {
    registry.plugins = [installedPlugin({ pluginId: "ade-linear", displayName: "Linear" })];
    invokePluginSocketAction.mockResolvedValue(PRESENTATION);

    await runPluginSocketAction("ade-linear", "connect", ACTION_CONTEXT);

    expect(openExternalUrl).toHaveBeenCalledWith(
      "https://linear.app/oauth/authorize?client_id=abc&state=xyz",
    );
  });

  it("still says what the action said, beside opening the browser", async () => {
    registry.plugins = [installedPlugin({ pluginId: "ade-linear", displayName: "Linear" })];
    invokePluginSocketAction.mockResolvedValue({
      ...PRESENTATION,
      message: "Finish in your browser.",
    });

    await runPluginSocketAction("ade-linear", "connect", ACTION_CONTEXT);

    expect(openExternalUrl).toHaveBeenCalledTimes(1);
    const toast = showToast.mock.calls[0]?.[0] as { message: string };
    expect(toast.message).toBe("Finish in your browser.");
  });
});

/**
 * `{openSettings}` and `{navigate}` in one result.
 *
 * The pair is ONE destination written twice, not two things to do. There is no
 * client discriminator on the action context, so a plugin whose gear belongs on
 * ADE's Settings page here and on its own panel on a phone has to answer with
 * both and let each client take the half it can honour. Honouring both sent the
 * reader to Settings and moved the tab underneath, so they came back to a view
 * they never chose.
 */
describe("a press that answers with both a settings page and a navigation", () => {
  it("opens Settings and leaves the tab where the reader left it", async () => {
    stores.sources = [source()];
    registry.plugins = [installedPlugin()];
    invokePluginSocketAction.mockResolvedValue({
      openSettings: "secrets.secrets",
      navigate: { panelId: "stories" },
    });

    await runPluginSocketAction("hn", "openSettings", ACTION_CONTEXT);

    expect(navigateToAppTarget).toHaveBeenCalledTimes(1);
    expect(navigateToAppTarget).toHaveBeenCalledWith({
      kind: "settings",
      tab: "secrets",
      anchor: "secrets",
    });
    expect(revealPluginWorkRailPane).not.toHaveBeenCalled();
    expect(getPluginPanelPopover()).toBeNull();
  });

  it("takes the navigation when the settings request was refused", async () => {
    // The rule read from the other side: a client that could NOT honour the
    // settings half is exactly the client the fallback was written for.
    stores.sources = [source()];
    registry.plugins = [installedPlugin()];
    invokePluginSocketAction.mockResolvedValue({
      openSettings: "billing.plans",
      navigate: { panelId: "stories" },
    });

    await runPluginSocketAction("hn", "openSettings", ACTION_CONTEXT);

    expect(navigateToAppTarget).toHaveBeenCalledWith({
      kind: "plugin",
      pluginId: "hn",
      panelId: "stories",
      context: null,
    });
  });

  it("still navigates for a result carrying no settings request at all", async () => {
    stores.sources = [source()];
    registry.plugins = [installedPlugin()];
    invokePluginSocketAction.mockResolvedValue({ navigate: { panelId: "stories" } });

    await runPluginSocketAction("hn", "open", ACTION_CONTEXT);

    expect(navigateToAppTarget).toHaveBeenCalledWith({
      kind: "plugin",
      pluginId: "hn",
      panelId: "stories",
      context: null,
    });
  });
});

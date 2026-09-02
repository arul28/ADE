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
}));

vi.mock("../../app/toast/toastStore", () => ({ showToast }));

const {
  applyPluginActionNavigation,
  runPluginSocketAction,
  PLUGIN_ACTION_SLOW_NOTICE_MS,
} = await import("./pluginActionDispatch");

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
  showToast.mockReset();
  invokePluginSocketAction.mockReset();
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

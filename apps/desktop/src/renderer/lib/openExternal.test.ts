/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADE_OPEN_BUILT_IN_BROWSER_EVENT,
  canOpenUrlOnThisMachine,
  openLinkFromUi,
  openUrlInAdeBrowser,
  setLinkOpenMode,
  setWindowRuntimeBinding,
  type OpenBuiltInBrowserDetail,
} from "./openExternal";
import { resolveLinkOpenTarget } from "./linkOpenTarget";

describe("openUrlInAdeBrowser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("falls back immediately when in-app navigation rejects", async () => {
    const openExternal = vi.fn(async () => undefined);
    const navigate = vi.fn(async () => {
      throw new Error("profile migration failed");
    });
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: {
        app: { openExternal },
        builtInBrowser: { navigate },
      },
    });

    openUrlInAdeBrowser("https://example.test/docs");

    expect(navigate).toHaveBeenCalledWith({
      url: "https://example.test/docs",
      newTab: true,
    });
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledOnce());
    expect(openExternal).toHaveBeenCalledWith("https://example.test/docs");
  });

  it("does not fall back solely because in-app navigation remains pending", async () => {
    vi.useFakeTimers();
    const openExternal = vi.fn(async () => undefined);
    const navigate = vi.fn(() => new Promise<void>(() => {}));
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: {
        app: { openExternal },
        builtInBrowser: { navigate },
      },
    });

    openUrlInAdeBrowser("https://example.test/docs");
    expect(openExternal).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe("openLinkFromUi", () => {
  function installAde() {
    const openExternal = vi.fn(async () => undefined);
    const navigate = vi.fn(async () => undefined);
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: {
        app: { openExternal },
        builtInBrowser: { navigate },
      },
    });
    return { navigate, openExternal };
  }

  afterEach(() => {
    setLinkOpenMode("in-app");
    setWindowRuntimeBinding(null);
    vi.useRealTimers();
  });

  const studio = { kind: "remote", key: "remote:studio:project-1", targetId: "studio" } as never;

  it.each([
    ["from a chat pinned to it", studio, null],
    ["from a window bound to it", undefined, studio],
  ])("opens another machine's localhost in the ADE browser even when links go to the system browser (%s)", async (_label, chatPin, windowBinding) => {
    vi.useFakeTimers();
    const { navigate, openExternal } = installAde();
    setLinkOpenMode("external");
    setWindowRuntimeBinding(windowBinding as never);
    const announced: Array<OpenBuiltInBrowserDetail> = [];
    const listen = (event: Event) => announced.push((event as CustomEvent<OpenBuiltInBrowserDetail>).detail);
    window.addEventListener(ADE_OPEN_BUILT_IN_BROWSER_EVENT, listen);

    // The system browser would load THIS computer's port 4180, which is nothing.
    openLinkFromUi("http://localhost:4180/", null, chatPin === undefined ? null : { runtimePin: chatPin });
    // The Browser pane is revealed and may take the link itself...
    expect(announced).toHaveLength(1);
    // ...and when no pane does, the link still opens through the tunnel.
    await vi.advanceTimersByTimeAsync(3_000);
    window.removeEventListener(ADE_OPEN_BUILT_IN_BROWSER_EVENT, listen);

    expect(openExternal).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith({ url: "http://localhost:4180/", newTab: true }, studio);
  });

  it("completes a scheme-less terminal link before handing it to the OS opener", async () => {
    // `new URL("127.0.0.1:8080")` throws in main and the renderer swallows it,
    // so an un-normalized external open was a click that did nothing at all.
    const { openExternal } = installAde();
    setLinkOpenMode("external");

    openLinkFromUi("127.0.0.1:8080");

    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledOnce());
    expect(openExternal).toHaveBeenCalledWith("http://127.0.0.1:8080");
  });

  it("completes it the same way for the in-app branch", () => {
    const { navigate } = installAde();
    setLinkOpenMode("in-app");

    openLinkFromUi("[::1]:5173");

    expect(navigate).toHaveBeenCalledWith({ url: "http://[::1]:5173", newTab: true });
  });

  it("leaves a URL that already names a scheme alone", async () => {
    const { openExternal } = installAde();
    setLinkOpenMode("external");

    openLinkFromUi("https://example.test/docs");

    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledOnce());
    expect(openExternal).toHaveBeenCalledWith("https://example.test/docs");
  });
});

describe("resolveLinkOpenTarget", () => {
  it("follows the preference on a plain click", () => {
    expect(resolveLinkOpenTarget({ mode: "in-app" })).toBe("in-app");
    expect(resolveLinkOpenTarget({ mode: "external" })).toBe("external");
  });

  it("treats Cmd as Mod on macOS and Ctrl elsewhere", () => {
    expect(resolveLinkOpenTarget({ mode: "in-app", modifiers: { metaKey: true }, isMac: true })).toBe("external");
    expect(resolveLinkOpenTarget({ mode: "in-app", modifiers: { ctrlKey: true }, isMac: false })).toBe("external");
    // The other platform's key is not Mod, so it must not trigger the override.
    expect(resolveLinkOpenTarget({ mode: "in-app", modifiers: { ctrlKey: true }, isMac: true })).toBe("in-app");
    expect(resolveLinkOpenTarget({ mode: "in-app", modifiers: { metaKey: true }, isMac: false })).toBe("in-app");
  });

  it("opens externally on Mod+Click even when the preference is in-app", () => {
    expect(resolveLinkOpenTarget({ mode: "in-app", modifiers: { metaKey: true }, isMac: true })).toBe("external");
  });

  it("opens in ADE on Shift+Click even when the preference is external", () => {
    expect(resolveLinkOpenTarget({ mode: "external", modifiers: { shiftKey: true } })).toBe("in-app");
  });

  it("lets Mod win over Shift, because Mod is the escape hatch", () => {
    expect(
      resolveLinkOpenTarget({
        mode: "in-app",
        modifiers: { metaKey: true, shiftKey: true },
        isMac: true,
      }),
    ).toBe("external");
  });

  it("ignores modifiers that carry no meaning here", () => {
    expect(resolveLinkOpenTarget({ mode: "in-app", modifiers: {} })).toBe("in-app");
    expect(resolveLinkOpenTarget({ mode: "external", modifiers: null })).toBe("external");
  });
});

describe("canOpenUrlOnThisMachine", () => {
  const studio = { kind: "remote", key: "remote:studio:project-1", targetId: "studio" } as never;

  beforeEach(() => {
    // `remoteMachineForLoopbackLink` falls back to the window's binding when
    // the caller passes none, so pin it to "this machine" for these cases.
    setWindowRuntimeBinding(null);
  });

  afterEach(() => {
    setWindowRuntimeBinding(null);
  });

  // The menu offers an OS browser only for what the main process will accept;
  // every other scheme would come back as an allowlist error after the click.
  it.each([
    ["https", "https://example.test/docs", true],
    ["mailto", "mailto:ada@example.test", true],
    ["file", "file:///tmp/notes.md", false],
    ["irc", "irc://irc.libera.chat/ade", false],
    ["a protocol-relative link", "//example.test/docs", false],
  ])("agrees with the main-process allowlist about a %s URL", (_label, url, expected) => {
    expect(canOpenUrlOnThisMachine(url)).toBe(expected);
  });

  it("refuses a loopback link that belongs to another machine", () => {
    // A chat on a remote machine printing localhost:4180 means THAT machine's
    // port; an OS browser here would open this computer's, which is nothing.
    expect(canOpenUrlOnThisMachine("http://localhost:4180/", { runtimePin: studio })).toBe(false);
    expect(
      canOpenUrlOnThisMachine("http://127.0.0.1:4180/", { runtimePin: studio }),
      "a loopback address is another machine's too",
    ).toBe(false);
    // The same address written the way a dev server prints it — no scheme. Only
    // the normalized form is recognisable as loopback, so this one is the case
    // that proves the guard normalizes rather than reading the raw string.
    expect(
      canOpenUrlOnThisMachine("127.0.0.1:4180", { runtimePin: studio }),
      "a scheme-less loopback link is another machine's too",
    ).toBe(false);
  });

  it("still allows a loopback link when the chat runs here", () => {
    expect(canOpenUrlOnThisMachine("http://localhost:4180/", { runtimePin: null })).toBe(true);
  });
});

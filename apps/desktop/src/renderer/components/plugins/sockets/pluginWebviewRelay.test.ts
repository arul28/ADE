import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  PluginWebviewUiRequest,
  PluginWebviewUiResponse,
} from "../../../../shared/plugins/webviewBridge";
import { rootAppStoreApi } from "../../../state/appStore";
import { dismissToast, getToasts } from "../../app/toast/toastStore";
import { registerPluginComposerTarget, resetPluginComposerTargets } from "./composerTarget";
import {
  handlePluginWebviewUiRequest,
  installPluginWebviewRelay,
  pluginWebviewAttachmentText,
  readPluginWebviewUiRequest,
} from "./pluginWebviewRelay";
import {
  registerPluginWebviewGuest,
  resetPluginWebviewGuests,
} from "./pluginWebviewGuestRegistry";
import {
  getPluginWebviewConfirm,
  settlePluginWebviewConfirm,
  resetPluginWebviewConfirm,
} from "./pluginWebviewConfirmStore";
import { getPluginPrompt, submitPluginPrompt, closePluginPrompt } from "./pluginPromptStore";
import {
  getPluginWebviewPicker,
  resetPluginWebviewPicker,
  settlePluginWebviewPicker,
} from "./pluginWebviewPickerStore";
import {
  getPluginWebviewPageError,
  resetPluginWebviewPageErrors,
} from "./pluginWebviewPageErrorStore";
import {
  getPluginWebviewPopover,
  openPluginWebviewPopover,
  resetPluginWebviewPopover,
} from "./pluginWebviewPopoverStore";
import {
  closePluginWebviewOverlay,
  getPluginWebviewOverlay,
} from "./pluginWebviewOverlayStore";

/**
 * The relay's contract in one sentence: every request is answered exactly once.
 *
 * These walk each verb through {@link handlePluginWebviewUiRequest} — the pure
 * half — and then walk the listener through a fake IPC pair, because the two
 * failures the contract is guarding against live in different places. A verb
 * that does the wrong thing is a bug in the dispatcher; a verb that answers
 * twice, or not at all, is a bug in the wiring, and only the fake pair can see
 * that one.
 */

function request(
  verb: PluginWebviewUiRequest["verb"],
  args: Record<string, unknown> = {},
  overrides: Partial<PluginWebviewUiRequest> = {},
): PluginWebviewUiRequest {
  return {
    requestId: "req-1",
    guestKey: "guest-7",
    pluginId: "acme",
    surfaceId: "issues",
    placement: "popover",
    verb,
    args,
    ...overrides,
  };
}

beforeEach(() => {
  resetPluginWebviewGuests();
  resetPluginComposerTargets();
  resetPluginWebviewConfirm();
  resetPluginWebviewPicker();
  resetPluginWebviewPageErrors();
  resetPluginWebviewPopover();
  closePluginWebviewOverlay();
  for (const toast of getToasts()) dismissToast(toast.id);
  closePluginPrompt();
  rootAppStoreApi.setState({
    installedPlugins: [
      {
        pluginId: "acme",
        displayName: "Acme",
        version: "1.0.0",
        enabled: true,
        icon: "puzzle",
        accent: "#fff",
        status: "running",
        tabs: [],
        theme: null,
      },
    ],
  } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readPluginWebviewUiRequest", () => {
  it("drops only a payload with no request id to echo", () => {
    expect(readPluginWebviewUiRequest(null)).toBeNull();
    expect(readPluginWebviewUiRequest({ guestKey: "g", pluginId: "p", verb: "ui.toast" })).toBeNull();
    expect(readPluginWebviewUiRequest({ requestId: "r", guestKey: "g", pluginId: "p", verb: "nope" }))
      .toBeNull();
  });

  it("keeps the host's own surfaceId and placement rather than re-deriving them", () => {
    const read = readPluginWebviewUiRequest({
      requestId: "r",
      guestKey: "guest-3",
      pluginId: "acme",
      surfaceId: "issues",
      placement: "composer-picker",
      verb: "surface.close",
      args: { ignored: true },
    });
    expect(read).toMatchObject({
      guestKey: "guest-3",
      surfaceId: "issues",
      placement: "composer-picker",
      verb: "surface.close",
    });
  });
});

describe("surface.close", () => {
  it("closes the surface that owns the guest", async () => {
    const close = vi.fn();
    registerPluginWebviewGuest({
      guestKey: "guest-7",
      pluginId: "acme",
      surfaceId: "issues",
      placement: "popover",
      close,
    });
    await expect(handlePluginWebviewUiRequest(request("surface.close"))).resolves.toEqual({ ok: true });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("is a no-op, not a refusal, for a placement with nothing to close", async () => {
    registerPluginWebviewGuest({
      guestKey: "guest-7",
      pluginId: "acme",
      surfaceId: "issues",
      placement: "tab",
    });
    await expect(handlePluginWebviewUiRequest(request("surface.close"))).resolves.toEqual({ ok: true });
  });

  it("refuses when the guest is already gone", async () => {
    const answer = await handlePluginWebviewUiRequest(request("surface.close"));
    expect(answer.ok).toBe(false);
  });
});

describe("composer verbs", () => {
  it("attaches an issue as text through the socket path's own applier", async () => {
    const insertText = vi.fn();
    registerPluginComposerTarget("composer-1", {
      sessionId: null,
      insertText,
      replaceText: vi.fn(),
    });
    const answer = await handlePluginWebviewUiRequest(request("composer.attach", {
      issue: {
        provider: "linear",
        issueId: "uuid-1",
        identifier: "ADE-148",
        title: "Page tier",
        url: "https://linear.app/ADE-148",
      },
    }));
    expect(answer).toEqual({ ok: true });
    expect(insertText).toHaveBeenCalledWith("ADE-148 Page tier (https://linear.app/ADE-148)");
  });

  it("refuses an insert when no composer is on screen", async () => {
    const answer = await handlePluginWebviewUiRequest(request("composer.insert", { text: "hi" }));
    expect(answer.ok).toBe(false);
  });

  it("renders an attachment with only the fields it has", () => {
    expect(pluginWebviewAttachmentText({
      provider: "linear",
      issueId: "uuid-1",
      identifier: "ADE-1",
      title: "",
      url: "",
    })).toBe("ADE-1");
  });
});

describe("toast verbs", () => {
  it("shows a toast under the plugin's own name and answers with its id", async () => {
    const answer = await handlePluginWebviewUiRequest(request("ui.toast", {
      toast: { level: "error", message: "Sign-in expired" },
    }));
    expect(answer.ok).toBe(true);
    const id = (answer as { value: { id: string } }).value.id;
    expect(getToasts().find((toast) => toast.id === id)).toMatchObject({
      title: "Acme",
      message: "Sign-in expired",
      tone: "error",
    });
    await expect(handlePluginWebviewUiRequest(request("ui.dismissToast", { id })))
      .resolves.toEqual({ ok: true });
    expect(getToasts().some((toast) => toast.id === id)).toBe(false);
  });

  it("refuses a toast with no message rather than showing an empty one", async () => {
    const answer = await handlePluginWebviewUiRequest(request("ui.toast", {
      toast: { level: "info", message: "" },
    }));
    expect(answer.ok).toBe(false);
  });
});

describe("ui.prompt", () => {
  it("answers with the reader's text", async () => {
    const pending = handlePluginWebviewUiRequest(request("ui.prompt", {
      prompt: { id: "note", title: "Why?" },
    }));
    await Promise.resolve();
    expect(getPluginPrompt()).not.toBeNull();
    submitPluginPrompt("because");
    await expect(pending).resolves.toEqual({ ok: true, value: { id: "note", text: "because" } });
  });

  it("answers null when the reader walks away instead of hanging the page", async () => {
    const pending = handlePluginWebviewUiRequest(request("ui.prompt", {
      prompt: { id: "note", title: "Why?" },
    }));
    await Promise.resolve();
    closePluginPrompt();
    await expect(pending).resolves.toEqual({ ok: true, value: null });
  });
});

describe("ui.confirm", () => {
  it("answers the reader's decision", async () => {
    const pending = handlePluginWebviewUiRequest(request("ui.confirm", {
      confirm: { title: "Delete it?", destructive: true },
    }));
    await Promise.resolve();
    expect(getPluginWebviewConfirm()).toMatchObject({ displayName: "Acme" });
    settlePluginWebviewConfirm(true);
    await expect(pending).resolves.toEqual({ ok: true, value: true });
  });

  it("answers false when a second question replaces the first", async () => {
    const first = handlePluginWebviewUiRequest(request("ui.confirm", { confirm: { title: "One" } }));
    await Promise.resolve();
    const second = handlePluginWebviewUiRequest(request("ui.confirm", { confirm: { title: "Two" } }));
    await expect(first).resolves.toEqual({ ok: true, value: false });
    settlePluginWebviewConfirm(true);
    await expect(second).resolves.toEqual({ ok: true, value: true });
  });
});

describe("actionResult", () => {
  it("applies the composer half of a control-flow answer", async () => {
    const insertText = vi.fn();
    registerPluginComposerTarget("composer-1", {
      sessionId: null,
      insertText,
      replaceText: vi.fn(),
    });
    const answer = await handlePluginWebviewUiRequest(request("actionResult", {
      action: "file",
      result: { composer: { insertText: "ADE-9" } },
    }));
    expect(answer).toEqual({ ok: true });
    expect(insertText).toHaveBeenCalledWith("ADE-9");
  });

  /**
   * `{openWebview}`, which this path used to drop on the floor.
   *
   * The socket press has honoured it since the page tier shipped; an invoke
   * from a PAGE did not, so a plugin whose own page answered `{openWebview}`
   * got nothing at all and no error anywhere. Linear's Attach is the case: its
   * issue popover answers `{openWebview:{surfaceId:"picker"}}`, and the picker
   * has to REPLACE that popover rather than stack under it.
   */
  describe("openWebview", () => {
    const withSurfaces = (tabs: Array<{ id: string; title: string; panelId: string }>) => {
      rootAppStoreApi.setState({
        installedPlugins: [{
          pluginId: "acme",
          displayName: "Acme",
          version: "1.0.0",
          enabled: true,
          icon: "puzzle",
          accent: "#fff",
          status: "running",
          tabs,
          theme: null,
        }],
      } as never);
    };

    it("opens the page the answer named, in the placement it asked for", async () => {
      withSurfaces([{ id: "picker", title: "Attach", panelId: "picker" }]);
      const answer = await handlePluginWebviewUiRequest(request("actionResult", {
        action: "attach",
        result: { openWebview: { surfaceId: "picker", placement: "picker", context: { issue: "ADE-9" } } },
      }));
      expect(answer).toEqual({ ok: true });

      const card = getPluginWebviewPopover();
      expect(card).toMatchObject({
        pluginId: "acme",
        surfaceId: "picker",
        kind: "composer-picker",
        // The page's plugin-authored hint rides through as the pointer.
        pointer: { issue: "ADE-9" },
      });
      // A page's subject is main's word, captured at attach and not carried on
      // this verb. The relay has none to pass on and must not invent one from
      // the calling guest.
      expect(card?.subject).toBeNull();
    });

    it("replaces the calling popover rather than stacking under it", async () => {
      withSurfaces([
        { id: "issues", title: "Issue", panelId: "issues" },
        { id: "picker", title: "Attach", panelId: "picker" },
      ]);
      // The card the Attach button was pressed in, with the anchor the host
      // measured for it.
      openPluginWebviewPopover({
        pluginId: "acme",
        surfaceId: "issues",
        kind: "popover",
        subject: null,
        anchor: { x: 340, y: 120, width: 280, height: 200 },
      });
      registerPluginWebviewGuest({
        guestKey: "guest-7",
        pluginId: "acme",
        surfaceId: "issues",
        placement: "popover",
      });

      await handlePluginWebviewUiRequest(request("actionResult", {
        action: "attach",
        result: { openWebview: { surfaceId: "picker", placement: "picker" } },
      }));

      // One anchored card at a time, so the picker took the popover's place.
      const card = getPluginWebviewPopover();
      expect(card).toMatchObject({ surfaceId: "picker", kind: "composer-picker" });
      // And it opened where the control the reader pressed was, not in the
      // middle of the window.
      expect(card?.anchor).toEqual({ x: 340, y: 120, width: 280, height: 200 });
    });

    it("anchors nowhere when the calling guest is not the standing card", async () => {
      withSurfaces([{ id: "picker", title: "Attach", panelId: "picker" }]);
      // A tab guest has no anchor. Borrowing another surface's would put the
      // picker over a control the reader never pressed.
      openPluginWebviewPopover({
        pluginId: "acme",
        surfaceId: "someone-else",
        kind: "popover",
        subject: null,
        anchor: { x: 20, y: 10, width: 100, height: 100 },
      });
      registerPluginWebviewGuest({
        guestKey: "guest-7",
        pluginId: "acme",
        surfaceId: "board",
        placement: "tab",
      });

      await handlePluginWebviewUiRequest(request("actionResult", {
        action: "attach",
        result: { openWebview: { surfaceId: "picker", placement: "picker" } },
      }));
      expect(getPluginWebviewPopover()?.anchor).toBeNull();
    });

    it("opens nothing for a surface the plugin does not declare", async () => {
      // The same check the socket path makes, and for the same reason: an
      // unresolvable id would open an empty frame the reader has to dismiss.
      withSurfaces([{ id: "picker", title: "Attach", panelId: "picker" }]);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const answer = await handlePluginWebviewUiRequest(request("actionResult", {
        action: "attach",
        result: { openWebview: { surfaceId: "not-a-surface", placement: "picker" } },
      }));
      // The invoke still succeeded; only the open was refused.
      expect(answer).toEqual({ ok: true });
      expect(getPluginWebviewPopover()).toBeNull();
      expect(warn).toHaveBeenCalled();
    });

    it("opens nothing for a plugin that is switched off", async () => {
      rootAppStoreApi.setState({
        installedPlugins: [{
          pluginId: "acme",
          displayName: "Acme",
          version: "1.0.0",
          enabled: false,
          icon: "puzzle",
          accent: "#fff",
          status: "stopped",
          tabs: [{ id: "picker", title: "Attach", panelId: "picker" }],
          theme: null,
        }],
      } as never);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await handlePluginWebviewUiRequest(request("actionResult", {
        action: "attach",
        result: { openWebview: { surfaceId: "picker", placement: "picker" } },
      }));
      expect(getPluginWebviewPopover()).toBeNull();
    });

    it("warns rather than opening when the answer is malformed", async () => {
      withSurfaces([{ id: "picker", title: "Attach", panelId: "picker" }]);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const answer = await handlePluginWebviewUiRequest(request("actionResult", {
        action: "attach",
        result: { openWebview: { placement: "picker" } },
      }));
      expect(answer).toEqual({ ok: true });
      expect(getPluginWebviewPopover()).toBeNull();
      expect(warn).toHaveBeenCalled();
    });

    it("defaults to the overlay a plugin written before the page tier meant", async () => {
      withSurfaces([{ id: "board", title: "Board", panelId: "board" }]);
      const answer = await handlePluginWebviewUiRequest(request("actionResult", {
        action: "attach",
        result: { openWebview: { surfaceId: "board" } },
      }));
      expect(answer).toEqual({ ok: true });
      // The overlay is a different host from the anchored card.
      expect(getPluginWebviewPopover()).toBeNull();
      expect(getPluginWebviewOverlay()).toMatchObject({ pluginId: "acme", surfaceId: "board" });
    });
  });
});

describe("installPluginWebviewRelay", () => {
  it("answers every request exactly once, including one it cannot serve", async () => {
    const responses: PluginWebviewUiResponse[] = [];
    let uninstalled = false;
    // Annotated rather than inferred: the assignment happens inside the fake
    // `onUiRequest`, and TypeScript narrows the declaration to `null` before it
    // sees that callback run.
    let deliver!: (payload: unknown) => void;
    const uninstall = installPluginWebviewRelay({
      onUiRequest: (cb) => {
        deliver = cb;
        return () => {
          uninstalled = true;
        };
      },
      respondUi: (response) => responses.push(response),
    });

    deliver(request("surface.close"));
    // A drained microtask queue is the settle point: the dispatcher is async and
    // nothing here waits on a timer.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(responses).toEqual([
      { requestId: "req-1", ok: false, message: "That page is no longer on screen." },
    ]);

    deliver({ nonsense: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(responses).toHaveLength(1);

    uninstall();
    expect(uninstalled).toBe(true);
  });

  it("turns a throw inside an applier into a refusal the page can read", async () => {
    const responses: PluginWebviewUiResponse[] = [];
    // Annotated rather than inferred: the assignment happens inside the fake
    // `onUiRequest`, and TypeScript narrows the declaration to `null` before it
    // sees that callback run.
    let deliver!: (payload: unknown) => void;
    installPluginWebviewRelay({
      onUiRequest: (cb) => {
        deliver = cb;
        return () => undefined;
      },
      respondUi: (response) => responses.push(response),
    });
    registerPluginWebviewGuest({
      guestKey: "guest-7",
      pluginId: "acme",
      surfaceId: "issues",
      placement: "popover",
      close: () => {
        throw new Error("boom");
      },
    });
    deliver(request("surface.close"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(responses).toEqual([{ requestId: "req-1", ok: false, message: "boom" }]);
  });
});

describe("host pickers", () => {
  it("opens ADE's picker and answers the choice", async () => {
    const pending = handlePluginWebviewUiRequest(request("ui.pickLane", { value: "lane-1" }));
    await Promise.resolve();
    expect(getPluginWebviewPicker()).toMatchObject({ verb: "ui.pickLane", pluginId: "acme" });
    settlePluginWebviewPicker({ laneId: "lane-1", name: "Main" });
    await expect(pending).resolves.toEqual({
      ok: true,
      value: { laneId: "lane-1", name: "Main" },
    });
  });

  it("answers null when the reader dismisses rather than hanging", async () => {
    const pending = handlePluginWebviewUiRequest(request("ui.pickModel"));
    await Promise.resolve();
    settlePluginWebviewPicker(null);
    await expect(pending).resolves.toEqual({ ok: true, value: null });
  });

  it("refuses a permission pick with no provider rather than answering null", async () => {
    const answer = await handlePluginWebviewUiRequest(request("ui.pickPermissionMode", {}));
    expect(answer).toEqual({
      ok: false,
      message: "ADE doesn’t have a permission control for that provider.",
    });
    expect(getPluginWebviewPicker()).toBeNull();
  });
});

describe("page.error", () => {
  it("records the report for the error card", async () => {
    const answer = await handlePluginWebviewUiRequest(request("page.error", {
      error: { kind: "error", message: "Render threw." },
    }));
    expect(answer).toEqual({ ok: true });
    expect(getPluginWebviewPageError("guest-7")).toEqual({
      kind: "error",
      message: "Render threw.",
    });
  });
});

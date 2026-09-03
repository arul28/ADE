// The second action table: what the plugin's own HTML page invokes.
//
// `index.js` answers the MANIFEST — the `get_status` tool, the panel refresh,
// the palette word — and what those return is vocabulary: `{navigate}`,
// `{message}`, a panel id. This file answers a PAGE, and a page wants neither of
// those things. It wants DATA — the same shapes `window.ade.appControl.*` handed
// the compiled `ChatAppControlPanel` — and, for a press, `{ok, message}` it can
// draw beside the control the reader touched.
//
// `page/src/host/actions.ts` is the contract, one exported function per id.
// Every id it names is defined here, and the shapes it declares in
// `page/src/types.ts` are what these handlers pass through.
//
// ## Why a page handler does not throw
//
// A press on a panel that fails renders as a banner because the host turns
// `{message, ok: false}` into one. A page's `invoke` has no such chrome: a
// rejected promise reaches the page as an exception beside a form the reader has
// already filled in, and the page has to invent the banner itself. So every
// MUTATION here answers `{ok: false, message}` for anything the host refused,
// and throws only when the plugin itself is wrong.
//
// The reads are the exception, and only where a failure has somewhere honest to
// live:
//
//   * `pageStatus` degrades to an unsupported status carrying the message, so a
//     page opened on a machine where Electron Control does not run draws its own
//     blockers card rather than a crash.
//   * `pageTargets` degrades to `[]`, because a workspace with no windows and a
//     scan that failed both mean "there is nothing to switch to" and the picker
//     hides either way.
//   * `pageSnapshot`, `pageInspectPoint` and `pageSelectPoint` do NOT degrade.
//     An empty element list is indistinguishable from "the app is showing
//     nothing", and a lie the page cannot detect is worse than a rejection it
//     can retry.
//
// ## Why no frame ever crosses this table
//
// The compiled pane subscribed to `appControl.onEvent` and drew the screencast
// itself: thirty base64 PNGs a second, each one a structured clone into the
// renderer. A page cannot pay that, so the live view stays a HOST engine —
// `electron-control`, the one the `canvas` component already mounts — and the
// page reserves a rect for it (`page/src/host/engine.ts`). Nothing here returns
// image bytes, and the one handler that used to produce them
// (`pageAttachContext`) hands the host an element and lets the host crop.
//
// ## Why `deps` is read through getters
//
// `index.js` holds its SDK binding in a variable that is null until `activate`
// runs, and this table is built at LOAD so a page that opens before `activate`
// resolves gets a real handler rather than "no such action". A table that
// captured the sdk by value would capture the null; a handler that runs before
// the binding exists answers its own empty shape instead.

"use strict";

/** The one sentence for a call that arrived before `activate` finished. */
const STARTING_UP = "Electron Control is still starting up on this machine.";

/** What a host that cannot drive answers, so the blockers card has something to draw. */
const UNSUPPORTED_STATUS = Object.freeze({
  platform: "unknown",
  supported: false,
  activeSession: null,
  providers: [],
});

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** An integer that may have arrived as a string. `0` survives; nothing else does. */
function integer(value) {
  if (Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return null;
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * The coordinate space a point verb was sent in.
 *
 * The page always sends `viewport`, which is what the compiled pane sent for
 * every one of its click, scroll, select and inspect calls. A stray value is
 * narrowed rather than passed through: the host reads it as a discriminator and
 * an unknown one would be taken as `screenshot`, silently clicking somewhere
 * else on a HiDPI display.
 */
function coordinateSpace(value) {
  return value === "screenshot" ? "screenshot" : "viewport";
}

function createPageActions(deps) {
  /** Are the lifecycle's bindings there yet? See the header. */
  function ready() {
    return Boolean(deps.sdk);
  }

  function invokeControl(action, args = {}) {
    return deps.sdk.actions.invoke("app_control", action, args);
  }

  /** One sentence for whatever refused, worded for a control beside a form. */
  function failure(error, fallback) {
    return { ok: false, message: text(error?.message) ?? text(error) ?? fallback };
  }

  /**
   * Run a MUTATION and shape whatever comes back.
   *
   * The single place `{ok, message}` is built, so no handler below can forget
   * the rule. `extra` folds the host's own answer in — a launched session, an
   * attached target — for the handlers whose page caller reads one.
   */
  async function mutate(fallback, run) {
    if (!ready()) return { ok: false, message: STARTING_UP };
    try {
      const answer = await run();
      return { ok: true, ...(answer ?? {}) };
    } catch (error) {
      return failure(error, fallback);
    }
  }

  return {
    /* ── Reads ──────────────────────────────────────────────────────────── */

    /**
     * The status, plus the reason this host will not drive.
     *
     * `disabledReason` has no compiled counterpart in the pane: it was a PROP
     * (`controlDisabledReason`) the chat or the Work rail handed down, and a
     * page has no parent to hand it one. The host's own `lastError` on a failed
     * session is a different thing and stays where it is — this field is about
     * the MACHINE, not the session, which is why an unsupported platform fills
     * it and a crashed app does not.
     */
    async pageStatus() {
      if (!ready()) return { ...UNSUPPORTED_STATUS, disabledReason: STARTING_UP };
      try {
        const status = await invokeControl("getStatus", {});
        const shaped = record(status);
        const supported = shaped.supported === true;
        return {
          ...UNSUPPORTED_STATUS,
          ...shaped,
          supported,
          disabledReason: text(shaped.disabledReason)
            ?? (supported
              ? null
              : "Electron Control drives an app on the computer this project is attached to, and this machine cannot."),
        };
      } catch (error) {
        return {
          ...UNSUPPORTED_STATUS,
          disabledReason: text(error?.message) ?? "Could not read Electron Control on this machine.",
        };
      }
    },

    /** The CDP targets, or `[]`. A picker with nothing in it hides itself. */
    async pageTargets() {
      if (!ready()) return [];
      try {
        const list = await invokeControl("listTargets", {});
        return Array.isArray(list) ? list : [];
      } catch {
        return [];
      }
    },

    /**
     * The DOM snapshot, WITHOUT the screenshot.
     *
     * The host answers a `screenshot` field carrying a full-size data URL. It is
     * stripped here rather than ignored on the page: the bytes would cross the
     * bridge as a structured clone on every refresh, for a picture the host
     * engine is already painting.
     */
    async pageSnapshot(args) {
      if (!ready()) throw new Error(STARTING_UP);
      const frame = record(args);
      const snapshot = record(
        await invokeControl("getSnapshot", { projectRoot: text(frame.projectRoot) }),
      );
      const { screenshot: _screenshot, ...rest } = snapshot;
      return rest;
    },

    /* ── The session ────────────────────────────────────────────────────── */

    /**
     * Launch a command in ADE's terminal.
     *
     * `force: true` unconditionally, which is the compiled call's own choice: the
     * reader pressed Run with a session already showing, and that is a deliberate
     * replacement rather than a race.
     */
    async pageLaunch(args) {
      const frame = record(args);
      const command = text(frame.command);
      if (!command) return { ok: false, message: "Enter a launch command." };
      return await mutate("Could not launch the app.", async () => {
        const session = await invokeControl("launchInTerminal", {
          projectRoot: text(frame.projectRoot),
          laneId: text(frame.laneId),
          command,
          cwd: text(frame.cwd),
          chatSessionId: text(frame.chatSessionId),
          force: true,
        });
        // A session the host started but that reports its own failure is a
        // refusal, not a success with a note: the compiled pane drew
        // `launched.lastError` as an error banner and this keeps that reading.
        const lastError = text(record(session).lastError);
        if (lastError) return { ok: false, message: lastError, session };
        return { session };
      });
    },

    async pageConnect(args) {
      const frame = record(args);
      const port = integer(frame.cdpPort);
      if (port === null || port <= 0) return { ok: false, message: "Enter a valid CDP port." };
      return await mutate("Could not connect to that port.", async () => ({
        session: await invokeControl("connect", {
          projectRoot: text(frame.projectRoot),
          laneId: text(frame.laneId),
          cdpPort: port,
          chatSessionId: text(frame.chatSessionId),
          force: true,
        }),
      }));
    },

    async pageStop() {
      return await mutate("Could not stop the session.", async () => {
        await invokeControl("stop", {});
      });
    },

    async pageAttachTarget(args) {
      const targetId = text(record(args).targetId);
      if (!targetId) return { ok: false, message: "Pick a window to attach to." };
      return await mutate("Could not attach to that window.", async () => ({
        session: await invokeControl("attachToTarget", { targetId }),
      }));
    },

    async pageFocusWindow() {
      return await mutate("Could not show the app window.", async () => {
        await invokeControl("focusWindow", {});
      });
    },

    async pageMinimizeWindow() {
      return await mutate("Could not minimize the app window.", async () => {
        await invokeControl("minimizeWindow", {});
      });
    },

    /* ── Driving the app ────────────────────────────────────────────────── */

    async pageClick(args) {
      const frame = record(args);
      const x = integer(frame.x);
      const y = integer(frame.y);
      if (x === null || y === null) return { ok: false, message: "Click needs an x and a y." };
      return await mutate("Click failed.", async () => {
        await invokeControl("click", { x, y, coordinateSpace: coordinateSpace(frame.coordinateSpace) });
      });
    },

    async pageScroll(args) {
      const frame = record(args);
      const x = integer(frame.x);
      const y = integer(frame.y);
      const deltaX = integer(frame.deltaX) ?? 0;
      const deltaY = integer(frame.deltaY) ?? 0;
      if (x === null || y === null) return { ok: false, message: "Scroll needs an x and a y." };
      if (deltaX === 0 && deltaY === 0) return { ok: false, message: "Scroll needs a non-zero amount." };
      return await mutate("Scroll failed.", async () => {
        await invokeControl("scroll", {
          x,
          y,
          deltaX,
          deltaY,
          coordinateSpace: coordinateSpace(frame.coordinateSpace),
        });
      });
    },

    /**
     * Type into whatever the app has focused.
     *
     * Empty text is a REFUSAL rather than a silent success: the compiled pane
     * returned early on an empty field and drew nothing, which left the reader
     * unable to tell a no-op from a failure.
     */
    async pageTypeText(args) {
      const value = record(args).text;
      if (typeof value !== "string" || !value.trim()) {
        return { ok: false, message: "Enter some text to type." };
      }
      return await mutate("Could not type into the app.", async () => {
        await invokeControl("typeText", { text: value });
      });
    },

    /* ── Inspecting ─────────────────────────────────────────────────────── */

    /**
     * Read what is at a point, without selecting it.
     *
     * Throws rather than degrading, and so does `pageSelectPoint`: the page
     * draws whatever comes back as the inspect list, and an empty list from a
     * failed read is indistinguishable from an app that is showing nothing.
     */
    async pageInspectPoint(args) {
      if (!ready()) throw new Error(STARTING_UP);
      const frame = record(args);
      const x = integer(frame.x);
      const y = integer(frame.y);
      if (x === null || y === null) throw new Error("Inspect needs an x and a y.");
      const result = record(
        await invokeControl("inspectPoint", {
          projectRoot: text(frame.projectRoot),
          x,
          y,
          coordinateSpace: coordinateSpace(frame.coordinateSpace),
          includeScreenshot: false,
        }),
      );
      return { ...result, snapshot: stripScreenshot(result.snapshot) };
    },

    async pageSelectPoint(args) {
      if (!ready()) throw new Error(STARTING_UP);
      const frame = record(args);
      const x = integer(frame.x);
      const y = integer(frame.y);
      if (x === null || y === null) throw new Error("Select needs an x and a y.");
      const result = record(
        await invokeControl("selectPoint", {
          projectRoot: text(frame.projectRoot),
          x,
          y,
          coordinateSpace: coordinateSpace(frame.coordinateSpace),
          includeScreenshot: false,
        }),
      );
      return { ...result, snapshot: stripScreenshot(result.snapshot) };
    },

    /**
     * Hand a selected element to the chat.
     *
     * The compiled pane did this in the renderer across three steps: crop the
     * screenshot on a canvas, `agentChat.saveTempAttachment` the base64, then
     * call two props the chat had passed down. A page has none of the three, so
     * the whole thing is one call and the host does the crop on the side that
     * already holds the frame.
     */
    async pageAttachContext(args) {
      const item = record(record(args).item);
      if (!text(item.id)) return { ok: false, message: "Nothing is selected to attach." };
      return await mutate("Could not insert Electron Control context.", async () => {
        await invokeControl("attachContext", { item });
      });
    },
  };
}

/**
 * Drop a snapshot's screenshot, wherever it is nested.
 *
 * Shared by the three reads that carry one. `null` and a missing snapshot both
 * survive as themselves rather than becoming `{}` — the page branches on the
 * presence of the snapshot, and inventing an empty one would draw an inspect
 * list of nothing over an app that answered nothing at all.
 */
function stripScreenshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return snapshot ?? null;
  const { screenshot: _screenshot, ...rest } = snapshot;
  return rest;
}

module.exports = { createPageActions, __internals: { coordinateSpace, integer, stripScreenshot, text } };

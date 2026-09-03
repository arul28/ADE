// The second action table: what the plugin's own HTML page invokes.
//
// `index.js`'s `ownActions` answers the MANIFEST — the `get_status` tool, the
// panel refresh, the palette word — and what those return is vocabulary:
// `{navigate}`, `{message}`, a panel id. This file answers a PAGE, and a page
// wants neither. It wants DATA — the same shapes `window.ade.iosSimulator.*`
// handed the compiled pane — and, for a control the reader just pressed,
// `{ok, message}` it can draw beside that control.
//
// `page/src/host/actions.ts` is the contract, one exported function per id, and
// its header carries the compiled-call → page-action table. Every id it names
// is defined here.
//
// ## Why a page handler does not throw
//
// A press on a panel that fails renders as a banner because the host turns
// `{ok: false, message}` into one. A page's `invoke` has no such chrome: a
// rejected promise reaches the page as an exception beside a toolbar the reader
// has already pressed, and the page would have to invent the banner itself.
//
// So every MUTATION here answers `{ok: false, message}` for anything the
// machine refused — a simulator owned by another chat, a target that will not
// build, an `idb` that is not installed, a Mac that is not a Mac — and throws
// only when the plugin itself is wrong.
//
// The READS are the exception, and only where a failure has an honest place to
// live. `pageStatus`, `pageDevices`, `pageLaunchTargets`, `pageStreamStatus`,
// `pagePreviewCapability` and `pagePreviewTargets` all degrade — `null`, or an
// empty list — because the page draws "No available simulator" and "No
// launchable app found" from exactly those, and a machine that cannot answer
// and a machine with nothing to answer about look the same to a reader either
// way. `pageScreenSnapshot`, `pageInspectorSnapshot`, `pageScreenshot` and
// `pageResolvePreviewMatch` reject instead: an empty snapshot is
// indistinguishable from "there is nothing on screen", and a lie the page
// cannot detect is worse than a rejection it can retry.
//
// ## Why the page never names a project root or a lane
//
// Every `ios_simulator` verb that builds takes an optional `projectRoot` /
// `laneId` pair, and a page that could send its own would be a page that could
// ask this machine to build any directory it can spell. Nothing here forwards
// one, and `page/src/host/actions.ts` has no argument for either — so the host
// resolves the build root from the project this plugin is bound to, which is
// the same resolution the compiled pane got from its chat's runtime scope.
//
// Sending `projectRoot: null` explicitly rather than omitting the key would be
// the same mistake in a different spelling: the host reads a present-and-null
// root as "no project", not as "use the default". Every argument below is
// omitted when it has no value.
//
// ## Why `deps` is read through getters
//
// `index.js` holds its collaborators in bindings that are null until `activate`
// runs, and this table is built at LOAD so a page that opens before `activate`
// resolves gets a real handler rather than "no such action". A table that
// captured them by value would capture the null; a handler that runs before the
// bindings exist answers its empty shape or `{ok: false, message}` instead.

"use strict";

/** The one sentence for a call that arrived before `activate` finished. */
const STARTING_UP = "iOS Sim Control is still starting up on this machine.";

/** The stream rate the compiled pane asked for, so the host gets the same one. */
const DEFAULT_STREAM_FPS = 60;

/** Capture backend the host window-capture engine implements. */
const STREAM_BACKEND = "simulator-window-capture";

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finite(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function coordinate(value) {
  const numeric = finite(value);
  return numeric === null ? null : Math.round(numeric);
}

function failure(error, fallback) {
  const message = error?.message ?? (typeof error === "string" ? error : null);
  return { ok: false, message: message && message.trim() ? message.trim() : fallback };
}

/**
 * A device udid the page named, or nothing.
 *
 * Nothing is a real answer and the common one: the host resolves the booted
 * device itself, and a page that had to know the udid before it could read the
 * status would have nothing to read it from.
 */
function deviceArg(args) {
  const udid = text(args?.deviceUdid);
  return udid ? { deviceUdid: udid } : {};
}

/**
 * Build the page table.
 *
 * `deps` carries live getters onto `index.js`'s bindings plus the two functions
 * this half needs from it: `invokeSim` (the `ios_simulator` domain call, which
 * is where the project pin lives) and `refresh` (republish the status row, so a
 * page mutation reaches the panel every other client draws).
 */
function createPageActions(deps) {
  function ready() {
    return Boolean(deps.sdk);
  }

  /** One `ios_simulator` verb. The host scopes it to this plugin's project. */
  function sim(action, args = {}) {
    return deps.invokeSim(action, args);
  }

  /** A key that is present only when it has a value. See the header. */
  function when(key, value) {
    return value === null || value === undefined ? {} : { [key]: value };
  }

  /**
   * A mutation, wrapped once.
   *
   * Every mutating handler below is this shape, so the "never throw for a
   * refusal" rule is kept in ONE place rather than in twenty `try`/`catch`
   * blocks that could each forget it.
   */
  async function mutate(fallback, run) {
    if (!ready()) return { ok: false, message: STARTING_UP };
    try {
      const result = await run();
      return { ok: true, ...(result ?? {}) };
    } catch (error) {
      return failure(error, fallback);
    }
  }

  const pageActions = {
    /* ── Reads that degrade ───────────────────────────────────────────── */

    async pageStatus() {
      if (!ready()) return null;
      try {
        return (await sim("getStatus", {})) ?? null;
      } catch {
        // The pane draws its four setup chips from a null status as "unknown",
        // which is the honest reading of "this machine did not answer".
        return null;
      }
    },

    async pageDevices() {
      if (!ready()) return [];
      try {
        const devices = await sim("listDevices", {});
        return Array.isArray(devices) ? devices : [];
      } catch {
        return [];
      }
    },

    async pageLaunchTargets(args = {}) {
      if (!ready()) return [];
      try {
        const targets = await sim("listLaunchTargets", deviceArg(args));
        return Array.isArray(targets) ? targets : [];
      } catch {
        // "No launchable app found" is what the row prints either way, and a
        // project with no Xcode project in it is the common case, not an error.
        return [];
      }
    },

    async pageStreamStatus() {
      if (!ready()) return null;
      try {
        return (await sim("getStreamStatus", {})) ?? null;
      } catch {
        return null;
      }
    },

    async pagePreviewCapability() {
      if (!ready()) return null;
      try {
        return (await sim("getPreviewCapability", {})) ?? null;
      } catch {
        // Preview Lab's own status line reads a null capability as "checking",
        // then as the setup card. Neither is a crash.
        return null;
      }
    },

    async pagePreviewTargets(args = {}) {
      if (!ready()) return [];
      try {
        const targets = await sim("listPreviewTargets", {
          ...when("sourceFile", text(args?.sourceFile)),
          ...when("sourceLine", finite(args?.sourceLine)),
        });
        return Array.isArray(targets) ? targets : [];
      } catch {
        return [];
      }
    },

    /* ── Reads that reject ────────────────────────────────────────────── */

    async pageScreenSnapshot(args = {}) {
      if (!ready()) throw new Error(STARTING_UP);
      return await sim("getScreenSnapshot", {
        ...deviceArg(args),
        ...(coordinate(args?.x) === null ? {} : { x: coordinate(args.x) }),
        ...(coordinate(args?.y) === null ? {} : { y: coordinate(args.y) }),
      });
    },

    async pageInspectorSnapshot(args = {}) {
      if (!ready()) throw new Error(STARTING_UP);
      return await sim("getInspectorSnapshot", deviceArg(args));
    },

    async pageScreenshot(args = {}) {
      if (!ready()) throw new Error(STARTING_UP);
      return await sim("screenshot", deviceArg(args));
    },

    async pageResolvePreviewMatch(args = {}) {
      if (!ready()) throw new Error(STARTING_UP);
      return await sim("resolvePreviewMatch", {
        ...when("sourceFile", text(args?.sourceFile)),
        ...when("sourceLine", finite(args?.sourceLine)),
        ...when("elementLabel", text(args?.elementLabel)),
        ...when("componentId", text(args?.componentId)),
      });
    },

    /* ── The session ──────────────────────────────────────────────────── */

    async pageLaunch(args = {}) {
      const result = await mutate("Could not launch the app.", async () => {
        const session = await sim("launch", {
          ...deviceArg(args),
          ...(text(args?.targetId) ? { targetId: text(args.targetId) } : {}),
          ...(text(args?.previewTargetId) ? { previewTargetId: text(args.previewTargetId) } : {}),
        });
        return {
          session: session ?? null,
          buildRoot: session?.buildRoot ?? null,
          usedInstalledBinary: session?.usedInstalledBinary === true,
          message: session?.usedInstalledBinary === true
            // The compiled pane drew this as a chip beside the toolbar. It is
            // the difference between "your change is running" and "an app that
            // predates your change is running", so it is never silent.
            ? "Launched the installed app — nothing was rebuilt, so recent changes are not included."
            : "Launched.",
        };
      });
      if (result.ok) await deps.refresh().catch(() => {});
      return result;
    },

    async pageShutdown(args = {}) {
      const result = await mutate("Could not stop the simulator.", async () => {
        const stopped = await sim("shutdown", {
          ...(args?.force === true ? { force: true } : {}),
          // The pane drives whatever session its project is running and hides
          // the ownership card for it, so it says so rather than replaying the
          // owner's id back as its own — which is the impersonation the host's
          // own `ignoreOwnership` flag exists to replace.
          ignoreOwnership: true,
        });
        return {
          released: stopped?.released === true,
          message: stopped?.released === true ? "Stopped." : "There was nothing running.",
        };
      });
      if (result.ok) await deps.refresh().catch(() => {});
      return result;
    },

    async pageAttachChat(args = {}) {
      const result = await mutate("Could not attach to that session.", async () => {
        const session = await sim("attachToChatSession", {
          chatSessionId: text(args?.chatSessionId) ?? null,
          ...(args?.takeOver === true ? { takeOver: true } : {}),
        });
        return {
          session: session ?? null,
          message: args?.takeOver === true ? "Took the session over." : "Attached.",
        };
      });
      if (result.ok) await deps.refresh().catch(() => {});
      return result;
    },

    /* ── The stream ───────────────────────────────────────────────────── */

    async pageStartStream(args = {}) {
      return await mutate("Could not start the live screen.", async () => {
        const status = await sim("startStream", {
          ...deviceArg(args),
          backend: STREAM_BACKEND,
          fps: finite(args?.fps) ?? DEFAULT_STREAM_FPS,
        });
        return {
          status: status ?? null,
          // The host's own blocker sentence when there is one — a denied Screen
          // Recording grant, a Simulator window nobody can see — because it is
          // the only half that knows which.
          message: status?.message ?? null,
        };
      });
    },

    async pageStopStream() {
      return await mutate("Could not stop the live screen.", async () => {
        const status = await sim("stopStream", {});
        return { status: status ?? null, message: null };
      });
    },

    /* ── Control mode ─────────────────────────────────────────────────── */

    async pageTap(args = {}) {
      const x = coordinate(args?.x);
      const y = coordinate(args?.y);
      if (x === null || y === null) return { ok: false, message: "That tap had no coordinates." };
      return await mutate("Could not tap the simulator.", async () => {
        await sim("tap", { ...deviceArg(args), x, y });
        return { message: null };
      });
    },

    async pageTypeText(args = {}) {
      const value = typeof args?.text === "string" ? args.text : null;
      if (!value) return { ok: false, message: "There was nothing to type." };
      return await mutate("Could not type into the simulator.", async () => {
        await sim("typeText", { ...deviceArg(args), text: value });
        return { message: null };
      });
    },

    async pageDrag(args = {}) {
      return await dragLike("drag", args, "Could not drag in the simulator.");
    },

    async pageSwipe(args = {}) {
      return await dragLike("swipe", args, "Could not swipe in the simulator.");
    },

    /* ── Inspect mode ─────────────────────────────────────────────────── */

    async pageSelectPoint(args = {}) {
      const x = coordinate(args?.x);
      const y = coordinate(args?.y);
      if (x === null || y === null) return { ok: false, message: "That point had no coordinates." };
      return await mutate("Could not inspect that point.", async () => {
        const result = await sim("selectPoint", { ...deviceArg(args), x, y });
        return {
          element: result?.item ?? null,
          source: result?.source ?? "none",
          message: result?.item ? null : "No element at that point.",
        };
      });
    },

    async pageInspectPoint(args = {}) {
      const x = coordinate(args?.x);
      const y = coordinate(args?.y);
      if (x === null || y === null) return { ok: false, message: "That point had no coordinates." };
      return await mutate("Could not inspect that point.", async () => {
        const result = await sim("inspectPoint", { ...deviceArg(args), x, y });
        return { result: result ?? null, message: null };
      });
    },

    /* ── Preview Lab ──────────────────────────────────────────────────── */

    async pageEnsurePreviewWorkspace(args = {}) {
      return await mutate("Could not reach the Xcode preview bridge.", async () => {
        const workspace = await sim("ensurePreviewWorkspace", {
          ...when("sourceFile", text(args?.sourceFile)),
          ...when("sourceLine", finite(args?.sourceLine)),
          openIfNeeded: args?.openIfNeeded === true,
        });
        return {
          // `ok` on the ENVELOPE is "the call ran". The workspace's own `ok` is
          // "Xcode answered", and those are different facts: a Mac with Xcode
          // closed answers perfectly well and says no.
          capability: workspace?.capability ?? null,
          opened: workspace?.opened === true,
          path: workspace?.path ?? null,
          ...(workspace?.ok === false
            ? { ok: false, message: workspace?.error ?? "Xcode did not answer." }
            : { message: null }),
        };
      });
    },

    async pageRenderPreview(args = {}) {
      const sourceFilePath = text(args?.sourceFilePath);
      if (!sourceFilePath) return { ok: false, message: "No #Preview was selected." };
      return await mutate("The preview did not render.", async () => {
        const preview = await sim("renderPreview", {
          sourceFilePath,
          ...when("previewDefinitionIndexInFile", finite(args?.previewDefinitionIndexInFile)),
          ...when("tabIdentifier", text(args?.tabIdentifier)),
          // The host's renderer takes an element list to annotate. The page has
          // no inspector tree of its own to send, so it sends none rather than
          // a shape it invented.
          elements: [],
        });
        return { preview: preview ?? null, message: preview?.error ?? null };
      });
    },

    async pageRenderCurrentPreview(args = {}) {
      return await mutate("The preview did not render.", async () => {
        const preview = await sim("renderCurrentPreview", {
          ...when("tabIdentifier", text(args?.tabIdentifier)),
        });
        return { preview: preview ?? null, message: preview?.error ?? null };
      });
    },

    async pageOpenPreviewWorkspace() {
      return await mutate("Could not open the Xcode workspace.", async () => {
        const opened = await sim("openPreviewWorkspace", {});
        return { path: opened?.path ?? null, message: null };
      });
    },
  };

  /**
   * `drag` and `swipe`, which differ only in the verb.
   *
   * Both take the same four coordinates and both refuse the same way, so they
   * are one function rather than two copies that could drift on the guard.
   */
  async function dragLike(action, args, fallback) {
    const fromX = coordinate(args?.fromX);
    const fromY = coordinate(args?.fromY);
    const toX = coordinate(args?.toX);
    const toY = coordinate(args?.toY);
    if (fromX === null || fromY === null || toX === null || toY === null) {
      return { ok: false, message: "That gesture had no coordinates." };
    }
    return await mutate(fallback, async () => {
      await sim(action, {
        ...deviceArg(args),
        fromX,
        fromY,
        toX,
        toY,
        ...(finite(args?.durationMs) === null ? {} : { durationMs: finite(args.durationMs) }),
      });
      return { message: null };
    });
  }

  return pageActions;
}

/** Every id this table defines, for the manifest gate and for `test/`. */
const PAGE_ACTION_IDS = Object.freeze([
  "pageStatus",
  "pageDevices",
  "pageLaunchTargets",
  "pageStreamStatus",
  "pagePreviewCapability",
  "pagePreviewTargets",
  "pageScreenSnapshot",
  "pageInspectorSnapshot",
  "pageScreenshot",
  "pageResolvePreviewMatch",
  "pageLaunch",
  "pageShutdown",
  "pageAttachChat",
  "pageStartStream",
  "pageStopStream",
  "pageTap",
  "pageTypeText",
  "pageDrag",
  "pageSwipe",
  "pageSelectPoint",
  "pageInspectPoint",
  "pageEnsurePreviewWorkspace",
  "pageRenderPreview",
  "pageRenderCurrentPreview",
  "pageOpenPreviewWorkspace",
]);

/** The ids that must answer `{ok, message}` rather than throwing on a refusal. */
const PAGE_MUTATION_IDS = Object.freeze([
  "pageLaunch",
  "pageShutdown",
  "pageAttachChat",
  "pageStartStream",
  "pageStopStream",
  "pageTap",
  "pageTypeText",
  "pageDrag",
  "pageSwipe",
  "pageSelectPoint",
  "pageInspectPoint",
  "pageEnsurePreviewWorkspace",
  "pageRenderPreview",
  "pageRenderCurrentPreview",
  "pageOpenPreviewWorkspace",
]);

module.exports = {
  DEFAULT_STREAM_FPS,
  PAGE_ACTION_IDS,
  PAGE_MUTATION_IDS,
  STREAM_BACKEND,
  createPageActions,
};

"use strict";

/**
 * The child half of the seam.
 *
 * `page/test/seam.test.tsx` walks the PAGE against a scripted child. This walks
 * the CHILD against a scripted host, and the two together are the whole contract:
 * an id in one and not the other fails here or there, and never in production.
 *
 * The rule this file exists to hold is the one a reader feels: a mutation that
 * the host refused answers `{ok: false, message}` and does NOT throw, because a
 * rejected promise reaches the page as an exception beside a form it has already
 * filled in.
 */

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { createPageActions } = require("../pageActions");
const plugin = require("../index");

/** The seven mutations. Every one of them answers `{ok, message}`. */
const MUTATIONS = [
  ["pageLaunch", { command: "pnpm dev" }, "launchInTerminal"],
  ["pageConnect", { cdpPort: 9222 }, "connect"],
  ["pageStop", {}, "stop"],
  ["pageAttachTarget", { targetId: "target-a" }, "attachToTarget"],
  ["pageFocusWindow", {}, "focusWindow"],
  ["pageMinimizeWindow", {}, "minimizeWindow"],
  ["pageClick", { x: 1, y: 2 }, "click"],
  ["pageScroll", { x: 1, y: 2, deltaY: 120 }, "scroll"],
  ["pageTypeText", { text: "hello" }, "typeText"],
  ["pageAttachContext", { item: { id: "context-1" } }, "attachContext"],
];

/** The five reads. */
const READS = ["pageStatus", "pageTargets", "pageSnapshot", "pageInspectPoint", "pageSelectPoint"];

function createDeps(invoke) {
  const calls = [];
  const sdk = {
    log() {},
    actions: {
      async invoke(domain, action, args) {
        calls.push({ domain, action, args });
        return invoke ? await invoke(domain, action, args) : {};
      },
    },
  };
  return { deps: { get sdk() { return sdk; } }, calls };
}

describe("the page action table", () => {
  it("defines every id the page's host-call map names, and nothing else", () => {
    const { deps } = createDeps();
    const ids = Object.keys(createPageActions(deps)).sort();
    assert.deepEqual(ids, [
      "pageAttachContext",
      "pageAttachTarget",
      "pageClick",
      "pageConnect",
      "pageFocusWindow",
      "pageInspectPoint",
      "pageLaunch",
      "pageMinimizeWindow",
      "pageScroll",
      "pageSelectPoint",
      "pageSnapshot",
      "pageStatus",
      "pageStop",
      "pageTargets",
      "pageTypeText",
    ]);
  });

  it("merges into the plugin's action table without colliding with the manifest half", () => {
    const { deps } = createDeps();
    const pageIds = Object.keys(createPageActions(deps));
    const ownIds = ["refreshStatus", "openControl", "getStatusTool"];
    for (const id of pageIds) {
      assert.ok(id in plugin.actions, `${id} is missing from exports.actions`);
      assert.ok(!ownIds.includes(id), `${id} collides with the manifest half`);
    }
    for (const id of ownIds) {
      assert.ok(id in plugin.actions, `${id} is missing from exports.actions`);
    }
  });

  it("routes every id at the app_control action domain", async () => {
    const { deps, calls } = createDeps(async (_domain, action) => {
      if (action === "getSnapshot" || action === "inspectPoint" || action === "selectPoint") {
        return { snapshot: { elements: [], screenshot: { dataUrl: "data:image/png;base64,AAA" } } };
      }
      return {};
    });
    const actions = createPageActions(deps);
    for (const [id, args] of MUTATIONS) {
      await actions[id](args);
    }
    await actions.pageStatus();
    await actions.pageTargets();
    await actions.pageSnapshot({});
    await actions.pageInspectPoint({ x: 1, y: 2 });
    await actions.pageSelectPoint({ x: 1, y: 2 });
    assert.equal(calls.length, MUTATIONS.length + READS.length);
    for (const call of calls) assert.equal(call.domain, "app_control");
    const hostVerbs = calls.map((call) => call.action);
    for (const [, , verb] of MUTATIONS) assert.ok(hostVerbs.includes(verb), `${verb} was never invoked`);
  });

  it("answers {ok:false, message} instead of throwing when the host refuses", async () => {
    const { deps } = createDeps(async () => {
      throw new Error("The renderer is not accepting input.");
    });
    const actions = createPageActions(deps);
    for (const [id, args] of MUTATIONS) {
      const result = await actions[id](args);
      assert.equal(result.ok, false, `${id} did not answer ok:false`);
      assert.equal(result.message, "The renderer is not accepting input.", `${id} lost the host's sentence`);
    }
  });

  it("answers {ok:false, message} for its own argument refusals, without asking the host", async () => {
    const { deps, calls } = createDeps();
    const actions = createPageActions(deps);
    const refusals = [
      [await actions.pageLaunch({ command: "   " }), "Enter a launch command."],
      [await actions.pageConnect({ cdpPort: "not-a-port" }), "Enter a valid CDP port."],
      [await actions.pageConnect({ cdpPort: 0 }), "Enter a valid CDP port."],
      [await actions.pageAttachTarget({}), "Pick a window to attach to."],
      [await actions.pageClick({ x: 1 }), "Click needs an x and a y."],
      [await actions.pageScroll({ x: 1, y: 2 }), "Scroll needs a non-zero amount."],
      [await actions.pageTypeText({ text: "  " }), "Enter some text to type."],
      [await actions.pageAttachContext({ item: {} }), "Nothing is selected to attach."],
    ];
    for (const [result, message] of refusals) {
      assert.equal(result.ok, false);
      assert.equal(result.message, message);
    }
    // Nothing reached the host: a refusal the child can see is a refusal the
    // child answers, not a round trip that fails somewhere else.
    assert.equal(calls.length, 0);
  });

  it("refuses a launch whose session reports its own failure", async () => {
    const { deps } = createDeps(async () => ({
      id: "session-1",
      label: "pnpm dev",
      status: "failed",
      lastError: "Port 9222 is already in use.",
    }));
    const actions = createPageActions(deps);
    const result = await actions.pageLaunch({ command: "pnpm dev" });
    assert.equal(result.ok, false);
    assert.equal(result.message, "Port 9222 is already in use.");
    // And the session still comes back, because the page redraws the status pill
    // from it either way.
    assert.equal(result.session.status, "failed");
  });

  it("degrades pageStatus rather than throwing, and names why the machine cannot drive", async () => {
    const { deps } = createDeps(async () => {
      throw new Error("No Electron Control on this host.");
    });
    const status = await createPageActions(deps).pageStatus();
    assert.equal(status.supported, false);
    assert.equal(status.activeSession, null);
    assert.equal(status.disabledReason, "No Electron Control on this host.");
  });

  it("fills disabledReason for an unsupported host that answered cleanly", async () => {
    const { deps } = createDeps(async () => ({ platform: "linux", supported: false, activeSession: null }));
    const status = await createPageActions(deps).pageStatus();
    assert.equal(status.supported, false);
    assert.match(status.disabledReason, /computer this project is attached to/);
  });

  it("leaves disabledReason null on a machine that can drive", async () => {
    const { deps } = createDeps(async () => ({ platform: "darwin", supported: true, activeSession: null }));
    const status = await createPageActions(deps).pageStatus();
    assert.equal(status.supported, true);
    assert.equal(status.disabledReason, null);
  });

  it("degrades pageTargets to an empty list", async () => {
    const { deps } = createDeps(async () => {
      throw new Error("nope");
    });
    assert.deepEqual(await createPageActions(deps).pageTargets(), []);
    const shaped = createPageActions(createDeps(async () => "not an array").deps);
    assert.deepEqual(await shaped.pageTargets(), []);
  });

  it("strips the screenshot from every read that carries one", async () => {
    const { deps } = createDeps(async (_domain, action) => {
      const snapshot = {
        elements: [],
        screenshot: { dataUrl: "data:image/png;base64,AAA", width: 10, height: 10 },
        url: "http://localhost:5173/",
      };
      if (action === "getSnapshot") return snapshot;
      return { item: null, source: "none", snapshot };
    });
    const actions = createPageActions(deps);
    const snapshot = await actions.pageSnapshot({});
    assert.equal(snapshot.screenshot, undefined);
    assert.equal(snapshot.url, "http://localhost:5173/");
    for (const id of ["pageInspectPoint", "pageSelectPoint"]) {
      const result = await actions[id]({ x: 1, y: 2 });
      assert.equal(result.snapshot.screenshot, undefined);
      assert.equal(result.snapshot.url, "http://localhost:5173/");
    }
  });

  it("throws on the three reads that have nowhere honest to degrade to", async () => {
    const { deps } = createDeps(async () => {
      throw new Error("The renderer went away.");
    });
    const actions = createPageActions(deps);
    await assert.rejects(() => actions.pageSnapshot({}), /The renderer went away/);
    await assert.rejects(() => actions.pageInspectPoint({ x: 1, y: 2 }), /The renderer went away/);
    await assert.rejects(() => actions.pageSelectPoint({ x: 1, y: 2 }), /The renderer went away/);
    await assert.rejects(() => actions.pageInspectPoint({ y: 2 }), /needs an x and a y/);
    await assert.rejects(() => actions.pageSelectPoint({ x: 1 }), /needs an x and a y/);
  });

  it("narrows an unknown coordinate space to viewport rather than passing it through", async () => {
    const { deps, calls } = createDeps();
    const actions = createPageActions(deps);
    await actions.pageClick({ x: 1, y: 2, coordinateSpace: "whatever" });
    await actions.pageScroll({ x: 1, y: 2, deltaY: 1, coordinateSpace: "screenshot" });
    assert.equal(calls[0].args.coordinateSpace, "viewport");
    // `screenshot` is a real space and survives; only the unknown is narrowed.
    assert.equal(calls[1].args.coordinateSpace, "screenshot");
  });

  it("answers every handler without a bound sdk rather than crashing the page", async () => {
    const actions = createPageActions({ get sdk() { return null; } });
    for (const [id, args] of MUTATIONS) {
      const result = await actions[id](args);
      assert.equal(result.ok, false, `${id} did not refuse`);
      assert.ok(result.message, `${id} refused with no sentence`);
    }
    const status = await actions.pageStatus();
    assert.equal(status.supported, false);
    assert.match(status.disabledReason, /starting up/);
    assert.deepEqual(await actions.pageTargets(), []);
    await assert.rejects(() => actions.pageSnapshot({}), /starting up/);
  });

  it("never returns a credential-shaped field", async () => {
    const { deps } = createDeps(async () => ({ supported: true, activeSession: null, providers: [] }));
    const actions = createPageActions(deps);
    const answers = [
      await actions.pageStatus(),
      await actions.pageTargets(),
      ...(await Promise.all(MUTATIONS.map(([id, args]) => actions[id](args)))),
    ];
    const forbidden = /token|secret|password|credential|apikey|api_key/i;
    for (const answer of answers) {
      for (const key of Object.keys(answer ?? {})) {
        assert.ok(!forbidden.test(key), `a page action answered a ${key} field`);
      }
    }
  });
});

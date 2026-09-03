"use strict";

const assert = require("node:assert/strict");
const { afterEach, describe, it } = require("node:test");

const plugin = require("../index");
const {
  PAGE_ACTION_IDS,
  PAGE_MUTATION_IDS,
  STREAM_BACKEND,
  createPageActions,
} = require("../pageActions");
const { createSdk } = require("./support");

afterEach(async () => {
  await plugin.deactivate().catch(() => {});
});

/**
 * A table wired to a scripted `ios_simulator` domain.
 *
 * `calls` is the whole point: these handlers exist to translate a page's
 * argument shape into the domain's, and a translation that drifts is invisible
 * unless the test reads what was actually sent.
 */
function tableWith(invoke, { sdk = {} } = {}) {
  const calls = [];
  const actions = createPageActions({
    sdk,
    invokeSim: async (action, args) => {
      calls.push({ action, args });
      return await invoke(action, args);
    },
    refresh: async () => {},
  });
  return { actions, calls };
}

/** A table whose domain always throws, for the refusal rule. */
function refusingTable(message) {
  return tableWith(async () => {
    throw new Error(message);
  });
}

describe("the page action table", () => {
  it("defines every id the page can invoke, and no id twice", () => {
    const { actions } = tableWith(async () => null);
    const defined = Object.keys(actions).sort();
    assert.deepEqual(defined, [...PAGE_ACTION_IDS].sort());
    assert.equal(new Set(PAGE_ACTION_IDS).size, PAGE_ACTION_IDS.length);
    assert.equal(PAGE_ACTION_IDS.length, 25);
    for (const id of PAGE_ACTION_IDS) {
      assert.equal(typeof actions[id], "function", `${id} is not a handler`);
    }
  });

  it("merges into the plugin's own table without colliding with it", () => {
    // The invariant the merge order in `index.js` is a belt on rather than the
    // thing that decides which copy runs.
    const own = ["refreshStatus", "openSimulator", "getStatusTool"];
    for (const id of own) {
      assert.ok(!PAGE_ACTION_IDS.includes(id), `${id} is defined by both halves`);
      assert.equal(typeof plugin.actions[id], "function");
    }
    for (const id of PAGE_ACTION_IDS) {
      assert.equal(typeof plugin.actions[id], "function", `${id} is not dispatchable`);
    }
  });

  it("every mutation answers {ok:false, message} rather than throwing", async () => {
    const { actions } = refusingTable("The simulator is in use by another chat.");
    for (const id of PAGE_MUTATION_IDS) {
      // Arguments every mutation needs to get PAST its own shape guard and
      // actually reach the refusing domain — the guard's own refusal is the
      // next test.
      const args = {
        x: 10,
        y: 20,
        fromX: 1,
        fromY: 2,
        toX: 3,
        toY: 4,
        text: "hello",
        sourceFilePath: "Sources/ContentView.swift",
      };
      const result = await actions[id](args);
      assert.equal(result.ok, false, `${id} did not refuse`);
      assert.equal(
        result.message,
        "The simulator is in use by another chat.",
        `${id} lost the host's own sentence`,
      );
    }
  });

  it("a mutation with no coordinates refuses without asking the machine", async () => {
    const { actions, calls } = tableWith(async () => ({ ok: true }));
    for (const id of ["pageTap", "pageSelectPoint", "pageInspectPoint"]) {
      const result = await actions[id]({});
      assert.equal(result.ok, false, `${id} accepted a point with no coordinates`);
      assert.match(result.message, /coordinates/);
    }
    for (const id of ["pageDrag", "pageSwipe"]) {
      const result = await actions[id]({ fromX: 1 });
      assert.equal(result.ok, false, `${id} accepted a half-specified gesture`);
    }
    assert.equal((await actions.pageTypeText({})).ok, false);
    assert.equal((await actions.pageRenderPreview({})).ok, false);
    assert.deepEqual(calls, [], "a refused shape still reached the machine");
  });

  it("a read that degrades answers an empty shape rather than throwing", async () => {
    const { actions } = refusingTable("This machine did not answer.");
    assert.equal(await actions.pageStatus(), null);
    assert.deepEqual(await actions.pageDevices(), []);
    assert.deepEqual(await actions.pageLaunchTargets(), []);
    assert.equal(await actions.pageStreamStatus(), null);
    assert.equal(await actions.pagePreviewCapability(), null);
    assert.deepEqual(await actions.pagePreviewTargets(), []);
  });

  it("a read that must not lie rejects instead", async () => {
    const { actions } = refusingTable("The inspector did not answer.");
    for (const id of [
      "pageScreenSnapshot",
      "pageInspectorSnapshot",
      "pageScreenshot",
      "pageResolvePreviewMatch",
    ]) {
      await assert.rejects(actions[id]({}), /did not answer/, `${id} degraded a read it must not`);
    }
  });

  it("never sends a project root, a lane, or a null-valued optional", async () => {
    const { actions, calls } = tableWith(async () => ({}));
    await actions.pageLaunchTargets({});
    await actions.pagePreviewTargets({});
    await actions.pageResolvePreviewMatch({});
    await actions.pageRenderCurrentPreview({});
    await actions.pageOpenPreviewWorkspace();
    for (const call of calls) {
      assert.ok(!("projectRoot" in call.args), `${call.action} named a build root`);
      assert.ok(!("laneId" in call.args), `${call.action} named a lane`);
      for (const [key, value] of Object.entries(call.args)) {
        assert.notEqual(value, null, `${call.action} sent ${key}: null`);
        assert.notEqual(value, undefined, `${call.action} sent ${key}: undefined`);
      }
    }
  });

  it("translates the page's argument shapes into the domain's", async () => {
    const { actions, calls } = tableWith(async (action) => {
      if (action === "launch") return { id: "s1", usedInstalledBinary: false, buildRoot: "/repo" };
      if (action === "shutdown") return { released: true };
      if (action === "selectPoint") return { item: { id: "e1" }, source: "ade-inspector" };
      return {};
    });

    await actions.pageLaunch({ deviceUdid: " UDID-1 ", targetId: "t1" });
    assert.deepEqual(calls.at(-1), {
      action: "launch",
      // Trimmed, and `previewTargetId` absent rather than null.
      args: { deviceUdid: "UDID-1", targetId: "t1" },
    });

    await actions.pageStartStream({ deviceUdid: "UDID-1" });
    assert.deepEqual(calls.at(-1).args, {
      deviceUdid: "UDID-1",
      backend: STREAM_BACKEND,
      fps: 60,
    });

    await actions.pageDrag({ fromX: "10", fromY: 20.4, toX: 30, toY: 40, durationMs: 250 });
    assert.deepEqual(calls.at(-1).args, {
      fromX: 10,
      fromY: 20,
      toX: 30,
      toY: 40,
      durationMs: 250,
    });

    // The page's `element` is the domain's `item`. The two names are the seam,
    // and a rename on either side is exactly what this asserts.
    const selected = await actions.pageSelectPoint({ x: 5, y: 6 });
    assert.deepEqual(selected.element, { id: "e1" });

    // Shutdown says what it means rather than impersonating the owner.
    await actions.pageShutdown();
    assert.deepEqual(calls.at(-1).args, { ignoreOwnership: true });
  });

  it("says so when a launch reused the installed binary", async () => {
    const { actions } = tableWith(async () => ({ id: "s1", usedInstalledBinary: true }));
    const result = await actions.pageLaunch({ targetId: "t1" });
    assert.equal(result.ok, true);
    assert.equal(result.usedInstalledBinary, true);
    assert.match(result.message, /nothing was rebuilt/i);
  });

  it("carries Xcode's own refusal through an ensurePreviewWorkspace that ran", async () => {
    // The call succeeded and the workspace said no. Those are different facts,
    // and reporting the first as `ok: true` would hide the second.
    const { actions } = tableWith(async () => ({
      ok: false,
      opened: false,
      path: null,
      capability: { supported: false },
      error: "Xcode is not running.",
    }));
    const result = await actions.pageEnsurePreviewWorkspace({});
    assert.equal(result.ok, false);
    assert.equal(result.message, "Xcode is not running.");
    assert.deepEqual(result.capability, { supported: false });
  });

  it("answers a page that opened before activate, without a throw", async () => {
    const { actions } = tableWith(async () => ({}), { sdk: null });
    assert.equal(await actions.pageStatus(), null);
    assert.deepEqual(await actions.pageDevices(), []);
    const refused = await actions.pageLaunch({ targetId: "t1" });
    assert.equal(refused.ok, false);
    assert.match(refused.message, /still starting up/i);
    await assert.rejects(actions.pageScreenshot({}), /still starting up/i);
  });

  it("republishes the status row after a mutation that changed the session", async () => {
    const sdk = createSdk({
      actions: {
        invoke: async (domain, action) => {
          assert.equal(domain, "ios_simulator");
          if (action === "launch") return { id: "s1" };
          return { supported: true, platform: "darwin", activeSession: { deviceName: "iPhone 16" } };
        },
      },
    });
    await plugin.activate(sdk);
    const result = await plugin.actions.pageLaunch({ targetId: "t1" });
    assert.equal(result.ok, true);
    // The panel every other client draws now says the session is live, which is
    // the whole reason a page mutation republishes.
    const stored = await sdk.collections.list("status");
    assert.equal(stored[0].value.live, "yes");
  });
});

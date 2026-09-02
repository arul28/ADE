"use strict";

const assert = require("node:assert/strict");
const { afterEach, describe, it } = require("node:test");

const plugin = require("../index");
const { createSdk } = require("./support");

afterEach(async () => {
  await plugin.deactivate().catch(() => {});
});

/**
 * `record_feedback`, from both callers that reach it.
 *
 * The agent tool declares a flat `suppressionScope` and the panel button builds
 * a nested `{suppression: {scope}}`. Only the second was ever forwarded, so a
 * model that asked to suppress one PATH silenced the whole repo — the widest
 * possible answer, delivered silently.
 */
async function activateWith(recordFeedback) {
  const sdk = createSdk({ review: { recordFeedback } });
  await plugin.activate(sdk);
  return sdk;
}

describe("record_feedback suppression scope", () => {
  it("maps the tool's flat suppressionScope onto suppression.scope", async () => {
    const calls = [];
    await activateWith(async (args) => {
      calls.push(args);
      return args;
    });

    const result = await plugin.actions.recordFeedback({
      findingId: "finding-1",
      kind: "suppress",
      suppressionScope: "path",
    });

    assert.equal(result.ok, undefined);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].suppression, { scope: "path" });
  });

  it("keeps the panel's nested suppression when both shapes arrive", async () => {
    const calls = [];
    await activateWith(async (args) => {
      calls.push(args);
      return args;
    });

    await plugin.actions.recordFeedback({
      findingId: "finding-1",
      kind: "suppress",
      suppression: { scope: "global" },
      suppressionScope: "repo",
    });

    assert.deepEqual(calls[0].suppression, { scope: "global" });
  });

  it("refuses an unknown scope rather than widening it to the repo", async () => {
    const calls = [];
    await activateWith(async (args) => {
      calls.push(args);
      return args;
    });

    const result = await plugin.actions.recordFeedback({
      findingId: "finding-1",
      kind: "suppress",
      suppressionScope: "everything",
    });

    assert.equal(result.ok, false);
    assert.match(result.message, /repo, path, or global/);
    assert.equal(calls.length, 0, "nothing reaches the host on a refused scope");
  });

  it("sends no suppression when neither shape was given", async () => {
    const calls = [];
    await activateWith(async (args) => {
      calls.push(args);
      return args;
    });

    await plugin.actions.recordFeedback({ findingId: "finding-1", kind: "acknowledge" });
    assert.equal(calls[0].suppression, null);
  });
});

"use strict";

// What pressing Dictate does, proven without a microphone or a Mac.
//
// The collaborators are stubs on purpose: the real ones are covered elsewhere
// (`engine.test.js` for the sentences, the model store for the download, and a
// live run against the real binary for whisper itself). What is asserted here
// is the ORDER and the ENDINGS, which is where a dictation flow actually goes
// wrong — recording before it can transcribe, showing an error for a cancel,
// or leaving the user's voice on disk after a failure.

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { runDictate } = require("../dictateFlow");
const { captureFailure, captureUnavailableError } = require("../engine");

/** Records what happened, in order, so sequencing can be asserted. */
function harness(overrides = {}) {
  const calls = [];
  const discarded = [];
  return {
    calls,
    discarded,
    flow: {
      ensureReady: overrides.ensureReady ?? (() => {
        calls.push("ensureReady");
      }),
      capture: overrides.capture ?? (async () => {
        calls.push("capture");
        return { audioPath: "/tmp/clip.wav", durationMs: 2_000 };
      }),
      transcribe: overrides.transcribe ?? (async (audioPath) => {
        calls.push(`transcribe:${audioPath}`);
        return { text: "ship the lane" };
      }),
      discard: overrides.discard ?? (async (audioPath) => {
        calls.push("discard");
        discarded.push(audioPath);
      }),
      onCancelled: overrides.onCancelled,
    },
  };
}

describe("pressing Dictate", () => {
  it("hands the words to the composer as an insert", async () => {
    const { flow, calls, discarded } = harness();

    assert.deepEqual(await runDictate(flow), { composer: { insertText: "ship the lane" } });
    assert.deepEqual(calls, ["ensureReady", "capture", "transcribe:/tmp/clip.wav", "discard"]);
    assert.deepEqual(discarded, ["/tmp/clip.wav"]);
  });

  it("proves it can transcribe BEFORE it opens the microphone", async () => {
    const { flow, calls } = harness({
      ensureReady: () => {
        calls.push("ensureReady");
        throw new Error("The speech model is still downloading.");
      },
    });

    await assert.rejects(runDictate(flow), /still downloading/);
    // The whole point: nothing was recorded, so the user has not lost a word.
    assert.deepEqual(calls, ["ensureReady"]);
  });

  it("returns quietly when the user cancels, with no composer verb", async () => {
    let noted = false;
    const { flow, calls } = harness({
      capture: async () => {
        calls.push("capture");
        return null;
      },
      onCancelled: () => {
        noted = true;
      },
    });

    const result = await runDictate(flow);
    assert.deepEqual(result, { cancelled: true });
    // No `composer` key at all — the invoke path finds no verb and does nothing,
    // which is what "the user sees nothing" means on the other side.
    assert.equal("composer" in result, false);
    assert.equal(noted, true);
    // Nothing was recorded, so there is nothing to discard.
    assert.deepEqual(calls, ["ensureReady", "capture"]);
  });

  it("passes a busy microphone through as plain words", async () => {
    const { flow } = harness({
      capture: async () => {
        throw captureFailure({ code: "audio_capture_busy", message: "capture in progress" });
      },
    });

    await assert.rejects(runDictate(flow), (error) => {
      assert.equal(error.code, "voice_capture_busy");
      assert.match(error.message, /already using the microphone/);
      assert.doesNotMatch(error.message, /audio_capture_busy/);
      return true;
    });
  });

  it("passes a host with no microphone capability through the same way", async () => {
    const { flow } = harness({
      capture: async () => {
        throw captureUnavailableError();
      },
    });

    await assert.rejects(runDictate(flow), (error) => {
      assert.equal(error.code, "voice_capture_unavailable");
      return true;
    });
  });

  it("says so when the clip held no words, rather than inserting nothing", async () => {
    const { flow, discarded } = harness({ transcribe: async () => ({ text: "" }) });

    await assert.rejects(runDictate(flow), (error) => {
      assert.equal(error.code, "voice_no_speech");
      return true;
    });
    // An empty insert is a no-op the user cannot tell from a broken button.
    assert.deepEqual(discarded, ["/tmp/clip.wav"], "and the silent clip is still deleted");
  });

  it("deletes the recording even when transcribing throws", async () => {
    const { flow, discarded } = harness({
      transcribe: async () => {
        throw new Error("whisper fell over");
      },
    });

    await assert.rejects(runDictate(flow), /whisper fell over/);
    // The privacy sentence has to hold on the failure paths too — they are the
    // ones nobody checks.
    assert.deepEqual(discarded, ["/tmp/clip.wav"]);
  });

  it("waits for the deletion before it resolves", async () => {
    let deleted = false;
    const { flow } = harness({
      discard: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        deleted = true;
      },
    });

    await runDictate(flow);
    // Fire-and-forget would make the package's own privacy claim true only
    // eventually, which is not what it says.
    assert.equal(deleted, true);
  });
});

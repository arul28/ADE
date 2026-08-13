"use strict";

// The packaged glossary and its deterministic cleanup.
//
// These assertions are a contract with ADE's iOS app as much as with this
// package: `DictationCleanup.swift` runs the same passes in the same order on
// the same file, so a change here that is not made there splits one feature
// into two behaviours.

const assert = require("node:assert/strict");
const path = require("node:path");
const { describe, it } = require("node:test");

const {
  EMPTY_GLOSSARY,
  capitalizeSentences,
  cleanTranscript,
  loadBundledGlossary,
  prepareGlossary,
} = require("../glossary");
const { buildWhisperArgs, finishTranscript, promptTerms } = require("../engine");

const PLUGIN_ROOT = path.resolve(__dirname, "..");

const sample = prepareGlossary({
  version: 1,
  contextualTerms: ["SwiftUI", "cr-sqlite"],
  corrections: { "work tree": "worktree", work: "Work", "cherry pick": "cherry-pick" },
  fillers: ["um", "you know"],
});

describe("the packaged glossary", () => {
  it("ships inside the plugin and parses", () => {
    const bundled = loadBundledGlossary(PLUGIN_ROOT, { reload: true });
    assert.ok(bundled.version >= 1);
    assert.ok(bundled.contextualTerms.length > 0, "contextual terms are the decoder bias");
    assert.ok(bundled.corrections.length > 0);
    assert.ok(bundled.fillers.length > 0);
  });

  it("is an empty glossary rather than a crash when the file is not there", () => {
    const missing = loadBundledGlossary("/nowhere/at/all", { reload: true });
    assert.deepEqual(missing, EMPTY_GLOSSARY);
    // Restore the cache for the tests that follow.
    loadBundledGlossary(PLUGIN_ROOT, { reload: true });
  });

  it("sorts corrections longest-first, which is what makes them composable", () => {
    assert.deepEqual(sample.corrections.map((c) => c.from), ["cherry pick", "work tree", "work"]);
  });
});

describe("the deterministic cleanup", () => {
  it("removes fillers only as standalone words", () => {
    assert.equal(cleanTranscript("um so we should um ship it", sample), "So we should ship it");
    assert.equal(cleanTranscript("the umbrella is fine", sample), "The umbrella is fine");
  });

  it("removes multi-word fillers, and the punctuation they leave stranded", () => {
    // whisper punctuates the filler as a parenthetical, so removing it would
    // otherwise leave ",," in the user's draft. Runs of `.` are NOT collapsed.
    assert.equal(cleanTranscript("it is, you know, ready", sample), "It is, ready");
    // The ellipsis survives as typed — only `,;:` collapse. The capital after it
    // is the shared iOS rule (every `.` starts a sentence), left alone on purpose.
    assert.equal(cleanTranscript("wait... then ship", sample), "Wait... Then ship");
  });

  it("applies the longest correction that matches", () => {
    assert.equal(cleanTranscript("the work tree is dirty", sample), "The worktree is dirty");
    assert.equal(cleanTranscript("open the work chat", sample), "Open the Work chat");
    assert.equal(cleanTranscript("cherry pick that commit", sample), "Cherry-pick that commit");
  });

  it("capitalizes each sentence and leaves the inside of words alone", () => {
    assert.equal(
      cleanTranscript("ship it. then tell me. openAI and SwiftUI stay as typed", sample),
      "Ship it. Then tell me. OpenAI and SwiftUI stay as typed",
    );
    assert.equal(capitalizeSentences("one. two! three? four"), "One. Two! Three? Four");
  });

  it("tidies the spacing fillers leave behind", () => {
    assert.equal(cleanTranscript("push it , then um  rebase .", sample), "Push it, then rebase.");
  });

  it("is empty for an empty transcript", () => {
    assert.equal(cleanTranscript("   ", sample), "");
    assert.equal(cleanTranscript(null, sample), "");
  });
});

describe("the glossary and the caller, together", () => {
  it("runs the packaged cleanup and then the caller's spelling", () => {
    // "work tree" is corrected by the package; "cr sqlite" is the caller's word.
    assert.equal(
      finishTranscript("um the work tree has cr-sqlite in it", ["cr-SQLite"], sample),
      "The worktree has cr-SQLite in it",
    );
  });

  it("lets the caller's spelling win over a packaged correction", () => {
    // The package lowercases nothing here, but the caller says "Work Tree" —
    // applied last, so the caller is what the user reads.
    assert.equal(finishTranscript("the work tree is dirty", ["Worktree"], sample), "The Worktree is dirty");
  });

  it("still works with no packaged glossary at all", () => {
    assert.equal(finishTranscript("ship it", [], EMPTY_GLOSSARY), "Ship it");
  });

  it("puts the caller's terms in front of the packaged ones in the prompt", () => {
    const terms = promptTerms(["Fable", "SwiftUI"], sample);
    assert.deepEqual(terms.slice(0, 2), ["Fable", "SwiftUI"]);
    assert.ok(terms.includes("cr-sqlite"), "packaged contextual terms fill the rest");
    // Deduped case-insensitively across both lists.
    assert.equal(terms.filter((term) => term.toLowerCase() === "swiftui").length, 1);
  });

  it("biases the decoder with both lists through one --prompt", () => {
    const args = buildWhisperArgs({
      modelPath: "/m.bin",
      audioPath: "/a.wav",
      outputBase: "/tmp/out",
      glossary: ["Fable"],
      bundled: sample,
    });
    const prompt = args[args.indexOf("--prompt") + 1];
    assert.match(prompt, /^Fable, /);
    assert.match(prompt, /cr-sqlite/);
  });
});

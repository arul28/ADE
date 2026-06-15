import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  cleanTranscript,
  prepareGlossary,
  type VoiceGlossary,
} from "./dictationCleanup";
import { buildWhisperArgs } from "./transcriptionService";

// Load the real shipped glossary so the table cases assert against the actual
// corrections/fillers users get, not a fixture that can drift.
const glossaryPath = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "resources",
  "voice",
  "voice-glossary.json",
);
const glossary = prepareGlossary(
  JSON.parse(fs.readFileSync(glossaryPath, "utf8")) as VoiceGlossary,
);

const clean = (raw: string): string => cleanTranscript(raw, glossary);

describe("desktop voice transcription", () => {
  describe("cleanTranscript", () => {
    it("corrects 'work tree' -> 'worktree'", () => {
      expect(clean("rebase the work tree")).toBe("Rebase the worktree");
    });

    it("corrects 'work trees' -> 'worktrees'", () => {
      expect(clean("list the work trees")).toBe("List the worktrees");
    });

    it("removes fillers and applies corrections + capitalization", () => {
      expect(clean("um so like rebase the codecs branch")).toBe(
        "So like rebase the Codex branch",
      );
    });

    it("capitalizes the first letter of each sentence after . ! ?", () => {
      expect(clean("rebase main. then run vitest. did it pass?")).toBe(
        "Rebase main. Then run vitest. Did it pass?",
      );
    });

    it("does not clobber correctly-cased canonical terms like OpenAI", () => {
      // "open ai" -> "OpenAI" via correction; an already-correct OpenAI stays put.
      expect(clean("ask open ai about OpenAI models")).toBe(
        "Ask OpenAI about OpenAI models",
      );
    });

    it("preserves internal casing of canonical replacements (SwiftUI)", () => {
      expect(clean("update the swift ui view")).toBe("Update the SwiftUI view");
    });

    it("matches corrections on word boundaries only (no mid-word clobber)", () => {
      // "codex" is a correction key, but "codexish" must not be touched.
      expect(clean("the codexish thing")).toBe("The codexish thing");
    });

    it("removes a standalone filler but not a substring of a word", () => {
      // "er" is a filler token; it must not strip the "er" inside "merger".
      expect(clean("the merger um happened")).toBe("The merger happened");
    });

    it("removes the space before trailing punctuation", () => {
      expect(clean("run vitest , then commit .")).toBe("Run vitest, then commit.");
    });

    it("corrects 'cr sequel light' -> 'cr-sqlite' across the hyphen boundary", () => {
      expect(clean("debug cr sequel light sync")).toBe("Debug cr-sqlite sync");
    });

    it("applies the longest correction first (multi-word over single-word)", () => {
      // "codex spark" must win over "codex" alone.
      expect(clean("launch codex spark now")).toBe("Launch Codex Spark now");
    });

    it("collapses double spaces introduced by filler removal", () => {
      expect(clean("um   uh   rebase")).toBe("Rebase");
    });

    it("trims and returns empty for whitespace-only input", () => {
      expect(clean("   \n  ")).toBe("");
    });

    it("handles a full jargon-heavy prompt end to end", () => {
      expect(
        clean("um rebase the work tree onto main and squash then run vitest"),
      ).toBe("Rebase the worktree onto main and squash then run vitest");
    });
  });

  describe("buildWhisperArgs", () => {
    const args = buildWhisperArgs("/models/ggml-base.en.bin", "/tmp/clip.wav");

    it("uses -oj for the JSON sidecar", () => {
      expect(args).toContain("-oj");
      expect(args).not.toContain("-otj");
    });

    it("passes the model and audio file paths", () => {
      expect(args).toEqual(
        expect.arrayContaining(["-m", "/models/ggml-base.en.bin", "-f", "/tmp/clip.wav"]),
      );
    });

    it("forces English and suppresses prints", () => {
      expect(args).toContain("-l");
      expect(args).toContain("en");
      expect(args).toContain("-np");
    });
  });
});

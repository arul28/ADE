import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetGlossaryCacheForTests,
  cleanTranscript,
  loadGlossary,
  prepareGlossary,
  type VoiceGlossary,
} from "./dictationCleanup";
import { downloadSpeechModel, speechModelPath } from "./speechModelStore";
import { createTranscriptionService, TranscriptionError } from "./transcriptionService";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
// The network download is the boundary; its own behaviour is pinned in
// speechModelStore.test.ts. Every other export stays real.
vi.mock("./speechModelStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./speechModelStore")>();
  return { ...actual, downloadSpeechModel: vi.fn(actual.downloadSpeechModel) };
});

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

    it("sorts equal-length corrections deterministically", () => {
      const prepared = prepareGlossary({
        version: 1,
        contextualTerms: [],
        corrections: {
          beta: "beta",
          alfa: "alpha",
        },
        fillers: [],
      });

      expect(prepared.corrections.map((entry) => entry.from)).toEqual(["alfa", "beta"]);
    });

    it("collapses double spaces introduced by filler removal", () => {
      expect(clean("um   uh   rebase")).toBe("Rebase");
    });

    it("trims and returns empty for whitespace-only input", () => {
      expect(clean("   \n  ")).toBe("");
    });

    // Parakeet punctuates fillers itself; removing one must not strand its comma.
    it.each([
      ["Um, rebase the work tree.", "Rebase the worktree."],
      ["So, uh, we should ship it.", "So, we should ship it."],
      ["Um. Ship it.", "Ship it."],
      ["We ship it. Um, then merge.", "We ship it. Then merge."],
      ["Um, uh, ship it.", "Ship it."],
      ["Um. Um. Ship it.", "Ship it."],
      ["Uh. Um. Ship it.", "Ship it."],
      ["Um! Ship it.", "Ship it."],
      ["... so we ship.", "... So we ship."],
    ])("removes a punctuated filler cleanly: %s", (raw, expected) => {
      expect(clean(raw)).toBe(expected);
    });

    it("handles a full jargon-heavy prompt end to end", () => {
      expect(
        clean("um rebase the work tree onto main and squash then run vitest"),
      ).toBe("Rebase the worktree onto main and squash then run vitest");
    });

    it("does not cache the empty fallback after a failed glossary read", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-voice-glossary-"));
      const explicitPath = path.join(tmpDir, "voice-glossary.json");
      try {
        __resetGlossaryCacheForTests();
        expect(loadGlossary({ explicitPath }).version).toBe(0);
        fs.writeFileSync(
          explicitPath,
          JSON.stringify({
            version: 7,
            contextualTerms: ["ADE"],
            corrections: { codecs: "Codex" },
            fillers: ["um"],
          }),
        );
        expect(loadGlossary({ explicitPath }).version).toBe(7);
      } finally {
        __resetGlossaryCacheForTests();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("transcription service", () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
    const exe = process.platform === "win32" ? ".exe" : "";
    let root: string;
    let resourcesPath: string;
    let modelDir: string;

    // A model file large enough to count as complete (sparse; no real bytes written).
    const writeCompleteModel = (filePath: string) => {
      const fd = fs.openSync(filePath, "w");
      try {
        fs.ftruncateSync(fd, 401 * 1024 * 1024);
      } finally {
        fs.closeSync(fd);
      }
    };
    const createService = () =>
      createTranscriptionService({ logger, isPackaged: true, resourcesPath, modelDir, glossary });

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-transcription-"));
      resourcesPath = path.join(root, "resources");
      modelDir = path.join(root, "userData", "whisper");
      fs.mkdirSync(path.join(resourcesPath, "whisper"), { recursive: true });
      fs.mkdirSync(modelDir, { recursive: true });
      fs.writeFileSync(path.join(resourcesPath, "whisper", `transcribe-cli${exe}`), "");
    });

    afterEach(() => {
      vi.mocked(spawn).mockReset();
      fs.rmSync(root, { recursive: true, force: true });
    });

    it("clears stale model files at startup and enables dictation only for a complete new model", async () => {
      const stale = ["ggml-base.en.bin", "ggml-base.en.bin.part", "parakeet-ultra-Q4_K_M.gguf.part"];
      for (const name of stale) fs.writeFileSync(path.join(modelDir, name), "old");
      const modelPath = path.join(modelDir, "parakeet-ultra-Q4_K_M.gguf");
      fs.writeFileSync(modelPath, "truncated");

      const service = createService();

      expect(fs.readdirSync(modelDir)).toEqual(["parakeet-ultra-Q4_K_M.gguf"]);
      expect(service.getStatus()).toMatchObject({ installed: false, modelInstalled: false });
      await expect(service.transcribe(new Int16Array(1600))).rejects.toMatchObject({
        code: "model_not_installed",
      });

      writeCompleteModel(modelPath);
      expect(service.getStatus()).toMatchObject({ installed: true, modelPath });
      service.dispose();
    });

    it("returns the cleaned transcript transcribe-cli writes, and fails on a non-zero exit", async () => {
      writeCompleteModel(path.join(modelDir, "parakeet-ultra-Q4_K_M.gguf"));
      const fakeRun = (exitCode: number) => (_binary: string, args: readonly string[]) => {
        const child = Object.assign(new EventEmitter(), {
          stdout: new EventEmitter(),
          stderr: new EventEmitter(),
          kill: vi.fn(),
        });
        setImmediate(() => {
          if (exitCode === 0) {
            fs.writeFileSync(args[args.indexOf("-o") + 1]!, "  um, rebase the work tree onto main.\n");
          } else {
            child.stderr.emit("data", Buffer.from("illegal instruction"));
          }
          child.emit("close", exitCode);
        });
        return child as never;
      };
      const service = createService();

      vi.mocked(spawn).mockImplementation(fakeRun(0) as never);
      await expect(service.transcribe(new Int16Array(1600))).resolves.toEqual({
        raw: "um, rebase the work tree onto main.",
        cleaned: "Rebase the worktree onto main.",
      });

      vi.mocked(spawn).mockImplementation(fakeRun(132) as never);
      const failure = await service.transcribe(new Int16Array(1600)).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(TranscriptionError);
      expect(failure).toMatchObject({ code: "transcribe_failed" });
      service.dispose();
    });

    it("holds every install caller until the warm-up ends, and a failed warm-up still installs", async () => {
      vi.mocked(downloadSpeechModel).mockImplementationOnce(async ({ modelDir, onProgress }) => {
        writeCompleteModel(speechModelPath(modelDir));
        onProgress?.({ receivedBytes: 1, totalBytes: 1 });
        return { modelPath: speechModelPath(modelDir) };
      });
      // The warm-up's transcribe-cli run: held open until the test ends it, then
      // it fails, which must not fail the install.
      let finishWarmup!: () => void;
      const warmupSpawned = new Promise<void>((resolveSpawned) => {
        vi.mocked(spawn).mockImplementation((() => {
          const child = Object.assign(new EventEmitter(), {
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
            kill: vi.fn(),
          });
          finishWarmup = () => child.emit("close", 1);
          resolveSpawned();
          return child;
        }) as never);
      });
      const service = createService();
      const stages: Array<string | undefined> = [];
      const settled: string[] = [];

      const first = service
        .downloadModel((progress) => {
          stages.push(progress.stage);
          if (progress.stage === "warmup") throw new Error("listener blew up");
        })
        .then(() => settled.push("first"));
      await warmupSpawned;
      // The model is on disk now, yet a second caller (the renderer rejoining
      // after an IPC failure) must wait for the same install.
      const second = service.downloadModel().then(() => settled.push("second"));
      await new Promise((resolveTick) => setImmediate(resolveTick));
      expect(settled).toEqual([]);
      expect(service.getStatus()).toMatchObject({ downloading: true, modelInstalled: true });

      finishWarmup();
      await Promise.all([first, second]);
      expect(settled.sort()).toEqual(["first", "second"]);
      expect(stages).toEqual([undefined, "warmup"]);
      expect(service.getStatus()).toMatchObject({ downloading: false, installed: true });
      service.dispose();
    });
  });
});

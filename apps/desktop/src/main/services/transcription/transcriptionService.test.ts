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

    it.each([
      ["work tree is one word", "rebase the work tree", "Rebase the worktree"],
      ["plural work trees", "list the work trees", "List the worktrees"],
      ["fillers, correction and capitalization together", "um so like rebase the codecs branch", "So like rebase the Codex branch"],
      ["sentence-start capitals after . ! ?", "rebase main. then run vitest. did it pass?", "Rebase main. Then run vitest. Did it pass?"],
      ["an already-correct canonical term stays put", "ask open ai about OpenAI models", "Ask OpenAI about OpenAI models"],
      ["internal casing of a replacement (SwiftUI)", "update the swift ui view", "Update the SwiftUI view"],
      ["no mid-word correction", "the codexish thing", "The codexish thing"],
      ["no filler removal inside a word", "the merger um happened", "The merger happened"],
      ["no space before trailing punctuation", "run vitest , then commit .", "Run vitest, then commit."],
      ["a correction across a hyphen boundary", "debug cr sequel light sync", "Debug cr-sqlite sync"],
      ["the longest correction wins", "launch codex spark now", "Launch Codex Spark now"],
      ["double spaces left by filler removal", "um   uh   rebase", "Rebase"],
      ["whitespace-only input", "   \n  ", ""],
      ["a full jargon-heavy prompt", "um rebase the work tree onto main and squash then run vitest", "Rebase the worktree onto main and squash then run vitest"],
    ])("cleans %s", (_label, raw, expected) => {
      expect(clean(raw)).toBe(expected);
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

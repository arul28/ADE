import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  legacyAudioArtifactPaths,
  purgeLegacyAudioArtifacts,
} from "./legacyAudioArtifacts";

/**
 * The one chance ADE gets to clean up after itself.
 *
 * Speech moved out of core, so nothing in the app will ever look at
 * `<userData>/whisper` again — the app update that removed the feature is the
 * only moment that can delete the 141 MB it downloaded. That makes these
 * assertions load-bearing in a way most cleanup tests are not: there is no
 * second pass, no UI that mentions the bytes, and no user who would know.
 */
describe("purgeLegacyAudioArtifacts", () => {
  let root: string;
  let userDataPath: string;
  let tmpdir: string;
  let captureDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-audio-purge-"));
    userDataPath = path.join(root, "userData");
    tmpdir = path.join(root, "tmp");
    captureDir = path.join(tmpdir, "ade-audio-captures");
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.mkdirSync(tmpdir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const purge = (now?: number) =>
    purgeLegacyAudioArtifacts({ userDataPath, tmpdir, captureDir, ...(now != null ? { now } : {}) });

  it("deletes the downloaded speech model, including a partial download", () => {
    const [modelDir] = legacyAudioArtifactPaths({ userDataPath, tmpdir });
    fs.mkdirSync(modelDir!, { recursive: true });
    fs.writeFileSync(path.join(modelDir!, "ggml-base.en.bin"), Buffer.alloc(2048));
    fs.writeFileSync(path.join(modelDir!, "ggml-base.en.bin.part"), Buffer.alloc(512));

    const result = purge();

    expect(fs.existsSync(modelDir!)).toBe(false);
    expect(result.removed).toEqual([modelDir]);
    expect(result.freedBytes).toBe(2048 + 512);
  });

  it("deletes the old build's clip staging directory too", () => {
    // Kilobytes rather than megabytes, but they are still the user's disk and
    // nothing else will ever come looking for them.
    const [, stagingDir] = legacyAudioArtifactPaths({ userDataPath, tmpdir });
    fs.mkdirSync(stagingDir!, { recursive: true });
    fs.writeFileSync(path.join(stagingDir!, "clip.wav"), Buffer.alloc(64));

    const result = purge();

    expect(fs.existsSync(stagingDir!)).toBe(false);
    expect(result.removed).toEqual([stagingDir]);
    expect(result.freedBytes).toBe(64);
  });

  it("keeps the legacy staging dir distinct from today's capture dir", () => {
    // Both live under the OS temp dir and only the basename separates them.
    // If they ever collided, the legacy pass would delete live clips a plugin
    // is still reading — a recursive delete, not the age-based sweep.
    const [, stagingDir] = legacyAudioArtifactPaths({ userDataPath, tmpdir });
    expect(stagingDir).not.toBe(captureDir);

    fs.mkdirSync(captureDir, { recursive: true });
    const liveClip = path.join(captureDir, "in-flight.wav");
    fs.writeFileSync(liveClip, Buffer.alloc(32));

    purge();

    expect(fs.existsSync(liveClip)).toBe(true);
  });

  it("is a silent no-op on a machine that never used voice", () => {
    const first = purge();
    const second = purge();

    expect(first.removed).toEqual([]);
    expect(first.freedBytes).toBe(0);
    expect(second.removed).toEqual([]);
  });

  it("is idempotent — a second pass finds nothing left to do", () => {
    const [modelDir] = legacyAudioArtifactPaths({ userDataPath, tmpdir });
    fs.mkdirSync(modelDir!, { recursive: true });
    fs.writeFileSync(path.join(modelDir!, "ggml-base.en.bin"), Buffer.alloc(1024));

    expect(purge().removed).toEqual([modelDir]);
    expect(purge().removed).toEqual([]);
  });

  it("never touches a plugin's own data directory", () => {
    // A plugin keeps its model under the plugins root. A sweep that went
    // looking for "model-looking files" instead of these exact legacy paths
    // would eventually delete the model the user just installed.
    const pluginModel = path.join(root, "ade", "plugins", "some-plugin", "data", "ggml-base.en.bin");
    fs.mkdirSync(path.dirname(pluginModel), { recursive: true });
    fs.writeFileSync(pluginModel, Buffer.alloc(1024));

    purge();

    expect(fs.existsSync(pluginModel)).toBe(true);
  });

  it("sweeps stale clips but leaves an in-flight capture alone", () => {
    fs.mkdirSync(captureDir, { recursive: true });
    const stale = path.join(captureDir, "stale.wav");
    const fresh = path.join(captureDir, "fresh.wav");
    fs.writeFileSync(stale, Buffer.alloc(32));
    fs.writeFileSync(fresh, Buffer.alloc(32));
    const longAgo = new Date(Date.now() - 48 * 60 * 60_000);
    fs.utimesSync(stale, longAgo, longAgo);

    const result = purge();

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(result.removed).toEqual([stale]);
  });
});

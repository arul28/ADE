import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  artifactStreamMimeType,
  decodeRemoteArtifactChunk,
  isStreamableArtifactFile,
  knownArtifactMimeType,
  parseRangeHeader,
  resolveByteRange,
  resolveContainedArtifactFile,
  respondToArtifactProtocolRequest,
} from "./artifactStreamProtocol";

describe("artifact stream helpers", () => {
  it("serves QuickTime as MP4 and parses the first range", () => {
    expect(artifactStreamMimeType("a/b/rec.MOV")).toBe("video/mp4");
    expect(artifactStreamMimeType("x.png")).toBe("image/png");
    expect(artifactStreamMimeType("x.bin")).toBe("application/octet-stream");
    expect(knownArtifactMimeType("x.m4v")).toBe("video/mp4");
    expect(knownArtifactMimeType("notes.json")).toBeNull();
    expect(isStreamableArtifactFile("clip.webm")).toBe(true);
    expect(isStreamableArtifactFile("notes.json")).toBe(false);
    expect(parseRangeHeader("bytes=10-20")).toEqual({ kind: "from", start: 10, end: 20 });
    expect(parseRangeHeader("bytes=10-")).toEqual({ kind: "from", start: 10, end: null });
    expect(parseRangeHeader("bytes=-5")).toEqual({ kind: "suffix", length: 5 });
    expect(parseRangeHeader("bytes=-")).toBeNull();
    expect(parseRangeHeader(null)).toBeNull();
  });

  it("turns a parsed range into the bytes to send, or null for 416", () => {
    expect(resolveByteRange(null, 100)).toEqual({ start: 0, end: 99 });
    expect(resolveByteRange({ kind: "from", start: 10, end: null }, 100)).toEqual({ start: 10, end: 99 });
    expect(resolveByteRange({ kind: "from", start: 10, end: 500 }, 100)).toEqual({ start: 10, end: 99 });
    expect(resolveByteRange({ kind: "suffix", length: 30 }, 100)).toEqual({ start: 70, end: 99 });
    expect(resolveByteRange({ kind: "suffix", length: 300 }, 100)).toEqual({ start: 0, end: 99 });
    expect(resolveByteRange({ kind: "suffix", length: 0 }, 100)).toBeNull();
    expect(resolveByteRange({ kind: "from", start: 100, end: null }, 100)).toBeNull();
    expect(resolveByteRange({ kind: "from", start: 50, end: 10 }, 100)).toBeNull();
    expect(resolveByteRange(null, 0)).toBeNull();
  });

  it("refuses a chunk answer that is not one", () => {
    expect(decodeRemoteArtifactChunk({ totalSize: 3, offset: 0, data: "AAAA" }).bytes.length).toBe(3);
    expect(() => decodeRemoteArtifactChunk({ totalSize: -1, data: "" })).toThrow();
    expect(() => decodeRemoteArtifactChunk(null)).toThrow();
  });
});

describe("artifact containment", () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ade-artifact-jail-")));
  const projectRoot = path.join(tmp, "repo");
  const allowedDir = path.join(projectRoot, ".ade", "artifacts");
  fs.mkdirSync(path.join(allowedDir, "sub"), { recursive: true });
  fs.writeFileSync(path.join(allowedDir, "sub", "proof.png"), "png");
  fs.writeFileSync(path.join(projectRoot, "secret.txt"), "secret");
  fs.mkdirSync(path.join(projectRoot, ".ade", "artifacts-old"));
  fs.writeFileSync(path.join(projectRoot, ".ade", "artifacts-old", "x.png"), "old");
  fs.symlinkSync(path.join(projectRoot, "secret.txt"), path.join(allowedDir, "escape.png"));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const check = (requestedPath: string, projectRelative: boolean) =>
    resolveContainedArtifactFile({ requestedPath, projectRelative, projectRoot, allowedDir });

  it("serves a file inside the artifacts dir by relative or absolute path", () => {
    expect(check("/.ade/artifacts/sub/proof.png", true)).toEqual({
      ok: true,
      filePath: path.join(allowedDir, "sub", "proof.png"),
      size: 3,
    });
    expect(check(path.join(allowedDir, "sub", "proof.png"), false)).toMatchObject({ ok: true });
    expect(check(".ade/artifacts/sub/proof.png", false)).toMatchObject({ ok: true });
  });

  it("refuses a walk out, a sibling with the same prefix, a symlink out, a folder, and a missing file", () => {
    expect(check("/.ade/artifacts/../../secret.txt", true)).toMatchObject({ ok: false, reason: "outside" });
    expect(check(path.join(projectRoot, "secret.txt"), false)).toMatchObject({ ok: false, reason: "outside" });
    expect(check("/.ade/artifacts-old/x.png", true)).toMatchObject({ ok: false, reason: "outside" });
    expect(check("/.ade/artifacts/escape.png", true)).toMatchObject({ ok: false, reason: "outside" });
    expect(check("/.ade/artifacts/sub", true)).toMatchObject({ ok: false, reason: "not-file" });
    expect(check("/.ade/artifacts/none.png", true)).toMatchObject({ ok: false, reason: "missing" });
  });

  it("refuses everything when no project is active", () => {
    expect(resolveContainedArtifactFile({
      requestedPath: "/.ade/artifacts/sub/proof.png",
      projectRelative: true,
      projectRoot: null,
      allowedDir: null,
    })).toMatchObject({ ok: false, reason: "no-project" });
    expect(resolveContainedArtifactFile({
      requestedPath: path.join(allowedDir, "sub", "proof.png"),
      projectRelative: false,
      projectRoot,
      allowedDir: null,
    })).toMatchObject({ ok: false, reason: "outside" });
  });
});

describe("ade-artifact protocol answer", () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ade-artifact-protocol-")));
  const projectRoot = path.join(tmp, "repo");
  const allowedDir = path.join(projectRoot, ".ade", "artifacts");
  fs.mkdirSync(allowedDir, { recursive: true });
  fs.writeFileSync(path.join(allowedDir, "clip.mp4"), Buffer.from("0123456789"));
  fs.writeFileSync(path.join(allowedDir, "empty.png"), Buffer.alloc(0));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const scope = { projectRoot, allowedDir };
  const ask = (file: string, range?: string) => respondToArtifactProtocolRequest(
    new Request(`ade-artifact://project/.ade/artifacts/${file}`, range ? { headers: { Range: range } } : {}),
    scope,
  );

  it("answers a whole file, a range, and a suffix range with the shared parse", async () => {
    const whole = ask("clip.mp4");
    expect(whole.status).toBe(200);
    expect(whole.headers.get("Content-Type")).toBe("video/mp4");
    expect(await whole.text()).toBe("0123456789");

    const middle = ask("clip.mp4", "bytes=2-4");
    expect(middle.status).toBe(206);
    expect(middle.headers.get("Content-Range")).toBe("bytes 2-4/10");
    expect(await middle.text()).toBe("234");

    // `bytes=-3` is the last three bytes, not the whole file from 0.
    const suffix = ask("clip.mp4", "bytes=-3");
    expect(suffix.status).toBe(206);
    expect(await suffix.text()).toBe("789");
  });

  it("answers 200 for a Range it cannot read, 416 past the end, and 404 outside the jail", async () => {
    const malformed = ask("clip.mp4", "items=0-1");
    expect(malformed.status).toBe(200);
    expect(await malformed.text()).toBe("0123456789");
    const past = ask("clip.mp4", "bytes=50-");
    expect(past.status).toBe(416);
    expect(past.headers.get("Content-Range")).toBe("bytes */10");
    const empty = ask("empty.png");
    expect(empty.status).toBe(200);
    expect(empty.headers.get("Content-Length")).toBe("0");
    expect(ask("../../secret.txt").status).toBe(404);
  });
});

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createArtifactMediaServer, type ArtifactMediaServer } from "./artifactMediaServer";
import {
  REMOTE_ARTIFACT_CHUNK_BYTES,
  type RemoteArtifactRangeReader,
  artifactStreamMimeType,
  decodeRemoteArtifactChunk,
  isStreamableArtifactFile,
  knownArtifactMimeType,
  parseRangeHeader,
  resolveByteRange,
  resolveContainedArtifactFile,
  respondToArtifactProtocolRequest,
} from "./artifactStreamProtocol";
import { ARTIFACT_RANGE_READ_MAX_BYTES } from "../../../shared/artifactStreamUrl";
import { readArtifactByteRange } from "./artifactByteRange";

const TOKEN = "t".repeat(43);

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };

function patterned(size: number): Buffer {
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 31) % 256;
  return bytes;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sends the path exactly as written; Node does not fold `..` in a client request. */
function send(base: string, rawPath: string, options: { headers?: Record<string, string>; method?: string } = {}): Promise<Reply> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: url.hostname,
      port: url.port,
      path: rawPath,
      method: options.method ?? "GET",
      headers: options.headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

/** A paired machine holding one file, answering the way its broker does. */
function fakeMachine(bytes: Buffer) {
  return vi.fn<Parameters<RemoteArtifactRangeReader>, ReturnType<RemoteArtifactRangeReader>>(async ({ offset, length }) => ({
    totalSize: bytes.length,
    offset,
    data: bytes.subarray(offset, Math.min(bytes.length, offset + Math.min(length, 2 * 1024 * 1024))).toString("base64"),
  }));
}

let tmp: string;
let projectRoot: string;
let artifactsDir: string;
const video = patterned(300_000);
let reader: RemoteArtifactRangeReader | null = null;
let server: ArtifactMediaServer;
let base: string;
let origin: string;

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ade-media-server-")));
  projectRoot = path.join(tmp, "repo");
  artifactsDir = path.join(projectRoot, ".ade", "artifacts");
  fs.mkdirSync(path.join(artifactsDir, "apple-recordings"), { recursive: true });
  fs.writeFileSync(path.join(artifactsDir, "apple-recordings", "rec 1.mov"), video);
  fs.writeFileSync(path.join(artifactsDir, "big.mp4"), patterned(8 * 1024 * 1024));
  fs.writeFileSync(path.join(artifactsDir, "empty.mp4"), Buffer.alloc(0));
  fs.writeFileSync(path.join(projectRoot, "secret.txt"), "not a proof");
  fs.symlinkSync(path.join(projectRoot, "secret.txt"), path.join(artifactsDir, "link.mp4"));
  server = createArtifactMediaServer({
    localScope: () => ({ projectRoot, allowedDir: artifactsDir }),
    remoteReader: () => reader,
    token: TOKEN,
  });
  base = await server.baseUrl();
  origin = base.slice(0, base.length - TOKEN.length - 1);
});

afterEach(() => {
  reader = null;
  vi.restoreAllMocks();
});

afterAll(async () => {
  await server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const REC = "/project/.ade/artifacts/apple-recordings/rec%201.mov";

describe("artifact media server", () => {
  it("listens on loopback with the token in the base, once", async () => {
    expect(base).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+/${TOKEN}$`));
    expect(await server.baseUrl()).toBe(base);
  });

  it("refuses a missing, wrong, or short token and a foreign Host with 404", async () => {
    const wrong = "u".repeat(TOKEN.length);
    for (const target of [REC, `/${wrong}${REC}`, `/${TOKEN.slice(1)}${REC}`, `/${TOKEN}x${REC}`, `/${TOKEN}`, "/"]) {
      const reply = await send(origin, target);
      expect(reply.status, target).toBe(404);
      expect(reply.body.toString()).toBe("Not found");
    }
    const rebound = await send(origin, `/${TOKEN}${REC}`, { headers: { Host: "evil.example:80" } });
    expect(rebound.status).toBe(404);
  });

  it("serves GET and HEAD only", async () => {
    const reply = await send(origin, `/${TOKEN}${REC}`, { method: "POST" });
    expect(reply.status).toBe(405);
    expect(reply.headers.allow).toBe("GET, HEAD");
  });

  it("answers 200 with the whole file and the media headers when no Range is asked for", async () => {
    const reply = await send(origin, `/${TOKEN}${REC}`);
    expect(reply.status).toBe(200);
    expect(reply.headers["content-type"]).toBe("video/mp4");
    expect(reply.headers["content-length"]).toBe(String(video.length));
    expect(reply.headers["accept-ranges"]).toBe("bytes");
    expect(reply.headers["cache-control"]).toBe("no-store");
    expect(reply.headers["content-range"]).toBeUndefined();
    expect(reply.body.equals(video)).toBe(true);
  });

  it("answers every single-range form with 206 and the exact bytes", async () => {
    const size = video.length;
    const cases: Array<[string, number, number]> = [
      ["bytes=0-", 0, size - 1],
      ["bytes=100-199", 100, 199],
      [`bytes=${size - 10}-`, size - 10, size - 1],
      ["bytes=-500", size - 500, size - 1],
      [`bytes=-${size * 2}`, 0, size - 1],
      [`bytes=200-${size * 5}`, 200, size - 1],
    ];
    for (const [range, start, end] of cases) {
      const reply = await send(origin, `/${TOKEN}${REC}`, { headers: { Range: range } });
      expect(reply.status, range).toBe(206);
      expect(reply.headers["content-range"], range).toBe(`bytes ${start}-${end}/${size}`);
      expect(reply.headers["content-length"], range).toBe(String(end - start + 1));
      expect(reply.body.equals(video.subarray(start, end + 1)), range).toBe(true);
    }
  });

  it("answers 416 for a range it cannot satisfy", async () => {
    for (const range of [`bytes=${video.length}-`, "bytes=500-100", "bytes=-0"]) {
      const reply = await send(origin, `/${TOKEN}${REC}`, { headers: { Range: range } });
      expect(reply.status, range).toBe(416);
      expect(reply.headers["content-range"]).toBe(`bytes */${video.length}`);
    }
    const empty = await send(origin, `/${TOKEN}/project/.ade/artifacts/empty.mp4`);
    expect(empty.status).toBe(200);
    expect(empty.headers["content-length"]).toBe("0");
  });

  it("answers HEAD with the headers and no body", async () => {
    const reply = await send(origin, `/${TOKEN}${REC}`, { method: "HEAD", headers: { Range: "bytes=10-19" } });
    expect(reply.status).toBe(206);
    expect(reply.headers["content-length"]).toBe("10");
    expect(reply.headers["content-range"]).toBe(`bytes 10-19/${video.length}`);
    expect(reply.body.length).toBe(0);
  });

  it("refuses `..`, encoded `..`, and anything outside the artifacts dir", async () => {
    const warn = vi.fn();
    const strict = createArtifactMediaServer({
      localScope: () => ({ projectRoot, allowedDir: artifactsDir }),
      remoteReader: () => null,
      token: TOKEN,
      warn,
    });
    const strictBase = await strict.baseUrl();
    const strictOrigin = strictBase.slice(0, strictBase.length - TOKEN.length - 1);
    try {
      for (const target of [
        "/project/.ade/artifacts/../../secret.txt",
        "/project/.ade/artifacts/%2E%2E/%2E%2E/secret.txt",
        "/project/.ade/artifacts/..%2F..%2Fsecret.txt",
        "/project/secret.txt",
        "/project/.ade/artifacts/link.mp4",
        "/project/.ade/artifacts",
        "/project/.ade/artifacts/missing.mp4",
        `/project/${encodeURIComponent(path.join(projectRoot, "secret.txt"))}`,
      ]) {
        const reply = await send(strictOrigin, `/${TOKEN}${target}`);
        expect(reply.status, target).toBe(404);
        expect(reply.body.toString()).toBe("Not found");
      }
      // The symlink and the plain outside file reach the containment check and are logged.
      expect(warn).toHaveBeenCalledWith(
        "[artifact-media] rejected path outside artifacts dir",
        expect.objectContaining({ resolvedFile: path.join(projectRoot, "secret.txt") }),
      );
    } finally {
      await strict.close();
    }
  });

  it("serves nothing when no project is active", async () => {
    const idle = createArtifactMediaServer({
      localScope: () => ({ projectRoot: null, allowedDir: null }),
      remoteReader: () => null,
      token: TOKEN,
    });
    const idleBase = await idle.baseUrl();
    try {
      const reply = await send(idleBase.slice(0, idleBase.length - TOKEN.length - 1), `/${TOKEN}${REC}`);
      expect(reply.status).toBe(404);
    } finally {
      await idle.close();
    }
  });

  it("closes the file when the player drops the request", async () => {
    const createReadStream = vi.spyOn(fs, "createReadStream");
    const url = new URL(base);
    await new Promise<void>((resolve, reject) => {
      const req = http.get({
        host: url.hostname,
        port: url.port,
        path: `/${TOKEN}/project/.ade/artifacts/big.mp4`,
        headers: { Range: "bytes=0-" },
      }, (res) => {
        expect(res.statusCode).toBe(206);
        res.once("data", () => {
          req.destroy();
          resolve();
        });
      });
      req.on("error", (error) => {
        if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error);
      });
    });
    const stream = createReadStream.mock.results[0]?.value as fs.ReadStream;
    expect(stream).toBeTruthy();
    for (let attempt = 0; attempt < 50 && !stream.destroyed; attempt += 1) await wait(10);
    expect(stream.destroyed).toBe(true);
    expect(stream.bytesRead).toBeLessThan(8 * 1024 * 1024);
  });
});

describe("artifact media server, paired computer", () => {
  const REMOTE = "/remote/target-1/project-1/.ade/artifacts/apple-recordings/rec.mov";

  it("proxies a Range read in bounded chunks and names the file on the other machine", async () => {
    const bytes = patterned(3 * REMOTE_ARTIFACT_CHUNK_BYTES + 123);
    const machine = fakeMachine(bytes);
    reader = machine;
    const start = REMOTE_ARTIFACT_CHUNK_BYTES - 10;
    const end = 3 * REMOTE_ARTIFACT_CHUNK_BYTES + 5;

    const reply = await send(origin, `/${TOKEN}${REMOTE}`, { headers: { Range: `bytes=${start}-${end}` } });

    expect(reply.status).toBe(206);
    expect(reply.headers["content-range"]).toBe(`bytes ${start}-${end}/${bytes.length}`);
    expect(reply.headers["content-length"]).toBe(String(end - start + 1));
    expect(reply.headers["content-type"]).toBe("video/mp4");
    expect(reply.body.equals(bytes.subarray(start, end + 1))).toBe(true);
    for (const [call] of machine.mock.calls) {
      expect(call.length).toBeLessThanOrEqual(REMOTE_ARTIFACT_CHUNK_BYTES);
      expect(call).toMatchObject({
        targetId: "target-1",
        projectId: "project-1",
        relativePath: ".ade/artifacts/apple-recordings/rec.mov",
      });
    }
  });

  it("serves suffix ranges, HEAD, 200, and 416 like a local file", async () => {
    const bytes = patterned(5000);
    reader = fakeMachine(bytes);
    const suffix = await send(origin, `/${TOKEN}${REMOTE}`, { headers: { Range: "bytes=-100" } });
    expect(suffix.headers["content-range"]).toBe("bytes 4900-4999/5000");
    expect(suffix.body.equals(bytes.subarray(4900))).toBe(true);

    const head = await send(origin, `/${TOKEN}${REMOTE}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers["content-length"]).toBe("5000");
    expect(head.body.length).toBe(0);

    const whole = await send(origin, `/${TOKEN}${REMOTE}`);
    expect(whole.status).toBe(200);
    expect(whole.body.equals(bytes)).toBe(true);

    const past = await send(origin, `/${TOKEN}${REMOTE}`, { headers: { Range: "bytes=9000-" } });
    expect(past.status).toBe(416);
    expect(past.headers["content-range"]).toBe("bytes */5000");
  });

  it("pulls only as the player reads, and stops when the player leaves", async () => {
    const bytes = patterned(41 * 1024 * 1024);
    const machine = fakeMachine(bytes);
    reader = machine;
    const url = new URL(base);
    let request: http.ClientRequest | null = null;
    await new Promise<void>((resolve) => {
      request = http.get({
        host: url.hostname,
        port: url.port,
        path: `/${TOKEN}${REMOTE}`,
        headers: { Range: "bytes=0-" },
      }, (res) => {
        expect(res.headers["content-range"]).toBe(`bytes 0-${bytes.length - 1}/${bytes.length}`);
        res.once("data", () => {
          res.pause();
          resolve();
        });
      });
      request.on("error", () => {});
    });
    await wait(200);
    const whilePaused = machine.mock.calls.length;
    // A paused player holds a few socket buffers of chunks, never the file.
    expect(whilePaused).toBeLessThanOrEqual(12);
    request!.destroy();
    await wait(200);
    expect(machine.mock.calls.length).toBeLessThanOrEqual(whilePaused + 1);
  });

  it("never asks the other machine for a path with `..` in it", async () => {
    const machine = fakeMachine(patterned(10));
    reader = machine;
    for (const target of [
      "/remote/target-1/project-1/.ade/artifacts/../../.env",
      "/remote/target-1/project-1/.ade/artifacts/%2E%2E/.env",
    ]) {
      expect((await send(origin, `/${TOKEN}${target}`)).status).toBe(404);
    }
    expect(machine).not.toHaveBeenCalled();
  });

  it("maps an offline machine to 502 and a bridge that is not up to 503", async () => {
    reader = vi.fn(async () => {
      throw new Error("MacBook Pro is offline.");
    });
    const offline = await send(origin, `/${TOKEN}${REMOTE}`, { headers: { Range: "bytes=0-" } });
    expect(offline.status).toBe(502);
    expect(offline.body.toString()).toBe("MacBook Pro is offline.");

    reader = null;
    expect((await send(origin, `/${TOKEN}${REMOTE}`)).status).toBe(503);
  });

  it("cuts the connection when the file shrinks mid-stream instead of hanging", async () => {
    const bytes = patterned(3 * REMOTE_ARTIFACT_CHUNK_BYTES);
    let calls = 0;
    reader = vi.fn(async ({ offset, length }) => {
      calls += 1;
      const data = calls === 1 ? bytes.subarray(offset, offset + length) : Buffer.alloc(0);
      return { totalSize: bytes.length, offset, data: data.toString("base64") };
    });
    await expect(send(origin, `/${TOKEN}${REMOTE}`, { headers: { Range: "bytes=0-" } })).rejects.toThrow();
  });
});

describe("artifact media server lifecycle", () => {
  it("starts on first ask, refuses connections once closed, and restarts on the next ask", async () => {
    const lazy = createArtifactMediaServer({
      localScope: () => ({ projectRoot, allowedDir: artifactsDir }),
      remoteReader: () => null,
    });
    const first = await lazy.baseUrl();
    const token = first.split("/").pop()!;
    // 32 random bytes, base64url.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const firstOrigin = first.slice(0, first.length - token.length - 1);
    expect((await send(firstOrigin, `/${token}${REC}`)).status).toBe(200);
    await lazy.close();
    await expect(send(firstOrigin, `/${token}${REC}`)).rejects.toThrow();
    const second = await lazy.baseUrl();
    expect(second.endsWith(`/${token}`)).toBe(true);
    await lazy.close();
  });

  it("does not leave a server listening when close() lands while a start is still binding", async () => {
    const created: http.Server[] = [];
    const realCreate = http.createServer;
    const spy = vi.spyOn(http, "createServer").mockImplementation(((...args: Parameters<typeof http.createServer>) => {
      const next = (realCreate as (...a: unknown[]) => http.Server)(...args);
      created.push(next);
      return next;
    }) as typeof http.createServer);
    try {
      const racing = createArtifactMediaServer({
        localScope: () => ({ projectRoot, allowedDir: artifactsDir }),
        remoteReader: () => null,
      });
      const pending = racing.baseUrl();
      await racing.close();
      await expect(pending).rejects.toThrow(/closed/);
      expect(created).toHaveLength(1);
      await vi.waitFor(() => expect(created[0]!.listening).toBe(false));
      // The next ask still starts a fresh server.
      const again = await racing.baseUrl();
      expect(again).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
      await racing.close();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("artifact byte range reader", () => {
  describe("readArtifactByteRange", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-file-range-"));
    const file = path.join(dir, "clip.mp4");
    const bytes = Buffer.alloc(ARTIFACT_RANGE_READ_MAX_BYTES + 10);
    for (let index = 0; index < bytes.length; index += 997) bytes[index] = index % 251;
    fs.writeFileSync(file, bytes);
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    it("reads a slice, cut to the cap", async () => {
      const whole = await readArtifactByteRange(file, 0, 64 * 1024 * 1024);
      expect(whole).toMatchObject({ totalSize: bytes.length, rangeStart: 0, rangeEnd: ARTIFACT_RANGE_READ_MAX_BYTES, eof: false });
      expect(Buffer.from(whole.base64, "base64")).toEqual(bytes.subarray(0, ARTIFACT_RANGE_READ_MAX_BYTES));
    });

    it("reads the tail and says it reached the end", async () => {
      const tail = await readArtifactByteRange(file, bytes.length - 4, 100);
      expect(tail).toMatchObject({ rangeStart: bytes.length - 4, rangeEnd: bytes.length, eof: true });
      expect(Buffer.from(tail.base64, "base64")).toEqual(bytes.subarray(bytes.length - 4));
    });

    it("answers an empty end-of-file slice past the end, and treats a bad offset as 0", async () => {
      expect(await readArtifactByteRange(file, bytes.length + 5)).toEqual({
        totalSize: bytes.length,
        rangeStart: bytes.length,
        rangeEnd: bytes.length,
        base64: "",
        eof: true,
      });
      expect((await readArtifactByteRange(file, Number.NaN, 3)).rangeStart).toBe(0);
    });

    it("refuses a missing file and a folder", async () => {
      await expect(readArtifactByteRange(path.join(dir, "gone.mp4"))).rejects.toThrow(/does not exist/);
      await expect(readArtifactByteRange(dir)).rejects.toThrow(/does not exist/);
    });
  });
});

describe("artifact stream protocol", () => {
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
});

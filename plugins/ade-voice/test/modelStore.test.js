"use strict";

// The download, against a real HTTP server on loopback.
//
// Nothing here touches Hugging Face or a 141 MB file: the properties worth
// proving — atomic install, checksum refusal, resume from a partial, a server
// that ignores Range — are all size-independent, so the "model" is a few
// hundred deterministic bytes and the whole file runs in under a second.

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { after, beforeEach, describe, it } = require("node:test");

const {
  DEFAULT_MODEL_SHA256,
  DEFAULT_MODEL_URL,
  defaultModelSource,
  downloadModel,
  isModelInstalled,
  partialBytes,
  partialPathFor,
} = require("../modelStore");
const { MODEL_BASENAME, modelPathIn } = require("../engine");

const BODY = Buffer.from(Array.from({ length: 512 }, (_, i) => i % 251));
const BODY_SHA = createHash("sha256").update(BODY).digest("hex");

/** An origin server with the behaviours a 141 MB download actually meets. */
function startServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, range: req.headers.range ?? null });
    handler(req, res, requests.length);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/model.bin`,
        requests,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/** Serves the body, honouring Range. The ordinary case. */
function serveRanged(req, res) {
  const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
  if (range) {
    const start = Number(range[1]);
    const slice = BODY.subarray(start);
    res.writeHead(206, {
      "content-length": String(slice.length),
      "content-range": `bytes ${start}-${BODY.length - 1}/${BODY.length}`,
    });
    res.end(slice);
    return;
  }
  res.writeHead(200, { "content-length": String(BODY.length) });
  res.end(BODY);
}

const tempRoots = [];
async function tempDir() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ade-voice-test-"));
  tempRoots.push(dir);
  return dir;
}

after(async () => {
  for (const dir of tempRoots) await fsp.rm(dir, { recursive: true, force: true });
});

const source = { url: "", sha256: BODY_SHA, expectedBytes: BODY.length };
const options = { minBytes: BODY.length, maxAttempts: 2, retryDelayMs: 1 };

describe("the pinned source", () => {
  it("is the canonical whisper.cpp model, with the digest Hugging Face publishes for it", () => {
    assert.equal(DEFAULT_MODEL_URL, "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin");
    assert.match(DEFAULT_MODEL_SHA256, /^[a-f0-9]{64}$/);
    assert.equal(defaultModelSource({}).sha256, DEFAULT_MODEL_SHA256);
  });

  it("can be pointed somewhere else for a mirror or a test", () => {
    const mirrored = defaultModelSource({ ADE_VOICE_MODEL_URL: " https://mirror/m.bin ", ADE_VOICE_MODEL_SHA256: " abc " });
    assert.equal(mirrored.url, "https://mirror/m.bin");
    assert.equal(mirrored.sha256, "abc");
  });
});

describe("downloading the model", () => {
  let server;
  let dir;

  beforeEach(async () => {
    if (server) await server.close();
    server = null;
    dir = await tempDir();
  });

  after(async () => {
    if (server) await server.close();
  });

  it("installs it under its real name only once the whole file is there", async () => {
    server = await startServer(serveRanged);
    const result = await downloadModel({ modelDir: dir, source: { ...source, url: server.url }, ...options });

    assert.equal(result.downloaded, true);
    assert.equal(result.modelPath, path.join(dir, MODEL_BASENAME));
    assert.deepEqual(fs.readFileSync(result.modelPath), BODY);
    // The partial is gone: a rename, not a copy, is what made it the model.
    assert.equal(fs.existsSync(partialPathFor(dir)), false);
    assert.equal(isModelInstalled(dir, BODY.length), true);
  });

  it("does nothing at all when the model is already there", async () => {
    server = await startServer(serveRanged);
    await fsp.writeFile(modelPathIn(dir), BODY);
    const result = await downloadModel({ modelDir: dir, source: { ...source, url: server.url }, ...options });

    assert.equal(result.downloaded, false);
    assert.equal(server.requests.length, 0, "an installed model must not be re-fetched");
  });

  it("resumes from the bytes already on disk", async () => {
    server = await startServer(serveRanged);
    await fsp.writeFile(partialPathFor(dir), BODY.subarray(0, 200));
    assert.equal(partialBytes(dir), 200);

    await downloadModel({ modelDir: dir, source: { ...source, url: server.url }, ...options });

    assert.deepEqual(fs.readFileSync(modelPathIn(dir)), BODY);
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].range, "bytes=200-", "the second half should be the only half fetched");
  });

  it("starts over when the server ignores Range", async () => {
    server = await startServer((req, res) => {
      res.writeHead(200, { "content-length": String(BODY.length) });
      res.end(BODY);
    });
    await fsp.writeFile(partialPathFor(dir), BODY.subarray(0, 200));

    await downloadModel({ modelDir: dir, source: { ...source, url: server.url }, ...options });

    assert.deepEqual(fs.readFileSync(modelPathIn(dir)), BODY, "a 200 must overwrite, never append");
  });

  it("throws away a partial that is already at or past the full size", async () => {
    server = await startServer(serveRanged);
    await fsp.writeFile(partialPathFor(dir), Buffer.concat([BODY, Buffer.alloc(64)]));

    await downloadModel({ modelDir: dir, source: { ...source, url: server.url }, ...options });

    assert.deepEqual(fs.readFileSync(modelPathIn(dir)), BODY);
    assert.equal(server.requests[0].range, null, "an over-long partial is not a prefix to resume from");
  });

  it("refuses bytes that do not match the checksum, and keeps none of them", async () => {
    server = await startServer((req, res) => {
      const wrong = Buffer.from(BODY);
      wrong[0] ^= 0xff;
      res.writeHead(200, { "content-length": String(wrong.length) });
      res.end(wrong);
    });

    await assert.rejects(
      downloadModel({ modelDir: dir, source: { ...source, url: server.url }, ...options, maxAttempts: 1 }),
      /did not match its checksum/,
    );
    assert.equal(fs.existsSync(modelPathIn(dir)), false, "a bad download must never present as a model");
    assert.equal(fs.existsSync(partialPathFor(dir)), false, "corrupt bytes must not be resumed next time");
  });

  it("refuses a body that stopped early, in words a person can read", async () => {
    server = await startServer((req, res) => {
      res.writeHead(200, { "content-length": String(BODY.length) });
      // Deliver a prefix, then drop the connection — a network that died
      // mid-download, not a server that answered badly.
      res.write(BODY.subarray(0, 8), () => setTimeout(() => res.destroy(), 20));
    });

    await assert.rejects(
      downloadModel({ modelDir: dir, source: { ...source, url: server.url }, ...options, maxAttempts: 1 }),
      // This sentence is shown to the user, so it must not be "Error: aborted".
      /The connection dropped part-way through\./,
    );
    assert.equal(fs.existsSync(modelPathIn(dir)), false);
    // The partial is KEPT — only a checksum failure discards it — so the next
    // attempt resumes from whatever landed rather than starting over.
    assert.equal(fs.existsSync(partialPathFor(dir)), true);
  });

  it("says what the server answered, and retries", async () => {
    server = await startServer((req, res, count) => {
      if (count === 1) {
        res.writeHead(503);
        res.end();
        return;
      }
      serveRanged(req, res);
    });

    const result = await downloadModel({ modelDir: dir, source: { ...source, url: server.url }, ...options });
    assert.equal(result.downloaded, true);
    assert.equal(server.requests.length, 2);
  });

  it("gives up with the server's own answer in the message", async () => {
    server = await startServer((req, res) => {
      res.writeHead(404);
      res.end();
    });

    await assert.rejects(
      downloadModel({ modelDir: dir, source: { ...source, url: server.url }, ...options, maxAttempts: 1 }),
      /answered 404/,
    );
  });

  it("stops when it is cancelled", async () => {
    server = await startServer((req, res) => {
      // Never finishes: the abort is the only thing that can end this.
      res.writeHead(200, { "content-length": String(BODY.length) });
      res.write(BODY.subarray(0, 4));
    });
    const controller = new AbortController();
    const pending = downloadModel({
      modelDir: dir,
      source: { ...source, url: server.url },
      ...options,
      maxAttempts: 1,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);

    await assert.rejects(pending, /cancelled/);
    assert.equal(fs.existsSync(modelPathIn(dir)), false);
  });
});

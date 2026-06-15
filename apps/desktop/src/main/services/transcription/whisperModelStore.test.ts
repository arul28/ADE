import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  downloadWhisperModel,
  isWhisperModelInstalled,
  whisperModelPath,
} from "./whisperModelStore";

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

type TestServer = { url: string; hits: () => number; close: () => Promise<void> };

async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, hit: number) => void,
): Promise<TestServer> {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    handler(req, res, hits);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/ggml-base.en.bin`,
    hits: () => hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const tmpDirs: string[] = [];
async function makeModelDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ade-whisper-store-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    if (dir) await fsp.rm(dir, { recursive: true, force: true });
  }
});

describe("whisperModelStore.downloadWhisperModel", () => {
  it("streams the model to disk and verifies the pinned sha256", async () => {
    const body = Buffer.from("fake-whisper-model-bytes");
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "content-length": String(body.length) });
      res.end(body);
    });
    try {
      const modelDir = await makeModelDir();
      const progress: number[] = [];
      const result = await downloadWhisperModel({
        modelDir,
        source: { url: server.url, sha256: sha256(body) },
        minBytes: 1,
        onProgress: (p) => progress.push(p.receivedBytes),
      });
      expect(result.modelPath).toBe(whisperModelPath(modelDir));
      expect(fs.readFileSync(result.modelPath)).toEqual(body);
      expect(isWhisperModelInstalled(modelDir, 1)).toBe(true);
      expect(progress.at(-1)).toBe(body.length);
      // No leftover partial file.
      expect(fs.existsSync(`${result.modelPath}.part`)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("rejects a checksum mismatch and installs nothing", async () => {
    const body = Buffer.from("corrupted-bytes");
    const server = await startServer((_req, res) => {
      res.writeHead(200);
      res.end(body);
    });
    try {
      const modelDir = await makeModelDir();
      await expect(
        downloadWhisperModel({
          modelDir,
          source: { url: server.url, sha256: "0".repeat(64) },
          minBytes: 1,
          maxAttempts: 1,
        }),
      ).rejects.toThrow(/checksum mismatch/i);
      // Neither the final file nor a partial is left behind.
      expect(fs.existsSync(whisperModelPath(modelDir))).toBe(false);
      expect(fs.existsSync(`${whisperModelPath(modelDir)}.part`)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("retries a transient 500 then succeeds", async () => {
    const body = Buffer.from("eventually-ok-bytes");
    const server = await startServer((_req, res, hit) => {
      if (hit === 1) {
        res.writeHead(500);
        res.end("boom");
        return;
      }
      res.writeHead(200, { "content-length": String(body.length) });
      res.end(body);
    });
    try {
      const modelDir = await makeModelDir();
      const result = await downloadWhisperModel({
        modelDir,
        source: { url: server.url, sha256: sha256(body) },
        minBytes: 1,
        maxAttempts: 3,
      });
      expect(fs.readFileSync(result.modelPath)).toEqual(body);
      expect(server.hits()).toBeGreaterThanOrEqual(2);
    } finally {
      await server.close();
    }
  });

  it("is a no-op when the model is already installed", async () => {
    const modelDir = await makeModelDir();
    fs.writeFileSync(whisperModelPath(modelDir), Buffer.from("already-here"));
    const server = await startServer((_req, res) => {
      res.writeHead(500);
      res.end("should not be called");
    });
    try {
      await downloadWhisperModel({
        modelDir,
        source: { url: server.url, sha256: "unused" },
        minBytes: 1,
      });
      expect(server.hits()).toBe(0);
    } finally {
      await server.close();
    }
  });
});

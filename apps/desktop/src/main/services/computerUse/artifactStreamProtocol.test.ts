import { describe, expect, it, vi } from "vitest";
import {
  REMOTE_ARTIFACT_CHUNK_BYTES,
  artifactStreamMimeType,
  parseRangeHeader,
  respondToRemoteArtifactRequest,
  type RemoteArtifactRangeReader,
} from "./artifactStreamProtocol";

const URL_41MB = "ade-artifact://remote/target-1/project-1/.ade/artifacts/apple-recordings/lane-1/rec.mov";

/** A paired machine holding one file, answering the way its broker does. */
function fakeMachine(bytes: Buffer) {
  const reader = vi.fn<Parameters<RemoteArtifactRangeReader>, ReturnType<RemoteArtifactRangeReader>>(async ({ offset, length }) => ({
    totalSize: bytes.length,
    offset,
    data: bytes.subarray(offset, Math.min(bytes.length, offset + Math.min(length, 2 * 1024 * 1024))).toString("base64"),
  }));
  return reader;
}

function patterned(size: number): Buffer {
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 31) % 256;
  return bytes;
}

async function readAll(response: Response): Promise<Buffer> {
  return Buffer.from(await response.arrayBuffer());
}

describe("remote proof streaming", () => {
  it("answers a Range request with 206 and the exact bytes, one bounded chunk per call", async () => {
    const bytes = patterned(3 * REMOTE_ARTIFACT_CHUNK_BYTES + 123);
    const reader = fakeMachine(bytes);
    const start = REMOTE_ARTIFACT_CHUNK_BYTES - 10;
    const end = 3 * REMOTE_ARTIFACT_CHUNK_BYTES + 5;

    const response = await respondToRemoteArtifactRequest(
      new Request(URL_41MB, { headers: { Range: `bytes=${start}-${end}` } }),
      reader,
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(`bytes ${start}-${end}/${bytes.length}`);
    expect(response.headers.get("Content-Length")).toBe(String(end - start + 1));
    // `.mov` plays in Chromium only when it is called MP4.
    expect(response.headers.get("Content-Type")).toBe("video/mp4");
    expect(await readAll(response)).toEqual(bytes.subarray(start, end + 1));
    for (const [call] of reader.mock.calls) {
      expect(call.length).toBeLessThanOrEqual(REMOTE_ARTIFACT_CHUNK_BYTES);
      expect(call).toMatchObject({
        targetId: "target-1",
        projectId: "project-1",
        relativePath: ".ade/artifacts/apple-recordings/lane-1/rec.mov",
      });
    }
  });

  it("reads only what the player pulls, so a poster does not fetch the whole file", async () => {
    const bytes = patterned(41 * 1024 * 1024);
    const reader = fakeMachine(bytes);

    const response = await respondToRemoteArtifactRequest(
      new Request(URL_41MB, { headers: { Range: "bytes=0-" } }),
      reader,
    );
    expect(response.headers.get("Content-Range")).toBe(`bytes 0-${bytes.length - 1}/${bytes.length}`);
    const stream = response.body!.getReader();
    const first = await stream.read();
    expect(first.value?.byteLength).toBe(REMOTE_ARTIFACT_CHUNK_BYTES);
    await stream.cancel();

    expect(reader.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("serves suffix ranges and refuses a start past the end", async () => {
    const bytes = patterned(5000);
    const suffix = await respondToRemoteArtifactRequest(
      new Request(URL_41MB, { headers: { Range: "bytes=-100" } }),
      fakeMachine(bytes),
    );
    expect(suffix.headers.get("Content-Range")).toBe("bytes 4900-4999/5000");
    expect(await readAll(suffix)).toEqual(bytes.subarray(4900));

    const past = await respondToRemoteArtifactRequest(
      new Request(URL_41MB, { headers: { Range: "bytes=9000-" } }),
      fakeMachine(bytes),
    );
    expect(past.status).toBe(416);
    expect(past.headers.get("Content-Range")).toBe("bytes */5000");
  });

  it("answers 200 with the whole file when no Range is asked for", async () => {
    const bytes = patterned(REMOTE_ARTIFACT_CHUNK_BYTES + 1);
    const response = await respondToRemoteArtifactRequest(new Request(URL_41MB), fakeMachine(bytes));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Range")).toBeNull();
    expect(await readAll(response)).toEqual(bytes);
  });

  it("never asks the other machine for a path with `..` in it", async () => {
    const reader = fakeMachine(patterned(10));
    // A WHATWG `Request` folds `..` before this code sees it, and the other
    // machine's jail refuses what that folds to. This covers a raw URL that
    // reaches the handler unfolded.
    const raw = {
      url: "ade-artifact://remote/target-1/project-1/.ade/artifacts/../../.env",
      headers: new Headers(),
    } as unknown as Request;
    const response = await respondToRemoteArtifactRequest(raw, reader);
    expect(response.status).toBe(404);
    expect(reader).not.toHaveBeenCalled();
  });

  it("passes the other machine's refusal through as a clear error", async () => {
    const offline = vi.fn<Parameters<RemoteArtifactRangeReader>, ReturnType<RemoteArtifactRangeReader>>(async () => {
      throw new Error("MacBook Pro is offline.");
    });
    const response = await respondToRemoteArtifactRequest(
      new Request(URL_41MB, { headers: { Range: "bytes=0-" } }),
      offline,
    );
    expect(response.status).toBe(502);
    expect(await response.text()).toBe("MacBook Pro is offline.");

    const notReady = await respondToRemoteArtifactRequest(new Request(URL_41MB), null);
    expect(notReady.status).toBe(503);
  });

  it("errors the body when the file shrinks mid-stream instead of hanging", async () => {
    const bytes = patterned(3 * REMOTE_ARTIFACT_CHUNK_BYTES);
    let calls = 0;
    const reader = vi.fn<Parameters<RemoteArtifactRangeReader>, ReturnType<RemoteArtifactRangeReader>>(async ({ offset, length }) => {
      calls += 1;
      const data = calls === 1 ? bytes.subarray(offset, offset + length) : Buffer.alloc(0);
      return { totalSize: bytes.length, offset, data: data.toString("base64") };
    });
    const response = await respondToRemoteArtifactRequest(
      new Request(URL_41MB, { headers: { Range: "bytes=0-" } }),
      reader,
    );
    await expect(response.arrayBuffer()).rejects.toThrow();
  });
});

describe("artifact stream helpers", () => {
  it("serves QuickTime as MP4 and parses the first range", () => {
    expect(artifactStreamMimeType("a/b/rec.MOV")).toBe("video/mp4");
    expect(artifactStreamMimeType("x.png")).toBe("image/png");
    expect(artifactStreamMimeType("x.bin")).toBe("application/octet-stream");
    expect(parseRangeHeader("bytes=10-20")).toEqual({ kind: "from", start: 10, end: 20 });
    expect(parseRangeHeader("bytes=10-")).toEqual({ kind: "from", start: 10, end: null });
    expect(parseRangeHeader("bytes=-5")).toEqual({ kind: "suffix", length: 5 });
    expect(parseRangeHeader("bytes=-")).toBeNull();
    expect(parseRangeHeader(null)).toBeNull();
  });
});

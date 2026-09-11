import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ATTACHMENT_CHUNK_BYTES,
  attachmentMimeTypeForPath,
  createChunkedAttachmentStagingRegistry,
  readAttachmentChunk,
} from "./fileAttachment";

function tempProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ade-file-attachment-"));
}

describe("chunked attachment staging", () => {
  it("reassembles a multi-chunk upload into one staged file", async () => {
    const projectRoot = tempProjectRoot();
    const registry = createChunkedAttachmentStagingRegistry();
    const begun = registry.begin({ projectRoot, filename: "clip.mov" });
    const body = Buffer.from("0123456789".repeat(64));

    await registry.append({ uploadId: begun.uploadId, base64: body.subarray(0, 300).toString("base64") });
    await registry.append({ uploadId: begun.uploadId, base64: body.subarray(300).toString("base64") });
    const finished = await registry.finish({ uploadId: begun.uploadId });

    expect(finished.mimeType).toBe("video/quicktime");
    expect(finished.byteLength).toBe(body.byteLength);
    expect(fs.readFileSync(finished.path)).toEqual(body);
    // The basename is a fresh UUID; only the extension comes from the client.
    expect(path.extname(finished.path)).toBe(".mov");
    expect(path.dirname(finished.path)).toBe(path.join(projectRoot, ".ade", "attachments"));
    expect(registry.pendingCount()).toBe(0);
  });

  it("enforces the 50 MB ceiling on the running total, not the declared size", async () => {
    const projectRoot = tempProjectRoot();
    const registry = createChunkedAttachmentStagingRegistry({ maxBytes: 64 });
    const begun = registry.begin({ projectRoot, filename: "big.bin" });

    await registry.append({ uploadId: begun.uploadId, base64: Buffer.alloc(48).toString("base64") });
    await expect(
      registry.append({ uploadId: begun.uploadId, base64: Buffer.alloc(48).toString("base64") }),
    ).rejects.toThrow(/too large/i);
    // The session is dropped and its partial bytes removed, so a client cannot
    // resume past the cap.
    expect(registry.pendingCount()).toBe(0);
  });

  it("rejects an oversize declared total before any bytes move", () => {
    const projectRoot = tempProjectRoot();
    const registry = createChunkedAttachmentStagingRegistry({ maxBytes: 64 });
    expect(() => registry.begin({ projectRoot, filename: "big.bin", totalBytes: 1_000 })).toThrow(/too large/i);
  });

  it("leaves nothing at the final path when an upload is abandoned", async () => {
    const projectRoot = tempProjectRoot();
    const registry = createChunkedAttachmentStagingRegistry();
    const begun = registry.begin({ projectRoot, filename: "torn.pdf" });
    await registry.append({ uploadId: begun.uploadId, base64: Buffer.from("partial").toString("base64") });

    expect(await registry.abort({ uploadId: begun.uploadId })).toEqual({ aborted: true });
    const dir = path.join(projectRoot, ".ade", "attachments");
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
  });

  it("refuses chunks for an unknown or expired upload", async () => {
    await expect(
      createChunkedAttachmentStagingRegistry().append({ uploadId: "nope", base64: "AAAA" }),
    ).rejects.toThrow(/expired/i);
  });

  /**
   * A host restart (or a client that begins and vanishes) leaves a `.part` file
   * with nothing in memory that names it. The mtime sweep on `begin` is the
   * only thing that can reclaim those, so it is pinned here.
   */
  it("sweeps orphaned .part files older than the session TTL on begin", async () => {
    const projectRoot = tempProjectRoot();
    const dir = path.join(projectRoot, ".ade", "attachments");
    fs.mkdirSync(dir, { recursive: true });
    const orphan = path.join(dir, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.pdf.part");
    const fresh = path.join(dir, "ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee.pdf.part");
    const keeper = path.join(dir, "ffffffff-bbbb-cccc-dddd-eeeeeeeeeeff.pdf");
    fs.writeFileSync(orphan, "stale");
    fs.writeFileSync(fresh, "recent");
    fs.writeFileSync(keeper, "finished");
    const old = new Date(Date.now() - 600_000);
    fs.utimesSync(orphan, old, old);

    const registry = createChunkedAttachmentStagingRegistry({ ttlMs: 60_000 });
    registry.begin({ projectRoot, filename: "next.pdf" });
    // Fire-and-forget so it cannot fail a user's upload; drain the microtasks
    // and the readdir/stat/unlink round trip before asserting.
    await new Promise((resolve) => { setTimeout(resolve, 50); });

    expect(fs.existsSync(orphan)).toBe(false);
    // A `.part` inside the TTL may still belong to a live session on another
    // host process, and a finished attachment is never a sweep candidate.
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(keeper)).toBe(true);
  });

  /**
   * The ceiling is reserved before the write, so two appends that interleave on
   * one upload id cannot both read the pre-write counter and overshoot.
   */
  it("accounts for concurrent appends against the ceiling before writing", async () => {
    const projectRoot = tempProjectRoot();
    const registry = createChunkedAttachmentStagingRegistry({ maxBytes: 64 });
    const begun = registry.begin({ projectRoot, filename: "race.bin" });
    const chunk = Buffer.alloc(48).toString("base64");

    const results = await Promise.allSettled([
      registry.append({ uploadId: begun.uploadId, base64: chunk }),
      registry.append({ uploadId: begun.uploadId, base64: chunk }),
    ]);

    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(registry.pendingCount()).toBe(0);
  });

  /**
   * `appendFile` can write part of a chunk before throwing, so the `.part` is
   * left holding an unknown number of bytes. Rolling the counter back would
   * under-count what is on disk and publish a silently corrupt file, so the
   * whole upload is failed instead.
   */
  it("fails the whole upload when a chunk write throws", async () => {
    const projectRoot = tempProjectRoot();
    const registry = createChunkedAttachmentStagingRegistry();
    const begun = registry.begin({ projectRoot, filename: "torn.bin" });
    await registry.append({ uploadId: begun.uploadId, base64: Buffer.from("good").toString("base64") });

    const realAppend = fs.promises.appendFile;
    try {
      // @ts-expect-error test seam
      fs.promises.appendFile = async (target: string, chunk: Buffer) => {
        // A partial write, then the failure: exactly the state the rollback
        // used to mis-account for.
        await realAppend(target, chunk.subarray(0, 2));
        throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      };
      await expect(
        registry.append({ uploadId: begun.uploadId, base64: Buffer.from("more").toString("base64") }),
      ).rejects.toThrow(/could not be written/i);
    } finally {
      fs.promises.appendFile = realAppend;
    }

    expect(registry.pendingCount()).toBe(0);
    const dir = path.join(projectRoot, ".ade", "attachments");
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
    // The upload id is gone, so a client cannot resume onto the torn file.
    await expect(
      registry.append({ uploadId: begun.uploadId, base64: "AAAA" }),
    ).rejects.toThrow(/expired/i);
  });

  /** A 0-byte attachment is rejected rather than staged as an empty path. */
  it("rejects a finish with no bytes and leaves nothing on disk", async () => {
    const projectRoot = tempProjectRoot();
    const registry = createChunkedAttachmentStagingRegistry();
    const begun = registry.begin({ projectRoot, filename: "empty.txt" });

    await expect(registry.finish({ uploadId: begun.uploadId })).rejects.toThrow(/empty/i);
    const dir = path.join(projectRoot, ".ade", "attachments");
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
    expect(registry.pendingCount()).toBe(0);
  });
});

describe("readAttachmentChunk", () => {
  it("walks a file in bounded slices and reports eof", async () => {
    const projectRoot = tempProjectRoot();
    const filePath = path.join(projectRoot, "doc.pdf");
    const body = Buffer.from("abcdefghij".repeat(10));
    fs.writeFileSync(filePath, body);

    const first = await readAttachmentChunk(filePath, 0, 40);
    expect(first.byteLength).toBe(40);
    expect(first.totalBytes).toBe(body.byteLength);
    expect(first.mimeType).toBe("application/pdf");
    expect(first.eof).toBe(false);

    const rest = await readAttachmentChunk(filePath, first.byteLength, null);
    expect(rest.eof).toBe(true);
    expect(Buffer.concat([
      Buffer.from(first.base64, "base64"),
      Buffer.from(rest.base64, "base64"),
    ])).toEqual(body);
  });

  it("clamps a caller-requested length to the chunk ceiling", async () => {
    const projectRoot = tempProjectRoot();
    const filePath = path.join(projectRoot, "big.bin");
    fs.writeFileSync(filePath, Buffer.alloc(ATTACHMENT_CHUNK_BYTES * 2));
    const chunk = await readAttachmentChunk(filePath, 0, ATTACHMENT_CHUNK_BYTES * 2);
    expect(chunk.byteLength).toBe(ATTACHMENT_CHUNK_BYTES);
    expect(chunk.eof).toBe(false);
  });

  it("names types it knows and falls back to octet-stream", () => {
    expect(attachmentMimeTypeForPath("/x/a.mp4")).toBe("video/mp4");
    expect(attachmentMimeTypeForPath("/x/a.weird")).toBe("application/octet-stream");
  });
});

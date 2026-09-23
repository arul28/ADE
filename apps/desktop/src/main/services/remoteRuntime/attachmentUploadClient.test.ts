import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseRemoteAttachmentUploadTicket, withTempAttachmentFile } from "./attachmentUploadClient";

/**
 * The ticket arrives over the sync socket as untyped JSON from another machine,
 * and it is the only thing that names the route this process is about to POST a
 * file to. Everything it accepts has to be checked here, because nothing
 * downstream re-checks it.
 */
describe("parseRemoteAttachmentUploadTicket", () => {
  const valid = {
    ticket: "tkt-abc",
    path: "/remote-attachment-upload/tkt-abc",
    maxBytes: 50 * 1024 * 1024,
    expiresAtMs: 1_787_000_000_000,
  };

  it("accepts a well-formed ticket and normalises it", () => {
    expect(parseRemoteAttachmentUploadTicket(valid)).toEqual(valid);
  });

  it("trims surrounding whitespace on the ticket and the route path", () => {
    expect(parseRemoteAttachmentUploadTicket({ ...valid, ticket: "  tkt-abc  ", path: " /up " }))
      .toEqual({ ...valid, ticket: "tkt-abc", path: "/up" });
  });

  it("floors a fractional byte cap rather than carrying it into a size check", () => {
    expect(parseRemoteAttachmentUploadTicket({ ...valid, maxBytes: 1024.9 })?.maxBytes)
      .toBe(1024);
  });

  it("accepts a numeric string cap, which is how JSON transports large ints", () => {
    expect(parseRemoteAttachmentUploadTicket({ ...valid, maxBytes: "2048" })?.maxBytes)
      .toBe(2048);
  });

  it("defaults an unusable expiry to 0 rather than NaN", () => {
    expect(parseRemoteAttachmentUploadTicket({ ...valid, expiresAtMs: "soon" })?.expiresAtMs)
      .toBe(0);
    expect(parseRemoteAttachmentUploadTicket({ ...valid, expiresAtMs: undefined })?.expiresAtMs)
      .toBe(0);
  });

  it("rejects a missing or blank ticket", () => {
    expect(parseRemoteAttachmentUploadTicket({ ...valid, ticket: "" })).toBeNull();
    expect(parseRemoteAttachmentUploadTicket({ ...valid, ticket: "   " })).toBeNull();
    expect(parseRemoteAttachmentUploadTicket({ ...valid, ticket: 42 })).toBeNull();
  });

  it("rejects a route path that is not rooted", () => {
    // A relative path would be resolved against the capability URL's own path,
    // and an absolute URL would move the request to another origin entirely.
    expect(parseRemoteAttachmentUploadTicket({ ...valid, path: "upload" })).toBeNull();
    expect(parseRemoteAttachmentUploadTicket({ ...valid, path: "" })).toBeNull();
    expect(parseRemoteAttachmentUploadTicket({ ...valid, path: "https://evil.example/up" }))
      .toBeNull();
  });

  it("rejects a non-positive or unreadable byte cap", () => {
    expect(parseRemoteAttachmentUploadTicket({ ...valid, maxBytes: 0 })).toBeNull();
    expect(parseRemoteAttachmentUploadTicket({ ...valid, maxBytes: -1 })).toBeNull();
    expect(parseRemoteAttachmentUploadTicket({ ...valid, maxBytes: "lots" })).toBeNull();
    expect(parseRemoteAttachmentUploadTicket({ ...valid, maxBytes: undefined })).toBeNull();
    expect(parseRemoteAttachmentUploadTicket({ ...valid, maxBytes: Number.POSITIVE_INFINITY }))
      .toBeNull();
  });

  it("rejects anything that is not an object", () => {
    expect(parseRemoteAttachmentUploadTicket(null)).toBeNull();
    expect(parseRemoteAttachmentUploadTicket(undefined)).toBeNull();
    expect(parseRemoteAttachmentUploadTicket("tkt-abc")).toBeNull();
    expect(parseRemoteAttachmentUploadTicket(7)).toBeNull();
  });
});

describe("withTempAttachmentFile", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true })));
  });

  async function tempRoot(): Promise<string> {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ade-temp-attachment-test-"));
    roots.push(root);
    return root;
  }

  it("hands the upload a file with the exact bytes, then removes it", async () => {
    const root = await tempRoot();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    let seenPath = "";
    const result = await withTempAttachmentFile(bytes, async (sourcePath) => {
      seenPath = sourcePath;
      expect(await fs.promises.readFile(sourcePath)).toEqual(bytes);
      return { path: "/remote/landed.png" };
    }, root);

    expect(result).toEqual({ path: "/remote/landed.png" });
    expect(seenPath.startsWith(root)).toBe(true);
    await expect(fs.promises.readdir(root)).resolves.toEqual([]);
  });

  it("removes the file when the upload fails, and passes the failure on", async () => {
    const root = await tempRoot();
    await expect(withTempAttachmentFile(Buffer.from("x"), async () => {
      throw new Error("Attachment upload failed (HTTP 502).");
    }, root)).rejects.toThrow("Attachment upload failed (HTTP 502).");
    await expect(fs.promises.readdir(root)).resolves.toEqual([]);
  });
});

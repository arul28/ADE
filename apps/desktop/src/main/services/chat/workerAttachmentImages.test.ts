import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  materializeWorkerImages,
  workerPathImagesFromAttachments,
} from "./workerAttachmentImages";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-worker-images-"));
  tempDirs.push(dir);
  return dir;
}

describe("workerPathImagesFromAttachments", () => {
  it("sends local screenshots as paths with a sandbox root, not inline bytes", () => {
    expect(workerPathImagesFromAttachments([
      { path: "shot.png", resolvedPath: "/repo/.ade/attachments/shot.png", rootPath: "/repo" },
    ])).toEqual([
      { path: "/repo/.ade/attachments/shot.png", mimeType: "image/png", rootPath: "/repo" },
    ]);
  });
});

describe("materializeWorkerImages", () => {
  it("reads path images inside the attachment root and keeps URLs remote", async () => {
    const root = makeTempDir();
    const filePath = path.join(root, "shot.png");
    fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    await expect(materializeWorkerImages([
      { path: filePath, mimeType: "image/png", rootPath: root },
      { url: "https://example.com/ui.png" },
      { data: "abc", mimeType: "image/jpeg" },
    ])).resolves.toEqual([
      { data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64"), mimeType: "image/png" },
      { url: "https://example.com/ui.png" },
      { data: "abc", mimeType: "image/jpeg" },
    ]);
  });

  it("rejects an oversized screenshot instead of stuffing it onto the IPC pipe", async () => {
    const root = makeTempDir();
    const filePath = path.join(root, "huge.png");
    fs.writeFileSync(filePath, Buffer.alloc(8, 1));
    await expect(materializeWorkerImages(
      [{ path: filePath, mimeType: "image/png", rootPath: root }],
      { maxBytes: 4 },
    )).rejects.toThrow(/too large/);
  });

  it("refuses a path that escaped the attachment root", async () => {
    const root = makeTempDir();
    const outside = makeTempDir();
    const filePath = path.join(outside, "secret.png");
    fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await expect(materializeWorkerImages([
      { path: filePath, mimeType: "image/png", rootPath: root },
    ])).rejects.toThrow(/could not be read/);
  });
});

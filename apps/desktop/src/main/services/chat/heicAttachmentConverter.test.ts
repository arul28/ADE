import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HeicAttachmentConversionError } from "./heicAttachmentConverter";
import { convertHeicBufferToJpeg } from "./heicAttachmentConverter";

describe("convertHeicBufferToJpeg", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.promises.mkdtemp(path.join(process.cwd(), ".heic-converter-test-"));
  });

  afterEach(async () => {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });

  it("converts HEIC bytes to a JPEG and removes its temporary source files", async () => {
    const source = Buffer.from("synthetic-heic");
    const jpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]);
    const runSips = vi.fn(async (inputPath: string, outputPath: string) => {
      await expect(fs.promises.readFile(inputPath)).resolves.toEqual(source);
      expect(path.basename(inputPath)).toBe("source.heic");
      expect(path.basename(outputPath)).toBe("converted.jpg");
      await fs.promises.writeFile(outputPath, jpeg);
    });

    await expect(convertHeicBufferToJpeg(
      source,
      "../IMG_0001.HEIF",
      "image/heif",
      { platform: "darwin", tempRoot, runSips },
    )).resolves.toEqual({
      data: jpeg,
      filename: "IMG_0001.jpg",
      mimeType: "image/jpeg",
    });

    expect(runSips).toHaveBeenCalledOnce();
    await expect(fs.promises.readdir(tempRoot)).resolves.toEqual([]);
  });

  it.each(["win32", "linux"] as const)("fails honestly on %s without the bundled HEIF decoder", async (platform) => {
    const runSips = vi.fn();

    await expect(convertHeicBufferToJpeg(
      Buffer.from("synthetic-heic"),
      "photo.heic",
      "image/heic",
      { platform, tempRoot, runSips },
    )).rejects.toMatchObject({
      code: "unavailable",
      name: "HeicAttachmentConversionError",
    } satisfies Partial<HeicAttachmentConversionError>);

    expect(runSips).not.toHaveBeenCalled();
    await expect(fs.promises.readdir(tempRoot)).resolves.toEqual([]);
  });

  it("rejects decoder output that is not a JPEG", async () => {
    const runSips = vi.fn(async (_inputPath: string, outputPath: string) => {
      await fs.promises.writeFile(outputPath, "not-an-image");
    });

    await expect(convertHeicBufferToJpeg(
      Buffer.from("synthetic-heic"),
      "photo.heic",
      undefined,
      { platform: "darwin", tempRoot, runSips },
    )).rejects.toMatchObject({
      code: "failed",
      name: "HeicAttachmentConversionError",
    } satisfies Partial<HeicAttachmentConversionError>);

    expect(runSips).toHaveBeenCalledOnce();
    await expect(fs.promises.readdir(tempRoot)).resolves.toEqual([]);
  });
});

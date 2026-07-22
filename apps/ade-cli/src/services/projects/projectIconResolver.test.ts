import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  REMOTE_ICON_MAX_DATA_URL_BYTES,
  resolveRemoteProjectIcon,
} from "./projectIconResolver";

const tempRoots = new Set<string>();

function makeTempRoot(prefix = "ade-project-icon-"): string {
  // realpath collapses the macOS /var -> /private/var tmpdir symlink so the
  // resolver's within-root containment checks compare like-for-like paths.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempRoots.add(root);
  return root;
}

function writeFileEnsuringDir(filePath: string, data: Buffer | string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, data);
}

function decodeDataUrl(dataUrl: string): { mime: string; bytes: Buffer } {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error(`not a base64 data url: ${dataUrl.slice(0, 32)}…`);
  return { mime: match[1], bytes: Buffer.from(match[2], "base64") };
}

afterEach(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

describe("resolveRemoteProjectIcon", () => {
  it("returns an all-null icon when the project has no recognizable icon", () => {
    const root = makeTempRoot();
    writeFileEnsuringDir(path.join(root, "README.md"), "# no icon here");

    const icon = resolveRemoteProjectIcon(root);

    expect(icon.dataUrl).toBeNull();
    expect(icon.sourcePath).toBeNull();
    expect(icon.mimeType).toBeNull();
  });

  it("inlines a conventional PNG icon as a base64 data URL with the right mime", () => {
    const root = makeTempRoot();
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    writeFileEnsuringDir(path.join(root, "logo.png"), pngBytes);

    const icon = resolveRemoteProjectIcon(root);

    expect(icon.mimeType).toBe("image/png");
    expect(icon.sourcePath).toBe(path.join(root, "logo.png"));
    expect(icon.dataUrl).not.toBeNull();
    const decoded = decodeDataUrl(icon.dataUrl as string);
    expect(decoded.mime).toBe("image/png");
    // The inlined bytes must round-trip exactly, not a re-encoded approximation.
    expect(decoded.bytes.equals(pngBytes)).toBe(true);
  });

  it("maps SVG icons to image/svg+xml", () => {
    const root = makeTempRoot();
    writeFileEnsuringDir(path.join(root, "public", "favicon.svg"), "<svg/>");

    const icon = resolveRemoteProjectIcon(root);

    expect(icon.mimeType).toBe("image/svg+xml");
    expect(icon.sourcePath).toBe(path.join(root, "public", "favicon.svg"));
    expect(decodeDataUrl(icon.dataUrl as string).bytes.toString("utf8")).toBe("<svg/>");
  });

  it("honors an explicit project.iconPath override in .ade/ade.yaml", () => {
    const root = makeTempRoot();
    // A conventional candidate exists, but the override must win.
    writeFileEnsuringDir(path.join(root, "logo.png"), Buffer.from([1]));
    writeFileEnsuringDir(path.join(root, "brand", "custom-icon.png"), Buffer.from([9, 9, 9]));
    writeFileEnsuringDir(
      path.join(root, ".ade", "ade.yaml"),
      "version: 1\nproject:\n  iconPath: brand/custom-icon.png\n",
    );

    const icon = resolveRemoteProjectIcon(root);

    expect(icon.sourcePath).toBe(path.join(root, "brand", "custom-icon.png"));
    expect(decodeDataUrl(icon.dataUrl as string).bytes.equals(Buffer.from([9, 9, 9]))).toBe(true);
  });

  it("treats an explicit null iconPath as 'no icon' even when a candidate exists", () => {
    const root = makeTempRoot();
    writeFileEnsuringDir(path.join(root, "logo.png"), Buffer.from([1, 2, 3]));
    writeFileEnsuringDir(
      path.join(root, ".ade", "ade.yaml"),
      "version: 1\nproject:\n  iconPath: null\n",
    );

    const icon = resolveRemoteProjectIcon(root);

    expect(icon.dataUrl).toBeNull();
    expect(icon.sourcePath).toBeNull();
    expect(icon.mimeType).toBeNull();
  });

  it("resolves an icon referenced by index.html <link rel=icon>", () => {
    const root = makeTempRoot();
    writeFileEnsuringDir(
      path.join(root, "index.html"),
      '<!doctype html><html><head><link rel="icon" href="/brand.png"></head></html>',
    );
    writeFileEnsuringDir(path.join(root, "brand.png"), Buffer.from([7, 7]));

    const icon = resolveRemoteProjectIcon(root);

    expect(icon.sourcePath).toBe(path.join(root, "brand.png"));
    expect(icon.mimeType).toBe("image/png");
  });

  it("rejects an iconPath override that escapes the project root via ..", () => {
    const root = makeTempRoot();
    const outside = path.join(path.dirname(root), `outside-${path.basename(root)}.png`);
    fs.writeFileSync(outside, Buffer.from([0xde, 0xad]));
    tempRoots.add(outside); // ensure cleanup
    writeFileEnsuringDir(
      path.join(root, ".ade", "ade.yaml"),
      `version: 1\nproject:\n  iconPath: ../${path.basename(outside)}\n`,
    );

    const icon = resolveRemoteProjectIcon(root);

    expect(icon.dataUrl).toBeNull();
    expect(icon.sourcePath).toBeNull();
  });

  it("does not follow a symlinked directory that points outside the project root", () => {
    const root = makeTempRoot();
    const outsideDir = makeTempRoot("ade-project-icon-outside-");
    fs.writeFileSync(path.join(outsideDir, "favicon.png"), Buffer.from([0xca, 0xfe]));
    // `public` is a symlink escaping the root; the public/favicon.png candidate
    // must not be read.
    fs.symlinkSync(outsideDir, path.join(root, "public"));

    const icon = resolveRemoteProjectIcon(root);

    expect(icon.dataUrl).toBeNull();
    expect(icon.sourcePath).toBeNull();
  });

  it("never returns an encoded icon above the wire cap and keeps its metadata", () => {
    const root = makeTempRoot();
    // Invalid raster data makes the thumbnailer take its bounded raw-PNG
    // fallback, where base64 expansion pushes this beyond the encoded cap.
    const big = Buffer.alloc(REMOTE_ICON_MAX_DATA_URL_BYTES, 0);
    writeFileEnsuringDir(path.join(root, "logo.png"), big);

    const icon = resolveRemoteProjectIcon(root);

    expect(icon.dataUrl).toBeNull();
    expect(icon.mimeType).toBe("image/png");
    expect(icon.sourcePath).toBe(path.join(root, "logo.png"));
  });

  it("returns an all-null icon for an empty or whitespace root path", () => {
    const icon = resolveRemoteProjectIcon("   ");
    expect(icon).toEqual({ dataUrl: null, sourcePath: null, mimeType: null });
  });
});

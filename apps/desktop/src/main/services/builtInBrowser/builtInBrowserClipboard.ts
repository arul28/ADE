import fs from "node:fs/promises";
import path from "node:path";
import { clipboard, nativeImage } from "electron";
import os from "node:os";
import type {
  BuiltInBrowserClipboardImage,
  BuiltInBrowserClipboardReadResult,
  BuiltInBrowserClipboardWriteArgs,
  BuiltInBrowserClipboardWriteResult,
} from "../../../shared/types/builtInBrowser";
import {
  builtInBrowserUploadRoots,
  resolveReadableBrowserFiles,
} from "./builtInBrowserCapabilities";
import { readClipboardHtml, readClipboardImage, readClipboardItem, writeClipboardFlavors } from "../shared/electronClipboard";

/** How much clipboard text one read may return. */
const MAX_CLIPBOARD_READ_CHARS = 64_000;
/** Scratch PNGs kept for clipboard images; older ones are deleted. */
const MAX_CLIPBOARD_IMAGES = 20;

async function prune(dir: string): Promise<void> {
  try {
    const names = (await fs.readdir(dir)).filter((name) => name.endsWith(".png")).sort();
    const excess = names.slice(0, Math.max(0, names.length - MAX_CLIPBOARD_IMAGES));
    for (const name of excess) await fs.unlink(path.join(dir, name)).catch(() => {});
  } catch {
    // Housekeeping only: a prune failure must never fail the read.
  }
}

/**
 * Read every flavor the clipboard can give an agent.
 *
 * The image is a scratch file, not bytes in the answer: a 30 MB PNG never
 * enters a transcript, and a path can be attached. It lands beside the
 * collection's observations so a remote caller receives it with the result.
 */
export async function readClipboardContents(args: {
  observationRootPath: string | null;
}): Promise<BuiltInBrowserClipboardReadResult> {
  const item = await readClipboardItem();
  const text = await clipboard.readText();
  const html = await readClipboardHtml(item);
  // A copied FILE also exposes an image flavor (its icon) on both platforms.
  // Reporting that as "the clipboard image" would hand the agent a picture of a
  // file it cannot open, so the file flavors win until file support lands.
  // Copied files are `text/uri-list`; the raw platform names stay as a backstop.
  const formats = (item?.types ?? []).map((format) => format.toLowerCase());
  const fileFlavor = formats.some((format) => (
    format === "text/uri-list" || format.includes("file-url") || format.includes("filenames") || format.includes("filenamew")
  ));
  // An EMPTY NativeImage when there is no image, never null, so the check is
  // `isEmpty()` rather than a truth test.
  const image = fileFlavor ? nativeImage.createEmpty() : await readClipboardImage(item);
  let imageInfo: BuiltInBrowserClipboardImage | null = null;
  if (!image.isEmpty()) {
    const png = image.toPNG();
    const { width, height } = image.getSize();
    const dir = path.join(args.observationRootPath ?? path.join(os.tmpdir(), "ade-clipboard"), "clipboard");
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `clipboard-${Date.now()}-${Math.random().toString(16).slice(2, 10)}.png`);
    await fs.writeFile(filePath, png);
    await prune(dir);
    imageInfo = { filePath, width, height, bytes: png.byteLength, mimeType: "image/png" };
  }
  return {
    text: text.slice(0, MAX_CLIPBOARD_READ_CHARS),
    html: html ? html.slice(0, MAX_CLIPBOARD_READ_CHARS) : null,
    image: imageInfo,
    truncated: text.length > MAX_CLIPBOARD_READ_CHARS || html.length > MAX_CLIPBOARD_READ_CHARS,
  };
}

/**
 * Write text, HTML or an image.
 *
 * An `--image` path goes through the same upload-root jail as `upload` and
 * `drop`: otherwise the clipboard would be a way to stage a file the jail
 * refuses and paste it into a page.
 */
export async function writeClipboardContents(args: {
  projectRoot: string | null;
  observationRootPath: string | null;
  input: BuiltInBrowserClipboardWriteArgs;
}): Promise<BuiltInBrowserClipboardWriteResult> {
  const text = typeof args.input.text === "string" && args.input.text.trim() ? args.input.text : null;
  const html = typeof args.input.html === "string" && args.input.html.trim() ? args.input.html : null;
  const imagePath = typeof args.input.imagePath === "string" && args.input.imagePath.trim()
    ? args.input.imagePath.trim()
    : null;
  let image: Electron.NativeImage | null = null;
  if (imagePath) {
    const roots = builtInBrowserUploadRoots({
      projectRoot: args.projectRoot,
      observationRoot: args.observationRootPath,
      tmpDir: os.tmpdir(),
    });
    const [resolved] = await resolveReadableBrowserFiles([imagePath], "clipboard image", roots);
    image = nativeImage.createFromPath(resolved);
    if (image.isEmpty()) throw new Error(`Browser clipboard image could not be decoded: ${resolved}`);
  }
  if (!text && !html && !image) {
    throw new Error("browser clipboard write needs --value, --html or --image.");
  }
  // One write carries every flavor at once, so an image and its alt text do
  // not overwrite each other.
  await writeClipboardFlavors({ text, html, image });
  return { written: true };
}

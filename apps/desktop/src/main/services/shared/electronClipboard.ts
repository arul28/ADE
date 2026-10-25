import { clipboard, ClipboardItem, nativeImage, type NativeImage } from "electron";

/**
 * Electron's clipboard since 44: every read and write is a Promise, and the
 * per-flavor helpers (`readImage`, `readHTML`, `availableFormats`,
 * `readBuffer`, `writeImage`) are gone. One `clipboard.read()` lists the
 * flavors as MIME types; a platform format with no MIME mapping is listed as
 * `electron application/osclipboard;format="<name>"`.
 *
 * Reading `image/*` makes Chromium decode the picture, so callers that poll
 * should not read images on every tick.
 */

/** The type `clipboard.read()` lists a raw platform format under (Windows' "CanIncludeInClipboardHistory", macOS' "org.nspasteboard.ConcealedType"). */
export function osClipboardType(format: string): string {
  return `electron application/osclipboard;format="${format}"`;
}

/** The clipboard's single item, or null when it is empty. */
export async function readClipboardItem(): Promise<Electron.ClipboardItem | null> {
  const [item] = await clipboard.read();
  return item ?? null;
}

/** Every flavor on the clipboard, as `clipboard.read()` names them. */
export async function readClipboardTypes(): Promise<string[]> {
  return (await readClipboardItem())?.types ?? [];
}

async function readClipboardTypeBytes(item: Electron.ClipboardItem | null, type: string): Promise<Buffer | null> {
  if (!item?.types.includes(type)) return null;
  const blob = await item.getType(type);
  if (!(blob instanceof Blob)) return null;
  return Buffer.from(await blob.arrayBuffer());
}

/** The bytes of a raw platform format; empty when it is absent. */
export async function readClipboardFormat(format: string): Promise<Buffer> {
  return (await readClipboardTypeBytes(await readClipboardItem(), osClipboardType(format))) ?? Buffer.alloc(0);
}

/** The clipboard's HTML, or "" when there is none. */
export async function readClipboardHtml(item?: Electron.ClipboardItem | null): Promise<string> {
  const source = item === undefined ? await readClipboardItem() : item;
  return (await readClipboardTypeBytes(source, "text/html"))?.toString("utf8") ?? "";
}

/**
 * The clipboard's picture, or an empty image when there is none (the same
 * contract as the old `clipboard.readImage()`). Chromium hands every
 * `image/*` flavor back as PNG bytes.
 */
export async function readClipboardImage(item?: Electron.ClipboardItem | null): Promise<NativeImage> {
  const source = item === undefined ? await readClipboardItem() : item;
  const types = source?.types ?? [];
  const type = types.includes("image/png")
    ? "image/png"
    : types.find((candidate) => candidate.startsWith("image/") && candidate !== "image/svg+xml");
  if (!type) return nativeImage.createEmpty();
  const png = await readClipboardTypeBytes(source, type);
  return png && png.length > 0 ? nativeImage.createFromBuffer(png) : nativeImage.createEmpty();
}

/** A PNG flavor for a `ClipboardItem`. */
export function clipboardPngBlob(image: NativeImage): Blob {
  return new Blob([new Uint8Array(image.toPNG())], { type: "image/png" });
}

/** Puts a picture on the clipboard, replacing what was there. */
export async function writeClipboardImage(image: NativeImage): Promise<void> {
  await clipboard.write([new ClipboardItem({ "image/png": clipboardPngBlob(image) })]);
}

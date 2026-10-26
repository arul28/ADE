import { clipboard, ClipboardItem, nativeImage, type NativeImage } from "electron";

/**
 * Electron's clipboard since 44: every read and write is a Promise, and the
 * per-flavor helpers (`readImage`, `readHTML`, `availableFormats`,
 * `readBuffer`, `writeImage`) are gone. One `clipboard.read()` lists the
 * flavors as MIME types; a platform format with no MIME mapping is listed as
 * `electron application/osclipboard;format="<name>"`. Plain text keeps
 * Electron's own `readText`/`writeText`.
 *
 * Reading `image/*` makes Chromium decode the picture, so callers that poll
 * should not read images on every tick.
 */

const OS_CLIPBOARD_PREFIX = 'electron application/osclipboard;format="';

/** The type `clipboard.read()` lists a raw platform format under (Windows' "CanIncludeInClipboardHistory", macOS' "org.nspasteboard.ConcealedType"). */
function osClipboardType(format: string): string {
  return `${OS_CLIPBOARD_PREFIX}${format}"`;
}

/** A flavor's own name: a raw platform format without Electron's wrapper, a MIME type as it is. */
function clipboardFormatName(type: string): string {
  return type.startsWith(OS_CLIPBOARD_PREFIX) && type.endsWith('"')
    ? type.slice(OS_CLIPBOARD_PREFIX.length, -1)
    : type;
}

/** The clipboard's single item (Electron always returns one), or null when it is empty. */
export async function readClipboardItem(): Promise<Electron.ClipboardItem | null> {
  const [item] = await clipboard.read();
  return item ?? null;
}

/** Every flavor on the clipboard: MIME types, and raw platform formats under their own names. */
export async function readClipboardFormatNames(): Promise<string[]> {
  return ((await readClipboardItem())?.types ?? []).map(clipboardFormatName);
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

/** The item's HTML, or "" when there is none. */
export async function readClipboardHtml(item: Electron.ClipboardItem | null): Promise<string> {
  return (await readClipboardTypeBytes(item, "text/html"))?.toString("utf8") ?? "";
}

/**
 * The item's picture, or an empty image when there is none (the same contract
 * as the old `clipboard.readImage()`). Chromium hands every `image/*` flavor
 * back as PNG bytes.
 */
export async function readClipboardImage(item: Electron.ClipboardItem | null): Promise<NativeImage> {
  const types = item?.types ?? [];
  const type = types.includes("image/png")
    ? "image/png"
    : types.find((candidate) => candidate.startsWith("image/") && candidate !== "image/svg+xml");
  if (!type) return nativeImage.createEmpty();
  const png = await readClipboardTypeBytes(item, type);
  return png && png.length > 0 ? nativeImage.createFromBuffer(png) : nativeImage.createEmpty();
}

/**
 * Puts text, HTML and a picture on the clipboard in one write, replacing what
 * was there, so an image and its alt text do not overwrite each other.
 */
export async function writeClipboardFlavors(flavors: { text?: string | null; html?: string | null; image?: NativeImage | null }): Promise<void> {
  const item: Record<string, string | Blob> = {};
  if (flavors.text) item["text/plain"] = flavors.text;
  if (flavors.html) item["text/html"] = flavors.html;
  if (flavors.image) item["image/png"] = new Blob([new Uint8Array(flavors.image.toPNG())], { type: "image/png" });
  await clipboard.write([new ClipboardItem(item)]);
}

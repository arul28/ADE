import { stripElectronErrorWrapper } from "../../../shared/codedError";
import type { OpenProjectBinding } from "../../../shared/types";
import { TERMINAL_BRACKETED_PASTE_END, TERMINAL_BRACKETED_PASTE_START } from "./terminalBracketedPaste";

/**
 * Clipboard-image paste for tracked agent CLI terminals.
 *
 * The image is saved as a chat temp attachment on the session's machine, and
 * a short path/type stub goes into the PTY as a bracketed paste. The terminal
 * runtime lives in `TerminalView`; this module sees only the fields it needs.
 */

/** How long a failed image paste stays visible in the pane. */
export const IMAGE_PASTE_NOTICE_MS = 8_000;

/** The runtime fields this module reads and writes. `CachedRuntime` has them. */
export type TerminalImagePasteRuntime = {
  readonly sessionId: string;
  readonly runtimePin: OpenProjectBinding | null;
  readonly disposed: boolean;
  imagePasteNotice: string | null;
  imagePasteNoticeTimer: ReturnType<typeof setTimeout> | null;
};

/** What the terminal does for this module: tell its listeners, write to the PTY. */
export type TerminalImagePasteIo = {
  notify: () => void;
  writeInput: (data: string) => void;
};

type TerminalClipboardImage = { data: string; filename: string; mimeType: string };

function bracketedPaste(text: string): string {
  return `${TERMINAL_BRACKETED_PASTE_START}${text.trimEnd()}\n${TERMINAL_BRACKETED_PASTE_END}`;
}

function formatClipboardImageForPty(path: string, mimeType: string): string {
  return [
    "ADE clipboard image attached.",
    `Path: ${path}`,
    `Type: ${mimeType || "image/png"}`,
    "",
  ].join("\n");
}

// Both attachment sinks decode `data` as bare base64: the desktop IPC handler
// (Buffer.from(data, "base64")) and the sync host (which rejects anything
// outside the base64 alphabet). The web adapter's readClipboardImage answers
// with a full data URL, so strip the prefix rather than shipping bytes that
// decode to garbage on one side and throw on the other.
function base64FromImageData(value: string): string {
  if (!value.startsWith("data:")) return value;
  const comma = value.indexOf(",");
  return comma >= 0 ? value.slice(comma + 1) : "";
}

/**
 * Say why an image paste did nothing, in the console and in the pane.
 *
 * A failed save used to return `false`, and every caller dropped that, so the
 * user saw a paste that did nothing. The console line reaches the main log as
 * `window.console`, so a report from a user carries the reason. It also runs
 * for a failed clipboard read, so the fallback reason names no stage.
 */
function reportImagePasteFailure(
  runtime: TerminalImagePasteRuntime,
  io: TerminalImagePasteIo,
  error: unknown,
): void {
  const reason = stripElectronErrorWrapper(error instanceof Error ? error.message : String(error ?? ""))
    || "no reason was given.";
  console.warn(
    `[ade-term] image paste failed session=${runtime.sessionId} machine=${runtime.runtimePin?.kind ?? "bound"} reason=${reason}`,
  );
  if (runtime.disposed) return;
  runtime.imagePasteNotice = `Couldn't attach the image: ${reason}`;
  if (runtime.imagePasteNoticeTimer) clearTimeout(runtime.imagePasteNoticeTimer);
  runtime.imagePasteNoticeTimer = setTimeout(() => clearImagePasteNotice(runtime, io), IMAGE_PASTE_NOTICE_MS);
  io.notify();
}

export function clearImagePasteNotice(runtime: TerminalImagePasteRuntime, io: TerminalImagePasteIo): void {
  if (runtime.imagePasteNoticeTimer) clearTimeout(runtime.imagePasteNoticeTimer);
  runtime.imagePasteNoticeTimer = null;
  if (runtime.imagePasteNotice == null) return;
  runtime.imagePasteNotice = null;
  io.notify();
}

/**
 * Save the image on the session's machine and paste its path.
 *
 * Returns false only when there was nothing to attach. A failed save is
 * reported and counts as handled, so the paste is not tried a second time.
 */
export async function attachClipboardImageToRuntime(
  runtime: TerminalImagePasteRuntime,
  io: TerminalImagePasteIo,
  image: TerminalClipboardImage,
): Promise<boolean> {
  if (runtime.disposed) return false;
  const data = base64FromImageData(image.data);
  if (!data) return false;
  let saved: { path: string };
  try {
    saved = await window.ade.agentChat.saveTempAttachment(
      { data, filename: image.filename || "clipboard.png" },
      runtime.runtimePin ?? undefined,
    );
  } catch (error) {
    reportImagePasteFailure(runtime, io, error);
    return true;
  }
  if (runtime.disposed) return false;
  clearImagePasteNotice(runtime, io);
  io.writeInput(bracketedPaste(formatClipboardImageForPty(saved.path, image.mimeType)));
  return true;
}

/** Read the image from the clipboard, then attach it. */
export async function pasteRuntimeClipboardImageAttachment(
  runtime: TerminalImagePasteRuntime,
  io: TerminalImagePasteIo,
): Promise<boolean> {
  if (runtime.disposed) return false;
  let image: TerminalClipboardImage | null = null;
  try {
    image = await window.ade.app.readClipboardImage();
  } catch (error) {
    // The read refuses an image over the size cap; that reason is worth showing.
    reportImagePasteFailure(runtime, io, error);
    return true;
  }
  if (!image || runtime.disposed) return false;
  return await attachClipboardImageToRuntime(runtime, io, image);
}

// A paste event carries the image bytes of the device the user is actually
// typing on, synchronously and without a permission prompt. On web,
// navigator.clipboard.read() (the readClipboardImage path) is permission-gated
// and, when the browser is remote, reads the wrong machine's clipboard — so
// prefer the event's own items whenever the paste arrives as a real event.
export function clipboardImageBlobFromEvent(data: DataTransfer | null | undefined): Blob | null {
  if (!data) return null;
  const files = data.files as ArrayLike<File> | undefined;
  for (let index = 0; index < (files?.length ?? 0); index += 1) {
    const file = files?.[index];
    if (file && typeof file.type === "string" && file.type.startsWith("image/")) return file;
  }
  const items = data.items as ArrayLike<DataTransferItem> | undefined;
  for (let index = 0; index < (items?.length ?? 0); index += 1) {
    const item = items?.[index];
    if (!item || item.kind !== "file" || !item.type?.startsWith("image/")) continue;
    // getAsFile must run inside the event handler; DataTransferItems are
    // neutered once it returns.
    const file = item.getAsFile();
    if (file) return file;
  }
  return null;
}

// The attachment sink infers the stored file's type from the filename
// extension (it renames the file to a uuid anyway), so name the paste after its
// own mime instead of trusting a pasted File's name — a .png name carrying webp
// bytes is rejected as a mime mismatch.
const CLIPBOARD_IMAGE_EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/x-icon": ".ico",
  "image/svg+xml": ".svg",
};

/** Attach an image blob from a paste event. False means the caller should try the clipboard. */
export async function pasteClipboardImageBlob(
  runtime: TerminalImagePasteRuntime,
  io: TerminalImagePasteIo,
  blob: Blob,
): Promise<boolean> {
  if (runtime.disposed) return false;
  const mimeType = blob.type?.toLowerCase() || "image/png";
  const extension = CLIPBOARD_IMAGE_EXTENSION_BY_MIME[mimeType];
  if (!extension) return false;
  let dataUrl: string;
  try {
    dataUrl = await blobToDataUrl(blob);
  } catch {
    return false;
  }
  if (!dataUrl || runtime.disposed) return false;
  return await attachClipboardImageToRuntime(runtime, io, {
    data: dataUrl,
    filename: `clipboard-image${extension}`,
    mimeType,
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read the pasted image."));
    reader.readAsDataURL(blob);
  });
}

import type { AgentChatEventEnvelope, AgentChatFileRef } from "../../../shared/types";

/**
 * Files attached to a chat while its ADE Cloud computer rests, kept on this
 * device until the send that carries them.
 *
 * Copying a file to the chat's computer is a write, and a write wakes a
 * resting computer (`callAction`), while a computer should wake only when its
 * agent works. So a paste, drop or pick into such a chat keeps the bytes here
 * and the composer holds a stand-in path, `ade-held:<id>/<name>`. Previews read
 * the bytes here (`readAttachmentImageDataUrl`). The send that carries the
 * files copies each one to the chat's computer right before the message (the
 * send wakes the computer anyway) and sends the real paths
 * (`stageHeldAttachments`). The desktop and ADE Web share this: the bytes are
 * the ones the composer read, the same it would have copied at once.
 *
 * Only in this window's memory, and only while something needs the bytes: a
 * file taken out of the box gives them up at once, and so does a sent one
 * once its bubble stops showing it (the message and its put-back name the
 * copy). After a reload a send names the file to attach again. Bounded: when
 * the files held fill `MAX_HELD_CHARS`, the next one is copied to the
 * computer at once, as before.
 */

const HELD_PATH_PREFIX = "ade-held:";
/** Base64 characters kept for all held files: the same budget the draft sources keep. */
const MAX_HELD_CHARS = 64 * 1024 * 1024;

type HeldAttachment = {
  /** Base64, already converted (a HEIC is JPEG by now). */
  data: string;
  filename: string;
  mimeType: string | null;
  /**
   * The copy made on each machine, by the chat pin's key, while the send
   * that carries it runs or after it. A send that fails after some files went
   * reuses those copies when it goes again, so no file is copied twice.
   */
  staged: Map<string, Promise<string>>;
};

const held = new Map<string, HeldAttachment>();
let heldChars = 0;

function newId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** True for the stand-in path of a file kept on this device. */
export function isHeldAttachmentPath(path: string): boolean {
  return path.startsWith(HELD_PATH_PREFIX);
}

/** Whether any of these attachments is kept on this device. Cheap: every send asks. */
export function hasHeldAttachments(attachments: readonly AgentChatFileRef[]): boolean {
  return attachments.some((attachment) => attachment.type !== "image-url" && isHeldAttachmentPath(attachment.path));
}

/**
 * Keeps a file's bytes on this device and returns its stand-in path, or null
 * when the files held leave no room (the caller copies it to the computer,
 * as before). The stand-in ends in the file's name, so its type and chip
 * read as the file's.
 */
export function holdAttachmentBytes(args: { data: string; filename: string; mimeType: string | null }): string | null {
  if (heldChars + args.data.length > MAX_HELD_CHARS) return null;
  const name = args.filename.split(/[\\/]/).pop()?.trim() || "attachment";
  const path = `${HELD_PATH_PREFIX}${newId()}/${name}`;
  held.set(path, { data: args.data, filename: name, mimeType: args.mimeType, staged: new Map() });
  heldChars += args.data.length;
  return path;
}

/** A held image as a data URL for its preview; rejects once its bytes are gone. */
export function heldAttachmentImageDataUrl(path: string): Promise<{ dataUrl: string }> {
  const entry = held.get(path);
  if (!entry) return Promise.reject(new Error(heldAttachmentGoneMessage(path)));
  return Promise.resolve({ dataUrl: `data:${entry.mimeType || "image/png"};base64,${entry.data}` });
}

function heldAttachmentGoneMessage(path: string): string {
  const name = path.split("/").pop() || "a file";
  return `"${name}" was kept on this device until you sent and isn't here anymore (the window reloaded). Remove it and attach it again.`;
}

/**
 * Nothing needs these files' bytes anymore: each left the box (removed, or
 * not attached after all), or a send copied it to the chat's machine and its
 * bubble no longer shows it. They go now; a path not held here is skipped.
 */
export function releaseHeldAttachments(paths: readonly string[]): void {
  for (const path of paths) {
    const entry = held.get(path);
    if (!entry) continue;
    held.delete(path);
    heldChars -= entry.data.length;
  }
}

/**
 * Frees the bytes of files kept on this device that a send copied to the
 * chat's machine (`stagedHeldPaths` of `prepareDeviceHeldForSend`, collected
 * in `sent`), once neither the sent bubble nor the box shows them: the
 * message and its put-back name the copies.
 */
export function releaseSentHeldAttachments(
  sent: Set<string>,
  bubble: { envelope: AgentChatEventEnvelope } | null,
  box: readonly AgentChatFileRef[],
): void {
  if (!sent.size) return;
  const event = bubble?.envelope.event;
  const shown = new Set([...(event?.type === "user_message" ? event.attachments ?? [] : []), ...box].map((attachment) => attachment.path));
  const done = [...sent].filter((path) => !shown.has(path));
  for (const path of done) sent.delete(path);
  releaseHeldAttachments(done);
}

/**
 * The attachments as the send carries them: each file kept on this device is
 * copied to the chat's machine first, in order, and named by its path there;
 * `stagedHeldPaths` are the stand-in paths copied. `machineKey` is the chat
 * pin's key; a file already copied there for an earlier try of this send is
 * not copied again. `save` is the pane's copy (its chat API, reaching a
 * resting computer the way a send does). Throws when one can't be copied: the
 * send must not go without it, and every file stays held for the next try.
 */
export async function stageHeldAttachments(
  attachments: readonly AgentChatFileRef[],
  args: {
    machineKey: string;
    save: (file: { data: string; filename: string }) => Promise<{ path: string }>;
  },
): Promise<{ attachments: AgentChatFileRef[]; stagedHeldPaths: string[] }> {
  const staged: AgentChatFileRef[] = [];
  const stagedHeldPaths: string[] = [];
  for (const attachment of attachments) {
    if (attachment.type === "image-url" || !isHeldAttachmentPath(attachment.path)) {
      staged.push(attachment);
      continue;
    }
    const entry = held.get(attachment.path);
    if (!entry) throw new Error(heldAttachmentGoneMessage(attachment.path));
    let copy = entry.staged.get(args.machineKey);
    if (!copy) {
      copy = args.save({ data: entry.data, filename: entry.filename }).then(({ path }) => {
        if (typeof path !== "string" || !path.trim()) throw new Error("The chat's machine did not return a path for the file.");
        return path;
      });
      entry.staged.set(args.machineKey, copy);
      // A failed copy is not a copy: the next try makes one.
      copy.catch(() => {
        if (entry.staged.get(args.machineKey) === copy) entry.staged.delete(args.machineKey);
      });
    }
    staged.push({ ...attachment, path: await copy });
    stagedHeldPaths.push(attachment.path);
  }
  return { attachments: staged, stagedHeldPaths };
}

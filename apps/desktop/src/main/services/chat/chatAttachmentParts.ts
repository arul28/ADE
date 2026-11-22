/**
 * A pasted picture sent to this machine in parts, for a desktop on a slow or
 * unsteady link. One `saveTempAttachment` call carries the whole picture as
 * one request: at 0.5 Mbit/s a 2.2 MB paste is about a minute, every key and
 * echo on the link waits behind it, and a drop at any point loses all of it.
 *
 * Each part says where it starts, so every part is safe to send again and may
 * arrive in any order:
 * - A part is kept by its offset; a part this machine has already is answered
 *   and not added again.
 * - The answer says how many bytes this machine holds from the start.
 * - When it holds every byte, it stages the file once; a later part of the
 *   same upload gets the same path.
 */

/** Uploads kept open at once; the oldest goes when a new one starts. */
const OPEN_UPLOADS_MAX = 8;
/** An upload with no part for this long is dropped. */
const UPLOAD_IDLE_MS = 10 * 60_000;
/** A finished upload's path is kept this long, for a repeat of its last part. */
const FINISHED_KEEP_MS = 10 * 60_000;

export type AttachmentPartArgs = {
  uploadId?: unknown;
  offset?: unknown;
  totalBytes?: unknown;
  data?: unknown;
  filename?: unknown;
};

export type AttachmentPartResult = {
  /** Bytes this machine holds for the upload, from the start. */
  received: number;
  /** The staged file, once every byte arrived. */
  path?: string;
};

type OpenUpload = {
  totalBytes: number;
  filename: string | null;
  /** Bytes from the start, in order. */
  head: Buffer[];
  received: number;
  /** Parts past `received`, by offset, until the gap before them fills. */
  ahead: Map<number, Buffer>;
  aheadBytes: number;
  touchedAt: number;
  /** Set while the file stages, so a repeat of a part waits for it. */
  staging?: Promise<{ path: string }>;
  path?: string;
};

/** Moves every part that now joins the bytes from the start onto them. */
function joinAhead(upload: OpenUpload): void {
  for (;;) {
    let joined = false;
    for (const [offset, bytes] of upload.ahead) {
      const end = offset + bytes.length;
      if (end <= upload.received) {
        upload.ahead.delete(offset);
        upload.aheadBytes -= bytes.length;
        continue;
      }
      if (offset > upload.received) continue;
      upload.ahead.delete(offset);
      upload.aheadBytes -= bytes.length;
      const fresh = bytes.subarray(upload.received - offset);
      upload.head.push(fresh);
      upload.received += fresh.length;
      joined = true;
    }
    if (!joined) return;
  }
}

export type AttachmentPartStore = {
  savePart: (args: AttachmentPartArgs) => Promise<AttachmentPartResult>;
};

export function createAttachmentPartStore(deps: {
  maxBytes: number;
  stage: (content: Buffer, filename: string | null) => Promise<{ path: string }>;
  now?: () => number;
}): AttachmentPartStore {
  const now = deps.now ?? Date.now;
  const uploads = new Map<string, OpenUpload>();

  const sweep = () => {
    const at = now();
    for (const [id, upload] of uploads) {
      const keepMs = upload.path ? FINISHED_KEEP_MS : UPLOAD_IDLE_MS;
      if (!upload.staging && at - upload.touchedAt > keepMs) uploads.delete(id);
    }
    while (uploads.size > OPEN_UPLOADS_MAX) {
      // The upload quiet longest goes first. Ties keep the older one.
      let oldestId: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [id, upload] of uploads) {
        if (upload.staging || upload.touchedAt >= oldestAt) continue;
        oldestId = id;
        oldestAt = upload.touchedAt;
      }
      if (oldestId === null) break;
      uploads.delete(oldestId);
    }
  };

  return {
    async savePart(args) {
      const uploadId = typeof args.uploadId === "string" ? args.uploadId.trim() : "";
      if (!uploadId || uploadId.length > 128) throw new Error("An upload id is required.");
      const offset = Number(args.offset);
      const totalBytes = Number(args.totalBytes);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("The part offset is not valid.");
      if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) throw new Error("The upload size is not valid.");
      if (totalBytes > deps.maxBytes) throw new Error("This attachment is larger than the machine accepts.");
      if (typeof args.data !== "string") throw new Error("Part data is required.");

      let upload = uploads.get(uploadId);
      if (upload && upload.totalBytes !== totalBytes) throw new Error("The upload size changed between parts.");
      if (!upload) {
        sweep();
        upload = {
          totalBytes,
          filename: typeof args.filename === "string" ? args.filename : null,
          head: [],
          received: 0,
          ahead: new Map(),
          aheadBytes: 0,
          touchedAt: now(),
        };
        uploads.set(uploadId, upload);
      }
      upload.touchedAt = now();
      if (upload.path) return { received: upload.received, path: upload.path };
      if (upload.staging) {
        const staged = await upload.staging;
        return { received: upload.received, path: staged.path };
      }

      const bytes = Buffer.from(args.data, "base64");
      if (bytes.length === 0) throw new Error("The part is empty.");
      if (offset + bytes.length > totalBytes) throw new Error("The part goes past the end of the upload.");
      const end = offset + bytes.length;
      if (offset <= upload.received && end > upload.received) {
        // It joins the bytes from the start now, and may close a gap.
        const fresh = bytes.subarray(upload.received - offset);
        upload.head.push(fresh);
        upload.received += fresh.length;
        joinAhead(upload);
      } else if (offset > upload.received && !upload.ahead.has(offset)) {
        // Parts ahead of a gap never hold more than the upload's own size.
        if (upload.aheadBytes + bytes.length > totalBytes) return { received: upload.received };
        upload.ahead.set(offset, bytes);
        upload.aheadBytes += bytes.length;
      }
      if (upload.received < totalBytes) return { received: upload.received };

      const content = Buffer.concat(upload.head, totalBytes);
      upload.head = [];
      upload.ahead.clear();
      upload.aheadBytes = 0;
      const done = upload;
      done.staging = deps.stage(content, done.filename);
      try {
        const staged = await done.staging;
        done.path = staged.path;
        return { received: done.received, path: staged.path };
      } catch (error) {
        // A failed stage starts the upload over: the sender's next part finds
        // a new upload, and the sender sends again from what it holds.
        uploads.delete(uploadId);
        throw error;
      } finally {
        done.staging = undefined;
      }
    },
  };
}

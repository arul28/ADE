/**
 * The one disk-side rule for staging a chat attachment, shared by every process
 * that writes into a project's `.ade/attachments` directory: the desktop main
 * process (`registerIpc`), the ADE action registry the local brain serves, and
 * the CLI sync host's streamed HTTP upload route.
 *
 * There used to be three copies of this rule and only two of them validated the
 * extension, so the same drag-and-drop produced a differently-named file
 * depending on which process happened to answer. The invariants below are the
 * ones every caller now gets:
 *
 * - The destination basename is always a fresh UUID. Nothing about the source
 *   path or the caller-supplied display name reaches it except a
 *   regex-validated extension, so a traversal-shaped filename cannot smuggle a
 *   path fragment through to the write.
 * - The resolved destination is re-checked for containment inside the
 *   attachments directory. That cannot fail while the basename is a UUID — it
 *   fails loudly if either invariant is ever loosened.
 * - Size is checked by `stat` before a byte is copied, against the product
 *   ceiling for file-shaped attachments.
 *
 * Node-only: this module touches `node:fs`, so the renderer imports
 * `chatAttachmentLimits` instead.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { MAX_CHAT_ATTACHMENT_BYTES, attachmentTooLargeMessage } from "./chatAttachmentLimits";

/** Extensions are the only client-controlled part of a staged attachment name. */
const SAFE_ATTACHMENT_EXTENSION_PATTERN = /^\.[A-Za-z0-9]{1,16}$/;

/**
 * Where a project's staged attachments live.
 *
 * Inside `.ade` so CLI subprocesses and the Files viewer can reach them. Six
 * call sites across three processes used to spell this out by hand, which is
 * one rename away from a host and its own upload route disagreeing about where
 * a file just landed.
 */
export function projectAttachmentsDir(projectRoot: string): string {
  return path.join(projectRoot, ".ade", "attachments");
}

/** `.PNG` → `.png`; anything with a separator, a dot, or excess length → "". */
export function safeAttachmentExtension(candidate: string | null | undefined): string {
  const raw = path.extname((candidate ?? "").trim()).toLowerCase();
  return SAFE_ATTACHMENT_EXTENSION_PATTERN.test(raw) ? raw : "";
}

/**
 * The extension a staged copy carries: the caller's display name when it has a
 * usable one, else the source path's. `path.extname` is separator-agnostic on
 * both, so a Windows source path is handled the same as a POSIX one.
 */
export function resolveStagedAttachmentExtension(
  filename: string | null | undefined,
  sourcePath: string | null | undefined,
): string {
  return safeAttachmentExtension(filename) || safeAttachmentExtension(sourcePath);
}

/**
 * `<attachmentsDir>/<uuid><ext>`, resolved and re-checked for containment.
 *
 * `extension` must already be a validated safe extension (see
 * {@link safeAttachmentExtension}); anything else is dropped rather than
 * trusted.
 */
export function stagedAttachmentDestPath(attachmentsDir: string, extension: string): string {
  const baseDir = path.resolve(attachmentsDir);
  const ext = SAFE_ATTACHMENT_EXTENSION_PATTERN.test(extension) ? extension : "";
  const destPath = path.resolve(path.join(baseDir, `${randomUUID()}${ext}`));
  // `path.relative` rather than `startsWith(baseDir + path.sep)`. The prefix
  // form false-rejects whenever the resolved base already ends in a separator
  // — a filesystem root or a Windows drive root, where it looks for `//` or
  // `C:\\` — and it is raw string comparison where path containment is not a
  // string property. `relative` also gives the cross-drive case a name: with
  // no relative route from one Windows drive to another it returns an absolute
  // path, which the `isAbsolute` arm rejects.
  const relative = path.relative(baseDir, destPath);
  if (
    !relative
    || path.isAbsolute(relative)
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error("Invalid attachment destination.");
  }
  return destPath;
}

type StageAttachmentCopyArgs = {
  /** Absolute path to a file that already exists on THIS machine's disk. */
  sourcePath: string;
  /** The caller's display name for the file; only its extension is used. */
  filename?: string | null;
  /** Usually `<projectRoot>/.ade/attachments`. */
  attachmentsDir: string;
};

/**
 * Stage a file that already exists on this machine's disk by copying it, never
 * by round-tripping its bytes through base64 and IPC.
 *
 * Deliberately NOT constrained to the project root: a user drags a file in from
 * Downloads or Desktop, and refusing those would make the feature useless. The
 * source path is only ever READ, and nothing about it reaches the destination.
 * Because the source is unconstrained, this must only ever be reachable from
 * the machine that owns the file — never from a remote peer.
 */
export async function stageAttachmentCopy(
  args: StageAttachmentCopyArgs,
): Promise<{ path: string }> {
  const raw = typeof args.sourcePath === "string" ? args.sourcePath.trim() : "";
  if (!raw || raw.includes("\0")) throw new Error("Missing attachment source path.");
  const absolute = path.resolve(raw);
  const stat = await fs.promises.stat(absolute);
  if (!stat.isFile()) throw new Error("Attachment source is not a file.");
  if (stat.size > MAX_CHAT_ATTACHMENT_BYTES) {
    throw new Error(
      attachmentTooLargeMessage(path.basename(absolute), stat.size, MAX_CHAT_ATTACHMENT_BYTES),
    );
  }
  const baseDir = path.resolve(args.attachmentsDir);
  await fs.promises.mkdir(baseDir, { recursive: true });
  const destPath = stagedAttachmentDestPath(
    baseDir,
    resolveStagedAttachmentExtension(args.filename, absolute),
  );
  await fs.promises.copyFile(absolute, destPath);
  return { path: destPath };
}

/**
 * Stage bytes the caller already holds (a base64 IPC payload, a clipboard
 * grab) under the same UUID-basename rule as {@link stageAttachmentCopy}.
 *
 * Callers keep their own size ceilings and their own wording for exceeding
 * them: the base64 paths carry a smaller, image-shaped cap than the copy path,
 * and the message a user sees names which one they hit.
 *
 * The extension falls back to `.png` because every writer of this path is an
 * image producer, and a viewer that gets no extension at all shows nothing. An
 * extension the regex rejects now takes that fallback instead of reaching the
 * destination raw — the callers this replaced used `path.extname(filename)`
 * unvalidated, so a display name could name its own on-disk extension.
 */
export async function stageAttachmentBytes(args: {
  content: Buffer;
  filename?: string | null;
  attachmentsDir: string;
}): Promise<{ path: string }> {
  const baseDir = path.resolve(args.attachmentsDir);
  const destPath = stagedAttachmentDestPath(
    baseDir,
    resolveStagedAttachmentExtension(args.filename, null) || ".png",
  );
  await fs.promises.mkdir(baseDir, { recursive: true });
  await fs.promises.writeFile(destPath, args.content);
  return { path: destPath };
}

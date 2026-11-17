import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { AdeExpectedError } from "../../../shared/expectedError";
import type { AgentChatFileRef } from "../../../shared/types";

/**
 * An ADE Cloud launch runs in this app's main process, but the composer saves
 * a draft's files on the machine the project is open on. When that is another
 * machine, a launch file's path names a file there, not here, and the upload
 * failed with ENOENT. This copies each such file to this computer before the
 * launch reads it: the result maps the path there to the copy here.
 *
 * Only images come back: the other machine's brain reads an image for any
 * caller (`chat.getImageDataUrl`), and no action reads another kind of file.
 * A file of another kind that is not here stops the launch with a sentence
 * that says what to do.
 */
export async function copyLaunchFilesFromSource(input: {
  attachments: readonly AgentChatFileRef[] | undefined;
  /** Where the copies go: one folder per launch. */
  dir: string;
  /** The image's data URL, read on the machine that holds it. Null: no other machine to ask. */
  readSourceImage: ((filePath: string) => Promise<string>) | null;
}): Promise<Record<string, string>> {
  const copies: Record<string, string> = {};
  if (!input.readSourceImage) return copies;
  for (const file of input.attachments ?? []) {
    if (file.type === "image-url" || copies[file.path]) continue;
    const name = fileNameOf(file.path);
    if (file.type !== "image") {
      if (await isFileHere(file.path)) continue;
      throw new AdeExpectedError(
        `${name} is on the machine this project is open on, and ADE Cloud starts from this computer. Remove it, or attach it again from this computer.`,
        "user",
      );
    }
    // The source machine first: a file at the same path here can be a different one.
    let image: { bytes: Buffer; ext: string | null };
    try {
      image = decodeDataUrl(await input.readSourceImage(file.path));
    } catch (error) {
      // An image attached from this computer: the source machine doesn't have it.
      if (await isFileHere(file.path)) continue;
      const why = error instanceof Error ? error.message : String(error);
      throw new AdeExpectedError(`ADE couldn't get ${name} from the machine it was attached on: ${why.replace(/\.$/, "")}. Send again.`, "user");
    }
    await fs.mkdir(input.dir, { recursive: true });
    // A unique prefix: two files, or two messages of one launch, can share a name.
    const copy = path.join(input.dir, `${randomUUID().slice(0, 8)}-${withExt(safeFileName(name), image.ext)}`);
    await fs.writeFile(copy, image.bytes);
    copies[file.path] = copy;
  }
  return copies;
}

/**
 * The name a launch file goes up under. The source machine sends HEIC and
 * TIFF as JPEG, so the name takes the copy's extension when it has one.
 */
export function launchFileName(filePath: string, readPath: string): string {
  const name = fileNameOf(filePath);
  return readPath === filePath ? name : withExt(name, path.extname(readPath) || null);
}

/** Split on both separators: the path can come from a machine with the other OS. */
function fileNameOf(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || "attachment";
}

/** Characters Windows doesn't allow in a name (`:` would write an NTFS stream). */
function safeFileName(name: string): string {
  return name.replace(/[<>:"|?*\u0000-\u001f]/g, "_");
}

function withExt(name: string, ext: string | null): string {
  if (!ext) return name;
  const own = path.extname(name);
  return own.toLowerCase() === ext.toLowerCase() ? name : `${name.slice(0, name.length - own.length)}${ext}`;
}

async function isFileHere(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

const IMAGE_EXTS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/heic": ".heic",
};

function decodeDataUrl(dataUrl: string): { bytes: Buffer; ext: string | null } {
  const comma = dataUrl.indexOf(",");
  const head = comma < 0 ? "" : dataUrl.slice(0, comma);
  if (!head.startsWith("data:") || !head.endsWith(";base64")) {
    throw new Error("the image came back in a form ADE can't read");
  }
  const mime = head.slice("data:".length, -";base64".length).toLowerCase();
  return { bytes: Buffer.from(dataUrl.slice(comma + 1), "base64"), ext: IMAGE_EXTS[mime] ?? null };
}

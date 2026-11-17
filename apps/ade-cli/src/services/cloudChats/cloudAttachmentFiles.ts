/**
 * The files a person attached to a launch or a queued chat message, saved on
 * the ADE Cloud computer so the chat or CLI can read them by path. A launch
 * (`cloudBootLaunch.ts`) and the message queue (`cloudChatMessageQueue.ts`)
 * both save them here.
 */

import fs from "node:fs";
import path from "node:path";

/** The file ids the server accepts (`launches.ts`): a file's name on disk starts with it. */
const FILE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type SavedCloudFile = { path: string; type: "image" | "file" };

const safeFileName = (name: string): string => name.replace(/[/\\\u0000-\u001f]/g, "_").replace(/^\.+/, "_").slice(0, 120) || "file";

/**
 * Saves each file in `folder` as `<fileId>-<name>`. A file already there is
 * kept (a retry reads nothing again). `owner` names what carried the files
 * in the refusal ("launch", "message").
 */
export async function saveCloudFiles<F extends { fileId: string; name: string; contentType: string }>(
  folder: string,
  files: readonly F[],
  read: (file: F) => Promise<ArrayBuffer>,
  owner: string,
): Promise<SavedCloudFile[]> {
  const out: SavedCloudFile[] = [];
  for (const file of files) {
    if (!FILE_ID.test(file.fileId)) throw new Error(`The ${owner} names a file this computer can't keep ("${safeFileName(file.name)}").`);
    fs.mkdirSync(folder, { recursive: true });
    const target = path.join(folder, `${file.fileId}-${safeFileName(file.name)}`);
    if (!fs.existsSync(target)) {
      // Written beside it, then renamed: a file that is there is always whole, so a retry never keeps half of one.
      const partial = `${target}.part`;
      fs.writeFileSync(partial, Buffer.from(await read(file)));
      fs.renameSync(partial, target);
    }
    out.push({ path: target, type: file.contentType.startsWith("image/") ? "image" : "file" });
  }
  return out;
}

/** A CLI reads files by path: the message names its saved files after its text. */
export function withAttachmentPaths(text: string, attachments: ReadonlyArray<{ path: string }>): string {
  if (!attachments.length) return text;
  return [text, "", "Attached files:", ...attachments.map((file) => `- ${file.path}`)].join("\n");
}

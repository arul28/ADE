import fs from "node:fs";
import path from "node:path";
import { FileStampedMemo, readTextIfExists } from "../../lib/fileStampedMemo";

/**
 * One-line machine id files under `~/.ade/secrets` (`sync-device-id`,
 * `sync-site-id`), read through one process-wide memo.
 *
 * The brain reads the device id for every Attention build and account-directory
 * publish. Read synchronously each time, one read on Windows held the brain's
 * event loop 15 s while antivirus scanned the file. See {@link FileStampedMemo}.
 */
const idMemo = new FileStampedMemo<{ id: string | null }>();

function parseId(text: string): string | null {
  return text.trim() || null;
}

/** The id in the file, or null while it is missing or empty. Never writes. */
export function readMachineIdFile(filePath: string): string | null {
  const key = path.resolve(filePath);
  const remembered = idMemo.read(key, {
    filePath,
    reload: async () => ({ id: parseId((await readTextIfExists(filePath)) ?? "") }),
  });
  if (remembered) return remembered.id;
  let id: string | null = null;
  try {
    id = parseId(fs.readFileSync(filePath, "utf8"));
  } catch {
    id = null;
  }
  idMemo.remember(key, { id });
  return id;
}

/** Call after this process writes the file, so its next read sees the id at once. */
export function rememberMachineIdFile(filePath: string, id: string): void {
  idMemo.remember(path.resolve(filePath), { id: parseId(id) });
}

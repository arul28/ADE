import fs from "node:fs";
import path from "node:path";
import {
  resolveProjectIcon,
  resolveProjectIconPath,
} from "../../../../desktop/src/main/services/projects/projectIconResolver";

/**
 * Resolves a project's icon on the machine that hosts the project files, so a
 * desktop connected to this brain over the remote runtime can show the real
 * project logo in its project tab instead of a blank folder.
 *
 * This reuses the desktop's `resolveProjectIcon` (already in the brain bundle —
 * `cli.ts` imports the same module chain for the mobile sync icon path), so the
 * icon a remote desktop sees is exactly the one the host machine would show,
 * and we inherit its mtime-keyed result cache. Two things are layered on top:
 *   1. A wire-size cap — these icons travel inline in the `projects.list`
 *      payload, so anything too large is dropped.
 *   2. A size preflight via `resolveProjectIconPath` BEFORE `resolveProjectIcon`
 *      reads/encodes/caches the data URL, so an oversized icon is never inlined
 *      or retained in the resolver's cache just to be discarded.
 */
export type RemoteProjectIcon = {
  dataUrl: string | null;
  sourcePath: string | null;
  mimeType: string | null;
};

// Cap on the raw icon file. base64 inflates ~33%, so a 2 MB file yields a
// ~2.7 MB data URL — an acceptable ceiling for inline transport, and well below
// the desktop resolver's 10 MB on-disk limit.
const REMOTE_ICON_MAX_FILE_BYTES = 2 * 1024 * 1024;

// Frozen so the shared singleton can't be mutated by a caller and silently
// corrupt every subsequent resolve.
const EMPTY_ICON: RemoteProjectIcon = Object.freeze({
  dataUrl: null,
  sourcePath: null,
  mimeType: null,
});

function mimeTypeForIconPath(filePath: string): string | null {
  switch (path.extname(filePath).toLowerCase()) {
    case ".svg":
      return "image/svg+xml";
    case ".ico":
      return "image/x-icon";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return null;
  }
}

export function resolveRemoteProjectIcon(projectRoot: string): RemoteProjectIcon {
  if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
    return EMPTY_ICON;
  }
  const root = projectRoot.trim();

  let iconPath: string | null;
  try {
    iconPath = resolveProjectIconPath(root);
  } catch {
    return EMPTY_ICON;
  }
  if (!iconPath) return EMPTY_ICON;

  // Preflight the file size BEFORE resolveProjectIcon reads, base64-encodes, and
  // caches the full data URL. Without this, an oversized icon (under the
  // desktop resolver's 10 MB cap) would be inlined and retained in the shared
  // result cache even though we drop it from the wire.
  let size: number;
  try {
    size = fs.statSync(iconPath).size;
  } catch {
    return EMPTY_ICON;
  }
  if (size > REMOTE_ICON_MAX_FILE_BYTES) {
    return {
      dataUrl: null,
      sourcePath: iconPath,
      mimeType: mimeTypeForIconPath(iconPath),
    };
  }

  try {
    return resolveProjectIcon(root);
  } catch {
    return EMPTY_ICON;
  }
}

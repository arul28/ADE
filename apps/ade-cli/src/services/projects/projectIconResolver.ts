import { resolveProjectIcon } from "../../../../desktop/src/main/services/projects/projectIconResolver";

/**
 * Resolves a project's icon on the machine that hosts the project files, so a
 * desktop connected to this brain over the remote runtime can show the real
 * project logo in its project tab instead of a blank folder.
 *
 * This reuses the desktop's `resolveProjectIcon` (already in the brain bundle —
 * `cli.ts` imports the same module chain for the mobile sync icon path), so the
 * icon a remote desktop sees is exactly the one the host machine would show,
 * and we inherit its mtime-keyed result cache. The only thing layered on top is
 * a wire-size cap: the desktop resolver inlines the icon at full resolution
 * (capped at 10 MB on disk), but these icons travel inline in the `projects.list`
 * payload, so we drop any data URL above 2 MB while keeping the metadata.
 */
export type RemoteProjectIcon = {
  dataUrl: string | null;
  sourcePath: string | null;
  mimeType: string | null;
};

const REMOTE_ICON_MAX_DATAURL_BYTES = 2 * 1024 * 1024;

// Frozen so the shared singleton can't be mutated by a caller and silently
// corrupt every subsequent resolve.
const EMPTY_ICON: RemoteProjectIcon = Object.freeze({
  dataUrl: null,
  sourcePath: null,
  mimeType: null,
});

export function resolveRemoteProjectIcon(projectRoot: string): RemoteProjectIcon {
  if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
    return EMPTY_ICON;
  }
  let icon: RemoteProjectIcon;
  try {
    icon = resolveProjectIcon(projectRoot.trim());
  } catch {
    return EMPTY_ICON;
  }
  // Drop an oversized inline icon but keep its metadata so the desktop still
  // knows an icon exists (it falls back to the folder glyph).
  if (
    icon.dataUrl &&
    Buffer.byteLength(icon.dataUrl, "utf8") > REMOTE_ICON_MAX_DATAURL_BYTES
  ) {
    return { dataUrl: null, sourcePath: icon.sourcePath, mimeType: icon.mimeType };
  }
  return icon;
}

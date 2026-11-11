import fs from "node:fs";
import path from "node:path";
import {
  clearProjectIconOverride,
  resolveProjectIcon,
  resolveProjectIconOverridePath,
  resolveProjectIconPath,
} from "../../../../desktop/src/main/services/projects/projectIconResolver";
import { encodeProjectRecordIcon } from "../../../../desktop/src/main/services/projects/projectRecordHost";
import type { ProjectRecordIconValue } from "../../../../desktop/src/shared/projectRecord";

export {
  clearProjectIconOverride,
  decodeProjectIconUpload,
  importProjectIconBytes,
  removeProjectIconOverride,
  resolveProjectIconOverridePath,
  resolveProjectIconPath,
} from "../../../../desktop/src/main/services/projects/projectIconResolver";
import {
  PROJECT_ICON_THUMBNAIL_MAX_DATA_URL_BYTES,
  resolveMobileProjectIconDataUrl,
} from "../../../../desktop/src/main/services/projects/projectIconThumbnail";

/**
 * Resolves a project's icon on the machine that hosts the project files, so a
 * desktop connected to this brain over the remote runtime can show the real
 * project logo in its project tab instead of a blank folder.
 *
 * This reuses the same 64px thumbnail path as mobile (already in the brain
 * bundle) and applies a strict encoded-size cap. Project art is cosmetic and
 * travels inline in `projects.list`, so a full-resolution app icon must never
 * consume a relay frame or delay project bootstrap.
 */
export type RemoteProjectIcon = {
  dataUrl: string | null;
  sourcePath: string | null;
  mimeType: string | null;
};

// Keep this aligned with the persisted remote-project icon boundary. The
// thumbnail normally lands well below this; the cap also protects platforms
// where no rasterizer is available and the helper falls back to a raw PNG.
export const REMOTE_ICON_MAX_DATA_URL_BYTES = PROJECT_ICON_THUMBNAIL_MAX_DATA_URL_BYTES;

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

/**
 * How the shared project record (`shared/projectRecord.ts`) changes a resolve:
 * - `off`: as before the record.
 * - `detected`: the record says the custom icon was removed, so this
 *   machine's own override is dropped and the icon is detected.
 * - `migrate`: the record has no icon yet; the answer also carries this
 *   machine's own custom icon, shrunk for the record, for the caller to upload.
 */
export type RemoteProjectIconRecordMode = "off" | "detected" | "migrate";

export type RemoteProjectIconWithRecord = RemoteProjectIcon & {
  /** Only in `migrate` mode, and only when this machine has its own custom icon that fits. */
  recordValue?: ProjectRecordIconValue | null;
};

export function resolveRemoteProjectIconForRecord(
  projectRoot: string,
  mode: RemoteProjectIconRecordMode,
): RemoteProjectIconWithRecord {
  if (mode === "off" || typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
    return resolveRemoteProjectIcon(projectRoot);
  }
  const root = projectRoot.trim();
  if (mode === "detected") {
    try {
      clearProjectIconOverride(root);
    } catch {
      // The override is ignored below either way.
    }
    return resolveRemoteProjectIcon(root, { ignoreOverride: true });
  }
  const icon = resolveRemoteProjectIcon(root);
  let overridePath: string | null = null;
  try {
    overridePath = resolveProjectIconOverridePath(root);
  } catch {
    overridePath = null;
  }
  return overridePath ? { ...icon, recordValue: encodeProjectRecordIcon(overridePath) } : icon;
}

export function resolveRemoteProjectIcon(
  projectRoot: string,
  options: { ignoreOverride?: boolean } = {},
): RemoteProjectIcon {
  if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
    return EMPTY_ICON;
  }
  const root = projectRoot.trim();
  // `undefined` as the override skips this machine's own setting.
  const resolveOptions = options.ignoreOverride ? { iconPathOverride: undefined } : {};

  let iconPath: string | null;
  try {
    iconPath = resolveProjectIconPath(root, resolveOptions);
  } catch {
    return EMPTY_ICON;
  }
  if (!iconPath) return EMPTY_ICON;

  try {
    const thumbnailDataUrl = resolveMobileProjectIconDataUrl(root, {
      resolvedSourcePath: iconPath,
    });
    // Headless hosts may not have a rasterizer. Small originals remain safe to
    // inline (and preserve SVG/JPEG/WebP project art); larger originals are
    // never read merely to discover that base64 would exceed the wire cap.
    const dataUrl = thumbnailDataUrl ?? (
      fs.statSync(iconPath).size <= 96 * 1024
        ? resolveProjectIcon(root, resolveOptions).dataUrl
        : null
    );
    if (
      !dataUrl
      || Buffer.byteLength(dataUrl, "utf8") > REMOTE_ICON_MAX_DATA_URL_BYTES
    ) {
      return {
        dataUrl: null,
        sourcePath: iconPath,
        mimeType: mimeTypeForIconPath(iconPath),
      };
    }
    const mimeType = /^data:([^;,]+)[;,]/i.exec(dataUrl)?.[1] ?? null;
    return { dataUrl, sourcePath: iconPath, mimeType };
  } catch {
    return EMPTY_ICON;
  }
}

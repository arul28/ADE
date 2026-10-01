/**
 * The file types a project icon may use, in one place. The local icon picker,
 * the upload to a host, and the host's own check all derive from this table,
 * so they cannot disagree about what a project icon is.
 */
export const PROJECT_ICON_MIME_TYPES_BY_EXTENSION: Readonly<Record<string, readonly string[]>> = {
  ".ico": ["image/x-icon", "image/vnd.microsoft.icon"],
  ".jpg": ["image/jpeg"],
  ".jpeg": ["image/jpeg"],
  ".png": ["image/png"],
  ".svg": ["image/svg+xml"],
  ".webp": ["image/webp"],
};

/** Lowercase extensions, with the dot. */
export const PROJECT_ICON_EXTENSIONS: readonly string[] = Object.keys(PROJECT_ICON_MIME_TYPES_BY_EXTENSION);

/** Extensions without the dot, as a native file dialog filter wants them. */
export const PROJECT_ICON_DIALOG_EXTENSIONS: readonly string[] = PROJECT_ICON_EXTENSIONS.map((extension) =>
  extension.slice(1),
);

export const PROJECT_ICON_TYPE_ERROR = "Project icon must be an ico, jpg, png, svg, or webp file.";

/**
 * Largest icon file a desktop may upload to a host with `projects.setIcon`.
 * The bytes travel inline in one RPC frame; the host still serves the usual
 * small thumbnail in `projects.list`.
 */
export const REMOTE_PROJECT_ICON_UPLOAD_MAX_BYTES = 2 * 1024 * 1024;

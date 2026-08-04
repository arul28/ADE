/**
 * Typed failures for the pinned agent-tools distribution.
 *
 * Every failure a caller can reasonably react to differently gets its own
 * `kind`. A later UX layer maps these onto retry buttons, "free up disk"
 * banners, and "another ADE is already installing" spinners, so consumers must
 * branch on `kind` and never on the message text.
 */
export type ToolErrorKind =
  /** The bundled manifest is malformed, or names a tool that does not exist. */
  | "manifest"
  /** This platform/arch pair has no pinned build. */
  | "unsupported-target"
  /** DNS, TLS, HTTP status, or an idle socket while downloading. */
  | "network"
  /** The download completed but its sha512 did not match the pinned integrity. */
  | "integrity"
  /** Not enough free space on the volume that hosts the tools cache. */
  | "disk-space"
  /** `tar` could not unpack the archive. */
  | "extract"
  /** Another process held the install lock for longer than the timeout. */
  | "lock-timeout"
  /** mkdir/rename/unlink failed for a reason that is not one of the above. */
  | "filesystem"
  /** The tool is pinned and supported, but has not been fetched on this machine. */
  | "not-installed";

export type ToolErrorContext = {
  kind: ToolErrorKind;
  tool?: string;
  packageName?: string;
  version?: string;
  target?: string;
  /** Bytes required vs available, for `disk-space`. */
  requiredBytes?: number;
  availableBytes?: number;
  cause?: unknown;
};

export class ToolError extends Error {
  readonly kind: ToolErrorKind;
  readonly tool?: string;
  readonly packageName?: string;
  readonly version?: string;
  readonly target?: string;
  readonly requiredBytes?: number;
  readonly availableBytes?: number;

  constructor(message: string, context: ToolErrorContext) {
    super(message, { cause: context.cause });
    this.name = "ToolError";
    this.kind = context.kind;
    this.tool = context.tool;
    this.packageName = context.packageName;
    this.version = context.version;
    this.target = context.target;
    this.requiredBytes = context.requiredBytes;
    this.availableBytes = context.availableBytes;
  }
}

export function isToolError(value: unknown): value is ToolError {
  return value instanceof ToolError;
}

/**
 * Wrap an unknown throw as a `filesystem` failure unless it already carries a
 * more specific kind. Keeps `catch` blocks from flattening a real integrity or
 * disk-space diagnosis into a generic message.
 */
export function asToolError(error: unknown, context: ToolErrorContext): ToolError {
  if (isToolError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ToolError(message, { ...context, cause: error });
}

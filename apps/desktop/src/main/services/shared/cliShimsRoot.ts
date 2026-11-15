import os from "node:os";
import path from "node:path";

/**
 * Where ADE writes the per-runtime command shims its agents get on PATH
 * (`ade`, and GitHub's `gh` and git credential helper).
 *
 * macOS and Windows give each user their own temp folder. Linux shares `/tmp`,
 * where the shims folder is private to whoever made it first, so another user
 * (an ADE Cloud image builds as root, its brain runs as `node`) could never
 * write there and every shim was off: each user gets their own folder.
 */
export function defaultCliShimsRoot(
  platform: NodeJS.Platform = process.platform,
  tmpdir: string = os.tmpdir(),
  uid: number | null = typeof process.getuid === "function" ? process.getuid() : null,
): string {
  const shared = path.join(tmpdir, "ade-cli-shims");
  if (platform === "win32" || platform === "darwin" || uid == null) return shared;
  return `${shared}-${uid}`;
}

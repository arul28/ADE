import fs from "node:fs";
import path from "node:path";

/**
 * Resolve a path under the app's bundled `resources/` directory.
 *   packaged: <resourcesPath>/<subpath>
 *   dev:      apps/desktop/resources/<subpath>, found by searching upward from
 *             the compiled output (tsup output nesting varies, so a fixed level
 *             count is brittle — locate the real `resources/<subpath>` instead).
 *
 * Shared by the whisper binary resolver and the glossary loader so the dev walk
 * lives in exactly one place.
 */
export function resolveBundledResource(
  subpath: string,
  options: { isPackaged: boolean; resourcesPath?: string | null },
): string {
  if (options.isPackaged && options.resourcesPath) {
    return path.join(options.resourcesPath, subpath);
  }
  for (let dir = __dirname, i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, "resources", subpath);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(path.resolve(__dirname, "..", ".."), "resources", subpath);
}

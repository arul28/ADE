/**
 * Cursor names its per-workspace directory under `~/.cursor/projects/` by
 * slugging the absolute workspace path. This is a byte-for-byte reimplementation
 * of the slug function Cursor ships in `@cursor/sdk` (1.0.23,
 * `../utils/dist/index.js`):
 *
 *   function slug(p) {
 *     return p.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
 *   }
 *   function projectDir(home, workspacePath) {
 *     return `${home}/.cursor/projects/${slug(workspacePath)}`;
 *   }
 *
 * Every non-alphanumeric character becomes `-`, runs collapse, and leading and
 * trailing dashes are trimmed. Do not "improve" this: matching Cursor exactly is
 * the whole point. In particular:
 *   - `_` and `.` become `-`, they are not preserved or dropped;
 *   - a Windows drive letter survives as its own segment, so
 *     `C:\Users\me\repo` is `C-Users-me-repo` (the colon and backslashes each
 *     become a dash and then collapse), while `/Users/me/repo` is
 *     `Users-me-repo` because the leading dash is trimmed.
 */
export function cursorProjectSlug(workspacePath: string): string {
  return workspacePath
    .replace(/[^a-zA-Z0-9]/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

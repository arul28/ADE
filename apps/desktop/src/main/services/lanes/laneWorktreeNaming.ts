// What ADE names a lane's worktree folder. Leaf module: no services.

export function slugify(input: string): string {
  const s = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.length ? s : "lane";
}

/**
 * Longest lane-name part of a worktree folder name. The folder sits between
 * the project path and every file of the checkout, and Windows stops at 260
 * characters: a lane named after a long issue title made a 148-character
 * folder, and every checkout of a repo with 130-character paths failed.
 */
const WORKTREE_FOLDER_SLUG_MAX_CHARS = 40;

/**
 * `<slug>-<laneId[0:8]>`, the slug cut to a word boundary. The id suffix keeps
 * names unique and is what `worktreeDirSuffix` reads back.
 */
export function laneWorktreeFolderName(name: string, laneId: string): string {
  let slug = slugify(name);
  if (slug.length > WORKTREE_FOLDER_SLUG_MAX_CHARS) {
    const cut = slug.slice(0, WORKTREE_FOLDER_SLUG_MAX_CHARS);
    const lastDash = cut.lastIndexOf("-");
    slug = (lastDash >= WORKTREE_FOLDER_SLUG_MAX_CHARS / 2 ? cut.slice(0, lastDash) : cut).replace(/-+$/, "") || "lane";
  }
  return `${slug}-${laneId.slice(0, 8)}`;
}

/** The uncapped folder name older versions made, for paths recorded before the cap. */
export function legacyLaneWorktreeFolderName(name: string, laneId: string): string {
  return `${slugify(name)}-${laneId.slice(0, 8)}`;
}

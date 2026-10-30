// Small helpers the real-load benches share: their flags, their median, and the guard that keeps a
// bench off a live project.
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);

/** The value after `--name`, or undefined. */
export function flag(name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * The resolved root of a make-real-load-copy copy. Throws for anything else, so a bench never opens,
 * copies or measures a live project's database.
 */
export function requireCopyRoot(root: string | undefined): string {
  if (!root) throw new Error("--project <copy root> is required (a make-real-load-copy copy, never a live project)");
  const resolved = path.resolve(root);
  if (!fs.existsSync(path.join(resolved, ".ade", "real-load-copy.json"))) {
    throw new Error(`${resolved} is not a make-real-load-copy copy; refusing to use it`);
  }
  return resolved;
}

import { rootSpellings } from "./moveGitLinks";
import { listMoveRecords } from "./moveJournal";

/** Folders this project was moved out of, newest first, following a chain of moves. */
export function previousProjectRoots(projectRoot: string): string[] {
  const records = listMoveRecords().filter((record) => record.state === "done");
  const current = new Set(rootSpellings(projectRoot));
  const roots: string[] = [];
  let frontier = [...current];
  for (let hops = 0; hops < 10 && frontier.length; hops += 1) {
    const next: string[] = [];
    for (const record of records) {
      if (!frontier.includes(record.destinationRoot)) continue;
      if (current.has(record.sourceRoot) || roots.includes(record.sourceRoot)) continue;
      roots.push(record.sourceRoot);
      next.push(record.sourceRoot);
    }
    frontier = next;
  }
  return roots;
}


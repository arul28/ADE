import { rootSpellings } from "./moveGitLinks";
import { listMoveRecords } from "./moveJournal";

/** Folders this project was moved out of, newest first, following a chain of moves. */
export function previousProjectRoots(projectRoot: string): string[] {
  const records = listMoveRecords()
    .filter((record) => record.state === "done" && record.finishedAt != null)
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  const roots: string[] = [];
  let frontier: Array<{ spellings: string[]; before: number | null }> = [
    { spellings: rootSpellings(projectRoot), before: null },
  ];
  for (let hops = 0; hops < 10 && frontier.length; hops += 1) {
    const next: typeof frontier = [];
    for (const entry of frontier) {
      const record = records.find((candidate) => entry.spellings.includes(candidate.destinationRoot)
        && (entry.before === null || (candidate.finishedAt ?? Infinity) < entry.before));
      if (!record || roots.includes(record.sourceRoot)) continue;
      roots.push(record.sourceRoot);
      next.push({ spellings: rootSpellings(record.sourceRoot), before: record.finishedAt });
    }
    frontier = next;
  }
  return roots;
}


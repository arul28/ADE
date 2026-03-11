export type ParsedGitStatusPorcelain = {
  unmergedPaths: string[];
  changedPaths: string[];
};

const UNMERGED_CODES = new Set(["UU", "AA", "DD", "DU", "UD", "AU", "UA"]);

function normalizeStatusPath(rawLine: string): string | null {
  const line = rawLine.replace(/\r$/, "");
  if (line.length < 4) return null;
  let filePath = line.slice(3).trim();
  if (!filePath) return null;
  const renameDelimiter = filePath.indexOf(" -> ");
  if (renameDelimiter >= 0) {
    filePath = filePath.slice(renameDelimiter + 4).trim();
  }
  return filePath || null;
}

export function parseGitStatusPorcelain(stdout: string): ParsedGitStatusPorcelain {
  const changed = new Set<string>();
  const unmerged = new Set<string>();

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const code = line.slice(0, 2);
    const filePath = normalizeStatusPath(line);
    if (!filePath) continue;
    changed.add(filePath);
    if (UNMERGED_CODES.has(code)) {
      unmerged.add(filePath);
    }
  }

  return {
    unmergedPaths: [...unmerged],
    changedPaths: [...changed],
  };
}

export function hasMergeConflictMarkers(content: string): boolean {
  return content.includes("<<<<<<<") && content.includes("=======") && content.includes(">>>>>>>");
}

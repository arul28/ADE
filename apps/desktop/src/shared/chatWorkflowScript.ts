/**
 * The plan a Claude dynamic workflow's script declares: `export const meta =
 * { name, description, phases: [{ title, detail }] }`.
 *
 * One parser, shared by the transcript's script row and the chat-actions pane's
 * workflow section, so the two surfaces can never disagree about the run's name
 * or its phases. Pure string work: the script is provider-authored text and
 * every field is best-effort — an unparseable script yields nulls, never throws.
 */
export type ChatWorkflowScriptPlan = {
  /** `meta.name`, when the script declares one. */
  name: string | null;
  /** `meta.phases` titles, in plan order. Declared, not live. */
  phases: string[];
  /** Total line count, for the `N lines` label. */
  lines: number;
};

/**
 * The `meta` object literal a workflow script declares, when it parses.
 *
 * Everything below reads *inside* this block: a script's own helpers and agents
 * can carry a `name:` too, and matching anywhere in the file would report an
 * unrelated helper as the run's name (or a nested object's `phases` as its plan).
 */
function readWorkflowMetaBlock(script: string): string | null {
  const start = /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+meta\s*=\s*\{/.exec(script);
  if (!start) return null;
  const open = script.indexOf("{", start.index);
  if (open === -1) return null;
  let depth = 0;
  for (let index = open; index < script.length; index += 1) {
    const char = script[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return script.slice(open + 1, index);
    }
  }
  return null;
}

/** `meta.name` from a workflow script, e.g. `name: 'skate-build'`. */
export function readWorkflowMetaName(script: string): string | null {
  const meta = readWorkflowMetaBlock(script);
  if (!meta) return null;
  const match = /(?:^|,|\n)\s*name\s*:\s*(['"`])([^'"`\n]+)\1/.exec(meta);
  return match?.[2]?.trim() || null;
}

/** The `meta.phases` titles a workflow script declares, in order. */
export function readWorkflowMetaPhases(script: string): string[] {
  const meta = readWorkflowMetaBlock(script);
  if (!meta) return [];
  const block = /(?:^|,|\n)\s*phases\s*:\s*\[([\s\S]*?)\]/.exec(meta)?.[1];
  if (!block) return [];
  const titles: string[] = [];
  const pattern = /title\s*:\s*(['"`])([^'"`\n]+)\1/g;
  let match: RegExpExecArray | null = pattern.exec(block);
  while (match) {
    const title = match[2]!.trim();
    if (title) titles.push(title);
    match = pattern.exec(block);
  }
  return titles;
}

/** The plan of one script. Null when the string is empty. */
export function readWorkflowScriptPlan(script: string | null | undefined): ChatWorkflowScriptPlan | null {
  if (typeof script !== "string" || !script.trim().length) return null;
  return {
    name: readWorkflowMetaName(script),
    phases: readWorkflowMetaPhases(script),
    lines: script.split(/\r?\n/).length,
  };
}

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

/** `meta.name` from a workflow script, e.g. `name: 'skate-build'`. */
export function readWorkflowMetaName(script: string): string | null {
  const match = /(?:^|\n)\s*name\s*:\s*(['"`])([^'"`\n]+)\1/.exec(script);
  return match?.[2]?.trim() || null;
}

/** The `meta.phases` titles a workflow script declares, in order. */
export function readWorkflowMetaPhases(script: string): string[] {
  const block = /(?:^|\n)\s*phases\s*:\s*\[([\s\S]*?)\]/.exec(script)?.[1];
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

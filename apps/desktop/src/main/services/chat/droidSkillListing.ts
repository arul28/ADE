import os from "node:os";
import path from "node:path";

import { isPathInside, pathKey } from "../shared/pathCompare";
import {
  createSlashCommandListingCache,
  discoverClaudeSlashCommands,
  planSlashCommandInjection,
  renderWithinBudget,
  skillListingEntry,
  type DiscoveredClaudeSlashCommand,
  type SkillListingEntry,
  type NativeSlashCommandRoots,
  type SlashCommandInjectionPlan,
} from "./claudeSlashCommandDiscovery";

/**
 * The listing budget for a harness whose prompt ADE re-sends with every turn
 * (Droid): the same entries, at a third of the size, because the cost is paid
 * per message rather than once per session.
 */
const PER_TURN_SKILL_LISTING_BUDGET_BYTES = 5 * 1024;
const PER_TURN_SKILL_DESC_CHARS = 90;

/**
 * The skill roots Droid finds without ADE's help.
 *
 * Droid reads `skills/` under `.factory`, and also under `.agents` and
 * `.agent` (its "project (.agents)" and "user (.agents)" sources, in the
 * project and in the home directory; checked in the 0.244.0 binary and in
 * Factory's skills docs). It does not read `.claude/skills`, so those skills
 * never reach a Droid chat unless ADE lists them. `alreadyNamedRoots` are
 * roots the prompt names elsewhere (ADE's bundled skills), so they are not
 * listed a second time.
 */
function droidNativeSlashCommandRoots(
  cwd: string,
  alreadyNamedRoots: readonly string[] = [],
  home: string = os.homedir(),
): NativeSlashCommandRoots {
  const configRoots = [path.resolve(cwd, ".factory"), path.resolve(home, ".factory")];
  const agentRoots = [".agents", ".agent"].flatMap((dir) => [path.resolve(cwd, dir), path.resolve(home, dir)]);
  return {
    commandRoots: configRoots.map((root) => path.join(root, "commands")),
    skillRoots: [
      ...[...configRoots, ...agentRoots].map((root) => path.join(root, "skills")),
      ...alreadyNamedRoots.map((root) => path.resolve(root)),
    ],
  };
}

/** A Droid listing: its prompt lines, and the entries it lists. Cached and shared: read-only. */
export type DroidSkillListing = { readonly lines: readonly string[]; readonly entries: readonly SkillListingEntry[] };

const EMPTY_LISTING: DroidSkillListing = { lines: [], entries: [] };

/**
 * The prompt section that tells a harness which project and user skills exist
 * that it would not find on its own. Empty when there is nothing to add.
 */
function buildSkillListingSection(
  plan: SlashCommandInjectionPlan,
  budgetBytes: number,
  /** The project directory: its own files are listed before the user's. */
  cwd: string,
): DroidSkillListing {
  // The project's own files first. They are the ones written for this
  // codebase, and an alphabetical list spent the whole budget before reaching
  // a project's `/quality` or `/test`.
  const inProject = (entry: DiscoveredClaudeSlashCommand) => isPathInside(entry.filePath, cwd);
  const entries = [...plan.commands, ...plan.skills]
    .sort((a, b) => Number(inProject(b)) - Number(inProject(a)));
  const { lines, kept, omitted } = renderWithinBudget(entries, (entry) => {
    // One short line each: this list is paid for on every turn.
    const description = entry.description.trim().replace(/\s+/g, " ");
    const clipped = description.length > PER_TURN_SKILL_DESC_CHARS
      ? `${description.slice(0, PER_TURN_SKILL_DESC_CHARS - 1).trimEnd()}…`
      : description;
    return `- ${entry.name}${clipped ? ` — ${clipped}` : ""} (${entry.filePath})`;
  }, budgetBytes);
  if (!lines.length) return EMPTY_LISTING;
  const section = [
    "## Project commands and skills",
    "Files this project and this user keep that your harness does not load on its own. When the user sends `/<name>`, ADE expands the file for you. When one fits the task, read its file and follow it.",
    ...lines,
    ...(omitted > 0
      ? [`- ${omitted} more omitted to keep this list short. Run \`ade skill list --text\` if none of these fits.`]
      : []),
  ];
  return { lines: section, entries: kept.map((entry, index) => skillListingEntry(entry, lines[index]!)) };
}

/*
 * The finished listing, per project directory. Droid's prompt is rebuilt on
 * every turn, and planning lists each native root and resolves each skill's
 * real path; on discovery's own TTL a turn costs one map lookup instead.
 */
const cachedListing = createSlashCommandListingCache<DroidSkillListing>();

/**
 * The lines that tell a Droid chat in `cwd` which of the project's and the
 * user's commands and skills exist: Droid reads `.factory`, `.agents` and
 * `.agent` skills itself, so only the ones in `.claude/skills` are listed, as
 * for Claude. Skills that opt out of model invocation are left out, and so is
 * everything under `alreadyNamedRoots`. Empty when there is nothing to add, or
 * when the files could not be read.
 */
export function buildDroidSkillListing(cwd: string, alreadyNamedRoots: readonly string[]): DroidSkillListing {
  try {
    const key = [pathKey(cwd), ...alreadyNamedRoots.map((root) => pathKey(path.resolve(root)))].join("\n");
    return cachedListing(key, () => {
      const discovered = discoverClaudeSlashCommands(cwd).filter((entry) => entry.modelInvocable !== false);
      return buildSkillListingSection(
        planSlashCommandInjection(discovered, droidNativeSlashCommandRoots(cwd, alreadyNamedRoots)),
        PER_TURN_SKILL_LISTING_BUDGET_BYTES,
        cwd,
      );
    });
  } catch {
    return EMPTY_LISTING;
  }
}

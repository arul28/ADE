import type { ProjectMoveRecord, ProjectMoveVolume } from "../../../shared/types/projectMove";
import { isPathEqualOrDescendant } from "../../lib/pathUtils";

/** Window event the move surfaces fire so the Location row and the banner re-read. */
export const PROJECT_MOVE_CHANGED_EVENT = "ade:project-move-changed";

export function announceProjectMoveChanged(): void {
  window.dispatchEvent(new Event(PROJECT_MOVE_CHANGED_EVENT));
}

export { formatBytes } from "../../../shared/formatting";

/** `~/Projects/ADE` for display (macOS home folders live at `/Users/<name>`). */
export function displayPath(fullPath: string): string {
  return fullPath.replace(/^\/Users\/[^/]+(?=\/|$)/u, "~");
}

/** The drive a path is on: a `/Volumes/<name>` mount, else this Mac's internal disk. */
export function volumeFor(root: string, volumes: ProjectMoveVolume[]): ProjectMoveVolume | null {
  const mounted = volumes
    .filter((volume) => volume.mountPath.startsWith("/Volumes/") && isPathEqualOrDescendant(root, volume.mountPath))
    .sort((a, b) => b.mountPath.length - a.mountPath.length)[0];
  return mounted ?? volumes.find((volume) => volume.internal) ?? null;
}

export const REMINDER_CHOICES: ReadonlyArray<{ label: string; ms: number }> = [
  { label: "Tomorrow", ms: 24 * 60 * 60_000 },
  { label: "In 3 days", ms: 3 * 24 * 60 * 60_000 },
  { label: "In a week", ms: 7 * 24 * 60 * 60_000 },
];

export function formatReminder(at: number | undefined): string {
  if (!at) return "";
  if (at <= Date.now()) return "due now";
  const date = new Date(at);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60_000).toDateString() === date.toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (sameDay) return `today at ${time}`;
  if (tomorrow) return `tomorrow at ${time}`;
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

/**
 * What the check agent is asked to do. It confirms the move from inside the
 * moved project, reinstalls dependencies, runs the build, and reports. The old
 * copy is off limits: deleting it is the person's choice, made in ADE.
 *
 * The Done step shows it in an editable box beside the model, effort and
 * permission picker; the person starts the agent from there.
 */
export function agentCheckPrompt(record: ProjectMoveRecord): string {
  const followUps = record.followUps.length
    ? record.followUps.map((line) => `- ${line}`).join("\n")
    : "- Nothing else to note.";
  return [
    `ADE just moved this project from \`${record.sourceRoot}\` to \`${record.destinationRoot}\`${record.destinationVolumeName ? ` (on ${record.destinationVolumeName})` : ""}. Check that everything works here, then report back.`,
    "",
    "1. Confirm where you are: run `pwd` and `git worktree list`. Every lane should be under the new location, except lanes that always lived outside the project folder: those stay where they are and should now belong to this repository. Nothing should point at the old location.",
    "2. Run `git status` in the project and in each lane. Nothing should look unexpectedly changed.",
    "3. Dependencies (node_modules) were not copied. Reinstall them with the project's package manager, then run its build and its quickest test command. Report failures; don't change code to make them pass. Lanes link their node_modules to the main checkout's, so those links work again once the main checkout is reinstalled; don't remove them.",
    `4. Find files that still mention \`${record.sourceRoot}\`: CLAUDE.md, AGENTS.md, .claude/settings*.json, .env files, scripts, editor settings. List each with its line and the change you'd make. Ask me before editing.`,
    "5. ADE's notes from the move:",
    followUps,
    "",
    "Rules:",
    record.originalParkedAt
      ? `- The old copy at \`${record.originalParkedAt}\` is read-only for you. Don't edit it, run git in it, or delete it, even if asked. I delete it from ADE.`
      : "- The old copy is already gone; work only in the moved project.",
    "- Keep the report short: what works, what you fixed (only with my OK), what I need to do.",
    "",
    "Finish by telling me: when I'm happy, I can delete the old copy, keep it, or set a reminder from ADE's banner or Settings → Project location.",
  ].join("\n");
}

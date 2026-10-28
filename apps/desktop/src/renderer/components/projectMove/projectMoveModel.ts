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
  const bullets = (lines: string[]) => (lines.length ? lines.map((line) => `- ${line}`).join("\n") : "- Nothing.");
  const notes = (record.notes ?? []).map((note) => `### ${note.title}\n${note.detail}`).join("\n\n");
  const dependencies = record.copiedDependencies
    ? "3. Dependencies (node_modules) were copied with the project. Run the build and the quickest test command to prove they still work here. If a tool refuses its copied dependencies (pnpm can ask to reinstall when its store is on another drive), tell me and offer to reinstall; don't change code to make anything pass."
    : "3. Dependencies (node_modules) were not copied. Detect the package manager from the lockfile and offer me to reinstall in the project and in each lane that has its own package install; run it only when I say so. Then run the build and the quickest test command. A lane whose node_modules is a link into the main checkout works again once the main checkout is installed, but only when the link's target exists there: check each such link, keep the ones whose target exists, and list the ones whose target does not exist (for example a package that only that lane has) instead of saying they will work; don't remove links unless I ask. Report failures; don't change code to make them pass.";
  return [
    `ADE just moved this project from \`${record.sourceRoot}\` to \`${record.destinationRoot}\`${record.destinationVolumeName ? ` (on ${record.destinationVolumeName}${record.destinationInternal ? "" : ", an external drive"})` : ""}. Check that everything works here, find what still needs doing, and offer me the fixes. Ask before changing anything.`,
    "",
    "1. Confirm where you are: run `pwd` and `git worktree list`. Every lane should be under the new location, except lanes that always lived outside the project folder: those stay where they are and should now belong to this repository. Nothing should point at the old location.",
    "2. Run `git --no-optional-locks status` in the project and in each lane. Nothing should look unexpectedly changed.",
    dependencies,
    `4. Find files that still name \`${record.sourceRoot}\`: the list ADE found is below; also check scripts, .env files, editor settings and Python virtualenvs. For each, say the change you'd make. Ask me before editing.`,
    "5. Run `ade health --text` (the same checks Settings → Project shows) and go through any open issues with me: explain each, and offer its fix or what I should do. Fixes are mine to press there.",
    "",
    "## What ADE did",
    bullets(record.followUps),
    "",
    "## What ADE couldn't do",
    bullets(record.problems),
    ...(notes ? ["", "## What ADE found before the move", notes] : []),
    "",
    "Rules:",
    record.originalParkedAt
      ? `- The old copy at \`${record.originalParkedAt}\` is read-only for you. Don't edit it, run git in it, or delete it, even if asked. I delete it from ADE.`
      : "- The old copy is already gone; work only in the moved project.",
    ...(record.destinationInternal ? [] : ["- This project is on an external drive. Simulator screenshots: use ADE's Apple tools (`ade apple …`), which handle the drive; a hand-run `xcrun simctl io … screenshot` must write to /tmp."]),
    "- Keep the report short: what works, what you fixed (only with my OK), what I need to do.",
    "",
    "Finish by telling me: when I'm happy, I can delete the old copy, keep it, or set a reminder from ADE's banner or Settings → Project → Location.",
  ].join("\n");
}

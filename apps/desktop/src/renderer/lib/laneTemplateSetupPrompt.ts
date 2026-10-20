import type { LaneDependencyFolderStatus } from "../../shared/types";

const MAX_LISTED_LOCKFILES = 12;

/**
 * The prompt the "Set up a lane template" banner and the Settings button put in
 * a new chat in the primary lane. It is written into the composer and never
 * sent: the user picks a model and presses Send.
 */
export function buildLaneTemplateSetupPrompt(args: {
  projectName: string | null;
  /** The machine the chat runs on (its main checkout is where templates are saved). */
  machineName: string;
  folders: Array<Pick<LaneDependencyFolderStatus, "lockfile" | "manager">>;
  templateNames: string[];
  /** The template that already runs for new lanes there, if any. */
  defaultTemplateName?: string | null;
}): string {
  const project = args.projectName?.trim() || "this project";
  const listed = args.folders.slice(0, MAX_LISTED_LOCKFILES).map((folder) => `- ${folder.lockfile} (${folder.manager})`);
  if (args.folders.length > MAX_LISTED_LOCKFILES) {
    listed.push(`- and ${args.folders.length - MAX_LISTED_LOCKFILES} more (run \`ade lanes deps --text\`)`);
  }
  const existing = !args.templateNames.length
    ? "This machine has no lane templates yet."
    : args.defaultTemplateName
      ? `This machine has these templates: ${args.templateNames.join(", ")}. "${args.defaultTemplateName}" runs for new lanes; read it before you write a new one.`
      : `This machine already has these templates, but none runs for new lanes: ${args.templateNames.join(", ")}.`;

  return [
    `Set up a lane template for ${project}, so every new lane is ready to work in and uses little disk.`,
    "",
    "## What you need to know",
    "- A lane is a git worktree of this repo in its own folder. New lanes are plain worktrees: ADE does not copy, link or install any packages into them.",
    "- A lane template says what happens when a lane is created. It can copy env files, install packages, copy paths from the main checkout, and run a setup script. With `injectPrimaryPath: true`, the setup script gets `$PRIMARY_WORKTREE_PATH` (the main checkout).",
    "- The default template runs for every new lane on that machine. Templates are stored per machine (in that machine's `.ade/local.yaml`) and do not sync.",
    `- This chat runs in the main checkout on ${args.machineName}, so a template you save here is for ${args.machineName}.`,
    "- Read `ade help lanes` and the ade-lanes-git skill for the template commands (`ade lanes templates …`, `ade lanes deps`).",
    "",
    "## What ADE found in the main checkout",
    ...(listed.length ? listed : ["- No lockfiles. Read the repo to see how it gets its packages."]),
    existing,
    "",
    "## Before you write the template",
    "1. Ask me: make one template for all my machines, or a separate template for each machine? List my machines with `ade machines list`. To read or write another machine's templates, add `--machine \"<name>\"` to the `ade lanes templates` commands.",
    "2. Suggest, but do not do: research current package managers and build tools online. If a different one, or a different setting, would make installs, builds or CI clearly faster or smaller for this repo, tell me what it is, what it would save, and what it would cost to switch. Do not switch it yourself.",
    "",
    "## The template",
    "- Read the repo's layout first: every lockfile and package folder, workspaces or monorepos, native modules, build output, and any docs that say how to install.",
    "- Pick the method that saves the most disk and time and is still safe on each machine. Keep what the project's package manager already does well; for example, pnpm already shares files from its store, so a plain `pnpm install` is often the best step.",
    "- Do not change the project's package manager, its settings, or its lockfiles.",
    "- Never make a lane share a writable package folder with the main checkout without telling me the risk: an install in the lane then changes the main checkout too.",
    "- Each install or setup command may run up to 20 minutes.",
    "- Setup commands run on the lane's own machine in a plain shell (`/bin/sh -c` on macOS and Linux, `cmd.exe` on Windows) with that machine's login-shell PATH. Aliases, shell functions and anything set only in an interactive shell are not there. Each machine can have its own Node, Python or package manager in its own place, so check what each machine resolves (`command -v npm`, `node -v`) before you rely on a tool or a version.",
    "",
    "## Check it before you call it done",
    "1. Save the template and set it as the default on the machines I choose.",
    "2. On every machine you saved it to, create a test lane with it (`ade lanes create --name template-test --template <id>`, plus `--machine \"<name>\"` for another machine), and wait for setup to finish. A template that works on this machine can fail on another one: a different OS, shell, or tool location. Do the checks below on each machine.",
    "3. Check that each package folder in the test lane is the lane's own folder, not a link, unless I asked for links.",
    "4. Run one quick check in the test lane (a typecheck, one test, or a build step).",
    "5. Check that the main checkout's package folders did not change.",
    "6. Measure the real disk the test lane uses with the free space before and after (`df`). `du` and Finder count space-saving clones at full size.",
    "7. Delete each test lane (`ade lanes delete <lane> --force`, with `--machine` for another machine) and tell me what the template does, and for each machine how long setup took and how much disk a lane uses.",
  ].join("\n");
}

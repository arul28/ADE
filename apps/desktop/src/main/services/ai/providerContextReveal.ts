/**
 * The folders and files a provider page's "Initial context window" card may
 * show in Finder.
 *
 * The card lists the files a new chat sends: provider config homes (`~/.claude`,
 * `~/.codex`, …), shared skill folders (`~/.agents`), the project, the
 * instruction files in the folders above it, and ADE's own skills. The general
 * `appRevealPath` handler only allows the project and the user's Downloads,
 * Documents and temp folders, so most of those rows would be refused. Widening
 * that list for every caller is the wrong trade; this list is only for the
 * card's button. It shows a location; it never opens or reads a file.
 */
import os from "node:os";
import path from "node:path";
import {
  claudeConfigHome,
  claudeManagedInstructionsFile,
  codexConfigHome,
  copilotConfigHome,
  devinConfigDir,
  factoryConfigHome,
  grokConfigHome,
  kimiCodeConfigHome,
  openCodeConfigDir,
  piAgentDir,
  qwenConfigHome,
} from "../shared/providerConfigHomes";

/**
 * The instruction files providers read from each folder above the project
 * (Claude, Codex, Pi, Droid, Copilot): only these names, so an ancestor
 * folder itself is never a root.
 */
const ANCESTOR_FILES = [
  "CLAUDE.md",
  "CLAUDE.local.md",
  path.join(".claude", "CLAUDE.md"),
  "AGENTS.md",
  "AGENTS.override.md",
  path.join(".factory", "mcp.json"),
];

function ancestors(dir: string): string[] {
  const out: string[] = [];
  let current = path.resolve(dir);
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) return out;
    out.push(parent);
    current = parent;
  }
}

export function providerContextRevealRoots(args: {
  projectRoot: string | null;
  adeDir: string;
  /** Where ADE's bundled skills live: the app's own folders. */
  appDirs: readonly string[];
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
}): string[] {
  const env = args.env ?? process.env;
  const home = path.resolve(args.homeDir ?? os.homedir());
  const homeArgs = { env, homeDir: home, platform: args.platform };
  const projectRoot = args.projectRoot?.trim() ? path.resolve(args.projectRoot) : null;
  return [
    ...(projectRoot ? [projectRoot] : []),
    ...(projectRoot ? ancestors(projectRoot).flatMap((dir) => ANCESTOR_FILES.map((name) => path.join(dir, name))) : []),
    args.adeDir,
    ...args.appDirs,
    claudeManagedInstructionsFile(homeArgs),
    claudeConfigHome(homeArgs),
    // Claude Code keeps its MCP servers in a file beside its config folder.
    path.join(home, ".claude.json"),
    codexConfigHome(homeArgs),
    copilotConfigHome(homeArgs),
    factoryConfigHome(homeArgs),
    qwenConfigHome(homeArgs),
    kimiCodeConfigHome(homeArgs),
    grokConfigHome(homeArgs),
    piAgentDir(homeArgs),
    openCodeConfigDir(homeArgs),
    devinConfigDir(homeArgs),
    // Skill and rule folders several providers share, and the rest of the
    // providers' homes.
    ...[".agents", ".agent", ".cursor", ".gemini", ".devin", ".kimi"].map((dir) => path.join(home, dir)),
  ];
}

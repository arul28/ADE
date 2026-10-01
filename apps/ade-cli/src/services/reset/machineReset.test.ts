import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultMachineResetDeps,
  executeMachineReset,
  findAdeAncestor,
  isAdeProcessCommand,
  stripAdeShellLines,
  type MachineResetDeps,
  type ProcessEntry,
  type RunResult,
} from "./machineReset";

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "ADE reset test",
  GIT_AUTHOR_EMAIL: "reset-test@ade.invalid",
  GIT_COMMITTER_NAME: "ADE reset test",
  GIT_COMMITTER_EMAIL: "reset-test@ade.invalid",
};

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Run a real git command; every other external command is intercepted. */
function git(cwd: string, args: string[]): RunResult {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

function branchNames(project: string): string[] {
  return git(project, ["branch", "--format=%(refname:short)"]).stdout.split("\n").filter(Boolean);
}

/**
 * A throwaway machine under one temp folder: a home with an ADE registry, a
 * git project with a committed `.ade/` file, a redundant lane, a lane with its
 * own commit, and a lane with uncommitted work.
 */
function buildFixture(): { home: string; project: string; deps: MachineResetDeps } {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), "ade-reset-test-"));
  sandboxes.push(sb);
  const home = path.join(sb, "home");
  const tmp = path.join(sb, "tmp");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });

  const remote = path.join(sb, "remote.git");
  git(sb, ["init", "-q", "--bare", remote]);

  const project = path.join(home, "code", "myproj");
  fs.mkdirSync(project, { recursive: true });
  git(project, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(project, "README.md"), "hi\n");
  fs.mkdirSync(path.join(project, ".ade", "cto"), { recursive: true });
  fs.writeFileSync(path.join(project, ".ade", "cto", "identity.yaml"), "identity: shared\n");
  git(project, ["add", "-A"]);
  git(project, ["commit", "-qm", "init"]);
  git(project, ["remote", "add", "origin", remote]);
  git(project, ["push", "-q", "origin", "main"]);

  fs.mkdirSync(path.join(project, ".git", "info"), { recursive: true });
  fs.writeFileSync(path.join(project, ".git", "info", "exclude"), "# local\n.ade/\n");
  fs.writeFileSync(path.join(project, ".ade", "ade.db"), "db\n");

  const worktrees = path.join(project, ".ade", "worktrees");
  git(project, ["worktree", "add", "-q", "-b", "ade/clean-lane", path.join(worktrees, "clean-lane"), "main"]);
  git(project, ["worktree", "add", "-q", "-b", "ade/unique-lane", path.join(worktrees, "unique-lane"), "main"]);
  const uniqueWorktree = path.join(worktrees, "unique-lane");
  fs.writeFileSync(path.join(uniqueWorktree, "unique.txt"), "unique\n");
  git(uniqueWorktree, ["add", "unique.txt"]);
  git(uniqueWorktree, ["commit", "-qm", "unique lane work"]);
  git(project, ["worktree", "add", "-q", "-b", "ade/dirty-lane", path.join(worktrees, "dirty-lane"), "main"]);
  fs.writeFileSync(path.join(worktrees, "dirty-lane", "wip.txt"), "wip\n");

  const adeHome = path.join(home, ".ade");
  fs.mkdirSync(adeHome, { recursive: true });
  fs.writeFileSync(
    path.join(adeHome, "projects.json"),
    `${JSON.stringify({ version: 2, projects: [{ rootPath: project, displayName: "myproj" }] })}\n`,
  );

  const deps: MachineResetDeps = defaultMachineResetDeps({
    platform: "darwin",
    homeDir: home,
    tmpDir: tmp,
    env: { ADE_HOME: adeHome },
    uid: 501,
    selfPid: 999_999,
    extraDesktopDataDirs: [],
    listProcesses: () => [],
    kill: () => {},
    pidAlive: () => false,
    sleep: async () => {},
    run: (command, args, options) =>
      command === "git"
        ? git(options?.cwd ?? project, args)
        : { status: 1, stdout: "", stderr: "intercepted" },
    log: () => {},
  });

  return { home, project, deps };
}

describe("machine reset engine", () => {
  it("with rescue 'none' keeps a branch with unique commits and deletes a redundant one", async () => {
    const { project, deps } = buildFixture();

    const receipt = await executeMachineReset(
      { rescue: "none", receiptPath: path.join(deps.tmpDir, "receipt.json") },
      deps,
    );

    expect(receipt.ok).toBe(true);
    // The redundant lane's worktree and branch are gone; the lane whose commit
    // exists nowhere else survives as a branch.
    expect(receipt.removed.some((target) => target.endsWith(path.join("worktrees", "clean-lane")))).toBe(true);
    expect(receipt.removed.some((target) => target.endsWith("branch ade/clean-lane"))).toBe(true);
    expect(receipt.notes.join("\n")).toContain("Kept branch ade/unique-lane");
    const branches = branchNames(project);
    expect(branches).toContain("ade/unique-lane");
    expect(branches).not.toContain("ade/clean-lane");

    // ADE's data is gone, the project's own files are not, the file it commits
    // under .ade/ is restored, and its exclude rule is scrubbed.
    expect(fs.existsSync(path.join(project, ".ade", "ade.db"))).toBe(false);
    expect(fs.existsSync(path.join(project, ".ade", "cto", "identity.yaml"))).toBe(true);
    expect(fs.readFileSync(path.join(project, ".git", "info", "exclude"), "utf8")).not.toContain(".ade");
    expect(fs.readFileSync(path.join(project, "README.md"), "utf8")).toBe("hi\n");
  });

  it("with rescue 'commit' commits a dirty lane on its branch and keeps it", async () => {
    const { project, deps } = buildFixture();

    const receipt = await executeMachineReset(
      { rescue: "commit", receiptPath: path.join(deps.tmpDir, "receipt.json") },
      deps,
    );

    const rescued = receipt.rescued.find((entry) => entry.lane === "dirty-lane");
    expect(rescued?.mode).toBe("commit");
    expect(rescued?.branch).toBe("ade/dirty-lane");
    // The uncommitted file is now a commit on the lane's kept branch.
    const shown = git(project, ["show", "ade/dirty-lane:wip.txt"]);
    expect(shown.status).toBe(0);
    expect(shown.stdout).toBe("wip\n");
    expect(branchNames(project)).toContain("ade/dirty-lane");
  });

  it("parks a lane in ~/ADE Rescued Lanes when committing its work fails", async () => {
    const { home, deps } = buildFixture();
    const failingDeps: MachineResetDeps = {
      ...deps,
      run: (command, args, options) => {
        if (command === "git" && args.includes("commit")) {
          return { status: 1, stdout: "", stderr: "commit refused by test" };
        }
        return deps.run(command, args, options);
      },
    };

    const receipt = await executeMachineReset(
      { rescue: "commit", receiptPath: path.join(deps.tmpDir, "receipt.json") },
      failingDeps,
    );

    const rescued = receipt.rescued.find((entry) => entry.lane === "dirty-lane");
    expect(rescued?.mode).toBe("move");
    expect(rescued?.location).toBeDefined();
    // Never delete work a rescue could not save: the folder is parked whole.
    expect(rescued?.location).toContain(path.join(home, "ADE Rescued Lanes", "myproj", "dirty-lane"));
    expect(fs.existsSync(path.join(rescued?.location ?? "", "wip.txt"))).toBe(true);
  });

  it("refuses a rescue folder inside a folder it removes, before changing anything", async () => {
    const { project, deps } = buildFixture();

    await expect(
      executeMachineReset(
        {
          rescue: "move",
          rescueDir: path.join(project, ".ade", "rescued"),
          receiptPath: path.join(deps.tmpDir, "receipt.json"),
        },
        deps,
      ),
    ).rejects.toThrow(/inside/);

    expect(fs.existsSync(path.join(project, ".ade", "ade.db"))).toBe(true);
    expect(fs.existsSync(path.join(project, ".ade", "cto", "identity.yaml"))).toBe(true);
  });
});

describe("isAdeProcessCommand", () => {
  it.each<[string, boolean]>([
    ["/Applications/ADE.app/Contents/MacOS/ADE", true],
    ["/Applications/ADE Beta.app/Contents/MacOS/ADE Beta", true],
    ["/Applications/ADE.app/Contents/Resources/native/ade-desktop-driver/ade-desktop-driver --lane x", true],
    ["/Applications/ADE.app/Contents/Resources/ade-cli/dist/cli.cjs serve", true],
    ['"C:\\Users\\me\\AppData\\Local\\ADE\\ADE.exe" --flag', true],
    ["C:\\Program Files\\ADE\\ADE Beta.exe", true],
    ["/Applications/ADE.app/Contents/Resources/native/ade-capture-helper-win.exe", true],
    ["/usr/local/bin/ade-desktop", true],
    // The reset process itself carries the marker and is never its own target.
    ["/Applications/ADE.app/Contents/MacOS/ADE /Applications/ADE.app/Contents/Resources/ade-cli/cli.cjs reset --all --yes", false],
    // Look-alikes the person owns are left alone.
    ["/usr/bin/vim notes.txt", false],
    ["/Applications/Other.app/Contents/MacOS/Other", false],
    ["/usr/local/bin/myade-desktopx", false],
    ["/Applications/MyADE.app/Contents/MacOS/MyADE", false],
  ])("%s -> %s", (command, expected) => {
    expect(isAdeProcessCommand(command)).toBe(expected);
  });
});

describe("stripAdeShellLines", () => {
  it("removes the desktop's `# ADE CLI` marker and the line after it", () => {
    const raw = 'export FOO=1\n\n# ADE CLI\nexport PATH="$HOME/.local/bin:$PATH"\nalias x=y\n';
    const next = stripAdeShellLines(raw);
    expect(next).not.toBeNull();
    expect(next).not.toContain("# ADE CLI");
    expect(next).not.toContain(".local/bin");
    expect(next).toContain("alias x=y");
    expect(next).toContain("export FOO=1");
  });

  it("removes the installer's `# >>> ade >>>` block, CRLF included", () => {
    const raw = 'one\r\n# >>> ade >>>\r\n. "$HOME/.ade/env"\r\n# <<< ade <<<\r\ntwo\r\n';
    const next = stripAdeShellLines(raw);
    expect(next).not.toBeNull();
    expect(next).not.toContain("ade >>>");
    expect(next).not.toContain("$HOME/.ade/env");
    expect(next?.split(/\r?\n/).map((line) => line.trim())).toContain("one");
    expect(next?.split(/\r?\n/).map((line) => line.trim())).toContain("two");
  });

  it("returns null when there is nothing of ADE's to remove", () => {
    expect(stripAdeShellLines("export FOO=1\nalias x=y\n")).toBeNull();
  });
});

describe("findAdeAncestor", () => {
  const processes: ProcessEntry[] = [
    { pid: 200, ppid: 1, command: "/Applications/ADE.app/Contents/MacOS/ADE" },
    { pid: 300, ppid: 200, command: "/bin/zsh -l" },
    { pid: 500, ppid: 300, command: "node node_modules/vitest/vitest.mjs" },
  ];
  const findDeps = (): MachineResetDeps =>
    defaultMachineResetDeps({
      platform: "darwin",
      selfPid: 500,
      listProcesses: () => processes,
      run: () => ({ status: 1, stdout: "", stderr: "" }),
    });

  it("skips only the allowed pid on the way up the process tree", () => {
    expect(findAdeAncestor(findDeps())?.pid).toBe(200);
    // The desktop that handed the reset off is skipped; nothing above it is ADE.
    expect(findAdeAncestor(findDeps(), { allowPid: 200 })).toBeNull();
    // An allow for an unrelated pid changes nothing.
    expect(findAdeAncestor(findDeps(), { allowPid: 999 })?.pid).toBe(200);
  });
});

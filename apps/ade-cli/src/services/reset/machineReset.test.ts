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
import { desktopDataDirCandidates } from "./machineResetInventory";

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

  it("rescues a detached-HEAD lane's commits instead of deleting them", async () => {
    const { project, deps } = buildFixture();
    // A lane mid-rebase: detached HEAD with a commit no branch or remote holds.
    const lane = path.join(project, ".ade", "worktrees", "detached-lane");
    git(project, ["worktree", "add", "-q", "--detach", lane, "main"]);
    fs.writeFileSync(path.join(lane, "orphan.txt"), "orphan\n");
    git(lane, ["add", "orphan.txt"]);
    git(lane, ["commit", "-qm", "orphan commit"]);
    const orphan = git(lane, ["rev-parse", "HEAD"]).stdout.trim();

    const receipt = await executeMachineReset(
      { rescue: "commit", receiptPath: path.join(deps.tmpDir, "receipt.json") },
      deps,
    );

    const rescued = receipt.rescued.find((entry) => entry.lane === "detached-lane");
    expect(rescued?.branch).toBe("ade-rescue/detached-lane");
    expect(git(project, ["merge-base", "--is-ancestor", orphan, "ade-rescue/detached-lane"]).status).toBe(0);
  });

  it("rescues a detached lane's commits when its folder is already gone", async () => {
    const { project, deps } = buildFixture();
    const lane = path.join(project, ".ade", "worktrees", "gone-lane");
    git(project, ["worktree", "add", "-q", "--detach", lane, "main"]);
    fs.writeFileSync(path.join(lane, "orphan.txt"), "orphan\n");
    git(lane, ["add", "orphan.txt"]);
    git(lane, ["commit", "-qm", "orphan commit"]);
    const orphan = git(lane, ["rev-parse", "HEAD"]).stdout.trim();
    fs.rmSync(lane, { recursive: true, force: true });

    await executeMachineReset(
      { rescue: "commit", receiptPath: path.join(deps.tmpDir, "receipt.json") },
      deps,
    );

    expect(git(project, ["merge-base", "--is-ancestor", orphan, "ade-rescue/gone-lane"]).status).toBe(0);
  });

  it("treats a lane git cannot read as having work, and keeps its branch", async () => {
    const { project, deps } = buildFixture();
    // Git reports worktrees by real path (`/private/var/...` on macOS).
    const cleanLane = path.join(".ade", "worktrees", "clean-lane");
    const brokenStatus: MachineResetDeps = {
      ...deps,
      run: (command, args, options) => {
        if (command === "git" && args[0] === "-C" && args[1]?.endsWith(cleanLane) && args[2] === "status") {
          return { status: 128, stdout: "", stderr: "index.lock exists" };
        }
        return deps.run(command, args, options);
      },
    };

    const receipt = await executeMachineReset(
      { rescue: "commit", receiptPath: path.join(deps.tmpDir, "receipt.json") },
      brokenStatus,
    );

    expect(receipt.rescued.some((entry) => entry.lane === "clean-lane")).toBe(true);
    expect(branchNames(project)).toContain("ade/clean-lane");
  });

  it("reports a clean reset when a failed move is saved by the commit fallback", async () => {
    const { project, deps } = buildFixture();
    const failingMove: MachineResetDeps = {
      ...deps,
      run: (command, args, options) => {
        if (command === "git" && args.includes("worktree") && args.includes("move")) {
          return { status: 1, stdout: "", stderr: "move refused by test" };
        }
        return deps.run(command, args, options);
      },
    };

    const receipt = await executeMachineReset(
      {
        rescue: "move",
        rescueDir: path.join(path.dirname(deps.homeDir), "rescued"),
        receiptPath: path.join(deps.tmpDir, "receipt.json"),
      },
      failingMove,
    );

    expect(receipt.rescued.find((entry) => entry.lane === "dirty-lane")?.mode).toBe("commit");
    expect(receipt.failed).toEqual([]);
    expect(receipt.ok).toBe(true);
    expect(fs.existsSync(path.join(project, ".ade", "worktrees"))).toBe(false);
  });

  it("stops a desktop that does not quit, and never starts while it may still run", async () => {
    // A clock that moves only when the engine sleeps, so the 30 s and 5 s
    // waits pass at once.
    const fakeClock = (): Pick<MachineResetDeps, "now" | "sleep"> => {
      let at = Date.parse("2026-10-01T00:00:00Z");
      return { now: () => new Date(at), sleep: async (ms) => { at += ms; } };
    };
    const desktopPid = 4242;
    const desktop = { pid: desktopPid, ppid: 1, command: "/Applications/ADE.app/Contents/MacOS/ADE" };

    const stoppable = buildFixture();
    let alive = true;
    const signals: string[] = [];
    const receipt = await executeMachineReset(
      { rescue: "none", waitPid: desktopPid, receiptPath: path.join(stoppable.deps.tmpDir, "receipt.json") },
      {
        ...stoppable.deps,
        ...fakeClock(),
        listProcesses: () => (alive ? [desktop] : []),
        pidAlive: (pid) => pid === desktopPid && alive,
        kill: (pid, signal) => {
          signals.push(`${pid}:${signal}`);
          if (pid === desktopPid && signal === "SIGKILL") alive = false;
        },
      },
    );
    expect(signals).toEqual([`${desktopPid}:SIGTERM`, `${desktopPid}:SIGKILL`]);
    expect(receipt.notes.some((note) => note.includes("SIGKILL"))).toBe(true);

    const stuck = buildFixture();
    await expect(
      executeMachineReset(
        { rescue: "none", waitPid: desktopPid, receiptPath: path.join(stuck.deps.tmpDir, "receipt.json") },
        {
          ...stuck.deps,
          ...fakeClock(),
          listProcesses: () => [desktop],
          pidAlive: (pid) => pid === desktopPid,
        },
      ),
    ).rejects.toThrow(/would not quit/);
    expect(fs.existsSync(path.join(stuck.project, ".ade", "ade.db"))).toBe(true);

    // Alive but missing from a process list that failed to read: unknown, so no change.
    const unlisted = buildFixture();
    await expect(
      executeMachineReset(
        { rescue: "none", waitPid: desktopPid, receiptPath: path.join(unlisted.deps.tmpDir, "receipt.json") },
        {
          ...unlisted.deps,
          ...fakeClock(),
          listProcesses: () => [],
          pidAlive: (pid) => pid === desktopPid,
        },
      ),
    ).rejects.toThrow(/could not be read/);
    expect(fs.existsSync(path.join(unlisted.project, ".ade", "ade.db"))).toBe(true);
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

describe("machine reset desktop data dirs", () => {
  it("includes per-lane dev user-data folders", () => {
    const sb = fs.mkdtempSync(path.join(os.tmpdir(), "ade-reset-desktop-"));
    sandboxes.push(sb);
    const home = path.join(sb, "home");
    const appData = path.join(home, "Library", "Application Support");
    for (const name of ["ade-desktop", "ade-desktop-dev", "ade-desktop-dev-lane-1"]) {
      fs.mkdirSync(path.join(appData, name), { recursive: true });
    }
    // A file, not a folder: an `ade-desktop-dev-` prefix is not enough.
    fs.writeFileSync(path.join(appData, "ade-desktop-dev-not-a-folder"), "x");

    const deps = defaultMachineResetDeps({ platform: "darwin", homeDir: home, env: {} });
    const candidates = desktopDataDirCandidates(deps);

    expect(candidates).toContain(path.join(appData, "ade-desktop"));
    expect(candidates).toContain(path.join(appData, "ade-desktop-dev"));
    expect(candidates).toContain(path.join(appData, "ade-desktop-dev-lane-1"));
    expect(candidates).not.toContain(path.join(appData, "ade-desktop-dev-not-a-folder"));
  });
});

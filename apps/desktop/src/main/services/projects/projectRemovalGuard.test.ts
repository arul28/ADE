import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { summarizeCopyWork, type ProjectCopyCheckoutState, type ProjectCopyState } from "../../../shared/projectRemoval";
import { decideProjectFolderDeletion, decideRemovalRecheck, projectCopyStateToken } from "./projectRemovalGuard";
import { readProjectCopyState } from "./projectRemovalState";
import { createProjectCopyRemoval } from "../../../../../ade-cli/src/services/projects/projectCopyRemoval";

describe("decideProjectFolderDeletion", () => {
  const posix = {
    homeDir: "/Users/me",
    adeHome: "/Users/me/.ade",
    runtimePaths: ["/Applications/ADE.app/Contents/MacOS/ADE"],
    platform: "darwin" as const,
  };
  const win = {
    homeDir: "C:\\Users\\me",
    adeHome: "C:\\Users\\me\\.ade",
    runtimePaths: ["C:\\Program Files\\ADE\\ADE.exe"],
    platform: "win32" as const,
  };

  it.each([
    { name: "a registered project", base: posix, target: "/Users/me/code/app", roots: ["/Users/me/code/app"], ok: true },
    { name: "case-insensitive match on macOS", base: posix, target: "/users/ME/code/app", roots: ["/Users/me/code/app"], ok: true },
    { name: "a folder that is not registered", base: posix, target: "/Users/me/code/other", roots: ["/Users/me/code/app"], ok: false },
    { name: "a filesystem root", base: posix, target: "/", roots: ["/"], ok: false },
    { name: "a macOS volume root", base: posix, target: "/Volumes/Dev", roots: ["/Volumes/Dev"], ok: false },
    { name: "a project on a volume", base: posix, target: "/Volumes/Dev/app", roots: ["/Volumes/Dev/app"], ok: true },
    { name: "a Linux media mount", base: { ...posix, platform: "linux" as const }, target: "/media/me/usb", roots: ["/media/me/usb"], ok: false },
    { name: "one level below the top", base: posix, target: "/opt", roots: ["/opt"], ok: false },
    { name: "the home folder", base: { ...posix, adeHome: "/opt/ade-home" }, target: "/Users/me", roots: ["/Users/me"], ok: false },
    { name: "a folder beside the home folder", base: posix, target: "/Users/x", roots: ["/Users/x"], ok: true },
    { name: "the ADE home", base: posix, target: "/Users/me/.ade", roots: ["/Users/me/.ade"], ok: false },
    { name: "inside the ADE home", base: posix, target: "/Users/me/.ade/projects/x", roots: ["/Users/me/.ade/projects/x"], ok: false },
    {
      name: "a folder that holds another project",
      base: posix,
      target: "/Users/me/code",
      roots: ["/Users/me/code", "/Users/me/code/app"],
      ok: false,
    },
    {
      name: "a project inside another project (the inner one)",
      base: posix,
      target: "/Users/me/code/app",
      roots: ["/Users/me/code", "/Users/me/code/app"],
      ok: true,
    },
    {
      name: "the folder ADE runs from",
      base: { ...posix, runtimePaths: ["/Users/me/code/ade/apps/ade-cli/dist/cli.cjs"] },
      target: "/Users/me/code/ade",
      roots: ["/Users/me/code/ade"],
      ok: false,
    },
    { name: "a sibling with a shared prefix", base: posix, target: "/Users/me/code/app-old", roots: ["/Users/me/code/app-old", "/Users/me/code/app"], ok: true },
    { name: "a Windows project at the drive's first level", base: win, target: "D:\\repo", roots: ["D:\\repo"], ok: true },
    { name: "a Windows drive root", base: win, target: "D:\\", roots: ["D:\\"], ok: false },
    { name: "a Windows system folder", base: win, target: "C:\\Users", roots: ["C:\\Users"], ok: false },
    { name: "a Windows path in other case and slashes", base: win, target: "c:/users/me/code/app", roots: ["C:\\Users\\me\\code\\app"], ok: true },
    { name: "a Windows UNC share root", base: win, target: "\\\\server\\share\\", roots: ["\\\\server\\share"], ok: false },
  ])("$name", ({ base, target, roots, ok }) => {
    const decision = decideProjectFolderDeletion({ ...base, target, registeredRoots: roots });
    expect(decision.ok).toBe(ok);
  });
});

describe("decideRemovalRecheck", () => {
  const checkout = (overrides: Partial<ProjectCopyCheckoutState> = {}): ProjectCopyCheckoutState => ({
    path: "/Users/me/code/app",
    isMain: true,
    insideProject: true,
    branch: "main",
    changedFiles: 0,
    unpushedCommits: 0,
    ignoredEnvFiles: [],
    hasSubmodules: false,
    fingerprint: "work",
    ...overrides,
  });
  const state = (overrides: Partial<ProjectCopyState> = {}): ProjectCopyState => ({
    rootPath: "/Users/me/code/app",
    folder: "present",
    isGitRepo: true,
    checkouts: [checkout()],
    stashes: 0,
    unpushedOnBranches: 0,
    sessions: { chats: 0, terminals: 0 },
    unreadable: [],
    fingerprint: "branches",
    ...overrides,
  });
  const clean = state();
  const dirty = state({ checkouts: [checkout({ changedFiles: 3 })] });
  const dirtier = state({ checkouts: [checkout({ changedFiles: 4 })] });
  const withEnv = state({ checkouts: [checkout({ ignoredEnvFiles: [".env"] })] });
  const withMoreEnv = state({ checkouts: [checkout({ ignoredEnvFiles: [".env", ".env.local"] })] });
  const envOutside = state({
    checkouts: [checkout(), checkout({ path: "/Users/me/lanes/a", isMain: false, insideProject: false, ignoredEnvFiles: [".env"] })],
  });

  it.each([
    { name: "a clean copy, not accepted", shown: clean, current: clean, accept: false, expected: "ok" },
    { name: "a copy that became clean", shown: dirty, current: clean, accept: false, expected: "ok" },
    { name: "a copy with work, not accepted", shown: dirty, current: dirty, accept: false, expected: "unsaved_work" },
    { name: "a copy with work, accepted as shown", shown: dirty, current: dirty, accept: true, expected: "ok" },
    { name: "work that changed after it was accepted", shown: dirty, current: dirtier, accept: true, expected: "changed" },
    { name: "work that changed with the same counts", shown: dirty, current: state({ checkouts: [checkout({ changedFiles: 3, fingerprint: "edited again" })] }), accept: true, expected: "changed" },
    { name: "work that appeared after a clean report", shown: clean, current: dirty, accept: false, expected: "unsaved_work" },
    { name: "work that appeared, with acceptance sent", shown: clean, current: dirty, accept: true, expected: "changed" },
    { name: "a session that started", shown: clean, current: state({ sessions: { chats: 0, terminals: 1 } }), accept: true, expected: "work_running" },
    { name: "a chat running on a copy with accepted work", shown: dirty, current: { ...dirty, sessions: { chats: 1, terminals: 0 } }, accept: true, expected: "work_running" },
    { name: "a stash", shown: clean, current: state({ stashes: 1 }), accept: false, expected: "unsaved_work" },
    { name: "commits on a branch with no upstream", shown: clean, current: state({ unpushedOnBranches: 2 }), accept: false, expected: "unsaved_work" },
    { name: "a detached HEAD with commits", shown: clean, current: state({ checkouts: [checkout({ branch: null, unpushedCommits: 1 })] }), accept: false, expected: "unsaved_work" },
    { name: "state git could not read", shown: clean, current: state({ stashes: null }), accept: false, expected: "unsaved_work" },
    { name: "submodules", shown: clean, current: state({ checkouts: [checkout({ hasSubmodules: true })] }), accept: false, expected: "unsaved_work" },
    { name: "a folder that is not a git repository", shown: clean, current: state({ isGitRepo: false, checkouts: [] }), accept: false, expected: "unsaved_work" },
    { name: "files Git ignores, not accepted", shown: withEnv, current: withEnv, accept: false, expected: "unsaved_work" },
    { name: "a file Git ignores that appeared after acceptance", shown: withEnv, current: withMoreEnv, accept: true, expected: "changed" },
    { name: "files Git ignores in a lane outside the folder", shown: envOutside, current: envOutside, accept: false, expected: "ok" },
  ])("$name", ({ shown, current, accept, expected }) => {
    const decision = decideRemovalRecheck({
      current,
      currentToken: projectCopyStateToken(current),
      shownToken: projectCopyStateToken(shown),
      acceptWork: accept,
    });
    expect(decision.ok ? "ok" : decision.code).toBe(expected);
  });
});

describe("readProjectCopyState", () => {
  // `git ls-files --directory` lists an ignored folder as one line: the
  // secrets inside it must still reach the removal report, by name.
  it("names the secret files inside an ignored folder, and skips dependency folders", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-removal-state-"));
    try {
      const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
      git("init");
      fs.writeFileSync(path.join(root, ".gitignore"), "config/\nnode_modules/\n.env\n", "utf8");
      git("add", ".gitignore");
      git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-m", "init");
      for (const [rel, text] of [
        [".env", "A=1"],
        ["config/.env.production", "B=2"],
        ["config/deep/server.pem", "KEY"],
        ["config/notes.txt", "plain"],
        ["node_modules/pkg/.env", "C=3"],
      ] as const) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), text, "utf8");
      }
      const state = await readProjectCopyState(root, { chats: 0, terminals: 0 });
      const main = state.checkouts.find((checkout) => checkout.isMain)!;
      expect([...main.ignoredEnvFiles].sort()).toEqual([".env", "config/.env.production", "config/deep/server.pem"]);
      expect(summarizeCopyWork(state).summary).toContain("config/deep/server.pem");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("removing a project copy with its folder", () => {
  // The brain's `projects.removeCopy`: the copy is read again and checked
  // against the report the person accepted BEFORE the project stops and the
  // folder goes. A copy that changed since keeps its folder and its entry.
  type Git = (...args: string[]) => void;
  type Step = ((folder: string, git: Git) => void) | null;
  const commit = (git: Git, ...args: string[]) => git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", ...args);
  const write = (folder: string, text: string, seconds: number) => {
    fs.writeFileSync(path.join(folder, "a.txt"), text, "utf8");
    fs.utimesSync(path.join(folder, "a.txt"), seconds, seconds);
  };
  it.each<[string, Step, Step, string]>([
    ["keeps the folder and the entry when the copy changed after the report", null, (folder) => write(folder, "edited after the report\n", 1_700_000_100), "refused:changed"],
    ["deletes the folder, then drops the entry, when the copy is as reported", null, null, "removed:deleted"],
    // The counts stay the same: one changed file, one commit no remote has.
    ["keeps the folder when a file that was already changed changes again", (folder) => write(folder, "first edit\n", 1_700_000_000), (folder) => write(folder, "other edit\n", 1_700_000_100), "refused:changed"],
    ["keeps the folder when a commit no remote has is amended", (_folder, git) => commit(git, "--allow-empty", "-m", "local"), (_folder, git) => commit(git, "--amend", "--allow-empty", "-m", "local, amended"), "refused:changed"],
    ["deletes a copy with work when the work is as reported", (folder) => write(folder, "first edit\n", 1_700_000_000), null, "removed:deleted"],
  ])("%s", async (_label, beforeReport, afterReport, outcome) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ade-removal-copy-")));
    const folder = path.join(root, "app");
    fs.mkdirSync(folder);
    try {
      const git = (...args: string[]) => execFileSync("git", args, { cwd: folder, stdio: "ignore" });
      git("init");
      fs.writeFileSync(path.join(folder, "a.txt"), "a\n", "utf8");
      git("add", "a.txt");
      commit(git, "-m", "init");
      beforeReport?.(folder, git);
      const record = {
        projectId: "project-1", rootPath: folder, displayName: "app", addedAt: 0, lastOpenedAt: 0,
        gitOriginUrl: null, catalogVisibility: "visible", registrationSource: "user",
      };
      let entries = [record];
      const steps: string[] = [];
      const removal = createProjectCopyRemoval({
        projectRegistry: {
          get: (id: string) => entries.find((entry) => entry.projectId === id) ?? null,
          list: () => entries,
          remove: (id: string) => {
            steps.push(`forget:${fs.existsSync(folder) ? "folder present" : "folder gone"}`);
            entries = entries.filter((entry) => entry.projectId !== id);
            return true;
          },
        } as never,
        scopeRegistry: { getIfBooted: () => null } as never,
        stopProject: async () => { steps.push("stop"); },
        adeHome: null,
      });
      const report = await removal.inspect("project-1" as never);
      afterReport?.(folder, git);

      const result = await removal.remove("project-1" as never, { deleteFolder: true, stateToken: report.stateToken, acceptWork: true }, "delete");

      expect(result.status === "refused" ? `refused:${result.code}` : `${result.status}:${"folder" in result ? result.folder : ""}`).toBe(outcome);
      if (outcome.startsWith("refused")) {
        expect(fs.existsSync(path.join(folder, "a.txt"))).toBe(true);
        expect(entries).toEqual([record]);
        expect(steps).toEqual([]);
      } else {
        expect(fs.existsSync(folder)).toBe(false);
        expect(entries).toEqual([]);
        expect(steps).toEqual(["stop", "forget:folder gone"]);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

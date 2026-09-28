import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LaneSummary } from "../../../shared/types/lanes";
import type { CloudAgentLaunchArgs } from "../../../shared/types/cloudAgents";
import type { DevinCloudDirectoryEntry } from "./devinCloudDirectory";
import { createCloudAgentsService, type CloudAgentsServiceDeps } from "./cloudAgentsService";

const git = vi.hoisted(() => ({ runGit: vi.fn() }));
vi.mock("../git/git", () => ({ runGit: git.runGit }));

const originUrl = "https://github.com/acme/project.git";
const launchArgs: CloudAgentLaunchArgs = { provider: "devin", prompt: "Fix the bug", laneId: "cloud-lane" };

function lane(id = "cloud-lane", branchRef = "devin/work", laneType: LaneSummary["laneType"] = "worktree") {
  return {
    id,
    name: id,
    laneType,
    branchRef,
    worktreePath: `/tmp/${id}`,
    tags: laneType === "primary" ? [] : ["ade:cloud:devin"],
  } as LaneSummary;
}

function entry(overrides: Partial<DevinCloudDirectoryEntry> = {}): DevinCloudDirectoryEntry {
  return {
    id: "abc123",
    title: "Fix the bug",
    status: "idle",
    statusText: "Waiting",
    unread: false,
    url: null,
    repos: ["acme/project"],
    pullRequests: [],
    model: "devin-swe-2-low",
    platform: "linux",
    origin: "ADE",
    excerpt: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function fixture() {
  const lanes = {
    list: vi.fn().mockResolvedValue([lane()]),
    importBranch: vi.fn().mockResolvedValue(lane("imported", "devin/pr")),
    create: vi.fn().mockResolvedValue(lane("created", "devin/new")),
    updateAppearance: vi.fn(),
  };
  const chats = {
    list: vi.fn().mockResolvedValue([]),
    openDevinCloudChat: vi.fn().mockResolvedValue({ sessionId: "chat-1" }),
    openCursorCloudChat: vi.fn().mockResolvedValue({ sessionId: "chat-1" }),
    interrupt: vi.fn().mockResolvedValue(undefined),
    createDevinCloudChat: vi.fn().mockResolvedValue({ id: "chat-1" }),
    send: vi.fn().mockResolvedValue(undefined),
  };
  const directory = {
    list: vi.fn().mockResolvedValue([]),
    find: vi.fn().mockResolvedValue(entry()),
    cancel: vi.fn().mockResolvedValue(undefined),
    archive: vi.fn().mockResolvedValue(undefined),
    invalidate: vi.fn(),
  };
  const deps = {
    projectRoot: "/tmp/project",
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    devinDirectory: directory,
    cursorFleet: null,
    lanes,
    chats,
  } as unknown as CloudAgentsServiceDeps;
  return { service: createCloudAgentsService(deps), lanes, chats, directory };
}

beforeEach(() => {
  git.runGit.mockReset();
  git.runGit.mockImplementation(async (args: string[]) => {
    if (args[0] === "remote") return { exitCode: 0, stdout: originUrl, stderr: "" };
    if (args[0] === "symbolic-ref") return { exitCode: 0, stdout: "origin/main", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  });
});

describe("cloud agent lane ownership", () => {
  it("refuses to move the primary lane to a cloud", async () => {
    const { service, lanes, chats } = fixture();
    lanes.list.mockResolvedValue([lane("primary", "main", "primary")]);

    await expect(service.launch({ ...launchArgs, laneId: "primary" })).rejects.toThrow(/primary lane can't move/);
    expect(chats.createDevinCloudChat).not.toHaveBeenCalled();
  });

  it.each([
    { status: "active", devinSessionId: "abc123", startedAt: "2020-01-01T00:00:00.000Z", blocked: true },
    { status: "idle", devinSessionId: null, startedAt: new Date().toISOString(), blocked: true },
    { status: "ended", devinSessionId: null, startedAt: new Date().toISOString(), blocked: false },
  ])("handles an existing $status chat before launch", async ({ status, devinSessionId, startedAt, blocked }) => {
    const { service, chats } = fixture();
    chats.list.mockResolvedValue([{ laneId: "cloud-lane", status, devinSessionId, startedAt,
      devinCloud: { transport: "acp", version: "devin-swe-2-low" } }]);

    if (blocked) {
      await expect(service.launch(launchArgs)).rejects.toThrow(/already working in this lane/);
      expect(chats.createDevinCloudChat).not.toHaveBeenCalled();
    } else {
      await expect(service.launch(launchArgs)).resolves.toMatchObject({ laneId: "cloud-lane" });
    }
  });

  it("rejects a concurrent launch into the same lane before either chat has a session id", async () => {
    const { service, chats } = fixture();
    let release!: (value: { id: string }) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    chats.createDevinCloudChat.mockImplementation(() => new Promise((resolve) => { release = resolve; entered(); }));
    const first = service.launch(launchArgs);
    await started;
    await expect(service.launch(launchArgs)).rejects.toThrow(/already working in this lane/);
    release({ id: "chat-1" });
    await expect(first).resolves.toMatchObject({ chatSessionId: "chat-1" });
    expect(chats.createDevinCloudChat).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight open of the same Devin session", async () => {
    const { service, directory, chats } = fixture();
    let release!: (value: DevinCloudDirectoryEntry) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    directory.find.mockImplementation(() => new Promise((resolve) => { release = resolve; entered(); }));
    const first = service.open({ provider: "devin", id: "abc123" });
    await started;
    const second = service.open({ provider: "devin", id: "devin-abc123" });
    release(entry());
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ chatSessionId: "chat-1" }),
      expect.objectContaining({ chatSessionId: "chat-1" }),
    ]);
    expect(directory.find).toHaveBeenCalledTimes(1);
    expect(chats.openDevinCloudChat).toHaveBeenCalledTimes(1);
  });

  it("never imports a PR branch from another repository", async () => {
    const { service, directory, lanes } = fixture();
    directory.find.mockResolvedValue(entry({
      repos: ["someone/else"],
      pullRequests: [{ url: "https://github.com/someone/else/pull/3", number: 3, state: "open", title: null,
        headRef: "foreign-branch", baseRef: "main", additions: null, deletions: null }],
    }));

    await expect(service.open({ provider: "devin", id: "abc123" })).rejects.toThrow(/not this project/);
    expect(lanes.importBranch).not.toHaveBeenCalled();
    expect(lanes.create).not.toHaveBeenCalled();
  });

  it("makes a fresh lane when the PR branch is held by the primary or an archived lane", async () => {
    const { service, directory, lanes, chats } = fixture();
    directory.find.mockResolvedValue(entry({ pullRequests: [{
      url: "https://github.com/acme/project/pull/3", number: 3, state: "open", title: null,
      headRef: "main", baseRef: "main", additions: null, deletions: null,
    }] }));
    lanes.list.mockResolvedValue([lane("primary", "main", "primary")]);
    lanes.importBranch.mockRejectedValue(new Error("branch already exists"));

    await expect(service.open({ provider: "devin", id: "abc123" })).resolves.toMatchObject({
      laneId: "created", createdLane: true,
    });
    expect(chats.openDevinCloudChat).toHaveBeenCalledWith(expect.objectContaining({ laneId: "created" }));
  });

  it.each([
    { outcome: "behind", stderr: "non-fast-forward", ancestor: true, launches: true, failure: null },
    { outcome: "diverged", stderr: "non-fast-forward", ancestor: false, launches: false, failure: /diverged from origin/ },
    { outcome: "push denied", stderr: "permission denied", ancestor: false, launches: false, failure: /Could not push/ },
  ])("handles a $outcome branch push before launch", async ({ stderr, ancestor, launches, failure }) => {
    const { service, chats } = fixture();
    git.runGit.mockImplementation(async (args: string[]) => {
      if (args[0] === "remote") return { exitCode: 0, stdout: originUrl, stderr: "" };
      if (args[0] === "symbolic-ref") return { exitCode: 0, stdout: "origin/main", stderr: "" };
      if (args[0] === "push") return { exitCode: 1, stdout: "", stderr };
      if (args[0] === "fetch") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "rev-parse") return { exitCode: 0, stdout: "a".repeat(40), stderr: "" };
      if (args[0] === "merge-base") return { exitCode: ancestor ? 0 : 1, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    if (launches) {
      await expect(service.launch(launchArgs)).resolves.toMatchObject({ laneId: "cloud-lane" });
      expect(git.runGit).toHaveBeenCalledWith(["merge-base", "--is-ancestor", "HEAD", "a".repeat(40)], expect.anything());
    } else {
      await expect(service.launch(launchArgs)).rejects.toThrow(failure!);
      expect(chats.createDevinCloudChat).not.toHaveBeenCalled();
    }
  });

  it("rejects malformed Devin ids before asking the relay to open them", async () => {
    const { service, directory } = fixture();
    await expect(service.open({ provider: "devin", id: "abc; touch /tmp/unsafe" })).rejects.toThrow();
    expect(directory.find).not.toHaveBeenCalled();
  });
});

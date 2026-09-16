import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCliPlan } from "./cli";
import { CursorCloudUsageError, parseCursorCloudCommand, runCursorCloud } from "./cursorCloud";

const cursorModelsListMock = vi.hoisted(() => vi.fn());
const cursorAgentListMock = vi.hoisted(() => vi.fn());
const cursorAgentListRunsMock = vi.hoisted(() => vi.fn());
const cursorAgentCreateMock = vi.hoisted(() => vi.fn());
const cursorAgentResumeMock = vi.hoisted(() => vi.fn());
const cursorAgentArchiveMock = vi.hoisted(() => vi.fn());
const cursorAgentUnarchiveMock = vi.hoisted(() => vi.fn());
const cursorRepositoriesListMock = vi.hoisted(() => vi.fn());
const cursorMeMock = vi.hoisted(() => vi.fn());

vi.mock("@cursor/sdk", () => ({
  Cursor: {
    models: {
      list: (...args: unknown[]) => cursorModelsListMock(...args),
    },
    repositories: {
      list: (...args: unknown[]) => cursorRepositoriesListMock(...args),
    },
    me: (...args: unknown[]) => cursorMeMock(...args),
  },
  Agent: {
    list: (...args: unknown[]) => cursorAgentListMock(...args),
    listRuns: (...args: unknown[]) => cursorAgentListRunsMock(...args),
    create: (...args: unknown[]) => cursorAgentCreateMock(...args),
    resume: (...args: unknown[]) => cursorAgentResumeMock(...args),
    archive: (...args: unknown[]) => cursorAgentArchiveMock(...args),
    unarchive: (...args: unknown[]) => cursorAgentUnarchiveMock(...args),
  },
}));

function makeRun(id = "run-1") {
  return {
    id,
    stream: async function* () {
      yield { type: "status", status: "finished" };
    },
    wait: vi.fn().mockResolvedValue({ status: "finished", durationMs: 12, result: "done" }),
  };
}

function makeAgent(agentId = "bc-1") {
  return {
    agentId,
    send: vi.fn().mockResolvedValue(makeRun()),
    listArtifacts: vi.fn().mockResolvedValue([{ path: "dist/report.zip", sizeBytes: 7 }]),
    downloadArtifact: vi.fn().mockResolvedValue(Buffer.from("report")),
    close: vi.fn(),
    [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
  };
}

afterEach(() => {
  cursorModelsListMock.mockReset();
  cursorAgentListMock.mockReset();
  cursorAgentListRunsMock.mockReset();
  cursorAgentCreateMock.mockReset();
  cursorAgentResumeMock.mockReset();
  cursorAgentArchiveMock.mockReset();
  cursorAgentUnarchiveMock.mockReset();
  cursorRepositoriesListMock.mockReset();
  cursorMeMock.mockReset();
});

describe("ADE CLI cursor cloud surface", () => {
  it("routes 'cursor cloud' to a cursor-cloud plan", () => {
    const plan = buildCliPlan(["cursor", "cloud", "agents", "list", "--archived"]);
    expect(plan.kind).toBe("cursor-cloud");
    if (plan.kind !== "cursor-cloud") return;
    expect(plan.rest).toEqual(["agents", "list", "--archived"]);
  });

  it("renders top-level cursor help via --help", () => {
    const plan = buildCliPlan(["cursor", "--help"]);
    expect(plan.kind).toBe("help");
    if (plan.kind !== "help") return;
    expect(plan.text).toContain("Cursor Cloud");
    expect(plan.text).toContain("ade cursor cloud agents");
  });

  it("renders group-level cursor help via --help", () => {
    const plan = buildCliPlan(["cursor", "cloud", "agents", "--help"]);
    expect(plan.kind).toBe("help");
    if (plan.kind !== "help") return;
    expect(plan.text).toContain("Cursor Cloud: agents");
  });

  it("resolves help via 'help cursor cloud runs' too", () => {
    const plan = buildCliPlan(["help", "cursor", "cloud", "runs"]);
    expect(plan.kind).toBe("help");
    if (plan.kind !== "help") return;
    expect(plan.text).toContain("Cursor Cloud: runs");
  });

  it("rejects an unknown ade cursor surface", () => {
    expect(() => buildCliPlan(["cursor", "local", "agents", "list"])).toThrow(/'ade cursor' surface 'local'/);
  });
});

describe("parseCursorCloudCommand", () => {
  it("normalizes plural and singular group aliases", () => {
    const parsed = parseCursorCloudCommand(["agents", "list"]);
    expect(parsed?.group).toBe("agents");
    expect(parsed?.sub).toBe("list");

    const singular = parseCursorCloudCommand(["repo", "list"]);
    expect(singular?.group).toBe("repos");
  });

  it("defaults runtime sub to 'list' when missing", () => {
    const parsed = parseCursorCloudCommand(["agents"]);
    expect(parsed?.group).toBe("agents");
    expect(parsed?.sub).toBe("list");
  });

  it("does not treat an option value as a missing default subcommand", () => {
    expect(parseCursorCloudCommand(["agents", "--limit", "100"])).toEqual({
      group: "agents",
      sub: "list",
      rest: ["--limit", "100"],
    });
    expect(parseCursorCloudCommand(["runs", "--agent", "bc-1"])).toEqual({
      group: "runs",
      sub: "list",
      rest: ["--agent", "bc-1"],
    });
  });

  it("handles 'me' as a single-shot group", () => {
    const parsed = parseCursorCloudCommand(["me"]);
    expect(parsed?.group).toBe("me");
    expect(parsed?.sub).toBe("show");
  });

  it("rejects an unknown group", () => {
    expect(() => parseCursorCloudCommand(["bogus", "list"])).toThrow(CursorCloudUsageError);
  });
});

describe("runCursorCloud", () => {
  it("renders current Cursor SDK model list entries in text mode", async () => {
    cursorModelsListMock.mockResolvedValue([
      { id: "cursor/claude-sonnet-5", displayName: "Claude Sonnet 5" },
      { model: { id: "legacy/composer" }, displayName: "Legacy Composer" },
      { id: "claude-4-sonnet-thinking" },
    ]);

    const result = await runCursorCloud(["models", "list"], "text");

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Claude Sonnet 5 (cursor/claude-sonnet-5)");
    expect(result.output).toContain("Legacy Composer (legacy/composer)");
    expect(result.output).toContain("Claude 4 Sonnet Thinking (claude-4-sonnet-thinking)");
    expect(cursorModelsListMock).toHaveBeenCalledWith({ apiKey: undefined });
  });

  it("pages Cursor Cloud agents at the API's 100-item cap and returns every page", async () => {
    cursorAgentListMock
      .mockResolvedValueOnce({
        items: [{ agentId: "bc-page-1", name: "First agent" }],
        nextCursor: "page-2",
      })
      .mockResolvedValueOnce({
        items: [{ agentId: "bc-page-2", name: "Second agent" }],
      });

    const result = await runCursorCloud(["agents", "list", "--limit", "101"], "json");

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("bc-page-1");
    expect(result.output).toContain("bc-page-2");
    expect(cursorAgentListMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ runtime: "cloud", limit: 100 }),
    );
    expect(cursorAgentListMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ runtime: "cloud", limit: 100, cursor: "page-2" }),
    );
  });

  it("creates a cloud agent with the selected repo, branch, model, and PR options", async () => {
    const agent = makeAgent();
    cursorAgentCreateMock.mockResolvedValue(agent);

    const result = await runCursorCloud([
      "agents", "create",
      "--repo", "https://github.com/owner/repo",
      "--prompt", "fix flaky test",
      "--branch", "main",
      "--model", "cursor/grok-4.6",
      "--pr-url", "https://github.com/owner/repo/pull/7",
      "--auto-pr",
    ], "json");

    expect(cursorAgentCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      model: { id: "cursor/grok-4.6" },
      cloud: expect.objectContaining({
        repos: [{
          url: "https://github.com/owner/repo",
          startingRef: "main",
          prUrl: "https://github.com/owner/repo/pull/7",
        }],
        autoCreatePR: true,
        skipReviewerRequest: true,
      }),
    }));
    expect(agent.send).toHaveBeenCalledWith("fix flaky test", { model: { id: "cursor/grok-4.6" } });
    expect(JSON.parse(result.output)).toEqual(expect.objectContaining({
      agentId: "bc-1",
      runId: "run-1",
      status: "finished",
    }));
  });

  it("resumes a cloud agent for a follow-up and disposes the SDK handle", async () => {
    const agent = makeAgent("bc-follow-up");
    cursorAgentResumeMock.mockResolvedValue(agent);

    const result = await runCursorCloud([
      "agents", "follow-up", "--agent", "bc-follow-up", "--prompt", "address review comments",
    ], "json");

    expect(cursorAgentResumeMock).toHaveBeenCalledWith("bc-follow-up", { apiKey: undefined });
    expect(agent.send).toHaveBeenCalledWith("address review comments", undefined);
    expect(agent[Symbol.asyncDispose]).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.output)).toEqual(expect.objectContaining({ agentId: "bc-follow-up" }));
  });

  it("archives and unarchives an agent through the Cursor API", async () => {
    const archived = await runCursorCloud(["agents", "archive", "--agent", "bc-1"], "json");
    const unarchived = await runCursorCloud(["agents", "unarchive", "--agent", "bc-1"], "json");
    expect(JSON.parse(archived.output)).toEqual({ ok: true, agentId: "bc-1", action: "archive" });
    expect(JSON.parse(unarchived.output)).toEqual({ ok: true, agentId: "bc-1", action: "unarchive" });
    expect(cursorAgentArchiveMock).toHaveBeenCalledWith("bc-1", { apiKey: undefined });
    expect(cursorAgentUnarchiveMock).toHaveBeenCalledWith("bc-1", { apiKey: undefined });
  });

  it("pages cloud runs at the API's 100-item cap", async () => {
    cursorAgentListRunsMock
      .mockResolvedValueOnce({ items: [{ id: "run-page-1", status: "finished" }], nextCursor: "page-2" })
      .mockResolvedValueOnce({ items: [{ id: "run-page-2", status: "running" }] });

    const result = await runCursorCloud(["runs", "list", "--agent", "bc-1", "--limit", "101"], "json");

    expect(result.output).toContain("run-page-1");
    expect(result.output).toContain("run-page-2");
    expect(cursorAgentListRunsMock).toHaveBeenNthCalledWith(
      1,
      "bc-1",
      expect.objectContaining({ runtime: "cloud", limit: 100 }),
    );
    expect(cursorAgentListRunsMock).toHaveBeenNthCalledWith(
      2,
      "bc-1",
      expect.objectContaining({ runtime: "cloud", limit: 100, cursor: "page-2" }),
    );
  });

  it("lists and downloads cloud artifacts", async () => {
    const agent = makeAgent();
    cursorAgentResumeMock.mockResolvedValue(agent);

    await expect(runCursorCloud(["artifacts", "list", "--agent", "bc-1"], "text"))
      .resolves.toMatchObject({ exitCode: 0, output: expect.stringContaining("dist/report.zip") });
    const downloaded = await runCursorCloud([
      "artifacts", "download", "--agent", "bc-1", "--path", "dist/report.zip",
    ], "json");
    expect(JSON.parse(downloaded.output)).toEqual(expect.objectContaining({
      path: "dist/report.zip",
      sizeBytes: 6,
      base64: Buffer.from("report").toString("base64"),
    }));
    expect(agent.downloadArtifact).toHaveBeenCalledWith("dist/report.zip");
  });

  it("returns repository and account metadata in text mode", async () => {
    cursorRepositoriesListMock.mockResolvedValue([{ url: "https://github.com/owner/repo" }]);
    cursorMeMock.mockResolvedValue({ apiKeyName: "ade-key", userEmail: "dev@example.com" });

    await expect(runCursorCloud(["repos", "list"], "text"))
      .resolves.toMatchObject({ exitCode: 0, output: expect.stringContaining("https://github.com/owner/repo") });
    await expect(runCursorCloud(["me"], "text"))
      .resolves.toMatchObject({ exitCode: 0, output: expect.stringContaining("ade-key") });
    expect(cursorRepositoriesListMock).toHaveBeenCalledWith({ apiKey: undefined });
    expect(cursorMeMock).toHaveBeenCalledWith({ apiKey: undefined });
  });
});

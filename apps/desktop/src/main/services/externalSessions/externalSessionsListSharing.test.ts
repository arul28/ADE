import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExternalSessionsService } from "./externalSessionsService";
import { EXTERNAL_SESSION_PROVIDERS } from "../../../shared/types/externalSessions";

let root: string;
let previousAdeHome: string | undefined;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ade-list-sharing-")));
  fs.mkdirSync(path.join(root, "repo"), { recursive: true });
  previousAdeHome = process.env.ADE_HOME;
  process.env.ADE_HOME = path.join(root, "ade-home");
});

afterEach(() => {
  if (previousAdeHome === undefined) delete process.env.ADE_HOME;
  else process.env.ADE_HOME = previousAdeHome;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("externalSessionsService list sharing", () => {
  it("runs the machine-wide process scan once for a burst of per-provider calls, and again for the next call", async () => {
    const inspectLiveSessions = vi.fn(async () => ({
      availability: { available: true as const, method: "lsof" as const },
      byKey: new Map(),
    }));
    const sessionsList = vi.fn(() => []);
    const service = createExternalSessionsService({
      projectRoot: path.join(root, "repo"),
      homeDir: path.join(root, "home"),
      env: { PATH: "" },
      droidForkSupported: true,
      laneService: { getLaneWorktreePath: () => path.join(root, "repo"), list: () => [] },
      sessionService: { list: sessionsList, listClaudeSessionPointers: () => [] },
      ptyService: { create: vi.fn() },
      logger: { warn: vi.fn(), info: vi.fn() },
      inspectLiveSessions,
    });
    const providers = EXTERNAL_SESSION_PROVIDERS.filter((provider) => provider !== "opencode");

    await Promise.all(providers.map((provider) => service.list({ providers: [provider], scope: "project" })));
    expect(inspectLiveSessions).toHaveBeenCalledTimes(1);
    expect(sessionsList).toHaveBeenCalledTimes(1);

    // Settled: the next call reads fresh state.
    await service.list({ providers: ["claude"], scope: "project" });
    expect(inspectLiveSessions).toHaveBeenCalledTimes(2);
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  parseOrphanedAdeAgentProcesses,
  recoverOrphanedAdeAgentProcesses,
} from "./orphanedAgentProcessReaper";

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

describe("orphanedAgentProcessReaper", () => {
  it("parses orphaned ADE Codex exec workers only", () => {
    const stdout = [
      " 19097 1 15207 node /Users/arul/ADE/.ade/worktrees/lane/apps/desktop/node_modules/.bin/codex exec --experimental-json -m gpt-5",
      " 19121 19097 15207 /Users/arul/ADE/.ade/worktrees/lane/apps/desktop/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex exec --experimental-json",
      " 20000 1 20000 node /Users/arul/ADE/apps/desktop/node_modules/.bin/vitest run",
      " 20001 1 20001 node /Users/arul/Other/.ade/worktrees/lane/node_modules/.bin/codex exec",
    ].join("\n");

    expect(parseOrphanedAdeAgentProcesses(stdout)).toEqual([
      expect.objectContaining({ pid: 19097, ppid: 1, pgid: 15207 }),
      expect.objectContaining({ pid: 20001, ppid: 1, pgid: 20001 }),
    ]);
  });

  it("terminates each orphaned process group once", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, {
        stdout: [
          " 19097 1 15207 node /Users/arul/ADE/.ade/worktrees/lane/apps/desktop/node_modules/.bin/codex exec --experimental-json",
          " 19121 1 15207 /Users/arul/ADE/.ade/worktrees/lane/apps/desktop/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex exec --experimental-json",
        ].join("\n"),
      });
    });
    const processKill = vi.fn(() => true);
    const logger = { warn: vi.fn() };

    const recovered = await recoverOrphanedAdeAgentProcesses({ logger, processKill });

    expect(recovered).toHaveLength(2);
    expect(processKill).toHaveBeenCalledTimes(1);
    expect(processKill).toHaveBeenCalledWith(-15207, "SIGTERM");
  });
});

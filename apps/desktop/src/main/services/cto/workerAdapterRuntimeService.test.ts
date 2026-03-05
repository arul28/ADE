import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createWorkerAdapterRuntimeService } from "./workerAdapterRuntimeService";
import type { AgentIdentity } from "../../../shared/types";

type SpawnStubCapture = {
  command: string;
  args: string[];
  stdinWritten: string;
};

function makeAgent(overrides: Partial<AgentIdentity>): AgentIdentity {
  return {
    id: "agent-1",
    name: "Worker",
    slug: "worker",
    role: "engineer",
    reportsTo: null,
    capabilities: [],
    status: "idle",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    createdAt: "2026-03-05T00:00:00.000Z",
    updatedAt: "2026-03-05T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

function createSpawnStub(output = "ok"): {
  spawn: any;
  capture: SpawnStubCapture;
} {
  const capture: SpawnStubCapture = {
    command: "",
    args: [],
    stdinWritten: "",
  };
  const spawn = vi.fn((command: string, args: string[]) => {
    capture.command = command;
    capture.args = [...args];
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = new EventEmitter() as any;
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = {
      write: (chunk: string) => {
        capture.stdinWritten += chunk;
      },
      end: () => {},
    };
    child.kill = vi.fn();
    queueMicrotask(() => {
      stdout.emit("data", output);
      child.emit("close", 0, null);
    });
    return child;
  });
  return { spawn, capture };
}

describe("workerAdapterRuntimeService", () => {
  it("runs claude-local through CLI spawn path", async () => {
    const { spawn, capture } = createSpawnStub("claude-output");
    const service = createWorkerAdapterRuntimeService({ spawnImpl: spawn as any });
    const result = await service.run({
      agent: makeAgent({
        adapterType: "claude-local",
        adapterConfig: { model: "sonnet", cliArgs: ["--json"] },
      }),
      prompt: "hello",
    });

    expect(capture.command).toBe("claude");
    expect(capture.args).toEqual(["--model", "sonnet", "--json"]);
    expect(capture.stdinWritten).toContain("hello");
    expect(result.ok).toBe(true);
    expect(result.outputText).toContain("claude-output");
  });

  it("runs codex-local through CLI spawn path", async () => {
    const { spawn, capture } = createSpawnStub("codex-output");
    const service = createWorkerAdapterRuntimeService({ spawnImpl: spawn as any });
    const result = await service.run({
      agent: makeAgent({
        adapterType: "codex-local",
        adapterConfig: { model: "gpt-5.3-codex", cliArgs: ["--json"] },
      }),
      prompt: "fix this",
    });

    expect(capture.command).toBe("codex");
    expect(capture.args).toEqual(["--model", "gpt-5.3-codex", "--json"]);
    expect(result.ok).toBe(true);
    expect(result.outputText).toContain("codex-output");
  });

  it("sends openclaw-webhook request with resolved env header", async () => {
    process.env.OPENCLAW_WEBHOOK_TOKEN = "secret-token";
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ output: "webhook-ok" }),
      } as any;
    });
    const service = createWorkerAdapterRuntimeService({ fetchImpl: fetchMock as any });
    const result = await service.run({
      agent: makeAgent({
        adapterType: "openclaw-webhook",
        adapterConfig: {
          url: "https://example.com/hook",
          headers: {
            Authorization: "Bearer ${env:OPENCLAW_WEBHOOK_TOKEN}",
          },
        },
      }),
      prompt: "run remote",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
    expect(result.ok).toBe(true);
    expect(result.outputText).toBe("webhook-ok");
  });

  it("runs process adapter and blocks unsafe commands", async () => {
    const { spawn } = createSpawnStub("process-output");
    const service = createWorkerAdapterRuntimeService({ spawnImpl: spawn as any });
    const ok = await service.run({
      agent: makeAgent({
        adapterType: "process",
        adapterConfig: { command: "echo", args: ["hello"] },
      }),
      prompt: "test",
    });
    expect(ok.ok).toBe(true);
    expect(ok.outputText).toContain("process-output");

    await expect(
      service.run({
        agent: makeAgent({
          adapterType: "process",
          adapterConfig: { command: "rm -rf /" },
        }),
        prompt: "test",
      })
    ).rejects.toThrow(/unsafe/i);
  });
});


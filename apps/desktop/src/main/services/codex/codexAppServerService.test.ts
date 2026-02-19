import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { CodexEventPayload } from "../../../shared/types";
import { createCodexAppServerService } from "./codexAppServerService";

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: {
    writable: boolean;
    destroyed: boolean;
    write: (chunk: string) => boolean;
  };
  writes: string[];
  kill: (signal?: NodeJS.Signals) => boolean;
};

function createFakeChild(): FakeChild {
  const writes: string[] = [];
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const proc = new EventEmitter() as FakeChild;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.writes = writes;
  proc.stdin = {
    writable: true,
    destroyed: false,
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    }
  };
  proc.kill = () => {
    proc.stdin.writable = false;
    proc.stdin.destroyed = true;
    setTimeout(() => {
      proc.emit("exit", 0, "SIGTERM");
    }, 0);
    return true;
  };
  return proc;
}

function parseWrites(proc: FakeChild): Array<Record<string, unknown>> {
  const lines = proc.writes
    .flatMap((entry) => entry.split("\n"))
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function jsonLine(payload: Record<string, unknown>): string {
  return `${JSON.stringify({ jsonrpc: "2.0", ...payload })}\n`;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function createLoggerStub() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  } as any;
}

function createDbStub() {
  const kv = new Map<string, unknown>();
  return {
    getJson: <T,>(key: string): T | null => (kv.has(key) ? (kv.get(key) as T) : null),
    setJson: (key: string, value: unknown) => {
      kv.set(key, value);
    }
  } as any;
}

describe("createCodexAppServerService", () => {
  it("correlates request/response IDs even when responses arrive out of order", async () => {
    const child = createFakeChild();
    const service = createCodexAppServerService({
      db: createDbStub(),
      logger: createLoggerStub(),
      laneService: {
        getLaneWorktreePath: (laneId: string) => `/tmp/${laneId}`
      } as any,
      clientVersion: "test",
      spawnProcess: () => child as any
    });

    const threadListPromise = service.threadList({ limit: 10 });
    const modelListPromise = service.modelList(10);

    await waitFor(() => parseWrites(child).some((msg) => msg.method === "initialize"));
    const init = parseWrites(child).find((msg) => msg.method === "initialize");
    child.stdout.emit("data", jsonLine({ id: init?.id as number, result: { userAgent: "CodexServer/Test" } }));

    await waitFor(() => {
      const messages = parseWrites(child);
      return messages.some((msg) => msg.method === "thread/list") && messages.some((msg) => msg.method === "model/list");
    });

    const allMessages = parseWrites(child);
    const threadReq = allMessages.find((msg) => msg.method === "thread/list");
    const modelReq = allMessages.find((msg) => msg.method === "model/list");
    expect(threadReq?.id).toBeTypeOf("number");
    expect(modelReq?.id).toBeTypeOf("number");

    child.stdout.emit(
      "data",
      jsonLine({
        id: modelReq?.id as number,
        result: {
          data: [{ id: "model-1", model: "gpt-5.1-codex", displayName: "Codex", description: "", isDefault: true }],
          nextCursor: null
        }
      })
    );
    child.stdout.emit(
      "data",
      jsonLine({
        id: threadReq?.id as number,
        result: {
          data: [
            {
              id: "thr-1",
              preview: "test",
              modelProvider: "openai",
              createdAt: 1,
              updatedAt: 1,
              path: null,
              cwd: "/tmp/lane-a",
              cliVersion: "0.1.0",
              source: "app-server",
              gitInfo: null,
              turns: []
            }
          ],
          nextCursor: null
        }
      })
    );

    const threadList = await threadListPromise;
    const models = await modelListPromise;

    expect(threadList.data[0]?.id).toBe("thr-1");
    expect(models.data[0]?.id).toBe("model-1");

    service.dispose();
  });

  it("tracks approval requests and writes approval responses", async () => {
    const child = createFakeChild();
    const events: CodexEventPayload[] = [];
    const service = createCodexAppServerService({
      db: createDbStub(),
      logger: createLoggerStub(),
      laneService: {
        getLaneWorktreePath: (laneId: string) => `/tmp/${laneId}`
      } as any,
      clientVersion: "test",
      onEvent: (event) => {
        events.push(event);
      },
      spawnProcess: () => child as any
    });

    const accountPromise = service.accountRead();
    await waitFor(() => parseWrites(child).some((msg) => msg.method === "initialize"));

    const init = parseWrites(child).find((msg) => msg.method === "initialize");
    child.stdout.emit("data", jsonLine({ id: init?.id as number, result: { userAgent: "CodexServer/Test" } }));

    await waitFor(() => parseWrites(child).some((msg) => msg.method === "account/read"));
    const accountReadReq = parseWrites(child).find((msg) => msg.method === "account/read");
    child.stdout.emit("data", jsonLine({ id: accountReadReq?.id as number, result: { account: null, requiresOpenaiAuth: true } }));
    await accountPromise;

    child.stdout.emit(
      "data",
      jsonLine({
        id: "approval-1",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thr-1",
          turnId: "turn-1",
          itemId: "item-1",
          reason: "needs access",
          command: "git status",
          cwd: "/tmp/lane-a"
        }
      })
    );

    const pending = service.listPendingApprovals("thr-1");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.requestId).toBe("approval-1");

    await service.respondToApprovalRequest("approval-1", "acceptForSession");
    const allMessages = parseWrites(child);
    const approvalResponse = allMessages.find(
      (msg) => msg.id === "approval-1" && (msg.result as Record<string, unknown> | undefined)?.decision === "acceptForSession"
    );
    expect(approvalResponse).toBeTruthy();
    expect(service.listPendingApprovals()).toHaveLength(0);
    expect(events.some((event) => event.type === "server-request")).toBe(true);

    service.dispose();
  });

  it("sends turn/start text input shape expected by app-server", async () => {
    const child = createFakeChild();
    const service = createCodexAppServerService({
      db: createDbStub(),
      logger: createLoggerStub(),
      laneService: {
        getLaneWorktreePath: (laneId: string) => `/tmp/${laneId}`
      } as any,
      clientVersion: "test",
      spawnProcess: () => child as any
    });

    const turnPromise = service.turnStart({
      threadId: "thr-1",
      laneId: "lane-a",
      prompt: "Ship it",
      effort: "xhigh"
    });

    await waitFor(() => parseWrites(child).some((msg) => msg.method === "initialize"));
    const init = parseWrites(child).find((msg) => msg.method === "initialize");
    child.stdout.emit("data", jsonLine({ id: init?.id as number, result: { userAgent: "CodexServer/Test" } }));

    await waitFor(() => parseWrites(child).some((msg) => msg.method === "turn/start"));
    const turnReq = parseWrites(child).find((msg) => msg.method === "turn/start");
    const turnParams = (turnReq?.params ?? {}) as Record<string, unknown>;
    const input = Array.isArray(turnParams.input) ? turnParams.input : [];
    const first = (input[0] ?? {}) as Record<string, unknown>;
    expect(first.type).toBe("text");
    expect(first.text).toBe("Ship it");
    expect(first.text_elements).toEqual([]);
    expect(turnParams.effort).toBe("xhigh");

    child.stdout.emit(
      "data",
      jsonLine({
        id: turnReq?.id as number,
        result: {
          turn: { id: "turn-1", items: [], status: "running", error: null }
        }
      })
    );

    const turn = await turnPromise;
    expect(turn.id).toBe("turn-1");
    service.dispose();
  });

  it("retries thread/read without turns when thread is not materialized yet", async () => {
    const child = createFakeChild();
    const service = createCodexAppServerService({
      db: createDbStub(),
      logger: createLoggerStub(),
      laneService: {
        getLaneWorktreePath: (laneId: string) => `/tmp/${laneId}`
      } as any,
      clientVersion: "test",
      spawnProcess: () => child as any
    });

    const readPromise = service.threadRead({
      threadId: "thr-materializing",
      includeTurns: true
    });

    await waitFor(() => parseWrites(child).some((msg) => msg.method === "initialize"));
    const init = parseWrites(child).find((msg) => msg.method === "initialize");
    child.stdout.emit("data", jsonLine({ id: init?.id as number, result: { userAgent: "CodexServer/Test" } }));

    await waitFor(
      () =>
        parseWrites(child).filter((msg) => msg.method === "thread/read").length >= 1 &&
        ((parseWrites(child).filter((msg) => msg.method === "thread/read")[0]?.params as Record<string, unknown> | undefined)?.includeTurns === true)
    );
    const firstRead = parseWrites(child).find((msg) => msg.method === "thread/read");
    child.stdout.emit(
      "data",
      jsonLine({
        id: firstRead?.id as number,
        error: {
          code: -32600,
          message: "thread thr-materializing is not materialized yet; includeTurns is unavailable before first user message"
        }
      })
    );

    await waitFor(
      () =>
        parseWrites(child).filter((msg) => msg.method === "thread/read").length >= 2 &&
        ((parseWrites(child).filter((msg) => msg.method === "thread/read")[1]?.params as Record<string, unknown> | undefined)?.includeTurns === false)
    );
    const secondRead = parseWrites(child).filter((msg) => msg.method === "thread/read")[1] as Record<string, unknown>;
    child.stdout.emit(
      "data",
      jsonLine({
        id: secondRead.id as number,
        result: {
          thread: {
            id: "thr-materializing"
          }
        }
      })
    );

    const thread = await readPromise;
    expect(thread.id).toBe("thr-materializing");
    service.dispose();
  });

  it("forgets stale lane thread binding when resume fails with missing rollout", async () => {
    const child = createFakeChild();
    const service = createCodexAppServerService({
      db: createDbStub(),
      logger: createLoggerStub(),
      laneService: {
        getLaneWorktreePath: (laneId: string) => `/tmp/${laneId}`
      } as any,
      clientVersion: "test",
      spawnProcess: () => child as any
    });

    const startPromise = service.threadStart({
      laneId: "lane-a",
      model: null,
      approvalPolicy: "on-request",
      sandbox: "workspace-write"
    });

    await waitFor(() => parseWrites(child).some((msg) => msg.method === "initialize"));
    const init = parseWrites(child).find((msg) => msg.method === "initialize");
    child.stdout.emit("data", jsonLine({ id: init?.id as number, result: { userAgent: "CodexServer/Test" } }));

    await waitFor(() => parseWrites(child).some((msg) => msg.method === "thread/start"));
    const startReq = parseWrites(child).find((msg) => msg.method === "thread/start");
    child.stdout.emit(
      "data",
      jsonLine({
        id: startReq?.id as number,
        result: {
          thread: { id: "thr-stale" }
        }
      })
    );

    await startPromise;
    expect(service.getLaneBinding("lane-a").defaultThreadId).toBe("thr-stale");
    expect(service.getLaneBinding("lane-a").recentThreadIds).toContain("thr-stale");

    const resumePromise = service.threadResume({
      laneId: "lane-a",
      threadId: "thr-stale",
      model: null,
      approvalPolicy: "on-request",
      sandbox: "workspace-write"
    });

    await waitFor(() => parseWrites(child).some((msg) => msg.method === "thread/resume"));
    const resumeReq = parseWrites(child).find((msg) => msg.method === "thread/resume");
    child.stdout.emit(
      "data",
      jsonLine({
        id: resumeReq?.id as number,
        error: {
          code: -32600,
          message: "no rollout found for thread id thr-stale"
        }
      })
    );

    await expect(resumePromise).rejects.toThrow("no rollout found for thread id thr-stale");

    const binding = service.getLaneBinding("lane-a");
    expect(binding.defaultThreadId).toBeNull();
    expect(binding.recentThreadIds).not.toContain("thr-stale");

    service.dispose();
  });
});

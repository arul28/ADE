import { execFile } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DevServerRecord } from "../../../shared/types/builtInBrowser";
import { stopChatDevServer } from "./devServerStop";

// PowerShell (listeners, process table) and taskkill are the OS boundary.
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

type ExecCallback = (error: Error | null, stdout: string) => void;

const PORT = 43_123;
// Pids no real process holds, so the liveness probe after taskkill sees them gone.
const AGENT = 2_000_000_001;
const SHELL = 2_000_000_002;
const SERVER = 2_000_000_003;
const OUTSIDER = 2_000_000_010;

describe("stopChatDevServer on Windows", () => {
  afterEach(() => {
    vi.mocked(execFile).mockReset();
  });

  // Windows cannot read another process's environment, so ownership rests on
  // the chat's report, the listener running under this runtime, and its start
  // time lining up with that report. Anything else must never be killed.
  const reportedAt = Date.now();
  const record = (sessionId: string): DevServerRecord => ({
    port: PORT,
    url: `http://localhost:${PORT}/`,
    source: { sessionId, laneId: "lane-1", projectRoot: null },
    detectedAt: new Date(reportedAt).toISOString(),
  });

  it.each([
    { name: "a server the chat started under ADE", listener: SERVER, startedMs: reportedAt - 30_000, record: record("chat-1"), stops: true },
    { name: "no report from the chat", listener: SERVER, startedMs: reportedAt - 30_000, record: null, stops: false },
    { name: "another chat's report", listener: SERVER, startedMs: reportedAt - 30_000, record: record("chat-2"), stops: false },
    { name: "a listener started outside ADE", listener: OUTSIDER, startedMs: reportedAt - 30_000, record: record("chat-1"), stops: false },
    { name: "a server started long before the report", listener: SERVER, startedMs: reportedAt - 5 * 60_000, record: record("chat-1"), stops: false },
    { name: "a server started after the report", listener: SERVER, startedMs: reportedAt + 60_000, record: record("chat-1"), stops: false },
  ])("$name: stops=$stops", async ({ listener, startedMs, record: chatRecord, stops }) => {
    const table = [
      { pid: process.pid, ppid: 0, started: 1_000 },
      { pid: AGENT, ppid: process.pid, started: 2_000 },
      { pid: SHELL, ppid: AGENT, started: 3_000 },
      { pid: SERVER, ppid: SHELL, started: listener === SERVER ? startedMs : 4_000 },
      { pid: OUTSIDER, ppid: 0, started: listener === OUTSIDER ? startedMs : 4_000 },
    ];
    const killed: string[] = [];
    vi.mocked(execFile).mockImplementation(((command: string, args: string[], _options: unknown, callback: ExecCallback) => {
      const script = args.join(" ");
      let stdout = "";
      if (/taskkill/i.test(command)) killed.push(args[1] ?? "");
      else if (script.includes("Get-NetTCPConnection")) stdout = JSON.stringify(killed.length > 0 ? [] : [listener]);
      else if (script.includes("Win32_Process")) stdout = JSON.stringify(table);
      queueMicrotask(() => callback(null, stdout));
    }) as never);

    const result = await stopChatDevServer({
      chatSessionId: "chat-1",
      port: PORT,
      record: chatRecord,
      platform: "win32",
      graceMs: 0,
    });

    if (stops) {
      expect(result).toMatchObject({ ok: true, port: PORT });
      expect(killed).toEqual([String(SERVER)]);
    } else {
      expect(result).toMatchObject({ ok: false, reason: "not_owned" });
      expect(killed).toEqual([]);
    }
  });
});

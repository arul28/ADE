import { execFile } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentShellOutputObserver } from "./agentShellOutput";
import { createDevServerRegistry, detectDevServersInChunk, devServerRegistry } from "./devServerRegistry";
import { createDevServerWatcher } from "./devServerWatcher";

// The listener scan asks the OS (lsof / PowerShell); that process boundary is
// the only thing replaced.
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

type ExecCallback = (error: Error | null, stdout: string) => void;

function answerScans(answer: (command: string, args: string[]) => string): void {
  vi.mocked(execFile).mockImplementation(((command: string, args: string[], _options: unknown, callback: ExecCallback) => {
    queueMicrotask(() => callback(null, answer(command, args)));
  }) as never);
}

describe("detectDevServersInChunk", () => {
  it("matches the ready lines the common dev servers actually print", () => {
    const cases: Array<[string, number]> = [
      ["  ➜  Local:   http://localhost:5173/\n", 5173],
      ["  ➜  Network: http://127.0.0.1:5174/\n", 5174],
      ["ready - started server on 0.0.0.0:3000, url: http://localhost:3000\n", 3000],
      ["✓ Ready in 812ms\n  - Local:        http://localhost:3001\n", 3001],
      ["Server running at http://localhost:8080/\n", 8080],
      ["Listening on http://127.0.0.1:4321\n", 4321],
      ["  App running at http://localhost:8000/\n", 8000],
    ];
    for (const [line, port] of cases) {
      const { detections } = detectDevServersInChunk(line);
      expect(detections.map((entry) => entry.port), line).toEqual([port]);
    }
  });

  it("normalizes a wildcard host to something a tab can actually load", () => {
    const { detections } = detectDevServersInChunk("listening on http://0.0.0.0:4000/\n");
    expect(detections[0]?.url).toBe("http://localhost:4000/");
  });

  it("strips ANSI colour before matching", () => {
    const chunk = "  \u001B[32m\u27A1\u001B[39m  \u001B[1mLocal\u001B[22m:   \u001B[36mhttp://localhost:5173/\u001B[39m\n";
    expect(detectDevServersInChunk(chunk).detections[0]).toMatchObject({ port: 5173 });
  });

  it("ignores URLs that are not a server announcing itself", () => {
    const noise = [
      "See https://localhost:9999/docs for details\n",
      "  at fetch (http://localhost:5173/src/main.ts:12:3)\n",
      "npm notice New version available\n",
    ].join("");
    expect(detectDevServersInChunk(noise).detections).toEqual([]);
  });

  it("ignores privileged and malformed ports", () => {
    expect(detectDevServersInChunk("listening on http://localhost:80/\n").detections).toEqual([]);
    expect(detectDevServersInChunk("listening on http://localhost/\n").detections).toEqual([]);
  });

  it("finds a ready line split across two PTY chunks exactly once", () => {
    const first = detectDevServersInChunk("  ➜  Local:   http://localh");
    expect(first.detections).toEqual([]);

    const second = detectDevServersInChunk("ost:5173/\n", first.carry);
    expect(second.detections).toEqual([{ port: 5173, url: "http://localhost:5173/" }]);

    // The carry is consumed, so the next chunk does not re-report it.
    expect(detectDevServersInChunk("still building…\n", second.carry).detections).toEqual([]);
  });

  it("reports each port once per chunk even when a line repeats it", () => {
    const chunk = "  ➜  Local:   http://localhost:5173/ http://localhost:5173/about\n";
    expect(detectDevServersInChunk(chunk).detections).toHaveLength(1);
  });
});

describe("createDevServerRegistry", () => {
  it("notifies once per new (lane, port) and answers repeats with null", () => {
    const registry = createDevServerRegistry();
    const seen = vi.fn();
    registry.onDetected(seen);

    expect(registry.record({ port: 5173, url: "http://localhost:5173/", laneId: "lane-1", sessionId: "s1" }))
      .toMatchObject({ port: 5173 });
    // Same lane, same port, same url: a watch restart, not a new server.
    expect(registry.record({ port: 5173, url: "http://localhost:5173/", laneId: "lane-1", sessionId: "s1" }))
      .toBeNull();
    // A different lane serving the same port is genuinely a different server.
    expect(registry.record({ port: 5173, url: "http://localhost:5173/", laneId: "lane-2", sessionId: "s2" }))
      .toMatchObject({ source: { laneId: "lane-2" } });

    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("filters by lane and forgets a closed terminal session", () => {
    const registry = createDevServerRegistry();
    registry.record({ port: 3000, url: "http://localhost:3000/", laneId: "lane-1", sessionId: "s1" });
    registry.record({ port: 4000, url: "http://localhost:4000/", laneId: "lane-2", sessionId: "s2" });

    expect(registry.list({ laneId: "lane-1" }).map((entry) => entry.port)).toEqual([3000]);

    registry.forgetSession("s1");
    expect(registry.list().map((entry) => entry.port)).toEqual([4000]);
  });

  it("bounds how many servers it remembers", () => {
    const registry = createDevServerRegistry({ maxEntries: 2 });
    registry.record({ port: 3000, url: "http://localhost:3000/", laneId: "lane-1" });
    registry.record({ port: 3001, url: "http://localhost:3001/", laneId: "lane-1" });
    registry.record({ port: 3002, url: "http://localhost:3002/", laneId: "lane-1" });

    expect(registry.list()).toHaveLength(2);
    expect(registry.list().some((entry) => entry.port === 3002)).toBe(true);
  });

  it("survives a subscriber that throws", () => {
    const registry = createDevServerRegistry();
    registry.onDetected(() => {
      throw new Error("bad subscriber");
    });
    const good = vi.fn();
    registry.onDetected(good);

    expect(() => registry.record({ port: 5173, url: "http://localhost:5173/", laneId: "lane-1" })).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });
});

describe("dev servers outside ADE terminals", () => {
  afterEach(() => {
    vi.useRealTimers();
    devServerRegistry.clear();
  });

  it("reads an agent's streamed shell output like a terminal, across chunk boundaries", () => {
    devServerRegistry.clear();
    const observer = createAgentShellOutputObserver("/repo");
    const session = { sessionId: "chat-1", laneId: "lane-a" };
    // A Codex command streams only its new output per event, and the ready
    // line can be cut anywhere: `…localhost:51` + `73/`.
    observer.observe(session, { type: "command", command: "npm run dev", cwd: "", output: "> vite\n  ➜  Local:   http://localhost:51", itemId: "cmd-1", status: "running" } as never);
    expect(devServerRegistry.list()).toEqual([]);
    observer.observe(session, { type: "command", command: "npm run dev", cwd: "", output: "73/\n", itemId: "cmd-1", status: "running" } as never);
    // Claude's Bash tool hands back its output as text parts.
    observer.observe(session, { type: "tool_result", tool: "Bash", result: [{ type: "text", text: "Server running at http://localhost:8080/" }], itemId: "bash-1" } as never);

    expect(devServerRegistry.list().map((record) => record.port).sort()).toEqual([5173, 8080]);
    expect(devServerRegistry.list().every((record) => record.source.laneId === "lane-a" && record.source.projectRoot === "/repo")).toBe(true);
  });

  it.each([
    {
      platform: "darwin" as const,
      roots: [{ laneId: "primary", root: "/repo" }, { laneId: "lane-a", root: "/wt/lane-a" }],
      // lsof: listeners, then the cwd of each owner.
      scan: (command: string, args: string[]) => args.includes("cwd")
        ? "p101\nn/wt/lane-a/web\np102\nn/wt/lane-a-v2\np103\nn/wt/lane-a\n"
        : command === "lsof"
          ? "p101\ncnode\nn[::1]:47182\np102\ncnode\nn127.0.0.1:47183\np103\ncnode\nn*:9229\n"
          : "",
      found: ["lane-a:47182"],
    },
    {
      platform: "win32" as const,
      roots: [{ laneId: "primary", root: "C:\\repo" }, { laneId: "lane-a", root: "C:\\wt\\lane-a" }],
      scan: () => JSON.stringify([
        { pid: 201, ports: [47182], name: "node.exe", commandLine: "node.exe C:/wt/lane-a/node_modules/vite/bin/vite.js", ancestors: [] },
        { pid: 202, ports: [47183], name: "node.exe", commandLine: "node C:\\wt\\lane-a-v2\\server.js", ancestors: [] },
        // A relative entry point: the shell that started it names the lane.
        { pid: 203, ports: [47185], name: "node.exe", commandLine: "node server.js", ancestors: [{ pid: 300, commandLine: "cmd.exe /c cd /d C:\\WT\\Lane-A && node server.js" }] },
        // Only ADE itself names a root above it: that is not where it runs.
        { pid: 204, ports: [47186], name: "node.exe", commandLine: "node server.js", ancestors: [{ pid: process.pid, commandLine: "ade serve --project-root C:\\repo" }] },
      ]),
      found: ["lane-a:47182", "lane-a:47185"],
    },
  ])("finds a lane's background servers on $platform, and forgets them once they stop", async ({ platform, roots, scan, found }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(platform === "win32" ? "2026-10-04T12:00:00Z" : "2026-10-04T11:00:00Z"));
    const removed: number[] = [];
    const stopRemoved = devServerRegistry.onRemoved((record) => removed.push(record.port));
    const watcher = createDevServerWatcher({
      registry: devServerRegistry,
      projectRoot: platform === "win32" ? "C:\\repo" : "/repo",
      listLaneRoots: async () => roots,
      platform,
    });

    answerScans(scan);
    await watcher.refresh();
    const listed = devServerRegistry.list().map((record) => `${record.source.laneId}:${record.port}`).sort();
    expect(listed).toEqual(found);
    expect(devServerRegistry.list().every((record) => watcher.ownsRecord(record))).toBe(true);

    // The servers stop. Nothing announces that, so the next look notices.
    answerScans(() => (platform === "win32" ? "[]" : ""));
    vi.setSystemTime(Date.now() + 20_000);
    await watcher.refresh();
    expect(devServerRegistry.list()).toEqual([]);
    expect(removed.sort()).toEqual(found.map((key) => Number(key.split(":")[1])).sort());
    stopRemoved();
    watcher.dispose();
  });
});

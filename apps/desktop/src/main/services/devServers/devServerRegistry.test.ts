import { describe, expect, it, vi } from "vitest";
import { createDevServerRegistry, detectDevServersInChunk } from "./devServerRegistry";

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

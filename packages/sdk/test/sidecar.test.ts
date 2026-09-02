import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createAdeChat, type InternalAdeChatOptions } from "../src/client.js";
import type { AdeChatClient } from "../src/client.js";
import { resolveBinary } from "../src/binary.js";
import { createHash } from "node:crypto";
import { downloadRuntime, resolveRuntimeTarget, runtimePaths } from "../src/download.js";
import { writeRuntimePidfile } from "../src/runtimePidfile.js";
import { resolveRuntimeSocketPath } from "../src/socketPath.js";
import type { DownloadRequest } from "../src/download.js";

const FAKE_BIN = fileURLToPath(new URL("./fakeRuntimeBin.mjs", import.meta.url));

const homes: string[] = [];
/**
 * Every client goes in here on the line after it is created, BEFORE any
 * assertion touches it. A `push` placed after an `expect` is only reached on
 * the passing path, so the first failure in that test leaks a live runtime
 * process for the rest of the run.
 */
const clients: AdeChatClient[] = [];

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ade-sdk-side-"));
  homes.push(home);
  return home;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(tick, 10).unref?.();
    };
    tick();
  });
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.dispose().catch(() => {})));
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe("sidecar orphan prevention", () => {
  it("passes this process's pid so the runtime can watch for our death", async () => {
    const home = makeHome();
    const client = await createAdeChat({
      home,
      binaryPath: FAKE_BIN,
      startupTimeoutMs: 20_000,
    } as InternalAdeChatOptions);
    clients.push(client);

    const record = JSON.parse(fs.readFileSync(path.join(home, "spawn-record.json"), "utf8"));
    // `detached: false` does NOT make a child die with its parent on POSIX — an
    // orphan is reparented to init. This env var is the only thing that closes
    // the gap for a host killed with SIGKILL, and a validator run leaked four
    // runtimes before it existed.
    expect(record.embeddedParentPid).toBe(String(process.pid));
  });

  it("records the runtime pid for this home, and clears it on dispose", async () => {
    const home = makeHome();
    const client = await createAdeChat({
      home,
      binaryPath: FAKE_BIN,
      startupTimeoutMs: 20_000,
    } as InternalAdeChatOptions);
    clients.push(client);

    const pidfile = path.join(home, "runtime.pid");
    const recorded = JSON.parse(fs.readFileSync(pidfile, "utf8"));
    const spawned = JSON.parse(fs.readFileSync(path.join(home, "spawn-record.json"), "utf8"));
    expect(recorded.pid).toBe(spawned.pid);
    expect(recorded.parentPid).toBe(process.pid);

    await client.dispose();
    // Removed only after the child is confirmed gone, so a failed kill leaves a
    // record the next start can still act on.
    expect(fs.existsSync(pidfile)).toBe(false);
  });

  it("reclaims an orphaned runtime from a previous host before spawning", async () => {
    const home = makeHome();
    const first = await createAdeChat({
      home,
      binaryPath: FAKE_BIN,
      startupTimeoutMs: 20_000,
    } as InternalAdeChatOptions);
    clients.push(first);
    const orphanPid = JSON.parse(
      fs.readFileSync(path.join(home, "spawn-record.json"), "utf8"),
    ).pid as number;

    // Simulate the host dying without unwinding: the test never disposes
    // `first` itself, exactly as a SIGKILLed process would not. (It is
    // registered for afterEach cleanup above, which runs after the assertions
    // rather than as part of the scenario.) The runtime is still alive and
    // still listening.
    expect(isAlive(orphanPid)).toBe(true);

    const second = await createAdeChat({
      home,
      binaryPath: FAKE_BIN,
      startupTimeoutMs: 20_000,
    } as InternalAdeChatOptions);
    clients.push(second);

    // The orphan still answered on the socket, so the healthy-runtime path wins:
    // reuse it rather than kill a working process and pay a cold boot. A second
    // spawn here would put two runtimes on one home, fighting over the socket
    // and the database.
    const recorded = JSON.parse(fs.readFileSync(path.join(home, "runtime.pid"), "utf8"));
    expect(recorded.pid).toBe(orphanPid);
    expect(isAlive(orphanPid)).toBe(true);
    // Reused, not respawned: the record still names the original process.
    const spawnedAgain = JSON.parse(
      fs.readFileSync(path.join(home, "spawn-record.json"), "utf8"),
    ).pid as number;
    expect(spawnedAgain).toBe(orphanPid);
  });

  it("kills a recorded runtime that is alive but no longer serving", async () => {
    const home = makeHome();
    const client = await createAdeChat({
      home,
      binaryPath: FAKE_BIN,
      startupTimeoutMs: 20_000,
    } as InternalAdeChatOptions);
    clients.push(client);
    const firstPid = JSON.parse(
      fs.readFileSync(path.join(home, "spawn-record.json"), "utf8"),
    ).pid as number;

    // Break the endpoint while leaving the process up: the orphan signature the
    // reclaim path exists for (process alive, socket unusable).
    const socketPath = JSON.parse(
      fs.readFileSync(path.join(home, "runtime.pid"), "utf8"),
    ).socketPath as string;
    fs.rmSync(socketPath, { force: true });

    const second = await createAdeChat({
      home,
      binaryPath: FAKE_BIN,
      startupTimeoutMs: 20_000,
    } as InternalAdeChatOptions);
    clients.push(second);

    await waitFor(() => !isAlive(firstPid), "the stale runtime to be reclaimed");
    const recorded = JSON.parse(fs.readFileSync(path.join(home, "runtime.pid"), "utf8"));
    expect(recorded.pid).not.toBe(firstPid);
  });
});

describe("sidecar lifecycle", () => {
  it("spawns `runtime run --socket <path> --profile embedded` with the caller's ADE_HOME", async () => {
    const home = makeHome();
    const client = await createAdeChat({
      home,
      binaryPath: FAKE_BIN,
      startupTimeoutMs: 20_000,
    } as InternalAdeChatOptions);
    clients.push(client);

    const record = JSON.parse(fs.readFileSync(path.join(home, "spawn-record.json"), "utf8"));
    expect(record.argv.slice(0, 2)).toEqual(["runtime", "run"]);
    expect(record.profile).toBe("embedded");
    expect(record.adeHome).toBe(home);
    expect(record.argv).toContain(path.join(home, "sock", "ade.sock"));
  });

  it("dispose() kills the child process", async () => {
    const home = makeHome();
    const client = await createAdeChat({
      home,
      binaryPath: FAKE_BIN,
      startupTimeoutMs: 20_000,
    } as InternalAdeChatOptions);
    clients.push(client);
    const { pid } = JSON.parse(fs.readFileSync(path.join(home, "spawn-record.json"), "utf8"));
    expect(isAlive(pid)).toBe(true);

    await client.dispose();
    await waitFor(() => !isAlive(pid), "child exit after dispose");
    expect(isAlive(pid)).toBe(false);
  });

  it("waits out a slow start rather than failing on the first refused connect", async () => {
    const home = makeHome();
    process.env.FAKE_ADE_STARTUP_DELAY_MS = "400";
    try {
      const client = await createAdeChat({
        home,
        binaryPath: FAKE_BIN,
        startupTimeoutMs: 20_000,
      } as InternalAdeChatOptions);
      clients.push(client);
      const report = await client.doctor();
      expect(report.socket.connected).toBe(true);
    } finally {
      delete process.env.FAKE_ADE_STARTUP_DELAY_MS;
    }
  });

  it("fails fast with the child's stderr when the runtime exits during startup", async () => {
    const home = makeHome();
    process.env.FAKE_ADE_EXIT_DURING_STARTUP = "1";
    try {
      await expect(
        createAdeChat({
          home,
          binaryPath: FAKE_BIN,
          startupTimeoutMs: 20_000,
        } as InternalAdeChatOptions),
      ).rejects.toMatchObject({ code: "spawn_failed" });
    } finally {
      delete process.env.FAKE_ADE_EXIT_DURING_STARTUP;
    }
  });
});

describe("binary resolution", () => {
  it("honours an explicit binaryPath above everything else", async () => {
    const resolved = await resolveBinary({
      home: makeHome(),
      binaryPath: FAKE_BIN,
      logger: () => {},
      download: async () => {
        throw new Error("must not download");
      },
    });
    expect(resolved).toMatchObject({ binaryPath: FAKE_BIN, source: "explicit" });
  });

  it("rejects a binaryPath that does not exist", async () => {
    await expect(
      resolveBinary({
        home: makeHome(),
        binaryPath: path.join(os.tmpdir(), "definitely-not-here-ade"),
        logger: () => {},
      }),
    ).rejects.toMatchObject({ code: "binary_not_found" });
  });

  it("reuses a cached download before consulting PATH", async () => {
    const home = makeHome();
    const target = process.platform === "win32" ? "win32-x64" : `${process.platform}-${process.arch}`;
    const binaryPath = path.join(home, "bin", process.platform === "win32" ? "ade.exe" : "ade");
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    fs.writeFileSync(binaryPath, "", { mode: 0o755 });
    fs.mkdirSync(path.join(home, "runtime", target, "node_modules"), { recursive: true });

    const resolved = await resolveBinary({
      home,
      logger: () => {},
      download: async () => {
        throw new Error("must not download");
      },
    });
    expect(resolved).toMatchObject({ binaryPath, source: "cached-download" });
  });

  it("falls back to an `ade` found on PATH before downloading", async () => {
    const home = makeHome();
    const pathDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-sdk-bin-"));
    try {
      const onPath = path.join(pathDir, process.platform === "win32" ? "ade.exe" : "ade");
      fs.writeFileSync(onPath, "", { mode: 0o755 });
      const resolved = await resolveBinary({
        home,
        logger: () => {},
        env: { PATH: pathDir, PATHEXT: ".EXE" },
        download: async () => {
          throw new Error("must not download");
        },
      });
      expect(resolved).toMatchObject({ binaryPath: onPath, source: "path" });
    } finally {
      fs.rmSync(pathDir, { recursive: true, force: true });
    }
  });

  it("calls the injected downloader when nothing is cached or on PATH", async () => {
    const home = makeHome();
    const seen: DownloadRequest[] = [];
    const resolved = await resolveBinary({
      home,
      channel: "v9.9.9",
      logger: () => {},
      allowPathDiscovery: false,
      download: async (request) => {
        seen.push(request);
        return {
          binaryPath: path.join(request.home, "bin", "ade"),
          runtimeRoot: path.join(request.home, "runtime", request.target.target),
          checksumVerified: true,
        };
      },
    });
    expect(resolved.source).toBe("downloaded");
    expect(seen[0]!.channel).toBe("v9.9.9");
    expect(seen[0]!.target.binaryAsset).toMatch(/^ade-/);
  });
});

describe("download integrity", () => {
  it("fails closed when the channel publishes no SHA256SUMS", async () => {
    // An unverifiable executable is not installed. Before this, suppressing one
    // file downgraded the check to "is it big enough".
    const home = makeHome();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith("SHA256SUMS")) return new Response("", { status: 404 });
      return new Response(new Uint8Array(2 * 1024 * 1024), { status: 200 });
    }) as typeof fetch;
    try {
      await expect(
        downloadRuntime({
          home,
          channel: "latest",
          repo: "example/repo",
          target: resolveRuntimeTarget(),
          logger: () => {},
        }),
      ).rejects.toMatchObject({ code: "checksum_mismatch" });
      // Nothing was installed on the way to refusing.
      expect(fs.existsSync(path.join(home, "bin", "ade"))).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("rejects a checksum that does not match the bytes", async () => {
    const home = makeHome();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith("SHA256SUMS")) {
        const target = resolveRuntimeTarget();
        return new Response(
          `${"a".repeat(64)}  ${target.binaryAsset}\n${"b".repeat(64)}  ${target.archiveAsset}\n`,
          { status: 200 },
        );
      }
      return new Response(new Uint8Array(2 * 1024 * 1024), { status: 200 });
    }) as typeof fetch;
    try {
      await expect(
        downloadRuntime({
          home,
          channel: "latest",
          repo: "example/repo",
          target: resolveRuntimeTarget(),
          logger: () => {},
        }),
      ).rejects.toMatchObject({ code: "checksum_mismatch" });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("two runtimes on one home", () => {
  it("refuses to start when an unprovable owner is recorded", async () => {
    // Spawning anyway would put two writers on one SQLite state root.
    const home = makeHome();
    await writeRuntimePidfile(home, {
      // This process: unmistakably alive, and one reclaim can never prove is a
      // stale runtime — the "left" outcome A11 makes fatal.
      pid: process.pid,
      socketPath: resolveRuntimeSocketPath(home),
      parentPid: 7777,
      startedAt: new Date().toISOString(),
    });
    await expect(
      createAdeChat({
        home,
        binaryPath: FAKE_BIN,
        startupTimeoutMs: 20_000,
        logger: () => {},
      } as InternalAdeChatOptions),
    ).rejects.toMatchObject({ code: "spawn_failed" });
  });
});

describe("cached runtime is channel-aware", () => {
  /** Serves a valid, checksum-matching runtime so downloads succeed. */
  function serveRuntime(counter: { downloads: number }): typeof fetch {
    const target = resolveRuntimeTarget();
    const binary = new Uint8Array(2 * 1024 * 1024);
    const archive = new Uint8Array(2 * 1024 * 1024);
    const digest = (bytes: Uint8Array): string =>
      createHash("sha256").update(Buffer.from(bytes)).digest("hex");
    return (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith("SHA256SUMS")) {
        return new Response(
          `${digest(binary)}  ${target.binaryAsset}\n${digest(archive)}  ${target.archiveAsset}\n`,
          { status: 200 },
        );
      }
      counter.downloads += 1;
      return new Response(url.endsWith(".tar.gz") ? archive : binary, { status: 200 });
    }) as typeof fetch;
  }

  it("re-downloads when the requested channel differs from the cached one", async () => {
    const home = makeHome();
    const counter = { downloads: 0 };
    const realFetch = globalThis.fetch;
    globalThis.fetch = serveRuntime(counter);
    try {
      const request = {
        home,
        repo: "example/repo",
        target: resolveRuntimeTarget(),
        logger: () => {},
      };
      // The archive is not a real tar, so extraction fails — but only AFTER the
      // cache decision, which is what this test is about. Count fetches instead.
      await downloadRuntime({ ...request, channel: "v1.0.0" }).catch(() => {});
      const afterFirst = counter.downloads;
      expect(afterFirst).toBeGreaterThan(0);

      // Same channel again would be a candidate for reuse; a DIFFERENT channel
      // must never be, or pinning a version silently keeps the old build.
      await downloadRuntime({ ...request, channel: "v2.0.0" }).catch(() => {});
      expect(counter.downloads).toBeGreaterThan(afterFirst);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("reuses a cached runtime only when the channel marker matches", async () => {
    const home = makeHome();
    const target = resolveRuntimeTarget();
    const { binaryPath, runtimeRoot } = runtimePaths(home, target);
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    fs.writeFileSync(binaryPath, "", { mode: 0o755 });
    fs.mkdirSync(path.join(runtimeRoot, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, ".ade-sdk-channel"), "v1.0.0\n");

    const counter = { downloads: 0 };
    const realFetch = globalThis.fetch;
    globalThis.fetch = serveRuntime(counter);
    try {
      const request = {
        home,
        repo: "example/repo",
        target,
        logger: () => {},
      };
      const reused = await downloadRuntime({ ...request, channel: "v1.0.0" });
      expect(reused.binaryPath).toBe(binaryPath);
      expect(counter.downloads).toBe(0);

      await downloadRuntime({ ...request, channel: "v9.9.9" }).catch(() => {});
      expect(counter.downloads).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

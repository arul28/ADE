import { describe, expect, it } from "vitest";
import { decideBrainSkew } from "./brainVersionSkew";

const APP_CLI = "/Applications/ADE.app/Contents/Resources/ade-cli/cli.cjs";
const SEA = "/Users/a/.ade/bin/ade";
const OK = { min: 1, max: 1 };
const FUTURE = { min: 2, max: 3 };

type Brain = { version: string | null; entry: string | null; protocol?: { min: number; max: number }; commandLine?: string };

function decide(cli: { version: string; entry: string }, brain: Brain) {
  return decideBrainSkew({
    cliVersion: cli.version,
    placeholderVersion: "0.0.0",
    cliEntry: cli.entry,
    cliServeFile: cli.entry,
    brain: {
      version: brain.version,
      cliEntryPath: brain.entry,
      pid: 42,
      minCompatibleProtocol: (brain.protocol ?? OK).min,
      protocolVersion: (brain.protocol ?? OK).max,
      commandLine: brain.commandLine ?? null,
    },
    socketPath: "/Users/a/.ade/sock/ade.sock",
    adeHome: "/Users/a/.ade",
    platform: "darwin",
    exists: (candidate) => candidate === SEA,
    realpath: (candidate) => candidate,
  });
}

// An `ade` may repair only its own stale brain. Any other brain that speaks a
// compatible protocol is used as it is (ADE.app's CLI and the standalone brain
// update separately, so the skew window is normal), never stopped, replaced or
// uninstalled; an incompatible one is refused with one clear line.
describe("decideBrainSkew", () => {
  it.each([
    ["older CLI, newer compatible brain of another install", { version: "1.2.123", entry: APP_CLI }, { version: "1.2.125", entry: SEA }, "use"],
    ["newer CLI, older compatible brain of another install", { version: "1.2.126", entry: APP_CLI }, { version: "1.2.125", entry: SEA }, "use"],
    ["same release from another install", { version: "1.2.125", entry: APP_CLI }, { version: "1.2.125", entry: SEA }, "use"],
    ["older brain that does not say what it runs, not this CLI", { version: "1.2.126", entry: APP_CLI }, { version: "1.2.125", entry: null, commandLine: `${SEA} serve` }, "use"],
    ["its own stale build", { version: "1.2.126", entry: APP_CLI }, { version: "1.2.125", entry: APP_CLI }, "ours"],
    ["its own stale build that does not say what it runs", { version: "1.2.126", entry: APP_CLI }, { version: "1.2.125", entry: null, commandLine: `/Applications/ADE.app/Contents/MacOS/ADE ${APP_CLI} serve` }, "ours"],
    ["a newer brain on another protocol", { version: "1.2.123", entry: APP_CLI }, { version: "2.0.0", entry: SEA, protocol: FUTURE }, "refuse"],
  ] as const)("%s -> %s", (_label, cli, brain, kind) => {
    expect(decide(cli, brain).kind).toBe(kind);
  });

  it("notes the skew only when the versions differ, and refuses naming both versions and the matching ade", () => {
    const older = decide({ version: "1.2.123", entry: APP_CLI }, { version: "1.2.125", entry: SEA });
    expect(older.kind === "use" && older.note).toContain("v1.2.125");
    const same = decide({ version: "1.2.125", entry: APP_CLI }, { version: "1.2.125", entry: SEA });
    expect(same.kind === "use" && same.note).toBeNull();
    const refused = decide({ version: "1.2.123", entry: APP_CLI }, { version: "2.0.0", entry: null, protocol: FUTURE });
    const message = refused.kind === "refuse" ? refused.message : "";
    expect(message).toContain("v1.2.123");
    expect(message).toContain("v2.0.0");
    expect(message).toContain(SEA);
  });
});

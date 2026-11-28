import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CloudApiError, type CloudApiClient } from "../../../../desktop/src/shared/cloudApiClient";
import type { CloudLaunchStagesUpdate } from "../../../../account-directory/src/cloud/contract";
import { runCloudBootLaunch, takeCloudLaunch, type CloudBootLaunchDeps } from "./cloudBootLaunch";

const logger = { info: () => {}, warn: () => {} };
const LAUNCH = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";

/**
 * A server copy's fork gets its launch in a one-time file (it can't be given
 * env), and may carry its original's spent env launch. Each call is one brain
 * start; the entrypoint hands every start the same env again.
 */
describe("takeCloudLaunch: a server copy's join file", () => {
  const SPENT = "7f6e5d4c-3b2a-4190-8f7e-6d5c4b3a2910";
  const NEWER = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
  let adeDir: string;
  const joinFile = () => path.join(adeDir, "cloud", "launch-join.json");
  const spentEnv = (): NodeJS.ProcessEnv => ({ ADE_LAUNCH_ID: SPENT, ADE_LAUNCH_JOIN: "spent-code", PATH: "/usr/bin" });
  const hand = (body: string) => {
    fs.mkdirSync(path.dirname(joinFile()), { recursive: true });
    fs.writeFileSync(joinFile(), body, { mode: 0o600 });
  };

  beforeEach(() => {
    adeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-join-file-"));
  });
  afterEach(() => fs.rmSync(adeDir, { recursive: true, force: true }));

  it("reads the file once and deletes it; it wins over the copied env, whose launch every later start leaves alone", async () => {
    hand(JSON.stringify({ launchId: LAUNCH.toUpperCase(), join: "copy-code" }));
    const env = spentEnv();

    expect(takeCloudLaunch(adeDir, logger, env)).toEqual({ launchId: LAUNCH, joinCode: "copy-code" });
    expect(fs.existsSync(joinFile())).toBe(false);
    expect(env).toEqual({ PATH: "/usr/bin" });

    // The restarts after: the same spent env, no file.
    expect(takeCloudLaunch(adeDir, logger, spentEnv())).toBeNull();
    expect(takeCloudLaunch(adeDir, logger, spentEnv())).toBeNull();
    // A launch the env names anew is still taken.
    expect(takeCloudLaunch(adeDir, logger, { ADE_LAUNCH_ID: NEWER, ADE_LAUNCH_JOIN: "newer-code" })).toEqual({ launchId: NEWER, joinCode: "newer-code" });
  });

  it.each<[string, Record<string, string>, string | null, { launchId: string; joinCode: null } | null]>([
    ["on the same computer, before its launch ended, goes on with it, with no code", { ADE_HOST_INSTANCE_ID: "cloud:copy1" }, null, { launchId: LAUNCH, joinCode: null }],
    ["once its launch ended, takes none", { ADE_HOST_INSTANCE_ID: "cloud:copy1" }, "ended", null],
    ["on a copy of this computer, takes none", { ADE_HOST_INSTANCE_ID: "cloud:copy2" }, null, null],
    ["on a host that names no computer, takes none", {}, null, null],
  ])("a restart after the file was read, %s", async (_label, laterEnv, bootPhase, expected) => {
    hand(JSON.stringify({ launchId: LAUNCH, join: "copy-code" }));
    expect(takeCloudLaunch(adeDir, logger, { ...spentEnv(), ADE_HOST_INSTANCE_ID: "cloud:copy1" })).toEqual({ launchId: LAUNCH, joinCode: "copy-code" });
    if (bootPhase) fs.writeFileSync(path.join(adeDir, "cloud", "boot-launch.json"), JSON.stringify({ launchId: LAUNCH, phase: bootPhase }));

    expect(takeCloudLaunch(adeDir, logger, { ...spentEnv(), ...laterEnv })).toEqual(expected);
    // Never the code: only the launch is kept.
    const kept = fs.readdirSync(path.join(adeDir, "cloud")).map((name) => fs.readFileSync(path.join(adeDir, "cloud", name), "utf8")).join("\n");
    expect(kept).not.toContain("copy-code");
  });

  it.each([
    ["no file", null],
    ["a damaged file", "{\"launchId\": \"not-a-launch\", \"join\""],
  ])("with %s the env's launch is taken, and the file is gone", async (_label, body) => {
    if (body != null) hand(body);
    expect(takeCloudLaunch(adeDir, logger, spentEnv())).toEqual({ launchId: SPENT, joinCode: "spent-code" });
    expect(fs.existsSync(joinFile())).toBe(false);
  });
});

/**
 * A `machine` launch (a move's new computer, a new one from the phone): the
 * brain signs in and reports the launch done, with nothing else to set up.
 * The boot's state file is real, so a "restart" is a second run that reads it.
 */
describe("runCloudBootLaunch: a machine launch", () => {
  let dir: string;
  let stateFile: string;
  let reports: CloudLaunchStagesUpdate[];
  let reportFails: number;
  let launchState: string;
  let setUps: number;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-boot-launch-"));
    stateFile = path.join(dir, "cloud-launch.json");
    reports = [];
    reportFails = 0;
    launchState = "joined";
    setUps = 0;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const api = {
    launchStatus: async () => ({ launchId: LAUNCH, kind: "machine", state: launchState, request: null, stages: [] }),
    reportLaunchStages: async (_launchId: string, update: CloudLaunchStagesUpdate) => {
      if (reportFails > 0) {
        reportFails -= 1;
        throw new CloudApiError("ADE Cloud is busy.", "unavailable", 503);
      }
      reports.push(update);
      return {};
    },
  } as unknown as CloudApiClient;

  const boot = () => runCloudBootLaunch({
    launchId: LAUNCH,
    joinCode: null,
    instanceId: "madenew12345",
    stateFile,
    logger,
    api: () => api,
    account: {
      isSignedIn: () => true,
      startDeviceLogin: async () => { throw new Error("already signed in"); },
      pollDeviceLogin: async () => { throw new Error("already signed in"); },
    },
    approveHeadless: null,
    setUpProject: async () => {
      setUps += 1;
      throw new Error("a machine launch has no project");
    },
    launches: async () => { throw new Error("a machine launch starts no chat"); },
    sleep: async () => {},
  } satisfies CloudBootLaunchDeps);

  const doneReport = { state: "done", stages: [expect.objectContaining({ id: "computer", status: "done" }), expect.objectContaining({ id: "join", status: "done" })] };

  it("signed in, it reports the launch done with nothing set up, and a restart sends nothing again", async () => {
    await boot();
    expect(reports).toEqual([doneReport]);
    expect(setUps).toBe(0);

    launchState = "done";
    await boot();
    expect(reports).toHaveLength(1);
  });

  it("a done report that never landed is sent by the next boot", async () => {
    // Every try of this boot fails; the server is back for the next one.
    reportFails = 4;
    await boot();
    expect(reports).toEqual([]);

    await boot();
    expect(reports).toEqual([doneReport]);
    await boot();
    expect(reports).toHaveLength(1);
  });

  it("a launch the server already cancelled gets no report", async () => {
    launchState = "cancelled";
    await boot();
    expect(reports).toEqual([]);
    expect(setUps).toBe(0);
  });
});

/**
 * A join whose own sign-in link the computer couldn't finish (the headless
 * approval closed): the join claimed that link's code, and an approval page
 * refuses a claimed code, so the code a person is asked to approve must be a
 * fresh one.
 */
describe("runCloudBootLaunch: a join that needs a person's approval", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-boot-join-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("asks the person to approve a code the join's own link did not claim, and signs in with it", async () => {
    const minted: string[] = [];
    // The server's side: the first join claims its code for the link it answers with.
    const claimed = new Set<string>();
    const approvalCodes: string[] = [];
    const polls = new Map<string, number>();
    let signedIn = false;
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const api = {
      joinLaunch: async (_launchId: string, _instanceId: string, join: { needsApproval?: boolean; userCode?: string }) => {
        if (join.needsApproval) {
          const code = join.userCode ?? minted[0];
          approvalCodes.push(code);
          return { ok: true, state: "needs_approval", joinExpiresAt: Date.now() + 30 * 60_000 };
        }
        claimed.add(join.userCode!);
        return { url: "https://accounts.example/sign-in?__clerk_ticket=t", joinExpiresAt: Date.now() + 30 * 60_000 };
      },
      launchStatus: async () => ({ launchId: LAUNCH, kind: "machine", state: "joined", request: null, stages: [] }),
      reportLaunchStages: async () => ({}),
    } as unknown as CloudApiClient;

    await runCloudBootLaunch({
      launchId: LAUNCH,
      joinCode: "join-code-1234567890abcdef",
      instanceId: "macfresh1234",
      stateFile: path.join(dir, "cloud-launch.json"),
      logger,
      api: () => api,
      account: {
        isSignedIn: () => signedIn,
        startDeviceLogin: async () => {
          const userCode = `CODE-${minted.length + 1}`;
          minted.push(userCode);
          return { sessionId: userCode, userCode, intervalSec: 2, expiresAt };
        },
        // The person approves the code their page shows, which works only for a code no link claimed; a code
        // nobody can approve runs out.
        pollDeviceLogin: async (sessionId: string) => {
          if (approvalCodes.includes(sessionId) && !claimed.has(sessionId)) {
            signedIn = true;
            return { status: "signed_in" };
          }
          polls.set(sessionId, (polls.get(sessionId) ?? 0) + 1);
          return { status: (polls.get(sessionId) ?? 0) >= 3 ? "expired" : "pending" };
        },
      },
      approveHeadless: async () => "closed",
      setUpProject: async () => { throw new Error("a machine launch has no project"); },
      launches: async () => { throw new Error("a machine launch starts no chat"); },
      sleep: async () => {},
    } as unknown as CloudBootLaunchDeps);

    expect(approvalCodes).toHaveLength(1);
    expect(claimed.has(approvalCodes[0])).toBe(false);
    expect(signedIn).toBe(true);
  });
});

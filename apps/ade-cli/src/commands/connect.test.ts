import { describe, expect, it } from "vitest";

import {
  ConnectUsageError,
  type ConnectAccountStatus,
  type ConnectDeps,
  type ConnectMachine,
  type ConnectMachineList,
  type ConnectServiceStatus,
  parseConnectArgs,
  renderConnectSummary,
  runConnectCommand,
  serviceMechanismLabel,
} from "./connect";

const MACHINE_KEY = "a3f2c1d4e5b60718293a4b5c6d7e8f90";

type Calls = {
  login: number;
  installService: number;
  listMachines: number;
  sleeps: number[];
  progress: string[];
};

function makeDeps(
  overrides: Partial<ConnectDeps> & {
    account?: ConnectAccountStatus;
    service?: ConnectServiceStatus;
    machines?: ConnectMachine[];
    listState?: string;
  } = {},
): { deps: ConnectDeps; calls: Calls } {
  const calls: Calls = { login: 0, installService: 0, listMachines: 0, sleeps: [], progress: [] };
  let account = overrides.account ?? { signedIn: true, email: "arul@example.com" };
  let service = overrides.service ?? { installed: true, running: true };
  const machines = overrides.machines ?? [
    { machineKey: MACHINE_KEY, name: "Arul's MacBook Pro", online: true },
  ];
  // Virtual clock so poll timeouts do not spend real time.
  let clock = 0;

  const deps: ConnectDeps = {
    platform: "darwin",
    now: () => clock,
    sleep: async (ms) => {
      calls.sleeps.push(ms);
      clock += ms;
    },
    write: (text) => calls.progress.push(text),
    getAccountStatus: async () => account,
    runLogin: async () => {
      calls.login += 1;
      account = { signedIn: true, email: "arul@example.com", source: "loopback" };
      return account;
    },
    getServiceStatus: () => service,
    installService: async () => {
      calls.installService += 1;
      service = { installed: true, running: true };
      return { ok: true };
    },
    getMachineKey: () => MACHINE_KEY,
    listMachines: async (): Promise<ConnectMachineList> => {
      calls.listMachines += 1;
      return { state: overrides.listState ?? "ok", machines };
    },
    ...overrides,
  };
  return { deps, calls };
}

describe("parseConnectArgs", () => {
  it("defaults to a full interactive connect", () => {
    expect(parseConnectArgs([])).toEqual({
      statusOnly: false,
      login: true,
      service: true,
      headless: false,
      machineWaitMs: 60_000,
    });
  });

  it("accepts the documented flags in both spellings", () => {
    expect(parseConnectArgs(["--no-login", "--no-service", "--headless", "--timeout=30"]))
      .toMatchObject({ login: false, service: false, headless: true, machineWaitMs: 30_000 });
    expect(parseConnectArgs(["--status", "--timeout", "5"]))
      .toMatchObject({ statusOnly: true, machineWaitMs: 5_000 });
  });

  it("rejects unknown flags, positionals, and out-of-range timeouts", () => {
    expect(() => parseConnectArgs(["--nope"])).toThrow(ConnectUsageError);
    expect(() => parseConnectArgs(["extra"])).toThrow(ConnectUsageError);
    expect(() => parseConnectArgs(["--timeout", "abc"])).toThrow(ConnectUsageError);
    expect(() => parseConnectArgs(["--timeout", "0"])).toThrow(ConnectUsageError);
    expect(() => parseConnectArgs(["--timeout", "99999"])).toThrow(ConnectUsageError);
    expect(() => parseConnectArgs(["--timeout"])).toThrow(ConnectUsageError);
  });
});

describe("serviceMechanismLabel", () => {
  it("names the real per-platform mechanism", () => {
    // Windows persistence is an HKCU Run entry, not a service; the copy must
    // not promise a service that does not exist there.
    expect(serviceMechanismLabel("darwin")).toBe("launchd login service");
    expect(serviceMechanismLabel("linux")).toBe("systemd user service");
    expect(serviceMechanismLabel("win32")).toBe("per-user startup entry");
  });
});

describe("runConnectCommand", () => {
  it("takes a fast path when the machine is already connected", async () => {
    const { deps, calls } = makeDeps();
    const result = await runConnectCommand([], deps);

    expect(result.ok).toBe(true);
    expect(result.connected).toBe(true);
    expect(result.steps.map((step) => step.state)).toEqual(["ok", "ok", "ok"]);
    expect(result.machine).toMatchObject({
      machineKey: MACHINE_KEY,
      name: "Arul's MacBook Pro",
      published: true,
      online: true,
    });
    // No sign-in, no service mutation, and no polling loop.
    expect(calls.login).toBe(0);
    expect(calls.installService).toBe(0);
    expect(calls.listMachines).toBe(1);
    expect(calls.sleeps).toEqual([]);
  });

  it("signs in and installs the service when neither is present", async () => {
    const { deps, calls } = makeDeps({
      account: { signedIn: false },
      service: { installed: false, running: false },
    });
    const result = await runConnectCommand([], deps);

    expect(calls.login).toBe(1);
    expect(calls.installService).toBe(1);
    expect(result.connected).toBe(true);
    expect(result.account.identity).toBe("arul@example.com");
    expect(result.service).toMatchObject({ installed: true, running: true });
  });

  it("--no-login leaves the machine local-only but still installs the service", async () => {
    const { deps, calls } = makeDeps({
      account: { signedIn: false },
      service: { installed: false, running: false },
    });
    const result = await runConnectCommand(["--no-login"], deps);

    expect(calls.login).toBe(0);
    expect(calls.installService).toBe(1);
    expect(calls.listMachines).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.connected).toBe(false);
    expect(result.steps[0]).toMatchObject({ id: "account", state: "skipped" });
    expect(result.steps[1]).toMatchObject({ id: "service", state: "ok" });
    expect(result.steps[2]).toMatchObject({ id: "machine", state: "skipped" });
    expect(result.steps[2].detail).toContain("sign-in was skipped");
  });

  it("--no-service skips the service step and says so in the machine guidance", async () => {
    const { deps, calls } = makeDeps({ service: { installed: false, running: false } });
    const result = await runConnectCommand(["--no-service"], deps);

    expect(calls.installService).toBe(0);
    expect(result.service.skipped).toBe(true);
    expect(result.steps[1]).toMatchObject({ id: "service", state: "skipped" });
    expect(result.steps[1].detail).toContain("not installed, and --no-service");
  });

  it("skips the machine step and fails when sign-in fails mid-chain", async () => {
    const { deps, calls } = makeDeps({
      account: { signedIn: false },
      service: { installed: false, running: false },
      runLogin: async () => {
        throw new Error("device authorization expired");
      },
    });
    const result = await runConnectCommand([], deps);

    expect(result.ok).toBe(false);
    expect(result.connected).toBe(false);
    expect(result.steps[0]).toMatchObject({ id: "account", state: "failed" });
    expect(result.steps[0].detail).toBe("device authorization expired");
    // The service step still runs — it is useful on its own and makes a later
    // unattended `ade connect` succeed.
    expect(calls.installService).toBe(1);
    expect(result.steps[1]).toMatchObject({ id: "service", state: "ok" });
    // The machine step is skipped rather than polled: it cannot succeed.
    expect(result.steps[2]).toMatchObject({ id: "machine", state: "skipped" });
    expect(calls.listMachines).toBe(0);
    expect(result.nextAction).toContain("--headless");
  });

  it("treats a sign-in that reports not-signed-in as a failure", async () => {
    const { deps } = makeDeps({
      account: { signedIn: false },
      runLogin: async () => ({ signedIn: false }),
    });
    const result = await runConnectCommand([], deps);

    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({ id: "account", state: "failed" });
  });

  it("times out the directory poll with actionable guidance", async () => {
    const { deps, calls } = makeDeps({
      machines: [],
      getPublishHealth: async () => ({ state: "failing", reason: "no_active_sync_scope" }),
    });
    const result = await runConnectCommand(["--timeout", "10"], deps);

    expect(result.ok).toBe(false);
    expect(result.machine.published).toBe(false);
    expect(result.steps[2]).toMatchObject({ id: "machine", state: "failed" });
    expect(result.steps[2].detail).toContain("no_active_sync_scope");
    expect(result.nextAction).toContain("ade doctor");
    // Bounded: it polled until the 10s deadline at 2s intervals, then stopped.
    expect(calls.sleeps).toEqual([2000, 2000, 2000, 2000, 2000]);
    expect(calls.listMachines).toBe(6);
  });

  it("succeeds when the row appears part way through the poll", async () => {
    let attempts = 0;
    const { deps, calls } = makeDeps({
      listMachines: async () => {
        attempts += 1;
        return attempts < 3
          ? { state: "ok", machines: [] }
          : { state: "ok", machines: [{ machineKey: MACHINE_KEY, name: "box", online: true }] };
      },
    });
    const result = await runConnectCommand([], deps);

    expect(result.connected).toBe(true);
    expect(result.machine.name).toBe("box");
    expect(calls.sleeps).toEqual([2000, 2000]);
  });

  it("explains a signed-out directory rather than leaking the raw state", async () => {
    const { deps } = makeDeps({ machines: [], listState: "signed_out" });
    const result = await runConnectCommand(["--timeout", "1"], deps);

    expect(result.steps[2].detail).toContain("the ADE brain is not signed in");
    expect(result.steps[2].detail).not.toContain("signed_out");
  });

  it("--status reports without mutating anything or waiting", async () => {
    const { deps, calls } = makeDeps({
      account: { signedIn: false },
      service: { installed: false, running: false },
      machines: [],
    });
    const result = await runConnectCommand(["--status"], deps);

    expect(result.action).toBe("connect-status");
    expect(result.ok).toBe(false);
    expect(calls.login).toBe(0);
    expect(calls.installService).toBe(0);
    expect(calls.sleeps).toEqual([]);
    expect(result.steps[0]).toMatchObject({ id: "account", state: "failed" });
    expect(result.steps[1].detail).toContain("is not installed");
  });

  it("--status on a healthy machine is ok", async () => {
    const { deps, calls } = makeDeps();
    const result = await runConnectCommand(["--status"], deps);

    expect(result.ok).toBe(true);
    expect(result.connected).toBe(true);
    expect(calls.installService).toBe(0);
  });

  it("does not treat a self-mutation refusal as a service failure", async () => {
    // `ade connect` run from inside the brain it would replace: the service is
    // already doing its job, so refusing to reinstall is not an error.
    const { deps } = makeDeps({
      service: { installed: false, running: false },
      installService: async () => ({
        ok: false,
        selfMutationBlocked: true,
        message: "refusing to restart the brain that is running this command",
      }),
    });
    const result = await runConnectCommand([], deps);

    expect(result.ok).toBe(true);
    expect(result.steps[1]).toMatchObject({ id: "service", state: "ok" });
  });

  it("reports a real service install failure with a foreground fallback", async () => {
    const { deps } = makeDeps({
      service: { installed: false, running: false },
      installService: async () => ({ ok: false, message: "launchctl bootstrap failed" }),
    });
    const result = await runConnectCommand([], deps);

    expect(result.ok).toBe(false);
    expect(result.steps[1]).toMatchObject({ id: "service", state: "failed" });
    expect(result.steps[1].detail).toBe("launchctl bootstrap failed");
    expect(result.steps[1].nextAction).toContain("ade serve");
  });

  it("fails clearly when the machine has no sync identity yet", async () => {
    const { deps, calls } = makeDeps({ getMachineKey: () => null });
    const result = await runConnectCommand([], deps);

    expect(result.ok).toBe(false);
    expect(calls.listMachines).toBe(0);
    expect(result.steps[2].detail).toContain("no sync identity");
    expect(result.nextAction).toContain("ade brain start");
  });

  it("streams a checklist line per step and closes with undo guidance", async () => {
    const { deps, calls } = makeDeps();
    await runConnectCommand([], deps);
    const progress = calls.progress.join("");

    expect(progress).toContain("ADE connect");
    expect(progress).toContain("account");
    expect(progress).toContain("service");
    expect(progress).toContain("machine");
    expect(progress).toContain("ade logout");
    expect(progress).toContain("ade runtime uninstall-service");
    expect(progress).toContain("https://app.ade-app.dev");
  });
});

describe("renderConnectSummary", () => {
  it("is a single line in both outcomes", async () => {
    const { deps } = makeDeps();
    const connected = await runConnectCommand([], deps);
    expect(renderConnectSummary(connected)).toBe(
      'Connected as arul@example.com · machine "Arul\'s MacBook Pro"',
    );

    const { deps: offline } = makeDeps({ account: { signedIn: false } });
    const notConnected = await runConnectCommand(["--no-login"], offline);
    expect(renderConnectSummary(notConnected)).not.toContain("\n");
  });
});

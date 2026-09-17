import { describe, expect, it, vi } from "vitest";
import {
  MAC_DESKTOP_MACOS_ONLY_MESSAGE,
  MAC_DESKTOP_UNSUPPORTED_PLATFORM_CODE,
  type MacDesktopServiceApi,
  type MacDesktopStatus,
} from "../../../shared/types/macDesktop";
import {
  ADE_ACTION_ALLOWLIST,
  getAdeActionDomainServices,
  isAllowedAdeAction,
  isAutomationAllowedAdeAction,
  isCtoOnlyAdeAction,
  listAllowedAdeActionNames,
} from "./registry";

/**
 * The `mac_desktop` action domain.
 *
 * These are the two things a wiring bug actually breaks and a type cannot
 * catch: an action that is implemented but not allowlisted (callable in
 * process, refused over the bus) and an action that is allowlisted but not
 * implemented (advertised to an agent, throws when called). Both were live
 * defects in this repo's history, so both are asserted from the REAL registry
 * and the REAL allowlist rather than a stub of either.
 */

function macDesktopStatus(overrides: Partial<MacDesktopStatus> = {}): MacDesktopStatus {
  return {
    platform: "darwin",
    supported: true,
    unsupportedReason: null,
    driver: { state: "running", title: "", message: "", recovery: null, version: "1" },
    permissions: { screenRecording: "granted", accessibility: "granted" },
    displayMode: "virtual",
    display: null,
    windows: [],
    lease: null,
    stream: null,
    recording: null,
    lanes: [],
    hostIsLocal: true,
    ...overrides,
  };
}

/**
 * Every allowlisted method answers a marker, so a call that reached the service
 * is visible — and nothing else exists.
 *
 * Built from `ADE_ACTION_ALLOWLIST` rather than from a catch-all proxy: a proxy
 * that answers every property name cannot fail the test that matters, which is
 * the domain calling a method the service does not have. Reading an unknown
 * property here throws with the name.
 */
function fakeMacDesktopService(
  status: MacDesktopStatus,
): { service: MacDesktopServiceApi; calls: Array<{ method: string; args: unknown }> } {
  const calls: Array<{ method: string; args: unknown }> = [];
  const methods: Record<string, unknown> = {
    getStatus: (args: unknown) => {
      calls.push({ method: "getStatus", args });
      return Promise.resolve(status);
    },
    dispose: () => undefined,
  };
  for (const method of ADE_ACTION_ALLOWLIST.mac_desktop ?? []) {
    if (method in methods) continue;
    methods[method] = (args: unknown) => {
      calls.push({ method, args });
      return Promise.resolve({ method, args });
    };
  }
  const service = new Proxy(methods as MacDesktopServiceApi, {
    get: (target, property) => {
      // `then` is probed by `await` on the object itself; a symbol is never a
      // method name. Neither is the domain reaching for something it needs.
      if (typeof property === "symbol" || property === "then") return undefined;
      if (!(property in target)) {
        throw new Error(`mac_desktop action domain reached for an unimplemented service method: ${property}`);
      }
      return (target as Record<string, unknown>)[property];
    },
  });
  return { service, calls };
}

function domainService(service: MacDesktopServiceApi | null): Record<string, unknown> | null {
  const services = getAdeActionDomainServices({ macDesktopService: service } as never) as Record<
    string,
    Record<string, unknown> | null
  >;
  return services.mac_desktop ?? null;
}

describe("mac_desktop action domain", () => {
  it("is absent, not empty, when the runtime has no Mac Desktop service", () => {
    // A null domain makes `run_ade_action` answer "unavailable in this
    // runtime". An empty object would advertise a domain whose every action
    // throws — the runtime-backed null-service bug class.
    expect(domainService(null)).toBeNull();
  });

  it("implements every action it allowlists, and allowlists every action it implements", () => {
    const { service } = fakeMacDesktopService(macDesktopStatus());
    const built = domainService(service);
    expect(built).not.toBeNull();

    const allowlisted = [...(ADE_ACTION_ALLOWLIST.mac_desktop ?? [])].sort();
    const implemented = Object.keys(built!)
      .filter((key) => typeof built![key] === "function")
      .sort();

    expect(implemented).toEqual(allowlisted);
    // `listAllowedAdeActionNames` intersects the two, so it must lose nothing.
    expect(listAllowedAdeActionNames("mac_desktop", built!)).toEqual(allowlisted);
  });

  it("classifies reads and writes: agents get them, the stream token and takeover are cto-only", () => {
    const agentActions = [
      // reads
      "getStatus",
      "listWindows",
      "observe",
      "getStreamStatus",
      // writes
      "start",
      "stop",
      "open",
      "claimWindow",
      "releaseWindow",
      "click",
      "type",
      "press",
      "scroll",
      "drag",
      "wait",
      "screenshot",
      "startRecording",
      "stopRecording",
      "requestInputLease",
      "present",
    ];
    for (const action of agentActions) {
      expect(isAllowedAdeAction("mac_desktop", action), action).toBe(true);
      expect(isCtoOnlyAdeAction("mac_desktop", action), action).toBe(false);
      expect(isAutomationAllowedAdeAction("mac_desktop", action), action).toBe(true);
    }
    // `startStream` is the ONLY call that mints the loopback stream token, and
    // the takeover trio is a human client's. All are reachable, none by an
    // agent-role caller.
    for (const action of ["startStream", "stopStream", "takeControl", "returnControl", "renewLease"]) {
      expect(isAllowedAdeAction("mac_desktop", action), action).toBe(true);
      expect(isCtoOnlyAdeAction("mac_desktop", action), action).toBe(true);
      expect(isAutomationAllowedAdeAction("mac_desktop", action), action).toBe(false);
    }
    // Proof is filed through `ingest_computer_use_artifacts` only. A
    // `mac_desktop.proof` action would be a second ingestion path.
    expect(isAllowedAdeAction("mac_desktop", "proof")).toBe(false);
  });

  it("rejects every action but getStatus off macOS, with the code and the one sentence", async () => {
    const status = macDesktopStatus({
      platform: "win32",
      supported: false,
      unsupportedReason: MAC_DESKTOP_MACOS_ONLY_MESSAGE,
      displayMode: "unavailable",
    });
    const { service, calls } = fakeMacDesktopService(status);
    const built = domainService(service)!;

    // The capability read still answers — a non-Mac client learns it cannot
    // host a display by READING, and a read that throws cannot tell it.
    await expect(built.getStatus as never).toBeTypeOf("function");
    await expect((built.getStatus as (a?: unknown) => Promise<unknown>)({})).resolves.toMatchObject({
      supported: false,
      unsupportedReason: MAC_DESKTOP_MACOS_ONLY_MESSAGE,
    });

    for (const action of ["start", "observe", "click", "screenshot", "startStream", "present"]) {
      const call = built[action] as (args?: unknown) => Promise<unknown>;
      await expect(call({ laneId: "lane-1", target: "x", direction: "up", destination: "main" }), action)
        .rejects.toThrow(
          new RegExp(`${MAC_DESKTOP_UNSUPPORTED_PLATFORM_CODE}.*${MAC_DESKTOP_MACOS_ONLY_MESSAGE}`),
        );
    }
    // The gate refused before anything reached the service.
    expect(calls.filter((entry) => entry.method !== "getStatus")).toEqual([]);
  });

  it("validates inputs before the service sees them", async () => {
    const { service } = fakeMacDesktopService(macDesktopStatus());
    const built = domainService(service)!;
    const call = (action: string, args: unknown) =>
      (built[action] as (a?: unknown) => Promise<unknown>)(args);

    await expect(call("start", {})).rejects.toThrow(/requires laneId/);
    await expect(call("observe", { laneId: "  " })).rejects.toThrow(/requires laneId/);
    await expect(call("claimWindow", { laneId: "lane-1" })).rejects.toThrow(/requires windowId/);
    await expect(call("open", { laneId: "lane-1" })).rejects.toThrow(/requires target/);
    await expect(call("click", { laneId: "lane-1" })).rejects.toThrow(/handle, text, or x\/y/);
    await expect(call("scroll", { laneId: "lane-1", direction: "sideways" }))
      .rejects.toThrow(/unknown direction 'sideways'/);
    await expect(call("wait", { laneId: "lane-1" })).rejects.toThrow(/text, gone, or windowTitle/);
    await expect(call("press", { laneId: "lane-1", key: "a", modifiers: ["hyper"] }))
      .rejects.toThrow(/unknown modifier 'hyper'/);
    await expect(call("present", { laneId: "lane-1", destination: "elsewhere" }))
      .rejects.toThrow(/unknown destination 'elsewhere'/);
    await expect(call("requestInputLease", { laneId: "lane-1" }))
      .rejects.toThrow(/requires chatSessionId/);
  });

  it("passes a resolved target through to the service", async () => {
    const { service, calls } = fakeMacDesktopService(macDesktopStatus());
    const built = domainService(service)!;
    await (built.click as (a: unknown) => Promise<unknown>)({
      laneId: "lane-1",
      handle: "obs-a1:e:3",
      mode: "real",
      count: 2,
    });
    const click = calls.find((entry) => entry.method === "click");
    expect(click?.args).toMatchObject({
      laneId: "lane-1",
      handle: "obs-a1:e:3",
      mode: "real",
      count: 2,
    });
  });
});

describe("mac_desktop prompt-free default", () => {
  it("does not appear in a runtime with no service wired", () => {
    const services = getAdeActionDomainServices({} as never) as Record<string, unknown>;
    expect(services.mac_desktop ?? null).toBeNull();
    expect(vi.isMockFunction(services.mac_desktop)).toBe(false);
  });
});

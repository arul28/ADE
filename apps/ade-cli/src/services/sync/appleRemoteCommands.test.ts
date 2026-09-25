import { describe, expect, it, vi } from "vitest";

import {
  APPLE_OWNED_BY_OTHER_SESSION_CODE,
  assertAppleInputAllowed,
  buildAppleStatusPayload,
  createAppleRemoteCommandHandlers,
  type AppleDeviceRemoteService,
} from "./appleRemoteCommands";

const RAW_STATUS = {
  supported: true,
  activeDevice: { udid: "UDID-1", name: "iPhone 17 Pro", runtime: "iOS 26.0", state: "Booted" },
  laneDevice: { udid: "UDID-1", name: "iPhone 17 Pro", origin: "clone", family: "iphone" },
  activeSession: { chatSessionId: "chat-owner", bundleId: "com.acme.MyApp", deviceUdid: "UDID-1" },
  deviceSession: null,
  stream: { running: true, codec: "avc1.42E01E", width: 393, height: 852, bitrateKbps: 2500, fps: 30, lastError: null },
};

function service(overrides: Partial<AppleDeviceRemoteService> = {}): AppleDeviceRemoteService {
  return {
    getStatus: vi.fn(async () => RAW_STATUS),
    startStream: vi.fn(async () => ({ transport: { url: "http://127.0.0.1:1/s", token: "t", codec: "avc1", width: 393, height: 852 } })),
    stopStream: vi.fn(async () => ({})),
    tap: vi.fn(async () => ({ ok: true })),
    typeText: vi.fn(async () => ({ ok: true })),
    drag: vi.fn(async () => ({ ok: true })),
    tapElement: vi.fn(async () => ({ ok: true })),
    openUrl: vi.fn(async () => ({ ok: true })),
    deviceCreate: vi.fn(async () => ({})),
    deviceAttach: vi.fn(async () => ({})),
    deviceList: vi.fn(async () => ({ installed: [], lane: null })),
    recordStart: vi.fn(async () => ({})),
    recordStop: vi.fn(async () => null),
    recordList: vi.fn(async () => []),
    ...overrides,
  } as AppleDeviceRemoteService;
}

function handlersFor(target = service()) {
  const issue = vi.fn(() => ({
    url: null,
    path: "/apple/stream/abc",
    token: "tok",
    ticket: "abc",
    codec: "avc1",
    width: 393,
    height: 852,
    expiresAt: "2026-01-01T00:00:00.000Z",
  }));
  const entries = createAppleRemoteCommandHandlers({
    service: target,
    streamRelay: { issue },
    remoteBitrateKbpsCap: () => 1000,
  });
  const byAction = new Map(entries.map((entry) => [entry.action as string, entry]));
  return { entries, byAction, issue, target };
}

describe("buildAppleStatusPayload", () => {
  it("names the lane's own device, and nothing for the host's any-booted fallback", () => {
    // The phone's simulator chip needs `laneDevice` to match `device`, so it
    // never offers a device another lane holds (review finding A3-F4).
    const owned = buildAppleStatusPayload("lane-a", {
      activeDevice: { udid: "U1", name: "iPhone 16 Pro", state: "Booted" },
      laneDevice: { udid: "U1", name: "iPhone 16 Pro", family: "iphone", origin: "clone" },
    });
    expect(owned.laneDevice).toEqual({ udid: "U1" });
    expect(owned.device?.udid).toBe("U1");

    const fallback = buildAppleStatusPayload("lane-b", {
      activeDevice: { udid: "U2", name: "iPhone 17", state: "Booted" },
    });
    expect(fallback.device?.udid).toBe("U2");
    expect(fallback.laneDevice).toBeNull();
  });

  it("projects the service status into the wire shape without a secret", () => {
    const payload = buildAppleStatusPayload("lane-a", RAW_STATUS);
    expect(payload.device).toEqual({
      udid: "UDID-1",
      name: "iPhone 17 Pro",
      family: "iphone",
      runtime: "iOS 26.0",
      origin: "clone",
      state: "Booted",
    });
    expect(payload.owner).toEqual({ chatSessionId: "chat-owner", chatTitle: null });
    expect(payload.stream.running).toBe(true);
    expect(JSON.stringify(payload)).not.toContain("token");
  });

  it("says so when the machine cannot run simulators", () => {
    expect(buildAppleStatusPayload("lane-a", { supported: false }).unavailable).toMatch(/cannot run/);
  });
});

describe("assertAppleInputAllowed", () => {
  const owned = buildAppleStatusPayload("lane-a", RAW_STATUS);

  it("lets the owning chat drive", () => {
    expect(() => assertAppleInputAllowed(owned, "chat-owner")).not.toThrow();
  });

  it("refuses another chat with the cooperative error", () => {
    expect(() => assertAppleInputAllowed(owned, "chat-other"))
      .toThrow(new RegExp(APPLE_OWNED_BY_OTHER_SESSION_CODE));
  });

  it("refuses an anonymous remote caller rather than treating it as the owner", () => {
    expect(() => assertAppleInputAllowed(owned, null))
      .toThrow(new RegExp(APPLE_OWNED_BY_OTHER_SESSION_CODE));
  });

  it("lets anyone drive an unclaimed device", () => {
    const unclaimed = buildAppleStatusPayload("lane-a", { ...RAW_STATUS, activeSession: null });
    expect(() => assertAppleInputAllowed(unclaimed, null)).not.toThrow();
  });
});

describe("apple.* remote command handlers", () => {
  it("makes status and the ticket viewer-allowed, and input controller-only", () => {
    const { byAction } = handlersFor();
    expect(byAction.get("apple.status")?.policy.viewerAllowed).toBe(true);
    expect(byAction.get("apple.streamTicket")?.policy.viewerAllowed).toBe(true);
    expect(byAction.get("apple.input")?.policy).toEqual({ viewerAllowed: false, controllerAllowed: true });
  });

  it("names the claiming chat so a viewer with no roster can render the ribbon", async () => {
    const resolveChatTitle = vi.fn(async () => "Fix the sign-in sheet");
    const entries = createAppleRemoteCommandHandlers({
      service: service(),
      streamRelay: null,
      resolveChatTitle,
    });
    const status = await entries.find((entry) => entry.action === "apple.status")!
      .handler({ laneId: "lane-a" }) as { owner: { chatSessionId: string; chatTitle: string } };
    expect(resolveChatTitle).toHaveBeenCalledWith("chat-owner");
    expect(status.owner).toEqual({ chatSessionId: "chat-owner", chatTitle: "Fix the sign-in sheet" });
  });

  it("treats a whitespace-only title as no title, so no client has to re-trim", async () => {
    const entries = createAppleRemoteCommandHandlers({
      service: service(),
      streamRelay: null,
      resolveChatTitle: async () => "   ",
    });
    const status = await entries.find((entry) => entry.action === "apple.status")!
      .handler({ laneId: "lane-a" }) as { owner: { chatTitle: string | null } };
    expect(status.owner.chatTitle).toBeNull();
  });

  it("keeps the device card when the chat lookup fails", async () => {
    const entries = createAppleRemoteCommandHandlers({
      service: service(),
      streamRelay: null,
      resolveChatTitle: async () => {
        throw new Error("chat store is restarting");
      },
    });
    const status = await entries.find((entry) => entry.action === "apple.status")!
      .handler({ laneId: "lane-a" }) as { owner: { chatTitle: string | null }; device: unknown };
    expect(status.owner.chatTitle).toBeNull();
    expect(status.device).not.toBeNull();
  });

  it("returns the raw status only when the caller asks for it", async () => {
    const { byAction } = handlersFor();
    const lean = await byAction.get("apple.status")!.handler({ laneId: "lane-a" }) as Record<string, unknown>;
    expect(lean.raw).toBeUndefined();
    const full = await byAction.get("apple.status")!.handler({ laneId: "lane-a", full: true }) as Record<string, unknown>;
    expect(full.raw).toEqual(RAW_STATUS);
  });

  it("starts the stream at the remote cap before issuing a ticket", async () => {
    const { byAction, issue, target } = handlersFor();
    const ticket = await byAction.get("apple.streamTicket")!.handler({ laneId: "lane-a" });
    expect(target.startStream).toHaveBeenCalledWith({
      laneId: "lane-a",
      chatSessionId: null,
      bitrateKbps: 1000,
    });
    expect(issue).toHaveBeenCalledWith({ laneId: "lane-a", codec: "avc1", width: 393, height: 852 });
    expect(ticket).toMatchObject({ path: "/apple/stream/abc", token: "tok" });
  });

  it("a viewer's ticket on a device that is off is refused with APPLE_DEVICE_OFF, and no ticket is issued", async () => {
    const off = Object.assign(new Error("APPLE_DEVICE_OFF: iPhone 17 Pro is off. Watching a device never boots it."), {
      code: "APPLE_DEVICE_OFF",
    });
    const { byAction, issue, target } = handlersFor(service({ startStream: vi.fn(async () => { throw off; }) }));
    await expect(byAction.get("apple.streamTicket")!.handler({ laneId: "lane-a" }))
      .rejects.toThrow(/^APPLE_DEVICE_OFF: iPhone 17 Pro is off\./);
    // Watching never asks for a boot.
    expect(target.startStream).toHaveBeenCalledWith(expect.not.objectContaining({ boot: true }));
    expect(issue).not.toHaveBeenCalled();
  });

  it("drives the device for the owning chat", async () => {
    const { byAction, target } = handlersFor();
    await byAction.get("apple.input")!.handler({
      laneId: "lane-a",
      chatSessionId: "chat-owner",
      kind: "tap",
      x: 10,
      y: 20,
    });
    expect(target.tap).toHaveBeenCalledWith({ laneId: "lane-a", chatSessionId: "chat-owner", x: 10, y: 20 });
  });

  it("refuses input from a chat that does not own the device", async () => {
    const { byAction, target } = handlersFor();
    await expect(byAction.get("apple.input")!.handler({
      laneId: "lane-a",
      chatSessionId: "chat-other",
      kind: "tap",
      x: 1,
      y: 2,
    })).rejects.toThrow(new RegExp(APPLE_OWNED_BY_OTHER_SESSION_CODE));
    expect(target.tap).not.toHaveBeenCalled();
  });

  it("refuses an unknown input kind", async () => {
    const { byAction } = handlersFor();
    await expect(byAction.get("apple.input")!.handler({
      laneId: "lane-a",
      chatSessionId: "chat-owner",
      kind: "shake",
    })).rejects.toThrow(/does not support 'shake'/);
  });

  it("refuses recording control from another chat", async () => {
    const { byAction, target } = handlersFor();
    await expect(byAction.get("apple.recordStart")!.handler({
      laneId: "lane-a",
      chatSessionId: "chat-other",
    })).rejects.toThrow(new RegExp(APPLE_OWNED_BY_OTHER_SESSION_CODE));
    expect(target.recordStart).not.toHaveBeenCalled();
  });

  it("passes an allowlisted method through apple.invoke and guards the mutating ones", async () => {
    const screenshot = vi.fn(async () => ({ path: "/tmp/a.png" }));
    const relaunchApp = vi.fn(async () => ({ ok: true }));
    const { byAction } = handlersFor(service({ screenshot, relaunchApp } as never));
    await byAction.get("apple.invoke")!.handler({
      laneId: "lane-a",
      chatSessionId: "chat-other",
      method: "screenshot",
      args: {},
    });
    expect(screenshot).toHaveBeenCalled();
    await expect(byAction.get("apple.invoke")!.handler({
      laneId: "lane-a",
      chatSessionId: "chat-other",
      method: "relaunchApp",
      args: {},
    })).rejects.toThrow(new RegExp(APPLE_OWNED_BY_OTHER_SESSION_CODE));
    expect(relaunchApp).not.toHaveBeenCalled();
  });

  it("refuses a method outside the ios_simulator allowlist", async () => {
    const { byAction } = handlersFor(service({ dispose: vi.fn() } as never));
    await expect(byAction.get("apple.invoke")!.handler({
      laneId: "lane-a",
      method: "dispose",
    })).rejects.toThrow(/does not allow 'dispose'/);
  });

  it("registers nothing when the runtime has no simulator service", () => {
    expect(createAppleRemoteCommandHandlers({
      service: service(),
      streamRelay: null,
    }).some((entry) => entry.action === "apple.streamTicket")).toBe(true);
  });

  it("fails the ticket clearly when no relay exists", async () => {
    const entries = createAppleRemoteCommandHandlers({ service: service(), streamRelay: null });
    const ticket = entries.find((entry) => entry.action === "apple.streamTicket")!;
    await expect(ticket.handler({ laneId: "lane-a" })).rejects.toThrow(/relay is not available/);
  });
});

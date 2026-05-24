import { describe, expect, it, vi } from "vitest";
import type {
  ApnsBridgeSaveConfigArgs,
  ApnsBridgeUploadKeyArgs,
} from "../../../shared/types/sync";
import { createApnsBridgeService } from "./apnsBridgeService";
import type { ApnsEnvelope, ApnsSendResult } from "./apnsService";

type ApnsConfigSnapshot = {
  enabled: boolean;
  keyId: string;
  teamId: string;
  bundleId: string;
  env: "sandbox" | "production";
};

function makeProjectConfigService(initial: {
  apns?: Partial<ApnsConfigSnapshot> | null;
  shared?: Record<string, unknown>;
  local?: Record<string, unknown>;
}) {
  const state = {
    shared: initial.shared ?? {},
    local: initial.local ?? {},
    apns: initial.apns ?? null,
  };
  const save = vi.fn(
    (
      next: { shared: Record<string, unknown>; local: Record<string, unknown> },
    ) => {
      state.shared = next.shared;
      state.local = next.local;
      const notifications =
        next.shared.notifications as Record<string, unknown> | undefined;
      const apns = notifications?.apns as Partial<ApnsConfigSnapshot> | undefined;
      state.apns = apns ?? null;
    },
  );
  const get = vi.fn(() => ({
    shared: state.shared,
    local: state.local,
    effective: {
      notifications: state.apns ? { apns: state.apns } : undefined,
    },
  }));
  return { get, save, _state: state };
}

function makeKeyStore(initialPem: string | null = null) {
  let stored = initialPem;
  return {
    has: vi.fn(() => stored !== null),
    load: vi.fn(() => stored),
    save: vi.fn((pem: string) => {
      stored = pem;
    }),
    clear: vi.fn(() => {
      stored = null;
    }),
  };
}

function makeApnsService(overrides?: {
  isConfigured?: boolean;
  sendResult?: ApnsSendResult;
  configureThrows?: Error;
}) {
  return {
    configure: vi.fn(() => {
      if (overrides?.configureThrows) {
        throw overrides.configureThrows;
      }
    }),
    isConfigured: vi.fn(() => overrides?.isConfigured ?? false),
    reset: vi.fn(async () => {}),
    send: vi.fn(
      async (_envelope: ApnsEnvelope): Promise<ApnsSendResult> =>
        overrides?.sendResult ?? { ok: true, status: 200 },
    ),
  };
}

function makeDeviceRegistry(devices: any[]) {
  return {
    listDevices: vi.fn(() => devices),
  };
}

const baseConfig: ApnsBridgeSaveConfigArgs = {
  enabled: true,
  keyId: "ABCDE12345",
  teamId: "12345ABCDE",
  bundleId: "com.ade.ios",
  env: "sandbox",
};

describe("apnsBridgeService.getStatus", () => {
  it("reflects enabled/configured/keyStored independently from the underlying services", async () => {
    const projectConfigService = makeProjectConfigService({
      apns: { ...baseConfig },
    });
    const apnsKeyStore = makeKeyStore("PEM");
    const apnsService = makeApnsService({ isConfigured: true });

    const bridge = createApnsBridgeService({
      projectConfigService: projectConfigService as any,
      apnsService: apnsService as any,
      apnsKeyStore: apnsKeyStore as any,
    });

    await expect(bridge.getStatus()).resolves.toEqual({
      enabled: true,
      configured: true,
      keyStored: true,
      keyId: "ABCDE12345",
      teamId: "12345ABCDE",
      bundleId: "com.ade.ios",
      env: "sandbox",
    });
  });

  it("defaults to a sandbox/disabled status when no project config exists", async () => {
    const bridge = createApnsBridgeService({
      projectConfigService: null,
      apnsService: null,
      apnsKeyStore: null,
    });

    await expect(bridge.getStatus()).resolves.toEqual({
      enabled: false,
      configured: false,
      keyStored: false,
      keyId: null,
      teamId: null,
      bundleId: null,
      env: "sandbox",
    });
  });

  it("coerces unrecognized env values to sandbox", async () => {
    const projectConfigService = makeProjectConfigService({
      apns: { ...baseConfig, env: "weird-env" as any },
    });
    const bridge = createApnsBridgeService({
      projectConfigService: projectConfigService as any,
      apnsService: null,
      apnsKeyStore: null,
    });

    await expect(bridge.getStatus()).resolves.toMatchObject({ env: "sandbox" });
  });
});

describe("apnsBridgeService.saveConfig", () => {
  it("disables and resets the apns service without configuring it", async () => {
    const projectConfigService = makeProjectConfigService({
      apns: { ...baseConfig, enabled: true },
    });
    const apnsKeyStore = makeKeyStore("PEM");
    const apnsService = makeApnsService({ isConfigured: true });

    const bridge = createApnsBridgeService({
      projectConfigService: projectConfigService as any,
      apnsService: apnsService as any,
      apnsKeyStore: apnsKeyStore as any,
    });

    const result = await bridge.saveConfig({ ...baseConfig, enabled: false });

    expect(apnsService.configure).not.toHaveBeenCalled();
    expect(apnsService.reset).toHaveBeenCalledTimes(1);
    expect(projectConfigService.save).toHaveBeenCalledTimes(1);
    expect(result.enabled).toBe(false);
  });

  it("configures the apns service when enabling with a stored key", async () => {
    const projectConfigService = makeProjectConfigService({});
    const apnsKeyStore = makeKeyStore("PEM-DATA");
    const apnsService = makeApnsService({ isConfigured: true });

    const bridge = createApnsBridgeService({
      projectConfigService: projectConfigService as any,
      apnsService: apnsService as any,
      apnsKeyStore: apnsKeyStore as any,
    });

    await bridge.saveConfig(baseConfig);

    expect(apnsService.configure).toHaveBeenCalledWith({
      keyP8Pem: "PEM-DATA",
      keyId: "ABCDE12345",
      teamId: "12345ABCDE",
      bundleId: "com.ade.ios",
      env: "sandbox",
    });
    expect(projectConfigService.save).toHaveBeenCalledTimes(1);
  });

  it("resets the apns service when enabling without a stored key", async () => {
    const projectConfigService = makeProjectConfigService({});
    const apnsKeyStore = makeKeyStore(null);
    const apnsService = makeApnsService();

    const bridge = createApnsBridgeService({
      projectConfigService: projectConfigService as any,
      apnsService: apnsService as any,
      apnsKeyStore: apnsKeyStore as any,
    });

    await bridge.saveConfig(baseConfig);

    expect(apnsService.configure).not.toHaveBeenCalled();
    expect(apnsService.reset).toHaveBeenCalledTimes(1);
    expect(projectConfigService.save).toHaveBeenCalledTimes(1);
  });

  it("wraps a configure() failure with a contextual error message", async () => {
    const projectConfigService = makeProjectConfigService({});
    const apnsKeyStore = makeKeyStore("PEM");
    const apnsService = makeApnsService({
      configureThrows: new Error("bad keyId"),
    });

    const bridge = createApnsBridgeService({
      projectConfigService: projectConfigService as any,
      apnsService: apnsService as any,
      apnsKeyStore: apnsKeyStore as any,
    });

    await expect(bridge.saveConfig(baseConfig)).rejects.toThrow(
      /APNs configure failed: bad keyId/,
    );
    expect(projectConfigService.save).not.toHaveBeenCalled();
  });
});

describe("apnsBridgeService.uploadKey", () => {
  it("refuses to upload an empty .p8 payload", async () => {
    const apnsKeyStore = makeKeyStore(null);
    const bridge = createApnsBridgeService({
      projectConfigService: null,
      apnsService: null,
      apnsKeyStore: apnsKeyStore as any,
    });

    await expect(bridge.uploadKey({ p8Pem: "   " })).rejects.toThrow(/Empty/);
    expect(apnsKeyStore.save).not.toHaveBeenCalled();
  });

  it("refuses to upload when the keystore is unavailable", async () => {
    const bridge = createApnsBridgeService({
      projectConfigService: null,
      apnsService: null,
      apnsKeyStore: null,
    });

    await expect(
      bridge.uploadKey({ p8Pem: "-----BEGIN PRIVATE KEY-----" } as ApnsBridgeUploadKeyArgs),
    ).rejects.toThrow(/ApnsKeyStore unavailable/);
  });

  it("hot-reconfigures the apns service when a project is already enabled", async () => {
    const projectConfigService = makeProjectConfigService({
      apns: { ...baseConfig, enabled: true, env: "production" },
    });
    const apnsKeyStore = makeKeyStore(null);
    const apnsService = makeApnsService();

    const bridge = createApnsBridgeService({
      projectConfigService: projectConfigService as any,
      apnsService: apnsService as any,
      apnsKeyStore: apnsKeyStore as any,
    });

    await bridge.uploadKey({ p8Pem: "  PEM-PAYLOAD  " });

    expect(apnsService.configure).toHaveBeenCalledWith({
      keyP8Pem: "PEM-PAYLOAD",
      keyId: "ABCDE12345",
      teamId: "12345ABCDE",
      bundleId: "com.ade.ios",
      env: "production",
    });
    expect(apnsKeyStore.save).toHaveBeenCalledWith("PEM-PAYLOAD");
  });

  it("stores the key without configuring when the project is disabled", async () => {
    const projectConfigService = makeProjectConfigService({
      apns: { ...baseConfig, enabled: false },
    });
    const apnsKeyStore = makeKeyStore(null);
    const apnsService = makeApnsService();

    const bridge = createApnsBridgeService({
      projectConfigService: projectConfigService as any,
      apnsService: apnsService as any,
      apnsKeyStore: apnsKeyStore as any,
    });

    await bridge.uploadKey({ p8Pem: "PEM-PAYLOAD" });

    expect(apnsService.configure).not.toHaveBeenCalled();
    expect(apnsKeyStore.save).toHaveBeenCalledWith("PEM-PAYLOAD");
  });
});

describe("apnsBridgeService.clearKey", () => {
  it("clears the keystore and resets the apns service", async () => {
    const apnsKeyStore = makeKeyStore("PEM");
    const apnsService = makeApnsService({ isConfigured: true });

    const bridge = createApnsBridgeService({
      projectConfigService: null,
      apnsService: apnsService as any,
      apnsKeyStore: apnsKeyStore as any,
    });

    const status = await bridge.clearKey();

    expect(apnsKeyStore.clear).toHaveBeenCalledTimes(1);
    expect(apnsService.reset).toHaveBeenCalledTimes(1);
    expect(status.keyStored).toBe(false);
  });
});

describe("apnsBridgeService.sendTestPush", () => {
  function withConfig(extra?: Partial<ApnsConfigSnapshot>) {
    return makeProjectConfigService({
      apns: { ...baseConfig, ...extra },
    });
  }

  function iosDevice(metadata: Record<string, unknown>) {
    return {
      deviceId: "iphone-1",
      platform: "iOS",
      deviceType: "phone",
      metadata,
    };
  }

  it("returns ok=false when the apns service is not configured", async () => {
    const apnsService = makeApnsService({ isConfigured: false });
    const bridge = createApnsBridgeService({
      projectConfigService: withConfig() as any,
      apnsService: apnsService as any,
      apnsKeyStore: makeKeyStore() as any,
      getDeviceRegistryService: () => makeDeviceRegistry([]) as any,
    });

    const result = await bridge.sendTestPush({});
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not configured/i);
    expect(apnsService.send).not.toHaveBeenCalled();
  });

  it("returns ok=false when no iOS devices are registered", async () => {
    const apnsService = makeApnsService({ isConfigured: true });
    const bridge = createApnsBridgeService({
      projectConfigService: withConfig() as any,
      apnsService: apnsService as any,
      apnsKeyStore: makeKeyStore() as any,
      getDeviceRegistryService: () =>
        makeDeviceRegistry([
          { deviceId: "mac-1", platform: "macOS", deviceType: "desktop", metadata: {} },
          { deviceId: "ipad-1", platform: "iOS", deviceType: "tablet", metadata: {} },
        ]) as any,
    });

    const result = await bridge.sendTestPush({});
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no paired ios device/i);
  });

  it("requires an alert token when sending a generic alert push", async () => {
    const apnsService = makeApnsService({ isConfigured: true });
    const bridge = createApnsBridgeService({
      projectConfigService: withConfig() as any,
      apnsService: apnsService as any,
      apnsKeyStore: makeKeyStore() as any,
      getDeviceRegistryService: () =>
        makeDeviceRegistry([iosDevice({})]) as any,
    });

    const result = await bridge.sendTestPush({ kind: "generic" });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no APNs alert token/i);
    expect(apnsService.send).not.toHaveBeenCalled();
  });

  it("sends a generic alert push to the device's bundle id with priority 10", async () => {
    const apnsService = makeApnsService({
      isConfigured: true,
      sendResult: { ok: true, status: 200 },
    });
    const bridge = createApnsBridgeService({
      projectConfigService: withConfig({ env: "production" }) as any,
      apnsService: apnsService as any,
      apnsKeyStore: makeKeyStore() as any,
      getDeviceRegistryService: () =>
        makeDeviceRegistry([
          iosDevice({
            apnsAlertToken: "alert-token",
            apnsBundleId: "com.device.override",
            apnsEnv: "sandbox",
          }),
        ]) as any,
    });

    const result = await bridge.sendTestPush({ kind: "generic" });

    expect(result).toEqual({ ok: true });
    expect(apnsService.send).toHaveBeenCalledTimes(1);
    const envelope = apnsService.send.mock.calls[0]![0];
    expect(envelope.deviceToken).toBe("alert-token");
    expect(envelope.topic).toBe("com.device.override");
    expect(envelope.pushType).toBe("alert");
    expect(envelope.env).toBe("sandbox");
    expect(envelope.priority).toBe(10);
    expect(envelope.payload).toMatchObject({
      aps: expect.objectContaining({ category: "SYSTEM_ALERT" }),
    });
  });

  it("routes la_start to the activity-start token and the .push-type.liveactivity topic", async () => {
    const apnsService = makeApnsService({
      isConfigured: true,
      sendResult: { ok: true, status: 200 },
    });
    const bridge = createApnsBridgeService({
      projectConfigService: withConfig() as any,
      apnsService: apnsService as any,
      apnsKeyStore: makeKeyStore() as any,
      getDeviceRegistryService: () =>
        makeDeviceRegistry([
          iosDevice({
            apnsActivityStartToken: "la-start-token",
          }),
        ]) as any,
    });

    const result = await bridge.sendTestPush({ kind: "la_start" });

    expect(result).toEqual({ ok: true });
    const envelope = apnsService.send.mock.calls[0]![0];
    expect(envelope.pushType).toBe("liveactivity");
    expect(envelope.topic).toBe("com.ade.ios.push-type.liveactivity");
    expect(envelope.deviceToken).toBe("la-start-token");
    expect((envelope.payload as any).aps.event).toBe("start");
  });

  it("rejects la_update_running when the device has no active Live Activity token", async () => {
    const apnsService = makeApnsService({ isConfigured: true });
    const bridge = createApnsBridgeService({
      projectConfigService: withConfig() as any,
      apnsService: apnsService as any,
      apnsKeyStore: makeKeyStore() as any,
      getDeviceRegistryService: () =>
        makeDeviceRegistry([
          iosDevice({ apnsActivityStartToken: "start-only" }),
        ]) as any,
    });

    const result = await bridge.sendTestPush({ kind: "la_update_running" });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no active live activity/i);
    expect(apnsService.send).not.toHaveBeenCalled();
  });

  it("ends a live activity using an update token and emits an event=end payload", async () => {
    const apnsService = makeApnsService({
      isConfigured: true,
      sendResult: { ok: true, status: 200 },
    });
    const bridge = createApnsBridgeService({
      projectConfigService: withConfig() as any,
      apnsService: apnsService as any,
      apnsKeyStore: makeKeyStore() as any,
      getDeviceRegistryService: () =>
        makeDeviceRegistry([
          iosDevice({
            apnsActivityUpdateTokens: { "session-1": "update-token-1" },
          }),
        ]) as any,
    });

    const result = await bridge.sendTestPush({ kind: "la_end" });
    expect(result).toEqual({ ok: true });
    const envelope = apnsService.send.mock.calls[0]![0];
    expect(envelope.deviceToken).toBe("update-token-1");
    expect((envelope.payload as any).aps.event).toBe("end");
  });

  it("propagates apns send rejections as ok=false with the upstream reason", async () => {
    const apnsService = makeApnsService({
      isConfigured: true,
      sendResult: { ok: false, status: 410, reason: "BadDeviceToken" },
    });
    const bridge = createApnsBridgeService({
      projectConfigService: withConfig() as any,
      apnsService: apnsService as any,
      apnsKeyStore: makeKeyStore() as any,
      getDeviceRegistryService: () =>
        makeDeviceRegistry([
          iosDevice({ apnsAlertToken: "alert-token" }),
        ]) as any,
    });

    const result = await bridge.sendTestPush({ kind: "generic" });
    expect(result).toEqual({ ok: false, reason: "BadDeviceToken" });
  });

  it("returns ok=false when no device registry is available", async () => {
    const apnsService = makeApnsService({ isConfigured: true });
    const bridge = createApnsBridgeService({
      projectConfigService: withConfig() as any,
      apnsService: apnsService as any,
      apnsKeyStore: makeKeyStore() as any,
      getDeviceRegistryService: () => null,
    });

    const result = await bridge.sendTestPush({});
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/device registry unavailable/i);
  });
});

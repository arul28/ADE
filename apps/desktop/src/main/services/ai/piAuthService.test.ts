import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonValue } from "../chat/piSdkProtocol";
import type { PiSdkBridge, PiSdkPooled } from "../chat/piSdkPool";
import type { PiAuthStatusEvent } from "../../../shared/types/config";
import type { PiInstallation } from "./piInstallation";
import {
  __getActivePiLoginProviderIdsForTests,
  __resetPiAuthServiceForTests,
  __setPiAuthHooksForTests,
  addPiAuthStatusListener,
  cancelPiLogin,
  listPiLoginProviders,
  startPiLogin,
  submitPiLoginPrompt,
} from "./piAuthService";

const SECRET = "sk-super-secret-value";

const installation: PiInstallation = {
  cliPath: "/usr/local/bin/pi",
  packageRoot: "/pi/package",
  packageEntry: "/pi/package/dist/index.js",
  version: "0.84.0",
  nodeVersion: "22.19.0",
  sdkAvailable: true,
  cliAvailable: true,
  agentDir: "/home/user/.pi/agent",
  settingsPath: "/home/user/.pi/agent/settings.json",
  authPath: "/home/user/.pi/agent/auth.json",
  modelsPath: "/home/user/.pi/agent/models.json",
  modelsStorePath: "/home/user/.pi/agent/models-store.json",
  blocker: null,
};

type FakeWorker = {
  pooled: PiSdkPooled;
  bridge: PiSdkBridge;
  release: ReturnType<typeof vi.fn>;
  login: ReturnType<typeof vi.fn>;
  cancelLogin: ReturnType<typeof vi.fn>;
  respondToUi: ReturnType<typeof vi.fn>;
  finishLogin: () => void;
  failLogin: (error: Error) => void;
};

function createFakeWorker(authInventory: JsonValue = []): FakeWorker {
  const bridge: PiSdkBridge = {
    onEvent: null,
    onLifecycle: null,
    onError: null,
    onReady: null,
    onUiRequest: null,
    onUiNotice: null,
    onUiCancel: null,
  };
  let finishLogin!: () => void;
  let failLogin!: (error: Error) => void;
  const loginPromise = new Promise<void>((resolve, reject) => {
    finishLogin = resolve;
    failLogin = reject;
  });
  // A rejection is only observed once the service attaches its handler.
  loginPromise.catch(() => undefined);
  const login = vi.fn(() => loginPromise);
  const cancelLogin = vi.fn();
  const respondToUi = vi.fn();
  const pooled = {
    bridge,
    login,
    cancelLogin,
    respondToUi,
    requestAuth: vi.fn(async () => authInventory),
  } as unknown as PiSdkPooled;
  return { pooled, bridge, release: vi.fn(), login, cancelLogin, respondToUi, finishLogin, failLogin };
}

function installWorker(worker: FakeWorker): void {
  __setPiAuthHooksForTests({
    resolveInstallation: () => installation,
    acquireWorker: async () => ({ pooled: worker.pooled, release: worker.release }),
  });
}

function collectEvents(): PiAuthStatusEvent[] {
  const events: PiAuthStatusEvent[] = [];
  addPiAuthStatusListener((event) => events.push(event));
  return events;
}

/** Let the service's awaited hooks and settled promises run. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  __resetPiAuthServiceForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  __resetPiAuthServiceForTests();
  vi.useRealTimers();
});

describe("piAuthService", () => {
  it("lists only providers with an interactive login, sorted by name", async () => {
    const worker = createFakeWorker([
      { id: "zed", name: "Zed", authTypes: ["api_key"] },
      { id: "ambient", name: "Ambient", configured: true },
      { id: "xai", name: "xAI", authTypes: ["oauth"], loginLabel: "Sign in with SuperGrok", isSubscription: true, configured: true },
    ]);
    installWorker(worker);

    const providers = await listPiLoginProviders();

    expect(providers).toEqual([
      { id: "xai", name: "xAI", authTypes: ["oauth"], configured: true, loginLabel: "Sign in with SuperGrok", isSubscription: true },
      { id: "zed", name: "Zed", authTypes: ["api_key"], configured: false },
    ]);
    expect(worker.release).toHaveBeenCalledTimes(1);
  });

  it("releases the worker when the auth inventory request fails", async () => {
    const worker = createFakeWorker();
    (worker.pooled.requestAuth as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("worker died"));
    installWorker(worker);

    await expect(listPiLoginProviders()).rejects.toThrow("worker died");
    expect(worker.release).toHaveBeenCalledTimes(1);
  });

  it("refuses to start when Pi's SDK package is unavailable", async () => {
    const events = collectEvents();
    __setPiAuthHooksForTests({
      resolveInstallation: () => ({ ...installation, sdkAvailable: false, blocker: "Pi is not installed." }),
      acquireWorker: async () => {
        throw new Error("should not acquire a worker");
      },
    });

    await expect(startPiLogin({ providerId: "xai" })).resolves.toEqual({
      ok: false,
      error: "Pi is not installed.",
    });
    expect(events).toEqual([{ providerId: "xai", state: "error", error: "Pi is not installed." }]);
  });

  it("relays a prompt, sends the answer back to Pi, and never emits the value", async () => {
    const events = collectEvents();
    const worker = createFakeWorker();
    installWorker(worker);

    const started = startPiLogin({ providerId: "anthropic", method: "api_key" });
    await flush();

    expect(worker.login).toHaveBeenCalledWith({ providerId: "anthropic", method: "api_key" });
    expect(__getActivePiLoginProviderIdsForTests()).toEqual(["anthropic"]);

    worker.bridge.onUiNotice?.({
      origin: "auth",
      level: "info",
      message: "Enter code ABCD-1234 at https://x.ai/device",
      detail: { kind: "device_code", userCode: "ABCD-1234", verificationUri: "https://x.ai/device" },
    });
    worker.bridge.onUiRequest?.("req-1", {
      origin: "auth",
      kind: "secret",
      message: "Paste your Anthropic API key",
      placeholder: "sk-ant-…",
    });

    expect(events).toEqual([
      { providerId: "anthropic", state: "pending" },
      {
        providerId: "anthropic",
        state: "pending",
        notice: {
          level: "info",
          message: "Enter code ABCD-1234 at https://x.ai/device",
          userCode: "ABCD-1234",
          verificationUri: "https://x.ai/device",
        },
      },
      {
        providerId: "anthropic",
        state: "prompt",
        prompt: {
          requestId: "req-1",
          kind: "secret",
          title: "Sign in to anthropic",
          message: "Paste your Anthropic API key",
          placeholder: "sk-ant-…",
        },
      },
    ]);

    expect(submitPiLoginPrompt({ providerId: "anthropic", requestId: "req-1", value: SECRET })).toEqual({ ok: true });
    expect(worker.respondToUi).toHaveBeenCalledWith("req-1", { ok: true, value: SECRET });
    // A stale answer for the same prompt must not reach Pi twice.
    expect(submitPiLoginPrompt({ providerId: "anthropic", requestId: "req-1", value: SECRET }).ok).toBe(false);
    expect(worker.respondToUi).toHaveBeenCalledTimes(1);

    worker.finishLogin();
    await expect(started).resolves.toEqual({ ok: true });

    expect(events.at(-1)).toEqual({ providerId: "anthropic", state: "success" });
    expect(worker.release).toHaveBeenCalledTimes(1);
    expect(__getActivePiLoginProviderIdsForTests()).toEqual([]);
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });

  it("maps an auth URL notice onto the status event", async () => {
    const events = collectEvents();
    const worker = createFakeWorker();
    installWorker(worker);

    const started = startPiLogin({ providerId: "xai" });
    await flush();
    worker.bridge.onUiNotice?.({
      origin: "auth",
      level: "info",
      message: "Open this URL to continue signing in.",
      detail: { kind: "auth_url", url: "https://accounts.x.ai/authorize" },
    });

    expect(events.at(-1)?.notice).toEqual({
      level: "info",
      message: "Open this URL to continue signing in.",
      url: "https://accounts.x.ai/authorize",
    });

    cancelPiLogin({ providerId: "xai" });
    await started;
  });

  it("cancel answers the pending prompt, stops Pi, and releases the worker", async () => {
    const events = collectEvents();
    const worker = createFakeWorker();
    installWorker(worker);

    const started = startPiLogin({ providerId: "xai" });
    await flush();
    worker.bridge.onUiRequest?.("req-9", { origin: "auth", kind: "manual_code", message: "Paste the code" });

    cancelPiLogin({ providerId: "xai" });

    expect(worker.respondToUi).toHaveBeenCalledWith("req-9", { ok: false, error: "Sign-in cancelled." });
    expect(worker.cancelLogin).toHaveBeenCalledTimes(1);
    await expect(started).resolves.toEqual({ ok: false, error: "Sign-in cancelled." });
    expect(events.at(-1)).toEqual({ providerId: "xai", state: "error", error: "Sign-in cancelled." });
    expect(worker.release).toHaveBeenCalledTimes(1);
    expect(__getActivePiLoginProviderIdsForTests()).toEqual([]);
  });

  it("times out an abandoned flow and releases the worker", async () => {
    const events = collectEvents();
    const worker = createFakeWorker();
    installWorker(worker);

    const started = startPiLogin({ providerId: "xai" });
    await flush();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    await expect(started).resolves.toEqual({
      ok: false,
      error: "Pi sign-in timed out. Start it again when you're ready.",
    });
    expect(worker.cancelLogin).toHaveBeenCalledTimes(1);
    expect(events.at(-1)?.state).toBe("error");
    expect(worker.release).toHaveBeenCalledTimes(1);
    expect(__getActivePiLoginProviderIdsForTests()).toEqual([]);
  });

  it("releases the worker when Pi's login rejects", async () => {
    const events = collectEvents();
    const worker = createFakeWorker();
    installWorker(worker);

    const started = startPiLogin({ providerId: "xai" });
    await flush();
    worker.failLogin(new Error("Pi SDK login failed: provider refused"));

    await expect(started).resolves.toEqual({
      ok: false,
      error: "Pi SDK login failed: provider refused",
    });
    expect(events.at(-1)).toEqual({
      providerId: "xai",
      state: "error",
      error: "Pi SDK login failed: provider refused",
    });
    expect(worker.release).toHaveBeenCalledTimes(1);
  });

  it("starting a second flow for the same provider supersedes the first", async () => {
    const first = createFakeWorker();
    installWorker(first);
    const started = startPiLogin({ providerId: "xai" });
    await flush();

    const second = createFakeWorker();
    installWorker(second);
    const restarted = startPiLogin({ providerId: "xai" });
    await flush();

    await expect(started).resolves.toEqual({ ok: false, error: "Sign-in cancelled." });
    expect(first.release).toHaveBeenCalledTimes(1);
    expect(__getActivePiLoginProviderIdsForTests()).toEqual(["xai"]);

    second.finishLogin();
    await expect(restarted).resolves.toEqual({ ok: true });
    expect(second.release).toHaveBeenCalledTimes(1);
  });
});

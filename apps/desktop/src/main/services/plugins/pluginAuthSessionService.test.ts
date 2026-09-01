import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PluginManifest, PluginManifestAuthSession } from "../../../shared/plugins/manifest";
import {
  PluginSdkError,
  PLUGIN_AUTH_PARAM_VALUE_MAX,
  type PluginAuthCompletedPayload,
} from "../../../shared/plugins/sdk";
import type { Logger } from "../logging/logger";
import {
  createPluginAuthSessionService,
  isPortUnavailableError,
  PLUGIN_AUTH_APP_REDIRECT_URI,
  PLUGIN_AUTH_CALLBACK_SCHEME,
  PLUGIN_AUTH_SESSION_TTL_MS,
} from "./pluginAuthSessionService";

/**
 * Every log line this service wrote, kept verbatim.
 *
 * Recorded rather than silenced because one of the contracts under test is a
 * fact about the LOGS — a state, a code or a parameter value in a log file has
 * escaped the one process this design keeps it inside — and that can only be
 * asserted against the lines that were actually written.
 */
type LogLine = { level: string; event: string; meta?: Record<string, unknown> };

function recordingLogger(): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const record = (level: string) => (event: string, meta?: Record<string, unknown>) => {
    lines.push({ level, event, ...(meta ? { meta } : {}) });
  };
  return {
    lines,
    logger: { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") },
  };
}

const BASE_MANIFEST: PluginManifest = {
  name: "tracker",
  version: "1.0.0",
  displayName: "Tracker",
  description: "",
  vocabVersion: 1,
  surfaces: [],
  panels: [],
  sockets: [],
  collections: {},
  settings: [],
  cli: [],
  skills: [],
  tools: [],
  automationTriggers: [],
  automationSteps: [],
  searchProviders: [],
  keybindings: [],
  chatRuntimes: [],
  webhookIngress: [],
  official: false,
};

function manifestWith(...authSessions: PluginManifestAuthSession[]): PluginManifest {
  return { ...BASE_MANIFEST, authSessions };
}

const APP_FLOW: PluginManifestAuthSession = {
  id: "connect",
  provider: "Tracker",
  authorizeUrl: "https://tracker.example/oauth/authorize",
  callbacks: ["app"],
};

/**
 * A port nothing is listening on right now, taken by binding and releasing one.
 *
 * The manifest DECLARES the loopback port — an ephemeral one would be a
 * redirect no provider ever accepts — so a test that wants a real listener has
 * to find a free port first and write it into the manifest, exactly as a plugin
 * author writes the one they registered.
 */
async function freePort(): Promise<number> {
  const probe = http.createServer();
  const port = await new Promise<number>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      resolve(address.port);
    });
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function loopbackFlow(port: number): PluginManifestAuthSession {
  return {
    id: "connect",
    provider: "Tracker",
    authorizeUrl: "https://tracker.example/oauth/authorize",
    callbacks: ["loopback"],
    loopback: { port, path: "/oauth/callback" },
  };
}

type Harness = {
  service: ReturnType<typeof createPluginAuthSessionService>;
  emitted: { pluginId: string; payload: PluginAuthCompletedPayload }[];
  lines: LogLine[];
};

const openServices: ReturnType<typeof createPluginAuthSessionService>[] = [];

function harness(overrides?: { now?: () => number; appRedirectUri?: string }): Harness {
  const { logger, lines } = recordingLogger();
  const emitted: { pluginId: string; payload: PluginAuthCompletedPayload }[] = [];
  const service = createPluginAuthSessionService({
    logger,
    emitCompleted: (pluginId, payload) => emitted.push({ pluginId, payload }),
    ...overrides,
  });
  openServices.push(service);
  return { service, emitted, lines };
}

afterEach(() => {
  while (openServices.length > 0) openServices.pop()!.dispose();
  vi.useRealTimers();
});

/** The `state` the host minted, read back off the URL it is presenting. */
function presentedState(service: Harness["service"], pluginId: string, sessionId: string): string {
  const presentation = service.presentation(pluginId, sessionId);
  if (!presentation) throw new Error("expected a live flow to present");
  const state = new URL(presentation.url).searchParams.get("state");
  if (!state) throw new Error("expected a state on the authorize URL");
  return state;
}

async function expectSdkError(run: () => Promise<unknown>): Promise<PluginSdkError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof PluginSdkError) return error;
    throw error;
  }
  throw new Error("Expected the auth session service to refuse this call.");
}

describe("createPluginAuthSessionService", () => {
  it("refuses a session id the manifest does not declare", async () => {
    const { service, emitted } = harness();
    const error = await expectSdkError(() => service.begin({
      pluginId: "tracker",
      manifest: manifestWith(APP_FLOW),
      sessionId: "not-declared",
      params: {},
    }));

    expect(error.code).toBe("not_permitted");
    expect(error.message).toContain("not-declared");
    expect(error.message).toContain("authSessions");
    expect(emitted).toHaveLength(0);
  });

  it("refuses a host-owned parameter by name rather than overwriting it", async () => {
    const { service } = harness();
    const error = await expectSdkError(() => service.begin({
      pluginId: "tracker",
      manifest: manifestWith(APP_FLOW),
      sessionId: "connect",
      params: { client_id: "abc", redirect_uri: "https://attacker.example/catch" },
    }));

    expect(error.code).toBe("invalid_args");
    expect(error.message).toContain("redirect_uri");
    expect(error.message).toContain("state");
    // Nothing was started, so nothing is presentable: the refusal is total.
    expect(service.presentation("tracker", "connect")).toBeNull();
  });

  it("refuses a parameter value past the ceiling", async () => {
    const { service } = harness();
    const error = await expectSdkError(() => service.begin({
      pluginId: "tracker",
      manifest: manifestWith(APP_FLOW),
      sessionId: "connect",
      params: { scope: "x".repeat(PLUGIN_AUTH_PARAM_VALUE_MAX + 1) },
    }));

    expect(error.code).toBe("invalid_args");
    expect(error.message).toContain("scope");
  });

  it("refuses a second begin while one is live rather than superseding it", async () => {
    const { service } = harness();
    const manifest = manifestWith(APP_FLOW);
    await service.begin({ pluginId: "tracker", manifest, sessionId: "connect", params: {} });

    const error = await expectSdkError(() => service.begin({
      pluginId: "tracker",
      manifest,
      sessionId: "connect",
      params: {},
    }));

    expect(error.code).toBe("auth_session_busy");
    // The first flow is untouched — the user is still looking at its window.
    expect(service.presentation("tracker", "connect")).not.toBeNull();
  });

  it("lets two different plugins run the same session id at once", async () => {
    const { service } = harness();
    const manifest = manifestWith(APP_FLOW);
    await service.begin({ pluginId: "tracker", manifest, sessionId: "connect", params: {} });
    await service.begin({ pluginId: "other", manifest, sessionId: "connect", params: {} });

    expect(service.presentation("tracker", "connect")).not.toBeNull();
    expect(service.presentation("other", "connect")).not.toBeNull();
  });

  it("stamps the presentation the client shows, with a callback scheme only for the app transport", async () => {
    const { service } = harness();
    await service.begin({
      pluginId: "tracker",
      manifest: manifestWith(APP_FLOW),
      sessionId: "connect",
      params: { client_id: "abc" },
    });

    const presentation = service.presentation("tracker", "connect");
    expect(presentation?.transport).toBe("app");
    expect(presentation?.callbackScheme).toBe(PLUGIN_AUTH_CALLBACK_SCHEME);
    const url = new URL(presentation!.url);
    expect(url.origin + url.pathname).toBe("https://tracker.example/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("abc");
    expect(url.searchParams.get("redirect_uri")).toBe(PLUGIN_AUTH_APP_REDIRECT_URI);
    expect(url.searchParams.get("state")).toBeTruthy();
  });

  it("picks app for a phone and loopback for a desktop, and falls back to what is declared", async () => {
    const { service } = harness();
    const port = await freePort();
    const both: PluginManifestAuthSession = {
      ...loopbackFlow(port),
      callbacks: ["loopback", "app"],
    };
    const manifest = manifestWith(both);

    const mobile = await service.begin({
      pluginId: "tracker",
      manifest,
      sessionId: "connect",
      params: {},
      client: "mobile",
    });
    expect(mobile.transport).toBe("app");
    expect(mobile.redirectUri).toBe(PLUGIN_AUTH_APP_REDIRECT_URI);
    service.cancel("tracker", "connect");

    const desktop = await service.begin({
      pluginId: "tracker",
      manifest,
      sessionId: "connect",
      params: {},
      client: "desktop",
    });
    expect(desktop.transport).toBe("loopback");
    expect(desktop.redirectUri).toBe(`http://127.0.0.1:${port}/oauth/callback`);
    service.cancel("tracker", "connect");

    // A desktop asking a flow that only speaks `app` gets `app` rather than a
    // refusal: the relay bounce is reachable from a desktop browser too.
    const appOnly = await service.begin({
      pluginId: "tracker",
      manifest: manifestWith(APP_FLOW),
      sessionId: "connect",
      params: {},
      client: "desktop",
    });
    expect(appOnly.transport).toBe("app");
  });

  it("refuses an explicit transport the flow does not declare", async () => {
    const { service } = harness();
    const error = await expectSdkError(() => service.begin({
      pluginId: "tracker",
      manifest: manifestWith(APP_FLOW),
      sessionId: "connect",
      params: {},
      transport: "loopback",
    }));

    expect(error.code).toBe("invalid_args");
    expect(error.message).toContain("loopback");
  });

  it("strips state from the success payload and emits exactly once", async () => {
    const { service, emitted } = harness();
    const begun = await service.begin({
      pluginId: "tracker",
      manifest: manifestWith(APP_FLOW),
      sessionId: "connect",
      params: {},
    });
    const state = presentedState(service, "tracker", "connect");

    expect(service.completeAppCallback({ params: { state, code: "auth-code-1" } })).toEqual({ ok: true });
    expect(emitted).toHaveLength(1);
    const payload = emitted[0]!.payload;
    expect(emitted[0]!.pluginId).toBe("tracker");
    expect(payload.sessionId).toBe("connect");
    expect(payload.attempt).toBe(begun.attempt);
    expect(payload.ok).toBe(true);
    expect(payload.ok === true ? payload.params : null).toEqual({ code: "auth-code-1" });

    // The same link opened a second time is refused, and emits nothing more.
    expect(service.completeAppCallback({ params: { state, code: "auth-code-1" } })).toEqual({
      ok: false,
      reason: "state_mismatch",
    });
    expect(emitted).toHaveLength(1);
    expect(service.presentation("tracker", "connect")).toBeNull();
  });

  it("refuses a callback whose state it never minted, and emits nothing", async () => {
    const { service, emitted } = harness();
    await service.begin({
      pluginId: "tracker",
      manifest: manifestWith(APP_FLOW),
      sessionId: "connect",
      params: {},
    });

    expect(service.completeAppCallback({ params: { state: "not-a-state-we-minted", code: "x" } })).toEqual({
      ok: false,
      reason: "state_mismatch",
    });
    expect(service.completeAppCallback({ params: { code: "x" } })).toEqual({
      ok: false,
      reason: "state_mismatch",
    });
    expect(emitted).toHaveLength(0);
    // The live flow the caller failed to address is still live.
    expect(service.presentation("tracker", "connect")).not.toBeNull();
  });

  it("refuses a callback for a flow that was never begun", async () => {
    const { service, emitted } = harness();
    // Nothing has been begun at all: there is no state table to match against,
    // so the door cannot be talked into naming a flow.
    expect(service.completeAppCallback({ params: { state: "anything", code: "x" } })).toEqual({
      ok: false,
      reason: "state_mismatch",
    });
    expect(emitted).toHaveLength(0);
  });

  it("reports the provider's own refusal as denied", async () => {
    const { service, emitted } = harness();
    await service.begin({
      pluginId: "tracker",
      manifest: manifestWith(APP_FLOW),
      sessionId: "connect",
      params: {},
    });
    const state = presentedState(service, "tracker", "connect");

    service.completeAppCallback({
      params: { state, error: "access_denied", error_description: "You said no." },
    });

    const payload = emitted[0]!.payload;
    expect(payload.ok).toBe(false);
    expect(payload.ok === false ? payload.reason : null).toBe("denied");
    expect(payload.ok === false ? payload.message : null).toBe("You said no.");
  });

  it("writes a sentence when the provider sent only an error code", async () => {
    const { service, emitted } = harness();
    await service.begin({
      pluginId: "tracker",
      manifest: manifestWith(APP_FLOW),
      sessionId: "connect",
      params: {},
    });
    const state = presentedState(service, "tracker", "connect");

    service.completeAppCallback({ params: { state, error: "server_error" } });

    const payload = emitted[0]!.payload;
    expect(payload.ok === false ? payload.message : null).toBe("Tracker sign-in failed (server_error).");
  });

  it("tells the plugin the flow expired when nobody ever came back", async () => {
    vi.useFakeTimers();
    const { service, emitted } = harness({ now: () => Date.now() });
    const begun = await service.begin({
      pluginId: "tracker",
      manifest: manifestWith(APP_FLOW),
      sessionId: "connect",
      params: {},
    });
    expect(Date.parse(begun.expiresAt)).toBe(Date.now() + PLUGIN_AUTH_SESSION_TTL_MS);
    expect(emitted).toHaveLength(0);

    vi.advanceTimersByTime(PLUGIN_AUTH_SESSION_TTL_MS + 1);

    expect(emitted).toHaveLength(1);
    const payload = emitted[0]!.payload;
    expect(payload.ok === false ? payload.reason : null).toBe("expired");
    expect(service.presentation("tracker", "connect")).toBeNull();
  });

  it("cancels once and stays quiet on every later cancel", async () => {
    const { service, emitted } = harness();
    await service.begin({
      pluginId: "tracker",
      manifest: manifestWith(APP_FLOW),
      sessionId: "connect",
      params: {},
    });

    service.cancel("tracker", "connect");
    service.cancel("tracker", "connect");
    service.cancel("tracker", "never-begun");

    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.payload.ok === false ? emitted[0]!.payload.reason : null).toBe("canceled");
  });

  it("tells a plugin its flows are gone, and says nothing at all on host shutdown", async () => {
    const { service, emitted } = harness();
    const manifest = manifestWith(APP_FLOW);
    await service.begin({ pluginId: "tracker", manifest, sessionId: "connect", params: {} });
    await service.begin({ pluginId: "other", manifest, sessionId: "connect", params: {} });

    service.disposePlugin("tracker");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.pluginId).toBe("tracker");

    service.dispose();
    expect(emitted).toHaveLength(1);
    expect(service.presentation("other", "connect")).toBeNull();
  });

  it("catches a real loopback redirect and tells the reader they can close the window", async () => {
    const { service, emitted } = harness();
    const port = await freePort();
    const begun = await service.begin({
      pluginId: "tracker",
      manifest: manifestWith(loopbackFlow(port)),
      sessionId: "connect",
      params: { client_id: "abc" },
    });
    expect(begun.transport).toBe("loopback");
    const state = presentedState(service, "tracker", "connect");

    const response = await fetch(
      `http://127.0.0.1:${port}/oauth/callback?code=loop-code&state=${encodeURIComponent(state)}`,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("close this window");

    expect(emitted).toHaveLength(1);
    const payload = emitted[0]!.payload;
    expect(payload.ok === true ? payload.params : null).toEqual({ code: "loop-code" });
    expect(service.presentation("tracker", "connect")).toBeNull();
  });

  it("answers 404 off the callback path and 400 for a state it did not mint, without retiring the flow", async () => {
    const { service, emitted } = harness();
    const port = await freePort();
    await service.begin({
      pluginId: "tracker",
      manifest: manifestWith(loopbackFlow(port)),
      sessionId: "connect",
      params: {},
    });

    expect((await fetch(`http://127.0.0.1:${port}/favicon.ico`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/oauth/callback?code=x&state=forged`)).status).toBe(400);
    expect(emitted).toHaveLength(0);
    // Still live: a stray request must not spend the flow the user is mid-way
    // through, or they come back from the provider to a state already retired.
    expect(service.presentation("tracker", "connect")).not.toBeNull();

    const state = presentedState(service, "tracker", "connect");
    await fetch(`http://127.0.0.1:${port}/oauth/callback?code=late&state=${encodeURIComponent(state)}`);
    expect(emitted).toHaveLength(1);
  });

  it("refuses a begin whose declared loopback port is already taken, naming the port", async () => {
    const { service } = harness();
    const port = await freePort();
    const squatter = http.createServer((_req, res) => res.end("busy"));
    await new Promise<void>((resolve) => squatter.listen(port, "127.0.0.1", () => resolve()));

    try {
      const error = await expectSdkError(() => service.begin({
        pluginId: "tracker",
        manifest: manifestWith(loopbackFlow(port)),
        sessionId: "connect",
        params: {},
      }));
      expect(error.code).toBe("auth_session_busy");
      expect(error.message).toContain(String(port));
      // The failed begin left nothing behind, so a retry once the port frees is
      // not refused as "already running".
      expect(service.presentation("tracker", "connect")).toBeNull();
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });

  it("never writes a state, a code or a parameter value to the log", async () => {
    const { service, lines } = harness();
    const port = await freePort();
    await service.begin({
      pluginId: "tracker",
      manifest: manifestWith(loopbackFlow(port)),
      sessionId: "connect",
      params: { client_id: "secret-client-id", code_challenge: "secret-challenge" },
    });
    const state = presentedState(service, "tracker", "connect");

    // A forged callback, a real one, and a cancel afterwards — every path that
    // logs at all.
    await fetch(`http://127.0.0.1:${port}/oauth/callback?code=x&state=forged-state-value`);
    await fetch(`http://127.0.0.1:${port}/oauth/callback?code=secret-auth-code&state=${encodeURIComponent(state)}`);
    service.cancel("tracker", "connect");
    service.completeAppCallback({ params: { state: "another-secret-state", code: "another-code" } });

    expect(lines.length).toBeGreaterThan(0);
    const written = JSON.stringify(lines);
    for (const secret of [
      state,
      "forged-state-value",
      "another-secret-state",
      "secret-auth-code",
      "another-code",
      "secret-client-id",
      "secret-challenge",
    ]) {
      expect(written).not.toContain(secret);
    }
    // The keys are logged, because an author debugging a flow needs to know
    // which parameters went out — and a key names nothing.
    expect(written).toContain("client_id");
    expect(written).toContain("code_challenge");
  });
});

/**
 * Swap `process.platform` for the duration of one synchronous check.
 *
 * `process.platform` IS the seam: the predicate reads it at call time, exactly
 * as `isLockContention` does, so nothing had to be threaded through the
 * production path to make the Windows branch testable. The property is a
 * non-writable own property on `process`, hence `defineProperty` rather than an
 * assignment, and it is restored in a `finally` so a failing expectation cannot
 * leave the rest of the suite believing it runs on Windows.
 */
function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  if (!original) throw new Error("process.platform is not an own property");
  Object.defineProperty(process, "platform", { ...original, value: platform });
  try {
    return run();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

const withCode = (message: string, code: string): Error => Object.assign(new Error(message), { code });

/**
 * The mapping from this predicate to the `auth_session_busy` error the plugin
 * sees is covered by the live-squatter test above; these cases cover which
 * failures count as "this declared port is not available" in the first place,
 * which is the half a macOS host can never observe for Windows.
 */
describe("isPortUnavailableError", () => {
  it("treats EADDRINUSE as contention on every platform, by code and by message", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      withPlatform(platform, () => {
        expect(isPortUnavailableError(withCode("listen failed", "EADDRINUSE"))).toBe(true);
        // The message fallback: not every path that fails to bind sets `code`.
        expect(isPortUnavailableError(new Error("listen EADDRINUSE 127.0.0.1:8321"))).toBe(true);
        expect(isPortUnavailableError(new Error("bind: address already in use"))).toBe(true);
      });
    }
  });

  it("accepts EACCES and EBUSY on win32, where a reserved port range fails the bind that way", () => {
    withPlatform("win32", () => {
      // A Hyper-V / WSL dynamic-port exclusion range holds the port with nothing
      // listening on it; Windows answers the bind EACCES, not EADDRINUSE.
      expect(isPortUnavailableError(withCode("listen EACCES 127.0.0.1:53000", "EACCES"))).toBe(true);
      expect(isPortUnavailableError(withCode("listen EBUSY 127.0.0.1:53000", "EBUSY"))).toBe(true);
    });
  });

  it("refuses EACCES and EBUSY off win32, where they are a real fault and not a busy port", () => {
    for (const platform of ["darwin", "linux"] as const) {
      withPlatform(platform, () => {
        // Reporting a privileged-port or sandbox denial as "the port is busy"
        // would send the user hunting for a program that does not exist.
        expect(isPortUnavailableError(withCode("listen EACCES 127.0.0.1:80", "EACCES"))).toBe(false);
        expect(isPortUnavailableError(withCode("listen EBUSY 127.0.0.1:80", "EBUSY"))).toBe(false);
      });
    }
  });

  it("refuses every other bind failure, on win32 too", () => {
    withPlatform("win32", () => {
      expect(isPortUnavailableError(withCode("listen EADDRNOTAVAIL", "EADDRNOTAVAIL"))).toBe(false);
      expect(isPortUnavailableError(new Error("something else entirely"))).toBe(false);
      expect(isPortUnavailableError(null)).toBe(false);
      expect(isPortUnavailableError("EADDRINUSE")).toBe(false);
    });
  });
});

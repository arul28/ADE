import { describe, expect, it, vi } from "vitest";
import type { AuthInfo, Certificate, LoginAuthenticationResponseDetails } from "electron";
import { configureBuiltInBrowserAuthentication } from "./builtInBrowserAuthentication";

type Listener = (...args: unknown[]) => void;

function createHarness() {
  const listeners = new Map<string, Listener>();
  const webContents = {
    on: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, listener);
    }),
  };
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
  };
  const recordAuthenticatedOrigin = vi.fn();
  const promptHttpAuth = vi.fn();
  const promptClientCertificate = vi.fn();
  configureBuiltInBrowserAuthentication({
    webContents: webContents as never,
    resolveParentWindow: () => null,
    getAgentIdentity: () => ({ laneId: "lane-1", chatSessionId: "chat-1" }),
    recordAuthenticatedOrigin,
    getLogger: () => logger as never,
    promptHttpAuth,
    promptClientCertificate,
  });
  return {
    listeners,
    logger,
    recordAuthenticatedOrigin,
    promptHttpAuth,
    promptClientCertificate,
  };
}

function authDetails(): LoginAuthenticationResponseDetails {
  return { url: "https://example.com/private" };
}

function authInfo(): AuthInfo {
  return {
    isProxy: false,
    scheme: "basic",
    host: "example.com",
    port: 443,
    realm: "Private",
  };
}

function certificate(subjectName: string): Certificate {
  const principal = {
    commonName: subjectName,
    country: "",
    locality: "",
    organizations: [],
    organizationUnits: [],
    state: "",
  };
  const value = {
    data: "pem",
    fingerprint: `fingerprint-${subjectName}`,
    issuer: principal,
    issuerCert: null as unknown as Certificate,
    issuerName: "ADE Test CA",
    serialNumber: "1",
    subject: principal,
    subjectName,
    validExpiry: 2_000_000_000,
    validStart: 1_000_000_000,
  } satisfies Certificate;
  value.issuerCert = value;
  return value;
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("configureBuiltInBrowserAuthentication", () => {
  it("passes HTTP auth credentials directly to Chromium without logging them", async () => {
    const harness = createHarness();
    harness.promptHttpAuth.mockResolvedValue({ username: "alice", password: "top-secret" });
    const event = { preventDefault: vi.fn() };
    const callback = vi.fn();

    harness.listeners.get("login")?.(event, authDetails(), authInfo(), callback);
    await flushPromises();

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith("alice", "top-secret");
    expect(harness.recordAuthenticatedOrigin).toHaveBeenCalledWith(
      "https://example.com/private",
      { laneId: "lane-1", chatSessionId: "chat-1" },
    );
    expect(JSON.stringify(harness.logger.info.mock.calls)).not.toContain("alice");
    expect(JSON.stringify(harness.logger.info.mock.calls)).not.toContain("top-secret");
  });

  it("cancels HTTP authentication when the human dismisses the prompt", async () => {
    const harness = createHarness();
    harness.promptHttpAuth.mockResolvedValue(null);
    const callback = vi.fn();

    harness.listeners.get("login")?.(
      { preventDefault: vi.fn() },
      authDetails(),
      authInfo(),
      callback,
    );
    await flushPromises();

    expect(callback).toHaveBeenCalledWith();
    expect(harness.recordAuthenticatedOrigin).not.toHaveBeenCalled();
  });

  it("does not treat proxy credentials as site authentication", async () => {
    const harness = createHarness();
    harness.promptHttpAuth.mockResolvedValue({ username: "proxy-user", password: "proxy-pass" });
    const callback = vi.fn();

    harness.listeners.get("login")?.(
      { preventDefault: vi.fn() },
      authDetails(),
      { ...authInfo(), isProxy: true },
      callback,
    );
    await flushPromises();

    expect(callback).toHaveBeenCalledWith("proxy-user", "proxy-pass");
    expect(harness.recordAuthenticatedOrigin).not.toHaveBeenCalled();
  });

  it("uses only a certificate from Electron's offered list", async () => {
    const harness = createHarness();
    const first = certificate("Alice");
    const second = certificate("Bob");
    harness.promptClientCertificate.mockResolvedValue(second);
    const event = { preventDefault: vi.fn() };
    const callback = vi.fn();

    harness.listeners.get("select-client-certificate")?.(
      event,
      "https://mtls.example.com/",
      [first, second],
      callback,
    );
    await flushPromises();

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(second);
    expect(harness.recordAuthenticatedOrigin).toHaveBeenCalledWith(
      "https://mtls.example.com/",
      { laneId: "lane-1", chatSessionId: "chat-1" },
    );
  });

  it("cancels when a certificate prompt returns an unoffered certificate", async () => {
    const harness = createHarness();
    harness.promptClientCertificate.mockResolvedValue(certificate("Mallory"));
    const callback = vi.fn();

    harness.listeners.get("select-client-certificate")?.(
      { preventDefault: vi.fn() },
      "https://mtls.example.com/",
      [certificate("Alice")],
      callback,
    );
    await flushPromises();

    expect(callback).toHaveBeenCalledWith();
    expect(harness.recordAuthenticatedOrigin).not.toHaveBeenCalled();
  });
});

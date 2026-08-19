import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachGitHubServiceHealth,
  getGitHubServiceHealth,
  resetGitHubServiceHealthCache,
} from "./githubStatusPage";
import type { GitHubStatus } from "../../../shared/types";

const OUTAGE_PAYLOAD = {
  status: { indicator: "major", description: "Partial System Outage" },
  components: [{ id: "brv1bkgrwx7q", name: "API Requests", status: "major_outage" }],
  incidents: [{ name: "Incident with GitHub.com", shortlink: "https://stspg.io/x", resolved_at: null }],
};

function jsonResponse(payload: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 503,
    json: async () => payload,
  } as unknown as Response;
}

describe("githubStatusPage", () => {
  beforeEach(() => {
    resetGitHubServiceHealthCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetGitHubServiceHealthCache();
  });

  it("returns a corroborated incident", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(OUTAGE_PAYLOAD)));
    const health = await getGitHubServiceHealth();
    expect(health?.affected[0]?.surface).toBe("api");
    expect(health?.incidentUrl).toBe("https://stspg.io/x");
  });

  it("caches so repeated failures don't re-hit the status page", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(OUTAGE_PAYLOAD));
    vi.stubGlobal("fetch", fetchMock);
    await getGitHubServiceHealth();
    await getGitHubServiceHealth();
    await getGitHubServiceHealth();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Without a negative cache, an outage that also breaks egress would retry the
  // status page on every failed GitHub call — exactly when it helps least.
  it("caches the null result too", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await getGitHubServiceHealth()).toBeNull();
    expect(await getGitHubServiceHealth()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent lookups into one request", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(OUTAGE_PAYLOAD));
    vi.stubGlobal("fetch", fetchMock);
    const [a, b] = await Promise.all([getGitHubServiceHealth(), getGitHubServiceHealth()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  // An unreachable or broken status page must never itself produce UI: that
  // would swap one wrong accusation for another.
  it("stays silent on a non-ok response or unparseable body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(OUTAGE_PAYLOAD, false)));
    expect(await getGitHubServiceHealth()).toBeNull();

    resetGitHubServiceHealthCache();
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("Unexpected token < in JSON");
      },
    } as unknown as Response)));
    expect(await getGitHubServiceHealth()).toBeNull();
  });

  it("never reports an outage when nothing ADE uses is degraded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      status: { indicator: "major", description: "Partial System Outage" },
      components: [{ id: "pjmpxvq2cmr2", name: "Copilot", status: "major_outage" }],
    })));
    expect(await getGitHubServiceHealth()).toBeNull();
  });
});

function status(overrides: Partial<GitHubStatus> = {}): GitHubStatus {
  return {
    tokenStored: true,
    patTokenStored: false,
    tokenDecryptionFailed: false,
    storageScope: "app",
    authSource: "gh",
    tokenType: "oauth",
    repo: { owner: "arul28", name: "ADE" },
    hasOrigin: true,
    userLogin: null,
    scopes: [],
    ghCliPath: null,
    ghAuthError: null,
    checkedAt: null,
    repoAccessOk: null,
    repoAccessError: null,
    connected: false,
    ...overrides,
  };
}

describe("attachGitHubServiceHealth", () => {
  beforeEach(() => resetGitHubServiceHealthCache());
  afterEach(() => {
    vi.restoreAllMocks();
    resetGitHubServiceHealthCache();
  });

  it("attaches a corroborated incident to a GitHub-side failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(OUTAGE_PAYLOAD)));
    const result = await attachGitHubServiceHealth(
      status({
        authFailure: { kind: "service_unavailable", message: "503", retryAt: null },
      }),
    );
    expect(result.serviceHealth?.affected[0]?.surface).toBe("api");
  });

  // Definitive answers FROM GitHub about this credential. Letting a mild,
  // unrelated degradation overwrite them would tell a rate-limited or
  // under-scoped user there is nothing to fix, hiding their real remedy.
  it("never overrides a definitive GitHub answer, and never asks the status page about one", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(OUTAGE_PAYLOAD));
    vi.stubGlobal("fetch", fetchMock);
    // `network` is ADE's own connectivity failing — the status page is just as
    // unreachable, so asking only adds latency to every offline blip.
    for (const kind of ["invalid_token", "permission_denied", "rate_limited", "network"] as const) {
      const result = await attachGitHubServiceHealth(
        status({ authFailure: { kind, message: "x", retryAt: null } }),
      );
      expect(result.serviceHealth).toBeFalsy();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // A fine-grained PAT that simply lacks this repo is a LOCAL misconfiguration:
  // connected === false, but GitHub never failed. Treating that as a trigger
  // would make this module a once-a-minute beacon for the whole session.
  it("does not consult the status page when GitHub reported no failure", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(OUTAGE_PAYLOAD));
    vi.stubGlobal("fetch", fetchMock);
    const result = await attachGitHubServiceHealth(status({ connected: false, authFailure: null }));
    expect(result.serviceHealth).toBeFalsy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stays silent when the status page is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ENOTFOUND"); }));
    const result = await attachGitHubServiceHealth(
      status({ authFailure: { kind: "service_unavailable", message: "503", retryAt: null } }),
    );
    expect(result.serviceHealth).toBeFalsy();
  });
});

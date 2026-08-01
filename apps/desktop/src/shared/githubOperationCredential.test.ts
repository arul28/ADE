import { describe, expect, it, vi } from "vitest";
import {
  evaluateGithubCredentialCapabilities,
  resolveGithubStatusCredentials,
} from "./githubOperationCredential";
import type { GithubStatusCredentialProbeResult } from "./githubOperationCredential";

describe("githubOperationCredential", () => {
  it("keeps a repo-validated fine-grained token available for writes", () => {
    expect(evaluateGithubCredentialCapabilities({
      source: "pat",
      tokenType: "fine-grained",
      scopes: [],
      userLogin: "alice",
      repositoryPresent: true,
      repositoryReadValidated: true,
    })).toEqual({ read: true, write: true });
  });

  it("resolves read fallback and validates the selected writer once", async () => {
    const app = { source: "app" as const, token: "app" };
    const gh = { source: "gh" as const, token: "gh" };
    const authenticated = vi.fn();
    const usable = vi.fn();
    const rejected = vi.fn();
    const result = await resolveGithubStatusCredentials({
      readCandidates: [app, gh],
      writeCandidates: [gh],
      cooldown: () => null,
      probe: async (candidate) => candidate.source === "app"
        ? {
            ok: false as const,
            error: "Not Found",
            authFailure: {
              kind: "permission_denied" as const,
              message: "Not Found",
              retryAt: null,
            },
            rateLimit: null,
            value: { repoAccessOk: false, write: false },
          }
        : { ok: true as const, value: { repoAccessOk: true, write: true } },
      capabilities: (_candidate, probe) => ({ read: probe.repoAccessOk, write: probe.write }),
      isRepositoryAccessFailure: (probe) => probe.value?.repoAccessOk === false,
      onAuthenticatedProbe: authenticated,
      onUsableProbe: usable,
      onRejectedProbe: rejected,
    });

    expect(result.active?.candidate.source).toBe("gh");
    expect(result.activeWriteSource).toBe("gh");
    expect(result.failures.map((failure) => failure.candidate.source)).toEqual(["app"]);
    expect(rejected).toHaveBeenCalledWith(
      app,
      expect.objectContaining({ ok: false }),
      { repositoryAccessFailure: true, phase: "read" },
    );
    expect(authenticated).toHaveBeenCalledTimes(1);
    expect(usable).toHaveBeenCalledTimes(1);
  });

  it("re-probes an accepted but unvalidated read credential before using it for writes", async () => {
    const gh = { source: "gh" as const, token: "shared" };
    type Probe = { repoAccessOk: boolean; write: boolean };
    const probe = vi.fn<[typeof gh], Promise<GithubStatusCredentialProbeResult<Probe>>>()
      .mockResolvedValueOnce({
        ok: false as const,
        error: "Not Found",
        authFailure: {
          kind: "permission_denied" as const,
          message: "Not Found",
          retryAt: null,
        },
        rateLimit: null,
        value: { repoAccessOk: false, write: false },
      })
      .mockResolvedValueOnce({
        ok: true as const,
        value: { repoAccessOk: true, write: true },
      });

    const result = await resolveGithubStatusCredentials({
      readCandidates: [gh],
      writeCandidates: [gh],
      cooldown: () => null,
      probe,
      capabilities: (_candidate, value) => ({ read: value.repoAccessOk, write: value.write }),
      isRepositoryAccessFailure: (result) => result.value?.repoAccessOk === false,
      onAuthenticatedProbe: vi.fn(),
      onUsableProbe: vi.fn(),
      onRejectedProbe: vi.fn(),
    });

    expect(result.active?.candidate).toBe(gh);
    expect(result.activeWriteSource).toBe("gh");
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("continues to the next credential when an authenticated probe lacks read access", async () => {
    const environment = { source: "environment" as const, token: "environment" };
    const app = { source: "app" as const, token: "app" };
    const authenticated = vi.fn();
    const usable = vi.fn();
    const rejected = vi.fn();

    const result = await resolveGithubStatusCredentials({
      readCandidates: [environment, app],
      writeCandidates: [environment],
      cooldown: () => null,
      probe: async (candidate) => ({
        ok: true as const,
        value: { read: candidate.source === "app", write: false },
      }),
      capabilities: (_candidate, value) => value,
      isRepositoryAccessFailure: () => false,
      onAuthenticatedProbe: authenticated,
      onUsableProbe: usable,
      onRejectedProbe: rejected,
    });

    expect(result.active?.candidate).toBe(app);
    expect(result.failures).toEqual([
      expect.objectContaining({
        candidate: environment,
        authFailure: expect.objectContaining({ kind: "permission_denied" }),
      }),
    ]);
    expect(authenticated).toHaveBeenNthCalledWith(1, environment, expect.anything());
    expect(authenticated).toHaveBeenNthCalledWith(2, app, expect.anything());
    expect(usable).toHaveBeenCalledOnce();
    expect(usable).toHaveBeenCalledWith(app, expect.anything());
    expect(rejected).toHaveBeenCalledWith(
      environment,
      expect.objectContaining({ ok: false }),
      { repositoryAccessFailure: false, phase: "read" },
    );
  });
});

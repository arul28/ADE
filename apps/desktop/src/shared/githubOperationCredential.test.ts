import { describe, expect, it, vi } from "vitest";
import {
  evaluateGithubCredentialCapabilities,
  resolveGithubStatusCredentials,
} from "./githubOperationCredential";

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
    const accepted = vi.fn();
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
      onAcceptedProbe: accepted,
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
    expect(accepted).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it } from "vitest";
import {
  deriveGitHubServiceHealth,
  githubServiceAffectedLabel,
  isGithubServiceUnavailable,
} from "./githubServiceHealth";

function summary(components: Array<{ id?: string; name: string; status: string }>, extra: Record<string, unknown> = {}) {
  return {
    status: { indicator: "major", description: "Partial System Outage" },
    components,
    incidents: [],
    ...extra,
  };
}

describe("deriveGitHubServiceHealth", () => {
  it("reports the components ADE depends on, worst first", () => {
    const health = deriveGitHubServiceHealth(
      summary([
        { id: "8l4ygp009s5s", name: "Git Operations", status: "degraded_performance" },
        { id: "brv1bkgrwx7q", name: "API Requests", status: "major_outage" },
        { id: "4230lsnqdsld", name: "Webhooks", status: "partial_outage" },
      ]),
    );
    expect(health).not.toBeNull();
    expect(health?.affected.map((entry) => entry.surface)).toEqual(["api", "webhooks", "git"]);
  });

  it("stays silent when every ADE-relevant component is operational", () => {
    expect(
      deriveGitHubServiceHealth(
        summary([
          { id: "brv1bkgrwx7q", name: "API Requests", status: "operational" },
          { id: "hhtssxt0f5v2", name: "Pull Requests", status: "operational" },
        ]),
      ),
    ).toBeNull();
  });

  // The strictness rule: a page-wide "major" indicator driven entirely by
  // products ADE never calls must not become an ADE-facing outage claim.
  it("ignores outages confined to components ADE does not use", () => {
    expect(
      deriveGitHubServiceHealth(
        summary([
          { id: "pjmpxvq2cmr2", name: "Copilot", status: "major_outage" },
          { id: "h2ftsgbw7kmk", name: "Codespaces", status: "major_outage" },
          { id: "vg70hn9s2tyj", name: "Pages", status: "degraded_performance" },
          { id: "st3j38cctv9l", name: "Packages", status: "partial_outage" },
          { id: "brv1bkgrwx7q", name: "API Requests", status: "operational" },
        ]),
      ),
    ).toBeNull();
  });

  it("matches components by name when the id is unfamiliar", () => {
    const health = deriveGitHubServiceHealth(
      summary([{ id: "rotated-id", name: "Pull Requests", status: "major_outage" }]),
    );
    expect(health?.affected[0]?.surface).toBe("pulls");
  });

  it("attaches the active incident and skips resolved ones", () => {
    const health = deriveGitHubServiceHealth(
      summary(
        [{ id: "brv1bkgrwx7q", name: "API Requests", status: "major_outage" }],
        {
          incidents: [
            { name: "Old incident", shortlink: "https://stspg.io/old", resolved_at: "2026-08-16T00:00:00Z" },
            { name: "Incident with GitHub.com", shortlink: "https://stspg.io/new", resolved_at: null },
          ],
        },
      ),
    );
    expect(health?.incidentUrl).toBe("https://stspg.io/new");
  });

  // The incident link is third-party data that reaches window.open on the web
  // client, which has no allowlist of its own.
  it("drops an incident link that is not https", () => {
    const health = deriveGitHubServiceHealth(
      summary(
        [{ id: "brv1bkgrwx7q", name: "API Requests", status: "major_outage" }],
        { incidents: [{ name: "x", shortlink: "javascript:alert(1)", resolved_at: null }] },
      ),
    );
    expect(health?.incidentUrl).toBeNull();
  });

  it("returns null for malformed payloads rather than inventing an outage", () => {
    expect(deriveGitHubServiceHealth(null)).toBeNull();
    expect(deriveGitHubServiceHealth("<html>503</html>")).toBeNull();
    expect(deriveGitHubServiceHealth({})).toBeNull();
    expect(deriveGitHubServiceHealth({ components: "nope" })).toBeNull();
    expect(
      deriveGitHubServiceHealth({ components: [{ id: "brv1bkgrwx7q", status: "bogus_status" }] }),
    ).toBeNull();
  });

  it("assumes a major incident when the status block is missing", () => {
    const health = deriveGitHubServiceHealth(
      { components: [{ id: "brv1bkgrwx7q", name: "API Requests", status: "major_outage" }] },
    );
    expect(health?.indicator).toBe("major");
  });
});

describe("githubServiceAffectedLabel", () => {
  it("joins component names for display", () => {
    const health = deriveGitHubServiceHealth(
      summary([
        { id: "brv1bkgrwx7q", name: "API Requests", status: "major_outage" },
        { id: "hhtssxt0f5v2", name: "Pull Requests", status: "major_outage" },
      ]),
    )!;
    expect(githubServiceAffectedLabel(health)).toBe("API Requests and Pull Requests");
  });
});

describe("isGithubServiceUnavailable", () => {
  it("detects GitHub's own 5xx body", () => {
    expect(
      isGithubServiceUnavailable({
        message: "No server is currently available to service your request. Sorry about that.",
      }),
    ).toBe(true);
  });

  it("detects any 5xx status even with an opaque message", () => {
    expect(isGithubServiceUnavailable({ status: 503, message: "" })).toBe(true);
    expect(isGithubServiceUnavailable({ status: 500, message: "oops" })).toBe(true);
  });

  it("does not claim an outage for credential rejections", () => {
    expect(isGithubServiceUnavailable({ status: 401, message: "Bad credentials" })).toBe(false);
    expect(isGithubServiceUnavailable({ status: 403, message: "Resource not accessible" })).toBe(false);
    expect(isGithubServiceUnavailable({ message: null })).toBe(false);
  });

  // Generic wording appears on responses that ARE the user's problem (a proxy
  // error page, a 404 for a repo the credential cannot see). Telling those
  // users "nothing to fix here" would be a lie, so message-only matching must
  // stay narrow to GitHub's own phrasing.
  it("does not treat generic error wording as a GitHub outage", () => {
    expect(isGithubServiceUnavailable({ message: "Internal server error" })).toBe(false);
    expect(isGithubServiceUnavailable({ message: "This is not the web page you are looking for" })).toBe(false);
  });
});

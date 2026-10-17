import { describe, expect, it, vi } from "vitest";
import type { SyncCredentialStore } from "../../../../../ade-cli/src/services/credentials/credentialStore";
import { createJiraCredentialService } from "../jira/jiraCredentialService";
import { createJiraService } from "../jira/jiraService";
import { createLinearCredentialService } from "../cto/linearCredentialService";
import { createLinearClient } from "../cto/linearClient";
import { createLinearIssueTracker } from "../cto/linearIssueTracker";
import { IssueTrackerError } from "./issueTrackerError";
import { createIssueTrackerService } from "./issueTrackerService";

class MemoryCredentialStore implements SyncCredentialStore {
  private values = new Map<string, string>();

  async get(key: string): Promise<string | null> { return this.getSync(key); }
  async set(key: string, value: string): Promise<void> { this.setSync(key, value); }
  async delete(key: string): Promise<void> { this.deleteSync(key); }
  getSync(key: string): string | null { return this.values.get(key) ?? null; }
  setSync(key: string, value: string): void { this.values.set(key, value); }
  deleteSync(key: string): void { this.values.delete(key); }
  updateSync(updater: (values: Record<string, string>) => boolean | void): void {
    const next = Object.fromEntries(this.values);
    if (updater(next) === false) return;
    this.values = new Map(Object.entries(next));
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("createIssueTrackerService bare-key resolution", () => {
  it.each(["linear", "jira"] as const)("reports a %s catalogue outage and retains its previous keys", async (tracker) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T12:00:00.000Z"));
    try {
      let catalogueReads = 0;
      let service: ReturnType<typeof createIssueTrackerService>;
      if (tracker === "linear") {
        const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
          const request = JSON.parse(String(init?.body)) as { query: string };
          if (request.query.includes("AllTeamStates")) {
            catalogueReads += 1;
            if (catalogueReads > 1) {
              return jsonResponse({ errors: [{ message: "Linear workflow state catalogue unavailable" }] });
            }
            return jsonResponse({ data: { teams: { nodes: [{
              id: "team-good",
              key: "GOOD",
              states: { nodes: [{ id: "state-todo", name: "Todo", type: "unstarted" }] },
            }] } } });
          }
          return jsonResponse({ data: { viewer: { id: "viewer-1", name: "Test User" }, organization: { id: "org-1" } } });
        });
        const credentials = createLinearCredentialService({
          adeDir: "/tmp/ade-issue-tracker-linear-test",
          credentialStore: new MemoryCredentialStore(),
        });
        credentials.setToken("linear-test-token");
        const client = createLinearClient({ credentials, fetchImpl });
        service = createIssueTrackerService({
          linearIssueTracker: createLinearIssueTracker({ client }),
        });
      } else {
        const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(String(input));
          if (url.pathname.endsWith("/myself")) {
            return jsonResponse({ accountId: "jira-account", displayName: "Jira User" });
          }
          if (url.pathname.endsWith("/project/search")) {
            catalogueReads += 1;
            if (catalogueReads > 1) return jsonResponse({ errorMessages: ["Jira project catalogue unavailable"] }, 503);
            return jsonResponse({ values: [{ id: "project-good", key: "GOOD", name: "Good project" }], isLast: true, total: 1 });
          }
          throw new Error(`Unexpected Jira request: ${init?.method ?? "GET"} ${url.pathname}`);
        });
        const credentials = createJiraCredentialService({ credentialStore: new MemoryCredentialStore() });
        const jiraService = createJiraService({ credentials, fetchImpl });
        await jiraService.connect({ siteUrl: "https://acme.atlassian.net", email: "user@example.test", apiToken: "jira-test-token" });
        service = createIssueTrackerService({ jiraService });
      }

      const known = await service.resolve({ reference: "GOOD-1" });
      expect(known.kind).toBe(tracker);
      expect(known.reference).toMatchObject(tracker === "linear"
        ? { provider: "linear", identifier: "GOOD-1" }
        : { provider: "jira", key: "GOOD-1" });

      await vi.advanceTimersByTimeAsync(60_001);
      const outage = await service.resolve({ reference: "KEY-1" }).catch((error: unknown) => error);
      expect(outage).toBeInstanceOf(IssueTrackerError);
      expect(outage).toMatchObject({
        tracker,
        operation: "resolve",
        reason: "failed",
      });
      expect((outage as Error).message).toContain(
        tracker === "linear" ? "Linear workflow state catalogue unavailable" : "Jira project catalogue unavailable",
      );

      const retained = await service.resolve({ reference: "GOOD-2" });
      expect(retained.kind).toBe(tracker);
      expect(retained.reference).toMatchObject(tracker === "linear"
        ? { provider: "linear", identifier: "GOOD-2" }
        : { provider: "jira", key: "GOOD-2" });
      expect(catalogueReads).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

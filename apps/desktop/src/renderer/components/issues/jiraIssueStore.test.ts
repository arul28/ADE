/* @vitest-environment jsdom */

import vm from "node:vm";
import v8 from "node:v8";
import { setImmediate as nextTask } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { OpenProjectBinding } from "../../../shared/types";
import type { JiraIssueSummary } from "../../../shared/types/jira";
import { loadJiraIssueList } from "./jiraIssueStore";

// The issue list cache keeps a bounded history of search listings. A pane that
// has moved on to other searches must not keep every past search's rows in
// memory for the rest of the session. Retention is only observable by holding
// WeakRefs to rows and running a real collection (the same technique the
// Effect-based store's fix used).

function resolveGc(): () => void {
  const exposed = (globalThis as { gc?: () => void }).gc;
  if (typeof exposed === "function") return exposed;
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc") as unknown;
  if (typeof gc !== "function") throw new Error("The test runner did not expose gc.");
  return gc as () => void;
}

const PIN: OpenProjectBinding = { kind: "local", key: "local-reader", rootPath: "/repo", displayName: "repo" };

function summary(key: string): JiraIssueSummary {
  return {
    id: key,
    key,
    projectKey: "ACME",
    title: key,
    status: { id: "1", name: "Open", category: "new" },
    issueType: { id: "10001", name: "Task", iconUrl: null, subtask: false },
    priority: null,
    assignee: null,
    reporter: null,
    labels: [],
    parentKey: null,
    url: `https://acme.atlassian.net/browse/${key}`,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

describe("Jira issue list cache", () => {
  it("lets a past search's rows go once the pane has searched on", async () => {
    const gc = resolveGc();
    const seen: JiraIssueSummary[][] = [];
    (window as any).ade = {
      jira: {
        listIssues: async ({ query }: { query?: string }) => {
          const issues = [0, 1, 2, 3].map((n) => summary(`${query}-${n}`));
          seen.push(issues);
          return { issues, nextCursor: null };
        },
      },
    };

    for (let i = 0; i < 60; i += 1) {
      await loadJiraIssueList(null, { query: `q${i}` }, { pin: PIN });
    }

    // Only the first, long-forgotten search's rows are tracked; the listings
    // after it stay reachable through the cache as they should.
    const refs = seen[0]!.map((row) => new WeakRef(row));
    seen.length = 0;
    await nextTask();
    gc();
    expect(refs.filter((ref) => ref.deref() !== undefined), "historical Jira searches retained after the pane closed").toEqual([]);
  }, 20_000);
});

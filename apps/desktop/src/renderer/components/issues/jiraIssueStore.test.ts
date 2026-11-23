/* @vitest-environment jsdom */

import vm from "node:vm";
import v8 from "node:v8";
import { setImmediate as nextTask } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { OpenProjectBinding } from "../../../shared/types";
import type { JiraIssueSummary } from "../../../shared/types/jira";
import { loadJiraIssueList, useJiraIssueList } from "./jiraIssueStore";

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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

type ListPage = { issues: JiraIssueSummary[]; nextCursor: string | null };

describe("Jira issue list cache", () => {
  afterEach(cleanup);

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

  it("ignores a slow reply for a search that restarted after its listing was evicted", async () => {
    const slow = deferred<ListPage>();
    const fresh = deferred<ListPage>();
    let flakyCalls = 0;
    (window as any).ade = {
      jira: {
        listIssues: ({ query }: { query?: string }) => {
          if (query !== "flaky") return Promise.resolve({ issues: [summary(`${query}-0`)], nextCursor: null });
          flakyCalls += 1;
          return (flakyCalls === 1 ? slow : fresh).promise;
        },
      },
    };
    // `enabled: false` keeps the hook from starting its own read; the test
    // orders the two "flaky" requests itself.
    const { result } = renderHook(() => useJiraIssueList({ query: "flaky" }, false, "", PIN));

    const first = loadJiraIssueList(null, { query: "flaky" }, { pin: PIN });
    // Fill the bounded history past MAX_LISTS with other searches, which evicts
    // the "flaky" listing (and its request token) while its reply is in flight.
    for (let i = 0; i < 40; i += 1) {
      await loadJiraIssueList(null, { query: `filler-${i}` }, { pin: PIN });
    }
    const second = loadJiraIssueList(null, { query: "flaky" }, { pin: PIN });
    await act(async () => {
      fresh.resolve({ issues: [summary("ACME-NEW")], nextCursor: null });
      await second;
    });
    await act(async () => {
      slow.resolve({ issues: [summary("ACME-OLD")], nextCursor: null });
      await first;
    });

    expect(result.current.status).toBe("ready");
    expect(result.current.issues.map((issue) => issue.key)).toEqual(["ACME-NEW"]);
  });
});

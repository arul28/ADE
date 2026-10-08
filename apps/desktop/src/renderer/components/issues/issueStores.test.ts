/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useAppStore } from "../../state/appStore";
import type { NormalizedLinearIssue } from "../../../shared/types";
import {
  editGitHubIssue,
  loadGitHubIssue,
  loadGitHubIssueList,
  normalizeGitHubIssue,
  peekGitHubIssue,
  useGitHubIssue,
} from "./githubIssueStore";
import { editLinearIssue, peekLinearIssue } from "./linearIssueStore";
import { initialIssueForm, writeIssueDraft } from "./issueCreateDraft";

// The issue stores and the create draft, through their exported functions with
// only the `window.ade` bridge faked: what the viewer, the sheet, the panes and
// the create composer rely on.

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const rawGitHubIssue = (number: number, title: string, extra: Record<string, unknown> = {}) => ({
  number,
  title,
  html_url: `https://github.com/acme/ade/issues/${number}`,
  state: "open",
  labels: [],
  assignees: [],
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  ...extra,
});

function linearIssue(title: string): NormalizedLinearIssue {
  return {
    id: "lin-1",
    identifier: "ADE-1",
    title,
    description: "",
    url: "https://linear.app/ade/issue/ADE-1",
    projectId: "project-1",
    projectSlug: "desktop",
    projectName: "Desktop",
    teamId: "team-1",
    teamKey: "ADE",
    teamName: "ADE",
    stateId: "state-1",
    stateName: "Todo",
    stateType: "unstarted",
    priority: 0,
    priorityLabel: "none",
    labels: [],
    metadataTags: [],
    assigneeId: null,
    assigneeName: null,
    creatorId: null,
    creatorName: null,
    blockerIssueIds: [],
    hasOpenBlockers: false,
    dueDate: null,
    estimate: null,
    archivedAt: null,
    completedAt: null,
    canceledAt: null,
    startedAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    raw: {},
  } as unknown as NormalizedLinearIssue;
}

const EMPTY_CATALOG = { projects: [], users: [], states: [], labels: [] };

/**
 * Two title edits on one issue, the first one's reply arriving last (or
 * failing last). Each tracker gets its own project root so the caches never
 * share an entry between cases.
 */
const trackers = [
  {
    name: "GitHub",
    setup: (root: string) => {
      const issue = normalizeGitHubIssue("acme", "ade", rawGitHubIssue(7, "Original"))!;
      const replies: Array<Deferred<unknown>> = [];
      (window as any).ade = { github: { updateIssue: vi.fn(() => { const next = deferred<unknown>(); replies.push(next); return next.promise; }) } };
      return {
        edit: (title: string) => editGitHubIssue(root, issue, { title }, { title }),
        reply: (index: number, title: string) => replies[index]!.resolve(rawGitHubIssue(7, title)),
        fail: (index: number) => replies[index]!.reject(new Error("GitHub said no")),
        shown: () => peekGitHubIssue(root, "acme", "ade", 7)?.title,
      };
    },
  },
  {
    name: "Linear",
    setup: (root: string) => {
      const issue = linearIssue("Original");
      const replies: Array<Deferred<unknown>> = [];
      (window as any).ade = { cto: { updateLinearIssue: vi.fn(() => { const next = deferred<unknown>(); replies.push(next); return next.promise; }) } };
      return {
        edit: (title: string) => editLinearIssue(root, issue, { title }, EMPTY_CATALOG as never),
        reply: (index: number, title: string) => replies[index]!.resolve(linearIssue(title)),
        fail: (index: number) => replies[index]!.reject(new Error("Linear said no")),
        shown: () => peekLinearIssue(root, "ADE-1")?.title,
      };
    },
  },
];

describe("issue edits: the newest edit wins", () => {
  afterEach(() => {
    delete (window as any).ade;
  });

  it.each(trackers)("$name: a slower reply to an earlier edit does not replace the newer one", async ({ setup }) => {
    const tracker = setup(`/root/${Math.random()}`);
    const first = tracker.edit("First");
    const second = tracker.edit("Second");
    expect(tracker.shown()).toBe("Second");

    tracker.reply(1, "Second");
    await second;
    tracker.reply(0, "First");
    await first;
    expect(tracker.shown()).toBe("Second");
  });

  it.each(trackers)("$name: an earlier edit that fails does not roll back a newer one", async ({ setup }) => {
    const tracker = setup(`/root/${Math.random()}`);
    const first = tracker.edit("First");
    const second = tracker.edit("Second");

    tracker.reply(1, "Second");
    await second;
    tracker.fail(0);
    await expect(first).rejects.toThrow(/said no/);
    expect(tracker.shown()).toBe("Second");
  });
});

describe("a read that started before an edit", () => {
  afterEach(() => {
    delete (window as any).ade;
  });

  it("does not put the pre-edit copy back when it lands after the edit", async () => {
    const root = `/root/${Math.random()}`;
    const read = deferred<unknown>();
    (window as any).ade = {
      github: {
        getIssue: vi.fn(() => read.promise),
        updateIssue: vi.fn(async () => rawGitHubIssue(5, "Saved title")),
      },
    };
    const refresh = loadGitHubIssue(root, "acme", "ade", 5, { force: true });
    const issue = normalizeGitHubIssue("acme", "ade", rawGitHubIssue(5, "Old title"))!;
    await editGitHubIssue(root, issue, { title: "Saved title" }, { title: "Saved title" });
    expect(peekGitHubIssue(root, "acme", "ade", 5)?.title).toBe("Saved title");

    read.resolve(rawGitHubIssue(5, "Old title"));
    await refresh;
    expect(peekGitHubIssue(root, "acme", "ade", 5)?.title).toBe("Saved title");
  });
});

describe("GitHub list rows are partial copies", () => {
  afterEach(() => {
    delete (window as any).ade;
  });

  it("shows a row at once, but opening it reads the whole issue (once)", async () => {
    const root = `/root/${Math.random()}`;
    const getIssue = vi.fn(async () => rawGitHubIssue(9, "Whole issue", { labels: [{ name: "a" }, { name: "b" }] }));
    (window as any).ade = {
      github: {
        listRepoIssueList: vi.fn(async () => [rawGitHubIssue(9, "From the list", { labels: [{ name: "a" }] })]),
        getIssue,
      },
    };
    loadGitHubIssueList(root, { owner: "acme", name: "ade" }, "open");
    await vi.waitFor(() => expect(peekGitHubIssue(root, "acme", "ade", 9)?.title).toBe("From the list"));

    // A list row holds only the first labels; it must not count as read.
    await loadGitHubIssue(root, "acme", "ade", 9);
    expect(getIssue).toHaveBeenCalledTimes(1);
    expect(peekGitHubIssue(root, "acme", "ade", 9)?.labels.map((label) => label.name)).toEqual(["a", "b"]);

    // The whole issue, once read, is served from the cache.
    await loadGitHubIssue(root, "acme", "ade", 9);
    expect(getIssue).toHaveBeenCalledTimes(1);
  });

  it("an open issue that a list refresh made partial is read again", async () => {
    const root = `/root/${Math.random()}`;
    useAppStore.setState({ project: { rootPath: root, displayName: "ADE" }, projectBinding: null } as never);
    const getIssue = vi.fn(async () => rawGitHubIssue(11, "Whole", { updated_at: "2026-10-01T00:00:00Z" }));
    const listRepoIssueList = vi.fn(async () => [rawGitHubIssue(11, "Edited on GitHub", { updated_at: "2026-10-02T00:00:00Z" })]);
    (window as any).ade = { github: { getIssue, listRepoIssueList } };

    const { result } = renderHook(() => useGitHubIssue({ owner: "acme", repo: "ade", number: 11 }));
    await vi.waitFor(() => expect(result.current.issue?.title).toBe("Whole"));
    expect(getIssue).toHaveBeenCalledTimes(1);

    getIssue.mockImplementation(async () => rawGitHubIssue(11, "Edited on GitHub", { updated_at: "2026-10-02T00:00:00Z" }));
    loadGitHubIssueList(root, { owner: "acme", name: "ade" }, "open", { force: true });
    await vi.waitFor(() => expect(getIssue).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(result.current.fetchedAt).toBeGreaterThan(0));
    expect(result.current.issue?.title).toBe("Edited on GitHub");
  });
});

describe("the create draft", () => {
  beforeEach(() => window.localStorage.clear());

  it("belongs to one project, never brings back a parent, and keeps form answers", () => {
    writeIssueDraft("github", "/project-a", {
      title: "Crash on launch",
      body: "Steps…",
      linear: initialIssueForm({}, null).linear,
      github: { labels: ["bug"], assignees: [], milestone: 3, type: null, parent: "12", templateKey: "bug.yml" },
      formAnswers: { 0: "macOS 26" },
    });

    const sameProject = initialIssueForm({ provider: "github" }, "/project-a");
    expect(sameProject.title).toBe("Crash on launch");
    expect(sameProject.github.labels).toEqual(["bug"]);
    expect(sameProject.github.parent).toBe("");
    expect(sameProject.formAnswers).toEqual({ 0: "macOS 26" });

    const otherProject = initialIssueForm({ provider: "github" }, "/project-b");
    expect(otherProject.title).toBe("");
    expect(otherProject.github.labels).toEqual([]);
    expect(otherProject.github.milestone).toBeNull();

    // A sub-issue request sets its own parent; a text prefill starts clean.
    const subIssue = initialIssueForm(
      { prefill: { parent: { provider: "github", owner: "acme", repo: "ade", number: 40 } } },
      "/project-a",
    );
    expect(subIssue.github.parent).toBe("40");
    expect(initialIssueForm({ provider: "github", prefill: { title: "From chat" } }, "/project-a").github.labels).toEqual([]);
  });
});

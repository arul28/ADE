"use strict";

function collectionStore() {
  const bags = new Map();
  function bag(name) {
    if (!bags.has(name)) bags.set(name, new Map());
    return bags.get(name);
  }
  return {
    async put(collection, key, value) {
      bag(collection).set(key, { key, value });
    },
    async get(collection, key) {
      return bag(collection).get(key)?.value ?? null;
    },
    async list(collection, opts = {}) {
      const prefix = typeof opts.keyPrefix === "string" ? opts.keyPrefix : "";
      const limit = Number(opts.limit) || 400;
      const rows = [];
      for (const [key, row] of bag(collection)) {
        if (prefix && !key.startsWith(prefix)) continue;
        rows.push(row);
        if (rows.length >= limit) break;
      }
      return rows;
    },
    async delete(collection, key) {
      bag(collection).delete(key);
    },
    bags,
  };
}

function createSdk(overrides = {}) {
  const panels = new Map();
  const collections = collectionStore();
  const review = {
    listRuns: async () => [],
    getRunDetail: async () => null,
    listLaunchContext: async () => ({ lanes: [], recentCommitsByLane: {}, defaultLaneId: null }),
    startRun: async () => ({ runId: "run-1" }),
    rerun: async () => ({ runId: "run-2" }),
    cancelRun: async () => ({ id: "run-1" }),
    recordFeedback: async (args) => args,
    qualityReport: async () => ({ totalRuns: 0, totalFindings: 0 }),
    listSuppressions: async () => [],
    deleteSuppression: async () => true,
    ...(overrides.review ?? {}),
  };
  const sdk = {
    log() {},
    panels: {
      async update(id, schema) {
        panels.set(id, schema);
      },
    },
    collections,
    actions: {
      async invoke(domain, action, args) {
        if (domain !== "review") throw new Error(`unexpected domain ${domain}`);
        if (typeof review[action] !== "function") throw new Error(`unexpected review action ${action}`);
        return review[action](args);
      },
    },
    events: {
      on() {
        return () => {};
      },
    },
    clipboard: {
      async write() {},
    },
    ...overrides,
    panelsMap: panels,
    review,
  };
  return sdk;
}

function sampleRun(overrides = {}) {
  return {
    id: "run-1",
    laneId: "lane-1",
    target: { mode: "lane_diff", laneId: "lane-1" },
    targetLabel: "fix-login vs main",
    status: "completed",
    summary: "Two findings",
    findingCount: 2,
    severitySummary: { critical: 0, high: 1, medium: 1, low: 0, info: 0 },
    chatSessionId: "sess-1",
    createdAt: "2026-09-02T10:00:00.000Z",
    updatedAt: "2026-09-02T10:05:00.000Z",
    startedAt: "2026-09-02T10:00:01.000Z",
    endedAt: "2026-09-02T10:05:00.000Z",
    config: { publishBehavior: "local_only" },
    findings: [
      {
        id: "find-1",
        runId: "run-1",
        title: "Missing null check",
        severity: "high",
        body: "auth.ts does not guard a missing user.",
        filePath: "src/auth.ts",
        line: 42,
      },
    ],
    reviewerRuns: [
      { reviewerKey: "diff-risk", label: "Diff risk", status: "completed" },
    ],
    publications: [],
    ...overrides,
  };
}

module.exports = { createSdk, sampleRun };

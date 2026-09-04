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
  const git = {
    listRecentCommits: async () => [],
    listBranches: async () => [],
    getCommit: async () => null,
    getCommitMessage: async () => "",
    listCommitFiles: async () => [],
    isCommitInLaneHistory: async () => false,
    getOriginRemote: async () => ({ remoteUrl: null, branch: null }),
    getOpenPrForBranch: async () => ({ prUrl: null, prNumber: null }),
    getConflictState: async () => null,
    stashList: async () => [],
    cherryPickCommit: async (args) => args,
    revertCommit: async (args) => args,
    resetToCommit: async (args) => args,
    checkoutBranch: async (args) => args,
    createTag: async (args) => args,
    fetch: async (args) => args,
    pull: async (args) => args,
    push: async (args) => args,
    undoLastHeadChange: async (args) => args,
    redoLastHeadChange: async (args) => args,
    sync: async (args) => args,
    stashPush: async (args) => args,
    stashApply: async (args) => args,
    stashPop: async (args) => args,
    stashDrop: async (args) => args,
    stashClear: async (args) => args,
    rebaseContinue: async (args) => args,
    rebaseAbort: async (args) => args,
    mergeContinue: async (args) => args,
    mergeAbort: async (args) => args,
    ...(overrides.git ?? {}),
  };
  const operation = {
    list: async () => [],
    get: async () => null,
    ...(overrides.operation ?? {}),
  };
  const lanes = {
    list: async () => [],
    create: async (args) => ({ id: "lane-new", name: args.name }),
    rename: async (args) => args,
    archive: async (args) => args,
    delete: async (args) => args,
    ...(overrides.lanes ?? {}),
  };
  const chat = {
    listSessions: async () => [],
    ...(overrides.chat ?? {}),
  };
  const cto = {
    getState: async () => null,
    ...(overrides.cto ?? {}),
  };
  const diff = {
    getFilePatch: async () => null,
    ...(overrides.diff ?? {}),
  };
  const history = {
    exportOperations: async () => ({ cancelled: true }),
    ...(overrides.history ?? {}),
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
        const table = { git, operation, lanes, lane: lanes, chat, cto, diff, history }[domain];
        if (!table) throw new Error(`unexpected domain ${domain}`);
        if (typeof table[action] !== "function") throw new Error(`unexpected ${domain} action ${action}`);
        return table[action](args);
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
    git,
    operation,
    lanes,
    chat,
  };
  return sdk;
}

function sampleCommit(overrides = {}) {
  return {
    sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    shortSha: "aaaaaaa",
    parents: ["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
    authorName: "Ada",
    authoredAt: "2026-09-02T10:00:00.000Z",
    subject: "Fix the rail",
    pushed: true,
    ...overrides,
  };
}

function sampleLane(overrides = {}) {
  return { id: "lane-1", name: "fix-login", ...overrides };
}

function sampleOperation(overrides = {}) {
  return {
    id: "op-1",
    laneId: "lane-1",
    laneName: "fix-login",
    kind: "git_commit",
    status: "succeeded",
    startedAt: "2026-09-02T10:00:00.000Z",
    endedAt: "2026-09-02T10:00:01.000Z",
    preHeadSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    postHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    metadataJson: null,
    ...overrides,
  };
}

module.exports = { createSdk, sampleCommit, sampleLane, sampleOperation };

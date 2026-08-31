import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openKvDb, type AdeDb } from "../state/kvDb";
import { isCrsqliteAvailable } from "../state/crsqliteExtension";
import { createLaneService } from "./laneService";
import {
  ISSUE_REF_KEY,
  issueRefToStoredLinearIssue,
  readLinearIssueRef,
  type IssueRef,
} from "../../../shared/issueRef";
import { parseLaneLinearIssueJson } from "../../../shared/laneLinearIssue";

vi.mock("../git/git", () => ({
  getHeadSha: vi.fn(),
  runGit: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  runGitOrThrow: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
}));

const roots: string[] = [];
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const PROJECT_ID = "project-issue-ref";
const LANE_ID = "12345678-lane";

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-issue-ref-"));
  roots.push(root);
  const db = await openKvDb(path.join(root, ".ade", "ade.db"), logger as never);
  const worktreesDir = path.join(root, ".ade", "worktrees");
  fs.mkdirSync(worktreesDir, { recursive: true });
  const now = "2026-08-01T00:00:00.000Z";
  db.run(
    "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
    [PROJECT_ID, root, "Fixture", "main", now, now],
  );
  db.run(
    `insert into lanes(
       id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
       attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
     ) values (?, ?, ?, null, 'worktree', 'main', 'feature/x', ?, null, 0, null, null, null, null, 'active', ?, null)`,
    [LANE_ID, PROJECT_ID, "Lane", path.join(worktreesDir, "lane-12345678"), now],
  );
  const service = createLaneService({
    db,
    projectRoot: root,
    projectId: PROJECT_ID,
    defaultBaseRef: "main",
    worktreesDir,
    logger: logger as never,
  });
  return { db, service, root };
}

function jiraRef(overrides: Partial<IssueRef> = {}): IssueRef {
  return {
    pluginId: "ade-jira",
    provider: "jira",
    issueId: "10042",
    key: "OPS-42",
    title: "Rotate the certificates",
    url: "https://example.atlassian.net/browse/OPS-42",
    state: { id: "3", name: "In Review", category: "started" },
    container: { id: "10000", key: "OPS", name: "Operations" },
    labels: ["security"],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  while (roots.length) {
    const root = roots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("laneService issue links across trackers", () => {
  it("links an issue from a tracker ADE has never heard of", async () => {
    const { service } = await fixture();
    const link = service.linkIssueRef({ laneId: LANE_ID, issue: jiraRef(), source: "plugin_link" });
    expect(link.issue).toMatchObject({ provider: "jira", key: "OPS-42", pluginId: "ade-jira" });
    expect(link.source).toBe("plugin_link");
    expect(service.listIssueLinks({ laneId: LANE_ID })).toHaveLength(1);
  });

  it("stores the ref in the existing column, not in a new one", async () => {
    const { db, service } = await fixture();
    service.linkIssueRef({ laneId: LANE_ID, issue: jiraRef() });
    const row = db.get<{ issue_id: string; issue_json: string }>(
      "select issue_id, issue_json from lane_linear_issue_links where project_id = ?",
      [PROJECT_ID],
    );
    // The row key is namespaced so two trackers cannot collide on the app-layer
    // uniqueness tuple, while the ref itself rides inside `issue_json`.
    expect(row?.issue_id).toBe("jira:10042");
    const parsed = JSON.parse(row!.issue_json) as Record<string, unknown>;
    expect(parsed[ISSUE_REF_KEY]).toMatchObject({ provider: "jira", issueId: "10042" });
    // And the legacy projection sits beside it, which is what an older peer reads.
    expect(parsed.identifier).toBe("OPS-42");
    expect(parseLaneLinearIssueJson(row!.issue_json)).not.toBeNull();
  });

  it("does not collide when two trackers mint the same issue id", async () => {
    const { service } = await fixture();
    service.linkIssueRef({ laneId: LANE_ID, issue: jiraRef({ provider: "jira", issueId: "7", key: "OPS-7" }) });
    service.linkIssueRef({ laneId: LANE_ID, issue: jiraRef({ provider: "asana", issueId: "7", key: "AS-7" }) });
    const providers = service.listIssueLinks({ laneId: LANE_ID }).map((link) => link.issue.provider);
    expect(providers.sort()).toEqual(["asana", "jira"]);
  });

  it("reports a legacy Linear lane through the generic reader with no migration", async () => {
    const { db, service } = await fixture();
    // Written the way an older build writes it: legacy fields only, no ref.
    const legacy = {
      id: "issue-uuid-1",
      identifier: "ADE-123",
      title: "Fix the thing",
      description: null,
      url: "https://linear.app/ade/issue/ADE-123",
      projectId: "p",
      projectSlug: "ade",
      projectName: null,
      teamId: "team-uuid",
      teamKey: "ADE",
      teamName: null,
      stateId: "state-uuid",
      stateName: "In Progress",
      stateType: "started",
      priority: 2,
      priorityLabel: "high",
      labels: [],
      assigneeId: null,
      assigneeName: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    db.run(
      `insert into lane_linear_issue_links(
         id, project_id, lane_id, issue_id, issue_json, role, source,
         include_in_pr, close_on_merge, evidence_json, created_at, updated_at
       ) values (?, ?, ?, ?, ?, 'referenced', 'manual', 1, 0, null, ?, ?)`,
      [
        "legacy-link", PROJECT_ID, LANE_ID, "issue-uuid-1", JSON.stringify(legacy),
        "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z",
      ],
    );
    const links = service.listIssueLinks({ laneId: LANE_ID });
    expect(links).toHaveLength(1);
    expect(links[0]!.issue).toMatchObject({
      provider: "linear",
      key: "ADE-123",
      issueId: "issue-uuid-1",
      pluginId: "core",
    });
  });

  it("refuses a link nothing downstream could display or reference", async () => {
    const { service } = await fixture();
    expect(() => service.linkIssueRef({ laneId: LANE_ID, issue: jiraRef({ title: "  " }) }))
      .toThrow(/missing a provider, an issue id, a key or a title/i);
  });

  it("refuses a call that names both a lane and a session, and one that names neither", async () => {
    const { service } = await fixture();
    expect(() => service.linkIssueRef({ laneId: LANE_ID, sessionId: "s", issue: jiraRef() }))
      .toThrow(/not both/i);
    expect(() => service.linkIssueRef({ issue: jiraRef() })).toThrow(/required/i);
  });
});

describe("laneService issue link ownership", () => {
  it("lets the plugin that made a link remove it", async () => {
    const { service } = await fixture();
    service.linkIssueRef({ laneId: LANE_ID, issue: jiraRef({ pluginId: "ade-jira" }) });
    expect(service.unlinkIssueRef({
      laneId: LANE_ID, provider: "jira", issueId: "10042", requirePluginId: "ade-jira",
    })).toBe(true);
    expect(service.listIssueLinks({ laneId: LANE_ID })).toHaveLength(0);
  });

  it("refuses to let one plugin remove another plugin's link, and names the owner", async () => {
    const { service } = await fixture();
    service.linkIssueRef({ laneId: LANE_ID, issue: jiraRef({ pluginId: "ade-jira" }) });
    expect(() => service.unlinkIssueRef({
      laneId: LANE_ID, provider: "jira", issueId: "10042", requirePluginId: "ade-linear",
    })).toThrow(/belongs to "ade-jira"/);
    expect(service.listIssueLinks({ laneId: LANE_ID })).toHaveLength(1);
  });

  it("lets the user remove any link, including one a plugin made", async () => {
    const { service } = await fixture();
    service.linkIssueRef({ laneId: LANE_ID, issue: jiraRef({ pluginId: "ade-jira" }) });
    // No `requirePluginId` is the user's path, through the UI, the CLI and the TUI.
    expect(service.unlinkIssueRef({ laneId: LANE_ID, provider: "jira", issueId: "10042" })).toBe(true);
  });

  it("answers false rather than refusing for a link that is not there", async () => {
    const { service } = await fixture();
    expect(service.unlinkIssueRef({
      laneId: LANE_ID, provider: "jira", issueId: "nope", requirePluginId: "ade-linear",
    })).toBe(false);
  });
});

describe("lane summaries carry the generic shape", () => {
  it("derives primaryIssue and issueLinks without storing them", async () => {
    const { service } = await fixture();
    service.linkIssueRef({ laneId: LANE_ID, issue: jiraRef() });
    const lane = await service.getSummary(LANE_ID, { includeStatus: false });
    expect(lane?.issueLinks?.map((link) => link.issue.provider)).toContain("jira");
    // The legacy fields stay populated beside them, so no existing reader loses
    // anything while the migration to the generic shape is in progress.
    expect(lane).toHaveProperty("linearIssueLinks");
  });

  it("reports a plugin's primary link as the primary issue when the lane has no legacy row", async () => {
    const { service } = await fixture();
    // A plugin writes only the link table, never `lane_linear_issues`, because
    // that row is what named the branch and is not a plugin's to overwrite.
    // Recording `role: "primary"` and then reporting no primary would be a lie.
    service.linkIssueRef({ laneId: LANE_ID, issue: jiraRef(), role: "primary", source: "plugin_link" });
    const lane = await service.getSummary(LANE_ID, { includeStatus: false });
    expect(lane?.linearIssue ?? null).toBeNull();
    expect(lane?.primaryIssue).toMatchObject({ provider: "jira", key: "OPS-42" });
  });

  it("keeps the legacy row as the primary when there is one, because it named the branch", async () => {
    const { db, service } = await fixture();
    db.run(
      `insert into lane_linear_issues(id, project_id, lane_id, issue_id, issue_json, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
      [
        "primary-row", PROJECT_ID, LANE_ID, "issue-uuid-1",
        JSON.stringify({
          id: "issue-uuid-1", identifier: "ADE-123", title: "Fix the thing", description: null,
          url: null, projectId: "p", projectSlug: "ade", projectName: null, teamId: "t",
          teamKey: "ADE", teamName: null, stateId: "s", stateName: "Todo", stateType: "unstarted",
          priority: 0, priorityLabel: "none", labels: [], assigneeId: null, assigneeName: null,
          createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
        }),
        "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z",
      ],
    );
    service.linkIssueRef({ laneId: LANE_ID, issue: jiraRef(), role: "primary", source: "plugin_link" });
    const lane = await service.getSummary(LANE_ID, { includeStatus: false });
    expect(lane?.primaryIssue).toMatchObject({ provider: "linear", key: "ADE-123" });
  });
});

// The compatibility mechanism is "change no SQL". These two tests are the lock
// on that, because the moment a column appears here, every peer on an older
// build starts receiving changesets naming a column its schema lacks, and
// nothing in the sync layer filters or negotiates that away.
describe("the replicated issue-link tables keep their frozen shape", () => {
  const EXPECTED_COLUMNS: Record<string, string[]> = {
    lane_linear_issues: [
      "id", "project_id", "lane_id", "issue_id", "issue_json", "created_at", "updated_at",
    ],
    lane_linear_issue_links: [
      "id", "project_id", "lane_id", "issue_id", "issue_json", "role", "source",
      "include_in_pr", "close_on_merge", "evidence_json", "created_at", "updated_at",
    ],
    session_linear_issues: [
      "id", "project_id", "session_id", "lane_id", "issue_id", "issue_json", "role", "source",
      "include_in_pr", "close_on_merge", "evidence_json", "created_at", "updated_at",
    ],
  };

  it("adds no column for the provider-neutral issue link", async () => {
    const { db } = await fixture();
    for (const [table, expected] of Object.entries(EXPECTED_COLUMNS)) {
      const columns = db.all<{ name: string }>(`pragma table_info(${table})`).map((c) => c.name);
      expect(columns, `${table} gained or lost a column`).toEqual(expected);
    }
  });

  it("carries no unique index besides the primary key, as crsql_as_crr demands", async () => {
    const { db } = await fixture();
    for (const table of Object.keys(EXPECTED_COLUMNS)) {
      // `origin: "pk"` is the primary key's own autoindex, which is the one
      // unique index a CRR table is allowed to keep.
      const unique = db.all<{ name: string; unique: number; origin: string }>(
        `pragma index_list(${table})`,
      ).filter((index) => index.unique === 1 && index.origin !== "pk");
      expect(unique, `${table} carries a unique index`).toEqual([]);
    }
  });
});

describe.skipIf(!isCrsqliteAvailable())("the generic shape survives a sync round trip", () => {
  it("reaches a peer with its tracker identity intact", async () => {
    const a = await fixture();
    const bRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-issue-ref-peer-"));
    roots.push(bRoot);
    const b: AdeDb = await openKvDb(path.join(bRoot, ".ade", "ade.db"), logger as never);

    a.service.linkIssueRef({ laneId: LANE_ID, issue: jiraRef(), source: "plugin_link" });
    const result = b.sync.applyChanges(a.db.sync.exportChangesSince(0));
    expect(result).toBeTruthy();

    const row = b.get<{ issue_id: string; issue_json: string }>(
      "select issue_id, issue_json from lane_linear_issue_links where project_id = ?",
      [PROJECT_ID],
    );
    expect(row?.issue_id).toBe("jira:10042");
    const onPeer = parseLaneLinearIssueJson(row!.issue_json);
    // The peer parses the row at all — the legacy projection did its job — and
    // the tracker identity came across inside the column.
    expect(onPeer).not.toBeNull();
    expect(readLinearIssueRef(onPeer!)).toMatchObject({ provider: "jira", key: "OPS-42" });
    b.close();
  });

  it("reaches a peer whose parser predates the ref, still readable", async () => {
    const a = await fixture();
    const bRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-issue-ref-oldpeer-"));
    roots.push(bRoot);
    const b: AdeDb = await openKvDb(path.join(bRoot, ".ade", "ade.db"), logger as never);

    a.service.linkIssueRef({ laneId: LANE_ID, issue: jiraRef() });
    b.sync.applyChanges(a.db.sync.exportChangesSince(0));

    const row = b.get<{ issue_json: string }>(
      "select issue_json from lane_linear_issue_links where project_id = ?",
      [PROJECT_ID],
    );
    // Simulate the older build's parser: it reads named fields only and has no
    // case for the reserved key. It must still get a complete, displayable
    // issue, because that is the whole compatibility bet.
    const raw = JSON.parse(row!.issue_json) as Record<string, unknown>;
    delete raw[ISSUE_REF_KEY];
    const asOldPeerSeesIt = parseLaneLinearIssueJson(JSON.stringify(raw));
    expect(asOldPeerSeesIt).toMatchObject({
      identifier: "OPS-42",
      title: "Rotate the certificates",
      url: "https://example.atlassian.net/browse/OPS-42",
      stateName: "In Review",
      teamKey: "OPS",
    });
    b.close();
  });

  it("applies twice without changing the result", async () => {
    const a = await fixture();
    const bRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-issue-ref-idem-"));
    roots.push(bRoot);
    const b: AdeDb = await openKvDb(path.join(bRoot, ".ade", "ade.db"), logger as never);

    a.service.linkIssueRef({ laneId: LANE_ID, issue: jiraRef() });
    const changes = a.db.sync.exportChangesSince(0);
    b.sync.applyChanges(changes);
    b.sync.applyChanges(changes);
    const count = b.get<{ n: number }>(
      "select count(*) as n from lane_linear_issue_links where project_id = ?",
      [PROJECT_ID],
    );
    expect(count?.n).toBe(1);
    b.close();
  });
});

describe("stored refs round-trip through the store", () => {
  it("keeps the ref across a read-back, which the row parser would otherwise drop", async () => {
    const { service } = await fixture();
    const ref = jiraRef();
    service.linkIssueRef({ laneId: LANE_ID, issue: ref });
    const link = service.listIssueLinks({ laneId: LANE_ID })[0]!;
    expect(link.issue).toMatchObject({
      pluginId: "ade-jira",
      provider: "jira",
      issueId: "10042",
      key: "OPS-42",
      title: "Rotate the certificates",
    });
    expect(readLinearIssueRef(issueRefToStoredLinearIssue(ref)).provider).toBe("jira");
  });
});

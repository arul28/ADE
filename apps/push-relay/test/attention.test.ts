import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  attentionTestInternals,
  pruneAttentionState,
  type AttentionRelayEnv,
} from "../src/attention";

type NativeStatement = {
  all: (...values: unknown[]) => Array<Record<string, unknown>>;
  get: (...values: unknown[]) => Record<string, unknown> | undefined;
  run: (...values: unknown[]) => unknown;
};

type NativeDatabase = {
  close: () => void;
  exec: (sql: string) => void;
  prepare: (sql: string) => NativeStatement;
};

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => NativeDatabase;
};

class SqliteD1Statement {
  private values: unknown[] = [];

  constructor(
    private readonly database: NativeDatabase,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): this {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.database.prepare(this.sql).get(...this.values) ?? null) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return {
      results: this.database.prepare(this.sql).all(...this.values) as T[],
    };
  }

  async run(): Promise<{ success: boolean }> {
    this.runSync();
    return { success: true };
  }

  runSync(): void {
    this.database.prepare(this.sql).run(...this.values);
  }
}

class SqliteD1Database {
  readonly native = new DatabaseSync(":memory:");

  constructor() {
    for (const migration of [
      "../migrations/0001_push_registrations.sql",
      "../migrations/0002_rate_and_budget.sql",
      "../migrations/0003_account_attention.sql",
    ]) {
      this.native.exec(readFileSync(new URL(migration, import.meta.url), "utf8"));
    }
  }

  prepare(sql: string): SqliteD1Statement {
    return new SqliteD1Statement(this.native, sql);
  }

  async batch(statements: SqliteD1Statement[]): Promise<Array<{ success: boolean }>> {
    this.native.exec("begin immediate");
    try {
      for (const statement of statements) statement.runSync();
      this.native.exec("commit");
      return statements.map(() => ({ success: true }));
    } catch (error) {
      this.native.exec("rollback");
      throw error;
    }
  }

  close(): void {
    this.native.close();
  }
}

function makeAttentionEnv(database: SqliteD1Database): AttentionRelayEnv {
  return { DB: database as unknown as D1Database };
}

function row<T extends Record<string, unknown>>(
  database: SqliteD1Database,
  sql: string,
  ...values: unknown[]
): T | undefined {
  return database.native.prepare(sql).get(...values) as T | undefined;
}

function rows<T extends Record<string, unknown>>(
  database: SqliteD1Database,
  sql: string,
  ...values: unknown[]
): T[] {
  return database.native.prepare(sql).all(...values) as T[];
}

async function accountRoute(
  database: SqliteD1Database,
  userId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const request = new Request(`https://push.example${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await attentionTestInternals.handleAuthorizedAttentionAccountRequest(
    request,
    makeAttentionEnv(database),
    new URL(request.url),
    userId,
  );
  if (!response) throw new Error(`Attention route did not handle ${method} ${path}`);
  return response;
}

function insertAttentionDevice(
  database: SqliteD1Database,
  args: {
    userId: string;
    deviceId: string;
    apnsToken?: string | null;
    sourceMachineKey?: string | null;
    leaseExpiresAt?: string;
    ownershipEpoch?: number;
  },
): void {
  const now = "2026-07-28T08:00:00.000Z";
  database.native.prepare(`
    insert into attention_devices(
      user_id, device_id, source_machine_key, apns_token, push_to_start_token,
      bundle_id, aps_environment, platform, device_name, preferences_json,
      registered_at, updated_at, lease_expires_at
    ) values (?, ?, ?, ?, null, 'com.ade.ios', 'sandbox', 'iOS', null, '{}', ?, ?, ?)
  `).run(
    args.userId,
    args.deviceId,
    args.sourceMachineKey ?? null,
    args.apnsToken ?? null,
    now,
    now,
    args.leaseExpiresAt ?? "2026-09-01T08:00:00.000Z",
  );
  database.native.prepare(`
    insert into attention_device_ownership(
      device_id, user_id, ownership_epoch, apns_token, active, updated_at
    ) values (?, ?, ?, ?, 1, ?)
  `).run(
    args.deviceId,
    args.userId,
    args.ownershipEpoch ?? 1,
    args.apnsToken ?? null,
    now,
  );
}

const MACHINE_KEY = "a".repeat(32);

function validAgentItem(): Record<string, unknown> {
  return {
    contractVersion: 1,
    id: `agent:${MACHINE_KEY}:session-1`,
    revision: 7,
    fingerprint: "fingerprint-7",
    kind: "agent",
    eventKind: "agent_needs_you",
    phase: "needs_you",
    title: "Approve the migration",
    preview: "The database migration is ready for review.",
    privacyPreview: "An ADE agent needs your attention.",
    detail: "Review the generated SQL before continuing.",
    recentActivity: ["Inspected the schema", "Prepared the migration"],
    planProgress: {
      completed: 2,
      total: 3,
      current: "Waiting for approval",
    },
    laneId: "lane-1",
    laneName: "attention-system",
    provider: "codex",
    model: "gpt-5",
    machine: {
      machineKey: MACHINE_KEY,
      accountMachineKey: "c".repeat(32),
      name: "Studio",
    },
    project: {
      projectId: "project-1",
      name: "ADE",
      rootPath: "/projects/ade",
    },
    destination: {
      kind: "session",
      sessionId: "session-1",
      itemId: "approval-1",
      eventId: "event-1",
    },
    actions: [
      {
        id: "approve",
        kind: "approve",
        label: "Approve",
        payload: { decision: "accept" },
      },
      {
        id: "open",
        kind: "open",
        label: "Open",
      },
    ],
    occurredAt: "2026-07-28T08:00:00.000Z",
    updatedAt: "2026-07-28T08:00:05.000Z",
    expiresAt: "2026-07-29T08:00:05.000Z",
  };
}

describe("account Attention contract", () => {
  it("accepts and normalizes a bounded machine-owned agent item", () => {
    const parsed = attentionTestInternals.parseAttentionItem(validAgentItem(), MACHINE_KEY);

    expect(parsed).toMatchObject({
      id: `agent:${MACHINE_KEY}:session-1`,
      kind: "agent",
      eventKind: "agent_needs_you",
      phase: "needs_you",
      seenAt: null,
      dismissedAt: null,
      machine: {
        machineKey: MACHINE_KEY,
        name: "Studio",
        online: true,
      },
      destination: {
        kind: "session",
        sessionId: "session-1",
        itemId: "approval-1",
      },
      planProgress: {
        completed: 2,
        total: 3,
      },
    });
  });

  it("rejects cross-kind events, foreign machine ids, and invalid progress", () => {
    const wrongKind = validAgentItem();
    wrongKind.eventKind = "pr_merge_ready";
    expect(attentionTestInternals.parseAttentionItem(wrongKind, MACHINE_KEY)).toBeNull();

    const foreignId = validAgentItem();
    foreignId.id = `agent:${"b".repeat(32)}:session-1`;
    expect(attentionTestInternals.parseAttentionItem(foreignId, MACHINE_KEY)).toBeNull();

    const invalidProgress = validAgentItem();
    invalidProgress.planProgress = { completed: 4, total: 3, current: "Impossible" };
    expect(attentionTestInternals.parseAttentionItem(invalidProgress, MACHINE_KEY)).toBeNull();
  });

  it("clamps desktop-first escalation preferences to a safe relay range", () => {
    expect(attentionTestInternals.desktopEscalationDelayMs({})).toBe(30_000);
    expect(attentionTestInternals.desktopEscalationDelayMs({
      desktopFirstDelaySeconds: -90,
    })).toBe(0);
    expect(attentionTestInternals.desktopEscalationDelayMs({
      desktopFirstDelaySeconds: 119.6,
    })).toBe(120_000);
    expect(attentionTestInternals.desktopEscalationDelayMs({
      desktopFirstDelaySeconds: 3_600,
    })).toBe(300_000);
  });

  it("resets a cursor that belongs to a different account revision stream", () => {
    expect(attentionTestInternals.normalizedSnapshotCursor(12, 40)).toBe(12);
    expect(attentionTestInternals.normalizedSnapshotCursor(40, 40)).toBe(40);
    expect(attentionTestInternals.normalizedSnapshotCursor(400, 2)).toBe(0);
    expect(
      attentionTestInternals.normalizedSnapshotCursor(12, 40, "account-a", "account-a"),
    ).toBe(12);
    expect(
      attentionTestInternals.normalizedSnapshotCursor(12, 40, "account-a", "account-b"),
    ).toBe(0);
  });

  it("does not rewrite an identical full-snapshot heartbeat", () => {
    const current = [{
      item_id: `agent:${MACHINE_KEY}:session-1`,
      source_revision: 7,
      fingerprint: "fingerprint-7",
    }];
    const incoming = [{
      id: `agent:${MACHINE_KEY}:session-1`,
      revision: 7,
      fingerprint: "fingerprint-7",
    }];
    expect(
      attentionTestInternals.attentionFullSnapshotUnchanged(current, incoming, 0),
    ).toBe(true);
    expect(
      attentionTestInternals.attentionFullSnapshotUnchanged(current, [
        { ...incoming[0], fingerprint: "fingerprint-8" },
      ], 0),
    ).toBe(false);
    expect(
      attentionTestInternals.attentionFullSnapshotUnchanged(current, incoming, 1),
    ).toBe(false);
  });

  it("redacts lock-screen content without breaking exact PR routing metadata", () => {
    const privateState = attentionTestInternals.privacyPreservingActivityContentState({
      updatedAt: 1_752_000_000,
      activeCount: 2,
      runs: [{
        id: "session-1",
        title: "Secret customer migration",
        phase: "needs_you",
        model: "gpt-5",
        lane: "secret-client",
        detail: "Approve production access",
      }],
      prs: [{
        id: "pr-42",
        prNumber: 42,
        title: "Fix private authentication bug",
        phase: "review_requested",
        lane: "security",
        repoOwner: "private-owner",
        repoName: "private-repo",
      }],
    });

    expect(privateState).toMatchObject({
      runs: [{
        id: "session-1",
        title: "Agent activity",
        phase: "needs_you",
        model: null,
        lane: null,
        detail: null,
      }],
      prs: [{
        id: "pr-42",
        prNumber: 42,
        title: "Pull request #42",
        phase: "review_requested",
        lane: null,
        repoOwner: "private-owner",
        repoName: "private-repo",
      }],
    });
  });

  it("redacts notification titles as well as bodies when previews are hidden", () => {
    const parsed = attentionTestInternals.parseAttentionItem(validAgentItem(), MACHINE_KEY);
    expect(parsed).not.toBeNull();
    if (!parsed) return;

    expect(attentionTestInternals.notificationTitle(parsed, false)).toBe(
      "Approve the migration",
    );
    expect(attentionTestInternals.notificationTitle(parsed, true)).toBe(
      "ADE agent update",
    );

    const pullRequest = {
      ...parsed,
      kind: "pull_request",
    } as typeof parsed;
    expect(attentionTestInternals.notificationTitle(pullRequest, true)).toBe(
      "ADE pull request update",
    );
  });

  it("keeps exact account-machine routing in cross-machine alerts and Live Activity rows", () => {
    const firstRaw = validAgentItem();
    const first = attentionTestInternals.parseAttentionItem(firstRaw, MACHINE_KEY);
    expect(first).not.toBeNull();
    if (!first) return;

    const otherMachineKey = "b".repeat(32);
    const otherAccountMachineKey = "d".repeat(32);
    const secondRaw = {
      ...validAgentItem(),
      id: `agent:${otherMachineKey}:session-2`,
      machine: {
        machineKey: otherMachineKey,
        accountMachineKey: otherAccountMachineKey,
        name: "MacBook",
      },
      destination: {
        kind: "session",
        sessionId: "session-2",
      },
    };
    const second = attentionTestInternals.parseAttentionItem(
      secondRaw,
      otherMachineKey,
    );
    expect(second).not.toBeNull();
    if (!second) return;

    const firstDeepLink = attentionTestInternals.deepLinkForItem(first);
    const secondDeepLink = attentionTestInternals.deepLinkForItem(second);
    expect(firstDeepLink).toContain(`accountMachineKey=${"c".repeat(32)}`);
    expect(secondDeepLink).toContain(`accountMachineKey=${otherAccountMachineKey}`);
    expect(
      attentionTestInternals.attentionAlertRoutingPayload(first, firstDeepLink),
    ).toMatchObject({
      accountMachineKey: "c".repeat(32),
      sessionId: "session-1",
      deepLink: firstDeepLink,
    });
    expect(
      attentionTestInternals.attentionAlertRoutingPayload(second, secondDeepLink),
    ).toMatchObject({
      accountMachineKey: otherAccountMachineKey,
      sessionId: "session-2",
      deepLink: secondDeepLink,
    });
    expect(attentionTestInternals.activityRun(first)).toMatchObject({
      id: "session-1",
      accountMachineKey: "c".repeat(32),
    });

    const pullRequestRaw = {
      ...secondRaw,
      id: `pull-request:${otherMachineKey}:private-owner:private-repo:42`,
      kind: "pull_request",
      eventKind: "pr_checks_failing",
      phase: "checks_failing",
      destination: {
        kind: "pull_request",
        repoOwner: "private-owner",
        repoName: "private-repo",
        number: 42,
        tab: "checks",
      },
    };
    const pullRequest = attentionTestInternals.parseAttentionItem(
      pullRequestRaw,
      otherMachineKey,
    );
    expect(pullRequest).not.toBeNull();
    if (!pullRequest) return;
    expect(attentionTestInternals.activityPullRequest(pullRequest)).toMatchObject({
      prNumber: 42,
      accountMachineKey: otherAccountMachineKey,
    });
    const pullRequestDeepLink = attentionTestInternals.deepLinkForItem(pullRequest);
    expect(pullRequestDeepLink).toContain("tab=checks");
    expect(pullRequestDeepLink).toContain(
      `accountMachineKey=${otherAccountMachineKey}`,
    );
  });

  it("requires ownershipEpoch to be a positive safe JSON integer", async () => {
    const database = new SqliteD1Database();
    try {
      for (const ownershipEpoch of [0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
        const response = await accountRoute(
          database,
          "account-a",
          "PUT",
          "/attention/account/devices/phone-1",
          {
            ownershipEpoch,
            apnsToken: "90".repeat(32),
            bundleId: "com.ade.ios",
            apsEnvironment: "sandbox",
          },
        );
        expect(response.status).toBe(400);
      }
    } finally {
      database.close();
    }
  });

  it("imports legacy routes once without reclaiming a phone that changed accounts", async () => {
    const database = new SqliteD1Database();
    const env = makeAttentionEnv(database);
    const legacyToken = "ab".repeat(32);
    try {
      database.native.prepare(`
        insert into machines(machine_key, secret, created_at, last_seen_at)
        values (?, 'relay-secret', '2026-07-28T08:00:00.000Z', '2026-07-28T08:00:00.000Z')
      `).run(MACHINE_KEY);
      database.native.prepare(`
        insert into device_registrations(
          machine_key, device_id, apns_token, push_to_start_token, bundle_id,
          aps_environment, platform, device_name, registered_at, updated_at
        ) values (?, 'phone-1', ?, null, 'com.ade.ios', 'sandbox', 'iOS',
          'Phone', '2026-07-28T08:00:00.000Z', '2026-07-28T08:00:00.000Z')
      `).run(MACHINE_KEY, legacyToken);
      database.native.prepare(`
        insert into live_activity_tokens(
          machine_key, device_id, activity_id, token, updated_at
        ) values (?, 'phone-1', 'account-attention', ?, '2026-07-28T08:00:00.000Z')
      `).run(MACHINE_KEY, "cd".repeat(32));

      await attentionTestInternals.linkMachineToAccount(
        env,
        "account-a",
        MACHINE_KEY,
        "Studio",
      );
      expect(row(database, `
        select source_machine_key
        from attention_devices
        where user_id = 'account-a' and device_id = 'phone-1'
      `)?.source_machine_key).toBe(MACHINE_KEY);
      expect(row(database, `
        select legacy_devices_imported_at
        from attention_machine_links
        where machine_key = ?
      `, MACHINE_KEY)?.legacy_devices_imported_at).toEqual(expect.any(String));
      expect(rows(database, `
        select activity_id
        from attention_activity_tokens
        where user_id = 'account-a' and device_id = 'phone-1'
      `)).toHaveLength(1);

      const transfer = await accountRoute(
        database,
        "account-b",
        "PUT",
        "/attention/account/devices/phone-1",
        {
          ownershipEpoch: 2,
          apnsToken: legacyToken,
          bundleId: "com.ade.ios",
          apsEnvironment: "sandbox",
          platform: "iOS",
        },
      );
      expect(transfer.status).toBe(200);

      // A later machine heartbeat cannot use stale machine pairing data to
      // transfer the phone or its Live Activity route back to account A.
      await attentionTestInternals.linkMachineToAccount(
        env,
        "account-a",
        MACHINE_KEY,
        "Studio",
      );
      expect(row(database, `
        select user_id
        from attention_devices
        where device_id = 'phone-1'
      `)?.user_id).toBe("account-b");
      expect(rows(database, `
        select *
        from attention_activity_tokens
        where user_id = 'account-a' and device_id = 'phone-1'
      `)).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it("preserves source revisions on relink tombstones and permits a fresh-owner revival", async () => {
    const database = new SqliteD1Database();
    const env = makeAttentionEnv(database);
    const itemId = `agent:${MACHINE_KEY}:session-1`;
    try {
      database.native.prepare(`
        insert into machines(machine_key, secret, created_at, last_seen_at)
        values (?, 'relay-secret', '2026-07-28T08:00:00.000Z', '2026-07-28T08:00:00.000Z')
      `).run(MACHINE_KEY);
      await attentionTestInternals.linkMachineToAccount(
        env,
        "account-a",
        MACHINE_KEY,
        "Studio",
      );
      database.native.prepare(`
        insert into attention_revisions(user_id, revision, updated_at)
        values ('account-a', 4, '2026-07-28T08:00:00.000Z')
      `).run();
      database.native.prepare(`
        insert into attention_items(
          user_id, item_id, machine_key, source_revision, account_revision,
          fingerprint, event_kind, phase, payload_json, seen_at, dismissed_at,
          expires_at, updated_at
        ) values (
          'account-a', ?, ?, 7, 4, 'fingerprint-7', 'agent_running',
          'running', '{}', null, null, null, '2026-07-28T08:00:00.000Z'
        )
      `).run(itemId, MACHINE_KEY);

      await attentionTestInternals.linkMachineToAccount(
        env,
        "account-b",
        MACHINE_KEY,
        "Studio",
      );
      expect(row(database, `
        select source_revision
        from attention_tombstones
        where user_id = 'account-a' and item_id = ?
      `, itemId)?.source_revision).toBe(7);

      await attentionTestInternals.linkMachineToAccount(
        env,
        "account-a",
        MACHINE_KEY,
        "Studio",
      );
      expect(row(database, `
        select source_revision
        from attention_tombstones
        where user_id = 'account-a' and item_id = ?
      `, itemId)).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("checks destination quota before an atomic ownership transfer and renews the lease", async () => {
    const database = new SqliteD1Database();
    const transferToken = "ef".repeat(32);
    try {
      for (let index = 0; index < 32; index += 1) {
        insertAttentionDevice(database, {
          userId: "account-b",
          deviceId: `existing-${index}`,
        });
      }
      insertAttentionDevice(database, {
        userId: "account-a",
        deviceId: "phone-transfer",
        apnsToken: transferToken,
      });
      database.native.prepare(`
        insert into attention_presence(user_id, device_id, payload_json, observed_at)
        values ('account-a', 'phone-transfer', '{}', '2026-07-28T08:00:00.000Z')
      `).run();

      const rejected = await accountRoute(
        database,
        "account-b",
        "PUT",
        "/attention/account/devices/phone-transfer",
        {
          ownershipEpoch: 2,
          apnsToken: transferToken,
          bundleId: "com.ade.ios",
          apsEnvironment: "sandbox",
        },
      );
      expect(rejected.status).toBe(409);
      expect(row(database, `
        select user_id
        from attention_devices
        where device_id = 'phone-transfer'
      `)?.user_id).toBe("account-a");
      expect(rows(database, `
        select device_id from attention_devices where user_id = 'account-b'
      `)).toHaveLength(32);
      expect(rows(database, `
        select device_id
        from attention_presence
        where user_id = 'account-a' and device_id = 'phone-transfer'
      `)).toHaveLength(1);

      database.native.prepare(`
        delete from attention_devices
        where user_id = 'account-b' and device_id = 'existing-31'
      `).run();
      const transferred = await accountRoute(
        database,
        "account-b",
        "PUT",
        "/attention/account/devices/phone-transfer",
        {
          ownershipEpoch: 2,
          apnsToken: transferToken,
          bundleId: "com.ade.ios",
          apsEnvironment: "sandbox",
        },
      );
      expect(transferred.status).toBe(200);
      const transferredRow = row<{
        user_id: string;
        lease_expires_at: string;
      }>(database, `
        select user_id, lease_expires_at
        from attention_devices
        where device_id = 'phone-transfer'
      `);
      expect(transferredRow?.user_id).toBe("account-b");
      expect(Date.parse(transferredRow?.lease_expires_at ?? "")).toBeGreaterThan(
        Date.now() + 29 * 24 * 60 * 60 * 1_000,
      );
      expect(rows(database, `
        select device_id
        from attention_presence
        where user_id = 'account-a' and device_id = 'phone-transfer'
      `)).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it("rolls back the previous owner when the destination insert fails", async () => {
    const database = new SqliteD1Database();
    const transferToken = "12".repeat(32);
    try {
      insertAttentionDevice(database, {
        userId: "account-a",
        deviceId: "phone-transfer",
        apnsToken: transferToken,
      });
      database.native.prepare(`
        insert into attention_activity_tokens(
          user_id, device_id, activity_id, token, updated_at
        ) values (
          'account-a', 'phone-transfer', 'account-attention', ?,
          '2026-07-28T08:00:00.000Z'
        )
      `).run("34".repeat(32));
      database.native.exec(`
        create trigger reject_account_b_device
        before insert on attention_devices
        when new.user_id = 'account-b'
        begin
          select raise(abort, 'simulated destination failure');
        end
      `);

      await expect(accountRoute(
        database,
        "account-b",
        "PUT",
        "/attention/account/devices/phone-transfer",
        {
          ownershipEpoch: 2,
          apnsToken: transferToken,
          bundleId: "com.ade.ios",
          apsEnvironment: "sandbox",
        },
      )).rejects.toThrow("simulated destination failure");
      expect(row(database, `
        select user_id
        from attention_devices
        where device_id = 'phone-transfer'
      `)?.user_id).toBe("account-a");
      expect(rows(database, `
        select activity_id
        from attention_activity_tokens
        where user_id = 'account-a' and device_id = 'phone-transfer'
      `)).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("rolls back a transfer if the destination fills after the quota precheck", async () => {
    const database = new SqliteD1Database();
    const transferToken = "56".repeat(32);
    try {
      for (let index = 0; index < 31; index += 1) {
        insertAttentionDevice(database, {
          userId: "account-b",
          deviceId: `existing-${index}`,
        });
      }
      insertAttentionDevice(database, {
        userId: "account-a",
        deviceId: "phone-transfer",
        apnsToken: transferToken,
      });
      const originalBatch = database.batch.bind(database);
      let injectedConcurrentRegistration = false;
      database.batch = async (statements) => {
        if (!injectedConcurrentRegistration) {
          injectedConcurrentRegistration = true;
          insertAttentionDevice(database, {
            userId: "account-b",
            deviceId: "concurrent-phone",
          });
        }
        return await originalBatch(statements);
      };

      const response = await accountRoute(
        database,
        "account-b",
        "PUT",
        "/attention/account/devices/phone-transfer",
        {
          ownershipEpoch: 2,
          apnsToken: transferToken,
          bundleId: "com.ade.ios",
          apsEnvironment: "sandbox",
        },
      );

      expect(response.status).toBe(409);
      expect(row(database, `
        select user_id
        from attention_devices
        where device_id = 'phone-transfer'
      `)?.user_id).toBe("account-a");
      expect(rows(database, `
        select device_id from attention_devices where user_id = 'account-b'
      `)).toHaveLength(32);
      expect(row(database, `
        select user_id, ownership_epoch
        from attention_device_ownership
        where device_id = 'phone-transfer'
      `)).toMatchObject({
        user_id: "account-a",
        ownership_epoch: 1,
      });
    } finally {
      database.close();
    }
  });

  it("atomically rejects an ownership switch superseded during its precheck", async () => {
    const database = new SqliteD1Database();
    const apnsToken = "67".repeat(32);
    const registration = {
      apnsToken,
      bundleId: "com.ade.ios",
      apsEnvironment: "sandbox",
    };
    try {
      const firstOwner = await accountRoute(
        database,
        "account-a",
        "PUT",
        "/attention/account/devices/phone-1",
        { ...registration, ownershipEpoch: 1 },
      );
      expect(firstOwner.status).toBe(200);

      const originalBatch = database.batch.bind(database);
      let injectedNewerOwner = false;
      database.batch = async (statements) => {
        if (!injectedNewerOwner) {
          injectedNewerOwner = true;
          database.batch = originalBatch;
          const newer = await accountRoute(
            database,
            "account-c",
            "PUT",
            "/attention/account/devices/phone-1",
            { ...registration, ownershipEpoch: 3 },
          );
          expect(newer.status).toBe(200);
        }
        return await originalBatch(statements);
      };

      const superseded = await accountRoute(
        database,
        "account-b",
        "PUT",
        "/attention/account/devices/phone-1",
        { ...registration, ownershipEpoch: 2 },
      );
      expect(superseded.status).toBe(409);
      expect(await superseded.json()).toEqual({
        ok: false,
        error: "stale device ownership",
        ownershipEpoch: 3,
      });
      expect(row(database, `
        select user_id
        from attention_devices
        where device_id = 'phone-1'
      `)?.user_id).toBe("account-c");
      expect(row(database, `
        select user_id, ownership_epoch, active
        from attention_device_ownership
        where device_id = 'phone-1'
      `)).toMatchObject({
        user_id: "account-c",
        ownership_epoch: 3,
        active: 1,
      });
    } finally {
      database.close();
    }
  });

  it("rejects delayed old-account PUT and DELETE after switch, deletion, and revival", async () => {
    const database = new SqliteD1Database();
    const apnsToken = "78".repeat(32);
    const registration = {
      apnsToken,
      bundleId: "com.ade.ios",
      apsEnvironment: "sandbox",
    };
    try {
      const firstOwner = await accountRoute(
        database,
        "account-a",
        "PUT",
        "/attention/account/devices/phone-1",
        { ...registration, ownershipEpoch: 1 },
      );
      expect(firstOwner.status).toBe(200);

      const equalEpochOtherOwner = await accountRoute(
        database,
        "account-b",
        "PUT",
        "/attention/account/devices/phone-1",
        { ...registration, ownershipEpoch: 1 },
      );
      expect(equalEpochOtherOwner.status).toBe(409);
      expect(await equalEpochOtherOwner.json()).toEqual({
        ok: false,
        error: "stale device ownership",
        ownershipEpoch: 1,
      });

      const switched = await accountRoute(
        database,
        "account-b",
        "PUT",
        "/attention/account/devices/phone-1",
        { ...registration, ownershipEpoch: 2 },
      );
      expect(switched.status).toBe(200);

      const removed = await accountRoute(
        database,
        "account-b",
        "DELETE",
        "/attention/account/devices/phone-1",
        { ownershipEpoch: 2, apnsToken },
      );
      expect(removed.status).toBe(200);
      expect(row(database, `
        select user_id, ownership_epoch, active
        from attention_device_ownership
        where device_id = 'phone-1'
      `)).toMatchObject({
        user_id: "account-b",
        ownership_epoch: 2,
        active: 0,
      });
      expect(rows(database, `
        select device_id from attention_devices where device_id = 'phone-1'
      `)).toHaveLength(0);

      const revived = await accountRoute(
        database,
        "account-b",
        "PUT",
        "/attention/account/devices/phone-1",
        { ...registration, ownershipEpoch: 2 },
      );
      expect(revived.status).toBe(200);

      const delayedPut = await accountRoute(
        database,
        "account-a",
        "PUT",
        "/attention/account/devices/phone-1",
        { ...registration, ownershipEpoch: 1 },
      );
      expect(delayedPut.status).toBe(409);
      expect(await delayedPut.json()).toEqual({
        ok: false,
        error: "stale device ownership",
        ownershipEpoch: 2,
      });

      // A changed local install id still cannot reclaim a newer APNs route.
      const delayedRoutePut = await accountRoute(
        database,
        "account-a",
        "PUT",
        "/attention/account/devices/reinstalled-phone",
        { ...registration, ownershipEpoch: 1 },
      );
      expect(delayedRoutePut.status).toBe(409);
      expect((await delayedRoutePut.json()) as Record<string, unknown>).toMatchObject({
        ownershipEpoch: 2,
      });

      const staleDelete = await accountRoute(
        database,
        "account-a",
        "DELETE",
        "/attention/account/devices/phone-1",
        { ownershipEpoch: 1, apnsToken },
      );
      expect(staleDelete.status).toBe(409);
      expect((await staleDelete.json()) as Record<string, unknown>).toMatchObject({
        ownershipEpoch: 2,
      });
      expect(row(database, `
        select user_id
        from attention_devices
        where device_id = 'phone-1'
      `)?.user_id).toBe("account-b");
    } finally {
      database.close();
    }
  });

  it("prunes an expired lease and all device-owned account state", async () => {
    const database = new SqliteD1Database();
    try {
      insertAttentionDevice(database, {
        userId: "account-a",
        deviceId: "expired-phone",
        leaseExpiresAt: "2026-01-01T00:00:00.000Z",
      });
      database.native.prepare(`
        insert into attention_presence(user_id, device_id, payload_json, observed_at)
        values ('account-a', 'expired-phone', '{}', '2026-07-28T08:00:00.000Z')
      `).run();
      database.native.prepare(`
        insert into attention_activity_state(
          user_id, device_id, activity_id, started, fingerprint, updated_at
        ) values (
          'account-a', 'expired-phone', 'account-attention', 1, null,
          '2026-07-28T08:00:00.000Z'
        )
      `).run();

      await pruneAttentionState(makeAttentionEnv(database));

      expect(rows(database, `
        select device_id
        from attention_devices
        where user_id = 'account-a' and device_id = 'expired-phone'
      `)).toHaveLength(0);
      expect(rows(database, `
        select device_id
        from attention_presence
        where user_id = 'account-a' and device_id = 'expired-phone'
      `)).toHaveLength(0);
      expect(rows(database, `
        select device_id
        from attention_activity_state
        where user_id = 'account-a' and device_id = 'expired-phone'
      `)).toHaveLength(0);
      expect(row(database, `
        select ownership_epoch, active
        from attention_device_ownership
        where device_id = 'expired-phone'
      `)).toMatchObject({
        ownership_epoch: 1,
        active: 0,
      });
    } finally {
      database.close();
    }
  });
});

/**
 * The fake D1 the whole account-directory suite runs on.
 *
 * It mirrors the SQL the Worker actually issues — predicates included — so a
 * statement that narrows or widens shows up as a failing assertion rather than
 * being absorbed. It lives on its own because it is the single largest thing in
 * the harness and every suite that touches machines, revocations, device
 * authorizations, or pairing grants needs it.
 */

export type StoredMachine = {
  user_id: string;
  machine_key: string;
  device_id: string | null;
  /** Null for every row written before the anchor shipped, and never back-filled. */
  hardware_id: string | null;
  name: string | null;
  custom_name: string | null;
  platform: string | null;
  device_type: string | null;
  pubkey: string | null;
  reachable_endpoints: string | null;
  last_seen_at: number | null;
  created_at: number | null;
};

export type StoredDeviceAuthorization = {
  device_code: string;
  user_code: string;
  device_secret_hash: string;
  machine_key: string | null;
  status: "pending" | "approved" | "consumed" | "expired" | "error";
  code_verifier: string | null;
  oauth_state_hash: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_type: string | null;
  expires_in: number | null;
  error_message: string | null;
  poll_interval_seconds: number;
  last_polled_at: number | null;
  created_at: number;
  expires_at: number;
  approved_at: number | null;
  consumed_at: number | null;
};

export class FakeD1Statement {
  private values: unknown[] = [];

  constructor(
    private readonly sql: string,
    private readonly db: FakeD1Database,
  ) {}

  bind(...values: unknown[]): this {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    const result = this.db.first<T>(this.sql, this.values);
    await this.db.waitForConcurrentReads(this.sql);
    return result;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.all<T>(this.sql, this.values) };
  }

  async run(): Promise<{ success: boolean; meta: { changes: number } }> {
    const changes = this.db.run(this.sql, this.values);
    return { success: true, meta: { changes } };
  }
}

export type StoredRevocation = {
  user_id: string;
  machine_key: string;
  device_id: string | null;
  revoked_at: number;
};

export type StoredPairingGrant = {
  grant_hash: string;
  user_id: string;
  machine_key: string;
  created_at: number;
  expires_at: number;
  /** Non-null while one in-flight registration holds the grant. */
  reserved_at: number | null;
};

export class FakeD1Database {
  rows: StoredMachine[] = [];
  revocations: StoredRevocation[] = [];
  deviceRows: StoredDeviceAuthorization[] = [];
  pairingGrants: StoredPairingGrant[] = [];
  approvalRateLimits = new Map<string, { window_started_at: number; attempts: number }>();
  private rateLimitReadBarrier: {
    remaining: number;
    promise: Promise<void>;
    release: () => void;
  } | null = null;
  private oauthStateReadBarrier: {
    remaining: number;
    promise: Promise<void>;
    release: () => void;
  } | null = null;

  synchronizeRateLimitReads(expectedReads: number): void {
    let release = () => {};
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.rateLimitReadBarrier = { remaining: expectedReads, promise, release };
  }

  synchronizeOAuthStateReads(expectedReads: number): void {
    let release = () => {};
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.oauthStateReadBarrier = { remaining: expectedReads, promise, release };
  }

  async waitForConcurrentReads(sql: string): Promise<void> {
    const normalized = sql.toLowerCase();
    const barrier = normalized.includes("from device_approval_rate_limits")
      ? this.rateLimitReadBarrier
      : normalized.includes("from device_authorizations") && normalized.includes("where oauth_state_hash")
        ? this.oauthStateReadBarrier
        : null;
    if (!barrier) return;
    barrier.remaining -= 1;
    if (barrier.remaining === 0) barrier.release();
    await barrier.promise;
  }

  prepare(sql: string): FakeD1Statement {
    return new FakeD1Statement(sql, this);
  }

  /**
   * D1 runs a batch as one implicit transaction. The fake cannot fail halfway —
   * that is the point of the source using a batch — so it only has to prove the
   * statements were handed over TOGETHER: a caller that reverts to a loop of
   * `.run()` calls stops going through here at all.
   */
  async batch(
    statements: FakeD1Statement[],
  ): Promise<Array<{ success: boolean; meta: { changes: number } }>> {
    const results: Array<{ success: boolean; meta: { changes: number } }> = [];
    for (const statement of statements) results.push(await statement.run());
    this.batchedStatementCounts.push(statements.length);
    return results;
  }

  /** One entry per `batch()` call, so a test can assert the deletes were not a loop. */
  batchedStatementCounts: number[] = [];

  first<T>(sql: string, values: unknown[]): T | null {
    const normalized = sql.toLowerCase();
    if (normalized.includes("from revoked_machines")) {
      const [userId, machineKey] = values;
      return (this.revocations.find((row) =>
        row.user_id === userId && row.machine_key === machineKey
      ) ?? null) as T | null;
    }
    if (normalized.includes("from machines")) {
      const [userId, machineKey] = values;
      return (this.rows.find((row) => row.user_id === userId && row.machine_key === machineKey) ?? null) as T | null;
    }
    if (normalized.includes("from device_authorizations")) {
      const [value] = values;
      const key = normalized.includes("where device_code")
        ? "device_code"
        : normalized.includes("where user_code")
          ? "user_code"
          : "oauth_state_hash";
      return (this.deviceRows.find((row) => row[key] === value) ?? null) as T | null;
    }
    if (normalized.includes("from device_approval_rate_limits")) {
      return (this.approvalRateLimits.get(String(values[0])) ?? null) as T | null;
    }
    return null;
  }

  all<T>(sql: string, values: unknown[]): T[] {
    const normalized = sql.toLowerCase();
    if (!normalized.includes("from machines")) return [];
    // Duplicate lookup for one physical device. Mirrors the source predicate
    // exactly — including the `machine_key <> ?` self-exclusion and the OR over
    // both identifiers — so a worker that drops either deletes the row it just
    // wrote, or stops folding reinstalls, and the tests say so. A null bind
    // matches nothing, exactly as SQL comparison to null does.
    if (normalized.includes("device_id = ?")) {
      const [userId, machineKey, deviceId, hardwareId, limit] = values;
      return this.rows
        .filter((row) =>
          row.user_id === userId
          && row.machine_key !== machineKey
          && (
            (deviceId != null && row.device_id === deviceId)
            || (hardwareId != null && row.hardware_id === hardwareId)
          )
        )
        .sort((left, right) => Number(left.last_seen_at ?? 0) - Number(right.last_seen_at ?? 0))
        .slice(0, Number(limit)) as T[];
    }
    const [userId] = values;
    let rows = this.rows.filter((row) => row.user_id === userId);
    if (normalized.includes("order by last_seen_at desc")) {
      rows = [...rows].sort((left, right) =>
        Number(right.last_seen_at ?? 0) - Number(left.last_seen_at ?? 0)
      );
    }
    if (normalized.includes("limit 500")) rows = rows.slice(0, 500);
    return rows as T[];
  }

  run(sql: string, values: unknown[]): number {
    const normalized = sql.toLowerCase();
    if (normalized.includes("insert into machine_pairing_grants")) {
      const [grantHash, userId, machineKey, createdAt, expiresAt] = values;
      if (this.pairingGrants.some((row) => row.grant_hash === grantHash)) return 0;
      this.pairingGrants.push({
        grant_hash: String(grantHash),
        user_id: String(userId),
        machine_key: String(machineKey),
        created_at: Number(createdAt),
        expires_at: Number(expiresAt),
        reserved_at: null,
      });
      return 1;
    }
    if (normalized.includes("update machine_pairing_grants")) {
      // Phase two, failure: put the row back exactly as it was. Only the
      // reservation this request took may be cleared, and `expires_at` is not
      // in the statement at all — an extended TTL would be the bug.
      if (normalized.includes("set reserved_at = null")) {
        const [grantHash, userId, machineKey, reservedAt] = values;
        const row = this.pairingGrants.find((entry) =>
          entry.grant_hash === grantHash
          && entry.user_id === userId
          && entry.machine_key === machineKey
          && entry.reserved_at === Number(reservedAt)
        );
        if (!row) return 0;
        row.reserved_at = null;
        return 1;
      }
      // Phase one: the same single-statement guarantee the delete used to give.
      // User, machine, and expiry are all in the WHERE clause, plus "not held
      // by another in-flight registration", so a worker that loosens any of
      // them fails here instead of being absorbed.
      const [reservedAt, grantHash, userId, machineKey, nowMs, staleBefore] = values;
      const row = this.pairingGrants.find((entry) =>
        entry.grant_hash === grantHash
        && entry.user_id === userId
        && entry.machine_key === machineKey
        && entry.expires_at > Number(nowMs)
        && (entry.reserved_at === null || entry.reserved_at <= Number(staleBefore))
      );
      if (!row) return 0;
      row.reserved_at = Number(reservedAt);
      return 1;
    }
    if (normalized.includes("delete from machine_pairing_grants")) {
      // Phase two, success. Bound to the reservation this request took: a
      // consume that dropped `reserved_at` from the predicate could destroy a
      // grant another registration is holding.
      if (normalized.includes("grant_hash = ?")) {
        const [grantHash, userId, machineKey, reservedAt] = values;
        const before = this.pairingGrants.length;
        this.pairingGrants = this.pairingGrants.filter((row) =>
          !(row.grant_hash === grantHash
            && row.user_id === userId
            && row.machine_key === machineKey
            && row.reserved_at === Number(reservedAt))
        );
        return before - this.pairingGrants.length;
      }
      const cutoff = Number(values[0]);
      const before = this.pairingGrants.length;
      this.pairingGrants = this.pairingGrants.filter((row) => row.expires_at > cutoff);
      return before - this.pairingGrants.length;
    }
    if (normalized.includes("insert into revoked_machines")) {
      const [userId, machineKey, deviceId, revokedAt] = values;
      // Mirror whichever conflict clause the source actually uses, so a revert
      // to a bare `device_id = excluded.device_id` fails the retry test rather
      // than being papered over here.
      const preservesDeviceId = normalized.includes("coalesce(excluded.device_id");
      const row = this.revocations.find((entry) =>
        entry.user_id === userId && entry.machine_key === machineKey
      );
      if (row) {
        const next = deviceId == null ? null : String(deviceId);
        row.device_id = preservesDeviceId ? next ?? row.device_id : next;
        row.revoked_at = Number(revokedAt);
        return 1;
      }
      this.revocations.push({
        user_id: String(userId),
        machine_key: String(machineKey),
        device_id: deviceId == null ? null : String(deviceId),
        revoked_at: Number(revokedAt),
      });
      return 1;
    }
    if (normalized.includes("delete from revoked_machines")) {
      const [userId, machineKey] = values;
      const before = this.revocations.length;
      this.revocations = this.revocations.filter((row) =>
        row.user_id !== userId || row.machine_key !== machineKey
      );
      return before - this.revocations.length;
    }
    if (normalized.includes("insert into machines")) {
      const retainRelayEndpoints = values[11] === 1;
      const row: StoredMachine = {
        user_id: String(values[0]),
        machine_key: String(values[1]),
        device_id: values[2] == null ? null : String(values[2]),
        hardware_id: values[10] == null ? null : String(values[10]),
        name: values[3] == null ? null : String(values[3]),
        custom_name: null,
        platform: values[4] == null ? null : String(values[4]),
        device_type: values[5] == null ? null : String(values[5]),
        pubkey: values[6] == null ? null : String(values[6]),
        reachable_endpoints: values[7] == null ? null : String(values[7]),
        last_seen_at: values[8] == null ? null : Number(values[8]),
        created_at: values[9] == null ? null : Number(values[9]),
      };
      const existing = this.rows.find((entry) =>
        entry.user_id === row.user_id && entry.machine_key === row.machine_key
      );
      if (existing) {
        if (retainRelayEndpoints) {
          const nextEndpoints = JSON.parse(row.reachable_endpoints ?? "[]") as Array<{ kind?: string }>;
          const existingRelayEndpoints = (
            JSON.parse(existing.reachable_endpoints ?? "[]") as Array<{ kind?: string }>
          ).filter((endpoint) => endpoint.kind === "relay");
          if (
            !nextEndpoints.some((endpoint) => endpoint.kind === "relay")
            && existingRelayEndpoints.length > 0
          ) {
            row.reachable_endpoints = JSON.stringify([
              ...nextEndpoints,
              ...existingRelayEndpoints,
            ]);
          }
        }
        Object.assign(existing, row, {
          created_at: existing.created_at,
          custom_name: existing.custom_name,
          // Mirrors `coalesce(excluded.hardware_id, machines.hardware_id)`: one
          // heartbeat that could not read an anchor must not erase the one this
          // row already has, or a single bad sample undoes the dedup.
          hardware_id: row.hardware_id ?? existing.hardware_id,
        });
      } else {
        this.rows.push(row);
      }
      return 1;
    }
    if (normalized.includes("update machines") && normalized.includes("set custom_name")) {
      const [customName, userId, machineKey] = values;
      const row = this.rows.find((entry) =>
        entry.user_id === userId && entry.machine_key === machineKey
      );
      if (!row) return 0;
      // The supersede carry-forward only ever FILLS an empty name; the rename
      // route carries no such predicate. Mirrored rather than ignored, so a
      // carry-forward that lost the guard clobbers a user's rename here.
      if (normalized.includes("custom_name is null") && row.custom_name !== null) return 0;
      row.custom_name = customName == null ? null : String(customName);
      return 1;
    }
    if (normalized.includes("delete from machines")) {
      const [userId, machineKey, deviceId, hardwareId] = values;
      // The supersede delete carries the identifiers it was authorized by; the
      // removal delete does not. Honoring them here means a worker that narrows
      // the predicate — dropping it entirely, or keeping only the device id and
      // silently sparing every anchor-matched row — stops being covered.
      const scopedToDevice = normalized.includes("device_id = ?");
      const matchesScope = (row: StoredMachine): boolean =>
        (deviceId != null && row.device_id === deviceId)
        || (hardwareId != null && row.hardware_id === hardwareId);
      const before = this.rows.length;
      this.rows = this.rows.filter((row) =>
        row.user_id !== userId
        || row.machine_key !== machineKey
        || (scopedToDevice && !matchesScope(row))
      );
      return before - this.rows.length;
    }
    if (normalized.includes("delete from device_authorizations")) {
      const cutoff = Number(values[0]);
      const before = this.deviceRows.length;
      this.deviceRows = this.deviceRows.filter((row) =>
        row.expires_at > cutoff || !["expired", "consumed", "error"].includes(row.status)
      );
      return before - this.deviceRows.length;
    }
    if (normalized.includes("delete from device_approval_rate_limits")) {
      const cutoff = Number(values[0]);
      let changes = 0;
      for (const [clientHash, record] of this.approvalRateLimits) {
        if (record.window_started_at > cutoff) continue;
        this.approvalRateLimits.delete(clientHash);
        changes += 1;
      }
      return changes;
    }
    if (normalized.includes("insert into device_authorizations")) {
      const userCode = String(values[1]);
      if (this.deviceRows.some((row) => row.user_code === userCode)) {
        throw new Error("UNIQUE constraint failed: device_authorizations.user_code");
      }
      this.deviceRows.push({
        device_code: String(values[0]),
        user_code: userCode,
        device_secret_hash: String(values[2]),
        machine_key: values[6] == null ? null : String(values[6]),
        status: "pending",
        code_verifier: null,
        oauth_state_hash: null,
        access_token: null,
        refresh_token: null,
        token_type: null,
        expires_in: null,
        error_message: null,
        poll_interval_seconds: Number(values[3]),
        last_polled_at: null,
        created_at: Number(values[4]),
        expires_at: Number(values[5]),
        approved_at: null,
        consumed_at: null,
      });
      return 1;
    }
    if (normalized.includes("insert into device_approval_rate_limits")) {
      const clientHash = String(values[0]);
      const now = Number(values[1]);
      const windowMs = Number(values[2]);
      const maxAttempts = Number(values[5]);
      const record = this.approvalRateLimits.get(clientHash);
      if (!record) {
        this.approvalRateLimits.set(clientHash, { window_started_at: now, attempts: 1 });
        return 1;
      }
      if (now - record.window_started_at >= windowMs) {
        record.window_started_at = now;
        record.attempts = 1;
        return 1;
      }
      if (record.attempts >= maxAttempts) return 0;
      record.attempts += 1;
      return 1;
    }
    if (normalized.includes("update device_authorizations")) {
      if (normalized.includes("where expires_at <= ?")) {
        const now = Number(values[0]);
        let changes = 0;
        for (const row of this.deviceRows) {
          if (row.expires_at > now || (row.status !== "pending" && row.status !== "approved")) continue;
          row.status = "expired";
          row.code_verifier = null;
          row.oauth_state_hash = null;
          row.access_token = null;
          row.refresh_token = null;
          changes += 1;
        }
        return changes;
      }
      if (normalized.includes("set code_verifier")) {
        const row = this.deviceRows.find((entry) =>
          entry.device_code === values[2]
          && entry.status === "pending"
          && entry.expires_at > Number(values[3])
        );
        if (!row) return 0;
        row.code_verifier = String(values[0]);
        row.oauth_state_hash = String(values[1]);
        return 1;
      }
      if (normalized.includes("set oauth_state_hash = null")) {
        const row = this.deviceRows.find((entry) =>
          entry.device_code === values[0]
          && entry.status === "pending"
          && entry.oauth_state_hash === values[1]
          && entry.code_verifier !== null
          && entry.expires_at > Number(values[2])
        );
        if (!row) return 0;
        row.oauth_state_hash = null;
        return 1;
      }
      if (normalized.includes("set status = 'approved'")) {
        const row = this.deviceRows.find((entry) =>
          entry.device_code === values[5]
          && entry.status === "pending"
          && entry.expires_at > Number(values[6])
        );
        if (!row) return 0;
        row.status = "approved";
        row.access_token = String(values[0]);
        row.refresh_token = values[1] == null ? null : String(values[1]);
        row.token_type = String(values[2]);
        row.expires_in = Number(values[3]);
        row.approved_at = Number(values[4]);
        row.code_verifier = null;
        row.oauth_state_hash = null;
        return 1;
      }
      if (normalized.includes("set status = 'consumed'")) {
        const row = this.deviceRows.find((entry) =>
          entry.device_code === values[1]
          && entry.device_secret_hash === values[2]
          && entry.status === "approved"
        );
        if (!row) return 0;
        row.status = "consumed";
        row.consumed_at = Number(values[0]);
        row.access_token = null;
        row.refresh_token = null;
        return 1;
      }
      if (normalized.includes("set status = 'error'")) {
        const row = this.deviceRows.find((entry) => entry.device_code === values[1] && entry.status === "pending");
        if (!row) return 0;
        row.status = "error";
        row.error_message = String(values[0]);
        return 1;
      }
      if (normalized.includes("set status = 'expired'")) {
        const row = this.deviceRows.find((entry) => entry.device_code === values[0]);
        const pendingOnly = /status\s*=\s*'pending'/.test(normalized);
        const pendingOrApproved = /status\s+in\s*\(\s*'pending'\s*,\s*'approved'\s*\)/.test(normalized);
        if (
          !row
          || (pendingOnly && row.status !== "pending")
          || (pendingOrApproved && row.status !== "pending" && row.status !== "approved")
        ) return 0;
        row.status = "expired";
        row.code_verifier = null;
        row.oauth_state_hash = null;
        row.access_token = null;
        row.refresh_token = null;
        return 1;
      }
      if (normalized.includes("set last_polled_at = ?, poll_interval_seconds = ?")) {
        const row = this.deviceRows.find((entry) => entry.device_code === values[2]);
        if (!row) return 0;
        row.last_polled_at = Number(values[0]);
        row.poll_interval_seconds = Number(values[1]);
        return 1;
      }
      if (normalized.includes("set last_polled_at = ?")) {
        const row = this.deviceRows.find((entry) => entry.device_code === values[1]);
        if (!row) return 0;
        row.last_polled_at = Number(values[0]);
        return 1;
      }
    }
    return 0;
  }
}

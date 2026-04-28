import path from "node:path";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";
import type { Database, SqlJsStatic } from "sql.js";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createReviewSuppressionService } from "./reviewSuppressionService";

type SqlValue = string | number | null | Uint8Array;
type AdeDb = {
  run: (sql: string, params?: SqlValue[]) => void;
  get: <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: SqlValue[]) => T | null;
  all: <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: SqlValue[]) => T[];
};

function mapExecRows(rows: { columns: string[]; values: unknown[][] }[]): Record<string, unknown>[] {
  const first = rows[0];
  if (!first) return [];
  return first.values.map((row) => {
    const out: Record<string, unknown> = {};
    first.columns.forEach((column, index) => {
      out[column] = row[index];
    });
    return out;
  });
}

let SQL: SqlJsStatic;

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
  const wasmDir = path.dirname(wasmPath);
  SQL = await initSqlJs({
    locateFile: (file) => path.join(wasmDir, file),
  });
});

function createDb(): { raw: Database; db: AdeDb } {
  const raw = new SQL.Database();
  raw.run(`
    create table review_suppressions(
      id text primary key,
      project_id text not null,
      scope text not null,
      repo_key text,
      path_pattern text,
      title text not null,
      title_norm text not null,
      finding_class text,
      severity text,
      reason text,
      note text,
      embedding_json text,
      source_finding_id text,
      hit_count integer not null default 0,
      created_at text not null,
      last_matched_at text
    )
  `);
  const db: AdeDb = {
    run: (sql, params = []) => raw.run(sql, params),
    all: <T extends Record<string, unknown>>(sql: string, params: SqlValue[] = []) =>
      mapExecRows(raw.exec(sql, params)) as T[],
    get: <T extends Record<string, unknown>>(sql: string, params: SqlValue[] = []) =>
      (mapExecRows(raw.exec(sql, params))[0] ?? null) as T | null,
  };
  return { raw, db };
}

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  child: () => logger,
} as unknown as Parameters<typeof createReviewSuppressionService>[0]["logger"];

describe("reviewSuppressionService", () => {
  let dbHandle: ReturnType<typeof createDb>;
  beforeEach(() => {
    dbHandle = createDb();
  });

  it("creates a suppression and lists it back", async () => {
    const svc = createReviewSuppressionService({
      db: dbHandle.db as unknown as import("../state/kvDb").AdeDb,
      logger,
      projectId: "proj-1",
    });
    await svc.create({
      scope: "repo",
      title: "prefer async/await over raw promises",
      repoKey: "arul28/ade",
      reason: "style_only",
    });
    const list = svc.list();
    expect(list.length).toBe(1);
    expect(list[0]?.title).toContain("async/await");
    expect(list[0]?.scope).toBe("repo");
  });

  it("matches a near-duplicate finding by title tokens", async () => {
    const svc = createReviewSuppressionService({
      db: dbHandle.db as unknown as import("../state/kvDb").AdeDb,
      logger,
      projectId: "proj-1",
    });
    await svc.create({
      scope: "repo",
      title: "Prefer async await over raw promise chains",
      repoKey: "arul28/ade",
      reason: "low_value_noise",
    });
    const hit = await svc.match({
      finding: {
        title: "Prefer async await instead of raw promise chains",
        body: "...",
        filePath: "src/foo.ts",
        findingClass: null,
        severity: "low",
      },
      repoKey: "arul28/ade",
    });
    expect(hit).not.toBeNull();
    expect(hit!.similarity).toBeGreaterThanOrEqual(0.55);
    expect(hit!.scope).toBe("repo");
  });

  it("does not match unrelated findings", async () => {
    const svc = createReviewSuppressionService({
      db: dbHandle.db as unknown as import("../state/kvDb").AdeDb,
      logger,
      projectId: "proj-1",
    });
    await svc.create({
      scope: "repo",
      title: "Inline styles instead of Tailwind classes",
      repoKey: "arul28/ade",
      reason: "style_only",
    });
    const hit = await svc.match({
      finding: {
        title: "Race condition in auth middleware",
        body: "Concurrent requests can corrupt the session store",
        filePath: "src/auth/middleware.ts",
        findingClass: null,
        severity: "high",
      },
      repoKey: "arul28/ade",
    });
    expect(hit).toBeNull();
  });

  it("respects path-scoped patterns", async () => {
    const svc = createReviewSuppressionService({
      db: dbHandle.db as unknown as import("../state/kvDb").AdeDb,
      logger,
      projectId: "proj-1",
    });
    await svc.create({
      scope: "path",
      title: "Magic number usage — prefer named constant",
      pathPattern: "src/math/**",
      reason: "low_value_noise",
    });
    const hit = await svc.match({
      finding: {
        title: "magic number usage, prefer named constant",
        body: "",
        filePath: "src/math/util.ts",
        findingClass: null,
        severity: "low",
      },
      repoKey: "whatever",
    });
    expect(hit?.scope).toBe("path");

    const miss = await svc.match({
      finding: {
        title: "magic number usage, prefer named constant",
        body: "",
        filePath: "src/other.ts",
        findingClass: null,
        severity: "low",
      },
      repoKey: "whatever",
    });
    expect(miss).toBeNull();
  });

  it("path glob `src/**/*.ts` matches both shallow and nested files", async () => {
    const svc = createReviewSuppressionService({
      db: dbHandle.db as unknown as import("../state/kvDb").AdeDb,
      logger,
      projectId: "proj-1",
    });
    await svc.create({
      scope: "path",
      title: "Prefer named export over default in TS module",
      pathPattern: "src/**/*.ts",
      reason: "style_only",
    });

    const shallow = await svc.match({
      finding: {
        title: "prefer named export over default in ts module",
        body: "",
        filePath: "src/foo.ts",
        findingClass: null,
        severity: "low",
      },
      repoKey: "r",
    });
    expect(shallow).not.toBeNull();

    const nested = await svc.match({
      finding: {
        title: "prefer named export over default in ts module",
        body: "",
        filePath: "src/a/b/c/foo.ts",
        findingClass: null,
        severity: "low",
      },
      repoKey: "r",
    });
    expect(nested).not.toBeNull();

    const wrongExt = await svc.match({
      finding: {
        title: "prefer named export over default in ts module",
        body: "",
        filePath: "src/foo.tsx",
        findingClass: null,
        severity: "low",
      },
      repoKey: "r",
    });
    expect(wrongExt).toBeNull();
  });

  it("path glob `?` matches exactly one non-slash character", async () => {
    const svc = createReviewSuppressionService({
      db: dbHandle.db as unknown as import("../state/kvDb").AdeDb,
      logger,
      projectId: "proj-1",
    });
    await svc.create({
      scope: "path",
      title: "Numbered helper lint",
      pathPattern: "src/helper?.ts",
      reason: "style_only",
    });

    const single = await svc.match({
      finding: {
        title: "numbered helper lint",
        body: "",
        filePath: "src/helper1.ts",
        findingClass: null,
        severity: "low",
      },
      repoKey: "r",
    });
    expect(single).not.toBeNull();

    const twoChars = await svc.match({
      finding: {
        title: "numbered helper lint",
        body: "",
        filePath: "src/helper12.ts",
        findingClass: null,
        severity: "low",
      },
      repoKey: "r",
    });
    expect(twoChars).toBeNull();

    const slashed = await svc.match({
      finding: {
        title: "numbered helper lint",
        body: "",
        filePath: "src/helper/.ts",
        findingClass: null,
        severity: "low",
      },
      repoKey: "r",
    });
    expect(slashed).toBeNull();
  });

  it("title-match fallback fires when embeddings are weak/missing but tokens overlap", async () => {
    // No embeddingService is provided, so both sides fall back to the
    // title-token (Jaccard) path with the TITLE_SIM_THRESHOLD bar (0.55).
    // The pre-fix logic applied the embedding threshold here and rejected.
    const svc = createReviewSuppressionService({
      db: dbHandle.db as unknown as import("../state/kvDb").AdeDb,
      logger,
      projectId: "proj-1",
    });
    await svc.create({
      scope: "repo",
      title: "Prefer async await over raw promise chains",
      repoKey: "arul28/ade",
      reason: "style_only",
    });
    const hit = await svc.match({
      finding: {
        title: "Prefer async await over raw promise chains",
        body: "",
        filePath: "src/anywhere.ts",
        findingClass: null,
        severity: "low",
      },
      repoKey: "arul28/ade",
    });
    expect(hit).not.toBeNull();
    // Identical titles → Jaccard = 1.0, comfortably above TITLE_SIM_THRESHOLD.
    expect(hit!.similarity).toBeGreaterThanOrEqual(0.55);
  });

  it("removes a suppression", async () => {
    const svc = createReviewSuppressionService({
      db: dbHandle.db as unknown as import("../state/kvDb").AdeDb,
      logger,
      projectId: "proj-1",
    });
    const created = await svc.create({
      scope: "global",
      title: "dead code removal nit",
      reason: "low_value_noise",
    });
    expect(svc.remove(created.id)).toBe(true);
    expect(svc.list()).toEqual([]);
  });
});

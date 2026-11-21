import { logCloud, type CloudEnv } from "./store";

/**
 * Saved storage that no row reads any more (`cloud_storage_sweeps`): a
 * deleted chat copy's prefix, a replaced or deleted capsule upload's parts,
 * a replaced or deleted CLI copy's object. The record is written in the same
 * D1 write that lets go of the storage, and removed only once its objects
 * are gone, so a sweep that fails part way is finished later
 * (`sweepLeftovers`, from the minute tick).
 *
 * Each saved row has storage of its own: a new chat copy a fresh prefix, a
 * capsule upload its own prefix, a CLI save its own object. So a sweep never
 * reaches the objects of a row made after it, even under the same names.
 */

/** One object (`exact`), or every object under a prefix that ends in `/`. */
export type SweepTarget = { key: string; exact: boolean };

/** A sweep this old died with its request: the tick finishes it. */
const SWEEP_RETRY_AFTER_MS = 10 * 60_000;
const SWEEPS_PER_TICK = 25;

/** A storage generation's own id: what makes a new row's prefix or key its own. */
export const storageGeneration = (): string => crypto.randomUUID().replace(/-/g, "");

/**
 * Records `target` to sweep. With `onlyIf`, only while that condition holds,
 * read in the same write: put it before the statement that lets go of the
 * storage, with the same condition, so the record exists exactly when the
 * row let go.
 */
export function sweepStatement(env: Pick<CloudEnv, "DB">, userId: string, target: SweepTarget, now: number, onlyIf?: { sql: string; binds: unknown[] }): D1PreparedStatement {
  return env.DB.prepare(`
    insert into cloud_storage_sweeps (r2_key, user_id, exact, created_at)
    select ?, ?, ?, ? ${onlyIf ? `where ${onlyIf.sql}` : ""}
    on conflict (r2_key) do nothing
  `).bind(target.key, userId, target.exact ? 1 : 0, now, ...(onlyIf?.binds ?? []));
}

/**
 * Clears the record of an upload this write publishes (a CLI copy's new
 * object): only while `onlyIf` holds, so a publish that lost its race leaves
 * the record and the tick sweeps the unpublished object. Pair it with a
 * `sweepStatement` written before the upload.
 */
export function publishedStatement(env: Pick<CloudEnv, "DB">, key: string, onlyIf: { sql: string; binds: unknown[] }): D1PreparedStatement {
  return env.DB.prepare(`delete from cloud_storage_sweeps where r2_key = ? and ${onlyIf.sql}`).bind(key, ...onlyIf.binds);
}

async function deleteTarget(bucket: R2Bucket, target: SweepTarget): Promise<void> {
  if (target.exact) {
    await bucket.delete(target.key);
    return;
  }
  // A prefix names a folder (`…/`): never a sibling whose name starts the same.
  const prefix = target.key.endsWith("/") ? target.key : `${target.key}/`;
  let cursor: string | undefined;
  for (;;) {
    const listed = await bucket.list({ prefix, cursor, limit: 1000 });
    const keys = listed.objects.map((object) => object.key);
    if (keys.length) await bucket.delete(keys);
    if (!listed.truncated) return;
    cursor = listed.cursor;
  }
}

/** Deletes the recorded targets' objects, then their records. A failure leaves its record for the tick. */
export async function sweep(env: Pick<CloudEnv, "DB" | "CLOUD_CHATS">, targets: SweepTarget[]): Promise<void> {
  const bucket = env.CLOUD_CHATS;
  if (!bucket) return;
  for (const target of targets) {
    await deleteTarget(bucket, target);
    await env.DB.prepare("delete from cloud_storage_sweeps where r2_key = ?").bind(target.key).run();
  }
}

/** The minute tick: sweeps a few that a request started and didn't finish. */
export async function sweepLeftovers(env: Pick<CloudEnv, "DB" | "CLOUD_CHATS">, now: number): Promise<number> {
  if (!env.CLOUD_CHATS) return 0;
  const rows = (await env.DB.prepare("select r2_key, exact from cloud_storage_sweeps where created_at < ? order by created_at limit ?")
    .bind(now - SWEEP_RETRY_AFTER_MS, SWEEPS_PER_TICK).all<{ r2_key: string; exact: number }>()).results ?? [];
  let swept = 0;
  for (const row of rows) {
    try {
      await sweep(env, [{ key: row.r2_key, exact: row.exact === 1 }]);
      swept += 1;
    } catch (error) {
      logCloud("cloud.storage_sweep_failed", { message: error instanceof Error ? error.message : "unknown" });
    }
  }
  return swept;
}

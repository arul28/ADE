import type { AccountStoreResult } from "./accountStore";

/**
 * The wire shapes of the account settings store, shared by main, preload and
 * the renderer.
 *
 * They live in `shared` rather than beside the main service because preload
 * must not import from `main/`, and the renderer must describe the same result
 * the handler returns. One definition, three consumers.
 */

/** One row of the per-key LWW store, as the brain returns it. */
export type AccountSettingRow = {
  /** `all`, or `repo:<normalized remote>`. */
  scope: string;
  key: string;
  value: unknown;
  /** Server stamp. The only thing newer-wins comparisons may use. */
  updatedAt: string;
  changedAt: string | null;
  writerDeviceId: string | null;
};

/**
 * Every account-settings call answers with one of these. A rejected write is
 * distinct from an unavailable runtime so callers can keep it dirty for retry.
 *
 * `ok: false` is an ordinary answer, not an error: unavailable means no brain
 * was reachable, while rejected means account ownership changed during the
 * write. Both keep the local copy safe; the latter must also remain dirty.
 */
export type AccountSettingsResult<T> = AccountStoreResult<T>;

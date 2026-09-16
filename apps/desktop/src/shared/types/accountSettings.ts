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
 * Every account-settings call answers with one of these.
 *
 * `ok: false` is an ordinary answer, not an error: it means no brain was
 * reachable, and the caller's correct response is to keep its local copy and
 * try again later. Making unreachability a value rather than a rejection is
 * what keeps a theme change working on a train.
 */
export type AccountSettingsResult<T> = AccountStoreResult<T>;

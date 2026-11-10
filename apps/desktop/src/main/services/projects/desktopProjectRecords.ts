import {
  isSendableProjectRecordValue,
  PROJECT_RECORD_ICON_KEY,
  PROJECT_RECORD_NO_ICON,
  projectRecordScope,
  projectRecordSendOutcome,
  sameProjectRecordValue,
  type ProjectRecordIconValue,
  type ProjectRecordSendAnswer,
  type ProjectRecordSendOutcome,
} from "../../../shared/projectRecord";
import type { ProjectIcon } from "../../../shared/types";
import type { AccountSettingsResult } from "../../../shared/types/accountSettings";
import { clearProjectIconOverride, resolveProjectIconOverridePath } from "./projectIconResolver";
import {
  claimProjectRecordMigration,
  createProjectRecordStandInStore,
  decideProjectRecordIcon,
  encodeProjectRecordIcon,
  readProjectRecordPending,
  writeProjectRecordPending,
  type ProjectRecordIconEncoder,
} from "./projectRecordHost";

/**
 * The shared project record (`shared/projectRecord.ts`) for projects on this
 * computer, as the desktop main process reads and writes it.
 *
 * The account settings store lives in the brain, so every read and write goes
 * through the `account_settings` bridge. When the brain has no store (a
 * `--no-sync` brain) or is not running, the rows go to the project's
 * `.ade/project-record.json` instead, as the brain does with sync off.
 *
 * A choice the user makes while the store cannot take it (signed out, brain
 * down) is also kept there as pending. This machine shows the pending value,
 * and the next read or write that reaches the store sends it first.
 */

type AccountSettingsPort = {
  get(scope: string, key: string): Promise<AccountSettingsResult<unknown>>;
  set(scope: string, key: string, value: unknown): Promise<AccountSettingsResult<null>>;
};

type RecordLogger = { warn(event: string, data?: Record<string, unknown>): void };

/**
 * - `user`: a choice the user just made; kept pending when it cannot go now.
 * - `flush`: a pending choice sent again; it simply stays pending.
 * - `migration`: the one-time upload of an older icon. Never pending: it must
 *   not beat a newer icon later, and it tries again on its own.
 */
type WriteKind = "user" | "flush" | "migration";

function sendAnswer(result: AccountSettingsResult<unknown>): ProjectRecordSendAnswer {
  if (result.ok) return "accepted";
  return "unavailable" in result ? "unreachable" : "refused";
}

/** A record read that takes longer than this shows the local icon instead and writes nothing. */
const RECORD_READ_DEADLINE_MS = 2_000;

export type LocalProjectIconResolver = (options: { ignoreOverride: boolean }) => ProjectIcon;

async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createDesktopProjectRecords(args: {
  accountSettings: AccountSettingsPort;
  /** The project's canonical origin URL (cheap: a cached git config read). */
  readOriginUrl: (projectRoot: string) => string | null;
  /** Whether an ADE account is signed in on this computer (a refused write while signed out stays pending). */
  isSignedIn: () => boolean;
  encoder: ProjectRecordIconEncoder;
  logger: RecordLogger;
}) {
  const scopeOf = (projectRoot: string): string | null => {
    try {
      return projectRecordScope(args.readOriginUrl(projectRoot));
    } catch {
      return null;
    }
  };

  const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

  const readPending = (projectRoot: string, scope: string): unknown => {
    try {
      return readProjectRecordPending(projectRoot, scope, PROJECT_RECORD_ICON_KEY);
    } catch {
      return undefined;
    }
  };

  /** Saves or (undefined) clears the pending write. False when the file could not be written (logged). */
  const setPending = (projectRoot: string, scope: string, value: unknown): boolean => {
    try {
      writeProjectRecordPending(projectRoot, scope, PROJECT_RECORD_ICON_KEY, value);
      return true;
    } catch (error) {
      args.logger.warn("project.record_pending_write_failed", { key: PROJECT_RECORD_ICON_KEY, error: errorText(error) });
      return false;
    }
  };

  /**
   * Sends a value to the account store. A user's choice that cannot go now
   * is kept pending, and in the stand-in (the store of a `--no-sync` brain).
   * A value the signed-in store refuses is logged and its pending entry
   * cleared.
   */
  const send = async (
    projectRoot: string,
    scope: string,
    value: unknown,
    kind: WriteKind,
  ): Promise<ProjectRecordSendOutcome> => {
    // A value that is not a valid record value (too large, damaged) is never sent.
    const sendable = isSendableProjectRecordValue(PROJECT_RECORD_ICON_KEY, value);
    const answer = sendable ? sendAnswer(await args.accountSettings.set(scope, PROJECT_RECORD_ICON_KEY, value)) : "refused";
    const outcome = sendable ? projectRecordSendOutcome(answer, args.isSignedIn) : "refused";
    if (outcome !== "keep_pending") {
      if (outcome === "refused") args.logger.warn("project.record_write_dropped", { key: PROJECT_RECORD_ICON_KEY, kind });
      if (readPending(projectRoot, scope) !== undefined) setPending(projectRoot, scope, undefined);
      return outcome;
    }
    if (kind === "flush") return outcome;
    // Signed out, the one-time upload is simply dropped, as before.
    if (kind === "migration" && answer !== "unreachable") return outcome;
    try {
      createProjectRecordStandInStore(projectRoot).set(scope, PROJECT_RECORD_ICON_KEY, value);
    } catch (error) {
      args.logger.warn("project.record_write_failed", { key: PROJECT_RECORD_ICON_KEY, error: errorText(error) });
    }
    if (kind === "user" && setPending(projectRoot, scope, value)) {
      args.logger.warn("project.record_write_pending", { key: PROJECT_RECORD_ICON_KEY });
    }
    return outcome;
  };

  /** The raw icon value, or null when it could not be read in time (then nothing is written either). */
  const readIcon = async (projectRoot: string, scope: string): Promise<{ raw: unknown } | null> => {
    const pending = readPending(projectRoot, scope);
    const result = await withDeadline(args.accountSettings.get(scope, PROJECT_RECORD_ICON_KEY), RECORD_READ_DEADLINE_MS);
    if (result?.ok) {
      if (pending === undefined) return { raw: result.value };
      // Signed out, the store would only drop it again.
      if (!args.isSignedIn()) return { raw: pending };
      // The store answers: send this machine's latest choice first.
      const outcome = await send(projectRoot, scope, pending, "flush");
      return { raw: outcome === "refused" ? result.value : pending };
    }
    const unreachable = result !== null && !result.ok && "unavailable" in result;
    let standIn: unknown;
    if (unreachable) {
      try {
        standIn = createProjectRecordStandInStore(projectRoot).get(scope, PROJECT_RECORD_ICON_KEY);
      } catch (error) {
        args.logger.warn("project.record_read_failed", { error: errorText(error) });
        return pending === undefined ? null : { raw: pending };
      }
    }
    if (pending !== undefined) {
      // A pending choice is also written to the stand-in. When the stand-in
      // now holds something else, a `--no-sync` brain changed it later: that
      // is newer, and with no account store there is nothing to send to.
      if (unreachable && !sameProjectRecordValue(standIn, pending)) {
        setPending(projectRoot, scope, undefined);
        return { raw: standIn };
      }
      return { raw: pending };
    }
    return unreachable ? { raw: standIn } : null;
  };

  const encodeOverride = (sourcePath: string): ProjectRecordIconValue | null => {
    const value = encodeProjectRecordIcon(sourcePath, args.encoder);
    // The local icon is kept; only the copy for other machines is missing.
    if (!value) args.logger.warn("project.record_icon_not_shared", { reason: "too_large_or_unreadable" });
    return value;
  };

  return {
    /**
     * The icon to show for a project on this computer: the record's icon,
     * else (record says removed) the detected one, else this machine's own
     * as before. A project from before the record uploads its own custom
     * icon once.
     */
    async resolveIcon(projectRoot: string, resolveLocal: LocalProjectIconResolver): Promise<ProjectIcon> {
      const scope = scopeOf(projectRoot);
      const read = scope ? await readIcon(projectRoot, scope) : null;
      if (!scope || !read) return resolveLocal({ ignoreOverride: false });
      const decision = decideProjectRecordIcon(scope, read.raw);
      if (decision.use === "record") return decision.icon;
      if (decision.use === "detected") {
        try {
          clearProjectIconOverride(projectRoot);
        } catch (error) {
          args.logger.warn("project.record_override_clear_failed", { error: errorText(error) });
        }
        return resolveLocal({ ignoreOverride: true });
      }
      if (decision.migrate) {
        const overridePath = resolveProjectIconOverridePath(projectRoot);
        const value = overridePath ? claimProjectRecordMigration(scope, overridePath, encodeOverride) : null;
        if (value) await send(projectRoot, scope, value, "migration");
      }
      return resolveLocal({ ignoreOverride: false });
    },

    /** After the user set this machine's icon: share it. Never throws; a copy that cannot be made is logged. */
    async shareLocalIcon(projectRoot: string): Promise<void> {
      const scope = scopeOf(projectRoot);
      if (!scope) return;
      try {
        const overridePath = resolveProjectIconOverridePath(projectRoot);
        const value = overridePath ? encodeOverride(overridePath) : null;
        if (value) await send(projectRoot, scope, value, "user");
      } catch (error) {
        args.logger.warn("project.record_write_failed", { key: PROJECT_RECORD_ICON_KEY, error: errorText(error) });
      }
    },

    /**
     * Removes the custom icon. A shared project goes back to its detected icon
     * on every machine; a project with no origin keeps today's behavior.
     */
    async removeIcon(
      projectRoot: string,
      removeLocal: () => ProjectIcon,
      resolveLocal: LocalProjectIconResolver,
    ): Promise<ProjectIcon> {
      const scope = scopeOf(projectRoot);
      if (!scope) return removeLocal();
      await send(projectRoot, scope, PROJECT_RECORD_NO_ICON, "user");
      clearProjectIconOverride(projectRoot);
      return resolveLocal({ ignoreOverride: true });
    },
  };
}

export type DesktopProjectRecords = ReturnType<typeof createDesktopProjectRecords>;

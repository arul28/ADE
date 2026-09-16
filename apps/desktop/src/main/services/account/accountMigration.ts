import {
  createAccountMigrationReceipt,
  MIGRATION_SOURCES,
  type MigrationSource,
  type MigrationOutcome,
} from "../../../../../ade-cli/src/services/account/accountMigrationReceipt";

export type AccountMigrationSourceResult = {
  moved: number;
  skipped: number;
  /** Leave the source pending when its local store is not ready yet. */
  complete?: boolean;
};

export type AccountMigrationSource =
  () => AccountMigrationSourceResult | void | Promise<AccountMigrationSourceResult | void>;

export type AccountMigrationSources = Partial<Record<MigrationSource, AccountMigrationSource>>;

export type AccountMigrationArgs = {
  receiptDir: string;
  sources: AccountMigrationSources;
  getAccountUserId?: () => string | null;
  logger?: {
    info?(message: string, meta?: Record<string, unknown>): void;
    warn?(message: string, meta?: Record<string, unknown>): void;
  };
  now?: () => number;
};

export type AccountMigrationRun = {
  completed: Array<{ source: MigrationSource } & MigrationOutcome>;
  pending: MigrationSource[];
  failed: MigrationSource[];
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}

function normalizeCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * Run the supplied silent migrations in a stable order.
 *
 * Each source is acknowledged only after its runner resolves. A failed or
 * not-ready source stays pending, while earlier completed sources remain in
 * the receipt so a later launch resumes at the right boundary.
 */
export async function runAccountMigration(args: AccountMigrationArgs): Promise<AccountMigrationRun> {
  const now = args.now ?? Date.now;
  const receipt = createAccountMigrationReceipt({
    adeDir: args.receiptDir,
    getAccountUserId: args.getAccountUserId ?? (() => null),
    logger: { info: (message, meta) => args.logger?.info?.(message, meta) },
    now: args.now,
  });
  const completed: AccountMigrationRun["completed"] = [];
  const pending: MigrationSource[] = [];
  const failed: MigrationSource[] = [];

  for (const source of MIGRATION_SOURCES) {
    const run = args.sources[source];
    if (!run) continue;

    try {
      if (receipt.isComplete(source)) continue;
    } catch (error) {
      failed.push(source);
      args.logger?.warn?.("account.migration_receipt_read_failed", {
        source,
        error: errorMessage(error),
      });
      continue;
    }

    try {
      const result = await run();
      if (result && result.complete === false) {
        pending.push(source);
        continue;
      }
      const counts = {
        moved: normalizeCount(result && "moved" in result ? result.moved : 0),
        skipped: normalizeCount(result && "skipped" in result ? result.skipped : 0),
      };
      receipt.complete(source, counts);
      completed.push({ source, ...counts, completedAt: new Date(now()).toISOString() });
    } catch (error) {
      failed.push(source);
      args.logger?.warn?.("account.migration_source_failed", {
        source,
        error: errorMessage(error),
      });
    }
  }

  return { completed, pending, failed };
}

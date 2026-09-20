import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../../../../desktop/src/main/services/state/durableFile";
import { pathKey } from "../../../../desktop/src/main/services/shared/pathCompare";

/**
 * What this machine has already moved into the account, so it never moves it
 * twice.
 *
 * Migration here is silent and automatic — the owner's explicit decision. That
 * raises the bar on everything else about it: a silent action that half-ran, or
 * that ran again on the next launch and resurrected something the user deleted,
 * is not something anyone would notice until it had already cost them. So the
 * receipt is written per machine **and per source**, and a source is marked
 * complete only after the account confirms the write.
 *
 * Three rules this file exists to keep:
 *
 *  1. **Once per machine per source.** A crash resumes rather than repeats.
 *  2. **A source is never deleted here.** The old store stays readable for one
 *     release, so a user who rolls back still has their secrets. A later
 *     release removes the reader, not this code.
 *  3. **Newer never loses to older.** The account is filled by whichever
 *     machine migrates first; every machine after that finds the keys present
 *     and imports nothing, which is what stops a stale laptop overwriting a
 *     credential someone rotated last week.
 */

const RECEIPT_FILE = "account-migration.json";
const RECEIPT_VERSION = 1;

/**
 * Every store ADE migrates out of. Named rather than free-form so a receipt can
 * be read against a known list, and so a source that is added later is visibly
 * absent from an older machine's receipt rather than silently assumed done.
 */
export type MigrationSource =
  /** `.ade/ade.yaml` — the committed project config that is being retired. */
  | "shared_project_config"
  /** Renderer `localStorage` preferences: appearance, chat, terminal look. */
  | "renderer_preferences"
  /** `project-secrets.v1.enc` — the project secret store. */
  | "project_secrets"
  /** `ai.api_key.*` — provider API keys from the Electron-only store. */
  | "provider_api_keys"
  /** `linear.token.v1` and friends — the Linear OAuth credential. */
  | "linear_credentials";

export const MIGRATION_SOURCES: readonly MigrationSource[] = [
  "shared_project_config",
  "renderer_preferences",
  "project_secrets",
  "provider_api_keys",
  "linear_credentials",
] as const;

export type MigrationOutcome = {
  /** Set only after the account confirmed the write. */
  completedAt: string;
  /** How many items this machine actually moved. Zero is a real answer: it
   *  means another machine got there first, which is the common case. */
  moved: number;
  /** Items found in the source that the account already held. */
  skipped: number;
};

type ProjectReceiptSources = Partial<Record<MigrationSource, MigrationOutcome>>;

type ReceiptFile = {
  version: number;
  accountUserId: string | null;
  sources: Partial<Record<MigrationSource, MigrationOutcome>>;
  /** Project-scoped sources are keyed by canonical project root. */
  projectSources?: Record<string, ProjectReceiptSources>;
};

export type MigrationReceiptScope = {
  projectRoot?: string | null;
};

type ProjectRootKeys = {
  canonical: string;
  legacy: string[];
};

function projectRootKeys(root: string, platform: NodeJS.Platform): ProjectRootKeys {
  const resolved = path.resolve(root);
  let canonicalPath = resolved;
  try {
    canonicalPath = fs.realpathSync.native(resolved);
  } catch {
    // A project can be opened before its root exists. The resolved spelling is
    // still the best canonical key available in that case.
  }
  return {
    canonical: pathKey(canonicalPath, platform),
    legacy: [resolved, pathKey(resolved, platform)],
  };
}

function canonicalProjectRoot(root: string, platform: NodeJS.Platform): string {
  return projectRootKeys(root, platform).canonical;
}

function emptyReceipt(accountUserId: string | null): ReceiptFile {
  return { version: RECEIPT_VERSION, accountUserId, sources: {} };
}

export function createAccountMigrationReceipt(args: {
  adeDir: string;
  getAccountUserId: () => string | null;
  logger?: { info(message: string, meta?: Record<string, unknown>): void };
  now?: () => number;
  platform?: NodeJS.Platform;
}) {
  const receiptPath = path.join(args.adeDir, RECEIPT_FILE);
  const now = args.now ?? Date.now;
  const platform = args.platform ?? process.platform;
  const logger = args.logger ?? { info: () => {} };

  function read(): ReceiptFile {
    const accountUserId = args.getAccountUserId();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    } catch {
      parsed = null;
    }
    const loaded = parsed as Partial<ReceiptFile> | null;
    // A receipt belonging to a different account describes a migration into
    // somebody else's store. It proves nothing about this one.
    if (
      !loaded
      || loaded.version !== RECEIPT_VERSION
      || (loaded.accountUserId ?? null) !== accountUserId
    ) {
      return emptyReceipt(accountUserId);
    }
    return {
      version: RECEIPT_VERSION,
      accountUserId,
      sources: loaded.sources && typeof loaded.sources === "object" ? loaded.sources : {},
      projectSources: loaded.projectSources && typeof loaded.projectSources === "object"
        ? loaded.projectSources as Record<string, ProjectReceiptSources>
        : undefined,
    };
  }

  function scopedProjectRoot(source: MigrationSource, scope?: MigrationReceiptScope): string | null {
    if (source !== "project_secrets") return null;
    const root = scope?.projectRoot?.trim();
    return root ? canonicalProjectRoot(root, platform) : null;
  }

  function sourceOutcomes(
    receipt: ReceiptFile,
    source: MigrationSource,
    scope?: MigrationReceiptScope,
  ): Partial<Record<MigrationSource, MigrationOutcome>> {
    if (source !== "project_secrets") return receipt.sources;
    const root = scope?.projectRoot?.trim();
    if (!root) return receipt.sources;

    const keys = projectRootKeys(root, platform);
    const projectSources = receipt.projectSources;
    if (!projectSources) return {};
    const canonicalSources = projectSources[keys.canonical] ?? {};
    let migratedLegacy = false;
    for (const legacyKey of keys.legacy) {
      if (legacyKey === keys.canonical) continue;
      const legacySources = projectSources[legacyKey];
      if (!legacySources || typeof legacySources !== "object" || Array.isArray(legacySources)) continue;
      migratedLegacy = true;
      for (const [legacySource, legacyOutcome] of Object.entries(legacySources)) {
        const typedSource = legacySource as MigrationSource;
        const canonicalOutcome = canonicalSources[typedSource];
        if (!canonicalOutcome?.completedAt) {
          canonicalSources[typedSource] = legacyOutcome as MigrationOutcome;
        }
      }
      delete projectSources[legacyKey];
    }
    if (migratedLegacy) projectSources[keys.canonical] = canonicalSources;
    return projectSources[keys.canonical] ?? {};
  }

  function write(receipt: ReceiptFile): void {
    fs.mkdirSync(args.adeDir, { recursive: true });
    writeFileAtomic(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  }

  return {
    /** True when this machine has already finished this source for this account. */
    isComplete(source: MigrationSource, scope?: MigrationReceiptScope): boolean {
      return Boolean(sourceOutcomes(read(), source, scope)[source]?.completedAt);
    },

    /**
     * Record a finished source.
     *
     * Call this only after the account has confirmed the write. Recording it
     * before would turn a failed upload into a permanent skip, and the user's
     * secrets would stay on one machine with nothing left to notice it.
     */
    complete(
      source: MigrationSource,
      counts: { moved: number; skipped: number },
      scope?: MigrationReceiptScope,
    ): void {
      const receipt = read();
      const outcome = {
        completedAt: new Date(now()).toISOString(),
        moved: counts.moved,
        skipped: counts.skipped,
      };
      const projectRoot = scopedProjectRoot(source, scope);
      if (projectRoot) {
        // Reading also folds a legacy path.resolve key into the in-memory
        // canonical entry, so this write upgrades it without a second pass.
        sourceOutcomes(receipt, source, scope);
        receipt.projectSources ??= {};
        receipt.projectSources[projectRoot] ??= {};
        receipt.projectSources[projectRoot][source] = outcome;
      } else {
        receipt.sources[source] = outcome;
      }
      write(receipt);
      // Migration is silent by design, so the log is the only record a user or
      // a support conversation can ever consult. It names counts, never values.
      logger.info("account.migration_completed", {
        source,
        ...counts,
        ...(projectRoot ? { projectRoot } : {}),
      });
    },

    /** Everything this machine has migrated, for the Diagnostics panel. */
    summary(scope?: MigrationReceiptScope): Array<{ source: MigrationSource } & MigrationOutcome> {
      const receipt = read();
      return MIGRATION_SOURCES.flatMap((source) => {
        const outcome = sourceOutcomes(receipt, source, scope)[source];
        return outcome ? [{ source, ...outcome }] : [];
      });
    },

    /** Sources this machine has not finished yet. */
    pending(scope?: MigrationReceiptScope): MigrationSource[] {
      const receipt = read();
      return MIGRATION_SOURCES.filter((source) => !sourceOutcomes(receipt, source, scope)[source]?.completedAt);
    },

    receiptPathForTests(): string {
      return receiptPath;
    },
  };
}

export type AccountMigrationReceipt = ReturnType<typeof createAccountMigrationReceipt>;

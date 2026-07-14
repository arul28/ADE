import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Cookie, CookiesSetDetails, Session } from "electron";
import type { Logger } from "../logging/logger";
import { BUILT_IN_BROWSER_PARTITION } from "./builtInBrowserConstants";

const MIGRATION_VERSION = 1;
const LEGACY_PARTITION_RE = /^ade-browser-project-[a-f0-9]{16}$/;
const MAX_LEGACY_PARTITIONS = 64;
const MAX_COOKIES_PER_RUN = 5_000;
const MIGRATION_FILE_NAME = "ade-browser-profile-migration-v1.json";

type MigrationState = {
  version: typeof MIGRATION_VERSION;
  completedPartitions: string[];
  updatedAt: string;
};

export type BuiltInBrowserProfileMigrationResult = {
  discoveredPartitionCount: number;
  completedPartitionCount: number;
  migratedCookieCount: number;
  skippedCookieCount: number;
  deferredCookieCount: number;
};

export async function migrateLegacyBuiltInBrowserProfiles(args: {
  userDataPath: string;
  getSession: (partition: string) => Session;
  getLogger?: () => Logger | null;
}): Promise<BuiltInBrowserProfileMigrationResult> {
  const markerPath = path.join(args.userDataPath, MIGRATION_FILE_NAME);
  const completed = new Set(loadMigrationState(markerPath).completedPartitions);
  const legacyPartitions = await listLegacyPartitions(args.userDataPath);
  const pendingPartitions = legacyPartitions.filter((partition) => !completed.has(partition));
  const globalSession = args.getSession(BUILT_IN_BROWSER_PARTITION);
  const globalCookies = await globalSession.cookies.get({});
  const globalCookieKeys = new Set(globalCookies.map(cookieKey));
  let migratedCookieCount = 0;
  let skippedCookieCount = 0;
  let deferredCookieCount = 0;
  let remainingBudget = MAX_COOKIES_PER_RUN;

  for (const partitionName of pendingPartitions) {
    const legacySession = args.getSession(`persist:${partitionName}`);
    let cookies: Cookie[];
    try {
      cookies = await legacySession.cookies.get({});
    } catch (error) {
      logger(args)?.warn("built_in_browser.profile_partition_read_failed", {
        legacyPartition: partitionName,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const candidates = cookies.filter(isMigratablePersistentCookie);
    let complete = true;
    for (const cookie of candidates) {
      const key = cookieKey(cookie);
      if (globalCookieKeys.has(key)) {
        skippedCookieCount += 1;
        continue;
      }
      if (remainingBudget <= 0) {
        deferredCookieCount += 1;
        complete = false;
        continue;
      }
      remainingBudget -= 1;
      try {
        await globalSession.cookies.set(cookieSetDetails(cookie));
        globalCookieKeys.add(key);
        migratedCookieCount += 1;
      } catch (error) {
        complete = false;
        logger(args)?.warn("built_in_browser.profile_cookie_migration_failed", {
          legacyPartition: partitionName,
          cookieOrigin: cookieOriginForLog(cookie),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (complete) completed.add(partitionName);
  }

  if (migratedCookieCount > 0) await globalSession.cookies.flushStore();
  await writeMigrationState(markerPath, {
    version: MIGRATION_VERSION,
    completedPartitions: [...completed].sort(),
    updatedAt: new Date().toISOString(),
  });
  const result = {
    discoveredPartitionCount: legacyPartitions.length,
    completedPartitionCount: legacyPartitions.filter((partition) => completed.has(partition)).length,
    migratedCookieCount,
    skippedCookieCount,
    deferredCookieCount,
  };
  logger(args)?.info("built_in_browser.profile_migration_completed", result);
  return result;
}

async function listLegacyPartitions(userDataPath: string): Promise<string[]> {
  const partitionsPath = path.join(userDataPath, "Partitions");
  let entries: fsSync.Dirent[];
  try {
    entries = await fs.readdir(partitionsPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const candidates = entries
    .filter((entry) => entry.isDirectory() && LEGACY_PARTITION_RE.test(entry.name))
    .map((entry) => entry.name);
  const dated = await Promise.all(candidates.map(async (name) => {
    const partitionPath = path.join(partitionsPath, name);
    const cookiePath = path.join(partitionPath, "Cookies");
    const stats = await fs.stat(cookiePath).catch(() => fs.stat(partitionPath).catch(() => null));
    return { name, modifiedAtMs: stats?.mtimeMs ?? 0 };
  }));
  return dated
    .sort((left, right) => right.modifiedAtMs - left.modifiedAtMs || left.name.localeCompare(right.name))
    .slice(0, MAX_LEGACY_PARTITIONS)
    .map((entry) => entry.name);
}

function isMigratablePersistentCookie(cookie: Cookie): boolean {
  return (
    cookie.session !== true
    && typeof cookie.expirationDate === "number"
    && Number.isFinite(cookie.expirationDate)
    && cookie.expirationDate > Date.now() / 1_000
    && Boolean(normalizedCookieDomain(cookie.domain))
  );
}

function cookieKey(cookie: Cookie): string {
  return JSON.stringify([
    normalizedCookieDomain(cookie.domain),
    cookie.path ?? "/",
    cookie.name,
    cookie.hostOnly === true,
  ]);
}

function cookieSetDetails(cookie: Cookie): CookiesSetDetails {
  const domain = normalizedCookieDomain(cookie.domain);
  if (!domain || cookie.expirationDate == null) throw new Error("Legacy cookie is missing a valid domain or expiry.");
  const pathValue = cookie.path?.startsWith("/") ? cookie.path : "/";
  return {
    url: `${cookie.secure ? "https" : "http"}://${domain}${pathValue}`,
    name: cookie.name,
    value: cookie.value,
    ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
    path: pathValue,
    secure: cookie.secure === true,
    httpOnly: cookie.httpOnly === true,
    expirationDate: cookie.expirationDate,
    sameSite: cookie.sameSite,
  };
}

function normalizedCookieDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/^\./, "").toLowerCase();
  if (!normalized || normalized.includes("/") || normalized.includes(":")) return null;
  return normalized;
}

function cookieOriginForLog(cookie: Cookie): string | null {
  const domain = normalizedCookieDomain(cookie.domain);
  return domain ? `${cookie.secure ? "https" : "http"}://${domain}` : null;
}

function loadMigrationState(filePath: string): MigrationState {
  try {
    const parsed = JSON.parse(fsSync.readFileSync(filePath, "utf8")) as Partial<MigrationState>;
    if (parsed.version !== MIGRATION_VERSION || !Array.isArray(parsed.completedPartitions)) {
      throw new Error("unsupported migration state");
    }
    return {
      version: MIGRATION_VERSION,
      completedPartitions: parsed.completedPartitions.filter((value): value is string => (
        typeof value === "string" && LEGACY_PARTITION_RE.test(value)
      )),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return { version: MIGRATION_VERSION, completedPartitions: [], updatedAt: new Date(0).toISOString() };
  }
}

async function writeMigrationState(filePath: string, state: MigrationState): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tempPath, filePath);
    await fs.chmod(filePath, 0o600).catch(() => {});
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

function logger(args: { getLogger?: () => Logger | null }): Logger | null {
  try {
    return args.getLogger?.() ?? null;
  } catch {
    return null;
  }
}

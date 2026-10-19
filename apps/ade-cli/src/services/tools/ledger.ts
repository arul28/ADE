import { promises as fsp } from "node:fs";
import path from "node:path";
import { assertSafePackageCoordinates } from "./paths";
import { warnPinnedToolFetch } from "./onDemand";

/**
 * Every package directory ADE has written under the tools root, and when an
 * ADE build last pinned it.
 *
 * `gcTools` collects superseded versions of the packages the current manifest
 * pins, but a package the manifest no longer names at all (a vendor renamed its
 * platform package, a tool was dropped) used to be left alone forever: the
 * 276 MB `opencode-darwin-arm64/1.18.x` from before the `@opencode/cli-*`
 * rename is still on machines today. The ledger is what makes those
 * collectable without guessing: only a name in it can be removed, and only
 * once no ADE on this machine has pinned it for {@link RETIRED_PACKAGE_GRACE_MS}.
 * Every collection refreshes the packages its own manifest pins, so a second
 * channel that still uses a package keeps it alive by running.
 *
 * Writes are tmp-file + rename, so a reader never sees half a ledger. Two
 * processes racing a read-modify-write can lose one update; that only delays a
 * collection to the next run, because each run re-records what it pins.
 */
const LEDGER_FILE = ".installed-packages.json";
const LEDGER_SCHEMA_VERSION = 1;

/** Long enough for a second ADE channel to run and refresh what it pins. */
export const RETIRED_PACKAGE_GRACE_MS = 14 * 24 * 60 * 60_000;

/**
 * Package directories ADE builds wrote before the ledger existed and no build
 * pins any more: OpenCode's platform packages before the `@opencode/cli-*`
 * rename (#1361). Seeded at ledger creation so the usual grace period applies.
 */
const LEGACY_TOOL_PACKAGES = [
  "opencode-darwin-arm64",
  "opencode-darwin-x64",
  "opencode-linux-arm64",
  "opencode-linux-x64",
  "opencode-windows-x64-baseline",
] as const;

export type ToolsLedger = {
  /** Package name -> epoch ms an ADE build last pinned it. */
  packages: Record<string, number>;
};

function ledgerPath(toolsRoot: string): string {
  return path.join(toolsRoot, LEDGER_FILE);
}

function isSafePackageName(name: string): boolean {
  try {
    assertSafePackageCoordinates(name, "0");
    return true;
  } catch {
    return false;
  }
}

/** The ledger on disk; a missing or unreadable one starts from the legacy seed. */
export async function readToolsLedger(toolsRoot: string): Promise<ToolsLedger> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fsp.readFile(ledgerPath(toolsRoot), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warnPinnedToolFetch("tools.ledger_read_failed", { message: error instanceof Error ? error.message : String(error) });
    }
    const createdAt = Date.now();
    return { packages: Object.fromEntries(LEGACY_TOOL_PACKAGES.map((name) => [name, createdAt])) };
  }
  const packages: Record<string, number> = {};
  const recorded = (raw as { packages?: unknown } | null)?.packages;
  if (recorded && typeof recorded === "object" && !Array.isArray(recorded)) {
    for (const [name, lastPinnedAt] of Object.entries(recorded)) {
      // A name that is not a safe package path segment is dropped, never acted on.
      if (isSafePackageName(name) && typeof lastPinnedAt === "number" && Number.isFinite(lastPinnedAt)) {
        packages[name] = lastPinnedAt;
      }
    }
  }
  return { packages };
}

export async function writeToolsLedger(toolsRoot: string, ledger: ToolsLedger): Promise<void> {
  await fsp.mkdir(toolsRoot, { recursive: true });
  const target = ledgerPath(toolsRoot);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const sorted = Object.fromEntries(Object.entries(ledger.packages).sort(([left], [right]) => left.localeCompare(right)));
  await fsp.writeFile(temp, `${JSON.stringify({ schemaVersion: LEDGER_SCHEMA_VERSION, packages: sorted }, null, 2)}\n`, "utf8");
  try {
    await fsp.rename(temp, target);
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Mark packages as pinned now. Best effort: a failed write only delays a later collection. */
export async function recordPinnedPackages(toolsRoot: string, packageNames: readonly string[], now = Date.now()): Promise<void> {
  try {
    const ledger = await readToolsLedger(toolsRoot);
    for (const name of packageNames) ledger.packages[name] = now;
    await writeToolsLedger(toolsRoot, ledger);
  } catch (error) {
    warnPinnedToolFetch("tools.ledger_write_failed", { message: error instanceof Error ? error.message : String(error) });
    // The next install or collection records it again.
  }
}

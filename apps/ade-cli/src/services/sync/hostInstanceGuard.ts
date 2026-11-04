import fs from "node:fs";
import path from "node:path";

/**
 * A copied ADE home must not come up as the machine it was copied from.
 *
 * A cloud box can be forked: Agent37's `fork` copies the whole disk, so the
 * new box boots with this machine's relay key, device id, signing key, account
 * session and every project's cr-sqlite site id. Measured on 2026-11-03: the
 * fork published itself under the original's machine key, took over its relay
 * tunnel, and the two boxes then took turns renaming the one account row. Two
 * writers with one site id would also corrupt every synced project.
 *
 * The host says which box this is through `ADE_HOST_INSTANCE_ID` (ADE's cloud
 * templates set it; Agent37's hostname is the instance id). The id is recorded
 * beside the identity the first time a brain starts. When a later start sees a
 * different id, this home was copied: the machine's identity and trust files
 * are moved aside (never deleted, so a wrong call is recoverable by moving them
 * back) and each project's site id is retired, so the box starts signed out as
 * a NEW machine and keeps every file, repo and lane.
 *
 * Without the variable this does nothing at all, so a laptop whose hostname
 * changes is never mistaken for a copy.
 */
export const HOST_INSTANCE_ENV = "ADE_HOST_INSTANCE_ID";
export const HOST_INSTANCE_RECORD_FILE = "host-instance.json";

type HostInstanceRecord = { instanceId: string; recordedAt: string };

export type HostInstanceGuardResult =
  | { action: "disabled" }
  | { action: "recorded"; instanceId: string }
  | { action: "unchanged"; instanceId: string }
  | {
      action: "reset";
      instanceId: string;
      previousInstanceId: string;
      movedTo: string;
      retiredProjectSiteIds: string[];
    }
  | {
      /**
       * The home was copied, but some project's site id could not be retired
       * (or the project list could not be read). The new record is NOT
       * written, so the brain must not start: the next start runs the reset
       * again, and only what is left gets done.
       */
      action: "blocked";
      instanceId: string;
      previousInstanceId: string;
      movedTo: string;
      retiredProjectSiteIds: string[];
      failures: Array<{ path: string; error: string }>;
    };

function readRecord(filePath: string): HostInstanceRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<HostInstanceRecord>;
    return typeof parsed.instanceId === "string" && parsed.instanceId.trim()
      ? { instanceId: parsed.instanceId.trim(), recordedAt: String(parsed.recordedAt ?? "") }
      : null;
  } catch {
    return null;
  }
}

function writeRecord(filePath: string, instanceId: string, now: Date): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const record: HostInstanceRecord = { instanceId, recordedAt: now.toISOString() };
  fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The registered roots; a missing list is empty, any other read or parse failure throws. */
function registeredProjectRoots(registryPath: string): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(registryPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return [];
    throw error;
  }
  const parsed = JSON.parse(raw) as { projects?: Array<{ rootPath?: unknown }> };
  return (parsed.projects ?? [])
    .map((project) => (typeof project.rootPath === "string" ? project.rootPath : ""))
    .filter((rootPath) => rootPath.length > 0);
}

/** A folder an earlier, interrupted reset of this same copy already moved the identity into. */
function earlierMove(copiedDir: string, previousInstanceId: string): string | null {
  const suffix = `-from-${folderSafe(previousInstanceId)}`;
  let entries: string[];
  try {
    entries = fs.readdirSync(copiedDir);
  } catch (error) {
    // No folder yet is the first pass; anything else stops the start, to be retried.
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return null;
    throw error;
  }
  const match = entries.filter((entry) => entry.endsWith(suffix)).sort().pop();
  return match ? path.join(copiedDir, match) : null;
}

/** True when the path exists, false only when it does not (ENOENT); any other error is thrown. */
function pathPresent(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** A filesystem-safe stamp for the folder the old identity moves into. */
function folderSafe(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "unknown";
}

export function guardAgainstCopiedAdeHome(args: {
  adeDir: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  logger?: { info?: (event: string, meta: Record<string, unknown>) => void; warn?: (event: string, meta: Record<string, unknown>) => void };
}): HostInstanceGuardResult {
  const env = args.env ?? process.env;
  const instanceId = env[HOST_INSTANCE_ENV]?.trim();
  if (!instanceId) return { action: "disabled" };
  const now = args.now ?? (() => new Date());
  const secretsDir = path.join(args.adeDir, "secrets");
  // The record sits OUTSIDE secrets/, which is what moves aside: a reset must
  // leave the new box's record behind, not the old one's.
  const recordPath = path.join(args.adeDir, HOST_INSTANCE_RECORD_FILE);
  const record = readRecord(recordPath);

  if (!record) {
    writeRecord(recordPath, instanceId, now());
    return { action: "recorded", instanceId };
  }
  if (record.instanceId === instanceId) return { action: "unchanged", instanceId };

  // Safe to run again: a start that was blocked below left the old record in
  // place, so the next start comes back here. The identity it already moved
  // is found by its folder name and not moved twice (whatever is in secrets/
  // now was made on this box), and only projects not retired yet are retired.
  const copiedDir = path.join(args.adeDir, "copied-identities");
  let movedTo = earlierMove(copiedDir, record.instanceId);
  if (movedTo) {
    args.logger?.info?.("host_instance.copied_home_reset_resumed", { instanceId, previousInstanceId: record.instanceId, movedTo });
  } else {
    const stamp = now().toISOString().replace(/[:.]/g, "-");
    movedTo = path.join(copiedDir, `${stamp}-from-${folderSafe(record.instanceId)}`);
    fs.mkdirSync(copiedDir, { recursive: true });
    // The whole secrets folder, not a list of files: everything in it is this
    // machine's identity, its trust in other devices, or ciphertext under its
    // `.machine-key`, and a list would silently miss the next file anyone adds.
    // API keys and the account vault come back from the account after sign-in.
    if (fs.existsSync(secretsDir)) fs.renameSync(secretsDir, movedTo);
    else fs.mkdirSync(movedTo, { recursive: true });
  }

  // Each project database takes its cr-sqlite site id from the project's own
  // `.ade/secrets/sync-site-id` (kvDb mints one when it is missing, and applies
  // it before the extension loads), so retiring the file gives the copy a site
  // id of its own on the next open. Every one must go before this box may
  // serve: a project left on the copied site id would write as the original.
  const retiredProjectSiteIds: string[] = [];
  const failures: Array<{ path: string; error: string }> = [];
  const registryPath = path.join(args.adeDir, "projects.json");
  let roots: string[] = [];
  try {
    roots = registeredProjectRoots(registryPath);
  } catch (error) {
    failures.push({ path: registryPath, error: errorText(error) });
  }
  for (const rootPath of roots) {
    const siteIdPath = path.join(rootPath, ".ade", "secrets", "sync-site-id");
    const retiredPath = `${siteIdPath}.copied-from-${folderSafe(record.instanceId)}`;
    try {
      // Retired by an earlier pass: a site id there now was minted on this box.
      if (pathPresent(retiredPath)) continue;
      // `existsSync` reads "cannot look" as "absent", and an unreadable site id
      // skipped here would keep writing as the original. Only ENOENT is absent.
      if (!pathPresent(siteIdPath)) continue;
      fs.renameSync(siteIdPath, retiredPath);
      retiredProjectSiteIds.push(rootPath);
    } catch (error) {
      failures.push({ path: rootPath, error: errorText(error) });
    }
  }
  if (failures.length) {
    args.logger?.warn?.("host_instance.copied_home_reset_blocked", {
      instanceId,
      previousInstanceId: record.instanceId,
      movedTo,
      failures,
    });
    return { action: "blocked", instanceId, previousInstanceId: record.instanceId, movedTo, retiredProjectSiteIds, failures };
  }

  writeRecord(recordPath, instanceId, now());
  args.logger?.info?.("host_instance.copied_home_reset", {
    instanceId,
    previousInstanceId: record.instanceId,
    movedTo,
    retiredProjectSiteIds: retiredProjectSiteIds.length,
  });
  return { action: "reset", instanceId, previousInstanceId: record.instanceId, movedTo, retiredProjectSiteIds };
}

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

function registeredProjectRoots(adeDir: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(adeDir, "projects.json"), "utf8")) as {
      projects?: Array<{ rootPath?: unknown }>;
    };
    return (parsed.projects ?? [])
      .map((project) => (typeof project.rootPath === "string" ? project.rootPath : ""))
      .filter((rootPath) => rootPath.length > 0);
  } catch {
    return [];
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

  const stamp = now().toISOString().replace(/[:.]/g, "-");
  const movedTo = path.join(args.adeDir, "copied-identities", `${stamp}-from-${folderSafe(record.instanceId)}`);
  fs.mkdirSync(path.dirname(movedTo), { recursive: true });
  // The whole secrets folder, not a list of files: everything in it is this
  // machine's identity, its trust in other devices, or ciphertext under its
  // `.machine-key`, and a list would silently miss the next file anyone adds.
  // API keys and the account vault come back from the account after sign-in.
  if (fs.existsSync(secretsDir)) fs.renameSync(secretsDir, movedTo);
  else fs.mkdirSync(movedTo, { recursive: true });

  // Each project database takes its cr-sqlite site id from the project's own
  // `.ade/secrets/sync-site-id` (kvDb mints one when it is missing, and applies
  // it before the extension loads), so retiring the file gives the copy a site
  // id of its own on the next open.
  const retiredProjectSiteIds: string[] = [];
  for (const rootPath of registeredProjectRoots(args.adeDir)) {
    const siteIdPath = path.join(rootPath, ".ade", "secrets", "sync-site-id");
    try {
      if (!fs.existsSync(siteIdPath)) continue;
      fs.renameSync(siteIdPath, `${siteIdPath}.copied-from-${folderSafe(record.instanceId)}`);
      retiredProjectSiteIds.push(rootPath);
    } catch (error) {
      args.logger?.warn?.("host_instance.project_site_id_retire_failed", {
        rootPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
